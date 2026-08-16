import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

// Mock `spawn` before index.ts imports it.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import {
	abortAgent,
	createSpawnRegistry,
	DEFAULT_MAX_CONCURRENCY,
	getPiInvocation,
	mapWithConcurrencyLimit,
	spawnAgent,
} from "../index.ts";

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

describe("mapWithConcurrencyLimit", () => {
	it("preserves input order", async () => {
		const out = await mapWithConcurrencyLimit([1, 2, 3, 4], 2, async (n) => n * 10);
		expect(out).toEqual([10, 20, 30, 40]);
	});

	it("respects the concurrency cap", async () => {
		let active = 0;
		let peak = 0;
		await mapWithConcurrencyLimit([1, 2, 3, 4, 5], 2, async () => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((r) => setTimeout(r, 5));
			active--;
		});
		expect(peak).toBeLessThanOrEqual(2);
	});

	it("returns [] for empty input", async () => {
		expect(await mapWithConcurrencyLimit([], 4, async (n) => n)).toEqual([]);
	});

	// --- max-concurrency option (hardcoded default 5) ---

	it("DEFAULT_MAX_CONCURRENCY is 5 (hardcoded, no env / config)", () => {
		expect(DEFAULT_MAX_CONCURRENCY).toBe(5);
	});

	it("omitting concurrency caps in-flight work at the hardcoded 5", async () => {
		let active = 0;
		let peak = 0;
		const out = await mapWithConcurrencyLimit([1, 2, 3, 4, 5, 6, 7, 8], async (n) => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((r) => setTimeout(r, 5));
			active--;
			return n * 10;
		});
		expect(peak).toBe(5); // 8 items, hardcoded ceiling 5
		expect(out).toEqual([10, 20, 30, 40, 50, 60, 70, 80]); // order preserved
	});

	it("an env var does NOT change the omitted-concurrency default (hardcoded)", async () => {
		process.env.PI_MAX_CONCURRENT_SUBAGENTS = "50";
		try {
			let active = 0;
			let peak = 0;
			await mapWithConcurrencyLimit([1, 2, 3, 4, 5, 6], async () => {
				active++;
				peak = Math.max(peak, active);
				await new Promise((r) => setTimeout(r, 5));
				active--;
			});
			expect(peak).toBe(5); // still 5: the default is a constant, not env-driven
		} finally {
			delete process.env.PI_MAX_CONCURRENT_SUBAGENTS;
		}
	});

	it("stops dispatching new items after a rejection (no orphan workers)", async () => {
		const seen: number[] = [];
		let started = 0;
		// 2 workers, 6 items. Park ONE worker on item 0 so the other is forced to
		// advance to item 2 and fail. Releasing item 0 right before the throw keeps
		// it deterministic (no deadlock: the parked worker is always unblocked).
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => (release = r));
		await expect(
			mapWithConcurrencyLimit([0, 1, 2, 3, 4, 5], 2, async (n) => {
				started++;
				seen.push(n);
				if (n === 0) await gate; // park one worker on item 0
				if (n === 2) {
					release(); // unblock the parked worker first
					throw new Error("boom"); // then fail → sets `failed`
				}
				await new Promise((r) => setTimeout(r, 5));
			}),
		).rejects.toThrow("boom");
		// Worker A finished item 0 (released), worker B failed on item 2. Once
		// `failed` is set, neither worker pulls 3/4/5 — a rejection must not leave
		// siblings draining the rest of the queue.
		expect(seen).toEqual(expect.arrayContaining([0, 1, 2]));
		expect(started).toBeLessThanOrEqual(3);
		expect(seen).not.toContain(4);
		expect(seen).not.toContain(5);
	});

	it("awaits in-flight workers before rethrowing (no orphan subprocesses)", async () => {
		// Worker A parks on item 0 (in-flight); worker B fails on item 1
		// immediately, setting `failed`. The limiter must NOT rethrow until A
		// settles — otherwise a spawned subprocess could outlive the rejection.
		let releaseA: () => void = () => {};
		const gate = new Promise<void>((r) => (releaseA = r));
		let rejected = false;
		const p = mapWithConcurrencyLimit([0, 1], 2, async (n) => {
			if (n === 0) {
				await gate;
				return "a";
			}
			throw new Error("boom");
		}).then(
			() => "resolved",
			() => {
				rejected = true;
				return "rejected";
			},
		);
		// B has thrown by now; a fast-reject impl would have set `rejected` here.
		await new Promise((r) => setTimeout(r, 5));
		expect(rejected).toBe(false);
		releaseA(); // let the in-flight item 0 finish
		expect(await p).toBe("rejected");
	});
});

describe("getPiInvocation", () => {
	it("returns a non-empty command and an args array", () => {
		const inv = getPiInvocation(["--mode", "json"]);
		expect(typeof inv.command).toBe("string");
		expect(inv.command.length).toBeGreaterThan(0);
		expect(Array.isArray(inv.args)).toBe(true);
	});
});

