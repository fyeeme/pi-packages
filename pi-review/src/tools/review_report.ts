/**
 * src/tools/review_report.ts — the `review_report` LLM tool.
 *
 * Structured findings sink for the code-review skill — Pi's counterpart to
 * CC's native `ReportFindings` tool (verified in CC v2.1.226 binary: "Report
 * code-review findings as a typed list so the host UI can render them"). Pi has
 * no host finding-renderer, so this tool does double duty: it renders a tidy
 * Chinese Markdown report (table + details) back to the conversation AND writes
 * a machine-readable JSON (findings + level + outcome) to
 * `<cwd>/.pi/review/<id>.json` so CI / --fix / --comment can consume it.
 *
 * `verdict` (CONFIRMED/PLAUSIBLE/REFUTED) and `outcome` (5-state) enums follow
 * the CC ReportFindings shape (outcome values copied from the CC binary). The
 * code-review skill drops REFUTED findings before reporting, so that value is
 * accepted by the schema but rarely seen in practice.
 */
import { defineTool, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";

// --- enums following the CC ReportFindings shape ----------------------------

const Verdict = Type.Union([Type.Literal("CONFIRMED"), Type.Literal("PLAUSIBLE"), Type.Literal("REFUTED")]);

/** CC ReportFindings `outcome` 5 档（v2.1.226 二进制实证）。re-report after --fix 时填。 */
const Outcome = Type.Union([
	Type.Literal("fully_achieved"),
	Type.Literal("mostly_achieved"),
	Type.Literal("partially_achieved"),
	Type.Literal("not_achieved"),
	Type.Literal("unclear_from_transcript"),
]);

const Level = Type.Union([
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
	Type.Literal("max"),
	// simplify reuses this tool for structured apply-outcome reporting
	// (harden-code-simplify). Not a review effort level — carries no verdict.
	Type.Literal("simplify"),
]);

// --- schema -----------------------------------------------------------------

const FindingParams = Type.Object({
	file: Type.String({ description: "相对仓库根的文件路径。" }),
	line: Type.Optional(Type.Number({ description: "行号（1-based）。省略表示文件级。" })),
	category: Type.String({
		description:
			"产生该发现的角度 slug：correctness / reuse / simplification / efficiency / altitude / conventions（或更具体如 test-coverage）。",
	}),
	verdict: Type.Optional(Verdict),
	summary: Type.String({ description: "一句话说明（≤80字），同时作紧凑标签。中文。" }),
	failure_scenario: Type.String({
		description:
			"具体场景：输入/状态 → 错误输出/崩溃；清理类发现写明具体代价（重复/浪费/更难维护/违反哪条规则）。中文。",
	}),
	outcome: Type.Optional(Outcome),
});

const ReviewReportParams = Type.Object({
	level: Level,
	target: Type.Optional(Type.String({ description: "审查目标（diff 命令/范围，或 PR/分支/路径），用于报告表头。" })),
	files_changed: Type.Optional(Type.Number({ description: "改动文件数，用于报告表头。" })),
	fanned_out: Type.Optional(
		Type.Boolean({ description: "是否真的多智能体并发（Single-pass honesty）。false/省略表示单遍自审。" }),
	),
	findings: Type.Array(FindingParams, {
		description: "已验证、去重、按严重度从高到低排序的发现列表（most-severe first）。空数组表示无发现存活。",
	}),
});

interface ReviewReportDetails {
	level: string;
	findingsCount: number;
	/** 结构化 JSON 落盘路径；落盘失败时为 null（仍返回渲染报告）。 */
	outFile: string | null;
}

// --- render -----------------------------------------------------------------

interface FindingInput {
	file: string;
	line?: number;
	category: string;
	verdict?: string;
	summary: string;
	failure_scenario: string;
	outcome?: string;
}
interface ReportInput {
	level: string;
	target?: string;
	files_changed?: number;
	fanned_out?: boolean;
	findings: FindingInput[];
}

function fmtLoc(f: { file: string; line?: number }): string {
	return f.line != null ? `${f.file}:${f.line}` : f.file;
}

/** Escape a value for a GFM table cell: backslash-escape pipes and collapse
 *  newlines. Free-text fields (summary/category/verdict/loc) are LLM-provided
 *  and routinely contain `||`, `|`, regex, or shell pipes that would otherwise
 *  split the row into extra columns and break the whole summary table. */
function escapeCell(v: string): string {
	return v.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** 渲染中文 Markdown 报告（表头行 + 汇总表 + 详情块），格式与原 SKILL.md 教的一致。 */
function renderReport(p: ReportInput): string {
	const lines: string[] = [];
	const fanLabel = p.fanned_out === true ? "多智能体" : p.fanned_out === false ? "单遍自审" : "未标注";
	const targetStr = (p.target ?? "(whole diff)").replace(/`/g, "\\`"); // backtick inside the inline-code cell would close it early
	const filesStr = p.files_changed != null ? `${p.files_changed} 个文件` : "文件数未标注";
	lines.push(`\`${p.level}\` · \`${targetStr}\` · ${filesStr} · ${p.findings.length} 条发现 · ${fanLabel}`);
	lines.push("");

	if (p.findings.length === 0) {
		lines.push("（无发现存活验证。）");
		return lines.join("\n");
	}

	lines.push("| # | 判定 | 类别 | 位置 | 概述 |");
	lines.push("|---|------|------|------|------|");
	for (let i = 0; i < p.findings.length; i++) {
		const f = p.findings[i]!;
		lines.push(`| ${i + 1} | ${escapeCell(f.verdict ?? "")} | ${escapeCell(f.category)} | ${escapeCell(fmtLoc(f))} | ${escapeCell(f.summary)} |`);
	}
	lines.push("");
	lines.push("**详情**");
	lines.push("");
	p.findings.forEach((f, i) => {
		const v = f.verdict ? ` *(${f.verdict})*` : "";
		const out = f.outcome ? `\n修复结果：\`${f.outcome}\`` : "";
		lines.push(`**${i + 1}. ${fmtLoc(f)} — ${f.category}**${v}`);
		lines.push(`概述：${f.summary}`);
		lines.push(`场景：${f.failure_scenario}${out}`);
		lines.push("");
	});
	return lines.join("\n").trimEnd();
}

// --- tool -------------------------------------------------------------------

export const reviewReportTool = defineTool<typeof ReviewReportParams, ReviewReportDetails>({
	name: "review_report",
	label: "Report review findings",
	description:
		"Report code-review findings as a typed list — Pi's counterpart to CC's ReportFindings. Use this only when the active code-review instructions tell you to report findings with this tool. Call it once with the verified findings ranked most-severe first (empty array if nothing survived verification) and do not also print the findings as text — the tool renders a tidy Chinese Markdown report back to the conversation AND writes a machine-readable JSON to <cwd>/.pi/review/ for CI / --fix / --comment. When re-reporting after applying fixes, set `outcome` on each finding. 上报结构化 code-review 发现（CC ReportFindings 的 Pi 对等物）。",
	promptSnippet: "review_report — report structured code-review findings (renders Markdown + writes JSON for CI)",
	promptGuidelines: [
		"After verify + dedup, call `review_report` once with { level, findings } (most-severe first; empty array if none survived). Do not also hand-write the Markdown table — this tool renders it.",
		"On re-report after --fix, set each finding's `outcome` (fully_achieved / mostly_achieved / partially_achieved / not_achieved / unclear_from_transcript).",
		"Use this tool only when the code-review skill instructs reporting findings; otherwise follow the active output format.",
	],
	parameters: ReviewReportParams,

	async execute(toolCallId, params, _signal, _onUpdate, ctx) {
		const report = renderReport(params);

		let outFile: string | null = null;
		let writeError: string | null = null;
		const now = new Date();
		try {
			const dir = path.join(ctx.cwd, ".pi", "review");
			await fs.promises.mkdir(dir, { recursive: true });
			const safeId = toolCallId.replace(/[^\w.-]+/g, "_");
			const ts = now.toISOString().replace(/[:.]/g, "-");
			const fp = path.join(dir, `${ts}-${safeId}.json`);
			await fs.promises.writeFile(
				fp,
				JSON.stringify(
					{
						level: params.level,
						target: params.target ?? null,
						filesChanged: params.files_changed ?? null,
						fannedOut: params.fanned_out ?? null,
						generatedAt: now.toISOString(),
						findings: params.findings,
					},
					null,
					2,
				),
				{ encoding: "utf-8", mode: 0o600 },
			);
			outFile = fp;
		} catch (err) {
			/* 落盘失败不阻塞：仍返回渲染报告，但带上错误信息便于 CI/--fix 排障。 */
			writeError = err instanceof Error ? err.message : String(err);
		}

		const tail = outFile
			? `\n\n[结构化发现已写入 \`${outFile}\`]`
			: `\n\n[结构化落盘失败（${writeError ?? "未知原因"}），仅渲染报告]`;
		const details: ReviewReportDetails = {
			level: params.level,
			findingsCount: params.findings.length,
			outFile,
		};
		return {
			content: [{ type: "text" as const, text: report + tail }],
			details,
		};
	},

	// Render the returned Markdown report through pi's width-aware Markdown component
	// (the same path assistant text takes), not the plain-Text tool-result fallback that
	// renderer-less extension tools get. Without this, the GFM table is shown as raw
	// `|`/`|---|` wrapped to terminal width — no borders, no alignment.
	// tool-execution.ts wraps renderResult in try/catch and falls back to plain Text on
	// throw, so a failure here degrades to the pre-change behavior rather than erroring.
	renderResult(result, _options, _theme, _context) {
		const text = result.content
			.filter((c) => c.type === "text")
			.map((c) => (c.type === "text" ? c.text : ""))
			.join("\n");
		return new Markdown(text, 0, 0, getMarkdownTheme());
	},
});
