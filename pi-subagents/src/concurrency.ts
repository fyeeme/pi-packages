/**
 * concurrency.ts — file-based configuration for this package (settings + ceiling policy).
 *
 * Read-only. Two layers, project overriding global:
 *   - Global:  <agentDir>/pi-subagent.json — user-wide defaults.
 *   - Project: <cwd>/.pi/pi-subagent.json — overrides global on load.
 *
 * Keys (all optional):
 *   widget         "all" | "background" (default) | "off" — the above-editor widget
 *   fleetView      boolean, default true — the below-editor FleetView
 *   maxConcurrency 3 | 5 (default) | 8 | 10 — fan-out concurrency ceiling
 *
 * `widget`/`fleetView` are read once per process at extension start (changes
 * apply on the next pi session); `maxConcurrency` is read at call time (see
 * dispatch.ts getEffectiveMaxConcurrency) so an edited file takes effect on
 * the next fan-out without a restart. No read cache: this fires once per
 * fan-out, where a small JSON read is noise next to spawning subprocesses.
 *
 * Malformed files are ignored with a stderr warning (never fatal — callers
 * fall back to defaults), and unknown/garbage fields are dropped on read.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Settings file name (both layers). */
const SETTINGS_FILE = "pi-subagent.json";

/**
 * Display mode for the persistent above-editor agent widget.
 * - `all`: show every agent.
 * - `background`: hide foreground agents (background === false — they already
 *   render inline as the tool result); everything else stays visible.
 * - `off`: hide the widget entirely.
 */
export type WidgetMode = "all" | "background" | "off";

/** Allowed values for `maxConcurrency` (the concurrent-agents ceiling). */
export const MAX_CONCURRENCY_OPTIONS = [3, 5, 8, 10] as const;

/** One allowed `maxConcurrency` value. */
export type MaxConcurrencyOption = (typeof MAX_CONCURRENCY_OPTIONS)[number];

/** Package settings read from the two config layers. */
export interface SubagentCoreSettings {
	widget?: WidgetMode;
	/**
	 * Whether the below-editor FleetView is shown. Defaults to `true`. Pure
	 * UI: when `false`, the list never registers and its global input hook
	 * never captures keys; the above-editor widget and /agents are unaffected.
	 */
	fleetView?: boolean;
	/**
	 * Default concurrency ceiling for sub-agent fan-out (concurrent agents
	 * count). Must be one of {@link MAX_CONCURRENCY_OPTIONS}; any other value
	 * in the file is dropped and the hardcoded default (5) applies. A
	 * consumer-supplied env override (e.g. pi-review's
	 * PI_MAX_CONCURRENT_SUBAGENTS) still takes precedence over this file.
	 */
	maxConcurrency?: MaxConcurrencyOption;
}

const VALID_WIDGET_MODES: ReadonlySet<string> = new Set<WidgetMode>(["all", "background", "off"]);
const VALID_CONCURRENCY: ReadonlySet<number> = new Set<number>(MAX_CONCURRENCY_OPTIONS);

function globalPath(): string {
	return join(getAgentDir(), SETTINGS_FILE);
}

function projectPath(cwd: string): string {
	return join(cwd, ".pi", SETTINGS_FILE);
}

/** Drop fields that don't match the expected shape. Silent — garbage becomes absent. */
function sanitize(raw: unknown): SubagentCoreSettings {
	if (!raw || typeof raw !== "object") return {};
	const r = raw as Record<string, unknown>;
	const out: SubagentCoreSettings = {};
	if (typeof r.widget === "string" && VALID_WIDGET_MODES.has(r.widget)) {
		out.widget = r.widget as WidgetMode;
	}
	if (typeof r.fleetView === "boolean") {
		out.fleetView = r.fleetView;
	}
	if (typeof r.maxConcurrency === "number" && VALID_CONCURRENCY.has(r.maxConcurrency)) {
		out.maxConcurrency = r.maxConcurrency as MaxConcurrencyOption;
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
	return { ...readSettingsFile(globalPath()), ...readSettingsFile(projectPath(cwd)) };
}
