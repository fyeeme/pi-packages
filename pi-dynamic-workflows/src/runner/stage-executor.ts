/**
 * Stage executor — dispatches one step by `type`, wiring the five CC-fusion
 * modules plus the three composite patterns:
 *   - cache/journal  → computeCacheKey + Journal lookup/append (cache-resume)
 *   - budget         → BudgetPool guardBatch/guardSpawn + caps (runaway + budget-exceeded, incl. maxTokens)
 *   - spawn          → AgentDispatch (real spawnAgent or injected fake) + registry
 *   - lifecycle      → listeners threaded through (agent start/end/skip/retry)
 *   - abort          → per-call AbortController via the registry + run signal
 *
 * All seven step types are implemented. Every agent call — including those
 * inside composites — goes through dispatchAgentCall (cache + budget + spawn +
 * journal + lifecycle + an early signal-abort short-circuit), so resume/budget/
 * abort apply uniformly. Composite verdicts are coerced (LLMs return "true"/"0"
 * as strings) and JSON is parsed via the shared string-aware parseFirstJson.
 *
 * Timing note: `Date.now()` is used here for per-step duration stats only. This
 * is engine code, NOT a workflow `.ts` body, so the Task 3 ast-guard does not
 * apply; run identity (`now`) is still supplied deterministically by the caller.
 * (maxDurationMs is therefore advisory — it needs a live clock; maxTokens is
 * enforced via BudgetPool.isExhausted on each spawn.)
 */
import {
	assertBatchSize,
	assertLifetimeAgents,
	BudgetExceededError,
	BudgetPool,
} from "../budget/index.ts";
import { computeCacheKey, type Journal } from "../cache/index.ts";
import { type AgentLifecycleListeners, notifyCacheHit } from "../lifecycle.ts";
import { parseFirstJson } from "../outcomes.ts";
import type {
	AdversarialStep,
	AgentCallSpec,
	AgentOpts,
	AgentStep,
	ClassifyRouteStep,
	CodeStep,
	LoopUntilDryStep,
	SubWorkflowStep,
	FanOutStep,
	LoopUntilStep,
	RunStatus,
	StepContext,
	StepDefinition,
	StepResult,
	StepStats,
	TournamentStep,
} from "../types.ts";
import type { AgentSpawnOptions, AgentSpawnRegistry, AgentSpawnResult } from "../agent/dispatch.ts";
import { mapWithConcurrencyLimit } from "../agent/dispatch.ts";

/** Injectable agent dispatch — same shape as spawnAgent. Default = real spawnAgent. */
export type AgentDispatch = (
	registry: AgentSpawnRegistry,
	opts: AgentSpawnOptions,
) => Promise<AgentSpawnResult>;

/** Shared, mutable execution state threaded through every step of a run. */
export interface StepExecContext {
	readonly workflowName: string;
	readonly dispatch: AgentDispatch;
	readonly registry: AgentSpawnRegistry;
	readonly journal: Journal;
	readonly pool: BudgetPool;
	readonly signal?: AbortSignal;
	readonly listeners?: AgentLifecycleListeners;
	/** Deterministic inception time (ms), supplied by the caller — never read from Date.now() here. */
	readonly now: number;
	/** Cumulative agents spawned so far this run (lifetime-cap counter). */
	spawned: number;
	/** Current classify_route nesting depth (cycle guard). */
	depth: number;
}

/** Outcome of a dispatched agent call (shared by all step kinds that call agents). */
interface AgentCallOutcome {
	readonly value: string;
	readonly ok: boolean;
	readonly aborted: boolean;
	readonly cached: boolean;
	readonly stats: StepStats;
}

const MAX_ROUTE_DEPTH = 8;

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function executeStep(
	step: StepDefinition,
	ctx: StepContext,
	exec: StepExecContext,
): Promise<StepResult> {
	switch (step.type) {
		case "agent":
			return execAgent(step, ctx, exec);
		case "code":
			return execCode(step, ctx);
		case "fan_out":
			return execFanOut(step, ctx, exec);
		case "loop_until":
			return execLoopUntil(step, ctx, exec);
		case "adversarial":
			return execAdversarial(step, ctx, exec);
		case "tournament":
			return execTournament(step, ctx, exec);
		case "classify_route":
			return execClassifyRoute(step, ctx, exec);
		case "sub_workflow":
			return execSubWorkflow(step, ctx, exec);
		case "loop_until_dry":
			return execLoopUntilDry(step, ctx, exec);
	}
}

