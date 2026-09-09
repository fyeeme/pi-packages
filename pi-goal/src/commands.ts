/**
 * pi-goal — /goal and /guided-goal commands.
 *
 * Ported from oh-my-pi interactive-mode goal command handlers
 * (#dispatchGoalSubcommand, #openGoalMenu, #showGoalDetails,
 * #promptGoalBudgetEdit, #pauseGoalAction, #resumeGoalAction,
 * #confirmAndDropGoal, #startGoalFromObjective, #replaceGoalFromObjective,
 * handleGuidedGoalCommand). omp host-internal surfaces map to pi:
 *
 *   showHookSelector     → ctx.ui.select      (headless: notify fallback)
 *   showHookEditor       → ctx.ui.editor (prefill carried like omp)
 *   showHookConfirm      → ctx.ui.confirm
 *   showStatus           → ctx.ui.notify(text, "info")
 *   showWarning          → ctx.ui.notify(text, "warning")
 *   showError            → ctx.ui.notify(text, "error")
 *   session.prompt(...)  → deps.submitObjective (sendUserMessage)
 *   followUp(kickoff)    → pi.sendMessage display:false, triggerTurn
 *
 * Messages, menu labels ("Adjust budget…" with omp's ellipsis), titles, and
 * severities are copied verbatim from the omp handlers. The guided-goal
 * interview rides in as a hidden custom message: the agent asks its questions
 * as normal assistant turns and the user answers in the ordinary editor (omp
 * shows no status message for the kickoff either).
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { formatDuration } from "./format.ts";
import type { Goal } from "./state.ts";
import { renderTemplate } from "./template.ts";

const promptsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "prompts");
const guidedGoalInterviewPrompt = readFileSync(path.join(promptsDir, "guided-goal-interview.md"), "utf8");

type Severity = "info" | "warning" | "error";

/** Actions the commands need from the host wiring (index.ts). */
export interface GoalCommandDeps {
	getState(): { enabled: boolean; goal: Goal } | undefined;
	/** True when a goal exists but is not enabled (paused / budget-limited paused). */
	hasPausedGoal(): boolean;
	startGoal(objective: string): Promise<void>;
	replaceGoal(objective: string): Promise<void>;
	resumeGoal(): Promise<void>;
	pauseGoal(): Promise<void>;
	dropGoal(): Promise<void>;
	setBudget(raw: string): Promise<void>;
	/** Guided-goal interview: expose the goal tool and queue the kickoff. */
	startGuidedInterview(initial: string | undefined): Promise<void>;
}

/** Headless-safe output: notify in dialog-capable UIs, stderr text elsewhere.
 *  Severity mirrors omp showStatus (info) / showWarning (warning) / showError
 *  (error). */
function emit(ctx: ExtensionCommandContext, text: string, severity: Severity = "info"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(text, severity);
		return;
	}
	// stderr: stdout carries the protocol in json/rpc/print modes.
	console.error(text);
}

function shortDetail(objective: string): string {
	return objective.length > 48 ? `${objective.slice(0, 47)}…` : objective;
}

const GOAL_SUBCOMMANDS = new Set(["set", "show", "pause", "resume", "drop", "budget"]);

/** omp parseGoalSubcommand: only known first-words are subcommands; otherwise
 * the whole input is an objective ("fix the build" ≠ sub "fix"). */
export function parseGoalSubcommand(input: string): { sub: string | undefined; rest: string } {
	const trimmed = input.trim();
	if (!trimmed) return { sub: undefined, rest: "" };
	const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
	if (!match) return { sub: undefined, rest: trimmed };
	const first = match[1].toLowerCase();
	if (GOAL_SUBCOMMANDS.has(first)) {
		return { sub: first, rest: match[2]?.trim() ?? "" };
	}
	return { sub: undefined, rest: trimmed };
}

