/**
 * pi-goal — tool definition.
 *
 * Ported from oh-my-pi `packages/coding-agent/src/goals/tools/goal-tool.ts`
 * (GoalTool + renderer). Adaptations for pi's extension API:
 *
 *   omp surface                          → pi adaptation
 *   ─────────────────────────────────────────────────────────────────────────
 *   ArkType schema + type()              → TypeBox schema
 *   AgentTool class + ToolSession        → ToolDefinition + closure deps
 *   concurrency: "exclusive"             → executionMode: "sequential"
 *   renderStatusLine/framedBlock/mergeCallAndResult
 *                                        → split renderCall/renderResult with
 *                                            pi-tui Text components (pi-todo
 *                                            precedent)
 *   ToolError                            → throw Error (pi contract:
 *                                            tools fail by throwing)
 *   strict/intent fields                 → dropped (omp host-internal)
 *
 * omp operation semantics are kept verbatim for create/get/resume/drop:
 * create requires objective and only works without an existing live goal;
 * get reads state; resume reactivates paused goals; drop discards.
 *
 * DELIBERATE DEVIATION from omp (absorbed from CC 2.1.261's goal design):
 * completion is no longer self-graded. `complete` requires an `evidence`
 * audit and is gated by an independent evaluator subprocess (src/evaluator.ts)
 * that re-verifies the repo itself; a refuted claim keeps the goal active and
 * returns the evaluator's findings. `impossible` is a new op: the agent
 * reports the goal unachievable, the evaluator independently confirms (the
 * claim is evidence, not proof); confirmation pauses the goal, refutation
 * counts toward a dispute cap that pauses it for a human decision.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import type { Theme, ThemeColor, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { GoalEvaluatorOutcome, GoalEvaluatorRequest } from "./evaluator.ts";
import { formatDuration, formatNumber } from "./format.ts";
import type { GoalRuntime } from "./runtime.ts";
import { completionBudgetReport, remainingTokens } from "./runtime.ts";
import type { Goal, GoalModeState, GoalStatus, GoalToolDetails } from "./state.ts";

// Prompt lives in a static .md asset next to this module (published with the
// package). Loaded at runtime: pi loads extensions through jiti, which does
// not support bundler-style text imports (pi-todo precedent).
const goalDescription = readFileSync(
	path.join(path.dirname(fileURLToPath(import.meta.url)), "prompts", "goal.md"),
	"utf8",
);

export const GOAL_OPS = ["create", "get", "complete", "resume", "drop", "impossible"] as const;

/** Unconfirmed impossibility claims tolerated before the goal is paused for
 *  a human decision (CC 2.1.261 caps its idle check-ins the same way). */
export const IMPOSSIBLE_REPORT_CAP = 2;

export const GoalParamsSchema = Type.Object({
	// StringEnum (not Type.Union/Type.Literal): TypeBox literal unions do not
	// serialize for Google's API (docs/extensions.md, Custom Tools).
	op: StringEnum(GOAL_OPS, { description: "goal operation" }),
	objective: Type.Optional(Type.String({ description: "goal objective" })),
	token_budget: Type.Optional(Type.Integer({ description: "token budget" })),
	evidence: Type.Optional(
		Type.String({
			description:
				"op=complete 时必填：逐交付物的当前仓库状态审计（读了哪些文件、跑了哪些检查、观察到什么输出）——独立评估器以此为起点复核。",
		}),
	),
	reason: Type.Optional(
		Type.String({
			description:
				"op=impossible 时必填：为何目标在本会话确实无法达成（自相矛盾 / 依赖不可用资源 / 合理尝试已穷尽），附证据——评估器将独立核实。",
		}),
	),
});

export type GoalToolInput = Static<typeof GoalParamsSchema>;

export interface GoalToolResponse {
	goal: Goal | null;
	remainingTokens: number | null;
	completionBudgetReport: string | null;
}

export function buildGoalToolResponse(
	goal: Goal | null | undefined,
	options?: { includeCompletionReport?: boolean },
): GoalToolResponse {
	const resolvedGoal = goal ?? null;
	return {
		goal: resolvedGoal,
		remainingTokens: remainingTokens(resolvedGoal),
		completionBudgetReport:
			options?.includeCompletionReport && resolvedGoal?.status === "complete"
				? completionBudgetReport(resolvedGoal)
				: null,
	};
}

