/**
 * Runner — the engine that wires the five CC-fusion modules into an executable
 * workflow (Task 7).
 *
 * A workflow is a flat list of typed steps (types.ts discriminated union).
 * runWorkflow prepares the run (deterministic runId, journal load for resume,
 * budget pool, spawn registry) and delegates the step walk to runStepSequence.
 * Per agent call the sequence consults the cache/journal (resume without
 * re-dispatch), enforces the budget/caps, and routes abort/skip through the
 * per-call registry. classify_route reuses runStepSequence for its sub-steps.
 *
 * `dispatch` is injectable (default = real spawnAgent) so the run is fully
 * exercisable in tests with a fake dispatch — no `pi` binary, no provider API.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { BudgetPool } from "../budget/index.ts";
import { Journal, type RunManifest } from "../cache/index.ts";
import type { AgentLifecycleListeners } from "../lifecycle.ts";
import { generateRunId } from "../state/index.ts";
import type { Budget, RunResult, WorkflowDefinition } from "../types.ts";
import {
	createSpawnRegistry,
	spawnAgent,
	type AgentSpawnRegistry,
} from "../agent/dispatch.ts";
import { runStepSequence, aggregateStats, DEFAULT_MAX_PROMPT_BYTES, type AgentDispatch, type StepExecContext } from "./stage-executor.ts";

export { type AgentDispatch } from "./stage-executor.ts";

/** Reject workflow names containing path traversal segments — journalDir is
 *  derived from the name and must stay within the workflow directory tree. */
