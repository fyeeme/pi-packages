/**
 * src/config.ts — file-based configuration, following the shared young.json
 * convention (read-only, lenient, two layers with project overriding global):
 *
 *   - Global:  <agentDir>/young.json → the "pi-review" section
 *              (top-level keys isolate extensions — same file pi-subagents'
 *              "subagents" section and session-name live in)
 *   - Project: <cwd>/.pi/pi-review.json    (whole file, overrides global)
 *
 * Schema (all keys optional, same shape at both layers — at the global layer
 * this is the CONTENTS of the "pi-review" section):
 *
 *   {
 *     "maxTurns": { "loop": 3 },
 *     "fanout":   { "tool": "subagent" }
 *   }
 *
 * NOTE: sticky runtime STATE (codeReviewLastEffort / maxFindings) stays in
 * <agentDir>/pi-review.json — that file is state, not config; it is written
 * by the dispatcher and never read here.
 *
 * With no config file — or with any key absent or invalid — the rendered
 * instructions carry the built-in defaults, so absence of configuration
 * changes nothing.
 *
 * Read at command time (like pi-subagents' maxConcurrency): an edited file
 * takes effect on the next /code-review or /code-simplify without a restart.
 * Malformed files are ignored with a stderr warning (never fatal);
 * unknown/garbage fields are dropped on read.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Project-layer settings file name. */
const CONFIG_FILE = "pi-review.json";
/** Shared per-user settings file; this package owns its "pi-review" section. */
const SHARED_SETTINGS_FILE = "young.json";
const SHARED_SETTINGS_SECTION = "pi-review";

/** The dispatchable budgets. `subagent` turn budgets were removed: agent
 * tasks run to natural completion (only the fix→re-review loop count
 * remains configurable). */
export interface TurnBudgets {
	/** Max fix→re-review rounds when /code-review runs with --loop. */
	loop: number;
}

/** Built-in budget — identical to the literal in prompts/ and skills/. */
export const DEFAULT_TURN_BUDGETS: TurnBudgets = {
	loop: 3,
};

function globalPath(): string {
	return join(getAgentDir(), SHARED_SETTINGS_FILE);
}

function projectPath(cwd: string): string {
	return join(cwd, ".pi", CONFIG_FILE);
}

/** Read one JSON file as a plain object. Missing file → {} (the normal case,
 *  silent). Unparseable file → warn + {}. Arrays/scalars → {}. Never fatal. */
function readJsonFile(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	try {
		const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
		return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		console.warn(`[pi-review] Ignoring malformed config at ${path}: ${reason}`);
		return {};
	}
}

/** Read one config layer: the whole project file, or this package's section
 *  of the shared young.json (absent section → {}). */
function readLayer(path: string, section: string | undefined): Record<string, unknown> {
	const whole = readJsonFile(path);
	if (section === undefined) return whole;
	const sec = whole[section];
	return sec && typeof sec === "object" && !Array.isArray(sec) ? (sec as Record<string, unknown>) : {};
}

/** Positive integers only; anything else (floats, 0, negatives, strings) is
 *  dropped so the built-in default applies. */
function sanitizeBudget(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : undefined;
}

/** The `fanout.tool` value of one layer: a trimmed, non-empty string, or
 *  undefined (the dispatcher then uses the next layer / the default). */
function fanoutToolFrom(layer: Record<string, unknown>): string | undefined {
	const fanout = layer.fanout;
	if (!fanout || typeof fanout !== "object") return undefined;
	const tool = (fanout as Record<string, unknown>).tool;
	return typeof tool === "string" && tool.trim() ? tool.trim() : undefined;
}

/** Read the two-layer `fanout.tool` binding (project overrides global; the
 *  global layer is only read when the project layer binds nothing). */
export function loadFanoutTool(cwd: string = process.cwd()): string | undefined {
	return (
		fanoutToolFrom(readLayer(projectPath(cwd), undefined)) ??
		fanoutToolFrom(readLayer(globalPath(), SHARED_SETTINGS_SECTION))
	);
}

/** The `maxTurns.loop` value of one layer, before sanitization. Legacy
 *  maxTurns.subagent/verifier/gapHunt/simplify entries are read and dropped
 *  on purpose: agent turn budgets no longer exist. */
function loopOf(layer: Record<string, unknown>): unknown {
	const mt = layer.maxTurns;
	return mt && typeof mt === "object" ? (mt as Record<string, unknown>).loop : undefined;
}

/** Load the effective turn budgets: built-in default ← global (young.json
 *  "pi-review" section) ← project (.pi/pi-review.json). */
export function loadTurnBudgets(cwd: string = process.cwd()): TurnBudgets {
	return {
		loop:
			sanitizeBudget(loopOf(readLayer(projectPath(cwd), undefined))) ??
			sanitizeBudget(loopOf(readLayer(globalPath(), SHARED_SETTINGS_SECTION))) ??
			DEFAULT_TURN_BUDGETS.loop,
	};
}
