/**
 * sessions/spawn.ts — public per-agent abort/skip API (README §7).
 *
 * Thin barrel over src/agent/dispatch.ts: the spawn registry + per-agent
 * abort primitives. The core spawn implementation lives in
 * `@fyeeme/pi-subagent-core`; skip/retry (workflows-specific) stay in
 * dispatch.ts.
 */
export {
	abortAgent,
	createSpawnRegistry,
	retryAgent,
	skipAgent,
	type AgentSpawnRegistry,
} from "../src/agent/dispatch.ts";