// ---------------------------------------------------------------------------
// Shared agent dispatch — cache-resume + budget + spawn + journal + lifecycle
// ---------------------------------------------------------------------------

async function dispatchAgentCall(
	callId: string,
	prompt: string,
	signature: AgentOpts,
	exec: StepExecContext,
): Promise<AgentCallOutcome> {
	// If the run is already aborted, do not spawn (avoids spawning processes that
	// are killed immediately by the signal listener).
	if (exec.signal?.aborted) {
		return { value: "", ok: false, aborted: true, cached: false, stats: zeroStats };
	}

	const key = computeCacheKey({ workflowName: exec.workflowName, prompt, signature });

	const cached = exec.journal.lookup(key);
	if (cached?.type === "result" && cached.ok) {
		notifyCacheHit(exec.listeners, callId);
		return { value: cached.value as string, ok: true, aborted: false, cached: true, stats: zeroStats };
	}

const releaseSpawn = guardSpawn(exec, 1);
	notifyStart(exec, callId);
	await exec.journal.append({ type: "started", key, at: exec.now });
	let res: AgentSpawnResult;
	let durationMs: number;
	try {
		({ res, durationMs } = await timed(() =>
			exec.dispatch(exec.registry, dispatchOpts(callId, prompt, signature, exec.signal)),
		));
	} catch (e) {
		releaseSpawn(); // dispatch never started — return the reserved slot
		// dispatch rejected — write a terminal result so resume sees closure (not
		// an orphan `started`), per CC's "result always written" invariant. Returns
		// a failed outcome; runWithRetry treats status 'failed' as retryable.
		const msg = e instanceof Error ? e.message : String(e);
		await exec.journal.append({ type: "result", key, at: exec.now, ok: false, value: `dispatch error: ${msg}` });
		notifyEnd(exec, callId, false, zeroStats);
		return { value: `dispatch error: ${msg}`, ok: false, aborted: false, cached: false, stats: zeroStats };
	}
	applyOutcome(exec, res);
	const value = finalText(res);
	const ok = !res.aborted && res.exitCode === 0 && res.stopReason !== "error" && res.stopReason !== "aborted";
	const stats = usageStats(res, durationMs, ok);
	// On failure with no assistant output, surface the subprocess stderr /
	// errorMessage / exitCode so the caller can diagnose WHY it failed
	// (unknown model, missing provider, bad PATH, …). Without this the
	// step result is just "" and the error is invisible.
	const diag = ok || value ? value : diagnoseFailure(res);
	await exec.journal.append({ type: "result", key, at: exec.now, ok, value: diag });
	notifyEnd(exec, callId, ok, stats);
	return { value: diag, ok, aborted: res.aborted, cached: false, stats };
}

/** Build a human-readable failure reason from a subprocess result that
 *  produced no assistant text. Surfaces stderr / errorMessage / exitCode. */
function diagnoseFailure(res: AgentSpawnResult): string {
	const parts: string[] = ["[agent failed"];
	if (res.exitCode !== 0) parts.push(`exit ${res.exitCode}`);
	if (res.stopReason) parts.push(`stop:${res.stopReason}`);
	if (res.errorMessage) parts.push(res.errorMessage);
	// Last few non-empty stderr lines are usually the real cause.
	const stderrTail = res.stderr.trim().split("\n").filter(Boolean).slice(-4).join(" | ");
	if (stderrTail) parts.push(stderrTail);
	parts.push("]");
	return parts.join(" ");
}

// ---------------------------------------------------------------------------
// agent
// ---------------------------------------------------------------------------

async function execAgent(step: AgentStep, ctx: StepContext, exec: StepExecContext): Promise<StepResult> {
	const prompt = typeof step.prompt === "function" ? await step.prompt(ctx) : step.prompt;
	const callId = `${step.id}#${exec.spawned + 1}`;
	const outcome = await dispatchAgentCall(callId, prompt, step, exec);
	const status = outcome.ok ? "done" : outcome.aborted ? "skipped" : "failed";
	return stepResult(step.id, "agent", status, outcome.value, outcome.stats);
}