function validateCreateParams(params: GoalToolInput): { objective: string; tokenBudget?: number } {
	const objective = params.objective?.trim();
	if (!objective) {
		throw new Error("objective is required when op=create");
	}
	const tokenBudget = params.token_budget;
	if (tokenBudget !== undefined && (!Number.isInteger(tokenBudget) || tokenBudget <= 0)) {
		throw new Error("token_budget must be a positive integer when provided");
	}
	return { objective, tokenBudget };
}

export type GoalEvaluatorFn = (
	request: GoalEvaluatorRequest,
	opts: { cwd?: string; signal?: AbortSignal },
) => Promise<GoalEvaluatorOutcome>;

export interface GoalToolDeps {
	/** The session goal runtime (create/resume/drop/complete flow through it). */
	getRuntime(): GoalRuntime;
	/** Current in-memory goal state (get reads it). */
	getState(): GoalModeState | undefined;
	/** Independent completion/impossibility evaluator (src/evaluator.ts).
	 *  Gates `complete` and adjudicates `impossible`. */
	runEvaluator: GoalEvaluatorFn;
}

function describeEvaluatorVerdict(verdict: string): string {
	switch (verdict) {
		case "confirmed":
			return "completion confirmed";
		case "rejected":
			return "completion rejected";
		case "unavailable-fallback":
			return "evaluator unavailable";
		case "impossible-confirmed":
			return "impossibility confirmed";
		case "impossible-refuted":
			return "impossibility refuted";
		case "impossible-disputed":
			return "impossibility disputed";
		default:
			return "evaluator unavailable";
	}
}

export function createGoalTool(deps: GoalToolDeps): ToolDefinition<typeof GoalParamsSchema, GoalToolDetails> {
	return {
		name: "goal",
		label: "Goal",
		description: goalDescription,
		promptSnippet: "Manage the active goal-mode objective (create/get/complete/resume/drop/impossible)",
		parameters: GoalParamsSchema,
		executionMode: "sequential",

		async execute(
			_toolCallId: string,
			params: GoalToolInput,
			signal: AbortSignal | undefined,
			_onUpdate: undefined,
			ctx: { cwd?: string } | undefined,
		): Promise<AgentToolResult<GoalToolDetails>> {
			const runtime = deps.getRuntime();
			let response: GoalToolResponse;
			/** Evaluator resolution for gated ops (complete/impossible); undefined
			 *  on the ungated ops. */
			let evaluator: GoalToolDetails["evaluator"];
			if (params.op === "create") {
				const created = await runtime.createGoal(validateCreateParams(params));
				response = buildGoalToolResponse(created.goal);
			} else if (params.op === "get") {
				const state = deps.getState();
				response = buildGoalToolResponse(state?.goal ?? null);
			} else if (params.op === "resume") {
				const resumed = await runtime.resumeGoal();
				response = buildGoalToolResponse(resumed.goal);
			} else if (params.op === "drop") {
				const dropped = await runtime.dropGoal();
				response = buildGoalToolResponse(dropped ?? null);
			} else if (params.op === "complete") {
				({ response, evaluator } = await runGatedComplete(deps, params, ctx?.cwd, signal));
			} else {
				({ response, evaluator } = await runGatedImpossible(deps, params, ctx?.cwd, signal));
			}

			let text: string;
			if (response.goal) {
				text = `Goal: ${response.goal.objective}\nStatus: ${response.goal.status}\nTokens: ${response.goal.tokensUsed} used`;
				if (response.goal.tokenBudget !== undefined) {
					text += ` / ${response.goal.tokenBudget} budget`;
				}
				if (response.remainingTokens !== null) {
					text += `\nRemaining tokens: ${response.remainingTokens}`;
				}
				if (response.completionBudgetReport) {
					text += `\n\n${response.completionBudgetReport}`;
				}
			} else {
				text = "No active goal.";
			}
			if (evaluator) {
				text += `\n\n${evaluatorText(evaluator)}`;
			}
			return {
				content: [{ type: "text", text }],
				details: {
					op: params.op,
					goal: response.goal,
					remainingTokens: response.remainingTokens,
					completionBudgetReport: response.completionBudgetReport,
					evaluator,
				},
			};
		},

		renderCall: (args, theme) => renderGoalCall(args, theme),
		// omp goalToolRenderer.renderResult falls back to the call args when the
		// result carries no details (error paths): `details?.op ?? args?.op`.
		renderResult: (result, options, theme, context) => renderGoalResult(result, options, theme, context?.args),
	};
}

// =============================================================================
// Evaluator-gated ops (complete / impossible)
// =============================================================================

