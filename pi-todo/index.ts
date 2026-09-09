/**
 * pi-todo — the oh-my-pi todo tool migrated to a pi extension.
 *
 * Source: oh-my-pi (github.com/can1357/oh-my-pi, a fork of badlogic/pi-mono)
 *   - packages/coding-agent/src/tools/todo.ts (state + ops) → src/state.ts
 *   - packages/coding-agent/src/tools/todo.ts (TodoTool)     → src/tool.ts
 *   - packages/coding-agent/src/tools/todo.ts (renderer)     → src/render.ts
 *   - packages/coding-agent/src/prompts/tools/todo.md        → src/prompts/todo.md
 *   - packages/coding-agent/src/session/todo-tracker.ts (checkCompletion)
 *                                                            → agent_end reminder loop
 *   - packages/coding-agent/src/modes/components/todo-reminder.ts → reminder entry renderer
 *   - packages/coding-agent/src/modes/controllers/todo-command-controller.ts
 *                                                            → src/commands.ts
 *
 * Adaptations for pi's extension API (each maps an omp-internal surface to
 * the public extension boundary):
 *
 *   omp surface                       → pi adaptation
 *   ─────────────────────────────────────────────────────────────────────────
 *   session getTodoPhases/setTodoPhases → closure state + pi.appendEntry
 *                                         full-snapshot entries ("todo-phases")
 *   restore via tool-result details     → session_start backward scan of the
 *                                         current branch (appendEntry chains
 *                                         off the leaf, so tree navigation
 *                                         and forks restore branch-local state)
 *   ArkType schema + lenientArgValidation
 *                                     → TypeBox schema + prepareArguments
 *                                         (missing-op inference before validation)
 *   concurrency: "exclusive"           → executionMode: "sequential"
 *   mergeCallAndResult renderer        → split renderCall/renderResult slots
 *   eager-todo system-prompt prewalk   → promptGuidelines on the tool definition
 *   developer-role injected messages   → pi.sendMessage display:false (custom
 *                                         role; both /todo edits and stop
 *                                         reminders)
 *   TodoTracker.checkCompletion        → agent_end handler: same reminder text,
 *                                         3-attempt cycle, question guard, and
 *                                         followUp-triggered continuation
 *   TodoReminderComponent (TUI box)    → "todo-reminder" entry renderer
 *                                         (transcript-anchored, same text)
 *   $EDITOR round-trip                 → ctx.ui.editor (Markdown round-trip)
 *   mid-run nudge (tool-choice queue)  → dropped (omp host-internal)
 *   subagent-match lighting            → dropped (omp host-internal provider)
 *
 * omp operation semantics are kept verbatim: batch-atomic duplicate
 * rejection, single in_progress invariant with earliest-pending auto-promotion,
 * drop = abandoned (never delete), block skips finished work, view is a read.
 *
 * Integration contract for other extensions:
 *   - `pi.events.emit("todo_updated", { phases })` after every successful
 *     mutation (never on view or failure)
 *   - stop reminders count pending + in_progress only (blocked is parked)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { createTodoCommand } from "./src/commands.ts";
import { isAwaitingUserAnswer, type TodoItem, type TodoPhase } from "./src/state.ts";
import { createTodoTool } from "./src/tool.ts";
import {
	TODO_PHASES_ENTRY_TYPE,
	TODO_REMINDER_ENTRY_TYPE,
	restorePhasesFromEntries,
} from "./src/restore.ts";

/** omp settings todo.remindersMax default (3) — extensions have no settings. */
const REMINDERS_MAX = 3;

interface AssistantTextLike {
	role?: string;
	content?: unknown;
}

function assistantText(message: AssistantTextLike): string {
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((block): block is { type: string; text?: string } =>
			!!block && typeof block === "object" && (block as { type?: unknown }).type === "text",
		)
		.map(block => block.text ?? "")
		.join("\n")
		.trim();
}

