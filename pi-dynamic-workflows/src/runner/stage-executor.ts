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
 * (maxDurationMs uses a live clock via Date.now() at the guard points — engine
 * code is not AST-guarded — so wall-clock duration is enforced; maxTokens is
 * enforced via BudgetPool.isExhausted on each spawn.)
 */
import {
	assertBatchSize,
	assertLifetimeAgents,
	BudgetExceededError,
	BudgetPool,
} from "../budget/index.ts";
import { computeCacheKey, type Journal } from "../cache/index.ts";
import { RETRYABLE_CATEGORIES, WorkflowError, type ErrorCategory } from "../errors.ts";
import { type AgentLifecycleListeners, notifyCacheHit, notifyLog, notifyUpdate } from "../lifecycle.ts";
import { parseFirstJson } from "../outcomes.ts";
import type {
	AdversarialStep,
	AgentCallSpec,
	AgentOpts,
	AgentStep,
	ClassifyRouteStep,
	CodeStep,
	LoopUntilDryStep,
	LogStep,
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
import { stepIdOf } from "../format.ts";

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
	/** Run inception time (ms), supplied deterministically by the caller — used
	 * for journal timestamps and as the child BudgetPool originMs. NOT used for
	 * budget duration checks (those read Date.now() at the guard points). */
	readonly now: number;
	/** Cumulative agents spawned so far this run (lifetime-cap counter). */
	spawned: number;
	/** Current classify_route nesting depth (cycle guard). */
	depth: number;
	/** A3: per-step budget-exhaustion policy. Set by runStepSequence from
	 *  step.onBudgetExhaust before each step (default "throw"). */
	budgetPolicy: "throw" | "null";
	/** A6: max resolved-prompt byte size; oversize throws a size-limit error. */
	maxPromptBytes: number;
	/** A3: step ids that degraded to null under the "null" policy this run. */
	degradedStepIds: Set<string>;
	/** Recursion opt-in propagated to every spawned workflow sub-agent: when
	 *  false (default) children load WITHOUT the subagent/fan-out tools.
	 *  Opt-in re-enables them, bounded by any maxSpawnDepth cap. */
	allowChildRecursion: boolean;
	/** Non-cached dispatch attempts this run (null-degraded and dispatch-throw
	 *  paths included) — the denominator for resume cache-hit accounting. */
	dispatched: number;
}

/** Outcome of a dispatched agent call (shared by all step kinds that call agents). */
interface AgentCallOutcome {
	readonly value: string | null;
	readonly ok: boolean;
	readonly aborted: boolean;
	readonly cached: boolean;
	readonly stats: StepStats;
	/** A5: error category of this call's failure. dispatch-error marks a
	 *  retryable agent failure (dispatch rejection OR a failed subprocess);
	 *  absent for aborts and successes. */
	readonly errorCategory?: ErrorCategory;
}

const MAX_ROUTE_DEPTH = 8;

/** Default per-prompt byte-size cap (A6). Overridable via RunWorkflowOptions. */
export const DEFAULT_MAX_PROMPT_BYTES = 256 * 1024;

/** Non-printable C0 controls + DEL, excluding the common whitespace (\t \n \r).
 *  Presence triggers a control-chars rejection (A6) — these almost always
 *  indicate corrupted/serialized binary data leaking into a prompt. */
// A6: reject prompts containing non-printable / format control characters before
// any spawn. Covers C0 (minus tab/LF/CR) + DEL + C1 (U+0080–U+009F) + zero-width
// and bidi format chars (U+200B–U+200F, U+202A–U+202E, U+2060–U+206F, U+FEFF) —
// the known prompt-injection vectors (bidi override, ZWJ/ZWNJ smuggling, BOM).
// The message below says "non-printable control characters" and the regex means
// it: previously only C0+DEL were blocked while bidi/zero-width sailed through.
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\u0080-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/;

/** Base workflow-subagent discipline prompt (B1+B2). Prepended to every agent
 *  dispatch's systemPrompt so the model knows it is a workflow subagent and
 *  returns the literal result without confirmations / fences / prose. Injected
 *  BEFORE cache-key computation (design D1) so it participates in the key. */
