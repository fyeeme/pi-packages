/**
 * monitor.test.ts — unit tests for the live-state monitor plus an integration
 * test proving spawnAgent feeds it (the UI layer's data source).
 *
 * The spawnAgent integration mocks node:child_process the same way
 * dispatch.test.ts does: a fake ChildProcess whose stdout emits fabricated
 * NDJSON events, so the full processLine hook path runs without a real pi
 * subprocess.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

// Mock `spawn` before index.ts imports it.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { createSpawnRegistry, spawnAgent } from "../src/dispatch.ts";
import { AgentMonitor, isBoilerplateLine } from "../src/monitor.ts";
import type { AgentCallState } from "../src/monitor.ts";
import {
	clearModelCatalog,
	contextUtilizationPercent,
	formatSessionTokens,
	formatTokens,
	formatTurns,
	setModelCatalog,
} from "../src/ui/shared.ts";
import type { Theme } from "../src/ui/shared.ts";

/** Fake theme: colorless passthrough (tests strip ANSI assertions via length). */
const fakeTheme: Theme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

/** Emit a data event on the fake proc's stdout. */
function emitStdout(proc: ChildProcess, chunk: string | Buffer): void {
	proc.stdout!.emit("data", chunk);
}

/** Minimal fake ChildProcess: stdout/stderr as EventEmitters + kill spy. */
function fakeProc(): ChildProcess {
	const stdout = new EventEmitter();
	const stderr = new EventEmitter();
	const bus = new EventEmitter();
	return Object.assign(bus, {
		stdout,
		stderr,
		exitCode: null as number | null,
		signalCode: null as string | null,
		kill: vi.fn(),
	}) as unknown as ChildProcess;
}

function makeAssistantMessage(overrides: Record<string, unknown> = {}) {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		usage: { input: 1000, output: 2000, cacheRead: 0, cacheWrite: 500, totalTokens: 3500, cost: {} },
		model: "some-model",
		stopReason: "stop",
		...overrides,
	};
}

