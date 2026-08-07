import { describe, expect, it } from "vitest";
import { decideSimplifyMode } from "../src/commands/code-simplify.ts";
import { parseReviewArgs, resolveEffort } from "../src/commands/code-review.ts";

describe("decideSimplifyMode", () => {
	const window = 100_000;

	it("parallel when context is not near-full and subagent is available", () => {
		expect(decideSimplifyMode({ tokens: 50_000, contextWindow: window, hasSubagent: true })).toBe("parallel");
	});

	it("single-pass when context is near-full (>=80%) even with subagent available", () => {
		expect(decideSimplifyMode({ tokens: 85_000, contextWindow: window, hasSubagent: true })).toBe("single-pass");
	});

	it("single-pass when subagent is unavailable, regardless of context headroom", () => {
		expect(decideSimplifyMode({ tokens: 10_000, contextWindow: window, hasSubagent: false })).toBe("single-pass");
	});

	it("single-pass (conservative) when token count is unknown", () => {
		expect(decideSimplifyMode({ tokens: null, contextWindow: window, hasSubagent: true })).toBe("single-pass");
	});

	it("at exactly the 80% threshold → single-pass (boundary is >=)", () => {
		expect(decideSimplifyMode({ tokens: 80_000, contextWindow: window, hasSubagent: true })).toBe("single-pass");
	});

	it("just below the threshold → parallel", () => {
		expect(decideSimplifyMode({ tokens: 79_000, contextWindow: window, hasSubagent: true })).toBe("parallel");
	});
});

describe("parseReviewArgs", () => {
	it("parses a leading level and returns the rest", () => {
		expect(parseReviewArgs("high src/foo.ts --fix")).toEqual({ level: "high", rest: "src/foo.ts --fix" });
	});

	it("is case-insensitive on the level token", () => {
		expect(parseReviewArgs("XHIGH").level).toBe("xhigh");
	});

	it("treats a leading flag as flags (no level)", () => {
		expect(parseReviewArgs("--fix")).toEqual({ level: undefined, rest: "--fix" });
	});

	it("treats a non-level first token as target (no level)", () => {
		expect(parseReviewArgs("src/foo.ts --comment")).toEqual({ level: undefined, rest: "src/foo.ts --comment" });
	});

	it("empty args → no level, empty rest", () => {
		expect(parseReviewArgs("")).toEqual({ level: undefined, rest: "" });
	});

	it("whitespace-only args → no level, empty rest", () => {
		expect(parseReviewArgs("   ")).toEqual({ level: undefined, rest: "" });
	});
});

describe("resolveEffort", () => {
	it("explicit wins over last-used", () => {
		expect(resolveEffort("high", "low")).toEqual({ level: "high", source: "explicit" });
	});

	it("falls back to last-used when no explicit level", () => {
		expect(resolveEffort(undefined, "max")).toEqual({ level: "max", source: "last-used" });
	});

	it("falls back to default low when neither explicit nor last-used", () => {
		expect(resolveEffort(undefined, undefined)).toEqual({ level: "low", source: "default" });
	});
});
