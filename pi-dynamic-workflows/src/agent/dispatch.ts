/**
 * src/agent/dispatch.ts — agent dispatch底层 (Task 2)
 *
 * The core spawn primitive (`spawnAgent`, `mapWithConcurrencyLimit`,
 * `createSpawnRegistry`, `abortAgent`, `getPiInvocation` + the registry/
 * options/result types) lives in the shared `@fyeeme/pi-subagent-core`
 * package — extracted from the duplicate copies that used to live here and
 * in pi-review. This module keeps the workflows-specific layer on top:
 * `skipAgent`/`retryAgent` (with `AbortReason` semantics) and the lifecycle
 * notifications.
 *
 * Core semantics: one `pi --mode json -p --no-session` subprocess per agent
 * call, stdout parsed for {message_end, tool_result_end} events,
 * AbortSignal → SIGTERM with a 5s SIGKILL escalation. Each call owns a
 * per-call AbortController registered in an AgentAbortMap, paired with
 * Map<callId, ChildProcess>. A single callId can be aborted (retry/skip)
 * without disturbing its batch siblings, because abort is translated to a
 * SIGTERM on exactly one process.
 */
import type { AgentLifecycleListeners } from "../lifecycle.ts";
import { notifyRetry, notifySkip } from "../lifecycle.ts";
import type { AgentSpawnRegistry } from "@fyeeme/pi-subagent-core";

// Re-export the core dispatch surface so existing importers of this module
// (`../agent/dispatch.ts`) keep working unchanged.
export {
	abortAgent,
	createSpawnRegistry,
	getPiInvocation,
	mapWithConcurrencyLimit,
	spawnAgent,
} from "@fyeeme/pi-subagent-core";
export type {
	AgentAbortMap,
	AgentCallId,
	AgentSpawnOptions,
	AgentSpawnRegistry,
	AgentSpawnResult,
	AgentUsage,
} from "@fyeeme/pi-subagent-core";

export type AbortReason = "user-skip" | "user-retry";

/**
 * Abort one call as skipped. The call settles skipped (runner will not
 * re-dispatch it); batch siblings are untouched. Fires `onAgentSkip`.
 */
export function skipAgent(
	registry: AgentSpawnRegistry,
	callId: string,
	listeners?: AgentLifecycleListeners,
): boolean {
	const controller = registry.controllers.get(callId);
	if (!controller) return false;
	controller.abort("user-skip");
	notifySkip(listeners, callId);
	return true;
}

/**
 * Abort one call so the runner can re-dispatch it. Only this callId is
 * aborted; batch siblings keep running. Fires `onAgentRetry`. The actual
 * re-dispatch is the runner's job (it sees the call settle aborted and
 * decides whether to spawn again).
 */
export function retryAgent(
	registry: AgentSpawnRegistry,
	callId: string,
	listeners?: AgentLifecycleListeners,
): boolean {
	const controller = registry.controllers.get(callId);
	if (!controller) return false;
	controller.abort("user-retry");
	notifyRetry(listeners, callId);
	return true;
}