function requireClaim(value: string | undefined, op: "complete" | "impossible"): string {
	const claim = value?.trim();
	if (!claim) {
		throw new Error(
			op === "complete"
				? "evidence is required when op=complete — pass your per-deliverable audit of the current repo state (the independent evaluator re-verifies it)"
				: "reason is required when op=impossible — state why the goal cannot be achieved, with evidence (the independent evaluator will confirm it)",
		);
	}
	return claim;
}

/** Preserve omp's complete-error semantics BEFORE spending an evaluator run:
 *  no goal / already complete / dropped → same errors the runtime throws. */
function requireCompletableGoal(deps: GoalToolDeps): GoalModeState {
	const state = deps.getState();
	if (!state?.goal) {
		throw new Error("cannot complete goal because no goal is active");
	}
	if (state.goal.status === "complete") {
		throw new Error("goal is already complete");
	}
	if (state.goal.status === "dropped") {
		throw new Error("cannot complete a dropped goal");
	}
	return state;
}

async function runGatedComplete(
	deps: GoalToolDeps,
	params: GoalToolInput,
	cwd: string | undefined,
	signal: AbortSignal | undefined,
): Promise<{ response: GoalToolResponse; evaluator: NonNullable<GoalToolDetails["evaluator"]> }> {
	const state = requireCompletableGoal(deps);
	const evidence = requireClaim(params.evidence, "complete");
	const outcome = await deps.runEvaluator(
		{ mode: "complete", objective: state.goal.objective, claim: evidence },
		{ cwd, signal },
	);
	if (outcome.status === "refuted") {
		// The claim does not survive independent verification: no state change.
		return {
			response: buildGoalToolResponse(state.goal),
			evaluator: { verdict: "rejected", reason: outcome.reason },
		};
	}
	const completed = await deps.getRuntime().completeGoalFromTool();
	if (outcome.status === "unavailable") {
		// Evaluator unreachable (spawn failure / timeout / unparseable output):
		// fall back to the omp self-audit behavior, honestly labeled.
		return {
			response: buildGoalToolResponse(completed, { includeCompletionReport: true }),
			evaluator: { verdict: "unavailable-fallback", reason: outcome.detail },
		};
	}
	return {
		response: buildGoalToolResponse(completed, { includeCompletionReport: true }),
		evaluator: { verdict: "confirmed", reason: outcome.reason },
	};
}

async function runGatedImpossible(
	deps: GoalToolDeps,
	params: GoalToolInput,
	cwd: string | undefined,
	signal: AbortSignal | undefined,
): Promise<{ response: GoalToolResponse; evaluator: NonNullable<GoalToolDetails["evaluator"]> }> {
	const reason = requireClaim(params.reason, "impossible");
	const state = deps.getState();
	if (!state?.enabled || (state.goal.status !== "active" && state.goal.status !== "budget-limited")) {
		throw new Error("cannot report impossibility because no active goal exists");
	}
	const reported = await deps.getRuntime().recordImpossibleReport();
	const outcome = await deps.runEvaluator(
		{ mode: "impossible", objective: reported.objective, claim: reason },
		{ cwd, signal },
	);
	if (outcome.status === "confirmed") {
		await deps.getRuntime().pauseGoal({ reason: "impossible-confirmed" });
		return {
			response: buildGoalToolResponse(deps.getState()?.goal ?? { ...reported, status: "paused" }),
			evaluator: { verdict: "impossible-confirmed", reason: outcome.reason },
		};
	}
	if (outcome.status === "refuted") {
		const reports = reported.impossibleReports ?? 0;
		if (reports >= IMPOSSIBLE_REPORT_CAP) {
			await deps.getRuntime().pauseGoal({ reason: "impossible-disputed" });
			return {
				response: buildGoalToolResponse(deps.getState()?.goal ?? { ...reported, status: "paused" }),
				evaluator: { verdict: "impossible-disputed", reason: outcome.reason },
			};
		}
		return {
			response: buildGoalToolResponse(reported),
			evaluator: { verdict: "impossible-refuted", reason: outcome.reason },
		};
	}
	// Evaluator unavailable: keep the goal active (no state change on an
	// unadjudicated claim) and route the dispute to the user.
	return {
		response: buildGoalToolResponse(reported),
		evaluator: { verdict: "unavailable", reason: outcome.detail },
	};
}