// ---------------------------------------------------------------------------
// code (pure transform — no dispatch, no cache, not budgeted)
// ---------------------------------------------------------------------------

async function execCode(step: CodeStep, ctx: StepContext): Promise<StepResult> {
	const start = Date.now();
	try {
		const value = await step.transform(ctx);
		return stepResult(step.id, "code", "done", value, {
			tokens: 0,
			cost: 0,
			durationMs: Date.now() - start,
			agents: 0,
			failures: 0,
		});
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		// Surface the error message (runStepSequence only appends sr.results when
		// it's a non-empty string); a bare catch left the failure cause invisible.
		return stepResult(step.id, "code", "failed", `code error: ${msg}`, {
			tokens: 0,
			cost: 0,
			durationMs: Date.now() - start,
			agents: 0,
			failures: 1,
		});
	}
}

// ---------------------------------------------------------------------------
// fan_out (parallel agents over a list)
// ---------------------------------------------------------------------------

async function execFanOut(step: FanOutStep, ctx: StepContext, exec: StepExecContext): Promise<StepResult> {
	const items = [...step.over(ctx)];
	const n = items.length;
	guardBatch(exec, n, `fan_out "${step.id}"`);

	const parallelism = step.parallelism ?? Math.min(n, 8);
	const itemSpecs = items.map((item, i) => step.agent(item, i));
	const start = Date.now();

	const outcomes = await mapWithConcurrencyLimit(itemSpecs, parallelism, (spec, i) =>
		dispatchAgentCall(`${step.id}#${i + 1}`, spec.prompt, spec, exec),
	);

	const durationMs = Date.now() - start;
	const merged = step.merge ? await step.merge(outcomes.map((o) => o.value), ctx) : outcomes.map((o) => o.value);
	const stats = aggregateStats(outcomes.map((o) => o.stats), durationMs);
	return stepResult(step.id, "fan_out", outcomesStatus(outcomes), merged, stats);
}

// ---------------------------------------------------------------------------
// loop_until (iterate a body agent until / maxIterations / budget)
// ---------------------------------------------------------------------------

async function execLoopUntil(step: LoopUntilStep, ctx: StepContext, exec: StepExecContext): Promise<StepResult> {
	const maxIter = step.maxIterations ?? 10;
	const start = Date.now();
	const values: unknown[] = [];
	let stats = zeroStats;
	let status: StepResult["status"] = "done";
	let iter = 0;

	while (iter < maxIter) {
		if (exec.signal?.aborted) {
			status = "skipped";
			break;
		}
		const prompt = await step.prompt(ctx, iter);
		const outcome = await dispatchAgentCall(`${step.id}#${iter + 1}`, prompt, step, exec);
		stats = addStats(stats, outcome.stats);
		values.push(outcome.value);
		if (!outcome.ok) {
			status = outcome.aborted ? "skipped" : "failed";
			break;
		}
		iter++;
		if (step.until(ctx, iter)) break;
	}

	return stepResult(step.id, "loop_until", status, values, withDuration(stats, start), iter);
}

// ---------------------------------------------------------------------------
// adversarial (produce one candidate, N judges grade it, tally)
// ---------------------------------------------------------------------------

