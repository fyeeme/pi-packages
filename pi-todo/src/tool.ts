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
 *   eager-todo promptGuidelines    → dropped (cognitive-neutral notepad: the
 *       tool description documents the mechanics; the system prompt is not
 *       steered)
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
	getStatusTransitions,
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

/** The one write-back invariant: replace state, persist, broadcast — in that
 *  order. Shared by the tool path and the /todo command path so the two can
 *  never drift (persist/broadcast semantics live in index.ts's deps). */
export function commitPhases(deps: TodoToolDeps, next: TodoPhase[]): void {
	deps.setPhases(next);
	deps.persist(next);
	deps.broadcast(next);
}

export function createTodoTool(deps: TodoToolDeps): ToolDefinition<typeof TodoParamsSchema, TodoToolDetails> {
	const definition: ToolDefinition<typeof TodoParamsSchema, TodoToolDetails> = {
		name: "todo",
		label: "Todo",
		description: todoDescription,
		parameters: TodoParamsSchema,
		executionMode: "sequential",
		renderCall: renderTodoCall,
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
			const previousPhases = deps.getPhases();
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
			// model can retry with correct content. formatSummary does not fold
			// error results (the fold is gated on empty errors), so the full list
			// is present even on big lists.
			if (errors.length > 0) {
				throw new Error(formatSummary(previousPhases, errors, readOnly));
			}
			if (!readOnly) {
				// `updated` is a fresh clone nothing else references: hand ownership
				// to the closure, and let persist/broadcast make their own
				// entry-shaped snapshots (clonePhases inside index.ts).
				commitPhases(deps, updated);
			}
			// Per-write confirmation, independent of summary folding: on big lists
			// the folded summary may not show the operated tasks at all, so the
			// model needs an explicit record of what changed (status + blocker note).
			const transitions = readOnly ? [] : getStatusTransitions(previousPhases, updated);
			const details: TodoToolDetails = { op, phases: clonePhases(updated), storage: "session" };
			const completedTasks = transitions
				.filter(transition => transition.to === "completed")
				.map(({ phase, content }) => ({ phase, content }));
			if (completedTasks.length > 0) details.completedTasks = completedTasks;

			let text = formatSummary(updated, [], readOnly);
			if (transitions.length > 0) {
				const changed = transitions
					.map(transition => {
						const blocker =
							transition.to === "blocked"
								? updated
									.find(phase => phase.name === transition.phase)
									?.tasks.find(task => task.content === transition.content)?.blocker
								: undefined;
						const note = blocker ? ` (blocked: ${blocker})` : "";
						return `  - ${transition.content} [${transition.from} → ${transition.to}]${note} (${transition.phase})`;
					})
					.join("\n");
				text = `Changed:\n${changed}\n\n${text}`;
			}

			return {
				content: [{ type: "text", text }],
				details,
			};
		},
	};
	return definition;
}
