/**
 * pi-goal — tool + restore + todo-bridge tests.
 *
 * Tool scenarios ported from oh-my-pi `test/goals/goal-tool.test.ts`; restore
 * and todo-bridge tests pin the pi-side persistence adapters.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import type { GoalEvaluatorOutcome, GoalEvaluatorRequest } from "../src/evaluator.ts";
import { IMPOSSIBLE_REPORT_CAP } from "../src/tool.ts";
import { GOAL_CLEARED_ENTRY_TYPE, GOAL_STATE_ENTRY_TYPE, restoreGoalFromEntries } from "../src/restore.ts";
import { GoalRuntime, type GoalRuntimeHost } from "../src/runtime.ts";
import type { Goal, GoalModeState, GoalRuntimeEvent, GoalTokenUsage, GoalToolDetails } from "../src/state.ts";
import { buildTodoContext, parseTodoPhases, restoreTodoPhases, todoProgress } from "../src/todo-bridge.ts";
import {
	buildGoalToolResponse,
	createGoalTool,
	type GoalRenderArgs,
	renderGoalCall,
	renderGoalResult,
} from "../src/tool.ts";

// ---------------------------------------------------------------------------
// Runtime harness (same shape as runtime.test.ts)
// ---------------------------------------------------------------------------

function createUsage(overrides: Partial<GoalTokenUsage> = {}): GoalTokenUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...overrides };
}

function createGoal(overrides: Partial<Goal> = {}): Goal {
	return {
		id: "goal-1",
		objective: "Ship it",
		status: "active",
		tokenBudget: undefined,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

function createRuntimeHarness(initial?: { state?: GoalModeState }) {
	let state = initial?.state ? { ...initial.state, goal: { ...initial.state.goal } } : undefined;
	const events: GoalRuntimeEvent[] = [];
	const host: GoalRuntimeHost = {
		getState: () => (state ? { ...state, goal: { ...state.goal } } : undefined),
		setState: (next) => {
			state = next ? { ...next, goal: { ...next.goal } } : undefined;
		},
		getCurrentUsage: () => createUsage(),
		emit: async (event) => {
			events.push(event);
		},
		persist: () => {},
		sendHiddenMessage: async () => {},
		now: () => 0,
	};
	return { runtime: new GoalRuntime(host), getState: () => state, events };
}

async function executeTool(
	tool: ReturnType<typeof createGoalTool>,
	params: unknown,
): Promise<AgentToolResult<GoalToolDetails>> {
	const execute = tool.execute as (
		id: string,
		params: unknown,
		signal?: AbortSignal,
		onUpdate?: undefined,
		ctx?: { cwd?: string },
	) => Promise<AgentToolResult<GoalToolDetails>>;
	return execute("call-1", params, undefined, undefined, { cwd: "/tmp/repo" });
}

/** Evaluator stub: records requests, returns the given outcome. */
function stubEvaluator(outcome: GoalEvaluatorOutcome) {
	const calls: Array<{ request: GoalEvaluatorRequest; cwd?: string }> = [];
	const fn = async (request: GoalEvaluatorRequest, opts: { cwd?: string }) => {
		calls.push({ request, cwd: opts.cwd });
		return outcome;
	};
	return { fn, calls };
}

/** Tool factory wiring a runtime harness with an evaluator stub. */
function createTestTool(
	harness: ReturnType<typeof createRuntimeHarness>,
	evaluator: (request: GoalEvaluatorRequest, opts: { cwd?: string }) => Promise<GoalEvaluatorOutcome>,
) {
	return createGoalTool({ getRuntime: () => harness.runtime, getState: harness.getState, runEvaluator: evaluator });
}

// ---------------------------------------------------------------------------
// Tool ops
// ---------------------------------------------------------------------------

