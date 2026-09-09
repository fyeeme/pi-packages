/**
 * pi-goal — oh-my-pi goal mode migrated to a pi extension.
 *
 * Source: oh-my-pi (github.com/can1357/oh-my-pi, a fork of badlogic/pi-mono)
 *   - packages/coding-agent/src/goals/state.ts            → src/state.ts
 *   - packages/coding-agent/src/goals/runtime.ts          → src/runtime.ts
 *   - packages/coding-agent/src/goals/tools/goal-tool.ts  → src/tool.ts (+src/render.ts)
 *   - packages/coding-agent/src/prompts/tools/goal.md     → src/prompts/goal.md
 *   - packages/coding-agent/src/prompts/goals/*.md        → src/prompts/*.md
 *   - packages/coding-agent/src/session/agent-session.ts  → index.ts host wiring
 *   - packages/coding-agent/src/modes/interactive-mode.ts → index.ts continuation
 *     loop + src/commands.ts (/goal, /guided-goal)
 *
 * Adaptations for pi's extension API (each maps an omp-internal surface to
 * the public extension boundary):
 *
 *   omp surface                            → pi adaptation
 *   ─────────────────────────────────────────────────────────────────────────
 *   session getGoalModeState/setGoalModeState
 *                                          → closure state + goal-state
 *                                            custom entries (full snapshots)
 *   appendModeChange goal/goal_paused/none → "goal-state" / "goal-cleared"
 *                                            entries (see src/restore.ts)
 *   appendCustomEntry goal-completed       → "goal-completed" entry
 *   session stats getCurrentUsage          → sessionManager entries scan
 *                                            (same sums as getSessionStats)
 *   goal_updated session event             → pi.events.emit("goal_updated")
 *   sendHiddenMessage (budget steer)       → pi.sendMessage display:false
 *   prompt-time prependMessages goal context
 *                                          → before_agent_start message
 *                                            injection (hidden custom message)
 *   #scheduleGoalContinuation 800ms TUI timer
 *                                          → followUp delivery + triggerTurn
 *                                            (editor-empty guard dropped: pi
 *                                            extensions cannot read the editor)
 *   setActiveToolsByName                   → pi.setActiveTools
 *   status-line segment                    → ctx.ui.setStatus("goal", ...)
 *   settings goal.enabled / continuationModes / statusInFooter
 *                                          → dropped (extension is opt-in:
 *                                            installing it enables goal mode)
 *
 * omp operation semantics are kept verbatim: one live goal per session,
 * budget accounting includes cache writes but not cache reads, budget limit
 * steers exactly once per goal, interrupt pauses (never completes) the goal,
 * resume pauses active goals again, and completion requires a verified
 * `goal({op:"complete"})` call.
 *
 * Integration contract for other extensions:
 *   - `pi.events.emit("goal_updated", { goal, state })` after every runtime
 *     transition (goal may be null; state undefined after drop)
 *   - reads `todo_updated` events + "todo-phases" entries from pi-todo to
 *     render the goal todo context (works without pi-todo installed)
 */

// Prompt lives in a static .md asset next to this module (published with the
// package). Loaded at runtime: pi loads extensions through jiti, which does
// not support bundler-style text imports (pi-todo precedent).
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	createGoalCommand,
	createGuidedGoalCommand,
	type GoalCommandDeps,
	goalArgumentCompletions,
	renderGuidedGoalKickoff,
} from "./src/commands.ts";
import { formatDuration, formatNumber } from "./src/format.ts";
import {
	GOAL_CLEARED_ENTRY_TYPE,
	GOAL_COMPLETED_ENTRY_TYPE,
	GOAL_STATE_ENTRY_TYPE,
	restoreGoalFromEntries,
} from "./src/restore.ts";
import { GoalRuntime } from "./src/runtime.ts";
import type { Goal, GoalModeState, GoalTokenUsage } from "./src/state.ts";
import { cloneGoal } from "./src/state.ts";
import { renderTemplate } from "./src/template.ts";
import { buildTodoContext, restoreTodoPhases, type TodoPhase } from "./src/todo-bridge.ts";
import { runGoalEvaluator } from "./src/evaluator.ts";
import { createGoalTool, type GoalToolDeps } from "./src/tool.ts";