async function execAdversarial(step: AdversarialStep, ctx: StepContext, exec: StepExecContext): Promise<StepResult> {
	const judgeCount = step.judges ?? 3;
	const minPass = step.minPass ?? Math.ceil(judgeCount / 2);
	guardBatch(exec, 1 + judgeCount, `adversarial "${step.id}"`);
	const start = Date.now();
	let stats = zeroStats;

	const producePrompt = await resolvePrompt(step.produce, ctx);
	const candidate = await dispatchAgentCall(`${step.id}#produce`, producePrompt, step.produce, exec);
	stats = addStats(stats, candidate.stats);

	const outcomes: AgentCallOutcome[] = [candidate];
	const judges: { pass: boolean; reason: string }[] = [];
	if (candidate.ok) {
		const judgeSpecs = Array.from({ length: judgeCount }, (_, i) => judgePrompt(i, candidate.value, step.rubric));
		const judgeOutcomes = await mapWithConcurrencyLimit(judgeSpecs, Math.min(judgeCount, 8), (prompt, i) =>
			dispatchAgentCall(`${step.id}#judge${i + 1}`, prompt, step.judge ?? {}, exec),
		);
		for (const o of judgeOutcomes) {
			stats = addStats(stats, o.stats);
			outcomes.push(o);
			const parsed = parseFirstJson(o.value) as { pass?: unknown; reason?: unknown } | undefined;
			judges.push({ pass: parsePassBool(parsed?.pass), reason: parseReason(parsed?.reason) });
		}
	} else {
		// populate judge slots so the result shape is stable on produce failure
		for (let i = 0; i < judgeCount; i++) judges.push({ pass: false, reason: "produce failed" });
	}
	const passCount = judges.filter((j) => j.pass).length;

	return stepResult(
		step.id,
		"adversarial",
		outcomesStatus(outcomes),
		{ candidate: candidate.value, passed: passCount >= minPass, passCount, minPass, judges },
		withDuration(stats, start),
		1 + judgeCount,
	);
}

// ---------------------------------------------------------------------------
// tournament (N distinct candidates, M judges rank, pick winner)
// ---------------------------------------------------------------------------

async function execTournament(step: TournamentStep, ctx: StepContext, exec: StepExecContext): Promise<StepResult> {
	if (step.candidates < 1) throw new Error(`tournament "${step.id}" requires candidates >= 1`);
	if (step.judges < 1) throw new Error(`tournament "${step.id}" requires judges >= 1`);
	guardBatch(exec, step.candidates + step.judges, `tournament "${step.id}"`);
	const start = Date.now();
	let stats = zeroStats;
	const outcomes: AgentCallOutcome[] = [];

	const producePrompt = await resolvePrompt(step.produce, ctx);
	const candSpecs = Array.from({ length: step.candidates }, (_, i) => ({
		prompt: `${producePrompt}\n\nAttempt ${i + 1}: take a distinct approach.`,
	}));
	const candOutcomes = await mapWithConcurrencyLimit(candSpecs, Math.min(step.candidates, 8), (spec, i) =>
		dispatchAgentCall(`${step.id}#cand${i + 1}`, spec.prompt, step.produce, exec),
	);
	const candidates = candOutcomes.map((o) => {
		stats = addStats(stats, o.stats);
		outcomes.push(o);
		return o.value;
	});

	const judgeSpecs = Array.from({ length: step.judges }, (_, j) => rankPrompt(j, candidates));
	const judgeOutcomes = await mapWithConcurrencyLimit(judgeSpecs, Math.min(step.judges, 8), (prompt, j) =>
		dispatchAgentCall(`${step.id}#judge${j + 1}`, prompt, step.judge ?? {}, exec),
	);
	const judgePicks = judgeOutcomes.map((o) => {
		stats = addStats(stats, o.stats);
		outcomes.push(o);
		const parsed = parseFirstJson(o.value) as { winner?: unknown; reason?: unknown } | undefined;
		return { winner: parseWinnerNum(parsed?.winner), reason: parseReason(parsed?.reason) };
	});
	const winner = tallyWinner(
		judgePicks.map((j) => j.winner),
		step.candidates,
	);

	return stepResult(
		step.id,
		"tournament",
		outcomesStatus(outcomes),
		{ candidates, winner, judges: judgePicks },
		withDuration(stats, start),
		step.candidates + step.judges,
	);
}

// ---------------------------------------------------------------------------
// classify_route (classify → run the matching route's sub-steps)
// ---------------------------------------------------------------------------

