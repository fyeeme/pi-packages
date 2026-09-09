/**
 * pi-goal — pure goal state types.
 *
 * Ported from oh-my-pi (github.com/can1357/oh-my-pi, a fork of badlogic/pi-mono)
 * `packages/coding-agent/src/goals/state.ts` — the data model is carried over
 * verbatim. Dropped from the omp source (host-internal surfaces with no pi
 * counterpart):
 *   - UsageStatistics pick (replaced by the local GoalTokenUsage shape, the
 *     four fields the budget actually accounts for)
 *
 * Goal ids: omp used `Snowflake.next()`; pi-goal uses `crypto.randomUUID()`
 * (ids are opaque uniqueness tokens inside one session — nothing sorts them).
 */

export type GoalStatus = "active" | "paused" | "budget-limited" | "complete" | "dropped";

export interface Goal {
	id: string;
	objective: string;
	status: GoalStatus;
	tokenBudget?: number;
	tokensUsed: number;
	timeUsedSeconds: number;
	createdAt: number;
	updatedAt: number;
	/** Times the agent reported the goal impossible and the independent
	 *  evaluator REFUTED the claim (a confirmed impossibility pauses the goal
	 *  instead). Drives the dispute cap; absent on pre-evaluator snapshots. */
	impossibleReports?: number;
}

export interface GoalModeState {
	enabled: boolean;
	mode: "active" | "exiting";
	reason?: "completed" | "impossible-confirmed" | "impossible-disputed";
	goal: Goal;
}

/** How the independent evaluator resolved the last complete/impossible call
 *  (carried in tool details and surfaced by the result renderer). */
export type GoalEvaluatorVerdict =
	| "confirmed"
	| "rejected"
	| "unavailable-fallback"
	| "impossible-confirmed"
	| "impossible-refuted"
	| "impossible-disputed"
	| "unavailable";

export interface GoalToolDetails {
	op: "create" | "get" | "complete" | "resume" | "drop" | "impossible";
	goal?: Goal | null;
	remainingTokens?: number | null;
	completionBudgetReport?: string | null;
	evaluator?: { verdict: GoalEvaluatorVerdict; reason: string };
}

export type GoalRuntimeEvent =
	| { type: "goal_updated"; goal: Goal | null; state?: GoalModeState }
	| { type: "goal_continuation_requested"; prompt: string };

export interface GoalTokenUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export type GoalBudgetSteering = "allowed" | "suppressed";
export type GoalTerminalMetricEmission = "emit" | "suppress";

// =============================================================================
// Guards (session restore)
// =============================================================================

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether an unknown value is a persisted goal object. */
export function isGoal(value: unknown): value is Goal {
	if (!isRecord(value)) return false;
	if (typeof value.id !== "string" || typeof value.objective !== "string") return false;
	if (
		value.status !== "active" &&
		value.status !== "paused" &&
		value.status !== "budget-limited" &&
		value.status !== "complete" &&
		value.status !== "dropped"
	) {
		return false;
	}
	if (
		value.tokenBudget !== undefined &&
		(typeof value.tokenBudget !== "number" || !Number.isInteger(value.tokenBudget))
	)
		return false;
	if (
		value.impossibleReports !== undefined &&
		(typeof value.impossibleReports !== "number" || !Number.isInteger(value.impossibleReports) || value.impossibleReports < 0)
	)
		return false;
	return (
		typeof value.tokensUsed === "number" &&
		typeof value.timeUsedSeconds === "number" &&
		typeof value.createdAt === "number" &&
		typeof value.updatedAt === "number"
	);
}

/** Whether an unknown value is a persisted `{ enabled, goal }` snapshot. */
export function isGoalStateSnapshot(value: unknown): value is { enabled: boolean; goal: Goal } {
	return isRecord(value) && typeof value.enabled === "boolean" && isGoal(value.goal);
}

export function cloneGoal(goal: Goal): Goal {
	return goal.tokenBudget === undefined
		? { ...goal, tokenBudget: undefined }
		: { ...goal, tokenBudget: goal.tokenBudget };
}

export function cloneState(state: GoalModeState): GoalModeState {
	return { ...state, reason: state.reason, goal: cloneGoal(state.goal) };
}