const goalModeContextPrompt = readFileSync(
	path.join(path.dirname(fileURLToPath(import.meta.url)), "src", "prompts", "goal-mode-context.md"),
	"utf8",
);

interface EntryMessageLike {
	role?: string;
	stopReason?: string;
	usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | undefined;
}

interface EntryUsageLike {
	usage?: EntryMessageLike["usage"];
}

export default function piGoalExtension(pi: ExtensionAPI): void {
	// ------------------------------------------------------------------
	// Closure state (omp session fields)
	// ------------------------------------------------------------------
	let goalState: GoalModeState | undefined;
	/** Active tool set saved when goal mode took over (omp #goalModePreviousTools). */
	let savedTools: string[] | undefined;
	let turnCounter = 0;
	/** A continuation submitted by this extension is being processed. */
	let continuationInFlight = false;
	/** Last continuation turn produced no tool calls: stop auto-continuing. */
	let suppressNextContinuation = false;
	/** Any tool ran during the current agent run (suppression heuristic). */
	let runHadToolCalls = false;
	/** pi-todo phases for the goal todo context (empty without pi-todo). */
	let todoPhases: TodoPhase[] = [];
	/** Latest event context: gives the runtime synchronous entry access. */
	let currentCtx: ExtensionContext | undefined;
	/** A blocking ctx.ui dialog is open (ui_prompt_start/end). While open, no
	 *  continuation may fire: the modal would hide a turn starting behind it. */
	let uiPromptOpen = false;

	// ------------------------------------------------------------------
	// Usage accounting (mirror of pi getSessionStats().tokens sums)
	// ------------------------------------------------------------------
	function currentUsage(ctx: ExtensionContext | undefined): GoalTokenUsage {
		const totals: GoalTokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		if (!ctx) return totals;
		const add = (usage: EntryMessageLike["usage"]): void => {
			if (!usage) return;
			totals.input += usage.input ?? 0;
			totals.output += usage.output ?? 0;
			totals.cacheRead += usage.cacheRead ?? 0;
			totals.cacheWrite += usage.cacheWrite ?? 0;
		};
		for (const entry of ctx.sessionManager.getEntries()) {
			const typed = entry as { type?: string; message?: EntryMessageLike } & EntryUsageLike;
			if (typed.type === "branch_summary" || typed.type === "compaction") {
				add(typed.usage);
				continue;
			}
			if (typed.type !== "message") continue;
			const message = typed.message;
			if (!message) continue;
			if (message.role === "toolResult" || message.role === "assistant") {
				add(message.usage);
			}
		}
		return totals;
	}

	// ------------------------------------------------------------------
	// UI surfaces
	// ------------------------------------------------------------------
	/** omp status-line footer segment icons (unicode symbol set). */
	function goalStatusIcon(status: Goal["status"]): string {
		switch (status) {
			case "paused":
				return "⏸";
			case "complete":
				return "✔";
			case "budget-limited":
				return "⚠";
			case "dropped":
				return "⏹";
			default:
				return "🎯";
		}
	}

	/** omp status-line/segments.ts renderGoalMode: segment visible only while
	 *  enabled or paused; text "<icon> Goal used[/budget]" (goal.statusInFooter
	 *  defaults to true, so usage always renders). */
	function updateStatus(): void {
		const ctx = currentCtx;
		if (!ctx) return;
		const state = goalState;
		if (!state || !(state.enabled || state.goal.status === "paused")) {
			ctx.ui.setStatus("goal", undefined);
			return;
		}
		const goal = state.goal;
		const used = formatNumber(goal.tokensUsed);
		const budget = goal.tokenBudget !== undefined ? `/${formatNumber(goal.tokenBudget)}` : "";
		ctx.ui.setStatus("goal", `${goalStatusIcon(goal.status)} Goal ${used}${budget}`);
	}

	function notify(text: string, severity: "info" | "warning" | "error" = "info"): void {
		const ctx = currentCtx;
		if (!ctx) return;
		if (ctx.hasUI) {
			ctx.ui.notify(text, severity);
			return;
		}
		console.error(text);
	}

	// ------------------------------------------------------------------
	// Goal toolset management (omp setActiveToolsByName dance)
	// ------------------------------------------------------------------
	function ensureGoalToolActive(): void {
		const active = pi.getActiveTools().filter((name) => name !== "goal");
		savedTools = active;
		pi.setActiveTools([...new Set([...active, "goal"])]);
	}

	function restoreSavedTools(): void {
		if (savedTools !== undefined) {
			pi.setActiveTools(savedTools);
			savedTools = undefined;
		}
	}

	// ------------------------------------------------------------------
	// Exit (omp #exitGoalMode)
	// ------------------------------------------------------------------
	async function exitGoalMode(options?: { reason?: "completed" | "dropped" | "paused" }): Promise<void> {
		const currentState = goalState;
		if (options?.reason === "completed") {
			goalState = undefined;
			pi.appendEntry(GOAL_CLEARED_ENTRY_TYPE, { clearedAt: Date.now() });
			pi.appendEntry(GOAL_COMPLETED_ENTRY_TYPE, {
				objective: currentState?.goal?.objective,
				tokensUsed: currentState?.goal?.tokensUsed,
				tokenBudget: currentState?.goal?.tokenBudget,
				timeUsedSeconds: currentState?.goal?.timeUsedSeconds,
			});
		}
		restoreSavedTools();
		continuationInFlight = false;
		updateStatus();
		if (options?.reason === "completed") notify("Goal mode completed.");
		else if (options?.reason === "dropped") notify("Goal dropped.");
		else if (options?.reason === "paused") notify("Goal mode paused.");
	}

	// ------------------------------------------------------------------
	// goal_updated handling (omp #handleGoalSessionEvent)
	// ------------------------------------------------------------------
	function handleGoalUpdated(goal: Goal | null, state: GoalModeState | undefined): void {
		pi.events.emit("goal_updated", { goal, state });
		if (state?.goal?.status === "dropped") {
			// omp runtime.dropGoal commits state undefined (persist "none"), so the
			// dropped goal must vanish from session state entirely.
			goalState = undefined;
			void exitGoalMode({ reason: "dropped" });
			return;
		}
		goalState = state;
		if (!state?.enabled) {
			continuationInFlight = false;
		}
		updateStatus();
	}

	// ------------------------------------------------------------------
	// Runtime host (omp AgentSession GoalRuntimeHost)
	// ------------------------------------------------------------------
	const runtime = new GoalRuntime({
		getState: () => goalState,
		setState: (state) => {
			goalState = state;
		},
		getCurrentUsage: () => currentUsage(currentCtx),
		emit: (event) => {
			if (event.type === "goal_updated") {
				handleGoalUpdated(event.goal, event.state);
			}
		},
		persist: (mode, state) => {
			if (mode === "none") {
				pi.appendEntry(GOAL_CLEARED_ENTRY_TYPE, { clearedAt: Date.now() });
			} else if (state) {
				pi.appendEntry(GOAL_STATE_ENTRY_TYPE, { enabled: state.enabled, goal: cloneGoal(state.goal) });
			}
		},
		sendHiddenMessage: async (message) => {
			pi.sendMessage(
				{ customType: message.customType, content: message.content, display: false },
				{ deliverAs: message.deliverAs ?? "steer" },
			);
		},
	});

	// ------------------------------------------------------------------
	// Enter/replace/resume (omp #enterGoalMode and friends)
	// ------------------------------------------------------------------
	async function startGoal(objective: string): Promise<void> {
		if (goalState?.enabled) return;
		ensureGoalToolActive();
		const state = await runtime.createGoal({ objective });
		goalState = state;
		suppressNextContinuation = false;
		updateStatus();
		if (currentCtx && !currentCtx.isIdle()) {
			await sendGoalModeContext("steer");
		}
	}

	async function replaceGoal(objective: string): Promise<void> {
		const state = await runtime.replaceGoal({ objective });
		goalState = state;
		ensureGoalToolActive();
		suppressNextContinuation = false;
		updateStatus();
		if (currentCtx && !currentCtx.isIdle()) {
			await sendGoalModeContext("steer");
		}
	}

	async function resumeGoal(): Promise<void> {
		// omp #resumeGoalAction guard: exactly a persisted paused goal resumes.
		if (!goalState || goalState.enabled || goalState.goal.status !== "paused") {
			notify("No paused goal to resume.", "warning");
			return;
		}
		ensureGoalToolActive();
		const state = await runtime.resumeGoal();
		goalState = state;
		suppressNextContinuation = false;
		updateStatus();
		notify("Goal mode resumed.");
	}

	async function pauseGoal(): Promise<void> {
		if (!goalState?.enabled) {
			notify("No active goal to pause.", "warning");
			return;
		}
		await runtime.pauseGoal();
		await exitGoalMode({ reason: "paused" });
	}

	async function dropGoal(): Promise<void> {
		if (!goalState) {
			notify("No goal to drop.", "warning");
			return;
		}
		// runtime.dropGoal emits goal_updated (handled above: state → undefined,
		// exit notification) then commits undefined — no local state to reassign.
		await runtime.dropGoal();
	}

	/** omp #startGoalFromObjective: the objective text kicks off the work. */
	async function submitObjective(objective: string): Promise<void> {
		const streaming = currentCtx !== undefined && !currentCtx.isIdle();
		pi.sendUserMessage(objective, streaming ? { deliverAs: "steer" } : undefined);
	}

	async function setBudget(raw: string): Promise<void> {
		if (!goalState?.enabled) {
			notify("No active goal.", "warning");
			return;
		}
		if (goalState.goal.status === "complete") {
			notify("Goal is already complete.");
			return;
		}
		const trimmed = raw.trim().toLowerCase();
		let nextBudget: number | undefined;
		if (trimmed !== "off") {
			const parsed = Number.parseInt(trimmed, 10);
			if (!Number.isInteger(parsed) || parsed <= 0) {
				notify("Goal budget must be a positive integer or `off`.", "error");
				return;
			}
			nextBudget = parsed;
		}
		await runtime.onBudgetMutated(nextBudget);
		suppressNextContinuation = false;
		scheduleContinuation();
		notify(nextBudget === undefined ? "Goal budget cleared." : `Goal budget set to ${nextBudget}.`);
	}

	// ------------------------------------------------------------------
	// Goal context injection + continuation loop
	// ------------------------------------------------------------------
	async function sendGoalModeContext(deliverAs: "steer" | "followUp" | "nextTurn"): Promise<void> {
		const message = buildGoalModeMessage();
		if (!message) return;
		pi.sendMessage({ customType: "goal-mode-context", content: message, display: false }, { deliverAs });
	}

	function buildGoalModeMessage(): string | undefined {
		const content = runtime.buildActivePrompt();
		if (!content) return undefined;
		const todoToolActive = pi.getActiveTools().includes("todo");
		const todoContext = buildTodoContext(todoPhases, todoToolActive);
		return renderTemplate(goalModeContextPrompt, { goalContext: content, todoContext });
	}

	/** omp #scheduleGoalContinuation (TUI timer replaced by followUp delivery). */
	function scheduleContinuation(): void {
		if (!goalState?.enabled || goalState.goal.status !== "active") return;
		if (suppressNextContinuation) return;
		if (uiPromptOpen) return; // modal open: never start a turn behind it
		if (currentCtx?.hasPendingMessages()) return;
		const prompt = runtime.buildContinuationPrompt();
		if (!prompt) return;
		continuationInFlight = true;
		pi.sendMessage(
			{ customType: "goal-continuation", content: prompt, display: false },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	}

	// ------------------------------------------------------------------
	// Tool + command registration
	// ------------------------------------------------------------------
	const goalToolDeps: GoalToolDeps = {
		getRuntime: () => runtime,
		getState: () => goalState,
		// Grounded independent evaluator: a fresh `pi -p` subprocess in the
		// session cwd that re-verifies completion/impossibility claims itself
		// (src/evaluator.ts). currentCtx is undefined during registration, so
		// fall back to the process cwd.
		runEvaluator: (request, opts) =>
			runGoalEvaluator(request, { cwd: opts.cwd ?? currentCtx?.cwd ?? process.cwd(), signal: opts.signal }),
	};
	pi.registerTool(createGoalTool(goalToolDeps));

	const commandDeps: GoalCommandDeps = {
		getState: () => (goalState ? { enabled: goalState.enabled, goal: goalState.goal } : undefined),
		hasPausedGoal: () => goalState !== undefined && !goalState.enabled,
		// Command-driven start/replace mirror omp: create the goal, then submit
		// the objective text as the working prompt (steered when streaming).
		startGoal: async (objective) => {
			await startGoal(objective);
			await submitObjective(objective);
		},
		replaceGoal: async (objective) => {
			await replaceGoal(objective);
			await submitObjective(objective);
		},
		resumeGoal,
		pauseGoal,
		dropGoal,
		setBudget,
		startGuidedInterview: async (initial) => {
			// Expose the goal tool for the interview so the agent can finish by
			// calling `goal create` (omp handleGuidedGoalCommand). The kickoff
			// rides in as a hidden message; the interview is normal conversation.
			// omp queues behind an in-flight run (followUp) instead of steering it.
			ensureGoalToolActive();
			const kickoff = renderGuidedGoalKickoff(initial);
			pi.sendMessage(
				{ customType: "guided-goal", content: kickoff, display: false },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		},
	};
	pi.registerCommand("goal", {
		description: "Toggle goal mode (persistent autonomous objective for this session)",
		getArgumentCompletions: goalArgumentCompletions,
		handler: createGoalCommand(commandDeps),
	});
	pi.registerCommand("guided-goal", {
		description: "Have the agent interview you in chat, then set up goal mode",
		handler: createGuidedGoalCommand(commandDeps),
	});

	// Persistent transcript summary for completed goals (docs: appendEntry
	// entries "can render inside the chat transcript when paired with
	// pi.registerEntryRenderer()"). Invisible in the live flow (the goal tool
	// result already reports completion); renders on reload/history review.
	pi.registerEntryRenderer<{
		objective?: string;
		tokensUsed?: number;
		tokenBudget?: number;
		timeUsedSeconds?: number;
	}>(GOAL_COMPLETED_ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data;
		const objective = typeof data?.objective === "string" ? data.objective : "";
		const used = typeof data?.tokensUsed === "number" ? formatNumber(data.tokensUsed) : "0";
		const budget = typeof data?.tokenBudget === "number" ? ` / ${formatNumber(data.tokenBudget)}` : " (no budget)";
		const seconds = typeof data?.timeUsedSeconds === "number" ? data.timeUsedSeconds : 0;
		const text = theme.fg(
			"success",
			`● Goal completed${objective ? `: ${objective}` : ""} · ${used}${budget} tokens · ${formatDuration(seconds * 1000)}`,
		);
		return new Text(text, 0, 0);
	});

	// ------------------------------------------------------------------
	// Lifecycle events (omp agent-session + interactive-mode handlers)
	// ------------------------------------------------------------------
	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		// Branch-aware restore: latest valid snapshot on the current branch wins.
		const branch = ctx.sessionManager.getBranch();
		todoPhases = restoreTodoPhases(branch);
		const restored = restoreGoalFromEntries(branch);
		if (!restored) {
			goalState = undefined;
			// omp sdk.ts excludes the goal tool from the initial set; mirror that
			// when this session has no goal to manage.
			const active = pi.getActiveTools();
			if (active.includes("goal")) {
				pi.setActiveTools(active.filter((name) => name !== "goal"));
			}
			updateStatus();
			return;
		}
		goalState = restored;
		ensureGoalToolActive();
		// omp onThreadResumed: a persisted ACTIVE goal is paused again on cold
		// resume (the run that owned it is gone); paused/budget-limited goals
		// keep their state and re-arm accounting.
		const resumed = await runtime.onThreadResumed();
		goalState = resumed;
		updateStatus();
	});

	pi.on("agent_start", () => {
		runHadToolCalls = false;
	});

	pi.on("turn_start", (_event, ctx) => {
		currentCtx = ctx;
		runtime.onTurnStart(`turn-${++turnCounter}`, currentUsage(ctx));
	});

	pi.on("tool_execution_start", (_event, _ctx) => {
		runHadToolCalls = true;
		if (!continuationInFlight) {
			suppressNextContinuation = false;
		}
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		currentCtx = ctx;
		if (event.toolName === "goal") {
			await runtime.onGoalToolCompleted();
		} else {
			await runtime.onToolCompleted(event.toolName);
		}
	});

	pi.on("message_start", (event) => {
		// A real user message re-arms the continuation loop (omp watches
		// non-synthetic user message_start; goal-continuation messages are
		// custom role and never match).
		if (event.message.role === "user") {
			suppressNextContinuation = false;
		}
	});

	pi.on("before_agent_start", (_event, ctx) => {
		currentCtx = ctx;
		const content = buildGoalModeMessage();
		if (!content) return undefined;
		return {
			message: { customType: "goal-mode-context", content, display: false },
		};
	});

	pi.on("agent_end", async (event, ctx) => {
		currentCtx = ctx;
		// omp separates onAgentEnd (session) from continuation scheduling
		// (interactive-mode); both subscribe to the same end-of-run moment.
		const aborted = lastAssistantStopReason(event.messages) === "aborted";
		if (aborted) {
			await runtime.onTaskAborted({ reason: "interrupted" });
		} else {
			await runtime.onAgentEnd({ currentUsage: currentUsage(ctx) });
		}

		if (continuationInFlight) {
			suppressNextContinuation = !runHadToolCalls;
			continuationInFlight = false;
		}
		if (goalState?.mode === "exiting") {
			await exitGoalMode({ reason: "completed" });
			return;
		}
		updateStatus();
		scheduleContinuation();
	});

	pi.on("turn_end", (_event, ctx) => {
		currentCtx = ctx;
		updateStatus();
	});

	// Blocking ctx.ui dialogs (drop confirm, objective editor, /goal menu,
	// budget input — plus other extensions' ask_user). While one is open the
	// agent is not running, and a continuation must not start behind the modal.
	pi.on("ui_prompt_start", (_event, ctx) => {
		currentCtx = ctx;
		uiPromptOpen = true;
		updateStatus();
	});

	pi.on("ui_prompt_end", (_event, ctx) => {
		currentCtx = ctx;
		uiPromptOpen = false;
		updateStatus();
		// Recover a continuation withheld while the dialog was open. Only when
		// idle: if the agent is still streaming (e.g. another extension's
		// ask_user just closed), its own agent_end schedules the continuation.
		if (ctx.isIdle()) {
			scheduleContinuation();
		}
	});

	// Docs: "Use agent_settled for status integrations that need to know Pi
	// will not continue running automatically" — final usage is visible here.
	pi.on("agent_settled", (_event, ctx) => {
		currentCtx = ctx;
		updateStatus();
	});

	pi.on("session_tree", async (_event, ctx) => {
		currentCtx = ctx;
		// Tree navigation: omp reconciles with preserveActiveGoal — an active goal
		// stays live (the run continues), but accounting re-anchors to the
		// restored branch state.
		const branch = ctx.sessionManager.getBranch();
		todoPhases = restoreTodoPhases(branch);
		const restored = restoreGoalFromEntries(branch);
		if (!restored) {
			goalState = undefined;
			updateStatus();
			return;
		}
		goalState = restored;
		ensureGoalToolActive();
		const resumed = await runtime.onThreadResumed({ preserveActiveGoal: true });
		goalState = resumed;
		updateStatus();
	});

	pi.on("session_shutdown", () => {
		// Runtime replacement (quit/reload/session switch): drop closure state so
		// a stale instance never acts after teardown.
		goalState = undefined;
		currentCtx = undefined;
	});
}

function lastAssistantStopReason(messages: unknown[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as EntryMessageLike | undefined;
		if (message?.role === "assistant") return message.stopReason;
	}
	return undefined;
}

export type { GoalRuntimeHost } from "./src/runtime.ts";
// Re-exported for consumers that compose the pieces directly (tests, tools).
export { GoalRuntime } from "./src/runtime.ts";
export type { Goal, GoalModeState, GoalRuntimeEvent, GoalStatus, GoalToolDetails } from "./src/state.ts";