export function createGoalCommand(deps: GoalCommandDeps) {
	return async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
		const { sub, rest } = parseGoalSubcommand(args ?? "");
		if (sub) {
			await dispatchSubcommand(sub, rest, ctx, deps);
			return;
		}

		// omp handleGoalModeCommand: an objective typed while a goal is live is
		// rejected with status/warning — the menu opens only on a bare `/goal`.
		const state = deps.getState();
		if (state?.enabled) {
			if (rest) {
				emit(ctx, "Goal mode is already active. Use /goal to manage it, or /goal drop to start over.");
				return;
			}
			await openGoalMenu("active", ctx, deps);
			return;
		}
		if (deps.hasPausedGoal()) {
			if (rest) {
				emit(ctx, "Resume the current goal first, or drop it before setting a new objective.", "warning");
				return;
			}
			await openGoalMenu("paused", ctx, deps);
			return;
		}
		let objective = rest;
		if (!objective && ctx.hasUI) {
			objective = (await ctx.ui.editor("Goal objective", ""))?.trim() ?? "";
		}
		if (!objective) {
			emit(ctx, "Usage: /goal <objective> — or /goal set <objective>");
			return;
		}
		await deps.startGoal(objective);
	};
}

async function dispatchSubcommand(
	sub: string,
	rest: string,
	ctx: ExtensionCommandContext,
	deps: GoalCommandDeps,
): Promise<void> {
	switch (sub) {
		case "set": {
			// omp #handleGoalSetSubcommand guard (showWarning severity).
			if (deps.hasPausedGoal()) {
				emit(ctx, "Resume the current goal first, or drop it before setting a new objective.", "warning");
				return;
			}
			let objective = rest;
			if (!objective && ctx.hasUI) {
				objective = (await ctx.ui.editor("Goal objective", ""))?.trim() ?? "";
			}
			if (!objective) {
				emit(ctx, "Missing objective.");
				return;
			}
			if (deps.getState()?.enabled) {
				await deps.replaceGoal(objective);
			} else {
				await deps.startGoal(objective);
			}
			return;
		}
		case "show":
			showGoalDetails(deps.getState(), ctx);
			return;
		case "pause":
			await deps.pauseGoal();
			return;
		case "resume":
			await deps.resumeGoal();
			return;
		case "drop":
			await confirmAndDrop(ctx, deps);
			return;
		case "budget": {
			// omp #dispatchGoalSubcommand "budget": disabled guards first, then the
			// editor prompt when no value was typed.
			if (!deps.getState()?.enabled) {
				emit(
					ctx,
					deps.hasPausedGoal() ? "Resume the goal before adjusting the budget." : "No active goal.",
					"warning",
				);
				return;
			}
			if (!rest) {
				await promptGoalBudgetEdit(ctx, deps);
				return;
			}
			await deps.setBudget(rest);
			return;
		}
		default:
			emit(
				ctx,
				"Usage: /goal [set <objective>|show|pause|resume|drop|budget <N|off>] — /guided-goal for the interview flow",
			);
	}
}

/** omp #openGoalMenu: omp labels verbatim (budget item carries an ellipsis). */
async function openGoalMenu(
	state: "active" | "paused",
	ctx: ExtensionCommandContext,
	deps: GoalCommandDeps,
): Promise<void> {
	const goal = deps.getState()?.goal;
	if (!goal) return;
	const summary = shortDetail(goal.objective);
	const title = state === "active" ? `Goal: ${summary} (${goal.status})` : `Goal paused: ${summary}`;
	const items =
		state === "active"
			? ["Show details", "Adjust budget…", "Pause", "Drop"]
			: ["Resume", "Show details", "Adjust budget…", "Drop"];
	if (!ctx.hasUI) {
		emit(ctx, `${title}\nAvailable: ${items.map((i) => i.toLowerCase()).join(", ")}`);
		return;
	}
	const choice = await ctx.ui.select(title, items);
	if (!choice) return;
	switch (choice) {
		case "Show details":
			showGoalDetails(deps.getState(), ctx);
			return;
		case "Adjust budget…":
			await promptGoalBudgetEdit(ctx, deps);
			return;
		case "Pause":
			await deps.pauseGoal();
			return;
		case "Resume":
			await deps.resumeGoal();
			return;
		case "Drop":
			await confirmAndDrop(ctx, deps);
			return;
	}
}

