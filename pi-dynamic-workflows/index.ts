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
import { buildRenderGroups, type PhaseDef } from "./src/ui-groups.ts";
import { BOLD, CYAN, DIM, GREEN, RED, YELLOW, fmtTokens, stepIdOf } from "./src/format.ts";
import { defineWorkflow, runWorkflow } from "./src/index.ts";
import type { AgentCallId, Budget, RunResult, StageType, StepContext, StepDefinition, StepResult, StepStats, WorkflowDefinition } from "./src/types.ts";
import { WorkflowError } from "./src/errors.ts";
import type { AgentLifecycleListeners } from "./src/lifecycle.ts";
import { WorkflowInspect } from "./src/inspect.ts";

/** Last completed run, exposed to /wf-inspect for interactive review. */
let lastRunResult: RunResult | null = null;

/** Phases of the most recent run — handed to /wf-inspect so the post-run view
 *  groups steps the same way the live widget did (C1 consistency). */
let lastPhases: readonly PhaseDef[] | undefined;

/** Active widget during a run — lets /wf-inspect show a live snapshot
 *  before the run completes (lastRunResult is only set post-run). */
let activeWidget: { snapshot(): RunResult } | null = null;

// ---------------------------------------------------------------------------
// Parameter schema (the JSON-serializable workflow subset)
// ---------------------------------------------------------------------------