async function execClassifyRoute(step: ClassifyRouteStep, ctx: StepContext, exec: StepExecContext): Promise<StepResult> {
	const start = Date.now();
	const classifyPrompt = await resolvePrompt(step.classifier, ctx);
	const classify = await dispatchAgentCall(`${step.id}#classify`, classifyPrompt, step.classifier, exec);
	if (!classify.ok) {
		return stepResult(
			step.id,
			"classify_route",
			classify.aborted ? "skipped" : "failed",
			undefined,
			withDuration(classify.stats, start),
		);
	}

	const parsed = parseFirstJson(classify.value) as { category?: unknown } | undefined;
	const category = parseCategoryStr(parsed?.category);
	const routeSteps = step.routes[category] ?? step.fallback ?? [];

	exec.depth++;
	let sub: SequenceOutcome;
	try {
		sub = await runStepSequence(routeSteps, ctx.input, exec);
	} finally {
		exec.depth--;
	}
	const status: StepResult["status"] = sub.status === "completed" ? "done" : sub.status === "aborted" ? "skipped" : "failed";

	return stepResult(
		step.id,
		"classify_route",
		status,
		{ category, matched: category in step.routes, route: sub.steps, routeStatus: sub.status },
		withDuration(addStats(classify.stats, aggregateStats(sub.steps.map((s) => s.stats), 0)), start),
	);
}

// ---------------------------------------------------------------------------
// sub_workflow (nested child workflow — CC's workflow() pattern)
// ---------------------------------------------------------------------------

async function execSubWorkflow(step: SubWorkflowStep, ctx: StepContext, exec: StepExecContext): Promise<StepResult> {
	const start = Date.now();
	// Resolve the child's input: static value or function of parent ctx.
	const childInput = typeof step.input === "function" ? (step.input as (c: StepContext) => unknown)(ctx) : step.input ?? ctx.input;

	// Child shares parent's journal, pool, registry, and signal by default.
	// inheritBudget: false means the child uses its own BudgetPool (isolated caps).
	// Override workflowName with the CHILD's name so cache keys are scoped to the
	// child workflow — otherwise two sibling sub_workflows whose agents share a
	// prompt+signature collide on the parent's name and replay each other's cache.
	const childExec: StepExecContext = step.inheritBudget === false
		? { ...exec, workflowName: step.workflow.name, depth: exec.depth + 1, pool: new BudgetPool(step.workflow.budget ?? {}, exec.now) }
		: { ...exec, workflowName: step.workflow.name, depth: exec.depth + 1 };

	let sub: SequenceOutcome;
	if (childExec.depth > MAX_ROUTE_DEPTH) {
		sub = { steps: [], status: "failed", error: `sub_workflow nesting exceeded depth ${MAX_ROUTE_DEPTH}` };
	} else {
		sub = await runStepSequence(step.workflow.steps, childInput, childExec);
	}
	// Propagate the child's lifetime counter back to the parent: childExec is a
	// spread copy, so without this sync the parent's `spawned` undercounts every
	// agent the child spawned (callId numbering + the assertLifetimeAgents backstop
	// in guardSpawn both depend on this being run-cumulative, per its docstring).
	exec.spawned = childExec.spawned;

	const status: StepResult["status"] = sub.status === "completed" ? "done"
		: sub.status === "aborted" ? "skipped"
		: "failed";

	return stepResult(
		step.id,
		"sub_workflow",
		status,
		{ steps: sub.steps, status: sub.status, workflowName: step.workflow.name, error: sub.error },
		withDuration(aggregateStats(sub.steps.map((s) => s.stats), 0), start),
	);
}

// ---------------------------------------------------------------------------
// loop_until_dry (keep discovering until K rounds return nothing new)
// ---------------------------------------------------------------------------