const BASE_WORKFLOW_SUBAGENT_PROMPT = [
	"You are a subagent spawned by a deterministic workflow orchestration script.",
	"Your final text response is returned verbatim as a string to the calling script \u2014 it is your return value, not a message to a human.",
	"- Output the literal result (data, JSON, or text). Do NOT output confirmations like \"Done.\" or \"Sent.\"",
	"- If asked for JSON, return ONLY the raw JSON \u2014 no code fences, no prose, no markdown.",
	"- Be concise. The script will parse your output.",
].join("\n");

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
		case "log":
			return execLog(step, ctx, exec);
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

	// D1: prepend the base workflow-subagent discipline prompt to the signature's
	// systemPrompt BEFORE computing the cache key, so it participates in the key
	// (injecting after the key would let runs under different base-prompt versions
	// collide). A step override appends after the base (spec B1+B2).
	const effectiveSignature: AgentOpts = signature.systemPrompt
		? { ...signature, systemPrompt: `${BASE_WORKFLOW_SUBAGENT_PROMPT}\n\n${signature.systemPrompt}` }
		: { ...signature, systemPrompt: BASE_WORKFLOW_SUBAGENT_PROMPT };

	const key = computeCacheKey({ workflowName: exec.workflowName, prompt, signature: effectiveSignature });

	const cached = exec.journal.lookup(key);
	if (cached?.type === "result" && cached.ok) {
		notifyCacheHit(exec.listeners, callId);
		return { value: cached.value as string, ok: true, aborted: false, cached: true, stats: zeroStats };
	}

	// A6: reject oversized / control-character payloads before any spawn. These
	// run AFTER the cache-hit return so a config change (e.g. lowering
	// maxPromptBytes between runs) cannot kill resume replay of a previously
	// cached call — a replay spawns nothing. The checks gate NEW spawns and
	// cover BOTH the task prompt and the effective systemPrompt (which always
	// contains the base discipline prompt), so oversized/binary data cannot
	// dodge the guard by being placed in the system prompt. These throw terminal
	// WorkflowErrors (size-limit / control-chars) which propagate past
	// runWithRetry's retry loop — only dispatch-error is retryable (A5:
	// runWithRetry gates on RETRYABLE_CATEGORIES, not bare status). A rejection
	// also aborts the step's in-flight siblings so a concurrent batch fails fast
	// instead of the allSettled wait blocking on a stalled sibling.
	assertPromptAllowed(exec, callId, prompt, effectiveSignature.systemPrompt);

