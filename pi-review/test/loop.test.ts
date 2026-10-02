/**
 * loop.test.ts — the pure --loop helpers (src/loop.ts): --loop flag
 * extraction, blocking-finding extraction from the structured report JSON,
 * and newest-report discovery under <cwd>/.pi/review/.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { blockingFindings, extractLoopFlag, latestReportFile, runLoopFixing, waitForQuiescent } from "../src/loop.ts";

describe("extractLoopFlag", () => {
	it("detects and strips --loop, keeping the rest", () => {
		expect(extractLoopFlag("--loop --fix src/")).toEqual({ wantLoop: true, rest: "--fix src/" });
		expect(extractLoopFlag("--fix --loop")).toEqual({ wantLoop: true, rest: "--fix" });
	});

	it("no flag → passthrough", () => {
		expect(extractLoopFlag("--fix src/")).toEqual({ wantLoop: false, rest: "--fix src/" });
		expect(extractLoopFlag("")).toEqual({ wantLoop: false, rest: "" });
	});

	it("--loopx is not --loop (word-ish boundary via token equality)", () => {
		expect(extractLoopFlag("--loopx")).toEqual({ wantLoop: false, rest: "--loopx" });
	});
});

describe("blockingFindings", () => {
	it("extracts P0/P1 findings, ignores P2/P3 and unannotated", () => {
		const report = {
			level: "high",
			findings: [
				{ file: "a.ts", line: 3, priority: "P0", summary: "data loss" },
				{ file: "b.ts", priority: "P1", summary: "broken guard" },
				{ file: "c.ts", priority: "P2", summary: "duplication" },
				{ file: "d.ts", summary: "no priority" },
				{ file: "e.ts", priority: "P9", summary: "garbage priority" },
			],
		};
		expect(blockingFindings(report)).toEqual([
			{ file: "a.ts", line: 3, priority: "P0", summary: "data loss" },
			{ file: "b.ts", line: undefined, priority: "P1", summary: "broken guard" },
		]);
	});

	it("tolerates garbage shapes", () => {
		expect(blockingFindings(null)).toEqual([]);
		expect(blockingFindings("nope")).toEqual([]);
		expect(blockingFindings({})).toEqual([]);
		expect(blockingFindings({ findings: "not-an-array" })).toEqual([]);
		expect(blockingFindings({ findings: [null, 42, { priority: "P0" }] })).toEqual([]); // no file → skipped
	});

	it("a decided outcome (fixed/skipped/no_change_needed) un-blocks the finding", () => {
		// A fix turn re-reports its findings with an outcome per the skill's
		// fixed-later obligation — those must not re-trigger fix prompts.
		const report = {
			findings: [
				{ file: "a.ts", priority: "P0", summary: "already fixed", outcome: "fixed" },
				{ file: "b.ts", priority: "P1", summary: "won't fix", outcome: "skipped" },
				{ file: "c.ts", priority: "P0", summary: "declined", outcome: "no_change_needed" },
				{ file: "d.ts", priority: "P0", summary: "still open" },
				{ file: "e.ts", priority: "P1", summary: "garbage outcome", outcome: "whatever" },
			],
		};
		expect(blockingFindings(report)).toEqual([
			{ file: "d.ts", line: undefined, priority: "P0", summary: "still open" },
			{ file: "e.ts", line: undefined, priority: "P1", summary: "garbage outcome" },
		]);
	});
});

describe("latestReportFile", () => {
	const dir = join(tmpdir(), `pi-review-loop-test-${process.pid}`);

	beforeEach(() => {
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns the newest .json written after sinceMs", () => {
		const since = Date.now() - 10_000;
		writeFileSync(join(dir, "old.json"), "{}");
		utimesSync(join(dir, "old.json"), new Date(since - 5000), new Date(since - 5000));
		writeFileSync(join(dir, "new.json"), "{}");
		utimesSync(join(dir, "new.json"), new Date(since + 1000), new Date(since + 1000));
		writeFileSync(join(dir, "notes.txt"), "ignored");

		expect(latestReportFile(dir, since)).toBe(join(dir, "new.json"));
	});

	it("ignores files at or before sinceMs", () => {
		const since = Date.now() - 1000;
		writeFileSync(join(dir, "stale.json"), "{}");
		utimesSync(join(dir, "stale.json"), new Date(since), new Date(since));
		expect(latestReportFile(dir, since)).toBeNull();
	});

	it("missing dir → null", () => {
		expect(latestReportFile(join(dir, "nope"), 0)).toBeNull();
	});
});

describe("waitForQuiescent", () => {
	function fakeSession(opts: {
		idle: () => boolean;
		pending: () => boolean;
		onWait?: () => void;
		signal?: { aborted: boolean };
	}) {
		return {
			isIdle: opts.idle,
			hasPendingMessages: opts.pending,
			waitForIdle: async () => opts.onWait?.(),
			signal: opts.signal,
		};
	}

	it("keeps waiting while follow-ups remain queued after an idle point (loop-round regression)", async () => {
		// The --loop bug this guards: sendUserMessage(followUp) only enqueues —
		// isIdle stays true and the FIRST waitForIdle() resolves before the
		// turn starts. The wait must not return while messages remain queued.
		let pending = 2;
		let waits = 0;
		const session = fakeSession({
			idle: () => true,
			pending: () => pending > 0,
			onWait: () => {
				waits++;
				pending--; // each idle point drains one queued message
			},
		});
		expect(await waitForQuiescent(session)).toBe(true);
		expect(waits).toBe(2);
	});

	it("waits out an active run before returning", async () => {
		let running = true;
		const session = fakeSession({
			idle: () => !running,
			pending: () => false,
			onWait: () => {
				running = false;
			},
		});
		expect(await waitForQuiescent(session)).toBe(true);
	});

	it("reports abort instead of spinning forever", async () => {
		const session = fakeSession({
			idle: () => false,
			pending: () => true,
			signal: { aborted: true },
		});
		expect(await waitForQuiescent(session)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// runLoopFixing — the --loop driver state machine (fake session, real files)
// ---------------------------------------------------------------------------

interface FakeHarness {
	pi: ExtensionAPI;
	ctx: ExtensionCommandContext;
	notify: ReturnType<typeof vi.fn>;
	sent: Array<{ text: string }>;
	/** Per-settled-turn report payload (null = the turn writes no report). */
	script: Array<unknown | null>;
	/** Simulate the dispatcher-sent review turn settling before the loop runs. */
	simulateInitialTurn(): void;
	setReviewDir(dir: string): void;
}

