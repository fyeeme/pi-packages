/**
 * ui/shared.ts — formatting helpers + theme surface shared by the agent
 * widget, FleetView, and the conversation viewer.
 *
 * Ported from tintinweb/pi-subagents (src/ui/agent-widget.ts) and adapted to
 * this package's monitor state. All functions are pure and total: garbage in →
 * degraded-but-safe output, never a throw (the UI must not take down a spawn).
 */
/** Structural subset of pi's interactive Theme (fg + bold is all we use). */
export type Theme = {
	fg(color: string, text: string): string;
	bold(text: string): string;
};

/** Braille spinner frames for the animated running indicator. */
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** Tool name → human-readable action for activity descriptions. */
const TOOL_DISPLAY: Record<string, string> = {
	read: "reading",
	bash: "running command",
	edit: "editing",
	write: "writing",
	grep: "searching",
	find: "finding files",
	ls: "listing",
};

/** Apply foreground styling while restoring it after nested ANSI resets. */
export function fgPreservingNestedStyles(theme: Theme, color: string, text: string): string {
	const styledEmpty = theme.fg(color, "");
	const styleStart = styledEmpty.replace(/\u001b\[(?:0|39)m/g, "");
	return theme.fg(color, text.replace(/\u001b\[(?:0|39)m/g, (reset) => `${reset}${styleStart}`));
}

/** Compact a token count: "33.8k" / "1.2M" / "512". Shared by the widget
 *  and fleet renderings so the compaction tiers cannot drift apart. */
function compactCount(count: number): string {
	if (!Number.isFinite(count) || count <= 0) return "0";
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
	return `${Math.round(count)}`;
}

/** Format a token count compactly: "33.8k token", "1.2M token". */
export function formatTokens(count: number): string {
	return `${compactCount(count)} token`;
}

/**
 * Token count with optional context-fill % and compaction-count annotations.
 * Percent thresholds: <70% dim, 70–85% warning, ≥85% error. Compactions render
 * as `⇊N` in dim. `percent === null` omits the percent (no declared context
 * window, or briefly right after compaction).
 *
 *   "12.3k token" | "12.3k token (45%)" | "12.3k token (⇊2)" | "12.3k token (45% · ⇊2)"
 */
export function formatSessionTokens(
	tokens: number,
	percent: number | null,
	theme: Theme,
	compactions = 0,
): string {
	const tokenStr = formatTokens(tokens);
	const annot: string[] = [];
	if (percent !== null && Number.isFinite(percent) && percent >= 0) {
		const color = percent >= 85 ? "error" : percent >= 70 ? "warning" : "dim";
		annot.push(theme.fg(color, `${Math.round(percent)}%`));
	}
	if (compactions > 0) {
		annot.push(theme.fg("dim", `⇊${compactions}`));
	}
	if (annot.length === 0) return tokenStr;
	return `${tokenStr} (${annot.join(" · ")})`;
}

/** Format turn count with optional max limit: "↻5≤30" or "↻5". */
export function formatTurns(turnCount: number, maxTurns?: number | null): string {
	const turns = Number.isFinite(turnCount) && turnCount > 0 ? Math.round(turnCount) : 0;
	return maxTurns != null && Number.isFinite(maxTurns) && maxTurns > 0 ? `↻${turns}≤${Math.round(maxTurns)}` : `↻${turns}`;
}

/** Format milliseconds as "12.3s" / "2m17s". */
export function formatMs(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) ms = 0;
	const totalSeconds = Math.floor(ms / 1000);
	if (totalSeconds < 60) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

/** Fleet row elapsed: integer seconds ("11s"), matching Claude Code. */
export function formatFleetElapsed(ms: number): string {
	return `${Math.max(0, Math.round(ms / 1000))}s`;
}

/** Fleet row tokens: "↓ 13.1k tokens". */
export function formatFleetTokens(count: number): string {
	return `↓ ${compactCount(count)} tokens`;
}

/** Truncate text to a single line, max `len` chars. */
export function truncateLine(text: string, len = 60): string {
	const line = text.split("\n").find((l) => l.trim())?.trim() ?? "";
	if (line.length <= len) return line;
	return `${line.slice(0, len)}…`;
}

/** Build a human-readable activity string from in-flight tools or response text. */
export function describeActivity(activeTools: ReadonlyMap<string, string>, responseText?: string): string {
	if (activeTools.size > 0) {
		const groups = new Map<string, number>();
		for (const toolName of activeTools.values()) {
			const action = TOOL_DISPLAY[toolName] ?? toolName;
			groups.set(action, (groups.get(action) ?? 0) + 1);
		}
		const parts: string[] = [];
		for (const [action, count] of groups) {
			if (count > 1) parts.push(`${action} ${count} ${action === "searching" ? "patterns" : "files"}`);
			else parts.push(action);
		}
		return `${parts.join(", ")}…`;
	}
	if (responseText && responseText.trim().length > 0) {
		return truncateLine(responseText);
	}
	return "thinking…";
}

/**
 * Context-window utilization percent for a model id, resolved against the
 * session model catalog (see {@link setModelCatalog}). Returns null when the
 * model has no declared contextWindow (unknown ids) — callers then omit the
 * annotation.
 */
export function contextUtilizationPercent(contextTokens: number, modelId: string | undefined): number | null {
	const contextWindow = resolveContextWindow(modelId);
	if (contextWindow == null || contextWindow <= 0 || !Number.isFinite(contextTokens) || contextTokens <= 0) {
		return null;
	}
	return (contextTokens / contextWindow) * 100;
}

/** Minimal model shape the UI needs from the session catalog. */
export interface CatalogModel {
	id: string;
	contextWindow: number;
}

let contextWindowIndex: Map<string, number> | undefined;

/**
 * Seed the id → contextWindow index from the session's model catalog
 * (ctx.modelRegistry.getAll() at session_start). Purely additive: without a
 * seeded catalog the percent annotation is simply omitted.
 */
export function setModelCatalog(models: readonly CatalogModel[]): void {
	contextWindowIndex = new Map<string, number>();
	for (const model of models) {
		if (!model || typeof model.id !== "string" || !Number.isFinite(model.contextWindow)) continue;
		if (!contextWindowIndex.has(model.id)) {
			contextWindowIndex.set(model.id, model.contextWindow);
		}
	}
}

/** Test hook: drop the seeded catalog. */
export function clearModelCatalog(): void {
	contextWindowIndex = undefined;
}

function resolveContextWindow(modelId: string | undefined): number | undefined {
	if (!modelId) return undefined;
	if (!contextWindowIndex) return undefined;
	const exact = contextWindowIndex.get(modelId);
	if (exact != null) return exact;
	// Some surfaces reference models as "provider/model" — retry the bare id.
	const slash = modelId.lastIndexOf("/");
	if (slash >= 0 && slash < modelId.length - 1) {
		const bare = contextWindowIndex.get(modelId.slice(slash + 1));
		if (bare != null) return bare;
	}
	return undefined;
}
