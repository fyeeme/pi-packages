/**
 * concurrency.ts — file-based configuration for this package (settings + ceiling policy).
 *
 * Read-only. Two layers, project overriding global:
 *   - Global:  <agentDir>/pi-subagent.json — user-wide defaults.
 *   - Project: <cwd>/.pi/pi-subagent.json — overrides global on load.
 *
 *   fleet           boolean, default true — the below-editor fleet surface
 *   maxConcurrency  positive integer (default 5) — fan-out concurrency ceiling
 *
 * `fleet` is read once per process at extension start (changes apply on the
 * the next pi session); `maxConcurrency` is read at call time (see dispatch.ts
 * getEffectiveMaxConcurrency) so an edited file takes effect on the next
 * fan-out without a restart. No read cache: this fires once per fan-out,
 * where a small JSON read is noise next to spawning subprocesses.
 *
 * Malformed files are ignored with a stderr warning (never fatal — callers
 * fall back to defaults), and unknown/garbage fields are dropped on read.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Settings file name (both layers). */
const SETTINGS_FILE = "pi-subagent.json";

/** Package settings read from the two config layers. */
export interface SubagentCoreSettings {
	/**
	 * Whether the below-editor fleet surface is shown. Defaults to `true`.
	 * Pure UI: when `false`, the list never registers and its global input
	 * hook never captures keys.
	 */
	fleet?: boolean;
	/**
	 * Concurrency ceiling for sub-agent fan-out (concurrent agents count).
	 * Any positive integer is accepted; non-positive / non-integer values in
	 * the file are dropped and the hardcoded default (5) applies.
	 */
	maxConcurrency?: number;
	/**
	 * Prompt before running project-local agents (interactive sessions only).
	 * Defaults to `true`. Deliberately NOT a tool parameter: the model cannot
	 * weaken its own supervision.
	 */
	confirmProjectAgents?: boolean;
	/**
	 * Stall watchdog threshold in ms — a call with no subprocess event for
	 * this long is aborted. Defaults to 60000.
	 */
	stallMs?: number;
	/**
	 * Wall-clock ceiling in ms per call; 0 disables. Must be ≥ 2× the stall
	 * threshold when enabled; defaults to 0 (disabled).
	 */
	wallClockMs?: number;
}

function isPositiveInt(v: unknown): v is number {
	return typeof v === "number" && Number.isInteger(v) && v > 0;
}

function isNonNegativeInt(v: unknown): v is number {
	return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

function sanitize(raw: unknown): SubagentCoreSettings {
	if (!raw || typeof raw !== "object") return {};
	const r = raw as Record<string, unknown>;
	const out: SubagentCoreSettings = {};
	if (typeof r.fleet === "boolean") {
		out.fleet = r.fleet;
	} else if (typeof r.fleetView === "boolean") {
		console.warn('[pi-subagents] Setting "fleetView" was renamed to "fleet" — ignoring it');
	}
	if (typeof r.widget === "string") {
		console.warn(
			'[pi-subagents] Setting "widget" was removed — the fleet surface is the single UI (key "fleet") — ignoring it',
		);
	}
	if (isPositiveInt(r.maxConcurrency)) {
		out.maxConcurrency = r.maxConcurrency;
	}
	if (typeof r.confirmProjectAgents === "boolean") {
		out.confirmProjectAgents = r.confirmProjectAgents;
	}
	if (isPositiveInt(r.stallMs)) {
		out.stallMs = r.stallMs;
	}
	if (isNonNegativeInt(r.wallClockMs)) {
		out.wallClockMs = r.wallClockMs;
	}
	return out;
}

/** Read one settings file; missing file → {} (the normal case, silent).
 *  Unparseable file → warn + {}. */
function readSettingsFile(path: string): SubagentCoreSettings {
	if (!existsSync(path)) return {};
	try {
		return sanitize(JSON.parse(readFileSync(path, "utf-8")));
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		console.warn(`[pi-subagents] Ignoring malformed settings at ${path}: ${reason}`);
		return {};
	}
}

/** Load merged settings: global provides defaults, project overrides. */
export function loadCoreSettings(cwd: string = process.cwd()): SubagentCoreSettings {
	const globalSettings = readSettingsFile(join(getAgentDir(), SETTINGS_FILE));
	const projectSettings = readSettingsFile(join(cwd, ".pi", SETTINGS_FILE));
	return { ...globalSettings, ...projectSettings };
}
