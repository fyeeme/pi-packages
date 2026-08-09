/**
 * src/format.ts — shared display/parsing helpers (progress widget + /wf-inspect + runner).
 *
 * fmtTokens + ANSI color helpers: used by `buildProgressWidget` (index.ts) and
 * `WorkflowInspect` (src/inspect.ts) — one copy so the two UIs cannot drift.
 * stepIdOf: callId → step-id attribution, used by the runner (degraded-step
 * accounting) and the widget (grouping by step). Extracted from the verbatim
 * duplicates that used to live in each file.
 */
export const GREEN = (s: string): string => `\x1b[32m${s}\x1b[0m`;
export const RED = (s: string): string => `\x1b[31m${s}\x1b[0m`;
export const YELLOW = (s: string): string => `\x1b[33m${s}\x1b[0m`;
export const DIM = (s: string): string => `\x1b[2m${s}\x1b[0m`;
export const CYAN = (s: string): string => `\x1b[36m${s}\x1b[0m`;
export const BOLD = (s: string): string => `\x1b[1m${s}\x1b[0m`;

export function fmtTokens(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** Extract the step id from a callId of the form `${stepId}#${n}` (e.g.
 *  "fan#2", "adv#produce", "cr#classify"). Falls back to the whole callId when
 *  there is no '#'. Used to attribute null-degraded calls to their step. */
export function stepIdOf(callId: string): string {
	const sep = callId.lastIndexOf("#");
	return sep >= 0 ? callId.slice(0, sep) : callId;
}
