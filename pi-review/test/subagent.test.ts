import { beforeEach, describe, expect, it, vi } from "vitest";

// Keep the real mapWithConcurrencyLimit/createSpawnRegistry; only mock spawnAgent.
const { spawnAgentMock } = vi.hoisted(() => ({ spawnAgentMock: vi.fn() }));
vi.mock("../src/agent/dispatch.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/agent/dispatch.ts")>();
	return { ...actual, spawnAgent: spawnAgentMock };
});

import type { AgentSpawnResult } from "../src/agent/dispatch.ts";
import { subagentTool } from "../src/tools/subagent.ts";

function fakeResult(
	text: string,
	opts: { exitCode?: number; aborted?: boolean; errorMessage?: string; callId?: string } = {},
): AgentSpawnResult {
	return {
		callId: opts.callId ?? "c",
		exitCode: opts.exitCode ?? 0,
		messages: [{ role: "assistant", content: text }] as unknown as AgentSpawnResult["messages"],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
		aborted: opts.aborted ?? false,
		errorMessage: opts.errorMessage,
	};
}

// execute only reads ctx.cwd; a partial cast is enough.
const fakeCtx = { cwd: "/tmp" } as Parameters<typeof subagentTool.execute>[4];

describe("subagent tool", () => {
	beforeEach(() => {
		spawnAgentMock.mockReset();
	});

	it("single mode runs one prompt and returns its text", async () => {
		spawnAgentMock.mockResolvedValue(fakeResult("done", { callId: "t1#0" }));
		const r = await subagentTool.execute("t1", { mode: "single", prompts: ["review"] }, undefined, undefined, fakeCtx);
		expect(spawnAgentMock).toHaveBeenCalledTimes(1);
		expect(r.details.results).toHaveLength(1);
		expect(r.details.results[0]?.text).toBe("done");
	});

	it("parallel mode runs all prompts and preserves order", async () => {
		spawnAgentMock.mockImplementation(async (_reg: unknown, opts: { callId: string }) =>
			fakeResult(`out-${opts.callId}`, { callId: opts.callId }),
		);
		const r = await subagentTool.execute("t2", { mode: "parallel", prompts: ["a", "b", "c"] }, undefined, undefined, fakeCtx);
		expect(spawnAgentMock).toHaveBeenCalledTimes(3);
		expect(r.details.results.map((x) => x.text)).toEqual(["out-t2#0", "out-t2#1", "out-t2#2"]);
	});

	it("chain mode feeds prior output into the next call's systemPrompt", async () => {
		spawnAgentMock.mockImplementation(async (_reg: unknown, opts: { task: string }) => fakeResult(opts.task.toUpperCase()));
		await subagentTool.execute("t3", { mode: "chain", prompts: ["foo", "bar"] }, undefined, undefined, fakeCtx);
		const secondOpts = spawnAgentMock.mock.calls[1]![1] as { systemPrompt?: string };
		expect(secondOpts.systemPrompt).toContain("FOO");
	});

	it("throws when an agent fails (non-zero exit, not aborted)", async () => {
		spawnAgentMock.mockResolvedValue(fakeResult("", { exitCode: 2 }));
		await expect(
			subagentTool.execute("t4", { mode: "single", prompts: ["x"] }, undefined, undefined, fakeCtx),
		).rejects.toThrow(/agent #1 failed/);
	});

	it("rejects mode:single with more than one prompt", async () => {
		await expect(
			subagentTool.execute("t6", { mode: "single", prompts: ["a", "b"] }, undefined, undefined, fakeCtx),
		).rejects.toThrow(/single.*one prompt/);
	});

	it("calls onUpdate once per completed agent", async () => {
		spawnAgentMock.mockResolvedValue(fakeResult("ok"));
		const onUpdate = vi.fn();
		await subagentTool.execute("t5", { mode: "parallel", prompts: ["a", "b"] }, undefined, onUpdate, fakeCtx);
		expect(onUpdate).toHaveBeenCalledTimes(2);
	});
});