function sanitizeWorkflowName(name: string): string {
	// The name becomes a path segment under <cwd>/.pi/workflows/<name>, so it must
	// be a single segment (no separators) and not "." / ".." — otherwise it escapes
	// the per-workflow dir (e.g. name ".." writes the journal into <cwd>/.pi).
	if (name === "." || name === ".." || /[\\/]/.test(name) || /[<>:"|?*\x00-\x1f]/.test(name)) {
		throw new Error(`workflow name contains invalid characters: ${JSON.stringify(name)}`);
	}
	return name;
}

export interface RunWorkflowOptions {
	readonly workflow: WorkflowDefinition;
	/** Initial input exposed as ctx.input to the first step. */
	readonly input?: unknown;
	/** Base directory for the journal (journalDir defaults under here). */
	readonly cwd: string;
	/** Deterministic run inception time (ms) — passed to generateRunId + BudgetPool. Required. */
	readonly now: number;
	/** Sequence disambiguator for same-timestamp runs. Default 0. */
	readonly sequence?: number;
	/** Overrides workflow.budget if set. */
	readonly budget?: Budget;
	/** Run-wide abort signal; aborts every in-flight agent. */
	readonly signal?: AbortSignal;
	readonly listeners?: AgentLifecycleListeners;
	/** Injectable agent dispatch (default = real spawnAgent). */
	readonly dispatch?: AgentDispatch;
	/** Reuse an existing registry (e.g. to drive skip/retry from outside). */
	readonly registry?: AgentSpawnRegistry;
	/** Recursion opt-in for workflow sub-agents: when true, spawned agents may
	 *  register the subagent/fan-out tools (bounded by PI_SUBAGENT_MAX_SPAWN_DEPTH
	 *  if set). Default false — children run WITHOUT those tools, so nested
	 *  fan-out requires explicit opt-in. */
	readonly allowChildRecursion?: boolean;
	/** Journal directory. Default <cwd>/.pi/workflows/<workflow.name> (per-workflow → cross-run cache). */
	readonly journalDir?: string;
	/** A6: max resolved-prompt byte size; oversize throws a size-limit error.
	 *  Default DEFAULT_MAX_PROMPT_BYTES (256 KB). */
	readonly maxPromptBytes?: number;
	/** A6: policy gate invoked before the first dispatch. Return { allow: false,
	 *  reason } to deny the run with a policy-gate error. */
	readonly policyGate?: (workflow: WorkflowDefinition) => { readonly allow: boolean; readonly reason?: string } | Promise<{ readonly allow: boolean; readonly reason?: string }>;
}

export async function runWorkflow(opts: RunWorkflowOptions): Promise<RunResult> {
	const { workflow, cwd, now } = opts;
	const registry = opts.registry ?? createSpawnRegistry();
	const dispatch = opts.dispatch ?? spawnAgent;
	const budget = opts.budget ?? workflow.budget ?? {};
	const journalDir =
		opts.journalDir ??
		path.join(cwd, ".pi", "workflows", sanitizeWorkflowName(workflow.name));

	await fs.promises.mkdir(journalDir, { recursive: true });
	const journal = new Journal({ dir: journalDir });
	await journal.load();

	// Staged resume: load last run's manifest (best-effort; crash-resilient).
	// Real cache-hit accounting is OBSERVED during the run via the counting
	// listeners below — not predicted from the manifest, which would replay the
	// prior journal against itself and always read 100% (review M4).
	const prevManifest = await journal.loadManifest();
	let cacheHits = 0;
	let dispatchStarts = 0;
	const baseListeners = opts.listeners;
	const listeners: AgentLifecycleListeners = {
		onAgentStart: (id) => {
			dispatchStarts++;
			baseListeners?.onAgentStart?.(id);
		},
		onAgentEnd: baseListeners?.onAgentEnd,
		onAgentSkip: baseListeners?.onAgentSkip,
		onAgentRetry: baseListeners?.onAgentRetry,
		onAgentCacheHit: (id) => {
			cacheHits++;
			baseListeners?.onAgentCacheHit?.(id);
		},
		onLog: baseListeners?.onLog,
		onUpdate: baseListeners?.onUpdate,
	};

	// maxDurationMs is wall-clock: the pool's originMs must be the same clock
	// the guard points use (Date.now()), NOT the caller-supplied deterministic
	// `now` — mixing epochs (e.g. runWorkflow({ now: 1 }) + maxDurationMs) would
	// make the duration budget read as already-exhausted at the first guard.
	// `now` still drives runId / journal timestamps / exec.now (deterministic).
	const pool = new BudgetPool(budget, Date.now());

	const runId = generateRunId({ timestamp: now, sequence: opts.sequence ?? 0 });

	const exec: StepExecContext = {
		workflowName: workflow.name,
		dispatch,
		registry,
		journal,
		pool,
		signal: opts.signal,
		listeners,
		now,
		spawned: 0,
		depth: 0,
		budgetPolicy: "throw",
		maxPromptBytes: opts.maxPromptBytes ?? DEFAULT_MAX_PROMPT_BYTES,
		degradedStepIds: new Set(),
		allowChildRecursion: opts.allowChildRecursion ?? false,
		dispatched: 0,
	};

	// A6: policy gate runs before any agent is dispatched. A denial aborts the
	// run with a terminal policy-gate error (not retryable).
	if (opts.policyGate) {
		const decision = await opts.policyGate(workflow);
		if (!decision.allow) {
			return {
				runId,
				status: "failed",
				steps: [],
				stats: { tokens: 0, cost: 0, durationMs: 0, agents: 0, failures: 0 },
				journalFile: journal.file,
				error: decision.reason ?? "denied by policy gate",
				errorCategory: "policy-gate",
			};
		}
	}

	const outcome = await runStepSequence(workflow.steps, opts.input, exec);

	const writeErr = journal.writeError;
	const journalWarning: string | undefined = writeErr
		? `journal write error (entries may be missing from disk; resume could re-dispatch): ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`
		: undefined;

	// Write staged-resume manifest when the run completes (even partially).
	// Only `runId` is consumed downstream (resume.previousRunId); the key list
	// is dead weight now that cache-hit accounting is observed live.
	if (!writeErr) {
		const manifest: RunManifest = { runId, at: now };
		await journal.writeManifest(manifest).catch(() => { /* best-effort */ });
	}

	return {
		runId,
		status: outcome.status,
		steps: outcome.steps,
		stats: aggregateStats(outcome.steps.map((s) => s.stats), 0),
		journalFile: journal.file,
		error: outcome.error ?? journalWarning,
		errorCategory: outcome.errorCategory,
		degradedSteps: exec.degradedStepIds.size > 0 ? [...exec.degradedStepIds] : undefined,
		resume: {
			cachedHits: cacheHits,
			cachedTotal: cacheHits + exec.dispatched,
			...(prevManifest ? { previousRunId: prevManifest.runId } : {}),
		},
	};
}
