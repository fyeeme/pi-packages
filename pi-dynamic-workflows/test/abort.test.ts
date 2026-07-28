import { describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import {
	abortAgent,
	createSpawnRegistry,
	retryAgent,
	skipAgent,
	type AgentSpawnRegistry,
} from "../src/agent/dispatch.ts";

type KillFn = ReturnType<typeof vi.fn>;

function fakeRegistry(
	callIds: string[],
): { registry: AgentSpawnRegistry; kills: Map<string, KillFn> } {
	const processes = new Map<AgentCallId, ChildProcess>();
	const kills = new Map<string, KillFn>();
	for (const id of callIds) {
		const killFn: KillFn = vi.fn();
		kills.set(id, killFn);
		processes.set(id, { kill: killFn } as unknown as ChildProcess);
	}
	const controllers = new Map<AgentCallId, AbortController>();
	for (const id of callIds) controllers.set(id, new AbortController());
	return {
		registry: { processes, controllers } as unknown as AgentSpawnRegistry,
		kills,
	};
}

describe("abortAgent", () => {
	it("should abort the controller for an in-flight call", () => {
		const { registry } = fakeRegistry(["call1", "call2"]);
		const controller = registry.controllers.get("call1")!;
		expect(controller.signal.aborted).toBe(false);
		abortAgent(registry, "call1");
		expect(controller.signal.aborted).toBe(true);
	});

	it("should return true if callId existed", () => {
		const { registry } = fakeRegistry(["call1"]);
		expect(abortAgent(registry, "call1")).toBe(true);
	});

	it("should return false if callId does not exist", () => {
		const { registry } = fakeRegistry([]);
		expect(abortAgent(registry, "nonexistent")).toBe(false);
	});

	it("should not affect sibling controllers", () => {
		const { registry } = fakeRegistry(["call1", "call2"]);
		abortAgent(registry, "call1");
		expect(registry.controllers.get("call2")!.signal.aborted).toBe(false);
	});
});

describe("skipAgent", () => {
	it("should abort the controller and fire onAgentSkip listener", () => {
		const { registry } = fakeRegistry(["x"]);
		const onSkip = vi.fn();
		skipAgent(registry, "x", { onAgentSkip: onSkip });
		expect(registry.controllers.get("x")!.signal.aborted).toBe(true);
		expect(onSkip).toHaveBeenCalledWith("x");
	});

	it("should return false for unknown callId", () => {
		const { registry } = fakeRegistry([]);
		expect(skipAgent(registry, "ghost")).toBe(false);
	});
});

describe("retryAgent", () => {
	it("should abort the controller and fire onAgentRetry listener", () => {
		const { registry } = fakeRegistry(["y"]);
		const onRetry = vi.fn();
		retryAgent(registry, "y", { onAgentRetry: onRetry });
		expect(registry.controllers.get("y")!.signal.aborted).toBe(true);
		expect(onRetry).toHaveBeenCalledWith("y");
	});

	it("should return false for unknown callId", () => {
		const { registry } = fakeRegistry([]);
		expect(retryAgent(registry, "ghost")).toBe(false);
	});
});

/** Satisfy the type import of AgentCallId used in fakeRegistry. */
import type { AgentCallId } from "../src/types.ts";
