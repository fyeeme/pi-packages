/**
 * src/agent/dispatch.ts — agent dispatch底层 (Task 2)
 *
 * The core spawn primitive (`spawnAgent`, `mapWithConcurrencyLimit`,
 * `createSpawnRegistry`, `abortAgent`, `getPiInvocation` + the registry/
 * options/result types) lives in the shared `@fyeeme/pi-subagents`
 * package — extracted from the duplicate copies that used to live here and
 * in pi-review. This module keeps the workflows-specific layer on top:
 * `skipAgent`/`retryAgent` (with user-skip/user-retry reasons) and the lifecycle
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
import type { AgentSpawnRegistry } from "@fyeeme/pi-subagents";

// Re-export the core dispatch surface so existing importers of this module
// (`../agent/dispatch.ts`) keep working unchanged.
export {
	abortAgent,
	createSpawnRegistry,
	mapWithConcurrencyLimit,
	spawnAgent,
} from "@fyeeme/pi-subagents";
export type {
	AgentSpawnOptions,
	AgentSpawnRegistry,
	AgentSpawnResult,
} from "@fyeeme/pi-subagents";

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

/** Retry intents keyed by registry: callIds aborted via retryAgent that the
 *  runner should re-dispatch once they settle. WeakKeyed so intents never
 *  outlive their run. */
const userRetryFlags = new WeakMap<AgentSpawnRegistry, Set<string>>();

/** Consume (delete-and-report) a pending retry intent for one call. The
 *  runner calls this when an aborted call settles; exactly one re-dispatch
 *  happens per intent. */
export function consumeUserRetry(registry: AgentSpawnRegistry, callId: string): boolean {
	const set = userRetryFlags.get(registry);
	if (!set) return false;
	const had = set.delete(callId);
	if (had && set.size === 0) userRetryFlags.delete(registry);
	return had;
}

/**
 * Abort one call so the runner re-dispatches it. Only this callId is
 * aborted; batch siblings keep running. Fires `onAgentRetry`. The runner
 * sees the intent when the call settles aborted and spawns one fresh
 * attempt under a `~retry`-suffixed id (same step attribution; the retried
 * attempt's journal result overwrites the aborted one — same cache key,
 * last-wins).
 */
export function retryAgent(
	registry: AgentSpawnRegistry,
	callId: string,
	listeners?: AgentLifecycleListeners,
): boolean {
	const controller = registry.controllers.get(callId);
	if (!controller) return false;
	let flags = userRetryFlags.get(registry);
	if (!flags) {
		flags = new Set();
		userRetryFlags.set(registry, flags);
	}
	flags.add(callId);
	controller.abort("user-retry");
	notifyRetry(listeners, callId);
	return true;
}
