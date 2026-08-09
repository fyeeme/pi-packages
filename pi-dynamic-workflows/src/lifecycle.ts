/**
 * Agent-level lifecycle events (Task 5 surface).
 *
 * Minimal: the four agent events. `retryAgent`/`skipAgent` fire onAgentRetry/
 * onAgentSkip. onAgentStart/onAgentEnd are reserved for the spawn path to wire
 * later — onAgentEnd takes a boolean `ok` rather than the full AgentSpawnResult
 * so this module has no `src/agent/dispatch` import (avoids a circular type
 * dependency: dispatch imports lifecycle for the listener type).
 *
 * Workflow/stage-level events (onWorkflowStart/onStageStart/...) join here
 * when the runner module lands. Mirrors CC's LifecycleListeners shape: a
 * per-call optional bundle; a throwing listener is caught and warned, never
 * blocks the abort/retry path.
 */

import type { StepStats } from "./types.ts";

export interface AgentLifecycleListeners {
	onAgentStart?(callId: string): void;
	/** `stats` carries per-call tokens/cost/duration so progress UIs can show spend live. */
	onAgentEnd?(callId: string, ok: boolean, stats?: StepStats, model?: string, output?: string): void;
	onAgentSkip?(callId: string): void;
	onAgentRetry?(callId: string): void;
	/** Fired when an agent call hits the journal cache (zero-dispatch resume). */
	onAgentCacheHit?(callId: string): void;
	/** Fired when a `log` step runs, with the step id and resolved message. */
	onLog?(stepId: string, message: string): void;
	/** Fired on each streamed `message_update` partial for an in-flight agent call. */
	onUpdate?(callId: string, partial: string): void;
}

export function notifySkip(listeners: AgentLifecycleListeners | undefined, callId: string): void {
	try {
		listeners?.onAgentSkip?.(callId);
	} catch (e) {
		warn("onAgentSkip", e);
	}
}

export function notifyRetry(listeners: AgentLifecycleListeners | undefined, callId: string): void {
	try {
		listeners?.onAgentRetry?.(callId);
	} catch (e) {
		warn("onAgentRetry", e);
	}
}

export function notifyCacheHit(listeners: AgentLifecycleListeners | undefined, callId: string): void {
	try {
		listeners?.onAgentCacheHit?.(callId);
	} catch (e) {
		warn("onAgentCacheHit", e);
	}
}

export function notifyLog(listeners: AgentLifecycleListeners | undefined, stepId: string, message: string): void {
	try {
		listeners?.onLog?.(stepId, message);
	} catch (e) {
		warn("onLog", e);
	}
}

export function notifyUpdate(listeners: AgentLifecycleListeners | undefined, callId: string, partial: string): void {
	try {
		listeners?.onUpdate?.(callId, partial);
	} catch (e) {
		warn("onUpdate", e);
	}
}

function warn(event: string, e: unknown): void {
	const msg = e instanceof Error ? e.message : String(e);
	console.warn(`[pi-dynamic-workflows] lifecycle ${event} listener threw: ${msg}`);
}