const releaseSpawn = guardSpawn(exec, callId, 1);
	if (releaseSpawn === null) {
		// A3: budget exhausted under the "null" policy — degrade this call to null
		// (guardSpawn already attributed the step to degradedStepIds). No spawn,
		// no slot consumed, nothing journaled. Counted as a dispatch attempt so
		// resume's cachedTotal covers the degraded path.
		exec.dispatched++;
		return { value: null, ok: true, aborted: false, cached: false, stats: zeroStats };
	}
	// Every non-cached call that passes the guard is a dispatch attempt (the
	// dispatch-throw path increments here too — the start was announced even
	// though no agent launched, so the total must not undercount it).
	exec.dispatched++;
	notifyStart(exec, callId);
	await exec.journal.append({ type: "started", key, at: exec.now });
	let res: AgentSpawnResult;
	let durationMs: number;
	try {
		({ res, durationMs } = await timed(() =>
			exec.dispatch(exec.registry, dispatchOpts(callId, prompt, effectiveSignature, exec.signal, exec.listeners, exec.allowChildRecursion)),
		));
	} catch (e) {
		releaseSpawn(); // dispatch never started — return the reserved slot
		// dispatch rejected — write a terminal result so resume sees closure (not
		// an orphan `started`), per CC's "result always written" invariant. Returns
		// a failed outcome; runWithRetry treats status 'failed' as retryable.
		const msg = e instanceof Error ? e.message : String(e);
		await exec.journal.append({ type: "result", key, at: exec.now, ok: false, value: `dispatch error: ${msg}` });
		notifyEnd(exec, callId, false, zeroStats);
		// Fail-fast for concurrent batches: a dispatch error is a real failure —
		// terminate the step's in-flight siblings (SIGTERM via their per-call
		// controllers) so mapWithConcurrencyLimit's allSettled wait does not hang
		// forever on a stalled sibling subprocess.
		abortStepCalls(exec, stepIdOf(callId));
		return {
			value: `dispatch error: ${msg}`,
			ok: false,
			aborted: false,
			cached: false,
			stats: zeroStats,
			errorCategory: "dispatch-error",
		};
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
	notifyEnd(exec, callId, ok, stats, res.model, diag);
	// Fail-fast for concurrent batches: a settled-but-failed call (non-abort) is a
	// real failure — terminate the step's in-flight siblings so the batch's
	// allSettled wait cannot block forever on a stalled sibling subprocess. A
	// degraded (budget-null) or aborted call is NOT a failure and must not abort
	// its siblings.
	if (!ok && !res.aborted) abortStepCalls(exec, stepIdOf(callId));
	// A failed-but-settled subprocess (exitCode≠0 / stopReason "error" / killed)
	// is a retryable dispatch-error — typically a transient provider/model
	// failure. Aborts (external cancel, skip, maxTurns) carry no category: they
	// settle as skipped and must not auto-retry.
	return {
		value: diag,
		ok,
		aborted: res.aborted,
		cached: false,
		stats,
		errorCategory: ok || res.aborted ? undefined : "dispatch-error",
	};
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
	return stepResult(step.id, "agent", status, outcome.value, outcome.stats, undefined, outcome.errorCategory);
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

// log (C2): emit a narrative line via the onLog listener. Pure string, zero
// dispatch/tokens, not cached — same profile as `code` but fires onLog and the
// widget renders it as a distinct narrative line.
async function execLog(step: LogStep, ctx: StepContext, exec: StepExecContext): Promise<StepResult> {
	const start = Date.now();
	// A `log` step is non-critical narrative — a throwing message function (e.g.
	// referencing a missing upstream field) must NOT crash the whole run. Fall
	// back to an inline error marker and keep status "done" so the run continues.
	let message: string;
	try {
		message = typeof step.message === "function" ? await step.message(ctx) : step.message;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		message = `[log error: ${msg}]`;
	}
	notifyLog(exec.listeners, step.id, message);
	return stepResult(step.id, "log", "done", message, {
		tokens: 0,
		cost: 0,
		durationMs: Date.now() - start,
		agents: 0,
		failures: 0,
	});
}

// ---------------------------------------------------------------------------
// fan_out (parallel agents over a list)
// ---------------------------------------------------------------------------

async function execFanOut(step: FanOutStep, ctx: StepContext, exec: StepExecContext): Promise<StepResult> {
	const items = [...step.over(ctx)];
	const n = items.length;
	guardBatch(exec, n, `fan_out "${step.id}"`);

	const parallelism = step.parallelism ?? Math.min(n, 8);
	const itemSpecs = items.map((item, i) => step.agent(item, i, ctx));
	const start = Date.now();

	const outcomes = await mapWithConcurrencyLimit(itemSpecs, parallelism, (spec, i) =>
		dispatchAgentCall(`${step.id}#${i + 1}`, spec.prompt, spec, exec),
	);

	const durationMs = Date.now() - start;
	const merged = step.merge ? await step.merge(outcomes.map((o) => o.value), ctx) : outcomes.map((o) => o.value);
	const stats = aggregateStats(outcomes.map((o) => o.stats), durationMs);
	const status = outcomesStatus(outcomes);
	// A5: a batch whose failures are all retryable dispatch-errors carries the
	// category so runWithRetry can retry the whole fan_out (successful items
	// replay as cache hits and are not re-charged). Aborted-only batches settle
	// as skipped and carry none.
	const errorCategory = status === "failed" && outcomes.some((o) => o.errorCategory === "dispatch-error") ? "dispatch-error" : undefined;
	return stepResult(step.id, "fan_out", status, merged, stats, undefined, errorCategory);
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

/** Judge call opts inherit the produce opts (model/tools/systemPrompt) and are
 *  overridden per-field by an explicit `step.judge`. Without this, a step-level
 *  `model` applied only to the produce call and judges silently fell back to the
 *  default model (review m14). */
function judgeOpts(produce: AgentOpts, judge?: AgentOpts): AgentOpts {
	return {
		model: judge?.model ?? produce.model,
		tools: judge?.tools ?? produce.tools,
		systemPrompt: judge?.systemPrompt ?? produce.systemPrompt,
	};
}

async function execAdversarial(step: AdversarialStep, ctx: StepContext, exec: StepExecContext): Promise<StepResult> {
	const judgeCount = step.judges ?? 3;
	if (judgeCount < 1) throw new Error(`adversarial "${step.id}" requires judges >= 1`);
	const minPass = step.minPass ?? Math.ceil(judgeCount / 2);
	guardBatch(exec, 1 + judgeCount, `adversarial "${step.id}"`);
	const start = Date.now();
	let stats = zeroStats;

	const producePrompt = await resolvePrompt(step.produce, ctx);
	const candidate = await dispatchAgentCall(`${step.id}#produce`, producePrompt, step.produce, exec);
	stats = addStats(stats, candidate.stats);

	// A3: a degraded produce (budget exhausted under the "null" policy) returns
	// value null — the step degrades to a null result per the README contract,
	// NOT a fabricated "done" with an empty candidate. No judges are dispatched:
	// the budget is exhausted, they would only degrade too.
	if (candidate.value === null) {
		return stepResult(step.id, "adversarial", "done", null, withDuration(stats, start), 1);
	}

	const outcomes: AgentCallOutcome[] = [candidate];
	const judges: { pass: boolean; reason: string }[] = [];
	if (candidate.ok) {
		const judgeSpecs = Array.from({ length: judgeCount }, (_, i) => judgePrompt(i, candidate.value ?? "", step.rubric));
		const judgeOutcomes = await mapWithConcurrencyLimit(judgeSpecs, Math.min(judgeCount, 8), (prompt, i) =>
			dispatchAgentCall(`${step.id}#judge${i + 1}`, prompt, judgeOpts(step.produce, step.judge), exec),
		);
		for (const o of judgeOutcomes) {
			stats = addStats(stats, o.stats);
			outcomes.push(o);
			const parsed = parseFirstJson(o.value ?? "") as { pass?: unknown; reason?: unknown } | undefined;
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
		{ candidate: candidate.value ?? "", passed: passCount >= minPass, passCount, minPass, judges },
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
		return o.value ?? "";
	});

	const judgeSpecs = Array.from({ length: step.judges }, (_, j) => rankPrompt(j, candidates));
	const judgeOutcomes = await mapWithConcurrencyLimit(judgeSpecs, Math.min(step.judges, 8), (prompt, j) =>
		dispatchAgentCall(`${step.id}#judge${j + 1}`, prompt, judgeOpts(step.produce, step.judge), exec),
	);
	const judgePicks = judgeOutcomes.map((o) => {
		stats = addStats(stats, o.stats);
		outcomes.push(o);
		const parsed = parseFirstJson(o.value ?? "") as { winner?: unknown; reason?: unknown } | undefined;
		return { winner: parseWinnerNum(parsed?.winner), reason: parseReason(parsed?.reason) };
	});
	const winner = tallyWinner(
		judgePicks.map((j) => j.winner),
		step.candidates,
	);

	// A5: like fan_out, a tournament whose failures are retryable dispatch-errors
	// carries the category so runWithRetry can retry the whole composite.
	const status = outcomesStatus(outcomes);
	const errorCategory = status === "failed" && outcomes.some((o) => o.errorCategory === "dispatch-error") ? "dispatch-error" : undefined;

	return stepResult(
		step.id,
		"tournament",
		status,
		{ candidates, winner, judges: judgePicks },
		withDuration(stats, start),
		step.candidates + step.judges,
		errorCategory,
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
			undefined,
			classify.aborted ? undefined : "dispatch-error",
		);
	}

	// A3: a degraded classifier (budget exhausted under the "null" policy)
	// returns value null — the step degrades to a null result per the README
	// contract; do not fabricate a route run from an empty category.
	if (classify.value === null) {
		return stepResult(step.id, "classify_route", "done", null, withDuration(classify.stats, start));
	}

	const parsed = parseFirstJson(classify.value ?? "") as { category?: unknown } | undefined;
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
		undefined,
		sub.errorCategory,
	);
}

