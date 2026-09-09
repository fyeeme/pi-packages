/**
 * pi-goal — session persistence helpers.
 *
 * omp persisted goal state through host mode-change entries
 * (sessionManager.appendModeChange("goal" | "goal_paused" | "none", { goal })).
 * pi has no mode-change entries, so the host persist callback writes explicit
 * full-snapshot custom entries instead:
 *
 *   persist("goal", state)        → appendEntry("goal-state", { enabled: true,  goal })
 *   persist("goal_paused", state) → appendEntry("goal-state", { enabled: false, goal })
 *   persist("none")               → appendEntry("goal-cleared", { droppedBy })
 *
 * Restore scans the CURRENT BRANCH backward: the latest `goal-cleared` wins if
 * it is newer than the latest `goal-state`; otherwise the latest valid
 * `goal-state` snapshot applies. Branch awareness comes for free because
 * appendEntry chains off the current leaf. Malformed entries are skipped so a
 * corrupt entry can never break startup.
 */

import { cloneGoal, type GoalModeState, isGoalStateSnapshot } from "./state.ts";

/** Session entry customType for goal state snapshots (see pi.appendEntry). */
export const GOAL_STATE_ENTRY_TYPE = "goal-state";

/** Session entry customType written when a goal is dropped (omp mode "none"). */
export const GOAL_CLEARED_ENTRY_TYPE = "goal-cleared";

/** Session entry customType for the completion summary (omp "goal-completed"). */
export const GOAL_COMPLETED_ENTRY_TYPE = "goal-completed";

interface EntryLike {
	type?: string;
	customType?: string;
	id?: string;
	data?: unknown;
}

export interface RestoredGoal {
	state: GoalModeState;
	/** Entry id the snapshot came from (ordering anchor vs goal-cleared). */
	entryId: string | undefined;
}

export interface RestoredCleared {
	entryId: string | undefined;
}

/**
 * Latest valid `goal-state` snapshot reachable on the current branch, or
 * undefined when none exists.
 */
export function latestGoalStateEntry(entries: readonly unknown[]): RestoredGoal | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as EntryLike | undefined;
		if (!entry || entry.type !== "custom" || entry.customType !== GOAL_STATE_ENTRY_TYPE) continue;
		if (isGoalStateSnapshot(entry.data)) {
			return {
				state: { enabled: entry.data.enabled, mode: "active", goal: cloneGoal(entry.data.goal) },
				entryId: entry.id,
			};
		}
	}
	return undefined;
}

/** Latest `goal-cleared` marker reachable on the current branch, or undefined. */
export function latestGoalClearedEntry(entries: readonly unknown[]): RestoredCleared | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as EntryLike | undefined;
		if (!entry || entry.type !== "custom" || entry.customType !== GOAL_CLEARED_ENTRY_TYPE) continue;
		return { entryId: entry.id };
	}
	return undefined;
}

/**
 * Restore goal state from session entries: a cleared marker newer than the
 * latest snapshot means no goal; otherwise the snapshot applies. Compares by
 * position in the branch (entries arrive in append order).
 */
export function restoreGoalFromEntries(entries: readonly unknown[]): GoalModeState | undefined {
	const cleared = latestGoalClearedEntry(entries);
	const state = latestGoalStateEntry(entries);
	if (!state) return undefined;
	if (cleared && state.entryId !== undefined && cleared.entryId !== undefined) {
		// Both have ids: pick whichever appears later on the branch.
		const clearedIdx = entries.findIndex((e) => (e as EntryLike)?.id === cleared.entryId);
		const stateIdx = entries.findIndex((e) => (e as EntryLike)?.id === state.entryId);
		if (clearedIdx > stateIdx) return undefined;
	}
	return state.state;
}