function fakeHarness(): FakeHarness {
	const entries: Array<{ id: string; type: "message"; message: { role: string; content: unknown[] } }> = [
		{ id: "u1", type: "message", message: { role: "user", content: [] } },
		{ id: "a1", type: "message", message: { role: "assistant", content: [] } }, // loop baseline
	];
	let nextId = 1;
	let idle = true;
	let pending = 0;
	let reviewDir = "";
	let turn = 0;
	const waiters: Array<() => void> = [];
	const notify = vi.fn();
	const sent: Array<{ text: string }> = [];
	const script: Array<unknown | null> = [];

	const writeReport = (payload: unknown): void => {
		if (!reviewDir) return;
		mkdirSync(reviewDir, { recursive: true });
		const fp = join(reviewDir, `report-${turn}.json`);
		writeFileSync(fp, JSON.stringify({ level: "high", findings: payload }));
		// Future mtime: beats loopStart regardless of filesystem timestamp
		// granularity (the discovery filter is strictly `mtime > sinceMs`).
		const t = new Date(Date.now() + 60_000);
		utimesSync(fp, t, t);
	};

	const settleTurn = (): void => {
		nextId += 1;
		entries.push({ id: `a${nextId}`, type: "message", message: { role: "assistant", content: [] } });
		const report = script[turn];
		turn += 1;
		if (report !== null) writeReport(report);
		idle = true;
		pending -= 1;
		for (const w of waiters.splice(0)) w();
	};

	const pi = {
		sendUserMessage: (content: string) => {
			sent.push({ text: content });
			pending += 1;
			idle = false;
			queueMicrotask(settleTurn); // the fake turn runs and settles immediately
			return Promise.resolve();
		},
	} as unknown as ExtensionAPI;

	const ctx = {
		signal: undefined,
		isIdle: () => idle,
		hasPendingMessages: () => pending > 0,
		waitForIdle: () => new Promise<void>((r) => (idle ? r() : waiters.push(r))),
		ui: { notify },
		sessionManager: { getBranch: () => entries },
	} as unknown as ExtensionCommandContext;

	return {
		pi,
		ctx,
		notify,
		sent,
		script,
		simulateInitialTurn: settleTurn,
		setReviewDir: (d: string) => {
			reviewDir = d;
		},
	};
}

