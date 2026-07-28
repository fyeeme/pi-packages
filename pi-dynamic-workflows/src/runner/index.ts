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
import { runStepSequence, aggregateStats, type AgentDispatch, type StepExecContext } from "./stage-executor.ts";

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
	/** Journal directory. Default <cwd>/.pi/workflows/<workflow.name> (per-workflow → cross-run cache). */
	readonly journalDir?: string;
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

	// Staged resume: load last run's manifest to predict cache hits.
	const prevManifest = await journal.loadManifest();
	const stagedInfo = prevManifest ? journal.stagedHits(prevManifest) : null;

	const pool = new BudgetPool(budget, now);

	const exec: StepExecContext = {
		workflowName: workflow.name,
		dispatch,
		registry,
		journal,
		pool,
		signal: opts.signal,
		listeners: opts.listeners,
		now,
		spawned: 0,
		depth: 0,
	};

	const outcome = await runStepSequence(workflow.steps, opts.input, exec);

	const writeErr = journal.writeError;
	const journalWarning: string | undefined = writeErr
		? `journal write error (entries may be missing from disk; resume could re-dispatch): ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`
		: undefined;

	const runId = generateRunId({ timestamp: now, sequence: opts.sequence ?? 0 });

	// Write staged-resume manifest when the run completes (even partially —
	// the manifest records whatever agent keys made it to the journal).
	if (!writeErr) {
		const allKeys: string[] = [];
		for (const entry of journal.allEntries()) {
			// Only successful results are cache-hits on resume (failed keys are
			// re-dispatched); including them inflated cachedTotal and understated
			// the real hit ratio.
			if (entry.type === "result" && entry.ok) allKeys.push(entry.key);
		}
		const manifest: RunManifest = { runId, at: now, keys: allKeys };
		await journal.writeManifest(manifest).catch(() => { /* best-effort */ });
	}

	return {
		runId,
		status: outcome.status,
		steps: outcome.steps,
		stats: aggregateStats(outcome.steps.map((s) => s.stats), 0),
		journalFile: journal.file,
		error: outcome.error ?? journalWarning,
		resume: stagedInfo
			? { cachedHits: stagedInfo.hits, cachedTotal: stagedInfo.total, previousRunId: prevManifest?.runId }
			: undefined,
	};
}
