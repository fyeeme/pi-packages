/**
 * src/library.ts — named workflow library: the persistence layer for
 * workflows (PR3 of the sandwich refactor).
 *
 * Workflows are single-file `.ts` definitions (full step set including the
 * TS-only steps like loop_until) discovered from:
 *
 *   1. project — nearest `.pi/workflows/lib/` walking up from cwd
 *   2. bundled — this package's own `workflows/` directory (seed workflows)
 *
 * The project entry overrides a bundled entry of the same name. Discovery and
 * loading go through the existing loader (jiti + the ast determinism guard),
 * so a library workflow is rejected before execution when its source
 * smuggles in non-deterministic APIs — the precondition cache-key resume
 * relies on.
 *
 * The library directory is deliberately distinct from the journal output
 * tree (`.pi/workflows/runs/<runId>/`): definitions and run state never
 * collide. Adding a workflow = dropping a file; no code change.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadWorkflowModule } from "./loader.ts";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { WorkflowDefinition } from "./types.ts";

/** This file lives at <pkg>/src/ → the bundled library is <pkg>/workflows. */
const PKG_ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const BUNDLED_LIB_DIR = path.join(PKG_ROOT, "workflows");

/** Project-level library directory, relative to the project root. */
const PROJECT_LIB_REL = path.join(CONFIG_DIR_NAME, "workflows", "lib");

/** One library entry, after loading the module. */
export interface LibraryEntry {
	readonly name: string;
	readonly description?: string;
	readonly filePath: string;
	readonly workflow: WorkflowDefinition;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/** Nearest project library dir walking up from cwd (like agent discovery). */
export function findProjectLibDir(cwd: string): string | null {
	let dir = path.resolve(cwd);
	for (;;) {
		const candidate = path.join(dir, PROJECT_LIB_REL);
		if (isDirectory(candidate)) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/** Library directories in priority order (later wins on name collision). */
function libDirs(cwd: string): string[] {
	const dirs = [BUNDLED_LIB_DIR];
	const project = findProjectLibDir(cwd);
	if (project) dirs.push(project);
	return dirs;
}

function isValidWorkflow(value: unknown): value is WorkflowDefinition {
	return (
		!!value &&
		typeof value === "object" &&
		typeof (value as WorkflowDefinition).name === "string" &&
		Array.isArray((value as WorkflowDefinition).steps)
	);
}

/** Load one workflow file: ast-guard + jiti import + shape validation. */
async function loadEntry(filePath: string): Promise<LibraryEntry | null> {
	try {
		const mod = (await loadWorkflowModule({ filePath })) as {
			workflow?: unknown;
			default?: unknown;
		};
		const wf = mod.workflow ?? mod.default;
		if (!isValidWorkflow(wf)) return null;
		return {
			name: wf.name,
			description: wf.description,
			filePath,
			workflow: wf,
		};
	} catch (err) {
		// Fail-fast, deliberately: a library file that fails the determinism
		// guard or errors at import must NOT silently disappear from the
		// available list (a poisoned entry re-appearing would break cache-key
		// resume). The error names the offending file; remove or fix the file
		// to restore discovery. Shape-invalid files (below) are the exception
		// — they are skipped silently as non-workflows.
		throw new Error(`library workflow ${path.basename(filePath)} failed to load: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/**
 * Discover the library: load every `.ts` workflow in the library dirs and
 * index by workflow name (later dirs override earlier same-name entries).
 * A file whose module import or the determinism guard check FAILS aborts the
 * whole discovery with an error naming the file (fail-fast — see loadEntry);
 * a file that imports cleanly but is not a valid workflow shape is skipped
 * silently.
 */
export async function discoverWorkflowLibrary(cwd: string): Promise<Map<string, LibraryEntry>> {
	const byName = new Map<string, LibraryEntry>();
	for (const dir of libDirs(cwd)) {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue; // unreadable/missing dir — skip
		}
		for (const entry of entries) {
			if (!entry.name.endsWith(".ts") || entry.name.startsWith(".")) continue;
			if (!entry.isFile() && !entry.isSymbolicLink()) continue;
			const loaded = await loadEntry(path.join(dir, entry.name));
			if (loaded) byName.set(loaded.name, loaded);
		}
	}
	return byName;
}

/** Resolve one workflow by name, or null when not in the library. */
export async function loadLibraryWorkflow(
	name: string,
	cwd: string,
): Promise<LibraryEntry | null> {
	// Fast path: only load the files that could define the name. Files export
	// the workflow's name, so discovery is required either way — but skipping
	// the project/bundled distinction keeps override semantics identical.
	const lib = await discoverWorkflowLibrary(cwd);
	return lib.get(name) ?? null;
}