/** Model-facing evaluator section appended to the tool-result text. */
function evaluatorText(evaluator: NonNullable<GoalToolDetails["evaluator"]>): string {
	switch (evaluator.verdict) {
		case "confirmed":
			return `Independent evaluator CONFIRMED completion. Evidence:\n${evaluator.reason || "(no reason returned)"}`;
		case "rejected":
			return (
				`Completion REJECTED by the independent evaluator — the goal remains active.\n\n` +
				`Evaluator findings:\n${evaluator.reason || "(no reason returned)"}\n\n` +
				`Fix the gaps (or gather stronger current-state evidence) and call goal({op:"complete", evidence: ...}) again. ` +
				`Do not re-claim with the same evidence.`
			);
		case "unavailable-fallback":
			return (
				`Independent evaluator unavailable (${evaluator.reason || "unknown reason"}) — ` +
				`completed via self-audit fallback. Mention this in the done report so the user knows the claim was not independently verified.`
			);
		case "impossible-confirmed":
			return (
				`The independent evaluator CONFIRMED the impossibility claim — the goal is now paused.\n\n` +
				`Evaluator evidence:\n${evaluator.reason || "(no reason returned)"}\n\n` +
				`Report this honestly to the user: what was attempted, why the goal cannot be achieved this session, and what would unblock it. ` +
				`Do not drop or re-create the goal; the user decides.`
			);
		case "impossible-refuted":
			return (
				`Impossibility claim REFUTED by the independent evaluator — the goal remains active.\n\n` +
				`Evaluator findings:\n${evaluator.reason || "(no reason returned)"}\n\n` +
				`Your claim is evidence, not proof: keep working toward the goal. ` +
				`Repeated unconfirmed impossibility claims pause the goal for the user.`
			);
		case "impossible-disputed":
			return (
				`Impossibility claim refuted again — the goal is now paused for a human decision.\n\n` +
				`Evaluator findings:\n${evaluator.reason || "(no reason returned)"}\n\n` +
				`Report the disagreement to the user with both sides' evidence and stop; the user decides whether to resume, drop, or restate the goal.`
			);
		default:
			return (
				`Independent evaluator unavailable (${evaluator.reason || "unknown reason"}) — the impossibility claim was NOT adjudicated. ` +
				`The goal remains active. Surface the situation to the user directly instead of repeating the claim; they can run /goal pause.`
			);
	}
}

// =============================================================================
// Rendering (ported from omp goalToolRenderer, pi-tui primitives)
// =============================================================================

/**
 * Rendering (ported from omp goalToolRenderer, pi-tui primitives)
 *
 * omp renders the header with renderStatusLine + a framed block; pi's split
 * renderCall/renderResult slots take the same strings as Text lines. Glyphs,
 * separators, badge brackets, and truncation caps are omp's unicode symbol
 * set verbatim:
 *   status.pending ⏳ · tool.goal ◎ · status.error ✘ · status.warning ⚠
 *   sep.dot " · " · format.bracketLeft/Right ⟦⟧
 *   TRUNCATE_LENGTHS.TITLE 60 (call) / LONG 100 (result)
 */

const STATUS_ICONS = {
	pending: "⏳",
	goal: "◎",
	error: "✘",
	warning: "⚠",
} as const;

/** omp sep.dot / format.bracketLeft / format.bracketRight (unicode set). */
const SEP_DOT = " · ";
const BRACKET_LEFT = "⟦";
const BRACKET_RIGHT = "⟧";

/** omp TRUNCATE_LENGTHS.TITLE / LONG. */
const TITLE_CAP = 60;
const LONG_CAP = 100;

function describeOp(op: string | undefined): string {
	switch (op) {
		case "create":
			return "set";
		case "complete":
			return "complete";
		case "get":
			return "check";
		case "resume":
			return "resume";
		case "drop":
			return "drop";
		case "impossible":
			return "report impossible";
		default:
			return op ?? "?";
	}
}

function goalBadgeColor(status: GoalStatus): ThemeColor {
	switch (status) {
		case "complete":
			return "success";
		case "budget-limited":
			return "warning";
		case "paused":
		case "dropped":
			return "muted";
		default:
			return "accent";
	}
}

/** omp truncateToWidth shape: clip to cap with an ellipsis. */
function clip(text: string, cap: number): string {
	const single = text.replace(/[\t\n\r]+/g, " ");
	return single.length > cap ? `${single.slice(0, cap - 1)}…` : single;
}

export interface GoalRenderArgs {
	op?: GoalToolInput["op"];
	objective?: string;
	token_budget?: number;
	evidence?: string;
	reason?: string;
}

