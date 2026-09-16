/**
 * loop.test.ts — the pure --loop helpers (src/loop.ts): --loop flag
 * extraction, blocking-finding extraction from the structured report JSON,
 * and newest-report discovery under <cwd>/.pi/review/.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blockingFindings, extractLoopFlag, latestReportFile, waitForQuiescent } from "../src/loop.ts";

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