describe("AgentMonitor (unit)", () => {
	let monitor: AgentMonitor;

	beforeEach(() => {
		monitor = new AgentMonitor();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("registers a call with derived description and defaults", () => {
		const controller = new AbortController();
		const messages: never[] = [];
		monitor.callStarted({ callId: "a1", task: "Line one\nLine two", controller, messages });
		const state = monitor.get("a1");
		expect(state).toBeDefined();
		expect(state?.displayName).toBe("Agent");
		expect(state?.description).toBe("Line one");
		expect(state?.status).toBe("running");
		expect(state?.messages).toBe(messages);
	});

	it("skips repo-context boilerplate when deriving the description", () => {
		monitor.callStarted({
			callId: "a2",
			task: "Repo cwd: /some/repo (Spring Boot microservices, Java 17). Repo信息\nRefactor the auth module",
			controller: new AbortController(),
			messages: [],
		});
		expect(monitor.get("a2")?.description).toBe("Refactor the auth module");
	});

	it("falls back to the first line when the whole task is boilerplate", () => {
		monitor.callStarted({
			callId: "a3",
			task: "Repo cwd: /some/repo. Repo信息",
			controller: new AbortController(),
			messages: [],
		});
		expect(monitor.get("a3")?.description).toBe("Repo cwd: /some/repo. Repo信息");
	});

	it("isBoilerplateLine recognizes repo-context lines (case-insensitive)", () => {
		expect(isBoilerplateLine("Repo cwd: /x (Spring Boot). Repo信息")).toBe(true);
		expect(isBoilerplateLine("repo信息: 微服务")).toBe(true);
		expect(isBoilerplateLine("repo: /x")).toBe(true);
		expect(isBoilerplateLine("  Repo cwd: /x  ")).toBe(true); // trimmed
		expect(isBoilerplateLine("Refactor the auth module")).toBe(false);
		expect(isBoilerplateLine("")).toBe(false);
	});

	it("messageEnd folds assistant usage into turns/tokens", () => {
		const messages: never[] = [];
		monitor.callStarted({ callId: "a1", task: "t", controller: new AbortController(), messages });
		monitor.messageEnd("a1", makeAssistantMessage() as never);
		monitor.messageEnd(
			"a1",
			makeAssistantMessage({
				usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: {} },
			}) as never,
		);
		const state = monitor.get("a1");
		expect(state?.turns).toBe(2);
		expect(state?.lifetimeTokens).toBe(1000 + 2000 + 500 + 10 + 20);
		expect(state?.contextTokens).toBe(30);
		expect(state?.model).toBe("some-model");
	});

	it("ignores non-assistant and garbage messageEnd input", () => {
		monitor.callStarted({ callId: "a1", task: "t", controller: new AbortController(), messages: [] as never[] });
		monitor.messageEnd("a1", { role: "user", content: "hi" } as never);
		monitor.messageEnd("a1", undefined as never);
		monitor.messageEnd("missing", makeAssistantMessage() as never);
		expect(monitor.get("a1")?.turns).toBe(0);
	});

	it("toolStart/toolEnd maintain activeTools and toolUses", () => {
		monitor.callStarted({ callId: "a1", task: "t", controller: new AbortController(), messages: [] as never[] });
		monitor.toolStart("a1", "t1", "read");
		monitor.toolStart("a1", "t2", "edit");
		expect(monitor.get("a1")?.activeTools.size).toBe(2);
		monitor.toolEnd("a1", "t1", "read");
		const state = monitor.get("a1");
		expect(state?.activeTools.size).toBe(1);
		expect(state?.activeTools.get("t2")).toBe("edit");
		expect(state?.toolUses).toBe(1);
		// toolEnd without a matching start still counts the completed use.
		monitor.toolEnd("a1", "", "bash");
		expect(monitor.get("a1")?.toolUses).toBe(2);
	});

	it("compacted increments the annotation counter", () => {
		monitor.callStarted({ callId: "a1", task: "t", controller: new AbortController(), messages: [] as never[] });
		monitor.compacted("a1");
		monitor.compacted("a1");
		expect(monitor.get("a1")?.compactions).toBe(2);
	});

	it("textDelta keeps a bounded rolling tail", () => {
		monitor.callStarted({ callId: "a1", task: "t", controller: new AbortController(), messages: [] as never[] });
		monitor.textDelta("a1", "x".repeat(200));
		monitor.textDelta("a1", "y".repeat(200));
		expect(monitor.get("a1")?.responseTail.length).toBeLessThanOrEqual(240);
		expect(monitor.get("a1")?.responseTail.endsWith("y")).toBe(true);
	});

	it("callEnded classifies completed / error / aborted / max-turns", () => {
		monitor.callStarted({ callId: "ok", task: "t", controller: new AbortController(), messages: [] as never[] });
		monitor.callEnded("ok", { exitCode: 0, aborted: false, maxTurnsReached: false });
		expect(monitor.get("ok")?.status).toBe("completed");

		monitor.callStarted({ callId: "err", task: "t", controller: new AbortController(), messages: [] as never[] });
		monitor.callEnded("err", { exitCode: 1, aborted: false, maxTurnsReached: false, errorMessage: "boom" });
		expect(monitor.get("err")?.status).toBe("error");
		expect(monitor.get("err")?.errorMessage).toBe("boom");

		monitor.callStarted({ callId: "ab", task: "t", controller: new AbortController(), messages: [] as never[] });
		monitor.callEnded("ab", { exitCode: 1, aborted: true, maxTurnsReached: false });
		expect(monitor.get("ab")?.status).toBe("aborted");

		monitor.callStarted({ callId: "mt", task: "t", controller: new AbortController(), messages: [] as never[] });
		monitor.callEnded("mt", { exitCode: 1, aborted: true, maxTurnsReached: true });
		const mt = monitor.get("mt");
		expect(mt?.status).toBe("aborted");
		expect(mt?.maxTurnsReached).toBe(true);
	});

	it("abort fires the registered controller while running only", () => {
		const controller = new AbortController();
		const onAbort = vi.fn();
		controller.signal.addEventListener("abort", onAbort);
		monitor.callStarted({ callId: "a1", task: "t", controller, messages: [] as never[] });
		expect(monitor.abort("a1")).toBe(true);
		expect(onAbort).toHaveBeenCalledTimes(1);
		monitor.callEnded("a1", { exitCode: 1, aborted: true, maxTurnsReached: false });
		expect(monitor.abort("a1")).toBe(false);
		expect(monitor.abort("missing")).toBe(false);
	});

	it("list() evicts finished calls after the retention window", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		monitor.callStarted({ callId: "a1", task: "t", controller: new AbortController(), messages: [] as never[] });
		monitor.callEnded("a1", { exitCode: 0, aborted: false, maxTurnsReached: false });
		expect(monitor.list().length).toBe(1);
		vi.setSystemTime(new Date("2026-01-01T00:02:00Z"));
		expect(monitor.list().length).toBe(0);
	});

	it("list() caps retained finished entries", () => {
		for (let i = 0; i < 25; i++) {
			monitor.callStarted({ callId: `c${i}`, task: "t", controller: new AbortController(), messages: [] as never[] });
			monitor.callEnded(`c${i}`, { exitCode: 0, aborted: false, maxTurnsReached: false });
		}
		expect(monitor.list().length).toBeLessThanOrEqual(20);
	});

	it("subscribe isolates listener errors and unsubscribes cleanly", () => {
		const good = vi.fn();
		const bad = vi.fn(() => {
			throw new Error("bad listener");
		});
		const unsub = monitor.subscribe(bad);
		monitor.subscribe(good);
		monitor.callStarted({ callId: "a1", task: "t", controller: new AbortController(), messages: [] as never[] });
		expect(good).toHaveBeenCalled();
		expect(bad).toHaveBeenCalled();
		unsub();
		monitor.clear();
		expect(good.mock.calls.length).toBe(2); // callStarted + clear
	});
});

