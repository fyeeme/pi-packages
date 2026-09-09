/**
 * pi-goal — todo bridge.
 *
 * omp rendered a `<todo_context>` block inside the goal-mode context message
 * by reading the host todo state directly (`session.getTodoPhases()`), gated
 * on `todo.enabled` + the todo tool being active. pi-goal is a separate
 * extension, so the state arrives over the documented pi-todo integration
 * contract instead:
 *
 *   - `pi.events.on("todo_updated")` keeps the live phases (pi-todo emits
 *     after every successful mutation, never on view or failure)
 *   - session entries (`todo-phases` full snapshots, pi-todo's documented
 *     entry type) restore the phases on session_start
 *
 * The rendered block is byte-identical to omp's goal-todo-context.md output:
 * phase names and task contents are XML-escaped with control characters
 * flattened (omp #sanitizeGoalTodoText).
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { escapeXmlText, renderTemplate } from "./template.ts";

const goalTodoContextPrompt = readFileSync(
	path.join(path.dirname(fileURLToPath(import.meta.url)), "prompts", "goal-todo-context.md"),
	"utf8",
);

/** pi-todo session entry customType for phase snapshots. */
const TODO_PHASES_ENTRY_TYPE = "todo-phases";

export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";

export interface TodoItem {
	content: string;
	status: TodoStatus;
	blocker?: string;
}

export interface TodoPhase {
	name: string;
	tasks: TodoItem[];
}

interface EntryLike {
	type?: string;
	customType?: string;
	data?: unknown;
}

function isTodoStatus(value: unknown): value is TodoStatus {
	return (
		value === "pending" ||
		value === "in_progress" ||
		value === "completed" ||
		value === "abandoned" ||
		value === "blocked"
	);
}

function isTodoPhase(value: unknown): value is TodoPhase {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (typeof record.name !== "string" || !Array.isArray(record.tasks)) return false;
	return record.tasks.every((task) => {
		if (typeof task !== "object" || task === null) return false;
		const t = task as Record<string, unknown>;
		return typeof t.content === "string" && isTodoStatus(t.status);
	});
}

/**
 * Restore todo phases from session entries (pi-todo's `todo-phases` snapshots).
 * Latest valid snapshot wins; malformed entries are skipped.
 */
export function restoreTodoPhases(entries: readonly unknown[]): TodoPhase[] {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as EntryLike | undefined;
		if (!entry || entry.type !== "custom" || entry.customType !== TODO_PHASES_ENTRY_TYPE) continue;
		const data = entry.data as { phases?: unknown } | undefined;
		if (data && Array.isArray(data.phases) && data.phases.every(isTodoPhase)) {
			return data.phases.map((phase) => ({
				name: phase.name,
				tasks: phase.tasks.map((task) => ({ content: task.content, status: task.status })),
			}));
		}
	}
	return [];
}

/** omp #sanitizeGoalTodoText: XML-escape and flatten control characters. */
function sanitizeTodoText(text: string): string {
	return escapeXmlText(text)
		.replace(/\r\n/g, "\\n")
		.replace(/\r/g, "\\r")
		.replace(/\n/g, "\\n")
		.replace(/\t/g, "\\t")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/g, " ");
}

/**
 * Render the `<todo_context>` block for the goal-mode context message.
 * Returns undefined when the todo tool is not active or there are no
 * non-empty phases (omp #buildGoalTodoContext gates).
 */
export function buildTodoContext(phases: TodoPhase[], todoToolActive: boolean): string | undefined {
	const canCallTodoTool = todoToolActive;
	if (!canCallTodoTool) return undefined;
	const nonEmpty = phases.filter((phase) => phase.tasks.length > 0);
	if (nonEmpty.length === 0) return undefined;

	let total = 0;
	let closed = 0;
	let open = 0;
	const promptPhases = nonEmpty.map((phase) => ({
		name: sanitizeTodoText(phase.name),
		tasks: phase.tasks.map((task) => {
			total++;
			if (task.status === "completed" || task.status === "abandoned") {
				closed++;
			} else {
				open++;
			}
			return { content: sanitizeTodoText(task.content), status: task.status };
		}),
	}));

	return renderTemplate(goalTodoContextPrompt, {
		canCallTodoTool,
		closed: String(closed),
		open: String(open),
		phases: promptPhases,
		total: String(total),
	});
}
