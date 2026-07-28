/**
 * Core runtime types for pi-dynamic-workflows.
 *
 * Mirrors the OpenSpec workflow-definition / workflow-runtime specs, with
 * extension points reserved for the Claude Code coordination mechanisms that
 * land in later tasks (deterministic sandbox, cache-key resume, per-agent
 * abort). Pure TypeScript here — no external schema dependency yet; the
 * TypeBox / Standard Schema adapter is introduced when step factories need
 * runtime validation.
 */

// ---------------------------------------------------------------------------
// Stage primitives (7 per spec D4)
// ---------------------------------------------------------------------------

export type StageType =
	| "fan_out"
	| "agent"
	| "code"
	| "loop_until"
	| "adversarial"
	| "tournament"
	| "classify_route"
	| "sub_workflow"
	| "loop_until_dry";

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

/**
 * Per-run resource limits.
 *
 * Task 6 upgrades this from static caps to a live pool: the runtime tracks
 * cumulative spend and exposes `remaining()` so fanOut can scale batch size
 * dynamically (Claude Code's `while (budget.remaining() > N)` pattern,
 * re-expressed for the declarative graph as a budget-driven loopUntil).
 */
export interface Budget {
	readonly maxTokens?: number;
	readonly maxDurationMs?: number;
	readonly maxAgents?: number;
}

// ---------------------------------------------------------------------------
// Step statistics + result
// ---------------------------------------------------------------------------

export interface StepStats {
	readonly tokens: number;
	readonly cost: number;
	readonly durationMs: number;
	readonly agents: number;
	readonly failures: number;
}

export interface StepResult<T = unknown> {
	readonly id: string;
	readonly type: StageType;
	readonly status: "done" | "failed" | "skipped";
	readonly results: T;
	readonly stats: StepStats;
	/** Present only for loop_until / adversarial / tournament. */
	readonly iterations?: number;
}

// ---------------------------------------------------------------------------
// Step context — inter-step references (spec: ctx.input + ctx.step(id))
// ---------------------------------------------------------------------------

export interface StepContext {
	readonly input: unknown;
	step(id: string): { results: unknown; stats: StepStats };
}

// ---------------------------------------------------------------------------
// Workflow definition (defineWorkflow is a typed identity function)
// ---------------------------------------------------------------------------

/**
 * Concrete step payloads — a discriminated union on `type`. All seven step
 * types are implemented in the runner (src/runner/stage-executor.ts): the four
 * core primitives (agent/code/fan_out/loop_until) plus three composites
 * (adversarial/tournament/classify_route) expanded onto them.
 */
export interface StepBase {
	readonly id: string;
	readonly retry?: StepRetry;
}

/** agent: one LLM call (dispatched via the injectable AgentDispatch). */
export interface AgentStep extends StepBase {
	readonly type: "agent";
	readonly prompt: string | ((ctx: StepContext) => string | Promise<string>);
	readonly model?: string;
	readonly tools?: readonly string[];
	readonly systemPrompt?: string;
}

/** code: a pure deterministic transform — no LLM, no dispatch, not cached. */
export interface CodeStep extends StepBase {
	readonly type: "code";
	readonly transform: (ctx: StepContext) => unknown | Promise<unknown>;
}

/** Per-item agent spec emitted by a fan_out step's `agent` factory. */
export interface FanOutItemSpec extends AgentOpts {
	readonly prompt: string;
}

/** fan_out: parallel agents over a list, optional merge. */
export interface FanOutStep extends StepBase {
	readonly type: "fan_out";
	readonly over: (ctx: StepContext) => readonly unknown[];
	readonly agent: (item: unknown, index: number) => FanOutItemSpec;
	/** Defaults to mapWithConcurrencyLimit's cap (MAX_CONCURRENCY). */
	readonly parallelism?: number;
	readonly merge?: (results: readonly unknown[], ctx: StepContext) => unknown | Promise<unknown>;
}

/** loop_until: iterate a body agent until `until` / maxIterations / budget. */
export interface LoopUntilStep extends StepBase {
	readonly type: "loop_until";
	readonly prompt: (ctx: StepContext, iteration: number) => string | Promise<string>;
	readonly until: (ctx: StepContext, iteration: number) => boolean;
	readonly maxIterations?: number;
	readonly model?: string;
	readonly tools?: readonly string[];
	readonly systemPrompt?: string;
}

/** Shared agent options that affect output (and therefore the cache signature). */
export interface AgentOpts {
	readonly model?: string;
	readonly tools?: readonly string[];
	readonly systemPrompt?: string;
}

/** A single agent call: prompt + opts. Used by the composite steps. */
export interface AgentCallSpec extends AgentOpts {
	readonly prompt: string | ((ctx: StepContext) => string | Promise<string>);
}

/** Composite patterns — expanded onto the core primitives. */
/** adversarial: produce one candidate, N judges grade it against a rubric, tally. */
export interface AdversarialStep extends StepBase {
	readonly type: "adversarial";
	readonly produce: AgentCallSpec;
	readonly rubric: readonly string[];
	/** Number of independent judges. Default 3. */
	readonly judges?: number;
	readonly judge?: AgentOpts;
	/** Min passing judges for the candidate to pass. Default = majority (ceil(judges/2)). */
	readonly minPass?: number;
}
/** tournament: N distinct candidates, M judges rank them, pick a winner. */
export interface TournamentStep extends StepBase {
	readonly type: "tournament";
	readonly candidates: number;
	readonly produce: AgentCallSpec;
	readonly judges: number;
	readonly judge?: AgentOpts;
}
/** classify_route: classify input → category, then run the matching route's steps. */
export interface ClassifyRouteStep extends StepBase {
	readonly type: "classify_route";
	readonly classifier: AgentCallSpec;
	readonly routes: Readonly<Record<string, readonly StepDefinition[]>>;
	/** Route used when the category matches no key. */
	readonly fallback?: readonly StepDefinition[];
}

