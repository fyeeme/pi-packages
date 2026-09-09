/**
 * pi-todo — tool definition.
 *
 * Ported from oh-my-pi `packages/coding-agent/src/tools/todo.ts` (TodoTool).
 * Adaptations for pi's extension API:
 *   ArkType schema + lenientArgValidation + resolveTodoParams repair
 *     → TypeBox schema + prepareArguments shim (op inference runs before
 *       schema validation; the closure supplies `hasExistingPhases`)
 *   AgentTool class + ToolSession  → ToolDefinition + closure deps
 *   concurrency: "exclusive"      → executionMode: "sequential"
 *   session getTodoPhases/setTodoPhases → getPhases/setPhases/persist/broadcast
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	applyParams,
	clonePhases,
	formatSummary,
	getCompletionTransitions,
	inferTodoOp,
	type TodoOperation,
	type TodoOpEntry,
	type TodoPhase,
	type TodoToolDetails,
} from "./state.ts";
import { renderTodoCall, renderTodoResult } from "./render.ts";

// Prompt lives in a static .md asset next to this module (published with the
// package). Loaded at runtime: pi loads extensions through jiti, which does
// not support bundler-style text imports (pi-dynamic-workflows precedent).
const todoDescription = readFileSync(
	path.join(path.dirname(fileURLToPath(import.meta.url)), "prompts", "todo.md"),
	"utf8",
);

export const TodoParamsSchema = Type.Object({
	op: StringEnum(["init", "start", "done", "rm", "drop", "block", "unblock", "append", "view"] as const, {
		description: "operation to apply",
	}),
	list: Type.Optional(
		Type.Array(
			Type.Object({
				phase: Type.String({ description: "phase name" }),
				items: Type.Array(Type.String({ description: "task content" }), {
					minItems: 1,
					description: "tasks for this phase",
				}),
			}),
			{ description: "phased task list (init)" },
		),
	),
	task: Type.Optional(Type.String({ description: "task content" })),
	phase: Type.Optional(Type.String({ description: "phase name" })),
	// No minItems here: `items` is only meaningful for `init`/`append`, and both
	// enforce non-empty with op-specific errors. A stray `items: []` on an op
	// that ignores it (e.g. `view`) must not be a hard schema rejection.
	items: Type.Optional(Type.Array(Type.String({ description: "task content" }), { description: "tasks to append" })),
	reason: Type.Optional(Type.String({ description: "blocker note (block op)" })),
});

export type TodoParams = Static<typeof TodoParamsSchema>;

/** Advisory nudge appended to the default system prompt while the tool is active. */
export const TODO_PROMPT_GUIDELINES = [
	"Consider calling the todo tool first to lay out a phased plan with a single `init` op. A good list covers the whole request — investigation through implementation and verification — not just the next step, with specific task descriptions a future turn could execute without re-planning.",
	"A useful list keeps each task to a concise, specific 5-10 word label; the `init` op only accepts phase names and task-label strings, so don't invent extra task metadata fields.",
	"If you create the list, continue the request in the same turn and avoid re-calling the todo tool unless task state materially changes.",
];

export interface TodoToolDeps {
	/** Current in-memory phases (already cloned on write). */
	getPhases(): TodoPhase[];
	/** Replace in-memory phases. */
	setPhases(phases: TodoPhase[]): void;
	/** Persist a full snapshot to the session. */
	persist(phases: TodoPhase[]): void;
	/** Broadcast a todo_updated event on the shared extension event bus. */
	broadcast(phases: TodoPhase[]): void;
}

export function createTodoTool(deps: TodoToolDeps): ToolDefinition<typeof TodoParamsSchema, TodoToolDetails> {
	const definition: ToolDefinition<typeof TodoParamsSchema, TodoToolDetails> = {
		name: "todo",
		label: "Todo",
		description: todoDescription,
		promptSnippet: "Write a structured todo list to track progress within a session",
		promptGuidelines: TODO_PROMPT_GUIDELINES,
		parameters: TodoParamsSchema,
		executionMode: "sequential",
		renderCall: (args, theme) => renderTodoCall(args, theme),
		// omp's renderer folds call args into the result view (touched-phase
		// diffing); pi passes them through the render context.
		renderResult: (result, options, theme, context) => renderTodoResult(result, options, theme, context?.args),

		prepareArguments(args: unknown): TodoParams {
			// Repair the one recoverable shape: a missing `op` alongside an
			// unambiguous payload (models routinely send `{list:[...]}` with no op).
			if (args && typeof args === "object" && !Array.isArray(args)) {
				const raw = args as Record<string, unknown>;
				if (raw.op === undefined) {
					const inferred = inferTodoOp(raw, deps.getPhases().length > 0);
					if (inferred) return { ...raw, op: inferred } as TodoParams;
				}
			}
			return args as TodoParams;
		},

		async execute(
			_toolCallId: string,
			params: TodoParams,
			_signal: AbortSignal | undefined,
			_onUpdate: undefined,
			_ctx: ExtensionContext,
		): Promise<AgentToolResult<TodoToolDetails>> {
			const previousPhases = clonePhases(deps.getPhases());
			const op: TodoOperation = params.op;
			// Pure-view calls are reads: no normalization, no state write.
			const readOnly = op === "view";
			const { phases: updated, errors } = readOnly
				? { phases: previousPhases, errors: [] as string[] }
				: applyParams(clonePhases(previousPhases), params as TodoOpEntry);
			// A batch with any error is discarded wholesale: persisting a
			// half-applied batch makes the natural retry hit "already exists" for
			// the ops that did land. State stays at previous. pi's tool contract
			// is throw-on-failure (no isError field on AgentToolResult), and the
			// thrown message carries the errors plus the unchanged list so the
			// model can retry with correct content.
			if (errors.length > 0) {
				throw new Error(formatSummary(previousPhases, errors, readOnly));
			}
			if (!readOnly) {
				deps.setPhases(clonePhases(updated));
				deps.persist(clonePhases(updated));
				deps.broadcast(clonePhases(updated));
			}
			const completedTasks = readOnly ? [] : getCompletionTransitions(previousPhases, updated);
			const details: TodoToolDetails = { op, phases: clonePhases(updated), storage: "session" };
			if (completedTasks.length > 0) details.completedTasks = completedTasks;

			return {
				content: [{ type: "text", text: formatSummary(updated, [], readOnly) }],
				details,
			};
		},
	};
	return definition;
}
