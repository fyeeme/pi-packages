/**
 * pi-dynamic-workflows — extension entry (Task 8 wiring).
 *
 * Registers the `run_workflow` tool so an agent can construct and execute a
 * workflow from within pi. The engine (src/runner) does the work; this entry
 * only adapts the agent's JSON args into the code-form WorkflowDefinition and
 * runs it with the default dispatch (real `pi --mode json` subprocesses).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { defineWorkflow, runWorkflow } from "./src/index.ts";
import type { AgentCallId, Budget, RunResult, StageType, StepContext, StepDefinition, StepResult, StepStats, WorkflowDefinition } from "./src/types.ts";
import type { AgentLifecycleListeners } from "./src/lifecycle.ts";
import { WorkflowInspect } from "./src/inspect.ts";

/** Last completed run, exposed to /wf-inspect for interactive review. */
let lastRunResult: RunResult | null = null;

/** Active widget during a run — lets /wf-inspect show a live snapshot
 *  before the run completes (lastRunResult is only set post-run). */
let activeWidget: { snapshot(): RunResult } | null = null;

// ---------------------------------------------------------------------------
// Parameter schema (the JSON-serializable workflow subset)
// ---------------------------------------------------------------------------

const StepSchema = Type.Union([
	Type.Object({
		id: Type.String({ description: "Step id; referenceable as {{step.<id>}} in later prompts" }),
		type: Type.Literal("agent"),
		prompt: Type.String({ description: "Prompt text; may use {{input}} / {{step.<id>}}" }),
		model: Type.Optional(Type.String({ description: "Full model id from the session (e.g. claude-sonnet-5). Omit to use the default session model. Invalid ids are dropped." })),
		systemPrompt: Type.Optional(Type.String()),
	}),
	Type.Object({
		id: Type.String(),
		type: Type.Literal("fan_out"),
		items: Type.Array(Type.Unknown(), { description: "Static list to fan out over" }),
		prompt: Type.String({ description: "Per-item prompt template; {{item}} is the current item" }),
		model: Type.Optional(Type.String()),
		parallelism: Type.Optional(Type.Number()),
	}),
	Type.Object({
		id: Type.String(),
		type: Type.Literal("adversarial"),
		prompt: Type.String({ description: "Produces the candidate to be judged" }),
		rubric: Type.Array(Type.String()),
		judges: Type.Optional(Type.Number()),
		minPass: Type.Optional(Type.Number()),
		model: Type.Optional(Type.String()),
	}),
	Type.Object({
		id: Type.String(),
		type: Type.Literal("tournament"),
		prompt: Type.String({ description: "Candidate producer prompt" }),
		candidates: Type.Number(),
		judges: Type.Number(),
		model: Type.Optional(Type.String()),
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
	}),
]);

const BudgetSchema = Type.Object({
	maxAgents: Type.Optional(Type.Number()),
	maxTokens: Type.Optional(Type.Number()),
	maxDurationMs: Type.Optional(Type.Number()),
});

const PhaseSchema = Type.Object({
	title: Type.String({ description: "Phase display name" }),
	detail: Type.Optional(Type.String({ description: "Short detail shown next to the phase title" })),
	stepIds: Type.Array(Type.String(), { description: "Step ids belonging to this phase" }),
});

const WorkflowSchema = Type.Object({
	name: Type.String(),
	description: Type.Optional(Type.String()),
	steps: Type.Array(StepSchema),
	budget: Type.Optional(BudgetSchema),
	phases: Type.Optional(Type.Array(PhaseSchema, { description: "Group steps into phases for progress-tree UI" })),
});

const RunWorkflowParams = Type.Object({
	workflow: WorkflowSchema,
	input: Type.Optional(Type.String({ description: "Initial ctx.input (also {{input}} in prompts)" })),
	cwd: Type.Optional(Type.String({ description: "Working dir + journal base. Default: session cwd" })),
	now: Type.Optional(Type.Number({ description: "Deterministic inception ms (resume seed). Default: Date.now()" })),
});

// ---------------------------------------------------------------------------
// Template compilation (data prompt string → code prompt function)
// ---------------------------------------------------------------------------

const HAS_TEMPLATE = /\{\{[^}]+\}\}/;

function fmt(value: unknown): string {
	if (value === undefined || value === null) return "";
	return typeof value === "string" ? value : JSON.stringify(value);
}

