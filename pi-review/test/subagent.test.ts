import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";

// Keep the real mapWithConcurrencyLimit/createSpawnRegistry; only mock spawnAgent.
const { spawnAgentMock } = vi.hoisted(() => ({ spawnAgentMock: vi.fn() }));
vi.mock("@fyeeme/pi-subagent-core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@fyeeme/pi-subagent-core")>();
	return { ...actual, spawnAgent: spawnAgentMock };
});

// Mock @earendil-works/pi-coding-agent: its dist pulls the @earendil-works/pi-ai/compat
// subpath, which is unbuildable in this checkout (packages/ai model data requires the
// models.dev network fetch that times out here). Same workaround review_report.test.ts
// uses. `defineTool` is a pass-through; truncateHead/formatSize are faithful stubs so
// the truncation + preview paths still behave for the existing tests.
vi.mock("@earendil-works/pi-coding-agent", () => ({
	defineTool: <T>(def: T): T => def,
	DEFAULT_MAX_BYTES: 51_200,
	DEFAULT_MAX_LINES: 2_000,
	formatSize: (bytes: number): string => `${(bytes / 1024).toFixed(1)}KB`,
	truncateHead: (
		text: string,
		{ maxBytes, maxLines }: { maxBytes: number; maxLines: number },
	) => {
		const lines = text.split("\n");
		const totalLines = lines.length;
		const totalBytes = Buffer.byteLength(text, "utf8");
		const truncated = totalLines > maxLines || totalBytes > maxBytes;
		if (!truncated)
			return { content: text, truncated: false, outputLines: totalLines, totalLines, outputBytes: totalBytes, totalBytes };
		const out: string[] = [];
		let bytes = 0;
		for (const ln of lines) {
			if (out.length >= maxLines) break;
			const add = (out.length ? 1 : 0) + Buffer.byteLength(ln, "utf8");
			if (bytes + add > maxBytes) break;
			out.push(ln);
			bytes += add;
		}
		const content = out.join("\n");
		return {
			content,
			truncated: true,
			outputLines: out.length,
			totalLines,
			outputBytes: Buffer.byteLength(content, "utf8"),
			totalBytes,
		};
	},
}));

import type { AgentSpawnResult } from "@fyeeme/pi-subagent-core";
import { subagentTool } from "../src/tools/subagent.ts";