async function execLoopUntilDry(step: LoopUntilDryStep, ctx: StepContext, exec: StepExecContext): Promise<StepResult> {
	const maxRounds = step.maxRounds ?? 10;
	const dryThreshold = step.dryThreshold ?? 2;
	const keyOf = step.keyOf;
	const merge = step.merge ?? ((known: unknown[], fresh: unknown[]) => known.concat(fresh));
	const start = Date.now();
	let known: unknown[] = [];
	let stats = zeroStats;
	let dry = 0;
	let round = 0;
	let status: StepResult["status"] = "done";

	while (round < maxRounds) {
		if (exec.signal?.aborted) { status = "skipped"; break; }
		const prompt = await step.prompt(ctx, known);
		const outcome = await dispatchAgentCall(`${step.id}#r${round + 1}`, prompt, {}, exec);
		stats = addStats(stats, outcome.stats);
		if (!outcome.ok) {
			status = outcome.aborted ? "skipped" : "failed";
			break;
		}
		const parsed = parseFirstJson(outcome.value) as unknown;
		const freshItems: unknown[] = Array.isArray(parsed) ? parsed : parsed !== undefined && parsed !== null ? [parsed] : [];
		const seen = new Set(known.map(keyOf));
		const novel = freshItems.filter((item) => !seen.has(keyOf(item)));
		if (novel.length === 0) {
			dry++;
			if (dry >= dryThreshold) {
				// Completeness critic: ask "what's missing?" one last time.
				if (step.critic) {
					const criticPrompt = await step.critic.prompt(ctx, known);
					const criticOutcome = await dispatchAgentCall(`${step.id}#critic`, criticPrompt, {}, exec);
					stats = addStats(stats, criticOutcome.stats);
					if (criticOutcome.ok) {
						const criticParsed = parseFirstJson(criticOutcome.value) as unknown;
						const criticItems: unknown[] = Array.isArray(criticParsed) ? criticParsed : [];
						const criticNovel = criticItems.filter((item) => !seen.has(keyOf(item)));
						if (criticNovel.length > 0) {
							known = merge(known, criticNovel);
							dry = 0; // reset dry counter and keep going
							round++;
							continue;
						}
					}
				}
				break;
			}
		} else {
			dry = 0;
			known = merge(known, novel);
		}
		round++;
	}

	return stepResult(step.id, "loop_until_dry", status, known, withDuration(stats, start), round);
}

// ---------------------------------------------------------------------------
// runStepSequence — run a list of steps (top-level workflow OR a classify route)
// ---------------------------------------------------------------------------

export interface SequenceOutcome {
	readonly steps: readonly StepResult[];
	readonly status: RunStatus;
	readonly error?: string;
}

export async function runStepSequence(
	steps: readonly StepDefinition[],
	input: unknown,
	exec: StepExecContext,
): Promise<SequenceOutcome> {
	if (exec.depth > MAX_ROUTE_DEPTH) {
		return { steps: [], status: "failed", error: `classify_route nesting exceeded depth ${MAX_ROUTE_DEPTH} (cycle?)` };
	}
	const prior = new Map<string, { results: unknown; stats: StepStats }>();
	const out: StepResult[] = [];
	const ctx: StepContext = {
		input,
		step(id: string) {
			const p = prior.get(id);
			if (!p) throw new Error(`step "${id}" has not executed yet (or does not exist)`);
			return p;
		},
	};

	for (const step of steps) {
		if (exec.signal?.aborted) return { steps: out, status: "aborted", error: "aborted by signal" };
		let sr: StepResult;
		try {
			sr = await runWithRetry(step, ctx, exec);
		} catch (e) {
			return { steps: out, status: "failed", error: e instanceof Error ? e.message : String(e) };
		}
		prior.set(step.id, { results: sr.results, stats: sr.stats });
		out.push(sr);
		// Post-step signal check: a run aborted mid-step (e.g. a fan_out whose
		// items all aborted) must never report "completed".
		if (exec.signal?.aborted) return { steps: out, status: "aborted", error: "aborted by signal" };
		if (sr.status === "failed") {
			const why = typeof sr.results === "string" && sr.results ? `: ${sr.results}` : "";
			return { steps: out, status: "failed", error: `step "${step.id}" failed${why}` };
		}
		if (sr.status === "skipped") {
			const aborted = !!exec.signal?.aborted;
			return { steps: out, status: aborted ? "aborted" : "failed", error: aborted ? "aborted by signal" : `step "${step.id}" skipped` };
		}
	}
	return { steps: out, status: "completed" };
}

async function runWithRetry(step: StepDefinition, ctx: StepContext, exec: StepExecContext): Promise<StepResult> {
	let sr = await executeStep(step, ctx, exec);
	const max = step.retry?.maxRetries ?? 0;
	let attempt = 0;
	let stats = sr.stats; // accumulate every attempt's stats (the pool is charged per dispatch)
	while (sr.status === "failed" && attempt < max) {
		if (exec.signal?.aborted) break;
		attempt++;
		sr = await executeStep(step, ctx, exec);
		stats = addStats(stats, sr.stats);
	}
	return stats === sr.stats ? sr : { ...sr, stats };
}

// ---------------------------------------------------------------------------
// prompt / verdict coercion helpers
// ---------------------------------------------------------------------------

