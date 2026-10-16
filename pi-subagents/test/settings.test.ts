/**
 * settings.test.ts — unit tests for the file-based configuration
 * (the "subagents" section of young.json, sanitized keys).
 *
 * The file location is pinned via PI_CODING_AGENT_DIR (pi's agent-dir env
 * override, honored by getAgentDir) so tests never touch the real
 * ~/.pi/agent/young.json.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCoreSettings } from "../src/concurrency.ts";

let globalDir: string;
let projDir: string;

beforeEach(() => {
	globalDir = mkdtempSync(join(tmpdir(), "pi-sa-sg-"));
	projDir = mkdtempSync(join(tmpdir(), "pi-sa-sp-"));
	process.env.PI_CODING_AGENT_DIR = globalDir;
});

afterEach(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	rmSync(globalDir, { recursive: true, force: true });
	rmSync(projDir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

function writeGlobal(obj: unknown): void {
	writeFileSync(join(globalDir, "young.json"), JSON.stringify(obj));
}

describe("settings (young.json subagents section)", () => {
	it("returns {} with no file (all defaults)", () => {
		expect(loadCoreSettings()).toEqual({});
	});

	it("parses the settings keys from the subagents section", () => {
		writeGlobal({ subagents: { fleet: false, maxConcurrency: 8 } });
		expect(loadCoreSettings()).toEqual({ fleet: false, maxConcurrency: 8 });
	});

	it("ignores other top-level sections — config is isolated per extension name", () => {
		writeGlobal({ "session-name": { enabled: false }, subagents: { maxConcurrency: 4 } });
		expect(loadCoreSettings()).toEqual({ maxConcurrency: 4 });
	});

	it("a missing subagents section reads as {}", () => {
		writeGlobal({ "session-name": { enabled: false } });
		expect(loadCoreSettings()).toEqual({});
	});

	it("a non-object subagents section reads as {}", () => {
		writeGlobal({ subagents: 42 });
		expect(loadCoreSettings()).toEqual({});
	});

	it("accepts any positive integer for maxConcurrency and drops invalid values with unknown keys", () => {
		writeGlobal({ subagents: { fleet: "yes", maxConcurrency: 0, bogus: 1 } });
		expect(loadCoreSettings()).toEqual({});
		writeGlobal({ subagents: { maxConcurrency: 7 } });
		expect(loadCoreSettings()).toEqual({ maxConcurrency: 7 });
		writeGlobal({ subagents: { maxConcurrency: 3.5 } });
		expect(loadCoreSettings()).toEqual({});
		writeGlobal({ subagents: { maxConcurrency: -2 } });
		expect(loadCoreSettings()).toEqual({});
	});

	it("legacy widget/fleetView keys are ignored with a stderr warning (no residue, fleet default on)", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		writeGlobal({ subagents: { widget: "background", fleetView: false } });
		expect(loadCoreSettings()).toEqual({});
		const messages = warn.mock.calls.map((c) => String(c[0]));
		expect(messages.some((m) => m.includes('"widget"'))).toBe(true);
		expect(messages.some((m) => m.includes('"fleetView"'))).toBe(true);
		warn.mockRestore();
	});

	it("a malformed file warns on stderr and reads as absent", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		// Raw write — writeGlobal JSON.stringifies, which would be valid JSON.
		writeFileSync(join(globalDir, "young.json"), "{ not json");
		expect(loadCoreSettings()).toEqual({});
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]?.[0])).toContain("young.json");
	});

	it("the old file names (pi-subagent.json global + project layer) are not read — no back-compat", () => {
		writeFileSync(join(globalDir, "pi-subagent.json"), JSON.stringify({ fleet: false }));
		mkdirSync(join(projDir, ".pi"), { recursive: true });
		writeFileSync(join(projDir, ".pi", "pi-subagent.json"), JSON.stringify({ fleet: false, maxConcurrency: 10 }));
		expect(loadCoreSettings()).toEqual({});
	});
});

describe("settings (reliability + trust keys)", () => {
	it("parses confirmProjectAgents as boolean", () => {
		writeGlobal({ subagents: { confirmProjectAgents: false } });
		expect(loadCoreSettings()).toEqual({ confirmProjectAgents: false });
	});

	it("parses positive-integer stallMs and drops invalid values", () => {
		writeGlobal({ subagents: { stallMs: 120000 } });
		expect(loadCoreSettings()).toEqual({ stallMs: 120000 });
		writeGlobal({ subagents: { stallMs: -1 } });
		expect(loadCoreSettings()).toEqual({});
		writeGlobal({ subagents: { stallMs: 0 } });
		expect(loadCoreSettings()).toEqual({});
	});

	it("parses non-negative wallClockMs (0 = disabled) and drops negatives", () => {
		writeGlobal({ subagents: { wallClockMs: 0 } });
		expect(loadCoreSettings()).toEqual({ wallClockMs: 0 });
		writeGlobal({ subagents: { wallClockMs: 600000 } });
		expect(loadCoreSettings()).toEqual({ wallClockMs: 600000 });
		writeGlobal({ subagents: { wallClockMs: -5 } });
		expect(loadCoreSettings()).toEqual({});
	});
});