function fakeResult(
	text: string,
	opts: {
		exitCode?: number;
		aborted?: boolean;
		maxTurnsReached?: boolean;
		errorMessage?: string;
		callId?: string;
	} = {},
): AgentSpawnResult {
	return {
		callId: opts.callId ?? "c",
		exitCode: opts.exitCode ?? 0,
		messages: [{ role: "assistant", content: text }] as unknown as AgentSpawnResult["messages"],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
		aborted: opts.aborted ?? false,
		maxTurnsReached: opts.maxTurnsReached ?? false,
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

	it("chain mode stops on a failed step and does not spawn downstream agents", async () => {
		spawnAgentMock
			.mockResolvedValueOnce(fakeResult("", { exitCode: 2 }))
			.mockResolvedValueOnce(fakeResult("should-not-run"));
		await expect(
			subagentTool.execute("t7", { mode: "chain", prompts: ["a", "b", "c"] }, undefined, undefined, fakeCtx),
		).rejects.toThrow(/agent #1 failed/);
		// Only the first step ran; the chain did not continue into b/c.
		expect(spawnAgentMock).toHaveBeenCalledTimes(1);
	});

	it("a maxTurns stop is reported as max-turns, not counted as aborted", async () => {
		spawnAgentMock.mockResolvedValue(
			fakeResult("partial work", { aborted: true, maxTurnsReached: true }),
		);
		const r = await subagentTool.execute("t8", { mode: "single", prompts: ["a"] }, undefined, undefined, fakeCtx);
		expect(r.details.results[0]?.maxTurnsReached).toBe(true);
		expect(r.details.stats.aborted).toBe(0);
		expect(r.content[0]).toMatchObject({ type: "text" });
		expect((r.content[0] as { text: string }).text).toContain("[max-turns]");
	});

	it("normal-size output is shown in full in the preview (not 200-char clipped)", async () => {
		const report = Array.from({ length: 50 }, (_, i) => `finding ${i}: some candidate with file:line and scenario`).join("\n");
		spawnAgentMock.mockResolvedValue(fakeResult(report, { callId: "t9#0" }));
		const r = await subagentTool.execute("t9", { mode: "single", prompts: ["a"] }, undefined, undefined, fakeCtx);
		const content = (r.content[0] as { text: string }).text;
		expect(content).toContain("finding 0");
		expect(content).toContain("finding 49"); // 完整内容可见,而非前 200 字符
		// 总是写入转录文件并附路径(借鉴 tintinweb/pi-subagents)
		const entry = r.details.results[0]!;
		expect(entry.transcriptFile).toBeTruthy();
		expect(content).toContain("完整转录:");
		expect(content).toContain(entry.transcriptFile!);
		expect(fs.readFileSync(entry.transcriptFile!, "utf-8")).toContain("finding 0");
	});

	it("oversized output is truncated with a readable temp-file path in the preview", async () => {
		const huge = "x".repeat(100_000);
		spawnAgentMock.mockResolvedValue(fakeResult(huge, { callId: "t10#0" }));
		const r = await subagentTool.execute("t10", { mode: "single", prompts: ["a"] }, undefined, undefined, fakeCtx);
		const entry = r.details.results[0]!;
		const content = (r.content[0] as { text: string }).text;
		expect(entry.transcriptFile).toBeTruthy();
		expect(content).toContain("输出截断:");
		expect(content).toContain(entry.transcriptFile!);
		// 完整转录确实落盘,模型可经 read 工具读取(含 --- assistant --- 分段)
		const transcript = fs.readFileSync(entry.transcriptFile!, "utf-8");
		expect(transcript).toContain(huge);
		expect(transcript).toContain("--- assistant ---");
	});

	// --- recursion-guard + cost-guard (harden-code-simplify) ---

	it("default maxTurns applies when omitted", async () => {
		spawnAgentMock.mockResolvedValue(fakeResult("ok"));
		await subagentTool.execute("tm", { mode: "single", prompts: ["a"] }, undefined, undefined, fakeCtx);
		const opts = spawnAgentMock.mock.calls[0]![1] as { maxTurns?: number };
		expect(opts.maxTurns).toBe(25);
	});

	it("explicit maxTurns overrides the default (0 honored, not unset)", async () => {
		spawnAgentMock.mockResolvedValue(fakeResult("ok"));
		await subagentTool.execute(
			"tz",
			{ mode: "single", prompts: ["a"], maxTurns: 0 },
			undefined,
			undefined,
			fakeCtx,
		);
		const opts = spawnAgentMock.mock.calls[0]![1] as { maxTurns?: number };
		expect(opts.maxTurns).toBe(0);
	});

	it("allowChildRecursion is false when the fan-out tool is not in the whitelist", async () => {
		spawnAgentMock.mockResolvedValue(fakeResult("ok"));
		await subagentTool.execute(
			"tr",
			{ mode: "single", prompts: ["a"], tools: ["read", "bash"] },
			undefined,
			undefined,
			fakeCtx,
		);
		const opts = spawnAgentMock.mock.calls[0]![1] as { allowChildRecursion?: boolean };
		expect(opts.allowChildRecursion).toBe(false);
	});

	it("allowChildRecursion is true when the fan-out tool is explicitly whitelisted", async () => {
		spawnAgentMock.mockResolvedValue(fakeResult("ok"));
		await subagentTool.execute(
			"tr2",
			{ mode: "single", prompts: ["a"], tools: ["read", "subagent"] },
			undefined,
			undefined,
			fakeCtx,
		);
		const opts = spawnAgentMock.mock.calls[0]![1] as { allowChildRecursion?: boolean };
		expect(opts.allowChildRecursion).toBe(true);
	});

	it("PI_MAX_CONCURRENT_SUBAGENTS caps concurrent in-flight agents", async () => {
		const prev = process.env.PI_MAX_CONCURRENT_SUBAGENTS;
		process.env.PI_MAX_CONCURRENT_SUBAGENTS = "2";
		try {
		// Each spawn resolves on the next microtask; track real concurrency.
		let inFlight = 0;
		let maxInFlight = 0;
		spawnAgentMock.mockImplementation(
			() =>
				new Promise((resolve) => {
					inFlight++;
					maxInFlight = Math.max(maxInFlight, inFlight);
					queueMicrotask(() => {
						inFlight--;
						resolve(fakeResult("ok"));
					});
				}),
		);
		await subagentTool.execute(
			"tc",
			{ mode: "parallel", prompts: ["a", "b", "c", "d", "e"] },
			undefined,
			undefined,
			fakeCtx,
		);
		expect(spawnAgentMock).toHaveBeenCalledTimes(5);
		expect(maxInFlight).toBeLessThanOrEqual(2); // the cap invariant
		expect(maxInFlight).toBe(2); // 5 prompts + cap 2 ⇒ parallelism actually used
		} finally {
			if (prev === undefined) delete process.env.PI_MAX_CONCURRENT_SUBAGENTS;
			else process.env.PI_MAX_CONCURRENT_SUBAGENTS = prev;
		}
	});
});
