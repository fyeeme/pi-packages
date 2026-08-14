import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";

// Block the real @earendil-works/pi-coding-agent dist from loading — it pulls
// the missing `@earendil-works/pi-ai/compat` subpath (unhydrated in this
// submodule), which is what makes subagent.test.ts fail to even load here.
// `defineTool` is a pass-through: reviewReportTool becomes the raw definition
// object, so `execute` is the real function under test.
vi.mock("@earendil-works/pi-coding-agent", () => ({
	defineTool: <T>(def: T): T => def,
}));

import { reviewReportTool } from "../src/tools/review_report.ts";

// vi.mock erases defineTool's type wrapping, so cast to a minimal call shape.
type ExecuteResult = {
	content: Array<{ type: string; text: string }>;
	details: { level: string; findingsCount: number; outFile: string | null; reportId: string | null };
};
const execute = (
	reviewReportTool as unknown as {
		execute: (
			toolCallId: string,
			params: Record<string, unknown>,
			signal: undefined,
			onUpdate: undefined,
			ctx: { cwd: string },
		) => Promise<ExecuteResult>;
	}
).execute;

describe("review_report tool", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "pi-rr-"));
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("renders the Chinese report (header + table + details) and writes structured JSON", async () => {
		const res = await execute(
			"call_1",
			{
				level: "high",
				target: "git diff HEAD",
				files_changed: 3,
				fanned_out: true,
				findings: [
					{
						file: "src/a.ts",
						line: 10,
						category: "correctness",
						verdict: "CONFIRMED",
						short_summary: "off-by-one in loop bound",
						summary: "off-by-one",
						failure_scenario: "i<10 漏掉末元素",
					},
					{
						file: "src/b.ts",
						category: "reuse",
						verdict: "PLAUSIBLE",
						summary: "重复 helper",
						failure_scenario: "应复用既有 X()",
					},
				],
			},
			undefined,
			undefined,
			{ cwd },
		);

		const text = res.content[0]!.text;
		// header line: level · target · files · count · fanned_out label
		expect(text).toContain("`high` · `git diff HEAD` · 3 个文件 · 2 条发现 · 多智能体");
		// summary table — overview cell prefers short_summary, falls back to summary
		expect(text).toContain("| 1 | CONFIRMED | correctness | src/a.ts:10 | off-by-one in loop bound |");
		expect(text).toContain("| 2 | PLAUSIBLE | reuse | src/b.ts | 重复 helper |");
		// details block — always the full summary
		expect(text).toContain("**1. src/a.ts:10 — correctness** *(CONFIRMED)*");
		expect(text).toContain("概述：off-by-one");
		expect(text).toContain("场景：i<10 漏掉末元素");
		// no line number → file-only location
		expect(text).toContain("**2. src/b.ts — reuse** *(PLAUSIBLE)*");
		// sink acknowledgement
		expect(text).toContain("[结构化发现已写入");

		// structured JSON on disk
		const outDir = join(cwd, ".pi", "review");
		const files = readdirSync(outDir);
		expect(files).toHaveLength(1);
		expect(files[0]).toMatch(/-call_1\.json$/); // timestamp format is an impl detail
		const json = JSON.parse(readFileSync(join(outDir, files[0]!), "utf8")) as Record<string, unknown>;
		expect(json.level).toBe("high");
		expect(json.target).toBe("git diff HEAD");
		expect(json.filesChanged).toBe(3);
		expect(json.fannedOut).toBe(true);
		expect(typeof json.generatedAt).toBe("string");
		const findings = json.findings as Array<Record<string, unknown>>;
		expect(findings).toHaveLength(2);
		expect(findings[0]).toMatchObject({ verdict: "CONFIRMED", category: "correctness", line: 10 });
		expect(findings[0]).toMatchObject({ short_summary: "off-by-one in loop bound" });

		expect(res.details.findingsCount).toBe(2);
		expect(res.details.outFile).toBe(join(outDir, files[0]!));
	});

	it("empty findings → zero-count header, no table, no details", async () => {
		const res = await execute("call_2", { level: "low", findings: [] }, undefined, undefined, {
			cwd,
		});
		const text = res.content[0]!.text;
		expect(text).toContain("0 条发现");
		expect(text).toContain("（无发现存活验证。）");
		expect(text).not.toContain("| # |");
		expect(res.details.findingsCount).toBe(0);
		expect(res.details.outFile).not.toBeNull(); // empty list still sinks a JSON
	});

	it("renders the outcome line on re-report after --fix (CC 3-state)", async () => {
		const res = await execute(
			"call_3",
			{
				level: "high",
				findings: [
					{
						file: "x.ts",
						line: 1,
						category: "correctness",
						verdict: "CONFIRMED",
						summary: "bug",
						failure_scenario: "崩溃",
						outcome: "fixed",
					},
				],
			},
			undefined,
			undefined,
			{ cwd },
		);
		expect(res.content[0]!.text).toContain("修复结果：`fixed`");
	});

	it("fanned_out=false labels the header as 单遍自审", async () => {
		const res = await execute(
			"call_4",
			{ level: "medium", fanned_out: false, findings: [
				{ file: "y.ts", category: "simplification", summary: "可内联", failure_scenario: "单调用点" },
			] },
			undefined,
			undefined,
			{ cwd },
		);
		expect(res.content[0]!.text).toContain("单遍自审");
		expect(res.content[0]!.text).toContain("| 1 |  | simplification | y.ts |"); // verdict omitted → empty cell
	});

	it("accepts level=simplify and reflects it in the header (no verdict needed)", async () => {
		const res = await execute(
			"call_5",
			{
				level: "simplify",
				findings: [
					{
						file: "z.ts",
						line: 8,
						category: "reuse",
						summary: "重复实现",
						failure_scenario: "应复用 helper",
						outcome: "fixed",
					},
					{
						file: "w.ts",
						category: "efficiency",
						summary: "重复 I/O",
						failure_scenario: "循环内读文件",
						outcome: "skipped",
					},
				],
			},
			undefined,
			undefined,
			{ cwd },
		);
		const text = res.content[0]!.text;
		expect(text).toContain("`simplify`");
		expect(text).toContain("2 条发现");
		// verdict cell empty (simplify carries no verdict), category still rendered
		expect(text).toContain("| 1 |  | reuse | z.ts:8 |");
		expect(text).toContain("| 2 |  | efficiency | w.ts |");
		// outcome rendered on details
		expect(text).toContain("修复结果：`fixed`");
		expect(text).toContain("修复结果：`skipped`");
		expect(res.details.level).toBe("simplify");
	});

	it("normalizes invalid 5-state outcome to skipped with a note, keeping the rest", async () => {
		const res = await execute(
			"call_6",
			{
				level: "simplify",
				findings: [
					{
						file: "a.ts",
						category: "reuse",
						summary: "旧五档 fully_achieved",
						failure_scenario: "应复用 helper",
						outcome: "fully_achieved",
					},
					{
						file: "b.ts",
						category: "efficiency",
						summary: "合法 fixed",
						failure_scenario: "重复 I/O",
						outcome: "fixed",
					},
				],
			},
			undefined,
			undefined,
			{ cwd },
		);
		const text = res.content[0]!.text;
		// normalized value rendered, note attached
		expect(text).toContain("修复结果：`skipped`");
		expect(text).toContain("（outcome \"fully_achieved\" 非法，已归一化为 skipped）");
		expect(text).toContain("修复结果：`fixed`");
		expect(res.details.findingsCount).toBe(2);
		// on-disk JSON carries only legal values
		const outDir = join(cwd, ".pi", "review");
		const json = JSON.parse(
			readFileSync(join(outDir, readdirSync(outDir)[0]!), "utf8"),
		) as { findings: Array<Record<string, unknown>> };
		expect(json.findings[0]).toMatchObject({ outcome: "skipped" });
		expect(json.findings[1]).toMatchObject({ outcome: "fixed" });
	});

	it("drops findings with invalid verdict (incl. REFUTED) without failing the call", async () => {
		const res = await execute(
			"call_7",
			{
				level: "high",
				findings: [
					{
						file: "a.ts",
						line: 1,
						category: "correctness",
						verdict: "REFUTED", // 旧 schema 值，验证流程已丢弃，不应出现在报告里
						summary: "被否决的候选",
						failure_scenario: "x",
					},
					{
						file: "b.ts",
						line: 2,
						category: "correctness",
						verdict: "CONFIRMED",
						summary: "存活候选",
						failure_scenario: "y",
					},
					{
						file: "c.ts",
						line: 3,
						category: "correctness",
						verdict: "BOGUS",
						summary: "非法值",
						failure_scenario: "z",
					},
				],
			},
			undefined,
			undefined,
			{ cwd },
		);
		const text = res.content[0]!.text;
		expect(text).toContain("1 条发现"); // only the CONFIRMED one survives
		expect(text).not.toContain("被否决的候选");
		expect(text).not.toContain("非法值");
		expect(text).toContain("存活候选");
		expect(res.details.findingsCount).toBe(1);
		// JSON matches the rendered report
		const outDir = join(cwd, ".pi", "review");
		const json = JSON.parse(
			readFileSync(join(outDir, readdirSync(outDir)[0]!), "utf8"),
		) as { findings: Array<Record<string, unknown>> };
		expect(json.findings).toHaveLength(1);
		expect(json.findings[0]).toMatchObject({ verdict: "CONFIRMED" });
	});

	it("carries report_id in the header and the on-disk JSON; re-report reuses it", async () => {
		const res = await execute(
			"call_8",
			{
				level: "high",
				report_id: "review-2026-08-11",
				findings: [
					{
						file: "x.ts",
						line: 1,
						category: "correctness",
						verdict: "CONFIRMED",
						summary: "bug",
						failure_scenario: "崩溃",
						outcome: "fixed",
					},
				],
			},
			undefined,
			undefined,
			{ cwd },
		);
		expect(res.content[0]!.text).toContain("报告 `review-2026-08-11`");
		const outDir = join(cwd, ".pi", "review");
		const json = JSON.parse(
			readFileSync(join(outDir, readdirSync(outDir)[0]!), "utf8"),
		) as { reportId: string | null };
		expect(json.reportId).toBe("review-2026-08-11");
		expect(res.details.reportId).toBe("review-2026-08-11");

		// re-report with the same id → separate file, same id, newer generatedAt
		const first = readdirSync(outDir).sort()[0]!;
		await execute(
			"call_9",
			{
				level: "high",
				report_id: "review-2026-08-11",
				findings: [{ file: "x.ts", line: 1, category: "correctness", summary: "bug", failure_scenario: "崩溃" }],
			},
			undefined,
			undefined,
			{ cwd },
		);
		const files = readdirSync(outDir).sort();
		expect(files).toHaveLength(2);
		const second = files.filter((f) => f !== first)[0]!;
		const secondJson = JSON.parse(readFileSync(join(outDir, second), "utf8")) as { reportId: string | null };
		expect(secondJson.reportId).toBe("review-2026-08-11");
	});

	it("prepareArguments sanitizes invalid values before schema validation (model path)", () => {
		const prepare = (
			reviewReportTool as unknown as {
				prepareArguments: (args: unknown) => unknown;
			}
		).prepareArguments;

		const prepared = prepare({
			level: "high",
			findings: [
				{
					file: "a.ts",
					category: "correctness",
					verdict: "REFUTED", // 模型误报旧值——必须在校验前剔除，否则整单 throw
					summary: "被否决",
					failure_scenario: "x",
				},
				{
					file: "b.ts",
					category: "correctness",
					verdict: "CONFIRMED",
					summary: "存活",
					failure_scenario: "y",
					outcome: "fully_achieved", // 旧五档——归一化为 skipped
				},
				{ file: "c.ts", category: "reuse", summary: "正常", failure_scenario: "z" },
			],
		});

		const cleaned = (prepared as { findings: Array<Record<string, unknown>> }).findings;
		expect(cleaned).toHaveLength(2); // REFUTED 剔除
		expect(cleaned[0]).toMatchObject({ verdict: "CONFIRMED", outcome: "skipped" }); // 五档归一化
		expect(cleaned[1]).toMatchObject({ category: "reuse" });

		// 清洗后的对象必须通过严格 schema 校验——validateToolArguments 不再 throw
		const schema = (reviewReportTool as unknown as { parameters: unknown }).parameters as never;
		expect(Value.Check(schema, prepared)).toBe(true);
	});

	it("prepareArguments passes through non-findings payloads unchanged", () => {
		const prepare = (
			reviewReportTool as unknown as {
				prepareArguments: (args: unknown) => unknown;
			}
		).prepareArguments;

		expect(prepare({ level: "low", findings: [] })).toMatchObject({ level: "low", findings: [] });
		const notObject = prepare("junk");
		expect(notObject).toBe("junk");
	});
});
