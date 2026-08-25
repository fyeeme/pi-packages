/**
 * settings.test.ts — unit tests for the file-based configuration
 * (pi-subagent.json, two layers, sanitized keys).
 *
 * The global layer is pinned via PI_CODING_AGENT_DIR (pi's agent-dir env
 * override, honored by getAgentDir) so tests never touch the real
 * ~/.pi/agent; the project layer is a temp cwd passed to loadCoreSettings.
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
	writeFileSync(join(globalDir, "pi-subagent.json"), JSON.stringify(obj));
}

function writeProject(obj: unknown): void {
	mkdirSync(join(projDir, ".pi"), { recursive: true });
	writeFileSync(join(projDir, ".pi", "pi-subagent.json"), JSON.stringify(obj));
}

describe("settings (pi-subagent.json)", () => {
	it("returns {} with no files (all defaults)", () => {
		expect(loadCoreSettings(projDir)).toEqual({});
	});

	it("parses the settings keys from the global layer", () => {
		writeGlobal({ fleet: false, maxConcurrency: 8 });
		expect(loadCoreSettings(projDir)).toEqual({ fleet: false, maxConcurrency: 8 });
	});

	it("the project layer overrides the global layer per key", () => {
		writeGlobal({ fleet: true, maxConcurrency: 10 });
		writeProject({ maxConcurrency: 3 });
		// fleet only set globally → survives the merge.
		expect(loadCoreSettings(projDir)).toEqual({ fleet: true, maxConcurrency: 3 });
	});

	it("accepts any positive integer for maxConcurrency and drops invalid values with unknown keys", () => {
		writeProject({ fleet: "yes", maxConcurrency: 0, bogus: 1 });
		expect(loadCoreSettings(projDir)).toEqual({});
		writeProject({ maxConcurrency: 7 });
		expect(loadCoreSettings(projDir)).toEqual({ maxConcurrency: 7 });
		writeProject({ maxConcurrency: 3.5 });
		expect(loadCoreSettings(projDir)).toEqual({});
		writeProject({ maxConcurrency: -2 });
		expect(loadCoreSettings(projDir)).toEqual({});
	});

	it("legacy widget/fleetView keys are ignored with a stderr warning (no residue, fleet default on)", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		writeGlobal({ widget: "background", fleetView: false });
		expect(loadCoreSettings(projDir)).toEqual({});
		const messages = warn.mock.calls.map((c) => String(c[0]));
		expect(messages.some((m) => m.includes('"widget"'))).toBe(true);
		expect(messages.some((m) => m.includes('"fleetView"'))).toBe(true);
		warn.mockRestore();
	});

	it("a malformed file warns on stderr and reads as absent", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		// Raw write — writeGlobal JSON.stringifies, which would be valid JSON.
		writeFileSync(join(globalDir, "pi-subagent.json"), "{ not json");
		// Global layer unreadable → project still read; neither has valid keys.
		writeProject({ fleet: false });
		expect(loadCoreSettings(projDir)).toEqual({ fleet: false });
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]?.[0])).toContain("pi-subagent.json");
	});

	it("the pre-rename file name (pi-subagent-core.json) is not read — no back-compat", () => {
		writeFileSync(join(globalDir, "pi-subagent-core.json"), JSON.stringify({ fleet: true, maxConcurrency: 10 }));
		expect(loadCoreSettings(projDir)).toEqual({});
	});
});

describe("settings (reliability + trust keys)", () => {
	it("parses confirmProjectAgents as boolean", () => {
		writeProject({ confirmProjectAgents: false });
		expect(loadCoreSettings(projDir)).toEqual({ confirmProjectAgents: false });
	});

	it("parses positive-integer stallMs and drops invalid values", () => {
		writeProject({ stallMs: 120000 });
		expect(loadCoreSettings(projDir)).toEqual({ stallMs: 120000 });
		writeProject({ stallMs: -1 });
		expect(loadCoreSettings(projDir)).toEqual({});
		writeProject({ stallMs: 0 });
		expect(loadCoreSettings(projDir)).toEqual({});
	});

	it("parses non-negative wallClockMs (0 = disabled) and drops negatives", () => {
		writeProject({ wallClockMs: 0 });
		expect(loadCoreSettings(projDir)).toEqual({ wallClockMs: 0 });
		writeProject({ wallClockMs: 600000 });
		expect(loadCoreSettings(projDir)).toEqual({ wallClockMs: 600000 });
		writeProject({ wallClockMs: -5 });
		expect(loadCoreSettings(projDir)).toEqual({});
	});
});
