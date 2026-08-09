import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
	details: { level: string; findingsCount: number; outFile: string | null };
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
		// summary table
		expect(text).toContain("| 1 | CONFIRMED | correctness | src/a.ts:10 | off-by-one |");
		expect(text).toContain("| 2 | PLAUSIBLE | reuse | src/b.ts | 重复 helper |");
		// details block
		expect(text).toContain("**1. src/a.ts:10 — correctness** *(CONFIRMED)*");
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

	it("renders the outcome line on re-report after --fix", async () => {
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
						outcome: "fully_achieved",
					},
				],
			},
			undefined,
			undefined,
			{ cwd },
		);
		expect(res.content[0]!.text).toContain("修复结果：`fully_achieved`");
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
						outcome: "fully_achieved",
					},
					{
						file: "w.ts",
						category: "efficiency",
						summary: "重复 I/O",
						failure_scenario: "循环内读文件",
						outcome: "not_achieved",
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
		expect(text).toContain("修复结果：`fully_achieved`");
		expect(text).toContain("修复结果：`not_achieved`");
		expect(res.details.level).toBe("simplify");
	});
});