export default function piTodoExtension(pi: ExtensionAPI): void {
	let phases: TodoPhase[] = [];
	/** omp TodoTracker #reminderCount: reminders sent in the current cycle. */
	let reminderCount = 0;
	/** Last assistant reply text, for omp's awaiting-user-answer guard. */
	let lastAssistantText = "";

	const deps = {
		getPhases: () => phases,
		setPhases: (next: TodoPhase[]) => {
			phases = next;
		},
		persist: (next: TodoPhase[]) => {
			pi.appendEntry(TODO_PHASES_ENTRY_TYPE, { phases: clonePhasesForEntry(next) });
		},
		broadcast: (next: TodoPhase[]) => {
			pi.events.emit("todo_updated", { phases: clonePhasesForEntry(next) });
		},
		// omp #commit injects a developer system-reminder after user edits.
		sendHiddenMessage: (content: string) => {
			pi.sendMessage({ customType: "todo-user-edit", content, display: false });
		},
	};

	pi.registerTool(createTodoTool(deps));

	pi.registerCommand("todo", {
		description: "View or modify the agent's todo list",
		handler: createTodoCommand(deps),
	});

	pi.on("session_start", (_event, ctx) => {
		// Branch-aware restore: latest valid snapshot on the current branch wins.
		// getBranch() excludes entries on abandoned branches created after a
		// /fork or /tree navigation; getEntries() would let a later snapshot
		// from an abandoned branch win the backward scan.
		phases = restorePhasesFromEntries(ctx.sessionManager.getBranch());
		reminderCount = 0;
	});

	pi.on("message_start", (event) => {
		// omp resetCycle: a fresh user prompt starts a new reminder cycle.
		if ((event.message as { role?: string }).role === "user") {
			reminderCount = 0;
		}
	});

	pi.on("agent_end", (event) => {
		// Capture the last assistant text for the question guard BEFORE the
		// reminder decision (omp checkCompletion sees the terminal message).
		const messages = (event.messages ?? []) as AssistantTextLike[];
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message?.role === "assistant") {
				lastAssistantText = assistantText(message);
				break;
			}
		}
		checkCompletion();
	});

	/** omp TodoTracker.checkCompletion: nag + auto-continue on open todos. */
	function checkCompletion(): void {
		if (reminderCount >= REMINDERS_MAX) return;
		if (phases.length === 0) {
			reminderCount = 0;
			return;
		}
		const incompleteByPhase = phases
			.map(phase => ({
				name: phase.name,
				tasks: phase.tasks.filter(task => task.status === "pending" || task.status === "in_progress"),
			}))
			.filter(phase => phase.tasks.length > 0);
		const incomplete = incompleteByPhase.flatMap(phase => phase.tasks);
		if (incomplete.length === 0) {
			reminderCount = 0;
			return;
		}
		// omp isAwaitingUserAnswer: the assistant ended by asking the user
		// something — skip the reminder, the ball is in the user's court.
		if (isAwaitingUserAnswer(lastAssistantText)) return;

		reminderCount++;
		const todoList = incompleteByPhase
			.map(phase => `- ${phase.name}\n${phase.tasks.map(task => `  - ${task.content}`).join("\n")}`)
			.join("\n");
		const reminder =
			`<system-reminder>\n` +
			`You stopped with ${incomplete.length} incomplete todo item(s):\n${todoList}\n\n` +
			`Please continue working on these tasks or mark them complete if finished.\n` +
			`(Reminder ${reminderCount}/${REMINDERS_MAX})\n` +
			`</system-reminder>`;
		// omp: append developer message + scheduleAgentContinue.
		pi.sendMessage(
			{ customType: "todo-reminder", content: reminder, display: false },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		pi.appendEntry(TODO_REMINDER_ENTRY_TYPE, {
			count: incomplete.length,
			attempt: reminderCount,
			maxAttempts: REMINDERS_MAX,
			todos: incomplete.map(task => ({ content: task.content, status: task.status })),
		});
	}

	// omp TodoReminderComponent: warning box committed into the transcript —
	// `⚠ N incomplete todos - reminder X/Y` + italic unchecked list.
	pi.registerEntryRenderer<{
		count?: number;
		openCount?: number;
		attempt?: number;
		maxAttempts?: number;
		todos?: TodoItem[];
	}>(TODO_REMINDER_ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data;
		const count = typeof data?.count === "number" ? data.count : typeof data?.openCount === "number" ? data.openCount : 0;
		const attempt = typeof data?.attempt === "number" ? data.attempt : 1;
		const maxAttempts = typeof data?.maxAttempts === "number" ? data.maxAttempts : REMINDERS_MAX;
		const label = count === 1 ? "todo" : "todos";
		const header = `⚠ ${count} incomplete ${label} - reminder ${attempt}/${maxAttempts}`;
		const todos = Array.isArray(data?.todos) ? data.todos : [];
		const list = todos.length > 0 ? `\n\n${theme.italic(todos.map(todo => `  ☐ ${todo.content}`).join("\n"))}` : "";
		const component: Component = new Text(theme.fg("warning", header) + list, 0, 0);
		return component;
	});
}

/** Defensive clone for entries/events (omp TodoTracker.#clonePhases). */
function clonePhasesForEntry(phases: TodoPhase[]): TodoPhase[] {
	return phases.map(phase => ({
		name: phase.name,
		tasks: phase.tasks.map(task =>
			task.blocker !== undefined
				? { content: task.content, status: task.status, blocker: task.blocker }
				: { content: task.content, status: task.status },
		),
	}));
}
