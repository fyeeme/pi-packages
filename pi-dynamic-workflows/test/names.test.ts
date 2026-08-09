import { describe, expect, it } from "vitest";
import { generateRunId } from "../src/state/names.ts";

describe("generateRunId (deterministic)", () => {
	it("same input produces identical id", () => {
		const input = { timestamp: 1_800_000_000_000, sequence: 0 };
		expect(generateRunId(input)).toBe(generateRunId(input));
	});

	it("different sequence produces different id", () => {
		const ts = 1_800_000_000_000;
		expect(generateRunId({ timestamp: ts, sequence: 0 })).not.toBe(
			generateRunId({ timestamp: ts, sequence: 1 }),
		);
	});

	it("different timestamp produces different id", () => {
		expect(generateRunId({ timestamp: 1, sequence: 0 })).not.toBe(
			generateRunId({ timestamp: 2, sequence: 0 }),
		);
	});

	it("format is run-<base36 ts>-<zero-padded base36 seq>", () => {
		const ts = 1_800_000_000_000;
		expect(generateRunId({ timestamp: ts, sequence: 5 })).toBe(`run-${ts.toString(36)}-0005`);
	});

	it("sequence zero-pads to 4 digits", () => {
		const ts = 1;
		expect(generateRunId({ timestamp: ts, sequence: 0 })).toBe(`run-${ts.toString(36)}-0000`);
	});
});
