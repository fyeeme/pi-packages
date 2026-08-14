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
 * `verdict` (CONFIRMED/PLAUSIBLE) and `outcome` (fixed/skipped/no_change_needed)
 * enums follow the CC ReportFindings shape — values verified against the CC
 * v2.1.227 binary (consistent across 2.1.223/226/227). REFUTED is deliberately
 * absent: the verify flow drops it before reporting. The tool entry also
 * normalizes stray invalid values (drop the finding / coerce to skipped) rather
 * than failing the whole call.
 */
import { defineTool, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";

// --- enums following the CC ReportFindings shape ----------------------------
// 值域实证来源：CC v2.1.227 bin/claude.exe（ReportFindings 工具 schema）。
// verdict 两值与 outcome 三档在 2.1.223/226/227 三版本中一致。

const VERDICT_VALUES = ["CONFIRMED", "PLAUSIBLE"] as const;
const Verdict = Type.Union(VERDICT_VALUES.map((v) => Type.Literal(v)));

const OUTCOME_VALUES = ["fixed", "skipped", "no_change_needed"] as const;
/** CC ReportFindings `outcome` 三档（2.1.227 二进制实证）。fixed-later 再上报时更新。 */
const Outcome = Type.Union(OUTCOME_VALUES.map((v) => Type.Literal(v)));

// 供 SKILL-schema 同步测试引用（防漂移：SKILL 流程契约不得与常量脱节）。
export { OUTCOME_VALUES, VERDICT_VALUES };

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
	short_summary: Type.Optional(
		Type.String({
			description:
				"≤60 字符的纯声明标签（去掉理由与后果）。汇总表概述列优先使用它；详情块仍显示完整 summary。流程层面必填（CC 输出模板契约），schema 层面 optional（与 CC tool schema 一致）。中文。",
		}),
	),
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
	report_id: Type.Optional(
		Type.String({
			description:
				"报告标识（如 review-<ts>）。首次上报生成；fixed-later 再上报传同一 id，消费方按 id 归并，同 id 最新 generatedAt 为最终状态。",
		}),
	),
});

interface ReviewReportDetails {
	level: string;
	findingsCount: number;
	/** 结构化 JSON 落盘路径；落盘失败时为 null（仍返回渲染报告）。 */
	outFile: string | null;
	reportId: string | null;
}

/**
 * execute 入口的宽松 finding 形态——绕过 schema 校验的直接调用（如单测）
 * 可能携带旧五档 outcome 或已废弃的 REFUTED verdict。
 */
type LooseFinding = {
	file: string;
	line?: number;
	category: string;
	verdict?: string;
	short_summary?: string;
	summary: string;
	failure_scenario: string;
	outcome?: string;
};

/**
 * 单条清洗：非法 verdict（含已废弃的 REFUTED）返回 null（剔除）；非法 outcome
 * 归一化为 skipped 并附注原始值。schema 保持严格，清洗在 schema 校验之前。
 */
function sanitizeFinding(f: LooseFinding): { f: LooseFinding; note?: string } | null {
	if (f.verdict !== undefined && !(VERDICT_VALUES as readonly string[]).includes(f.verdict)) return null;
	let outcome = f.outcome;
	let note: string | undefined;
	if (outcome !== undefined && !(OUTCOME_VALUES as readonly string[]).includes(outcome)) {
		note = `（outcome "${outcome}" 非法，已归一化为 skipped）`;
		outcome = "skipped";
	}
	return { f: { ...f, outcome }, note };
}

/**
 * 批量清洗，note 按清洗后数组索引记录（渲染层附注用）。
 * `prepareArguments`（主防御，schema 校验前）与 `execute` 入口（双保险，
 * 防绕过 prepareArguments 的直接调用）共用——模型路径的非法值在进入
 * execute 前已被清洗，validateToolArguments 不会因边缘值 throw 掉整份报告。
 */
function normalizeFindings(findings: LooseFinding[]): { findings: LooseFinding[]; notes: Map<number, string> } {
	const out: LooseFinding[] = [];
	const notes = new Map<number, string>();
	for (const raw of findings) {
		const s = sanitizeFinding(raw);
		if (!s) continue;
		const idx = out.length;
		out.push(s.f);
		if (s.note) notes.set(idx, s.note);
	}
	return { findings: out, notes };
}

// --- render -----------------------------------------------------------------

