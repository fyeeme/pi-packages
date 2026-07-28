/**
 * Shared helpers for the runner e2e scenarios.
 *
 * The runner's `dispatch` is injectable, so every scenario runs with a fake
 * dispatch — no `pi` binary, no provider API. The fake mimics spawnAgent's
 * registry contract (registers a per-call AbortController so skip/abort can
 * target one callId) and links the run signal to that controller, so abort
 * scenarios behave like the real spawn path.
 */
import type { Message } from "@earendil-works/pi-ai";
import type { AgentDispatch } from "../../src/runner/stage-executor.ts";
import type { AgentSpawnOptions, AgentSpawnResult } from "../../src/agent/dispatch.ts";

export interface FakeDispatchOptions {
	/** Produce the final assistant text for a call. Default: `out:<task>`. */
	readonly value?: (opts: AgentSpawnOptions) => string;
	/** callIds that block until their controller aborts (for abort/skip scenarios). */
	readonly hang?: ReadonlySet<string>;
	/** callIds that settle as an errored agent (stopReason "error") — for failure-path tests. */
	readonly errors?: ReadonlySet<string>;
	/** callIds that settle as aborted (stopReason "aborted") — for abort-path tests. */
	readonly aborts?: ReadonlySet<string>;
}

const defaultFakeValue = (opts: AgentSpawnOptions): string => `out:${opts.task}`;

/**
 * Build a fake dispatch function for tests. Registers the per-call controller
 * on the registry and links the run signal, so abort scenarios match the real
 * spawn behavior.
 */
export function makeFakeDispatch(opts: FakeDispatchOptions = {}): AgentDispatch {
	const valueFn = opts.value ?? defaultFakeValue;
	return async (registry, options) => {
		const controller = new AbortController();
		registry.controllers.set(options.callId, controller);

		if (options.signal) {
			if (options.signal.aborted) controller.abort();
			else options.signal.addEventListener("abort", () => controller.abort(), { once: true });
		}

		const callId = options.callId;
		const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 15, turns: 1 };

		// Hang calls block until aborted.
		if (opts.hang?.has(callId)) {
			await new Promise<void>((resolve) => {
				if (controller.signal.aborted) resolve();
				else controller.signal.addEventListener("abort", () => resolve(), { once: true });
			});
			registry.controllers.delete(callId);
			return {
				callId,
				exitCode: 0,
				messages: [],
				stderr: "",
				usage,
				aborted: true,
			} as AgentSpawnResult;
		}

		const aborted = controller.signal.aborted;
		const isError = opts.errors?.has(callId) ?? false;
		const isAbort = opts.aborts?.has(callId) ?? false;

		const text = valueFn(options);
		const msg = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text }],
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0 }, totalTokens: 15 },
			model: "fake",
			stopReason: isError ? "error" : isAbort ? "aborted" : "stop",
			errorMessage: isError ? "fake error" : undefined,
		};
		const stopReason = msg.stopReason;
		const errorMessage = msg.errorMessage;

		const result: AgentSpawnResult = {
			callId,
			exitCode: isError ? 1 : 0,
			messages: [msg as unknown as Message],
			stderr: "",
			usage,
			model: "fake",
			stopReason,
			errorMessage,
			aborted,
		};

		registry.controllers.delete(callId);
		return result;
	};
}

export function countingDispatch(
	dispatch: AgentDispatch,
): { dispatch: AgentDispatch; calls: () => number } {
	let called = 0;
	const wrapped: AgentDispatch = async (registry, opts) => {
		called++;
		return dispatch(registry, opts);
	};
	return { dispatch: wrapped, calls: () => called };
}
