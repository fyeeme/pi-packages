/**
 * Run identity — deterministic by construction.
 *
 * Claude Code's workflow engine bans Date.now()/Math.random()/new Date()
 * inside workflow scripts because non-deterministic id generation breaks
 * resume cache hits: same script → different runId → different cache keys
 * → the journal never replays. The removed pi prototype used
 * `run-${Date.now()}-${Math.random()}` exactly this anti-pattern.
 *
 * This module is the fix: `generateRunId` is a PURE function of
 * (timestamp, sequence), both supplied by the caller. The runtime obtains the
 * timestamp once at run inception and passes it down; workflow bodies never
 * read "now" themselves (the ast-guard in `determinism/` enforces that).
 */

export interface RunIdInput {
	/** Inception epoch ms. Supplied by the caller; never read from Date.now() here. */
	readonly timestamp: number;
	/** Monotonic per-caller counter. Disambiguates runs that share a timestamp. */
	readonly sequence: number;
}

/**
 * Build a run id deterministically. Same (timestamp, sequence) → identical id.
 *
 * Format mirrors the removed prototype's `run-<base36>-<base36>` shape, but the
 * second slot is a zero-padded sequence (was `Math.random().slice(2,8)`).
 */
export function generateRunId(input: RunIdInput): string {
	const ts = input.timestamp.toString(36);
	const seq = input.sequence.toString(36).padStart(4, "0");
	return `run-${ts}-${seq}`;
}
