/**
 * subagent-tool.test.ts — wire-level behavior of the `subagent` tool:
 * parameter validation, shared-context prepending, and result shapes that
 * need no real subprocess (dispatch's node:child_process.spawn is mocked).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { subagentTool } from "../src/tools/subagent.ts";

const spawnImpl = vi.fn((_command: string, _args: string[], _opts: unknown) => fakeProc());
const spawnMock = vi.mocked(spawnImpl);
vi.mock("node:child_process", () => ({
	spawn: (...args: Parameters<typeof spawnImpl>) => spawnImpl(...args),
}));

function fakeCtx(): Record<string, unknown> {
	return {
		hasUI: false,
		mode: "headless",
		cwd: "/tmp",
		ui: {},
	};
}

/** Minimal fake ChildProcess closing immediately so spawnAgent resolves. */
function fakeProc(): ChildProcess {
	const stdout = new EventEmitter();
	const stderr = new EventEmitter();
	const bus = new EventEmitter();
	// Structurally identical shape; the ChildProcess interface cannot be
	// constructed directly, hence the single named cast.
	const proc = Object.assign(bus, {
		stdout,
		stderr,
		exitCode: null as number | null,
		signalCode: null as string | null,
		kill: vi.fn(),
	}) as unknown as ChildProcess;
	queueMicrotask(() => {
		stdout.emit("end");
		stdout.emit("close");
		bus.emit("close", 0);
	});
	return proc;
}


/** Fake ChildProcess that streams one final assistant message (oversized
 *  outputs drive the artifact-path truncation marker) before closing. */
function procWithFinalText(text: string): ChildProcess {
	const stdout = new EventEmitter();
	const stderr = new EventEmitter();
	const bus = new EventEmitter();
	const proc = Object.assign(bus, {
		stdout,
		stderr,
		exitCode: null as number | null,
		signalCode: null as string | null,
		kill: vi.fn(),
	}) as unknown as ChildProcess;
	const line = JSON.stringify({ type: "message_end", message: { role: "assistant", content: text } });
	queueMicrotask(() => {
		stdout.emit("data", Buffer.from(line + String.fromCharCode(10)));
		stdout.emit("end");
		stdout.emit("close");
		bus.emit("close", 0);
	});
	return proc;
}

beforeEach(() => {
	spawnMock.mockReset();
	spawnMock.mockImplementation(() => fakeProc());
});

describe("subagent tool parameter validation", () => {
	it("rejects maxTurns: 0 with a range message", async () => {
		const result = await subagentTool.execute!(
			"call-1",
			{ agent: "scout", task: "t", maxTurns: 0 } as never,
			new AbortController().signal,
			undefined,
			fakeCtx() as never,
		);
		const text = result.content[0];
		expect(text.type === "text" && text.text).toContain("Invalid maxTurns: 0");
	});

	it("rejects negative and non-integer maxTurns", async () => {
		for (const bad of [-3, 2.5]) {
			const result = await subagentTool.execute!(
				"call-1",
				{ agent: "scout", task: "t", maxTurns: bad } as never,
				new AbortController().signal,
				undefined,
				fakeCtx() as never,
			);
			const text = result.content[0];
			expect(text.type === "text" && text.text).toContain(`Invalid maxTurns: ${bad}`);
		}
	});
});

describe("shared context parameter", () => {
	it("prepends context to every task in parallel mode", async () => {
		await subagentTool.execute!(
			"call-1",
			{
				context: "SHARED-BACKGROUND",
				tasks: [
					{ agent: "scout", task: "first-task" },
					{ agent: "scout", task: "second-task" },
				],
			} as never,
			new AbortController().signal,
			undefined,
			fakeCtx() as never,
		);
		expect(spawnMock).toHaveBeenCalledTimes(2);
		const argvs = spawnMock.mock.calls.map(([, args]) => JSON.stringify(args));
		const first = argvs.find((a) => a.includes("first-task"));
		const second = argvs.find((a) => a.includes("second-task"));
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		for (const argvJson of [first, second]) {
			const parsed: string[] = JSON.parse(argvJson!);
			const prompt = parsed.join(" ");
			expect(prompt.indexOf("SHARED-BACKGROUND")).toBeGreaterThanOrEqual(0);
		}
	});
});
describe("parallel output truncation and artifacts", () => {
	it("a truncated output points at the full-output artifact; details carry outputPath", async () => {
		spawnMock.mockImplementation(() => procWithFinalText("Y".repeat(60 * 1024)));
		const result = await subagentTool.execute!(
			"call-1",
			{ tasks: [{ agent: "scout", task: "big-task" }] } as never,
			new AbortController().signal,
			undefined,
			fakeCtx() as never,
		);
		const text = result.content[0];
		expect(text.type === "text" && text.text).toContain("Output truncated:");
		expect(text.type === "text" && text.text).toContain("Full output: ");
		expect(text.type === "text" && /pi-subagents\//.test(text.text)).toBe(true);
		const details = result.details as { results: Array<{ outputPath?: string }> };
		expect(details.results[0]?.outputPath).toBeTruthy();
	});

	it("an under-cap output passes through without a truncation marker", async () => {
		spawnMock.mockImplementation(() => procWithFinalText("short and sweet"));
		const result = await subagentTool.execute!(
			"call-1",
			{ tasks: [{ agent: "scout", task: "small-task" }] } as never,
			new AbortController().signal,
			undefined,
			fakeCtx() as never,
		);
		const text = result.content[0];
		expect(text.type === "text" && text.text.includes("short and sweet")).toBe(true);
		expect(text.type === "text" && text.text.includes("Output truncated")).toBe(false);
	});
});

describe("result contract", () => {
	it("the <result> block is delivered and details record the extraction method", async () => {
		const body = "narration first\n<result>CONTRACT-ANSWER</result>";
		spawnMock.mockImplementation(() => procWithFinalText(body));
		// The contract prompt must ride --append-system-prompt.
		const result = await subagentTool.execute!(
			"call-1",
			{ tasks: [{ agent: "scout", task: "contract-task" }] } as never,
			new AbortController().signal,
			undefined,
			fakeCtx() as never,
		);
		const text = result.content[0];
		expect(text.type === "text" && text.text.includes("CONTRACT-ANSWER")).toBe(true);
		expect(text.type === "text" && text.text.includes("narration first")).toBe(false);
		expect(text.type === "text" && /extracted:/.test(text.text)).toBe(false); // silent on contract hit
		const details = result.details as { results: Array<{ extractMethod?: string }> };
		expect(details.results[0]?.extractMethod).toBe("result-block");
	});

	it("every spawn's appended system prompt carries the result-contract instruction", async () => {
		// The system prompt rides a temp file passed to --append-system-prompt,
		// unlinked again in spawnAgent's finally — so capture its content AT
		// spawn time from inside the mocked spawn.
		const { readFileSync } = await import("node:fs");
		const captured: string[] = [];
		spawnMock.mockImplementationOnce(((_command: string, args: string[]) => {
			const idx = args.indexOf("--append-system-prompt");
			if (idx >= 0 && args[idx + 1]) captured.push(readFileSync(args[idx + 1], "utf-8"));
			return fakeProc();
		}) as never);
		await subagentTool.execute!(
			"call-1",
			{ agent: "scout", task: "single-task" } as never,
			new AbortController().signal,
			undefined,
			fakeCtx() as never,
		);
		expect(captured.length).toBe(1);
		expect(captured[0]).toContain("<result>");
	});
});