/** loop_until_dry: keep spawning discovery agents until K consecutive rounds
 *  return nothing new. CC's "loop-until-dry" pattern for unknown-size discovery.
 *  Each round's output is parsed via parseFirstJson and deduplicated via keyOf. */
export interface LoopUntilDryStep extends StepBase {
	readonly type: "loop_until_dry";
	/** Agent prompt builder — receives the known set so it can ask for new items. */
	readonly prompt: (ctx: StepContext, known: unknown[]) => string | Promise<string>;
	/** Stable key for deduplication. */
	readonly keyOf: (item: unknown) => string;
	/** Merge fresh items into the known set (default = known.concat(fresh)). */
	readonly merge?: (known: unknown[], fresh: unknown[]) => unknown[];
	/** Consecutive dry rounds required to stop. Default 2. */
	readonly dryThreshold?: number;
	/** Hard cap on rounds. Default 10. */
	readonly maxRounds?: number;
	/** Optional completeness critic: after dryThreshold is reached, run one
	 *  final critic agent asking "what's missing?". If the critic returns new
	 *  items, the loop restarts; otherwise it stops. Mirrors CC's completeness-
	 *  critic pattern (final agent asks "what's missing — modality not run,
	 *  claim unverified, source unread?"). */
	readonly critic?: {
		readonly prompt: (ctx: StepContext, known: unknown[]) => string | Promise<string>;
	};
}

/** sub_workflow: run a nested child workflow inline. Shares parent journal, budget, and registry.
 *  CC's `workflow(nameOrRef, args)` pattern — one level of nesting supported. */
export interface SubWorkflowStep extends StepBase {
	readonly type: "sub_workflow";
	/** The child workflow definition (inline or referenced). */
	readonly workflow: WorkflowDefinition;
	/** Input passed to the child workflow's ctx.input. If a function, called with parent ctx. */
	readonly input?: unknown | ((ctx: StepContext) => unknown);
	/** If true (default), child agents count against parent budget. If false, child has its own pool. */
	readonly inheritBudget?: boolean;
}

export type StepDefinition =
	| AgentStep
	| CodeStep
	| FanOutStep
	| LoopUntilStep
	| AdversarialStep
	| TournamentStep
	| ClassifyRouteStep
	| SubWorkflowStep
	| LoopUntilDryStep;

export interface StepRetry {
	readonly maxRetries: number;
	/** Re-executing an upstream stage as part of a retry cycle is not yet supported
	 * (the list-walk runner only re-runs the failing step). Tracked for a future
	 * spec revision; add `retryStage` back with implementation when ready. */
}

/** A phase groups related steps for UI progress-tree rendering.
 *  Steps not assigned to any phase render under an implicit default group. */
export interface PhaseDefinition {
	readonly title: string;
	readonly detail?: string;
	readonly stepIds: readonly string[];
	/** Optional model override for all agents in this phase. */
	readonly model?: string;
}

export interface WorkflowDefinition {
	readonly name: string;
	readonly description?: string;
	readonly steps: readonly StepDefinition[];
	readonly budget?: Budget;
	/** Optional phase groupings for progress-tree UI rendering. */
	readonly phases?: readonly PhaseDefinition[];
}

/** Typed identity helper: gives a workflow literal full union checking. */
export function defineWorkflow(wf: WorkflowDefinition): WorkflowDefinition {
	return wf;
}

// ---------------------------------------------------------------------------
// Run result (Task 7 runner surface)
// ---------------------------------------------------------------------------

export type RunStatus = "completed" | "failed" | "aborted";

export interface RunResult {
	readonly runId: string;
	readonly status: RunStatus;
	/** One entry per executed step, in order. Shorter than workflow.steps on abort/failure. */
	readonly steps: readonly StepResult[];
	/** Aggregated across executed steps. */
	readonly stats: StepStats;
	readonly journalFile?: string;
	readonly error?: string;
	/** Staged-resume info: how many agents hit the cache from a previous run. */
	readonly resume?: {
		readonly cachedHits: number;
		readonly cachedTotal: number;
		readonly previousRunId?: string;
	};
}

// ---------------------------------------------------------------------------
// Claude Code fusion — reserved types (land in Tasks 3–5)
// ---------------------------------------------------------------------------

/**
 * Stable cache key for one agent invocation: `sha256(callKey + NUL + normalizedOpts)`.
 * Normalization keeps only [schema, model, effort, isolation, agentType], drops
 * functions, sorts object keys — so identical (prompt, opts) produces identical
 * keys across runs (the determinism premise for resume).
 *
 * Task 4: the journal gains `{type:"result", key, ...}` rows and resume replays
 * cached agent calls without re-dispatch.
 */
export type CacheKey = string;

/** Unique id for a single agent call within a run. */
export type AgentCallId = string;

/**
 * Per-agent abort registry: `Map<callId, AbortController>`.
 *
 * Claude Code keeps one AbortController per in-flight agent so retry/skip can
 * target a single call without disturbing its batch siblings. In pi each agent
 * is a subprocess, so Task 5 pairs this map with `Map<callId, ChildProcess>`
 * in src/agent/dispatch.ts and translates abort → SIGTERM on exactly one process.
 */
export type AgentAbortMap = Map<AgentCallId, AbortController>;
