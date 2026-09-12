/**
 * pi-todo — the oh-my-pi todo tool migrated to a pi extension.
 *
 * Source: oh-my-pi (github.com/can1357/oh-my-pi, a fork of badlogic/pi-mono)
 *   - packages/coding-agent/src/tools/todo.ts (state + ops) → src/state.ts
 *   - packages/coding-agent/src/tools/todo.ts (TodoTool)     → src/tool.ts
 *   - packages/coding-agent/src/tools/todo.ts (renderer)     → src/render.ts
 *   - packages/coding-agent/src/prompts/tools/todo.md        → src/prompts/todo.md
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
 *
 * Removed in the cognitive-neutral refactor (agent-steering logic, not
 * bookkeeping): eager-todo promptGuidelines, the stop-reminder nag loop
 * (checkCompletion / TodoReminderComponent), and the manual-edit
 * `<system-reminder>` injection. The todo list is a neutral stateful notepad:
 * statuses change only through explicit ops.
 *
 * Integration contract for other extensions:
 *   - `pi.events.emit("todo_updated", { phases })` after every successful
 *     mutation (never on view or failure); full snapshot, five-status enum
 *   - every mutation appends a "todo-phases" snapshot entry (pi-goal's
 *     todo bridge and restore both read it)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createTodoCommand } from "./src/commands.ts";
import { clonePhases, type TodoPhase } from "./src/state.ts";
import { createTodoTool } from "./src/tool.ts";
import { TODO_PHASES_ENTRY_TYPE, restorePhasesFromEntries } from "./src/restore.ts";

export default function piTodoExtension(pi: ExtensionAPI): void {
	let phases: TodoPhase[] = [];

	const deps = {
		getPhases: () => phases,
		setPhases: (next: TodoPhase[]) => {
			phases = next;
		},
		persist: (next: TodoPhase[]) => {
			pi.appendEntry(TODO_PHASES_ENTRY_TYPE, { phases: clonePhases(next) });
		},
		broadcast: (next: TodoPhase[]) => {
			pi.events.emit("todo_updated", { phases: clonePhases(next) });
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
	});
}
