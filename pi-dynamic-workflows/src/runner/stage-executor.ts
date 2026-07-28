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
	type BudgetPool,
} from "../budget/index.ts";
import { computeCacheKey, type Journal } from "../cache/index.ts";
import type { AgentLifecycleListeners } from "../lifecycle.ts";
import { parseFirstJson } from "../outcomes.ts";
import type {
	AdversarialStep,
	AgentCallSpec,
	AgentOpts,
	AgentStep,
	ClassifyRouteStep,
	CodeStep,
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
	await exec.journal.append({ type: "result", key, at: exec.now, ok, value });
	notifyEnd(exec, callId, ok, stats);
	return { value, ok, aborted: res.aborted, cached: false, stats };
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
	} catch {
		return stepResult(step.id, "code", "failed", undefined, {
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
		if (sr.status === "failed") return { steps: out, status: "failed", error: `step "${step.id}" failed` };
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
	return v === true || v === 1 || v === "true" || v === "True" || v === "1";
}
function parseWinnerNum(v: unknown): number | undefined {
	const n = typeof v === "number" ? v : Number(v);
	return Number.isFinite(n) ? n : undefined;
}
function parseCategoryStr(v: unknown): string {
	return typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
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
 *  call it ONLY if the dispatch never started (spawn threw). */
function guardSpawn(exec: StepExecContext, n: number): () => void {
	assertLifetimeAgents(exec.spawned);
	// isExhausted enforces maxTokens (and maxAgents) before committing.
	if (exec.pool.isExhausted(exec.now)) {
		throw new BudgetExceededError("agent spawn refused — budget exhausted");
	}
	return exec.pool.reserve(n);
}

function applyOutcome(exec: StepExecContext, res: AgentSpawnResult): void {
	exec.spawned++;
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
