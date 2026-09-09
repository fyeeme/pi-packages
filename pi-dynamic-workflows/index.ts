/**
 * pi-dynamic-workflows — extension entry (Task 8 wiring).
 *
 * Registers the `run_workflow` tool so an agent can construct and execute a
 * workflow from within pi. The engine (src/runner) does the work; this entry
 * only adapts the agent's JSON args into the code-form WorkflowDefinition and
 * runs it with the default dispatch (real `pi --mode json` subprocesses).
 *
 * Live progress UI is delegated to the shared `@fyeeme/pi-subagents`
 * extension (registered via the `pi.extensions` manifest alongside this
 * entry): every spawned workflow agent notifies the process-global monitor
 * through spawnAgent, rendering in the shared above-editor agent widget, the
 * below-editor FleetView, and the `/agents` transcript viewer. This package
 * ships no widget/command of its own — a former `wf:progress` widget and
 * `/wf-inspect` command were removed in favor of that shared surface.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import piSubagents from "@fyeeme/pi-subagents";
import { defineWorkflow, runWorkflow } from "./src/index.ts";
import type { Budget, StepContext, StepDefinition, WorkflowDefinition } from "./src/types.ts";
import { WorkflowError } from "./src/errors.ts";
import { discoverWorkflowLibrary, loadLibraryWorkflow } from "./src/library.ts";

// ---------------------------------------------------------------------------
// Parameter schema (the JSON-serializable workflow subset)
// ---------------------------------------------------------------------------

const BudgetExhaustPolicy = Type.Optional(
	StringEnum(["throw", "null"] as const, {
		description: "Budget-exhaustion policy for this step: \"throw\" (default) aborts the run; \"null\" degrades this step to a null result so siblings/downstream continue (the run result records degraded steps).",
	}),
);

const StepSchema = Type.Union([
	Type.Object({
		id: Type.String({ description: "Step id; referenceable as {{step.<id>}} in later prompts" }),
		type: Type.Literal("agent"),
		prompt: Type.String({ description: "Prompt text; may use {{input}} / {{step.<id>}}" }),
		model: Type.Optional(Type.String({ description: "Full model id from the session (e.g. claude-sonnet-5). Omit to use the default session model. Invalid ids are dropped." })),
		systemPrompt: Type.Optional(Type.String()),
		onBudgetExhaust: BudgetExhaustPolicy,
	}),
	Type.Object({
		id: Type.String(),
		type: Type.Literal("log"),
		message: Type.String({ description: "Narrative line fired via the onLog lifecycle listener (zero dispatch / zero tokens)" }),
		onBudgetExhaust: BudgetExhaustPolicy,
	}),
	Type.Object({
		id: Type.String(),
		type: Type.Literal("fan_out"),
		items: Type.Array(Type.Unknown(), { description: "Static list to fan out over" }),
		prompt: Type.String({ description: "Per-item prompt template; {{item}} is the current item" }),
		model: Type.Optional(Type.String()),
		parallelism: Type.Optional(Type.Number()),
		onBudgetExhaust: BudgetExhaustPolicy,
	}),
	Type.Object({
		id: Type.String(),
		type: Type.Literal("adversarial"),
		prompt: Type.String({ description: "Produces the candidate to be judged" }),
		rubric: Type.Array(Type.String()),
		judges: Type.Optional(Type.Number()),
		minPass: Type.Optional(Type.Number()),
		model: Type.Optional(Type.String({ description: "Applies to the produce call AND the judges" })),
		onBudgetExhaust: BudgetExhaustPolicy,
	}),
	Type.Object({
		id: Type.String(),
		type: Type.Literal("tournament"),
		prompt: Type.String({ description: "Candidate producer prompt" }),
		candidates: Type.Number(),
		judges: Type.Number(),
		model: Type.Optional(Type.String({ description: "Applies to the candidate producers AND the judges" })),
		onBudgetExhaust: BudgetExhaustPolicy,
	}),
	Type.Object({
		id: Type.String(),
		type: Type.Literal("classify_route"),
		prompt: Type.String({ description: "Classifier prompt; agent should reply {category: \"...\"}" }),
		routes: Type.Record(
			Type.String(),
			Type.Array(Type.Object({ id: Type.String(), prompt: Type.String(), model: Type.Optional(Type.String()) })),
		),
		fallback: Type.Optional(
			Type.Array(Type.Object({ id: Type.String(), prompt: Type.String(), model: Type.Optional(Type.String()) })),
		),
		model: Type.Optional(Type.String()),
		onBudgetExhaust: BudgetExhaustPolicy,
	}),
]);

const BudgetSchema = Type.Object({
	maxAgents: Type.Optional(Type.Number()),
	maxTokens: Type.Optional(Type.Number()),
	maxDurationMs: Type.Optional(Type.Number()),
});

const WorkflowSchema = Type.Object({
	name: Type.String(),
	description: Type.Optional(Type.String()),
	steps: Type.Array(StepSchema),
	budget: Type.Optional(BudgetSchema),
});

const RunWorkflowParams = Type.Object({
	source: Type.Optional(
		StringEnum(["inline", "library"] as const, {
			description:
				'Where the workflow comes from. "inline" (default): the `workflow` parameter (JSON subset). "library": a named workflow from the discovered library (bundled workflows/ + project .pi/workflows/lib/, project overrides bundled) — full step set incl. loop_until, loaded through the determinism guard.',
			default: "inline",
		}),
	),
	name: Type.Optional(
		Type.String({ description: 'Library workflow name (required for source: "library").' }),
	),
	workflow: Type.Optional(WorkflowSchema),
	budget: Type.Optional(
		Type.Object(
			{
				maxAgents: Type.Optional(Type.Number()),
				maxTokens: Type.Optional(Type.Number()),
				maxDurationMs: Type.Optional(Type.Number()),
			},
			{
				description:
					"Per-call budget override (library mode only — inline workflows declare budget inside `workflow.budget`). Fields merge over the workflow definition's own budget; use it to tighten a library workflow for a large input without editing the definition. Omitted fields keep the definition's values.",
			},
		),
	),
	input: Type.Optional(Type.String({ description: "Initial ctx.input (also {{input}} in prompts)" })),
	cwd: Type.Optional(Type.String({ description: "Working dir + journal base. Default: session cwd" })),
	now: Type.Optional(Type.Number({ description: "Deterministic inception ms (resume seed). Default: Date.now()" })),
});

// ---------------------------------------------------------------------------
// Template compilation (data prompt string → code prompt function)
// ---------------------------------------------------------------------------

const HAS_TEMPLATE = /\{\{[^}]+\}\}/;
const TEMPLATE_TOKEN = /\{\{([^}]+)\}\}/g;

function fmt(value: unknown): string {
	if (value === undefined || value === null) return "";
	return typeof value === "string" ? value : JSON.stringify(value);
}

/** Where a template is being filled — gates which tokens are valid.
 *  agent: {{input}} and {{step.<id>}} (no {{item}}).
 *  fanout-item: {{input}} and {{item}} (no {{step.<id>}} — items run before
 *  step results merge, so a step reference is a definition error, not a miss). */