interface FindingInput {
	file: string;
	line?: number;
	category: string;
	verdict?: string;
	short_summary?: string;
	summary: string;
	failure_scenario: string;
	outcome?: string;
	/** normalize 附注（如非法 outcome 归一化说明），仅渲染进详情块。 */
	note?: string;
}
interface ReportInput {
	level: string;
	target?: string;
	files_changed?: number;
	fanned_out?: boolean;
	reportId?: string;
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
	const idStr = p.reportId ? ` · 报告 \`${escapeCell(p.reportId)}\`` : "";
	lines.push(`\`${p.level}\` · \`${targetStr}\` · ${filesStr} · ${p.findings.length} 条发现 · ${fanLabel}${idStr}`);
	lines.push("");

	if (p.findings.length === 0) {
		lines.push("（无发现存活验证。）");
		return lines.join("\n");
	}

	lines.push("| # | 判定 | 类别 | 位置 | 概述 |");
	lines.push("|---|------|------|------|------|");
	for (let i = 0; i < p.findings.length; i++) {
		const f = p.findings[i]!;
		lines.push(`| ${i + 1} | ${escapeCell(f.verdict ?? "")} | ${escapeCell(f.category)} | ${escapeCell(fmtLoc(f))} | ${escapeCell(f.short_summary ?? f.summary)} |`);
	}
	lines.push("");
	lines.push("**详情**");
	lines.push("");
	p.findings.forEach((f, i) => {
		const v = f.verdict ? ` *(${f.verdict})*` : "";
		const out = f.outcome ? `\n修复结果：\`${f.outcome}\`` : "";
		const note = f.note ? `\n${f.note}` : "";
		lines.push(`**${i + 1}. ${fmtLoc(f)} — ${f.category}**${v}`);
		lines.push(`概述：${f.summary}`);
		lines.push(`场景：${f.failure_scenario}${out}${note}`);
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
		"On re-report after --fix, set each finding's `outcome` (fixed / skipped / no_change_needed).",
		"Use this tool only when the code-review skill instructs reporting findings; otherwise follow the active output format.",
	],
	parameters: ReviewReportParams,

	// 主防御：schema 校验之前清洗非法值（模型路径下校验失败即 throw、工具不执行，
	// 因此 execute 内的防御对模型不可达）。返回符合 schema 的对象——非法 verdict
	// 的 finding 剔除、非法 outcome 归一化为 skipped；note 附注由 execute 层基于
	// 清洗结果生成（schema 对象不含 note 字段）。
	prepareArguments(args) {
		if (typeof args !== "object" || args === null) return args as Static<typeof ReviewReportParams>;
		const raw = args as { findings?: unknown };
		if (!Array.isArray(raw.findings)) return args as Static<typeof ReviewReportParams>;
		const { findings } = normalizeFindings(raw.findings as unknown as LooseFinding[]);
		return { ...raw, findings } as Static<typeof ReviewReportParams>;
	},

	async execute(toolCallId, params, _signal, _onUpdate, ctx) {
		// normalize（双保险）——绕过 prepareArguments 的直接调用（如单测）可能携带
		// 旧五档 outcome 或已废弃的 REFUTED verdict。归一化而非整单拒绝：非法
		// verdict 的 finding 剔除，非法 outcome 归一化为 skipped 并附注；渲染与落盘
		// 永远只含合法值（spec: 消费方永远看到合法值）。
		const { findings: cleaned, notes } = normalizeFindings(
			(params.findings ?? []) as unknown as LooseFinding[],
		);
		const findings: FindingInput[] = cleaned.map((f, i) => ({ ...f, note: notes.get(i) }));

		const report = renderReport({
			level: params.level,
			target: params.target,
			files_changed: params.files_changed,
			fanned_out: params.fanned_out,
			reportId: params.report_id,
			findings,
		});

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
						reportId: params.report_id ?? null,
						target: params.target ?? null,
						filesChanged: params.files_changed ?? null,
						fannedOut: params.fanned_out ?? null,
						generatedAt: now.toISOString(),
						findings,
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
			findingsCount: findings.length,
			outFile,
			reportId: params.report_id ?? null,
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
			.filter((c): c is Extract<(typeof result.content)[number], { type: "text" }> => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		return new Markdown(text, 0, 0, getMarkdownTheme());
	},
});