function fill(template: string, ctx: StepContext, item?: unknown): string {
	return template
		.replace(/{{input}}/g, () => fmt(ctx.input))
		.replace(/{{item}}/g, () => fmt(item))
		.replace(/{{step\.([A-Za-z0-9_-]+)}}/g, (_m, id: string) => fmt(ctx.step(id).results));
}

/** A string prompt becomes a function only if it contains a template token. */
function promptOf(s: string): string | ((ctx: StepContext) => string) {
	if (!HAS_TEMPLATE.test(s)) return s;
	return (ctx: StepContext) => fill(s, ctx);
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
	return { id: s.id, type: "agent", prompt: promptOf(s.prompt), model: s.model };
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
					return { id: s.id, type: "agent", prompt: promptOf(s.prompt), model: s.model, systemPrompt: s.systemPrompt };
				case "fan_out":
					return {
						id: s.id,
						type: "fan_out",
						over: () => s.items,
						agent: (item) => ({ prompt: fill(s.prompt, { input: undefined, step: throwStep }, item), model: s.model }),
						parallelism: s.parallelism,
					};
				case "adversarial":
					return {
						id: s.id,
						type: "adversarial",
						produce: { prompt: promptOf(s.prompt), model: s.model },
						rubric: [...s.rubric],
						judges: s.judges,
						minPass: s.minPass,
					};
				case "tournament":
					return {
						id: s.id,
						type: "tournament",
						candidates: s.candidates,
						judges: s.judges,
						produce: { prompt: promptOf(s.prompt), model: s.model },
					};
				case "classify_route": {
					const routes: Record<string, readonly StepDefinition[]> = {};
					for (const [cat, steps] of Object.entries(s.routes)) routes[cat] = steps.map(routeStepToCode);
					const fallback = s.fallback ? s.fallback.map(routeStepToCode) : undefined;
					return { id: s.id, type: "classify_route", classifier: { prompt: promptOf(s.prompt), model: s.model }, routes, fallback };
				}
			}
		}),
	});
}

// A StepContext stand-in for fan_out item-prompt filling (items don't see ctx.step).
const throwStep = (id: string): { results: unknown; stats: never } => {
	throw new Error(`{{step.${id}}} is not available inside a fan_out item prompt`);
};

// One discriminated data-step type (kept loose; the TypeBox schema is the contract).
type StepData =
	| { id: string; type: "agent"; prompt: string; model?: string; systemPrompt?: string }
	| { id: string; type: "fan_out"; items: readonly unknown[]; prompt: string; model?: string; parallelism?: number }
	| { id: string; type: "adversarial"; prompt: string; rubric: readonly string[]; judges?: number; minPass?: number; model?: string }
	| { id: string; type: "tournament"; prompt: string; candidates: number; judges: number; model?: string }
	| {
			id: string;
			type: "classify_route";
			prompt: string;
			routes: Readonly<Record<string, readonly RouteStepData[]>>;
			fallback?: readonly RouteStepData[];
			model?: string;
	  };

// ---------------------------------------------------------------------------
// Progress widget — bridges lifecycle events → TUI setWidget
// ---------------------------------------------------------------------------

type CallStatus = "running" | "done" | "failed" | "skipped" | "retried" | "cached";

const GREEN = (s: string): string => `\x1b[32m${s}\x1b[0m`;
const RED = (s: string): string => `\x1b[31m${s}\x1b[0m`;
const YELLOW = (s: string): string => `\x1b[33m${s}\x1b[0m`;
const DIM = (s: string): string => `\x1b[2m${s}\x1b[0m`;
const CYAN = (s: string): string => `\x1b[36m${s}\x1b[0m`;

interface CallInfo {
	readonly stepId: string;
	readonly status: CallStatus;
	readonly tokens: number;
}