describe("goal tool", () => {
	it("create starts a goal and returns the objective/status text", async () => {
		const harness = createRuntimeHarness();
		const tool = createTestTool(harness, async () => ({ status: "confirmed", reason: "verified" }));

		const result = await executeTool(tool, { op: "create", objective: "  Ship it  ", token_budget: 100 });
		expect(result.details.op).toBe("create");
		expect(result.details.goal?.objective).toBe("Ship it");
		expect(result.details.goal?.status).toBe("active");
		expect(result.details.remainingTokens).toBe(100);
		const text = (result.content[0] as { text: string }).text ?? "";
		expect(text).toContain("Goal: Ship it");
		expect(text).toContain("Status: active");
		expect(text).toContain("Remaining tokens: 100");
	});

	it("create requires objective and a positive integer budget", async () => {
		const harness = createRuntimeHarness();
		const tool = createTestTool(harness, async () => ({ status: "confirmed", reason: "verified" }));

		await expect(executeTool(tool, { op: "create" })).rejects.toThrow("objective is required when op=create");
		await expect(executeTool(tool, { op: "create", objective: "x", token_budget: 0 })).rejects.toThrow(
			"token_budget must be a positive integer when provided",
		);
		await expect(executeTool(tool, { op: "create", objective: "x", token_budget: 1.5 })).rejects.toThrow(
			"token_budget must be a positive integer when provided",
		);
	});

	it("get reads the current goal state", async () => {
		const harness = createRuntimeHarness({
			state: { enabled: true, mode: "active", goal: createGoal({ tokenBudget: 100, tokensUsed: 40 }) },
		});
		const tool = createTestTool(harness, async () => ({ status: "confirmed", reason: "verified" }));

		const result = await executeTool(tool, { op: "get" });
		expect(result.details.goal?.objective).toBe("Ship it");
		expect(result.details.remainingTokens).toBe(60);
	});

	it("get without a goal reports no active goal", async () => {
		const harness = createRuntimeHarness();
		const tool = createTestTool(harness, async () => ({ status: "confirmed", reason: "verified" }));

		const result = await executeTool(tool, { op: "get" });
		expect(result.details.goal).toBeNull();
		expect((result.content[0] as { text: string }).text).toBe("No active goal.");
	});

	it("resume reactivates a paused goal", async () => {
		const harness = createRuntimeHarness({
			state: { enabled: false, mode: "active", goal: createGoal({ status: "paused" }) },
		});
		const tool = createTestTool(harness, async () => ({ status: "confirmed", reason: "verified" }));

		const result = await executeTool(tool, { op: "resume" });
		expect(result.details.goal?.status).toBe("active");
		expect(harness.getState()?.enabled).toBe(true);
	});

	it("drop discards the goal", async () => {
		const harness = createRuntimeHarness({
			state: { enabled: true, mode: "active", goal: createGoal() },
		});
		const tool = createTestTool(harness, async () => ({ status: "confirmed", reason: "verified" }));

		const result = await executeTool(tool, { op: "drop" });
		expect(result.details.goal?.status).toBe("dropped");
		expect(harness.getState()).toBeUndefined();
	});

	it("complete marks complete and attaches the budget report", async () => {
		const harness = createRuntimeHarness({
			state: {
				enabled: true,
				mode: "active",
				goal: createGoal({ tokenBudget: 100, tokensUsed: 42, timeUsedSeconds: 7 }),
			},
		});
		const evaluator = stubEvaluator({ status: "confirmed", reason: "tests pass, file present" });
		const tool = createTestTool(harness, evaluator.fn);

		const result = await executeTool(tool, { op: "complete", evidence: "ran npm test; all green" });
		expect(result.details.goal?.status).toBe("complete");
		expect(result.details.evaluator?.verdict).toBe("confirmed");
		expect(result.details.completionBudgetReport).toContain("tokens used: 42 of 100");
		expect((result.content[0] as { text: string }).text).toContain("Goal achieved. Report final budget usage");
		// The evaluator received the objective and the evidence claim.
		expect(evaluator.calls).toHaveLength(1);
		expect(evaluator.calls[0]!.request).toEqual({
			mode: "complete",
			objective: "Ship it",
			claim: "ran npm test; all green",
		});
		expect(evaluator.calls[0]!.cwd).toBe("/tmp/repo");
	});

	it("complete requires evidence for the evaluator", async () => {
		const harness = createRuntimeHarness({ state: { enabled: true, mode: "active", goal: createGoal() } });
		const tool = createTestTool(harness, async () => ({ status: "confirmed", reason: "ok" }));

		await expect(executeTool(tool, { op: "complete" })).rejects.toThrow("evidence is required when op=complete");
		await expect(executeTool(tool, { op: "complete", evidence: "   " })).rejects.toThrow(
			"evidence is required when op=complete",
		);
	});

	it("complete keeps omp error semantics before spending an evaluator run", async () => {
		const harness = createRuntimeHarness({
			state: { enabled: false, mode: "exiting", reason: "completed", goal: createGoal({ status: "complete" }) },
		});
		const evaluator = stubEvaluator({ status: "confirmed", reason: "ok" });
		const tool = createTestTool(harness, evaluator.fn);

		await expect(executeTool(tool, { op: "complete", evidence: "x" })).rejects.toThrow("goal is already complete");
		expect(evaluator.calls).toHaveLength(0);
	});

	it("complete is gated: a refuted claim keeps the goal active and returns the findings", async () => {
		const harness = createRuntimeHarness({ state: { enabled: true, mode: "active", goal: createGoal() } });
		const tool = createTestTool(
			harness,
			async () => ({ status: "refuted", reason: "test/foo.test.ts exits 1: expected 2 got 3" }),
		);

		const result = await executeTool(tool, { op: "complete", evidence: "looks done" });
		expect(result.details.goal?.status).toBe("active");
		expect(result.details.evaluator?.verdict).toBe("rejected");
		expect(harness.getState()?.goal.status).toBe("active");
		expect(harness.getState()?.enabled).toBe(true);
		const text = (result.content[0] as { text: string }).text ?? "";
		expect(text).toContain("Completion REJECTED by the independent evaluator");
		expect(text).toContain("test/foo.test.ts exits 1");
	});

	it("complete falls back to self-audit when the evaluator is unavailable", async () => {
		const harness = createRuntimeHarness({
			state: { enabled: true, mode: "active", goal: createGoal({ tokenBudget: 10, tokensUsed: 4 }) },
		});
		const tool = createTestTool(harness, async () => ({ status: "unavailable", detail: "spawn failed" }));

		const result = await executeTool(tool, { op: "complete", evidence: "ran the checks" });
		expect(result.details.goal?.status).toBe("complete");
		expect(result.details.evaluator?.verdict).toBe("unavailable-fallback");
		const text = (result.content[0] as { text: string }).text ?? "";
		expect(text).toContain("Independent evaluator unavailable (spawn failed)");
		expect(text).toContain("self-audit fallback");
	});

	it("impossible refuted keeps the goal active and counts the dispute", async () => {
		const harness = createRuntimeHarness({ state: { enabled: true, mode: "active", goal: createGoal() } });
		const evaluator = stubEvaluator({
			status: "refuted",
			reason: "found a workable path: the missing API key can be read from env",
		});
		const tool = createTestTool(harness, evaluator.fn);

		const result = await executeTool(tool, { op: "impossible", reason: "the API is unreachable" });
		expect(result.details.goal?.status).toBe("active");
		expect(result.details.evaluator?.verdict).toBe("impossible-refuted");
		expect(harness.getState()?.goal.status).toBe("active");
		expect(harness.getState()?.goal.impossibleReports).toBe(1);
		const text = (result.content[0] as { text: string }).text ?? "";
		expect(text).toContain("Impossibility claim REFUTED");
		expect(text).toContain("workable path");
		expect(evaluator.calls[0]!.request).toEqual({
			mode: "impossible",
			objective: "Ship it",
			claim: "the API is unreachable",
		});
	});

	it("impossible confirmed pauses the goal for the user", async () => {
		const harness = createRuntimeHarness({
			state: { enabled: true, mode: "active", goal: createGoal({ tokenBudget: 50, tokensUsed: 10 }) },
		});
		const tool = createTestTool(
			harness,
			async () => ({ status: "confirmed", reason: "the condition contradicts the platform's capabilities" }),
		);

		const result = await executeTool(tool, { op: "impossible", reason: "no network in this session" });
		expect(result.details.goal?.status).toBe("paused");
		expect(result.details.evaluator?.verdict).toBe("impossible-confirmed");
		const state = harness.getState();
		expect(state?.enabled).toBe(false);
		expect(state?.goal.status).toBe("paused");
		expect(state?.reason).toBe("impossible-confirmed");
		const text = (result.content[0] as { text: string }).text ?? "";
		expect(text).toContain("CONFIRMED the impossibility claim");
		expect(text).toContain("paused");
	});

	it(`impossible refuted ${IMPOSSIBLE_REPORT_CAP} times pauses the goal for a human decision`, async () => {
		const harness = createRuntimeHarness({ state: { enabled: true, mode: "active", goal: createGoal() } });
		const tool = createTestTool(harness, async () => ({ status: "refuted", reason: "still workable" }));

		const first = await executeTool(tool, { op: "impossible", reason: "blocked" });
		expect(first.details.goal?.status).toBe("active");

		const second = await executeTool(tool, { op: "impossible", reason: "still blocked" });
		expect(second.details.evaluator?.verdict).toBe("impossible-disputed");
		expect(second.details.goal?.status).toBe("paused");
		const state = harness.getState();
		expect(state?.enabled).toBe(false);
		expect(state?.goal.status).toBe("paused");
		expect(state?.reason).toBe("impossible-disputed");
		expect(state?.goal.impossibleReports).toBe(IMPOSSIBLE_REPORT_CAP);
		const text = (second.content[0] as { text: string }).text ?? "";
		expect(text).toContain("paused for a human decision");
	});

	it("impossible requires a reason and an active goal", async () => {
		const harness = createRuntimeHarness({ state: { enabled: true, mode: "active", goal: createGoal() } });
		const tool = createTestTool(harness, async () => ({ status: "confirmed", reason: "ok" }));

		await expect(executeTool(tool, { op: "impossible" })).rejects.toThrow("reason is required when op=impossible");

		const empty = createRuntimeHarness();
		const emptyTool = createTestTool(empty, async () => ({ status: "confirmed", reason: "ok" }));
		await expect(executeTool(emptyTool, { op: "impossible", reason: "nope" })).rejects.toThrow(
			"cannot report impossibility because no active goal exists",
		);
	});

	it("impossible with an unavailable evaluator keeps the goal active", async () => {
		const harness = createRuntimeHarness({ state: { enabled: true, mode: "active", goal: createGoal() } });
		const tool = createTestTool(harness, async () => ({ status: "unavailable", detail: "timed out" }));

		const result = await executeTool(tool, { op: "impossible", reason: "dead end" });
		expect(result.details.goal?.status).toBe("active");
		expect(result.details.evaluator?.verdict).toBe("unavailable");
		expect(harness.getState()?.goal.status).toBe("active");
		expect(harness.getState()?.goal.impossibleReports).toBe(1);
		const text = (result.content[0] as { text: string }).text ?? "";
		expect(text).toContain("was NOT adjudicated");
	});

	it("propagates a caller abort from the evaluator", async () => {
		const harness = createRuntimeHarness({ state: { enabled: true, mode: "active", goal: createGoal() } });
		const tool = createTestTool(harness, async () => {
			throw new Error("goal evaluation aborted");
		});

		await expect(executeTool(tool, { op: "complete", evidence: "x" })).rejects.toThrow("goal evaluation aborted");
		expect(harness.getState()?.goal.status).toBe("active");
	});

	it("buildGoalToolResponse includes the completion report only for complete goals", () => {
		const active = buildGoalToolResponse(createGoal());
		expect(active.completionBudgetReport).toBeNull();
		const complete = buildGoalToolResponse(createGoal({ status: "complete", tokenBudget: 10, tokensUsed: 4 }), {
			includeCompletionReport: true,
		});
		expect(complete.completionBudgetReport).toContain("tokens used: 4 of 10");
		const completeWithoutFlag = buildGoalToolResponse(createGoal({ status: "complete" }), {
			includeCompletionReport: false,
		});
		expect(completeWithoutFlag.completionBudgetReport).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe("goal tool rendering", () => {
	const passthroughTheme = {
		fg: (_color: string, text: string) => text,
		italic: (text: string) => text,
		bold: (text: string) => text,
		strikethrough: (text: string) => text,
	} as never;

	it("renders the call line with objective and budget", () => {
		const args: GoalRenderArgs = { op: "create", objective: "Ship it", token_budget: 5000 };
		const component = renderGoalCall(args, passthroughTheme);
		const text = (component as unknown as { text: string }).text;
		expect(text).toContain("Goal: set");
		expect(text).toContain('"Ship it"');
		expect(text).toContain("budget 5K");
	});

	it("renders the result with status badge and token accounting", () => {
		const component = renderGoalResult(
			{
				content: [{ type: "text", text: "Goal: Ship it" }],
				details: {
					op: "create",
					goal: createGoal({ status: "active", tokenBudget: 10000, tokensUsed: 2500, timeUsedSeconds: 120 }),
					remainingTokens: 7500,
					completionBudgetReport: null,
				},
			},
			{ isPartial: false },
			passthroughTheme,
		);
		const text = (component as unknown as { text: string }).text;
		expect(text).toContain("⟦active⟧");
		expect(text).toContain('"Ship it"');
		expect(text).toContain("2.5K / 10K tokens");
		expect(text).toContain("7.5K left");
		expect(text).toContain("2m elapsed");
	});

	it("renders errors from the fallback content", () => {
		const component = renderGoalResult(
			{ content: [{ type: "text", text: "boom" }], isError: true },
			{ isPartial: false },
			passthroughTheme,
		);
		const text = (component as unknown as { text: string }).text;
		expect(text).toContain("boom");
	});
});

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

describe("restore", () => {
	it("restores the latest goal-state snapshot", () => {
		const entries = [
			{
				type: "custom",
				customType: GOAL_STATE_ENTRY_TYPE,
				id: "e1",
				data: { enabled: true, goal: createGoal({ id: "g1" }) },
			},
			{
				type: "custom",
				customType: GOAL_STATE_ENTRY_TYPE,
				id: "e2",
				data: { enabled: false, goal: createGoal({ id: "g2", status: "paused" }) },
			},
		];
		const restored = restoreGoalFromEntries(entries);
		expect(restored?.goal.id).toBe("g2");
		expect(restored?.enabled).toBe(false);
		expect(restored?.mode).toBe("active");
	});

	it("a newer goal-cleared marker erases the goal", () => {
		const entries = [
			{ type: "custom", customType: GOAL_STATE_ENTRY_TYPE, id: "e1", data: { enabled: true, goal: createGoal() } },
			{ type: "custom", customType: GOAL_CLEARED_ENTRY_TYPE, id: "e2", data: { clearedAt: 1 } },
		];
		expect(restoreGoalFromEntries(entries)).toBeUndefined();
	});

	it("a goal-state snapshot after the cleared marker wins", () => {
		const entries = [
			{ type: "custom", customType: GOAL_CLEARED_ENTRY_TYPE, id: "e1", data: { clearedAt: 1 } },
			{
				type: "custom",
				customType: GOAL_STATE_ENTRY_TYPE,
				id: "e2",
				data: { enabled: true, goal: createGoal({ id: "g3" }) },
			},
		];
		expect(restoreGoalFromEntries(entries)?.goal.id).toBe("g3");
	});

	it("skips malformed snapshots", () => {
		const entries = [
			{ type: "custom", customType: GOAL_STATE_ENTRY_TYPE, id: "e1", data: { enabled: "yes", goal: {} } },
			{
				type: "custom",
				customType: GOAL_STATE_ENTRY_TYPE,
				id: "e2",
				data: { enabled: true, goal: createGoal({ id: "g4" }) },
			},
		];
		expect(restoreGoalFromEntries(entries)?.goal.id).toBe("g4");
	});

	it("returns undefined with no entries", () => {
		expect(restoreGoalFromEntries([])).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Todo bridge
// ---------------------------------------------------------------------------

describe("todo bridge", () => {
	it("restores pi-todo phases from session entries", () => {
		const entries = [
			{
				type: "custom",
				customType: "todo-phases",
				data: { phases: [{ name: "P1", tasks: [{ content: "a", status: "in_progress" }] }] },
			},
		];
		const phases = restoreTodoPhases(entries);
		expect(phases).toHaveLength(1);
		expect(phases[0]?.tasks[0]?.status).toBe("in_progress");
	});

	it("renders the todo context block with counts", () => {
		const context = buildTodoContext(
			[
				{
					name: "Foundation",
					tasks: [
						{ content: "done task", status: "completed" },
						{ content: "open task", status: "in_progress" },
					],
				},
			],
			true,
		);
		expect(context).toContain("<todo_context>");
		expect(context).toContain("Overall: 1/2 done, 1 open.");
		expect(context).toContain("- [in_progress] open task");
	});

	it("returns undefined when the todo tool is inactive or phases are empty", () => {
		expect(buildTodoContext([{ name: "P", tasks: [{ content: "a", status: "pending" }] }], false)).toBeUndefined();
		expect(buildTodoContext([], true)).toBeUndefined();
	});

	it("escapes XML-sensitive todo text (omp #sanitizeGoalTodoText)", () => {
		const context = buildTodoContext([{ name: "P<1>", tasks: [{ content: "a & b", status: "pending" }] }], true);
		expect(context).toContain("P&lt;1&gt;");
		expect(context).toContain("a &amp; b");
	});

	it("counts footer progress over non-empty phases only (completed + abandoned closed)", () => {
		expect(
			todoProgress([
				{
					name: "P1",
					tasks: [
						{ content: "a", status: "completed" },
						{ content: "b", status: "abandoned" },
						{ content: "c", status: "in_progress" },
					],
				},
				{ name: "P2", tasks: [{ content: "d", status: "pending" }] },
				{ name: "empty", tasks: [] },
			]),
		).toEqual({ closed: 2, total: 4 });
		expect(todoProgress([{ name: "empty", tasks: [] }])).toBeUndefined();
		expect(todoProgress([])).toBeUndefined();
	});

	it("validates todo_updated event payloads (parseTodoPhases)", () => {
		const phases = [{ name: "P1", tasks: [{ content: "a", status: "pending" }] }];
		expect(parseTodoPhases(phases)).toEqual(phases);
		// defensive clone, not the caller's objects
		expect(parseTodoPhases(phases)).not.toBe(phases);
		expect(parseTodoPhases(undefined)).toBeUndefined();
		expect(parseTodoPhases("nope")).toBeUndefined();
		expect(parseTodoPhases([{ name: "P1", tasks: [{ content: "a", status: "bogus" }] }])).toBeUndefined();
		expect(parseTodoPhases([{ tasks: [] }])).toBeUndefined();
	});
});
