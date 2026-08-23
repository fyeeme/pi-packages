/**
 * settings.ts — file-based configuration for this package.
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
 * index.ts getEffectiveMaxConcurrency) so an edited file takes effect on the
 * next fan-out without a restart. Reads are cached per file keyed on
 * (mtimeMs, size) — an unchanged file costs one stat instead of read+parse,
 * while any edit changes the stamp and is picked up by the very next read.
 *
 * Malformed files are ignored with a stderr warning (never fatal — callers
 * fall back to defaults), and unknown/garbage fields are dropped on read.
 */
import { readFileSync, statSync } from "node:fs";
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

/**
 * Per-file cache: valid while the file's (mtimeMs, size) stamp is unchanged.
 * Fan-outs resolve the ceiling per call, so unchanged files skip the
 * read + JSON.parse while the "edit takes effect immediately" property is
 * preserved (any write changes the stamp).
 */
const fileCache = new Map<string, { stamp: string; settings: SubagentCoreSettings }>();

/** Current change stamp, or null when the file is missing/unstatable.
 *  ctimeMs is included because it changes on ANY write — a same-size rewrite
 *  within the same mtime tick (coarse-granularity filesystems, editor atomic
 *  saves) would otherwise serve a stale cached parse. */
function statStamp(path: string): string | null {
	try {
		const st = statSync(path);
		return `${st.mtimeMs}:${st.ctimeMs}:${st.size}`;
	} catch {
		return null;
	}
}

/** Read one settings file; missing file → {}. Unparseable file → warn + {}. */
function readSettingsFile(path: string): SubagentCoreSettings {
	const stamp = statStamp(path);
	if (stamp === null) {
		fileCache.delete(path);
		return {};
	}
	const cached = fileCache.get(path);
	if (cached && cached.stamp === stamp) return cached.settings;
	let settings: SubagentCoreSettings;
	try {
		settings = sanitize(JSON.parse(readFileSync(path, "utf-8")));
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		console.warn(`[pi-subagent-core] Ignoring malformed settings at ${path}: ${reason}`);
		settings = {};
	}
	fileCache.set(path, { stamp, settings });
	return settings;
}

/** Load merged settings: global provides defaults, project overrides. */
export function loadCoreSettings(cwd: string = process.cwd()): SubagentCoreSettings {
	return { ...readSettingsFile(globalPath()), ...readSettingsFile(projectPath(cwd)) };
}