type TemplateMode = "agent" | "fanout-item";

/** Resolve the three template tokens — {{input}}, {{item}} (fan_out item
 *  prompts only), {{step.<id>}} (agent prompts only) — in a SINGLE
 *  left-to-right pass. Substituted values are opaque: a literal {{...}} inside
 *  input/item/step results is emitted verbatim and NEVER re-evaluated, so
 *  workflows that process arbitrary text (logs, source, foreign templates)
 *  cannot be silently corrupted, value-hijacked, or crashed by their own data.
 *  Unknown or out-of-context tokens raise a categorized `compile` error naming
 *  the token and the referencing step. */
export function fill(template: string, mode: TemplateMode, ctx: StepContext, item: unknown | undefined, stepId: string): string {
	let out = "";
	let last = 0;
	for (const m of template.matchAll(TEMPLATE_TOKEN)) {
		const token = m[0];
		const idx = m.index ?? 0;
		out += template.slice(last, idx);
		out += resolveToken(token, m[1].trim(), mode, ctx, item, stepId);
		last = idx + token.length;
	}
	return out + template.slice(last);
}

function resolveToken(
	token: string,
	inner: string,
	mode: TemplateMode,
	ctx: StepContext,
	item: unknown | undefined,
	stepId: string,
): string {
	if (inner === "input") return fmt(ctx.input);
	if (inner === "item") {
		if (mode !== "fanout-item") throw badToken(token, "{{item}} is only valid in a fan_out item prompt", stepId);
		return fmt(item);
	}
	const stepRef = /^step\.(.+)$/.exec(inner);
	if (stepRef) {
		const id = stepRef[1];
		if (mode === "fanout-item") throw badToken(token, `{{step.${id}}} is not available inside a fan_out item prompt`, stepId, { refId: id });
		try {
			return fmt(ctx.step(id).results);
		} catch (e) {
			throw badToken(token, `{{step.${id}}} could not be resolved: ${(e as Error).message}`, stepId, { refId: id });
		}
	}
	throw badToken(token, "unknown template token", stepId);
}

