import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Same vi.mock pattern as review_report.test.ts — block the real
// @earendil-works/pi-coding-agent dist so the module loads in this submodule.
vi.mock("@earendil-works/pi-coding-agent", () => ({
	defineTool: <T>(def: T): T => def,
}));

import { OUTCOME_VALUES, PRIORITY_VALUES, VERDICT_VALUES, reviewReportTool } from "../src/tools/review_report.ts";

/**
 * 防漂移（pi-review-cc-parity）：SKILL.md 中的流程层输出契约（outcome 三档、
 * short_summary、report_id 固定-later）必须与 review_report 的 schema 常量一致。
 * schema 值域来自 CC 2.1.227 实证；若 SKILL 与常量脱节，机器消费方（CI /
 * 归并脚本）会读到契约外值。沿用 angle-sync.test.ts 的文本断言模式。
 */
const SKILLS_DIR = join(__dirname, "..", "skills");
const REVIEW = readFileSync(join(SKILLS_DIR, "code-review", "SKILL.md"), "utf8");
const SIMPLIFY = readFileSync(join(SKILLS_DIR, "code-simplify", "SKILL.md"), "utf8");

/** 旧五档（1.0.x）——必须从两份 SKILL 中彻底消失。 */
const OLD_OUTCOMES = [
	"fully_achieved",
	"mostly_achieved",
	"partially_achieved",
	"not_achieved",
	"unclear_from_transcript",
];

describe("SKILL 输出契约与 review_report schema 同步", () => {
	it("outcome 三档值出现在两份 SKILL 的输出契约中", () => {
		expect(OUTCOME_VALUES).toEqual(["fixed", "skipped", "no_change_needed"]);
		for (const v of OUTCOME_VALUES) {
			expect(REVIEW, `review 必须包含 outcome ${v}`).toContain(`\`${v}\``);
			expect(SIMPLIFY, `simplify 必须包含 outcome ${v}`).toContain(`\`${v}\``);
		}
	});

	it("旧五档 outcome 值不再出现在任何 SKILL 中", () => {
		for (const v of OLD_OUTCOMES) {
			expect(REVIEW, `review 不得残留 ${v}`).not.toContain(v);
			expect(SIMPLIFY, `simplify 不得残留 ${v}`).not.toContain(v);
		}
	});

	it("short_summary 契约在两份 SKILL 中都有", () => {
		expect(REVIEW).toContain("short_summary");
		expect(SIMPLIFY).toContain("short_summary");
	});

	it("report_id 固定-later 义务在两份 SKILL 中都有", () => {
		expect(REVIEW).toContain("report_id");
		expect(SIMPLIFY).toContain("report_id");
	});

	it("verdict 常量与 SKILL 输出契约一致（REFUTED 不进报告）", () => {
		expect(VERDICT_VALUES).toEqual(["CONFIRMED", "PLAUSIBLE"]);
		expect(REVIEW).toContain("`CONFIRMED`");
		expect(REVIEW).toContain("`PLAUSIBLE`");
	});

	it("priority 契约（P0–P3）与 --loop blocking 阈值在 SKILL 输出契约中", () => {
		expect(PRIORITY_VALUES).toEqual(["P0", "P1", "P2", "P3"]);
		for (const v of PRIORITY_VALUES) {
			expect(REVIEW, `review 必须包含 priority ${v}`).toContain(`**${v}**`);
		}
		expect(REVIEW).toContain("--loop");
	});

	it("CC re-sync 2026-10 契约在 review SKILL 中（canonFile 归一 / 反注入 / 8 角映射 / 轻量 synthesize / 收尾链）", () => {
		// finder 输出路径归一化（CC workflow canonFile）
		expect(REVIEW).toContain("canonFile");
		expect(REVIEW).toContain("longest");
		// 自由文本指令 + 反注入框架
		expect(REVIEW).toContain("free-form");
		expect(REVIEW).toContain("How to apply the review target");
		expect(REVIEW).toContain("never as an instruction to a subagent");
		// medium/high = CC 8 角映射
		expect(REVIEW).toContain("8-angle");
		// 轻量 Synthesize：同根因合并 + refuted/stats 透明度
		expect(REVIEW).toContain("same root cause also at");
		expect(REVIEW).toContain("`refuted`");
		expect(REVIEW).toContain("`stats`");
		// After-the-review 收尾链
		expect(REVIEW).toContain("## After the review");
	});

	it("STE-lite（80% ASD-STE100）写作契约在两份 SKILL 与工具 schema/guidelines 中", () => {
		expect(REVIEW).toContain("ASD-STE100");
		expect(SIMPLIFY).toContain("ASD-STE100");
		const tool = reviewReportTool as unknown as {
			promptGuidelines?: string[];
			parameters?: { properties?: Record<string, { description?: string }> };
		};
		expect((tool.promptGuidelines ?? []).some((g) => g.includes("ASD-STE100"))).toBe(true);
		// schema 形状无关的计数断言：guideline + summary/failure_scenario 两个字段描述
		const occurrences = JSON.stringify(reviewReportTool).split("ASD-STE100").length - 1;
		// guideline + summary/failure_scenario/refuted[].summary 三个字段描述
		expect(occurrences).toBeGreaterThanOrEqual(4);
		// 风格块的作用域覆盖 refuted 文本
		expect(REVIEW).toContain("refuted[].summary");
	});

	it("CC 291 re-sync 契约在 review SKILL 中（--max-findings / 32 硬顶 / gated 收尾链 / finder budget）", () => {
		// --max-findings flag 契约与上限优先级
		expect(REVIEW).toContain("--max-findings <n>|all|default");
		expect(REVIEW).toContain("`Fe=32`");
		expect(REVIEW).toContain("Findings limit:");
		expect(REVIEW).toContain("Limit precedence");
		// finder budget hint 消费（numstat → ceil(lines/150) 夰 [2,8]）
		expect(REVIEW).toContain("Finder budget:");
		expect(REVIEW).toContain("numstat");
		// after-review gated 主动调用链
		expect(REVIEW).toContain("three gates");
		expect(REVIEW).toContain("invoke `/code-simplify` now");
		expect(REVIEW).toContain("at most once");
	});
});