async function resolvePrompt(spec: AgentCallSpec, ctx: StepContext): Promise<string> {
	return typeof spec.prompt === "function" ? spec.prompt(ctx) : spec.prompt;
}

function judgePrompt(index: number, candidate: string, rubric: readonly string[]): string {
	const criteria = rubric.map((r, i) => `${i + 1}. ${r}`).join("\n");
	return `You are judge ${index + 1}. Evaluate this candidate:\n\n${candidate}\n\nAgainst these criteria:\n${criteria}\n\nReply with ONLY JSON: {"pass": true|false, "reason": "..."}`;
}

function rankPrompt(index: number, candidates: readonly string[]): string {
	const listing = candidates.map((c, i) => `[${i}] ${c}`).join("\n\n");
	return `You are judge ${index + 1}. Rank these candidates:\n\n${listing}\n\nReply with ONLY JSON: {"winner": <index>, "reason": "..."}`;
}

/** LLMs sometimes stringify booleans/numbers ("true", "0"); coerce leniently. */
function parsePassBool(v: unknown): boolean {
	if (typeof v === "string") {
		const s = v.trim().toLowerCase();
		return s === "true" || s === "yes" || s === "y" || s === "1";
	}
	return v === true || v === 1;
}
function parseWinnerNum(v: unknown): number | undefined {
	if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) : undefined;
	// Number("") / Number(null) === 0 would record a spurious vote for candidate 0.
	if (typeof v !== "string" || !v.trim()) return undefined;
	const n = Number(v);
	return Number.isFinite(n) ? Math.trunc(n) : undefined;
}
function parseCategoryStr(v: unknown): string {
	// Trim: LLMs often emit {"category": " bug"} with stray whitespace, which
	// would silently miss the route key and fall through to fallback.
	return typeof v === "string" ? v.trim() : v === undefined || v === null ? "" : String(v).trim();
}
function parseReason(v: unknown): string {
	return typeof v === "string" ? v : "";
}

function tallyWinner(picks: readonly (number | undefined)[], n: number): number {
	if (n <= 0) return -1;
	const counts = new Array(n).fill(0);
	for (const p of picks) if (typeof p === "number" && p >= 0 && p < n) counts[p]!++;
	let best = 0;
	let voted = false;
	for (let i = 0; i < n; i++) {
		if (counts[i]! > 0) voted = true;
		if (counts[i]! > counts[best]!) best = i;
	}
	return voted ? best : -1;
}

function outcomesStatus(outcomes: readonly { ok: boolean; aborted: boolean }[]): StepResult["status"] {
	// A real failure (non-abort) fails the step. An aborted item (per-call skip or
	// run signal) does NOT fail individually — but if EVERY item aborted (e.g. all
	// per-call skipped), the step did zero real work → 'skipped' so the run stops
	// instead of reporting 'done' with empty results.
	if (outcomes.length > 0 && outcomes.every((o) => o.aborted)) return "skipped";
	if (outcomes.some((o) => !o.ok && !o.aborted)) return "failed";
	return "done";
}

// ---------------------------------------------------------------------------
// budget / spawn / stats helpers
// ---------------------------------------------------------------------------

/** Pre-check a whole batch (fan_out items, or a composite's total agents) fits the budget + MAX_BATCH cap.
 *  Does NOT reserve — individual dispatchAgentCall → guardSpawn → pool.reserve(1) atomically reserves
 *  per-agent. This avoids double-counting: a prior guardBatch reserve(total) + per-call guardSpawn
 *  reserve(1) charged 2x the agent slots. Serial runStepSequence has no cross-step TOCTOU to exploit
 *  the pre-check gap; within-step concurrency is guarded by reserve(1)'s atomic increment. */
function guardBatch(exec: StepExecContext, total: number, label: string): void {
	assertBatchSize(total);
	if (!exec.pool.canSpawn(total, exec.now)) {
		throw new BudgetExceededError(`${label} needs ${total} agents but the budget is exhausted`);
	}
}