function badToken(token: string, reason: string, stepId: string, extra?: Readonly<Record<string, unknown>>): WorkflowError {
	return new WorkflowError(`step "${stepId}": ${reason} (token: ${token})`, {
		category: "compile",
		detail: { token, stepId, ...extra },
	});
}

/** A string prompt becomes a function only if it contains a template token. */
function promptOf(s: string, stepId: string): string | ((ctx: StepContext) => string) {
	if (!HAS_TEMPLATE.test(s)) return s;
	return (ctx: StepContext) => fill(s, "agent", ctx, undefined, stepId);
}

// ---------------------------------------------------------------------------
// Data workflow → code WorkflowDefinition
// ---------------------------------------------------------------------------

interface RouteStepData {
	readonly id: string;
	readonly prompt: string;
	readonly model?: string;
}

function routeStepToCode(s: RouteStepData): StepDefinition {
	return { id: s.id, type: "agent", prompt: promptOf(s.prompt, s.id), model: s.model };
}

function buildWorkflow(w: {
	readonly name: string;
	readonly description?: string;
	readonly steps: readonly StepData[];
	readonly budget?: Budget;
}): WorkflowDefinition {
	return defineWorkflow({
		name: w.name,
		description: w.description,
		budget: w.budget,
		steps: w.steps.map((s): StepDefinition => {
			switch (s.type) {
				case "agent":
					return { id: s.id, type: "agent", prompt: promptOf(s.prompt, s.id), model: s.model, systemPrompt: s.systemPrompt, onBudgetExhaust: s.onBudgetExhaust };
				case "log":
					return { id: s.id, type: "log", message: s.message, onBudgetExhaust: s.onBudgetExhaust };
				case "fan_out":
					return {
						id: s.id,
						type: "fan_out",
						over: () => s.items,
						agent: (item, _index, ctx) => ({ prompt: fill(s.prompt, "fanout-item", ctx, item, s.id), model: s.model }),
						parallelism: s.parallelism,
						onBudgetExhaust: s.onBudgetExhaust,
					};
				case "adversarial":
					return {
						id: s.id,
						type: "adversarial",
						produce: { prompt: promptOf(s.prompt, s.id), model: s.model },
						rubric: [...s.rubric],
						judges: s.judges,
						minPass: s.minPass,
						onBudgetExhaust: s.onBudgetExhaust,
					};
				case "tournament":
					return {
						id: s.id,
						type: "tournament",
						candidates: s.candidates,
						judges: s.judges,
						produce: { prompt: promptOf(s.prompt, s.id), model: s.model },
						onBudgetExhaust: s.onBudgetExhaust,
					};
				case "classify_route": {
					const routes: Record<string, readonly StepDefinition[]> = {};
					for (const [cat, steps] of Object.entries(s.routes)) routes[cat] = steps.map(routeStepToCode);
					const fallback = s.fallback ? s.fallback.map(routeStepToCode) : undefined;
					return { id: s.id, type: "classify_route", classifier: { prompt: promptOf(s.prompt, s.id), model: s.model }, routes, fallback, onBudgetExhaust: s.onBudgetExhaust };
				}
			}
		}),
	});
}