describe("runLoopFixing (driver integration)", () => {
	let dir = "";
	beforeEach(() => {
		dir = join(tmpdir(), `pi-review-loop-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("fixes one round: fix prompt → re-review prompt → clean → returns 1", async () => {
		const h = fakeHarness();
		h.setReviewDir(join(dir, ".pi", "review"));
		// initial review reports an open P0; the fix turn writes nothing; the
		// re-review reports the same finding with outcome=fixed (un-blocked).
		h.script.push([{ file: "src/a.ts", line: 12, priority: "P0", summary: "off-by-one" }]);
		h.script.push(null);
		h.script.push([{ file: "src/a.ts", line: 12, priority: "P0", summary: "off-by-one", outcome: "fixed" }]);

		const run = runLoopFixing(h.pi, h.ctx, { level: "high", passes: 3, reviewDir: join(dir, ".pi", "review") });
		h.simulateInitialTurn();
		const rounds = await run;

		expect(rounds).toBe(1);
		expect(h.sent).toHaveLength(2); // fix + re-review prompts
		expect(h.sent[0]!.text).toContain("Fix the following blocking findings");
		expect(h.sent[0]!.text).toContain("src/a.ts:12");
		expect(h.sent[1]!.text).toContain("Re-run the code-review SINGLE-PASS flow for effort high");
		expect(h.notify.mock.calls.some(([msg]) => /clean after 1 fix round/.test(String(msg)))).toBe(true);
	});

	it("stops at the passes limit with open findings and says so", async () => {
		const h = fakeHarness();
		h.setReviewDir(join(dir, ".pi", "review"));
		const open = [{ file: "src/b.ts", priority: "P1", summary: "race" }];
		h.script.push(open, null, open, null); // P0/P1 stays open every round

		const run = runLoopFixing(h.pi, h.ctx, { level: "low", passes: 1, reviewDir: join(dir, ".pi", "review") });
		h.simulateInitialTurn();
		const rounds = await run;

		expect(rounds).toBe(1);
		expect(h.sent).toHaveLength(2); // 1 fix + 1 re-review, then the limit fires
		expect(h.notify.mock.calls.some(([msg]) => /safety limit reached/.test(String(msg)))).toBe(true);
	});

	it("returns 0 with a warning when no report JSON ever lands", async () => {
		const h = fakeHarness();
		h.setReviewDir(join(dir, ".pi", "review"));
		h.script.push(null); // review turn wrote no report

		const run = runLoopFixing(h.pi, h.ctx, { level: "high", passes: 3, reviewDir: join(dir, ".pi", "review") });
		h.simulateInitialTurn();
		const rounds = await run;

		expect(rounds).toBe(0);
		expect(h.sent).toHaveLength(0);
		expect(h.notify.mock.calls.some(([msg]) => /no review_report JSON found/.test(String(msg)))).toBe(true);
	});

	it("returns 0 immediately when the caller signal is already aborted", async () => {
		const h = fakeHarness();
		(h.ctx as { signal?: { aborted: boolean } }).signal = { aborted: true };
		const rounds = await runLoopFixing(h.pi, h.ctx, { level: "high", passes: 3, reviewDir: join(dir, ".pi", "review") });
		expect(rounds).toBe(0);
		expect(h.sent).toHaveLength(0);
	});
});