describe("spawnAgent → monitor integration", () => {
	beforeEach(() => {
		spawnMock.mockReset();
	});

	it("feeds call start, tool activity, deltas, usage, compaction, and settlement", async () => {
		const proc = fakeProc();
		spawnMock.mockReturnValue(proc);

		// Import the singleton the same way spawnAgent populates it.
		const { monitor } = await import("../index.ts");
		monitor.clear();

		const registry = createSpawnRegistry();
		const promise = spawnAgent(registry, {
			callId: "it-1",
			task: "Do the thing\nwith details",
			displayName: "Explore",
		});

		// Spawn registered: running with derived description.
		let state: AgentCallState | undefined = monitor.get("it-1");
		expect(state?.status).toBe("running");
		expect(state?.displayName).toBe("Explore");
		expect(state?.description).toBe("Do the thing");

		// Stream: text delta, a tool round-trip, compaction, assistant end.
		emitStdout(
			proc,
			Buffer.from(
				[
					JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial…" } }),
					JSON.stringify({ type: "tool_execution_start", toolCallId: "t1", toolName: "read" }),
				].join("\n") + "\n",
			),
		);
		expect(monitor.get("it-1")?.responseTail).toContain("partial");
		expect(monitor.get("it-1")?.activeTools.get("t1")).toBe("read");

		emitStdout(
			proc,
			Buffer.from(
				[
					JSON.stringify({ type: "tool_execution_end", toolCallId: "t1", toolName: "read" }),
					JSON.stringify({ type: "compaction_start", reason: "threshold" }),
					JSON.stringify({ type: "message_end", message: makeAssistantMessage() }),
				].join("\n") + "\n",
			),
		);

		emitStdout(proc, Buffer.from(JSON.stringify({ type: "session_info_changed", name: "x" }) + "\n"));
		proc.emit("close", 0);

		const result = await promise;
		expect(result.exitCode).toBe(0);
		state = monitor.get("it-1");
		expect(state?.turns).toBe(1);
		expect(state?.toolUses).toBe(1);
		expect(state?.activeTools.size).toBe(0);
		expect(state?.compactions).toBe(1);
		expect(state?.lifetimeTokens).toBe(1000 + 2000 + 500);
		expect(state?.contextTokens).toBe(3500);
		expect(state?.status).toBe("completed");
		expect(state?.messages.length).toBe(1); // live ref == result.messages
	});

	it("classifies a non-zero exit as error", async () => {
		const proc = fakeProc();
		spawnMock.mockReturnValue(proc);
		const { monitor } = await import("../index.ts");
		monitor.clear();

		const registry = createSpawnRegistry();
		const promise = spawnAgent(registry, { callId: "it-2", task: "boom" });
		emitStdout(proc, Buffer.from(JSON.stringify({ type: "message_end", message: makeAssistantMessage({ stopReason: "error", errorMessage: "api down" }) }) + "\n"));
		proc.emit("close", 1);
		await promise;

		const state = monitor.get("it-2");
		expect(state?.status).toBe("error");
		expect(state?.errorMessage).toBe("api down");
	});

	it("monitor notifications never break a spawn even if a listener throws", async () => {
		const proc = fakeProc();
		spawnMock.mockReturnValue(proc);
		const { monitor } = await import("../index.ts");
		monitor.clear();
		const unsub = monitor.subscribe(() => {
			throw new Error("listener bug");
		});

		const registry = createSpawnRegistry();
		const promise = spawnAgent(registry, { callId: "it-3", task: "t" });
		emitStdout(proc, Buffer.from(JSON.stringify({ type: "message_end", message: makeAssistantMessage() }) + "\n"));
		proc.emit("close", 0);
		const result = await promise;
		unsub();
		expect(result.exitCode).toBe(0);
		expect(monitor.get("it-3")?.turns).toBe(1);
	});
});