// One discriminated data-step type (kept loose; the TypeBox schema is the contract).
type StepData =
	| { id: string; type: "agent"; prompt: string; model?: string; systemPrompt?: string; onBudgetExhaust?: "throw" | "null" }
	| { id: string; type: "log"; message: string; onBudgetExhaust?: "throw" | "null" }
	| { id: string; type: "fan_out"; items: readonly unknown[]; prompt: string; model?: string; parallelism?: number; onBudgetExhaust?: "throw" | "null" }
	| { id: string; type: "adversarial"; prompt: string; rubric: readonly string[]; judges?: number; minPass?: number; model?: string; onBudgetExhaust?: "throw" | "null" }
	| { id: string; type: "tournament"; prompt: string; candidates: number; judges: number; model?: string; onBudgetExhaust?: "throw" | "null" }
	| {
			id: string;
			type: "classify_route";
			prompt: string;
			routes: Readonly<Record<string, readonly RouteStepData[]>>;
			fallback?: readonly RouteStepData[];
			model?: string;
			onBudgetExhaust?: "throw" | "null";
	  };

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

/** Drop a step/route model id that isn't in the session registry, recording it. */
function dropInvalidModel(id: string, model: string | undefined, validIds: Set<string>, dropped: string[]): string | undefined {
	if (model && !validIds.has(model)) {
		dropped.push(`${id}→${model}`);
		return undefined;
	}
	return model;
}