// ---------------------------------------------------------------------------
// sub_workflow (nested child workflow — CC's workflow() pattern)
// ---------------------------------------------------------------------------

async function execSubWorkflow(step: SubWorkflowStep, ctx: StepContext, exec: StepExecContext): Promise<StepResult> {
	const start = Date.now();
	// Resolve the child's input: static value or function of parent ctx. The
	// function form is awaited (and typed to allow a Promise), matching the
	// async convention of CodeStep.transform / LogStep.message — an un-awaited
	// Promise would leak into the child's ctx.input as "[object Promise]" with
	// its rejection silently dropped.
	const childInput = typeof step.input === "function"
		? await (step.input as (c: StepContext) => unknown | Promise<unknown>)(ctx)
		: step.input ?? ctx.input;

	// Child shares parent's journal, pool, registry, and signal by default.
	// inheritBudget: false means the child uses its own BudgetPool (isolated caps).
	// Override workflowName with the CHILD's name so cache keys are scoped to the
	// child workflow — otherwise two sibling sub_workflows whose agents share a
	// prompt+signature collide on the parent's name and replay each other's cache.
	const childExec: StepExecContext = step.inheritBudget === false
		? { ...exec, workflowName: step.workflow.name, depth: exec.depth + 1, pool: new BudgetPool(step.workflow.budget ?? {}, Date.now()) }
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
		undefined,
		sub.errorCategory,
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
		const parsed = parseFirstJson(outcome.value ?? "") as unknown;
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
						const criticParsed = parseFirstJson(criticOutcome.value ?? "") as unknown;
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
	/** A5: category of the terminal error that failed the sequence (from a
	 *  thrown WorkflowError), surfaced on RunResult.errorCategory. */
	readonly errorCategory?: ErrorCategory;
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
		// A3: apply the step's budget-exhaustion policy for the duration of this step.
		exec.budgetPolicy = step.onBudgetExhaust ?? "throw";
		let sr: StepResult;
		try {
			sr = await runWithRetry(step, ctx, exec);
		} catch (e) {
			const wfe = e instanceof WorkflowError ? e : undefined;
			return {
				steps: out,
				status: "failed",
				error: e instanceof Error ? e.message : String(e),
				errorCategory: wfe?.category,
			};
		}
		prior.set(step.id, { results: sr.results, stats: sr.stats });
		out.push(sr);
		// Post-step signal check: a run aborted mid-step (e.g. a fan_out whose
		// items all aborted) must never report "completed".
		if (exec.signal?.aborted) return { steps: out, status: "aborted", error: "aborted by signal" };
		if (sr.status === "failed") {
			const why = typeof sr.results === "string" && sr.results ? `: ${sr.results}` : "";
			return { steps: out, status: "failed", error: `step "${step.id}" failed${why}`, errorCategory: sr.errorCategory };
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
	// A5: retry is gated by error category, not by bare status. Only retryable
	// categories (dispatch-error / unexpected-state) auto-retry — a code
	// transform failure or a terminal category (size-limit, determinism, …) must
	// not burn budget on a deterministic re-run.
	while (sr.status === "failed" && attempt < max && sr.errorCategory !== undefined && RETRYABLE_CATEGORIES.includes(sr.errorCategory)) {
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
	// The base workflow-subagent systemPrompt already carries the verbatim / raw-JSON
	// discipline, so this task prompt states only the task + the JSON schema it wants.
	return `You are judge ${index + 1}. Evaluate this candidate:\n\n${candidate}\n\nAgainst these criteria:\n${criteria}\n\nReturn JSON matching: {"pass": true|false, "reason": "..."}`;
}

function rankPrompt(index: number, candidates: readonly string[]): string {
	const listing = candidates.map((c, i) => `[${i}] ${c}`).join("\n\n");
	// Base systemPrompt carries the verbatim / raw-JSON discipline; task prompt
	// states only the ranking task + the JSON schema it wants.
	return `You are judge ${index + 1}. Rank these candidates:\n\n${listing}\n\nReturn JSON matching: {"winner": <index>, "reason": "..."}`;
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

/** Terminate every in-flight call belonging to `stepId` (via its per-call
 *  controller → SIGTERM in spawnAgent). Called from dispatchAgentCall on any
 *  failure of that call (settle failure, dispatch throw, A6 rejection): the
 *  hung siblings are killed so the batch's allSettled wait settles instead of
 *  blocking the run forever on a stalled subprocess. Aborting a healthy
 *  in-flight item is fine — the step is already failing, its results are
 *  discarded. A degraded (budget-null) or aborted call is NOT a failure and
 *  never triggers this. */
function abortStepCalls(exec: StepExecContext, stepId: string): void {
	for (const [callId, controller] of exec.registry.controllers) {
		if (stepIdOf(callId) === stepId) controller.abort();
	}
}

/** A6: reject oversized / control-character payloads before any spawn. On
 *  rejection the step's in-flight siblings are aborted first (fail-fast for
 *  concurrent batches), then a terminal WorkflowError is thrown. */
function assertPromptAllowed(exec: StepExecContext, callId: string, prompt: string, systemPrompt: string | undefined): void {
	const promptBytes = Buffer.byteLength(prompt, "utf8");
	if (promptBytes > exec.maxPromptBytes) {
		abortStepCalls(exec, stepIdOf(callId));
		throw new WorkflowError(
			`prompt size ${promptBytes} bytes exceeds limit ${exec.maxPromptBytes} bytes`,
			{ category: "size-limit", detail: { bytes: promptBytes, limit: exec.maxPromptBytes } },
		);
	}
	if (CONTROL_CHARS.test(prompt)) {
		abortStepCalls(exec, stepIdOf(callId));
		throw new WorkflowError("prompt contains non-printable control characters", { category: "control-chars" });
	}
	if (systemPrompt) {
		const sysBytes = Buffer.byteLength(systemPrompt, "utf8");
		if (sysBytes > exec.maxPromptBytes) {
			abortStepCalls(exec, stepIdOf(callId));
			throw new WorkflowError(
				`systemPrompt size ${sysBytes} bytes exceeds limit ${exec.maxPromptBytes} bytes`,
				{ category: "size-limit", detail: { bytes: sysBytes, limit: exec.maxPromptBytes } },
			);
		}
		if (CONTROL_CHARS.test(systemPrompt)) {
			abortStepCalls(exec, stepIdOf(callId));
			throw new WorkflowError("systemPrompt contains non-printable control characters", { category: "control-chars" });
		}
	}
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
	// Under the "null" policy (A3), skip the canSpawn pre-check: per-item
	// guardSpawn degrades excess items to null instead. The hard MAX_BATCH cap
	// above still throws regardless of policy.
	if (exec.budgetPolicy !== "null" && !exec.pool.canSpawn(total, Date.now())) {
		throw new BudgetExceededError(`${label} needs ${total} agents but the budget is exhausted`);
	}
}

/** Reserve one agent slot and check token budget. Returns a release handle —
 *  call it ONLY if the dispatch never started (spawn threw).
 *
 *  Under the "null" budget policy (A3), returns `null` instead of throwing
 *  when the budget is exhausted: the caller degrades that call to a null
 *  outcome. This is the single atomic chokepoint (sync section, no await gap),
 *  so concurrent fan_out workers each see an accurate count — closing the
 *  TOCTOU that a pre-check before reserve would reintroduce.
 *
 *  Lifetime accounting: `exec.spawned` is incremented SYNCHRONOUSLY here ... */
function guardSpawn(exec: StepExecContext, callId: string, n: number): (() => void) | null {
	exec.spawned += n;
	assertLifetimeAgents(exec.spawned);
	// isExhausted enforces maxTokens (and maxAgents) before committing.
	if (exec.pool.isExhausted(Date.now())) {
		exec.spawned -= n;
		if (exec.budgetPolicy === "null") {
			exec.degradedStepIds.add(stepIdOf(callId));
			return null;
		}
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
	listeners?: AgentLifecycleListeners,
	allowChildRecursion = false,
): AgentSpawnOptions {
	return {
		callId,
		task: prompt,
		model: spec.model,
		tools: spec.tools ? [...spec.tools] : undefined,
		systemPrompt: spec.systemPrompt,
		signal,
		allowChildRecursion,
		// C3: bridge the spawn's streamed deltas to the lifecycle onUpdate listener,
		// attributed to this callId. When no listener is registered, the subprocess
		// drops the deltas (its onUpdate stays undefined — same as before).
		onUpdate: listeners?.onUpdate ? (delta) => notifyUpdate(listeners, callId, delta) : undefined,
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
	errorCategory?: ErrorCategory,
): StepResult {
	const base: StepResult = { id, type, status, results, stats };
	if (iterations !== undefined) return { ...base, iterations, errorCategory };
	if (errorCategory !== undefined) return { ...base, errorCategory };
	return base;
}

function notifyStart(exec: StepExecContext, callId: string): void {
	try {
		exec.listeners?.onAgentStart?.(callId);
	} catch {
		/* listener robustness — a throwing listener never blocks dispatch */
	}
}
function notifyEnd(exec: StepExecContext, callId: string, ok: boolean, stats: StepStats, model?: string, output?: string): void {
	try {
		exec.listeners?.onAgentEnd?.(callId, ok, stats, model, output);
	} catch {
		/* listener robustness */
	}
}