function buildProgressWidget(
	steps: readonly { id: string; type: string }[],
	setWidget: (lines: string[] | undefined) => void,
	setStatus: (text: string | undefined) => void,
): AgentLifecycleListeners & { cleanup(): void; snapshot(): RunResult } {
	const start = Date.now();
	const calls = new Map<AgentCallId, CallInfo>();
	// Every step starts at 0 expected agents; onAgentStart/onAgentCacheHit
	// increment as calls fire (fan_out totals emerge at runtime). Pre-seeding
	// non-fan_out steps to 1 double-counted (1→2 on start), leaving completed
	// single-agent steps stuck showing [1/2].
	const expected = new Map(steps.map((s) => [s.id, 0]));

	// callId format: `${stepId}#${n}` (e.g. "fan#2", "adv#produce").
	const stepIdOf = (callId: string): string => {
		const sep = callId.lastIndexOf("#");
		return sep >= 0 ? callId.slice(0, sep) : callId;
	};

	function fmtTokens(n: number): string {
		return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
	}

	function renderBudgetBar(label: string, spent: number, cap: number): string {
		const w = 14;
		const pct = Math.min(spent / cap, 1);
		const filled = Math.round(pct * w);
		const bar = CYAN("█".repeat(filled)) + DIM("░".repeat(w - filled));
		return `  ${label.padEnd(7)} [${bar}] ${fmtTokens(spent)}/${fmtTokens(cap)}`;
	}

	function render(): void {
		const picons: Record<string, string> = {
			done: GREEN("✓"),
			failed: RED("✗"),
			skipped: YELLOW("⏭"),
			running: YELLOW("⏳"),
			cached: GREEN("↻"),
		};

		const lines: string[] = [];
		for (const s of steps) {
			const total = expected.get(s.id) ?? 0;
			const entries = [...calls.values()].filter((c) => c.stepId === s.id);
			const running = entries.some((c) => c.status === "running");
			const failed = entries.filter((c) => c.status === "failed").length;
			const skipped = entries.filter((c) => c.status === "skipped").length;
			const done = entries.filter((c) => c.status === "done" || c.status === "cached").length;
			const cached = entries.filter((c) => c.status === "cached").length;
			const tokens = entries.reduce((sum, c) => sum + c.tokens, 0);

			const icon = failed > 0 ? picons.failed
				: skipped > 0 && done === 0 ? picons.skipped
				: total > 0 && done >= total ? (cached > 0 ? picons.cached : picons.done)
				: running ? picons.running
				: DIM("○");

			const progress = total > 1 ? ` [${done}/${total}]` : "";
			const tok = tokens > 0 ? ` · ${fmtTokens(tokens)} tok` : "";
			lines.push(`  ${icon} ${s.id}${progress}${tok}`);
		}


		setWidget(lines.length > 0 ? lines : void 0);

		const all = [...calls.values()];
		const allDone = all.filter((c) => c.status !== "running").length;
		const totalTokens = all.reduce((sum, c) => sum + c.tokens, 0);
		const elapsed = ((Date.now() - start) / 1000).toFixed(0);
		setStatus(`wf ${allDone}/${calls.size} agents · ${fmtTokens(totalTokens)} tok · ${elapsed}s`);
	}

	const record = (callId: string, status: CallStatus, tokens = 0): void => {
		calls.set(callId, { stepId: stepIdOf(callId), status, tokens });
		render();
	};

	return {
		cleanup() {
			calls.clear();
			setWidget(void 0);
			setStatus(void 0);
		},
		/** Build a synthetic RunResult from the live calls map, so /wf-inspect
		 *  can show in-progress agents before the run finishes. */
		snapshot(): RunResult {
			const snapSteps: StepResult[] = steps.map((s) => {
				const entries = [...calls.values()].filter((c) => c.stepId === s.id);
				const total = expected.get(s.id) ?? 0;
				const done = entries.filter((c) => c.status === "done" || c.status === "cached").length;
				const failed = entries.filter((c) => c.status === "failed").length;
				const running = entries.filter((c) => c.status === "running").length;
				const cached = entries.filter((c) => c.status === "cached").length;
				const tokens = entries.reduce((sum, c) => sum + c.tokens, 0);
				const status: StepResult["status"] = failed > 0 ? "failed" : done >= total && total > 0 ? "done" : "skipped";
				const tag = cached > 0 ? "cached" : running > 0 ? "running" : "";
				const results = `[${done}/${total}]${tag ? " " + tag : ""}`;
				return {
					id: s.id,
					type: s.type as StageType,
					status,
					results,
					stats: { tokens, cost: 0, durationMs: 0, agents: entries.length, failures: failed },
				};
			});
			const all = [...calls.values()];
			const stats: StepStats = {
				tokens: all.reduce((sum, c) => sum + c.tokens, 0),
				cost: 0,
				durationMs: Date.now() - start,
				agents: all.length,
				failures: all.filter((c) => c.status === "failed").length,
			};
			return { runId: "live", status: "completed", steps: snapSteps, stats };
		},
		onAgentStart(callId) {
			const stepId = stepIdOf(callId);
			expected.set(stepId, (expected.get(stepId) ?? 0) + 1);
			record(callId, "running");
		},
		onAgentEnd(callId, ok, stats) {
			record(callId, ok ? "done" : "failed", stats?.tokens ?? 0);
		},
		onAgentSkip(callId) {
			record(callId, "skipped");
		},
		onAgentRetry(callId) {
			record(callId, "retried");
		},
		onAgentCacheHit(callId) {
			const stepId = stepIdOf(callId);
			expected.set(stepId, (expected.get(stepId) ?? 0) + 1);
			record(callId, "cached");
		},
	};
}

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
	pi.registerTool({
		name: "run_workflow",
		label: "Run workflow",
		description: [
			"Run a deterministic multi-agent workflow. Define steps inline and execute them with cache-resume, budget caps, and per-agent abort.",
			"Step types: agent, fan_out (over a static list), adversarial (produce + judges), tournament (candidates + judges), classify_route (classify → route sub-steps).",
			"String prompts support templates: {{input}}, {{step.<id>}} (a prior step's result), {{item}} (current fan_out item).",
			"Each agent step spawns a real `pi` subprocess, so pi + a provider must be configured.",
		].join(" "),
		promptSnippet: "run_workflow — execute a declarative multi-agent workflow (agent/fan_out/adversarial/tournament/classify_route)",
		parameters: RunWorkflowParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			// Scoped-models: validate every step's model against the session's
			// model registry. Invalid ids (e.g. "sonnet") are dropped so the
			// subprocess uses the default session model instead of failing.
			const validIds = new Set(ctx.modelRegistry.getAll().map((m) => m.id));
			const dropped: string[] = [];
			const sanitizedSteps = params.workflow.steps.map((s) => {
				const model = dropInvalidModel(s.id, s.model, validIds, dropped);
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
			const sanitizedWorkflow = { ...params.workflow, steps: sanitizedSteps };
			const widget = buildProgressWidget(
				sanitizedWorkflow.steps,
				(lines) => ctx.ui.setWidget("wf:progress", lines),
				(text) => ctx.ui.setStatus("wf:summary", text),
			);
			activeWidget = widget;
			try {
				const workflow = buildWorkflow(sanitizedWorkflow);
				const listeners: AgentLifecycleListeners = {
					onAgentStart: widget.onAgentStart,
					onAgentEnd: widget.onAgentEnd,
					onAgentSkip: widget.onAgentSkip,
					onAgentRetry: widget.onAgentRetry,
					onAgentCacheHit: widget.onAgentCacheHit,
				};
				const result = await runWorkflow({
					workflow,
					input: params.input,
					cwd: params.cwd ?? ctx.cwd,
					now: params.now ?? Date.now(),
					signal,
					listeners,
				});
				lastRunResult = result;

				const lines = [
					`workflow "${workflow.name}" → ${result.status} (run ${result.runId})`,
					...result.steps.map((s) => `  [${s.status}] ${s.id} (${s.type})${preview(s.results)}`),
					`stats: ${result.stats.agents} agent(s), ${result.stats.tokens} tokens, $${result.stats.cost.toFixed(4)}`,
				];
				if (result.error) lines.push(`error: ${result.error}`);
				return {
					content: [{ type: "text" as const, text: lines.join("\n") }],
					details: result,
					isError: result.status !== "completed",
				};
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				return { content: [{ type: "text" as const, text: `run_workflow failed: ${msg}` }], details: { error: msg }, isError: true };
			} finally {
				activeWidget = null;
				ctx.ui.setWidget("wf:progress", void 0);
				widget.cleanup();
			}
		},
	});

	pi.registerCommand("wf-inspect", {
		description: "Inspect the current/last workflow run (↑↓ select, enter detail, esc exit)",
		handler: async (_args, ctx) => {
			// Prefer a live snapshot while a run is in progress; fall back to
			// the last completed result once the run has finished.
			const r = activeWidget?.snapshot() ?? lastRunResult;
			if (!r) {
				ctx.ui.notify("No workflow run yet — run run_workflow first", "warning");
				return;
			}
			await ctx.ui.custom((tui, _theme, _kb, done) =>
				new WorkflowInspect(r, tui, () => done(undefined)),
			);
		},
	});
}

function preview(value: unknown): string {
	const s = typeof value === "string" ? value : JSON.stringify(value);
	if (!s) return "";
	return ` — ${s.length > 100 ? `${s.slice(0, 100)}…` : s}`;
}