describe("formatting helpers (ui/shared.ts)", () => {
	it("formatTokens renders compact magnitudes", () => {
		expect(formatTokens(0)).toBe("0 token");
		expect(formatTokens(728)).toBe("728 token");
		expect(formatTokens(33_800)).toBe("33.8k token");
		expect(formatTokens(1_234_567)).toBe("1.2M token");
	});

	it("formatSessionTokens annotates percent (threshold colors) and compactions", () => {
		expect(formatSessionTokens(1000, null, fakeTheme)).toBe("1.0k token");
		expect(formatSessionTokens(1000, 45, fakeTheme)).toBe("1.0k token (45%)");
		expect(formatSessionTokens(1000, 88, fakeTheme)).toBe("1.0k token (88%)");
		expect(formatSessionTokens(1000, null, fakeTheme, 2)).toBe("1.0k token (⇊2)");
		expect(formatSessionTokens(1000, 62, fakeTheme, 2)).toBe("1.0k token (62% · ⇊2)");
	});

	it("formatTurns renders the optional budget bound", () => {
		expect(formatTurns(5, 30)).toBe("↻5≤30");
		expect(formatTurns(5)).toBe("↻5");
	});

	it("contextUtilizationPercent resolves against the seeded catalog", () => {
		clearModelCatalog();
		expect(contextUtilizationPercent(1000, "m-x")).toBeNull();
		setModelCatalog([
			{ id: "m-x", contextWindow: 10_000 },
			{ id: "prov/m-y", contextWindow: 100_000 },
		]);
		expect(contextUtilizationPercent(5_000, "m-x")).toBe(50);
		// provider-prefixed reference falls back to the bare id
		expect(contextUtilizationPercent(10_000, "prov/m-y")).toBe(10);
		expect(contextUtilizationPercent(0, "m-x")).toBeNull();
		clearModelCatalog();
	});
});