const BudgetExhaustPolicy = Type.Optional(
	Type.Union([Type.Literal("throw"), Type.Literal("null")], {
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
		message: Type.String({ description: "Narrative line emitted into the progress widget (zero dispatch / zero tokens)" }),
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
// Progress widget — bridges lifecycle events → TUI setWidget
// ---------------------------------------------------------------------------

type CallStatus = "running" | "done" | "failed" | "skipped" | "retried" | "cached";

interface CallInfo {
	readonly stepId: string;
	readonly status: CallStatus;
	readonly tokens: number;
	readonly model?: string;
}

export function buildProgressWidget(
	steps: readonly { id: string; type: string }[],
	setWidget: (lines: string[] | undefined) => void,
	setStatus: (text: string | undefined) => void,
	phases?: readonly PhaseDef[],
): AgentLifecycleListeners & { cleanup(): void; snapshot(): RunResult } {
	const start = Date.now();
	let lastStreamRender = 0;
	// Once cleanup() runs (run finished), late events from the abort window — the
	// SIGTERM→SIGKILL grace period during which a child can still emit streamed
	// deltas — must not re-create the panel via render()/setWidget.
	let disposed = false;
	const calls = new Map<AgentCallId, CallInfo>();
	// C2: narrative lines emitted by `log` steps, keyed by step id.
	const logLines = new Map<string, string>();
	// C3: accumulated streaming text per in-flight call (delta chunks from onUpdate).
	const streamText = new Map<string, string>();
	// Live output capture: callId → the settled agent's final text (from onAgentEnd
	// `output`), so a live snapshot shows REAL results, not fabricated progress text.
	const callOutputs = new Map<string, string>();
	// Every step starts at 0 expected agents; onAgentStart/onAgentCacheHit
	// increment as calls fire (fan_out totals emerge at runtime). Pre-seeding
	// non-fan_out steps to 1 double-counted (1→2 on start), leaving completed
	// single-agent steps stuck showing [1/2].
	const expected = new Map(steps.map((s) => [s.id, 0]));

	// C1+D1: phase grouping — shared pure builder (also used by /wf-inspect).
	const renderGroups = buildRenderGroups(steps, (s) => s.id, phases);

	// callId format: `${stepId}#${n}` (e.g. "fan#2", "adv#produce") — see src/format.ts stepIdOf.

	function render(): void {
		const picons: Record<string, string> = {
			done: GREEN("✓"),
			failed: RED("✗"),
			skipped: YELLOW("⏭"),
			running: YELLOW("⏳"),
			cached: GREEN("↻"),
		};

		const lines: string[] = [];
		const renderStep = (s: { id: string; type: string }, indent: boolean): void => {
			// C2: a `log` step renders as a distinct narrative line, not an agent row.
			if (s.type === "log") {
				const msg = logLines.get(s.id);
				if (msg !== undefined) lines.push(`${indent ? "    " : "  "}${DIM(msg)}`);
				return;
			}
			const total = expected.get(s.id) ?? 0;
			const entries = [...calls.values()].filter((c) => c.stepId === s.id);
			const running = entries.some((c) => c.status === "running");
			const failed = entries.filter((c) => c.status === "failed").length;
			const skipped = entries.filter((c) => c.status === "skipped").length;
			const done = entries.filter((c) => c.status === "done" || c.status === "cached").length;
			const cached = entries.filter((c) => c.status === "cached").length;
			const tokens = entries.reduce((sum, c) => sum + c.tokens, 0);
			const models = new Set(entries.map((c) => c.model).filter((m): m is string => Boolean(m)));

			const icon = failed > 0 ? picons.failed
				: skipped > 0 && done === 0 ? picons.skipped
				: total > 0 && done >= total ? (cached > 0 ? picons.cached : picons.done)
				: running ? picons.running
				: DIM("○");

			const progress = total > 1 ? ` [${done}/${total}]` : "";
			const tok = tokens > 0 ? ` · ${fmtTokens(tokens)} tok` : "";
			// A8/C4: show the serving model when known (single model shown; mixed
			// fan_out models collapse to a count to avoid a noisy line).
			const modelTag = models.size === 1 ? ` · ${[...models][0]}` : models.size > 1 ? ` · ${models.size} models` : "";
			const pad = indent ? "    " : "  ";
			lines.push(`${pad}${icon} ${s.id}${progress}${tok}${modelTag}`);
		};

		// Every phase group renders its header — a phase interrupted by ungrouped
		// items produces two groups; deduplicating the second header would leave
		// an indented, header-less orphan row (review L2).
		for (const g of renderGroups) {
			if (g.kind === "phase" && g.title) {
				lines.push(`  ${BOLD(g.title)}${g.detail ? DIM(` — ${g.detail}`) : ""}`);
			}
			for (const s of g.items) renderStep(s, g.kind === "phase");
		}

		// C3: streaming tail — the most-recently-started running call's accumulated
		// text, truncated to the last 3 lines, so concurrent fan-out previews only
		// the active call instead of flooding the widget.
		const running = [...calls.entries()].reverse().find(([id, c]) => c.status === "running" && streamText.has(id));
		if (running) {
			const [id] = running;
			const text = streamText.get(id) ?? "";
			const tail = text.split("\n").slice(-3);
			for (const ln of tail) {
				const clipped = ln.length > 100 ? `${ln.slice(0, 99)}…` : ln;
				if (clipped) lines.push(DIM(`    ↳ ${clipped}`));
			}
		}


		setWidget(lines.length > 0 ? lines : void 0);

		const all = [...calls.values()];
		const allDone = all.filter((c) => c.status !== "running").length;
		const totalTokens = all.reduce((sum, c) => sum + c.tokens, 0);
		const elapsed = ((Date.now() - start) / 1000).toFixed(0);
		setStatus(`wf ${allDone}/${calls.size} agents · ${fmtTokens(totalTokens)} tok · ${elapsed}s`);
	}

	const record = (callId: string, status: CallStatus, tokens = 0, model?: string): void => {
		if (disposed) return; // late settle after cleanup — do not re-create the panel
		calls.set(callId, { stepId: stepIdOf(callId), status, tokens, model });
		render();
	};

	return {
		cleanup() {
			disposed = true;
			calls.clear();
			streamText.clear();
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
				const status: StepResult["status"] = s.type === "log"
					? "done" // narrative line, no agent call — never "skipped"
					: failed > 0 ? "failed" : done >= total && total > 0 ? "done" : running > 0 ? "running" : "skipped";
				// Real outputs from settled calls — NOT the fabricated `[n/m] running`
				// progress string (that leaked into the detail pane as fake results).
				const settled = [...calls.entries()]
					.filter(([callId, c]) => c.stepId === s.id)
					.map(([callId]) => callOutputs.get(callId))
					.filter((o): o is string => Boolean(o));
				const results = settled.length > 0
					? (s.type === "fan_out" ? settled : settled[0])
					: undefined;
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
		onAgentEnd(callId, ok, stats, model, output) {
			// A skipped/retried/cached call's subprocess still settles (abort →
			// notifyEnd(false)); do not overwrite the already-recorded terminal
			// state with a "failed" stamp — the run's own bookkeeping marks the
			// step skipped/retried, so the widget must show the same.
			const cur = calls.get(callId);
			if (cur && cur.status !== "running") {
				streamText.delete(callId);
				return;
			}
			record(callId, ok ? "done" : "failed", stats?.tokens ?? 0, model);
			streamText.delete(callId); // free the accumulated tail once the call settles
			if (output) callOutputs.set(callId, output);
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
		onLog(stepId, message) {
			if (disposed) return;
			logLines.set(stepId, message);
			render();
		},
		onUpdate(callId, partial) {
			if (disposed) return;
			// Bound the accumulated tail: the widget only ever renders the last 3
			// lines (each clipped to ~100 chars), so keeping the full stream alive
			// for the call's duration is pure memory growth on long generations.
			streamText.set(callId, ((streamText.get(callId) ?? "") + partial).slice(-4096));
			// Throttle: a high-frequency stream (fan_out × many deltas) would otherwise
			// trigger a full O(steps×calls) render() per chunk. Bound to ~20fps; the
			// final onAgentEnd render always fires, so the settled state is exact.
			const nowMs = Date.now();
			if (nowMs - lastStreamRender >= 50) {
				lastStreamRender = nowMs;
				render();
			}
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
			"Step types: agent, fan_out (over a static list), adversarial (produce + judges), tournament (candidates + judges), classify_route (classify → route sub-steps), log (narrative line).",
			"Every step accepts onBudgetExhaust: \"throw\" (default) / \"null\" — under \"null\", a step whose budget runs out degrades to a null result instead of aborting the run.",
			"String prompts support templates: {{input}}, {{step.<id>}} (a prior step's result), {{item}} (current fan_out item).",
			"Each agent step spawns a real `pi` subprocess, so pi + a provider must be configured.",
		].join(" "),
		promptSnippet: "run_workflow — execute a declarative multi-agent workflow (agent/fan_out/adversarial/tournament/classify_route/log)",
		parameters: RunWorkflowParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			// Scoped-models: when the session restricts models (--models /
			// enabledModels), validate step models against that scope; otherwise
			// fall back to the full registry. Invalid ids (e.g. "sonnet") are
			// dropped so the subprocess uses the default session model.
			const scoped = ctx.scopedModels;
			const validIds = scoped && scoped.length > 0
				? new Set(scoped.map((s) => s.model.id))
				: new Set(ctx.modelRegistry.getAll().map((m) => m.id));
			const dropped: string[] = [];
			const sanitizedSteps = params.workflow.steps.map((s) => {
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
			const sanitizedWorkflow = { ...params.workflow, steps: sanitizedSteps };
			const widget = buildProgressWidget(
				sanitizedWorkflow.steps,
				(lines) => ctx.ui.setWidget("wf:progress", lines),
				(text) => ctx.ui.setStatus("wf:summary", text),
				sanitizedWorkflow.phases,
			);
			activeWidget = widget;
			lastPhases = sanitizedWorkflow.phases;
			try {
				const workflow = buildWorkflow(sanitizedWorkflow);
				const listeners: AgentLifecycleListeners = {
					onAgentStart: widget.onAgentStart,
					onAgentEnd: widget.onAgentEnd,
					onAgentSkip: widget.onAgentSkip,
					onAgentRetry: widget.onAgentRetry,
					onAgentCacheHit: widget.onAgentCacheHit,
					onLog: widget.onLog,
					onUpdate: widget.onUpdate,
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
			await ctx.ui.custom(
				(tui, _theme, _kb, done) =>
					new WorkflowInspect(r, tui, () => done(undefined), lastPhases),
				{ overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "80%" } },
			);
		},
	});
}

function preview(value: unknown): string {
	const s = typeof value === "string" ? value : JSON.stringify(value);
	if (!s) return "";
	return ` — ${s.length > 100 ? `${s.slice(0, 100)}…` : s}`;
}
