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
import { loadCoreSettings, MAX_CONCURRENCY_OPTIONS } from "../src/concurrency.ts";

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

	it("MAX_CONCURRENCY_OPTIONS is [3, 5, 8, 10]", () => {
		expect([...MAX_CONCURRENCY_OPTIONS]).toEqual([3, 5, 8, 10]);
	});

	it("parses the three keys from the global layer", () => {
		writeGlobal({ widget: "all", fleetView: false, maxConcurrency: 8 });
		expect(loadCoreSettings(projDir)).toEqual({ widget: "all", fleetView: false, maxConcurrency: 8 });
	});

	it("the project layer overrides the global layer per key", () => {
		writeGlobal({ widget: "off", fleetView: true, maxConcurrency: 10 });
		writeProject({ widget: "all", maxConcurrency: 3 });
		// fleetView only set globally → survives the merge.
		expect(loadCoreSettings(projDir)).toEqual({ widget: "all", fleetView: true, maxConcurrency: 3 });
	});

	it("drops invalid values and unknown keys, keeps valid siblings", () => {
		writeProject({ widget: "sometimes", fleetView: "yes", maxConcurrency: 20, bogus: 1 });
		expect(loadCoreSettings(projDir)).toEqual({});
		writeProject({ widget: "off", maxConcurrency: 7 });
		expect(loadCoreSettings(projDir)).toEqual({ widget: "off" });
	});

	it("a malformed file warns on stderr and reads as absent", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		// Raw write — writeGlobal JSON.stringifies, which would be valid JSON.
		writeFileSync(join(globalDir, "pi-subagent.json"), "{ not json");
		// Global layer unreadable → project still read; neither has valid keys.
		writeProject({ fleetView: false });
		expect(loadCoreSettings(projDir)).toEqual({ fleetView: false });
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]?.[0])).toContain("pi-subagent.json");
	});

	it("the pre-rename file name (pi-subagent-core.json) is not read — no back-compat", () => {
		writeFileSync(join(globalDir, "pi-subagent-core.json"), JSON.stringify({ widget: "all", maxConcurrency: 10 }));
		expect(loadCoreSettings(projDir)).toEqual({});
	});
});
