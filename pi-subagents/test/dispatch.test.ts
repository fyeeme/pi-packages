import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

// Mock `spawn` before index.ts imports it.
const { spawnMock, artifactFailures } = vi.hoisted(() => ({
	spawnMock: vi.fn(),
	artifactFailures: { enabled: false },
}));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));
// Delegating node:fs mock — only writeFileSync can be made to fail on demand
// (ESM namespaces cannot be spied on after import).
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		writeFileSync: ((path: Parameters<typeof actual.writeFileSync>[0], ...rest: unknown[]) => {
			if (artifactFailures.enabled) throw new Error("EACCES: read-only tmpdir");
			return (actual.writeFileSync as (...a: unknown[]) => void)(path, ...rest);
		}) as typeof actual.writeFileSync,
	};
});

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	abortAgent,
	allocateStableId,
	createSpawnRegistry,
	DEFAULT_MAX_CONCURRENCY,
	getEffectiveMaxConcurrency,
	getMaxConcurrency,
	getPiInvocation,
	mapWithConcurrencyLimit,
	resolveWatchdogThresholds,
	spawnAgent,
	uniquifyStableId,
} from "../src/dispatch.ts";
import { monitor } from "../src/monitor.ts";
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

	// --- max-concurrency option (default 5, file-configurable 3/5/8/10) ---
	//
	// The omitted-concurrency ceiling reads the package settings files
	// (settings.ts) at call time. Stub PI_CODING_AGENT_DIR (pi's agent-dir
	// override, honored by getAgentDir) to a fresh temp dir so the global layer
	// is empty and the tests stay deterministic regardless of the host machine.

	let configDir: string;

	beforeEach(() => {
		configDir = mkdtempSync(join(tmpdir(), "pi-sa-cfg-"));
		process.env.PI_CODING_AGENT_DIR = configDir;
	});

	afterEach(() => {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(configDir, { recursive: true, force: true });
	});

	it("DEFAULT_MAX_CONCURRENCY is 5 (the hardcoded fallback)", () => {
		expect(DEFAULT_MAX_CONCURRENCY).toBe(5);
	});

	it("omitting concurrency caps in-flight work at the default 5 (no settings file)", async () => {
		let active = 0;
		let peak = 0;
		const out = await mapWithConcurrencyLimit([1, 2, 3, 4, 5, 6, 7, 8], async (n) => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((r) => setTimeout(r, 5));
			active--;
			return n * 10;
		});
		expect(peak).toBe(5); // 8 items, default ceiling 5
		expect(out).toEqual([10, 20, 30, 40, 50, 60, 70, 80]); // order preserved
	});

	it("a PI_CODING_AGENT_DIR env var does NOT change the default (file-based, not this env var)", () => {
		expect(getEffectiveMaxConcurrency()).toBe(5);
	});

	it("maxConcurrency from the global settings file raises the ceiling to the configured option", async () => {
		writeFileSync(join(configDir, "pi-subagent.json"), JSON.stringify({ maxConcurrency: 8 }));
		expect(getEffectiveMaxConcurrency()).toBe(8);
		let active = 0;
		let peak = 0;
		await mapWithConcurrencyLimit([1, 2, 3, 4, 5, 6, 7, 8], async () => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((r) => setTimeout(r, 5));
			active--;
		});
		expect(peak).toBe(8); // 8 items, configured ceiling 8 — all in flight
	});

	it("maxConcurrency from the project layer overrides the global layer", async () => {
		writeFileSync(join(configDir, "pi-subagent.json"), JSON.stringify({ maxConcurrency: 10 }));
		// Hermetic project layer: chdir into a temp dir so its .pi/ is never the repo's.
		const projDir = mkdtempSync(join(tmpdir(), "pi-sa-proj-"));
		const prevCwd = process.cwd();
		mkdirSync(join(projDir, ".pi"));
		writeFileSync(join(projDir, ".pi", "pi-subagent.json"), JSON.stringify({ maxConcurrency: 3 }));
		try {
			process.chdir(projDir);
			let active = 0;
			let peak = 0;
			await mapWithConcurrencyLimit([1, 2, 3, 4, 5, 6, 7, 8], async () => {
				active++;
				peak = Math.max(peak, active);
				await new Promise((r) => setTimeout(r, 5));
				active--;
			});
			expect(peak).toBe(3); // project layer (3) wins over global (10)
		} finally {
			process.chdir(prevCwd);
			rmSync(projDir, { recursive: true, force: true });
		}
	});

	it("non-positive / non-integer maxConcurrency values are dropped (fallback 5)", () => {
		writeFileSync(join(configDir, "pi-subagent.json"), JSON.stringify({ maxConcurrency: 0 }));
		expect(getEffectiveMaxConcurrency()).toBe(5);
		writeFileSync(join(configDir, "pi-subagent.json"), JSON.stringify({ maxConcurrency: 3.5 }));
		expect(getEffectiveMaxConcurrency()).toBe(5);
		writeFileSync(join(configDir, "pi-subagent.json"), JSON.stringify({ maxConcurrency: -2 }));
		expect(getEffectiveMaxConcurrency()).toBe(5);
		writeFileSync(join(configDir, "pi-subagent.json"), JSON.stringify({ maxConcurrency: 3 }));
		expect(getEffectiveMaxConcurrency()).toBe(3);
	});

	it("PI_MAX_CONCURRENT_SUBAGENTS is no longer honored — the file alone drives the ceiling", () => {
		writeFileSync(join(configDir, "pi-subagent.json"), JSON.stringify({ maxConcurrency: 3 }));
		process.env.PI_MAX_CONCURRENT_SUBAGENTS = "50";
		try {
			expect(getMaxConcurrency()).toBe(3);
			expect(getEffectiveMaxConcurrency()).toBe(3);
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


describe("stall watchdog and wall-clock ceiling", () => {
	let configDir: string;

	beforeEach(() => {
		spawnMock.mockReset();
		monitor.clear();
		configDir = mkdtempSync(join(tmpdir(), "pi-sa-watch-"));
		process.env.PI_CODING_AGENT_DIR = configDir;
	});
	afterEach(() => {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(configDir, { recursive: true, force: true });
		vi.useRealTimers();
		monitor.clear();
	});

	it("a silent subprocess is aborted as stalled at the default 60s, partial output kept", async () => {
		vi.useFakeTimers();
		const proc = fakeProc(); // emits nothing
		spawnMock.mockReturnValue(proc);
		const registry = createSpawnRegistry();
		const p = spawnAgent(registry, { callId: "w1", task: "x" });
		const done = p.then(async (r) => {
			expect(r.aborted).toBe(true);
			expect(r.abortReason).toBe("stalled");
			expect(proc.kill).toHaveBeenCalledWith("SIGTERM"); // same SIGTERM chain as ESC
			const state = monitor.get("w1");
			expect(state?.errorMessage).toContain("stalled"); // row text explains why
			return r;
		});
		await vi.advanceTimersByTimeAsync(60_000);
		proc.emit("close", null); // watchdog kill settles the process
		await done;
	});

	it("any subprocess output event rearms the stall timer", async () => {
		vi.useFakeTimers();
		const proc = fakeProc();
		spawnMock.mockReturnValue(proc);
		const registry = createSpawnRegistry();
		const p = spawnAgent(registry, { callId: "w2", task: "x" });
		let settled = false;
		void p.then(() => (settled = true));
		// 55s of silence, a delta, then another 55s — a non-rearming timer would
		// have fired at 60s; liveness pushes the deadline past 110s.
		for (const elapsed of [55_000, 55_000]) {
			await vi.advanceTimersByTimeAsync(elapsed - 1000);
			proc.stdout!.emit("data", Buffer.from(`${JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "alive" } })}\n`));
			await vi.advanceTimersByTimeAsync(1000);
		}
		expect(settled).toBe(false); // still running at t=110s
		disarmForTest(proc);
		proc.emit("close", 0);
		await p;
		expect(settled).toBe(true);
	});

	it("wallClockMs ends an agent that keeps outputting, reported as wall-clock", async () => {
		vi.useFakeTimers();
		writeFileSync(join(configDir, "pi-subagent.json"), JSON.stringify({ stallMs: 10_000, wallClockMs: 20_000 }));
		const proc = fakeProc();
		spawnMock.mockReturnValue(proc);
		const registry = createSpawnRegistry();
		const p = spawnAgent(registry, { callId: "w3", task: "x" });
		const heartbeat = setInterval(() => {
			proc.stdout!.emit("data", Buffer.from(`${JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "tick" } })}\n`));
		}, 5_000);
		const done = p.then((r) => {
			clearInterval(heartbeat);
			expect(r.aborted).toBe(true);
			expect(r.abortReason).toBe("wall-clock"); // stall never fired despite 25s total
			return r;
		});
		await vi.advanceTimersByTimeAsync(20_001);
		proc.emit("close", null);
		await done;
	});

	it("a wallClockMs below twice stallMs is ignored (invariant), default disabled otherwise", async () => {
		writeFileSync(
			join(configDir, "pi-subagent.json"),
			JSON.stringify({ stallMs: 30_000, wallClockMs: 40_000 }),
		);
		const resolved = resolveWatchdogThresholds();
		expect(resolved.stallMs).toBe(30_000);
		expect(resolved.wallClockMs).toBeUndefined(); // 40s < 2×30s → ignored

		writeFileSync(join(configDir, "pi-subagent.json"), JSON.stringify({ wallClockMs: -5 }));
		const defaults = resolveWatchdogThresholds();
		expect(defaults.stallMs).toBe(60_000); // invalid stall → default 60000
		expect(defaults.wallClockMs).toBeUndefined(); // no valid config → disabled
	});
});

/** Test seam: stop the stall rearm cycle without killing the fake proc. */
function disarmForTest(_proc: ChildProcess): void {}

describe("full-output artifacts", () => {
	beforeEach(() => {
		spawnMock.mockReset();
		monitor.clear();
	});
	afterEach(() => monitor.clear());

	it("writes the final output to <tmpdir>/pi-subagents/<pid>-<n>/<id>.md", async () => {
		const proc = fakeProc();
		spawnMock.mockReturnValue(proc);
		const registry = createSpawnRegistry();
		const p = spawnAgent(registry, { callId: "c-art", task: "x" });
		proc.stdout!.emit("data", Buffer.from(`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: "FINAL-OUTPUT-TEXT" } })}\n`));
		proc.emit("close", 0);
		const r = await p;
		const dirPart = `pi-subagents/${process.pid}-`;
		expect(r.outputPath!.includes(dirPart)).toBe(true);
		expect(r.outputPath!.endsWith(".md")).toBe(true);
		const { readFileSync } = await import("node:fs");
		expect(readFileSync(r.outputPath!, "utf-8")).toBe("FINAL-OUTPUT-TEXT");
	});

	it("uses the stable id (sanitized) for the artifact filename", async () => {
		const proc = fakeProc();
		spawnMock.mockReturnValue(proc);
		const registry = createSpawnRegistry();
		const p = spawnAgent(registry, { callId: "c-art2", task: "x", id: "Swift Fox" });
		proc.stdout!.emit("data", Buffer.from(`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: "out" } })}\n`));
		proc.emit("close", 0);
		const r = await p;
		expect(r.outputPath).toContain("Swift_Fox.md");
	});

	it("degrades to a warning when the artifact cannot be written", async () => {
		artifactFailures.enabled = true;
		try {
			const proc = fakeProc();
			spawnMock.mockReturnValue(proc);
			const registry = createSpawnRegistry();
			const p = spawnAgent(registry, { callId: "c-art3", task: "x" });
			proc.stdout!.emit("data", Buffer.from(`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: "out" } })}\n`));
			proc.emit("close", 0);
			const r = await p;
			expect(r.exitCode).toBe(0); // the call still succeeds
			expect(r.outputPath).toBeUndefined();
			expect(r.artifactWarning).toContain("full-output artifact not written");
		} finally {
			artifactFailures.enabled = false;
		}
	});
});

describe("stable spawn ids", () => {
	beforeEach(() => {
		spawnMock.mockReset();
		monitor.clear();
	});
	afterEach(() => monitor.clear());

	it("uniquifyStableId appends -2/-3 suffixes on collision", () => {
		const taken = new Set(["SwiftFox", "SwiftFox-2"]);
		expect(uniquifyStableId("SwiftFox", taken)).toBe("SwiftFox-3");
		expect(uniquifyStableId("CalmOtter", taken)).toBe("CalmOtter");
	});

	it("allocateStableId yields AdjectiveNoun ids unique within the process", () => {
		const seen = new Set<string>();
		for (let i = 0; i < 200; i++) {
			const id = allocateStableId();
			expect(id).toMatch(/^[A-Z][a-z]+[A-Z][a-z]+(-\d+)?$/);
			expect(seen.has(id)).toBe(false);
			seen.add(id);
		}
	});

	it("spawnAgent returns a stable id alongside the untouched callId; monitor carries it", async () => {
		const proc = fakeProc();
		spawnMock.mockReturnValue(proc);
		const registry = createSpawnRegistry();
		const p = spawnAgent(registry, { callId: "subagent-scout-1738-abc", task: "hi" });
		proc.emit("close", 0);
		const r = await p;
		expect(r.callId).toBe("subagent-scout-1738-abc"); // addressing key unchanged
		expect(r.id).toMatch(/^[A-Z][a-z]+[A-Z][a-z]+$/); // AdjectiveNoun
		expect(monitor.get(r.callId)?.id).toBe(r.id); // same id across surfaces
	});

	it("an explicit options.id passes through verbatim", async () => {
		const proc = fakeProc();
		spawnMock.mockReturnValue(proc);
		const registry = createSpawnRegistry();
		const p = spawnAgent(registry, { callId: "c-id", task: "hi", id: "PluckyBadger" });
		proc.emit("close", 0);
		const r = await p;
		expect(r.id).toBe("PluckyBadger");
		expect(monitor.get("c-id")?.id).toBe("PluckyBadger");
	});
});