describe("spawnAgent", () => {
	beforeEach(() => spawnMock.mockReset());
	afterEach(() => vi.useRealTimers());

	it("passes --thinking to the child process when set, omits it otherwise", async () => {
		const proc = fakeProc();
		spawnMock.mockReturnValue(proc);
		const registry = createSpawnRegistry();
		const p = spawnAgent(registry, { callId: "c-t1", task: "hi", thinking: "high" });
		proc.emit("close", 0);
		await p;
		expect(spawnMock.mock.calls[0]![1]).toContain("--thinking");
		expect(spawnMock.mock.calls[0]![1]).toContain("high");

		spawnMock.mockClear();
		spawnMock.mockReturnValue(proc);
		const p2 = spawnAgent(registry, { callId: "c-t2", task: "hi" });
		proc.emit("close", 0);
		await p2;
		expect(spawnMock.mock.calls[0]![1]).not.toContain("--thinking");
	});

	it("parses message_end NDJSON events into messages", async () => {
		const proc = fakeProc();
		spawnMock.mockReturnValue(proc);
		const registry = createSpawnRegistry();
		const p = spawnAgent(registry, { callId: "c1", task: "hi" });
		proc.stdout!.emit("data", Buffer.from(`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: "hello" } })}\n`));
		proc.stdout!.emit("data", Buffer.from(`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: "world" } })}\n`));
		proc.emit("close", 0);
		const r = await p;
		expect(r.exitCode).toBe(0);
		expect(r.messages).toHaveLength(2);
	});

	it("forwards message_update deltas via onUpdate and still collects message_end", async () => {
		const proc = fakeProc();
		spawnMock.mockReturnValue(proc);
		const registry = createSpawnRegistry();
		const deltas: string[] = [];
		const p = spawnAgent(registry, { callId: "c5", task: "hi", onUpdate: (d) => deltas.push(d) });
	const deltaMsg = (text: string): string => JSON.stringify({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
		});
		proc.stdout!.emit("data", Buffer.from(`${deltaMsg("Hel")}\n`));
		proc.stdout!.emit("data", Buffer.from(`${deltaMsg("lo, w")}\n`));
		proc.stdout!.emit("data", Buffer.from(`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: "Hello, world" } })}\n`));
		proc.emit("close", 0);
		const r = await p;
		expect(deltas).toEqual(["Hel", "lo, w"]);
		expect(r.messages).toHaveLength(1); // message_end still collected
	});

	it("discards message_update deltas when no onUpdate is provided", async () => {
		const proc = fakeProc();
		spawnMock.mockReturnValue(proc);
		const registry = createSpawnRegistry();
		const p = spawnAgent(registry, { callId: "c6", task: "hi" });
		proc.stdout!.emit("data", Buffer.from(`${JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ignored" } })}\n`));
		proc.stdout!.emit("data", Buffer.from(`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: "final" } })}\n`));
		proc.emit("close", 0);
		const r = await p;
		expect(r.messages).toHaveLength(1);
		expect(r.messages[0]?.content).toBe("final");
	});

	it("aborts via the registry → SIGTERM on the one process, SIGKILL after 5s", async () => {
		vi.useFakeTimers();
		const proc = fakeProc();
		spawnMock.mockReturnValue(proc);
		const registry = createSpawnRegistry();
		const p = spawnAgent(registry, { callId: "c2", task: "x" });
		expect(abortAgent(registry, "c2")).toBe(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
		// SIGTERM may be ignored — SIGKILL escalation after the 5s grace period.
		await vi.advanceTimersByTimeAsync(5000);
		expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
		proc.emit("close", null);
		const r = await p;
		expect(r.aborted).toBe(true);
	});

	it("returns false when aborting an unknown callId", () => {
		const registry = createSpawnRegistry();
		expect(abortAgent(registry, "nope")).toBe(false);
	});

	it("surfaces a spawn error (ENOENT) in errorMessage", async () => {
		const proc = fakeProc();
		spawnMock.mockReturnValue(proc);
		const registry = createSpawnRegistry();
		const p = spawnAgent(registry, { callId: "c3", task: "x" });
		proc.emit("error", new Error("spawn ENOENT"));
		const r = await p;
		expect(r.exitCode).toBe(1);
		expect(r.errorMessage).toContain("ENOENT");
	});

	it("treats signal-killed (code=null) as non-zero exit, not silent success", async () => {
		const proc = fakeProc();
		spawnMock.mockReturnValue(proc);
		const registry = createSpawnRegistry();
		const p = spawnAgent(registry, { callId: "c4", task: "x" });
		proc.emit("close", null); // null exit code = killed by a signal (OOM / external SIGKILL)
		const r = await p;
		expect(r.exitCode).toBe(1); // was the bug: resolve(code ?? 0) wrote 0 → masked the kill
	});

	it("keeps a CJK char split across two chunks intact (StringDecoder)", async () => {
		const proc = fakeProc();
		spawnMock.mockReturnValue(proc);
		const registry = createSpawnRegistry();
		const p = spawnAgent(registry, { callId: "c5", task: "x" });
		// "中" is a 3-byte UTF-8 sequence; split the line in the middle of it.
		const line = `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: "中" } })}\n`;
		const bytes = Buffer.from(line);
		const splitAt = bytes.indexOf(Buffer.from("中")) + 1; // cut inside the char
		proc.stdout!.emit("data", bytes.subarray(0, splitAt));
		proc.stdout!.emit("data", bytes.subarray(splitAt));
		proc.emit("close", 0);
		const r = await p;
		expect(r.exitCode).toBe(0);
		expect(r.messages).toHaveLength(1);
		expect((r.messages[0] as { content?: unknown }).content).toBe("中");
	});

	it("marks maxTurnsReached and aborts when the assistant turn budget is hit", async () => {
		const proc = fakeProc();
		spawnMock.mockReturnValue(proc);
		const registry = createSpawnRegistry();
		const p = spawnAgent(registry, { callId: "c6", task: "x", maxTurns: 1 });
		proc.stdout!.emit("data", Buffer.from(`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: "one" } })}\n`));
		await new Promise((r) => setTimeout(r, 5));
		expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
		proc.emit("close", null);
		const r = await p;
		expect(r.maxTurnsReached).toBe(true);
		expect(r.aborted).toBe(true);
		expect(r.usage.turns).toBe(1);
	});
});
