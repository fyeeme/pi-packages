/**
 * pi-todo — session persistence helpers.
 *
 * omp persisted todo state through the host session (tool result details +
 * user_todo_edit entries). The pi edition persists an explicit full snapshot
 * entry after every successful mutation (`todo-phases`), so restore is a
 * backward scan for the latest valid snapshot on the current branch — branch
 * awareness comes for free because appendEntry chains off the current leaf.
 */

import { clonePhases, isTodoPhaseSnapshot, type TodoPhase } from "./state.ts";

/** Session entry customType for todo snapshots (see pi.appendEntry). */
export const TODO_PHASES_ENTRY_TYPE = "todo-phases";

/** Session entry customType for stop-time reminders. */
export const TODO_REMINDER_ENTRY_TYPE = "todo-reminder";

/**
 * Reconstruct todo state from session entries: the latest valid
 * `todo-phases` snapshot reachable on the current branch wins; malformed
 * entries are skipped so a corrupt entry can never break startup.
 */
export function restorePhasesFromEntries(entries: readonly unknown[]): TodoPhase[] {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type?: string; customType?: string; data?: unknown } | undefined;
		if (!entry || entry.type !== "custom" || entry.customType !== TODO_PHASES_ENTRY_TYPE) continue;
		if (isTodoPhaseSnapshot(entry.data)) {
			return clonePhases(entry.data.phases);
		}
	}
	return [];
}