/** Reserve one agent slot and check token budget. Returns a release handle —
 *  call it ONLY if the dispatch never started (spawn threw).
 *
 *  Lifetime accounting: `exec.spawned` is incremented SYNCHRONOUSLY here, before
 *  the await on dispatch, so that concurrent fan_out workers each see an accurate
 *  count when they reach assertLifetimeAgents. (Previously it was incremented in
 *  applyOutcome, after the dispatch settled — so N concurrent workers all read the
 *  pre-flight count and a single batch with parallelism > MAX_LIFETIME_AGENTS
 *  could bust the runaway backstop before any settle.) The release handle rolls
 *  the increment back so a failed dispatch doesn't consume a lifetime slot, which
 *  also preserves callId numbering across retries. */
function guardSpawn(exec: StepExecContext, n: number): () => void {
	exec.spawned += n;
	assertLifetimeAgents(exec.spawned);
	// isExhausted enforces maxTokens (and maxAgents) before committing.
	if (exec.pool.isExhausted(exec.now)) {
		exec.spawned -= n;
		throw new BudgetExceededError("agent spawn refused — budget exhausted");
	}
	const releasePool = exec.pool.reserve(n);
	return () => {
		exec.spawned -= n;
		releasePool();
	};
}

function applyOutcome(exec: StepExecContext, res: AgentSpawnResult): void {
	// `spawned` was incremented synchronously in guardSpawn; a settled agent keeps
	// its slot, so don't touch it here — only record token spend.
	exec.pool.track({ tokens: res.usage.input + res.usage.output });
}

async function timed(fn: () => Promise<AgentSpawnResult>): Promise<{ res: AgentSpawnResult; durationMs: number }> {
	const start = Date.now();
	const res = await fn();
	return { res, durationMs: Date.now() - start };
}

function dispatchOpts(
	callId: string,
	prompt: string,
	spec: AgentOpts,
	signal?: AbortSignal,
): AgentSpawnOptions {
	return {
		callId,
		task: prompt,
		model: spec.model,
		tools: spec.tools ? [...spec.tools] : undefined,
		systemPrompt: spec.systemPrompt,
		signal,
	};
}

function finalText(res: AgentSpawnResult): string {
	for (let i = res.messages.length - 1; i >= 0; i--) {
		const msg = res.messages[i];
		if (msg?.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

const zeroStats: StepStats = { tokens: 0, cost: 0, durationMs: 0, agents: 0, failures: 0 };

function usageStats(res: AgentSpawnResult, durationMs: number, ok: boolean): StepStats {
	return {
		tokens: res.usage.input + res.usage.output,
		cost: res.usage.cost,
		durationMs,
		agents: 1,
		failures: ok ? 0 : 1,
	};
}

function addStats(a: StepStats, b: StepStats): StepStats {
	return {
		tokens: a.tokens + b.tokens,
		cost: a.cost + b.cost,
		durationMs: a.durationMs + b.durationMs,
		agents: a.agents + b.agents,
		failures: a.failures + b.failures,
	};
}

/** Sum a list of StepStats. `durationMs` is the wall-clock override (0 to keep the per-call sum). */
export function aggregateStats(stats: readonly StepStats[], durationMs: number): StepStats {
	let tokens = 0;
	let cost = 0;
	let agents = 0;
	let failures = 0;
	let dur = 0;
	for (const s of stats) {
		tokens += s.tokens;
		cost += s.cost;
		agents += s.agents;
		failures += s.failures;
		dur += s.durationMs;
	}
	return { tokens, cost, durationMs: durationMs > 0 ? durationMs : dur, agents, failures };
}

function withDuration(stats: StepStats, start: number): StepStats {
	return { ...stats, durationMs: Date.now() - start };
}

function stepResult(
	id: string,
	type: StepResult["type"],
	status: StepResult["status"],
	results: unknown,
	stats: StepStats,
	iterations?: number,
): StepResult {
	if (iterations !== undefined) return { id, type, status, results, stats, iterations };
	return { id, type, status, results, stats };
}

function notifyStart(exec: StepExecContext, callId: string): void {
	try {
		exec.listeners?.onAgentStart?.(callId);
	} catch {
		/* listener robustness — a throwing listener never blocks dispatch */
	}
}
function notifyEnd(exec: StepExecContext, callId: string, ok: boolean, stats: StepStats): void {
	try {
		exec.listeners?.onAgentEnd?.(callId, ok, stats);
	} catch {
		/* listener robustness */
	}
}
