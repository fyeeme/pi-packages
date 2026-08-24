/**
 * src/format.ts — shared parsing helper used by the runner.
 *
 * stepIdOf: callId → step-id attribution, used by the runner (degraded-step
 * accounting, sibling abort scoping) and by the engine's dispatchOpts (the
 * monitor `displayName` for the shared sub-agent UI). The former ANSI color
 * helpers + fmtTokens were progress-widget/`/wf-inspect` rendering aids and
 * were removed together with those surfaces (live progress is now rendered by
 * the shared @fyeeme/pi-subagents extension).
 */

/** Extract the step id from a callId of the form `${stepId}#${n}` (e.g.
 *  "fan#2", "adv#produce", "cr#classify"). Falls back to the whole callId when
 *  there is no '#'. Used to attribute null-degraded calls to their step. */
export function stepIdOf(callId: string): string {
	const sep = callId.lastIndexOf("#");
	return sep >= 0 ? callId.slice(0, sep) : callId;
}
