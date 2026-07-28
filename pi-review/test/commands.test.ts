import { describe, expect, it } from "vitest";
import { decideSimplifyMode } from "../src/commands/simplify.ts";

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