/** omp #showGoalDetails (showStatus severity: info). */
function showGoalDetails(state: { enabled: boolean; goal: Goal } | undefined, ctx: ExtensionCommandContext): void {
	const goal = state?.goal;
	if (!goal) {
		emit(ctx, "No goal set.");
		return;
	}
	const used = goal.tokensUsed.toLocaleString();
	const budgetLine =
		goal.tokenBudget !== undefined
			? `${used} / ${goal.tokenBudget.toLocaleString()} (${Math.max(0, goal.tokenBudget - goal.tokensUsed).toLocaleString()} left)`
			: `${used} (no budget)`;
	const lines = [
		`Objective: ${goal.objective}`,
		`Status: ${goal.status}${state?.enabled ? "" : " (paused)"}`,
		`Tokens: ${budgetLine}`,
		`Time spent: ${formatDuration(goal.timeUsedSeconds * 1000)}`,
	];
	emit(ctx, lines.join("\n"));
}

/** omp #promptGoalBudgetEdit: editor with the current budget prefilled; empty
 *  input cancels silently. */
async function promptGoalBudgetEdit(ctx: ExtensionCommandContext, deps: GoalCommandDeps): Promise<void> {
	const goal = deps.getState()?.goal;
	const prefill = goal?.tokenBudget !== undefined ? String(goal.tokenBudget) : "";
	let input: string | undefined;
	if (ctx.hasUI) {
		input = (await ctx.ui.editor("Goal budget (number, `off`, or empty to cancel)", prefill))?.trim();
	}
	if (!input) {
		if (!ctx.hasUI) emit(ctx, "Usage: /goal budget <N|off>");
		return;
	}
	await deps.setBudget(input);
}

async function confirmAndDrop(ctx: ExtensionCommandContext, deps: GoalCommandDeps): Promise<void> {
	if (!deps.getState() && !deps.hasPausedGoal()) {
		emit(ctx, "No goal to drop.", "warning");
		return;
	}
	if (ctx.hasUI) {
		const confirmed = await ctx.ui.confirm(
			"Drop goal?",
			"This removes the goal record. Accumulated usage stays in the session log.",
		);
		if (!confirmed) return;
	}
	await deps.dropGoal();
}

/** /guided-goal — interview first, goal create call at the end (omp
 *  handleGuidedGoalCommand: no kickoff status message). */
export function createGuidedGoalCommand(deps: GoalCommandDeps) {
	return async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
		if (deps.getState()?.enabled) {
			emit(ctx, "Goal mode is already active. Use /goal to manage it, or /goal drop to start over.");
			return;
		}
		if (deps.hasPausedGoal()) {
			emit(ctx, "Resume the current goal first, or drop it before setting a new objective.", "warning");
			return;
		}
		const initial = (args ?? "").trim();
		await deps.startGuidedInterview(initial || undefined);
	};
}

/** Render the guided-goal kickoff prompt (exposed for tests). */
export function renderGuidedGoalKickoff(initial: string | undefined): string {
	return renderTemplate(guidedGoalInterviewPrompt, { initial });
}

/**
 * /goal argument autocomplete — omp builtin-completions.ts
 * buildArgumentCompletions: subcommand names only while the first word is
 * being typed (`prefix.includes(" ")` → null), value carries omp's trailing
 * space, label is the bare name, description from the subcommand def.
 */
export function goalArgumentCompletions(
	prefix: string,
): Array<{ value: string; label: string; description?: string }> | null {
	if (prefix.includes(" ")) return null;
	const lower = prefix.toLowerCase();
	const subcommands = [
		{ value: "set ", label: "set", description: "Set or replace the goal" },
		{ value: "show ", label: "show", description: "Show current goal details" },
		{ value: "pause ", label: "pause", description: "Pause the current goal" },
		{ value: "resume ", label: "resume", description: "Resume a paused goal" },
		{ value: "drop ", label: "drop", description: "Drop the current goal" },
		{ value: "budget ", label: "budget", description: "Adjust the token budget" },
	];
	const filtered = subcommands.filter((item) => item.label.startsWith(lower));
	return filtered.length > 0 ? filtered : null;
}