/** pi ToolRenderContext.args slice used for the omp args-op fallback. */
export interface GoalRenderContext {
	args?: GoalRenderArgs;
}

export function renderGoalCall(args: GoalRenderArgs, theme: Theme): Component {
	const description = describeOp(args.op);
	const trimmedObjective = args.objective?.trim();
	const meta: string[] = [];
	if (args.op === "create" && trimmedObjective) {
		meta.push(theme.italic(theme.fg("muted", `"${clip(trimmedObjective, TITLE_CAP)}"`)));
	}
	if (args.op === "create" && args.token_budget !== undefined) {
		meta.push(`budget ${formatNumber(args.token_budget)}`);
	}
	let line = `${theme.fg("muted", STATUS_ICONS.pending)} ${theme.fg("accent", "Goal")}: ${theme.fg("muted", description)}`;
	if (meta.length > 0) {
		line += ` ${theme.fg("dim", meta.join(SEP_DOT))}`;
	}
	return new Text(line, 0, 0);
}

interface GoalRenderResult {
	content: Array<{ type: string; text?: string }>;
	details?: GoalToolDetails;
	isError?: boolean;
}

export function renderGoalResult(
	result: GoalRenderResult,
	_options: { isPartial: boolean },
	theme: Theme,
	args?: GoalRenderArgs,
): Component {
	const fallbackText = result.content?.find((c) => c.type === "text")?.text ?? "";
	const details = result.details;
	// omp: details carry the op; call args are the fallback (error paths).
	const op = details?.op ?? args?.op;
	const description = describeOp(op);

	if (result.isError) {
		// omp: ✘ header + two-space error detail inside the frame.
		const header = `${theme.fg("error", STATUS_ICONS.error)} ${theme.fg("accent", "Goal")}: ${theme.fg("muted", description)}`;
		const detail = `  ${theme.fg("error", clip(fallbackText || "Goal tool failed", LONG_CAP))}`;
		return new Text(`${header}\n${detail}`, 0, 0);
	}

	const goal = details?.goal ?? null;
	if (!goal) {
		// omp: ⚠ header with "no active goal" dim meta.
		const line =
			`${theme.fg("warning", STATUS_ICONS.warning)} ${theme.fg("accent", "Goal")}: ${theme.fg("muted", description)}` +
			` ${theme.fg("dim", `${SEP_DOT}no active goal`)}`;
		return new Text(line, 0, 0);
	}

	// omp header: ◎ (tool.goal, accent) + badge ⟦status⟧ in goalBadgeColor.
	const badgeColor = goalBadgeColor(goal.status);
	const header =
		`${theme.fg("accent", STATUS_ICONS.goal)} ${theme.fg("accent", "Goal")}: ${theme.fg("muted", description)}` +
		` ${theme.fg(badgeColor, `${BRACKET_LEFT}${goal.status}${BRACKET_RIGHT}`)}`;

	const lines: string[] = [header];
	const objectiveText = clip(goal.objective.trim(), LONG_CAP);
	lines.push(theme.italic(theme.fg("muted", `"${objectiveText}"`)));

	const used = formatNumber(goal.tokensUsed);
	const tokensLine =
		goal.tokenBudget !== undefined
			? `${used} / ${formatNumber(goal.tokenBudget)} tokens (${formatNumber(Math.max(0, goal.tokenBudget - goal.tokensUsed))} left)`
			: `${used} tokens`;
	const metaParts = [tokensLine];
	if (goal.timeUsedSeconds > 0) {
		metaParts.push(`${formatDuration(goal.timeUsedSeconds * 1000)} elapsed`);
	}
	lines.push(theme.fg("dim", metaParts.join(SEP_DOT)));

	const report = details?.completionBudgetReport;
	if (report) {
		for (const line of report.split("\n")) {
			lines.push(theme.fg("muted", line));
		}
	}

	const evaluator = details?.evaluator;
	if (evaluator) {
		const favorable = evaluator.verdict === "confirmed";
		const icon = favorable ? STATUS_ICONS.goal : STATUS_ICONS.warning;
		const color: ThemeColor = favorable ? "success" : "warning";
		lines.push(
			theme.fg(color, `${icon} ${clip(`${describeEvaluatorVerdict(evaluator.verdict)} — ${evaluator.reason || "(no reason returned)"}`, LONG_CAP * 2)}`),
		);
	}

	return new Text(lines.join("\n"), 0, 0);
}
