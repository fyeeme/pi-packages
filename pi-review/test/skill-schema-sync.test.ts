import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Same vi.mock pattern as review_report.test.ts — block the real
// @earendil-works/pi-coding-agent dist so the module loads in this submodule.
vi.mock("@earendil-works/pi-coding-agent", () => ({
	defineTool: <T>(def: T): T => def,
}));

import { OUTCOME_VALUES, VERDICT_VALUES } from "../src/tools/review_report.ts";

/**
 * 防漂移（pi-review-cc-parity）：SKILL.md 中的流程层输出契约（outcome 三档、
 * short_summary、report_id 固定-later）必须与 review_report 的 schema 常量一致。
 * schema 值域来自 CC 2.1.227 实证；若 SKILL 与常量脱节，机器消费方（CI /
 * 归并脚本）会读到契约外值。沿用 angle-sync.test.ts 的文本断言模式。
 */
const SKILLS_DIR = join(__dirname, "..", "skills");
const REVIEW = readFileSync(join(SKILLS_DIR, "code-review", "SKILL.md"), "utf8");
const SIMPLIFY = readFileSync(join(SKILLS_DIR, "simplify", "SKILL.md"), "utf8");

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
			expect(REVIEW, `code-review 必须包含 outcome ${v}`).toContain(`\`${v}\``);
			expect(SIMPLIFY, `simplify 必须包含 outcome ${v}`).toContain(`\`${v}\``);
		}
	});

	it("旧五档 outcome 值不再出现在任何 SKILL 中", () => {
		for (const v of OLD_OUTCOMES) {
			expect(REVIEW, `code-review 不得残留 ${v}`).not.toContain(v);
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
});
