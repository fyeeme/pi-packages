import { describe, expect, it } from "vitest";
import {
	BANNED_API_MESSAGE,
	DeterminismError,
	assertDeterministic,
	findDeterminismViolations,
} from "../src/determinism/ast-guard.ts";

describe("ast-guard — accept clean code", () => {
	it("accepts plain arithmetic", () => {
		expect(() => assertDeterministic("const x = 1 + 2; export default x;")).not.toThrow();
	});

	it("accepts TypeScript type annotations", () => {
		expect(() => assertDeterministic("const f = (x: number): string => String(x);")).not.toThrow();
	});

	it("accepts new Date(timestamp) with an argument", () => {
		expect(() => assertDeterministic("const d = new Date(1_700_000_000_000);")).not.toThrow();
	});

	it("accepts new Date(year, month, day)", () => {
		expect(() => assertDeterministic("const d = new Date(2026, 0, 1);")).not.toThrow();
	});

	it("accepts Date.parse (not Date.now)", () => {
		expect(() => assertDeterministic("const t = Date.parse('2026-01-01');")).not.toThrow();
	});
});

describe("ast-guard — reject banned APIs", () => {
	it("flags Date.now()", () => {
		const v = findDeterminismViolations("const t = Date.now();");
		expect(v).toHaveLength(1);
		expect(v[0]?.kind).toBe("date_now");
	});

	it("flags Math.random()", () => {
		const v = findDeterminismViolations("const r = Math.random();");
		expect(v).toHaveLength(1);
		expect(v[0]?.kind).toBe("math_random");
	});

	it("flags new Date() with no args", () => {
		const v = findDeterminismViolations("const d = new Date();");
		expect(v).toHaveLength(1);
		expect(v[0]?.kind).toBe("new_date");
	});

	it("flags Date() no-arg call (merged from loader.ts)", () => {
		const v = findDeterminismViolations("const s = Date();");
		expect(v).toHaveLength(1);
		expect(v[0]?.kind).toBe("date_call");
	});

	it("allows Date(timestamp) call with an argument", () => {
		expect(() => assertDeterministic("const s = Date(1_700_000_000_000);")).not.toThrow();
	});

	it("reports 1-based line:column", () => {
		// "const t = " is 10 chars (0-based 0..9), so D sits at 0-based 10 → 1-based 11.
		const src = "const a = 1;\nconst t = Date.now();";
		const v = findDeterminismViolations(src, "wf.ts");
		expect(v[0]?.line).toBe(2);
		expect(v[0]?.column).toBe(11);
		expect(v[0]?.source).toBe("Date.now");
	});

	it("collects multiple violations in one pass", () => {
		const src = "const a = Date.now();\nconst b = Math.random();\nconst c = new Date();";
		expect(findDeterminismViolations(src)).toHaveLength(3);
	});

	it("BANNED_API_MESSAGE covers all four kinds", () => {
		expect(Object.keys(BANNED_API_MESSAGE).sort()).toEqual(["date_call", "date_now", "math_random", "new_date"]);
	});
});

describe("ast-guard — throws DeterminismError", () => {
	it("assertDeterministic throws with file:line:col detail", () => {
		const src = "const t = Date.now();";
		let caught: DeterminismError | undefined;
		try {
			assertDeterministic(src, "wf.ts");
		} catch (e) {
			caught = e as DeterminismError;
		}
		expect(caught).toBeInstanceOf(DeterminismError);
		expect(caught?.message).toContain("wf.ts:1:11");
		expect(caught?.message).toContain("Date.now");
		expect(caught?.name).toBe("DeterminismError");
	});

	it("does not throw on clean code", () => {
		expect(() => assertDeterministic("export default 42;", "clean.ts")).not.toThrow();
	});
});
