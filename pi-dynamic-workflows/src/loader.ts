/**
 * Workflow-file loader — the bridge from the deterministic sandbox (Task 3) to
 * runtime execution: read a `.ts` workflow file, reject it via the ast-guard if
 * it smuggles in non-deterministic APIs (Date.now / Math.random / new Date()),
 * then load it as a module via jiti (the same loader pi uses for extensions).
 *
 * Guarding BEFORE jiti-import is what makes cache-key resume (Task 4) sound: a
 * workflow body that read "now" would change its cache key every run, so resume
 * could never hit. Rejecting such source at load time makes determinism
 * enforceable rather than hoped-for. jiti loads a real module (not a vm-sandboxed
 * string), so the guard runs on the raw source text first.
 *
 * Scope limit: the guard scans ONLY the entry file's source. A helper module
 * imported by the workflow that calls Date.now()/Math.random() is not caught
 * here, and would silently destabilize cache keys. For full determinism keep
 * workflows single-file, or guard imported helpers separately. (Walking jiti's
 * transitive imports pre-load is not exposed by the loader API.)
 */
import * as fs from "node:fs";
import { createJiti } from "jiti/static";
import { assertDeterministic } from "./determinism/ast-guard.ts";

export interface LoadWorkflowOptions {
	/** Absolute (or baseUrl-relative) path to the `.ts` workflow file. */
	readonly filePath: string;
	/** jiti base URL; defaults to this module so relative imports resolve from here. */
	readonly baseUrl?: string;
}

/**
 * Read `filePath`, reject it if non-deterministic, then load it via jiti.
 * Returns the module namespace — callers extract the workflow export
 * (e.g. `mod.workflow` or `mod.default`, a WorkflowDefinition).
 */
export async function loadWorkflowModule<T = unknown>(opts: LoadWorkflowOptions): Promise<T> {
	const source = await fs.promises.readFile(opts.filePath, "utf-8");
	assertDeterministic(source, opts.filePath);
	const jiti = createJiti(opts.baseUrl ?? import.meta.url, { moduleCache: false });
	return (await jiti.import(opts.filePath)) as T;
}
