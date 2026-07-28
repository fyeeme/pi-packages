/**
 * Task 7 end-to-end scenarios — exercise the runner wiring all five CC-fusion
 * modules. Every scenario uses an injected fake dispatch (no `pi` binary, no
 * provider API); the real spawnAgent path is the default dispatch left for a
 * manual smoke test.
 *
 * Scenarios (plan Task 7):
 *   1. two-stage run         — sequential agents + ctx.step threading
 *   2. fanOut + progress      — parallel agents + lifecycle onAgentStart
 *   3. budget exceeded        — BudgetPool refuses, explicit error (no truncation)
 *   4. save/reload            — journal persists to disk; reload hits cache
 *   5. abort + cleanup        — run signal aborts in-flight agent; registry cleans
 *   6. cache-resume hit       — re-run with a different runId still hits (key excludes runId)
 *   7. per-agent skip isolate — skipAgent one fan_out item; siblings complete
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineWorkflow } from "../../src/types.ts";
import { runWorkflow } from "../../src/runner/index.ts";
import { createSpawnRegistry, skipAgent } from "../../src/agent/dispatch.ts";
import { countingDispatch, makeFakeDispatch } from "./helpers.ts";

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-e2e-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("e2e scenarios", () => {
	it("1. two-stage: sequential agents + ctx.step threading", async () => {
		const dispatch = makeFakeDispatch();
		const wf = defineWorkflow({
			name: "two-stage",
			steps: [
				{ id: "first", type: "agent", prompt: "first task" },
				{ id: "second", type: "agent", prompt: (ctx) => `second: ${ctx.step("first").results}` },
			],
		});
		const result = await runWorkflow({ workflow: wf, cwd: dir, now: 1000, dispatch });
		expect(result.status).toBe("completed");
		expect(result.steps).toHaveLength(2);
		expect(result.steps[0].results).toBe("out:first task");
		expect(result.steps[1].results).toBe("out:second: out:first task");
	});

	it("2. fanOut + lifecycle onAgentStart progress", async () => {
		const dispatch = makeFakeDispatch();
		const wf = defineWorkflow({
			name: "fan-progress",
			steps: [
				{
					id: "fan",
					type: "fan_out",
					over: () => ["a", "b", "c"],
					agent: (item) => ({ prompt: `item:${item}` }),
					parallelism: 3,
				},
			],
		});
		const starts: string[] = [];
		const result = await runWorkflow({
			workflow: wf,
			cwd: dir,
			now: 1000,
			dispatch,
			listeners: {
				onAgentStart: (callId) => starts.push(callId),
			},
		});
		expect(result.status).toBe("completed");
		expect(starts).toHaveLength(3);
		expect(starts).toEqual(expect.arrayContaining(["fan#1", "fan#2", "fan#3"]));
	});

	it("3. budget exceeded — explicit error (no truncation)", async () => {
		const dispatch = makeFakeDispatch();
		const wf = defineWorkflow({
			name: "budget-exceeded",
			budget: { maxAgents: 1 },
			steps: [
				{ id: "a", type: "agent", prompt: "first" },
				{ id: "b", type: "agent", prompt: "second" },
			],
		});
		const result = await runWorkflow({ workflow: wf, cwd: dir, now: 1000, dispatch });
		expect(result.status).toBe("failed");
		expect((result.error ?? "").toLowerCase()).toMatch(/budget|exhausted/i);
		expect(result.steps[0].status).toBe("done");
	});

	it("4. save/reload — journal persists to disk; reload hits cache", async () => {
		const dispatch = makeFakeDispatch();
		const wf = defineWorkflow({
			name: "cache-persist",
			steps: [
				{ id: "a", type: "agent", prompt: "hello" },
				{ id: "b", type: "agent", prompt: "world" },
			],
		});

		const r1 = await runWorkflow({ workflow: wf, cwd: dir, now: 1000, dispatch });
		expect(r1.status).toBe("completed");
		expect(r1.steps).toHaveLength(2);

		// Verify journal was written to disk.
		const journalGlob = path.join(dir, ".pi", "workflows", "cache-persist", "journal.jsonl");
		expect(fs.existsSync(journalGlob)).toBe(true);
		const journalContent = fs.readFileSync(journalGlob, "utf-8");
		expect(journalContent).toContain("started");
		expect(journalContent).toContain("result");

		// Second run with different now (different runId) should still hit the cache.
		const { dispatch: counting, calls } = countingDispatch(dispatch);
		const r2 = await runWorkflow({ workflow: wf, cwd: dir, now: 2000, dispatch: counting });
		expect(r2.status).toBe("completed");
		expect(calls()).toBe(0); // zero dispatches → all cached
	});

	it("5. abort + cleanup — run signal aborts in-flight agent; registry cleans", async () => {
		const abortController = new AbortController();
		const dispatch = makeFakeDispatch({
			hang: new Set(["loop#1"]),
		});
		const wf = defineWorkflow({
			name: "abort-cleanup",
			steps: [
				{
					id: "loop",
					type: "loop_until",
					prompt: (ctx, i) => `iter ${i}`,
					until: () => false,
					maxIterations: 10,
				},
			],
		});
		const registry = createSpawnRegistry();

		const runP = runWorkflow({
			workflow: wf,
			cwd: dir,
			now: 1000,
			dispatch,
			signal: abortController.signal,
			registry,
		});

		// Wait for the first loop iteration to start.
		await vi.waitFor(() => {
			expect(registry.controllers.size).toBe(1);
		}, { interval: 10, timeout: 2000 });

		abortController.abort();
		const result = await runP;

		expect(result.status).toBe("aborted");
		expect(result.error).toBe("aborted by signal");
		// Registry cleaned up after each call's finally block.
		expect(registry.controllers.size).toBe(0);
	});

	it("6. cache-resume hit — re-run with different runId hits cache (key excludes runId)", async () => {
		const dispatch = makeFakeDispatch();
		const wf = defineWorkflow({
			name: "cache-hit",
			steps: [{ id: "a", type: "agent", prompt: "test" }],
		});

		// First run: dispatches the agent.
		const r1 = await runWorkflow({ workflow: wf, cwd: dir, now: 1000, dispatch });
		expect(r1.status).toBe("completed");

		// Second run: no dispatch — all cached despite different now/runId.
		const { dispatch: counting, calls } = countingDispatch(dispatch);
		const r2 = await runWorkflow({ workflow: wf, cwd: dir, now: 9999, dispatch: counting });
		expect(r2.status).toBe("completed");
		expect(calls()).toBe(0);
	});

	it("7. per-agent skip isolate — skipAgent one fan_out item; siblings complete", async () => {
		const dispatch = makeFakeDispatch({
			hang: new Set(["fan#2"]),
		});
		const wf = defineWorkflow({
			name: "skip-isolate",
			steps: [
				{
					id: "fan",
					type: "fan_out",
					over: () => ["x", "y", "z"],
					agent: (item) => ({ prompt: `item:${item}` }),
					parallelism: 3,
				},
			],
		});
		const registry = createSpawnRegistry();
		const runP = runWorkflow({
			workflow: wf,
			cwd: dir,
			now: 1000,
			dispatch,
			registry,
		});

		// Wait until fan#2 is in flight (hung). fan#1 and fan#3 complete immediately
		// with the fake dispatch, so only 1 controller remains (the hung call).
		await vi.waitFor(() => {
			expect(registry.controllers.size).toBe(1);
		}, { interval: 10, timeout: 2000 });

		skipAgent(registry, "fan#2");
		const result = await runP;

		expect(result.status).toBe("completed");
		expect(result.steps).toHaveLength(1);
		const sr = result.steps[0]!;
		expect(sr.status).toBe("done");
		expect((sr.results as string[])).toHaveLength(3);
		// Fan-out results: item 1 and 3 resolved with text; item 2 was skipped.
		expect((sr.results as string[])[0]).toBe("out:item:x");
		expect((sr.results as string[])[2]).toBe("out:item:z");
	});
});
