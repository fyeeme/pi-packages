/**
 * src/fanout.ts — the provider contracts pi-review relies on, inlined.
 *
 * pi-review holds NO npm dependency and NO import on @fyeeme/pi-subagents:
 * the fan-out tool comes from whatever extension registers the bound name
 * (see config.ts `fanout.tool`, default `subagent`). Two provider contracts
 * remain, both documented protocols rather than imports:
 *
 *   Discovery protocol — pi-subagents' shared agent-dir registry
 *   (globalThis[Symbol.for("@fyeeme/pi-subagents/agent-dirs")], the same
 *   cross-module registry its own addAgentDir writes: pi loads every
 *   extension in a separate module graph, so the registry lives on a
 *   registered symbol). Writing it directly registers this package's
 *   agents/ dir with whichever provider copy owns the tool, regardless of
 *   load order. Unconsumed, it is inert.
 *
 *   Spawn env protocol — the recursion guard env block a spawner writes
 *   into its children (documented in pi-subagents' README, Security model).
 *   Implementations that write none of it are treated as depth 0; the
 *   recursion policy stays the provider's own responsibility.
 *
 * Tool NAMING is configuration, not discovery: `fanout.tool` binds the
 * registered name explicitly (default `subagent`); an unregistered binding
 * degrades fan-out to single-pass with a warning (see dispatch.ts).
 */
import * as path from "node:path";
import * as process from "node:process";

/** Registry key pi-subagents uses for its extra agent-dir discovery. Same
 *  string → same Symbol via Symbol.for, across module copies and packages. */
const AGENT_DIRS_SYMBOL = Symbol.for("@fyeeme/pi-subagents/agent-dirs");

/**
 * Register an extra agent-discovery directory in the shared registry, the
 * same one pi-subagents' `addAgentDir` writes (documented cross-module
 * contract, no import). Idempotent per resolved path; works whichever
 * module runs first — the registry is created eagerly here and pi-subagents'
 * lazy reader adopts an existing array. Pure side effect on globalThis.
 */
export function registerAgentsDir(dir: string): void {
	const store = globalThis as Record<symbol, unknown>;
	let dirs = store[AGENT_DIRS_SYMBOL] as string[] | undefined;
	if (!Array.isArray(dirs)) {
		dirs = [];
		store[AGENT_DIRS_SYMBOL] = dirs;
	}
	const resolved = path.resolve(dir);
	if (!dirs.includes(resolved)) dirs.push(resolved);
}

/** Spawn env protocol keys (written by the spawner into every child). */
interface SpawnEnv {
	PI_SUBAGENT_DEPTH?: string;
	PI_SUBAGENT_RECURSION_ALLOWED?: string;
	PI_SUBAGENT_MAX_SPAWN_DEPTH?: string;
}

function parsePositiveInt(v: string | undefined): number | undefined {
	if (v == null || !/^\d+$/.test(v.trim())) return undefined;
	const n = Number(v);
	return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/**
 * Whether fan-out is allowed for THIS process, per the spawn env protocol:
 * depth 0 (or unset) is the top level and always allowed; deeper processes
 * need the spawner's explicit opt-in, optionally capped. Envs absent (a
 * provider that doesn't write them) → treated as depth 0. Pure.
 */
export function recursionAllowed(env: SpawnEnv = process.env): boolean {
	const depth = parsePositiveInt(env.PI_SUBAGENT_DEPTH) ?? 0;
	if (depth === 0) return true;
	if (env.PI_SUBAGENT_RECURSION_ALLOWED !== "1") return false;
	const max = parsePositiveInt(env.PI_SUBAGENT_MAX_SPAWN_DEPTH);
	return max == null ? true : depth < max;
}
