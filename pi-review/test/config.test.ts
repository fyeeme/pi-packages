/**
 * config.test.ts — the file-based turn-budget layer: two-layer merge
 * (global ← project), sanitization (invalid → built-in default), and the
 * no-config invariant (defaults equal the numbers the templates were
 * written with, so absence of config changes nothing).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_TURN_BUDGETS, loadFanoutTool, loadTurnBudgets } from "../src/config.ts";

const AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-review-global-"));
const PROJECT_DIR = mkdtempSync(join(tmpdir(), "pi-review-project-"));
const PREV_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;

beforeAll(() => {
	process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
});

afterEach(() => {
	rmSync(join(AGENT_DIR, "young.json"), { force: true });
	rmSync(join(PROJECT_DIR, ".pi"), { recursive: true, force: true });
	vi.restoreAllMocks();
});

afterAll(() => {
	if (PREV_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = PREV_AGENT_DIR;
	rmSync(AGENT_DIR, { recursive: true, force: true });
	rmSync(PROJECT_DIR, { recursive: true, force: true });
});

function writeGlobal(config: unknown): void {
	writeFileSync(join(AGENT_DIR, "young.json"), JSON.stringify({ "pi-review": config }));
}

function writeProject(config: unknown): void {
	mkdirSync(join(PROJECT_DIR, ".pi"), { recursive: true });
	writeFileSync(join(PROJECT_DIR, ".pi", "pi-review.json"), JSON.stringify(config));
}

describe("loadTurnBudgets", () => {
	it("returns the built-in defaults when no config exists anywhere", () => {
		expect(loadTurnBudgets(PROJECT_DIR)).toEqual(DEFAULT_TURN_BUDGETS);
		expect(DEFAULT_TURN_BUDGETS).toEqual({ loop: 3 });
	});

	it("reads the global layer", () => {
		writeGlobal({ maxTurns: { loop: 5 } });
		expect(loadTurnBudgets(PROJECT_DIR)).toEqual({ loop: 5 });
	});

	it("project overrides global per key", () => {
		writeGlobal({ maxTurns: { loop: 5 } });
		writeProject({ maxTurns: { loop: 2 } });
		expect(loadTurnBudgets(PROJECT_DIR)).toEqual({ loop: 2 });
	});

	it("legacy subagent turn budgets are dropped (the parameter no longer exists)", () => {
		writeGlobal({ maxTurns: { subagent: 30, verifier: 25, gapHunt: 40, simplify: 10 } });
		expect(loadTurnBudgets(PROJECT_DIR)).toEqual({ loop: 3 });
	});

	it.each([
		["zero", 0],
		["negative", -3],
		["float", 1.5],
		["string", "3"],
		["null", null],
		["NaN", Number.NaN],
	])("drops invalid %s values in favor of defaults", (_label, value) => {
		writeGlobal({ maxTurns: { loop: value } });
		expect(loadTurnBudgets(PROJECT_DIR)).toEqual(DEFAULT_TURN_BUDGETS);
	});

	it("drops unknown fields and a garbage maxTurns shape", () => {
		writeGlobal({ maxTurns: { finder: 99, subagent: 12 }, unrelated: true });
		expect(loadTurnBudgets(PROJECT_DIR)).toEqual({ loop: 3 });
	});

	it("ignores a malformed file with a warning and keeps defaults", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		writeFileSync(join(AGENT_DIR, "young.json"), "{ not json");
		expect(loadTurnBudgets(PROJECT_DIR)).toEqual(DEFAULT_TURN_BUDGETS);
		expect(warn).toHaveBeenCalledOnce();
		expect(String(warn.mock.calls[0]?.[0])).toContain(AGENT_DIR);
	});

	it("accepts values other than the built-in defaults only via config", () => {
		expect(DEFAULT_TURN_BUDGETS.loop).toBe(3);
		writeProject({ maxTurns: { loop: 7 } });
		expect(loadTurnBudgets(PROJECT_DIR)).toEqual({ loop: 7 });
	});
});

describe("loadFanoutTool (two-layer fanout.tool binding)", () => {
	it("undefined when nothing is configured", () => {
		expect(loadFanoutTool(PROJECT_DIR)).toBeUndefined();
	});

	it("reads the project layer and overrides global", () => {
		writeGlobal({ fanout: { tool: "from-global" } });
		expect(loadFanoutTool(PROJECT_DIR)).toBe("from-global");
		writeProject({ fanout: { tool: "from-project" } });
		expect(loadFanoutTool(PROJECT_DIR)).toBe("from-project");
	});

	it("accepts only a non-empty string; garbage falls through to the other layer", () => {
		writeProject({ fanout: { tool: "   " } });
		writeGlobal({ fanout: { tool: "subagent-parallel" } });
		expect(loadFanoutTool(PROJECT_DIR)).toBe("subagent-parallel");
		writeProject({ fanout: { tool: 42 } });
		expect(loadFanoutTool(PROJECT_DIR)).toBe("subagent-parallel");
		writeGlobal({});
		expect(loadFanoutTool(PROJECT_DIR)).toBeUndefined();
	});

	it("trims the bound tool name so it can match a registered tool", () => {
		writeProject({ fanout: { tool: " subagent-parallel\t" } });
		expect(loadFanoutTool(PROJECT_DIR)).toBe("subagent-parallel");
	});

	it("ignores a malformed file with a warning", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		mkdirSync(join(PROJECT_DIR, ".pi"), { recursive: true });
		writeFileSync(join(PROJECT_DIR, ".pi", "pi-review.json"), "{ not json");
		expect(loadFanoutTool(PROJECT_DIR)).toBeUndefined();
		expect(warn).toHaveBeenCalledOnce();
	});
});