export default function (pi: ExtensionAPI): void {
	// Compose the subagent stack (live agent UI — widget / FleetView /agents —
	// and the `subagent` tool) from the pinned dependency copy. The tool
	// registers exactly once per process (guard in pi-subagents' index.ts):
	// coexists with a standalone pi-subagents install and with other consumers
	// (pi-review) composing it.
	piSubagents(pi);

	pi.registerTool({
		name: "run_workflow",
		label: "Run workflow",
		description: [
			"Run a deterministic multi-agent workflow. Define steps inline and execute them with cache-resume, budget caps, and per-agent abort.",
			"Step types: agent, fan_out (over a static list), adversarial (produce + judges), tournament (candidates + judges), classify_route (classify → route sub-steps), log (narrative line).",
			"Every step accepts onBudgetExhaust: \"throw\" (default) / \"null\" — under \"null\", a step whose budget runs out degrades to a null result instead of aborting the run.",
			"String prompts support templates: {{input}}, {{step.<id>}} (a prior step's result), {{item}} (current fan_out item).",
			"Each agent step spawns a real `pi` subprocess, so pi + a provider must be configured.",
		].join(" "),
		promptSnippet: "run_workflow — execute a declarative multi-agent workflow (agent/fan_out/adversarial/tournament/classify_route/log)",
		parameters: RunWorkflowParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			// Library mode: resolve the named workflow from the discovered
			// library (ast-guard + jiti via the existing loader), then run it
			// through the same runner as inline mode. Unknown name → list the
			// available workflows instead of spawning anything.
			let workflowDef: WorkflowDefinition | undefined;
			if (params.source === "library") {
				if (!params.name)
					throw new Error('run_workflow: source "library" requires a workflow `name`.');
				try {
					const entry = await loadLibraryWorkflow(params.name, params.cwd ?? ctx.cwd);
					if (!entry) {
						const lib = await discoverWorkflowLibrary(params.cwd ?? ctx.cwd);
						const available = [...lib.values()]
							.map((e) => `- ${e.name}${e.description ? ` — ${e.description}` : ""} (${e.filePath})`)
							.join("\n");
						throw new Error(`run_workflow: no library workflow named "${params.name}". Available:\n${available || "(none)"}`);
					}
					workflowDef = entry.workflow;
				} catch (e) {
					if (e instanceof Error && e.message.startsWith("run_workflow:")) throw e;
					const msg = e instanceof Error ? e.message : String(e);
					throw new Error(`run_workflow failed: ${msg}`);
				}
			} else {
				if (!params.workflow)
					throw new Error('run_workflow: provide either a `workflow` (inline) or `name` with source "library".');
			}

				try {
					let workflow: WorkflowDefinition;
					if (params.source === "library") {
						// Library workflows are authored TS (models already validated at
						// authoring time; the determinism guard ran at load). A per-call
						// `budget` merges over the definition's own budget.
						workflow =
							workflowDef && params.budget
								? { ...workflowDef, budget: { ...workflowDef.budget, ...params.budget } }
								: workflowDef!;
					} else {
					// Scoped-models: when the session restricts models (--models /
					// enabledModels), validate step models against that scope; otherwise
					// fall back to the full registry. Invalid ids (e.g. "sonnet") are
					// dropped so the subprocess uses the default session model.
					const scoped = ctx.scopedModels;
					const validIds =
						scoped && scoped.length > 0
							? new Set(scoped.map((s) => s.model.id))
							: new Set(ctx.modelRegistry.getAll().map((m) => m.id));
					const dropped: string[] = [];
					const sanitizedSteps = params.workflow!.steps.map((s) => {
						const model = "model" in s ? dropInvalidModel(s.id, s.model, validIds, dropped) : undefined;
						if (s.type === "classify_route") {
							// Route/fallback sub-step models must be sanitized too — the schema
							// promises "Invalid ids are dropped", which routeStepToCode otherwise
							// passes straight through to the subprocess.
							const routes = Object.fromEntries(
								Object.entries(s.routes).map(([cat, rs]) => [
									cat,
									rs.map((r) => ({ ...r, model: dropInvalidModel(`${s.id}.${r.id}`, r.model, validIds, dropped) })),
								]),
							) as typeof s.routes;
							const fallback = s.fallback?.map((r) => ({ ...r, model: dropInvalidModel(`${s.id}.${r.id}`, r.model, validIds, dropped) }));
							return { ...s, model, routes, fallback };
						}
						return { ...s, model };
					});
					if (dropped.length > 0) {
						ctx.ui.notify(`Invalid model(s) dropped, using default: ${dropped.join(", ")}`, "warning");
					}
					const sanitizedWorkflow = { ...params.workflow!, steps: sanitizedSteps };
					workflow = buildWorkflow(sanitizedWorkflow);
				}
				const result = await runWorkflow({
					workflow,
					input: params.input,
					cwd: params.cwd ?? ctx.cwd,
					now: params.now ?? Date.now(),
					signal,
				});

				const lines = [
					`workflow "${workflow.name}" → ${result.status} (run ${result.runId})`,
					...result.steps.map((s) => `  [${s.status}] ${s.id} (${s.type})${preview(s.results)}`),
					`stats: ${result.stats.agents} agent(s), ${result.stats.tokens} tokens, $${result.stats.cost.toFixed(4)}`,
				];
				if (result.error) lines.push(`error: ${result.error}`);
				if (result.journalFile) lines.push(`full run details: ${result.journalFile}`);

				// Failed/aborted runs are tool errors: throw so pi sets isError and
				// reports the summary to the model (returning a value never sets the
				// error flag). Completed runs with degraded steps stay a normal result.
				const text = truncateHead(lines.join("\n"), { maxLines: 2000, maxBytes: 50_000 }).content;
				if (result.status !== "completed") {
					throw new Error(text);
				}
				const u = result.stats.usage;
				return {
					content: [{ type: "text" as const, text }],
					details: result,
					// Surface nested-agent usage so pi's footer //session totals include it.
					usage: u
						? {
								input: u.input,
								output: u.output,
								cacheRead: u.cacheRead,
								cacheWrite: u.cacheWrite,
								totalTokens: result.stats.tokens,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: result.stats.cost },
							}
						: undefined,
				};
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				throw new Error(`run_workflow failed: ${msg}`);
			}
		},
	});
}

function preview(value: unknown): string {
	const s = typeof value === "string" ? value : JSON.stringify(value);
	if (!s) return "";
	return ` — ${s.length > 100 ? `${s.slice(0, 100)}…` : s}`;
}
