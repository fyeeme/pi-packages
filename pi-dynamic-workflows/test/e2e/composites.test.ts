/**
 * Composite step scenarios (follow-up to Task 7): the three patterns expanded
 * onto the core primitives — adversarial, tournament, classify_route. All run
 * with a fake dispatch whose `value` callback returns deterministic JSON for
 * judge/classifier calls.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineWorkflow } from "../../src/types.ts";
import { runWorkflow } from "../../src/runner/index.ts";
import { countingDispatch, makeFakeDispatch } from "./helpers.ts";
import { parseFirstJson } from "../../src/outcomes.ts";

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-comp-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// adversarial
// ---------------------------------------------------------------------------

describe("adversarial — produce + N judges → tally", () => {
	it("grades a candidate and tallies pass/fail by majority", async () => {
		const wf = defineWorkflow({
			name: "adversarial",
			steps: [
				{
					id: "adv",
					type: "adversarial",
					produce: { prompt: "write a haiku" },
					rubric: ["5-7-5 syllables", "seasonal reference"],
					judges: 3,
				},
			],
		});
		const { dispatch, calls } = countingDispatch(
			makeFakeDispatch({
				value: (opts) => {
					if (opts.callId === "adv#produce") return "haiku text";
					if (opts.callId === "adv#judge3") return '{"pass": false, "reason": "no season"}';
					return '{"pass": true, "reason": "ok"}';
				},
			}),
		);
		const res = await runWorkflow({ workflow: wf, cwd: dir, now: 1000, dispatch });

		expect(res.status).toBe("completed");
		expect(calls()).toBe(4); // 1 produce + 3 judges
		const r = res.steps[0].results as {
			candidate: string;
			passed: boolean;
			passCount: number;
			minPass: number;
			judges: { pass: boolean }[];
		};
		expect(r.candidate).toBe("haiku text");
		expect(r.passCount).toBe(2);
		expect(r.minPass).toBe(2); // ceil(3/2)
		expect(r.passed).toBe(true);
		expect(r.judges).toHaveLength(3);
	});

	it("participates in cache-resume: re-run dispatches nothing", async () => {
		const wf = defineWorkflow({
			name: "adv-cache",
			steps: [{ id: "adv", type: "adversarial", produce: { prompt: "p" }, rubric: ["x"], judges: 2 }],
		});
		const value = (opts: { callId: string }) =>
			opts.callId === "adv#produce" ? "c" : '{"pass": true, "reason": ""}';
		const d1 = countingDispatch(makeFakeDispatch({ value }));
		await runWorkflow({ workflow: wf, cwd: dir, now: 1000, dispatch: d1.dispatch });
		expect(d1.calls()).toBe(3); // 1 produce + 2 judges

		const d2 = countingDispatch(makeFakeDispatch({ value }));
		await runWorkflow({ workflow: wf, cwd: dir, now: 1000, dispatch: d2.dispatch });
		expect(d2.calls()).toBe(0); // all cached
	});
});

// ---------------------------------------------------------------------------
// tournament
// ---------------------------------------------------------------------------

describe("tournament — N candidates + M judges → winner", () => {
	it("generates distinct candidates, judges rank, picks the majority winner", async () => {
		const wf = defineWorkflow({
			name: "tournament",
			steps: [{ id: "tmt", type: "tournament", candidates: 2, produce: { prompt: "solve X" }, judges: 2 }],
		});
		const { dispatch, calls } = countingDispatch(
			makeFakeDispatch({
				value: (opts) => {
					if (opts.callId.startsWith("tmt#cand")) return `approach ${opts.callId}`;
					return '{"winner": 0, "reason": "first is better"}';
				},
			}),
		);
		const res = await runWorkflow({ workflow: wf, cwd: dir, now: 1000, dispatch });

		expect(res.status).toBe("completed");
		expect(calls()).toBe(4); // 2 candidates + 2 judges
		const r = res.steps[0].results as { candidates: string[]; winner: number; judges: { winner?: number }[] };
		expect(r.candidates).toHaveLength(2);
		expect(r.candidates[0]).not.toBe(r.candidates[1]); // distinct
		expect(r.winner).toBe(0); // both judges picked 0
		expect(r.judges).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// classify_route
// ---------------------------------------------------------------------------

describe("classify_route — classify → matching route's sub-steps", () => {
	it("classifies and runs the matching route", async () => {
		const wf = defineWorkflow({
			name: "classify",
			steps: [
				{
					id: "cr",
					type: "classify_route",
					classifier: { prompt: (ctx) => `classify: ${ctx.input}` },
					routes: {
						fast: [{ id: "f1", type: "agent", prompt: "fast path" }],
						slow: [{ id: "s1", type: "agent", prompt: "slow path" }],
					},
					fallback: [{ id: "fb", type: "agent", prompt: "fallback" }],
				},
			],
		});
		const { dispatch, calls } = countingDispatch(
			makeFakeDispatch({
				value: (opts) => (opts.callId === "cr#classify" ? '{"category": "fast"}' : `out:${opts.task}`),
			}),
		);
		const res = await runWorkflow({ workflow: wf, cwd: dir, now: 1000, dispatch, input: "the input" });

		expect(res.status).toBe("completed");
		expect(calls()).toBe(2); // classifier + the fast route's single agent
		const r = res.steps[0].results as {
			category: string;
			matched: boolean;
			route: { results: unknown }[];
			routeStatus: string;
		};
		expect(r.category).toBe("fast");
		expect(r.matched).toBe(true);
		expect(r.routeStatus).toBe("completed");
		expect(r.route).toHaveLength(1);
		expect(r.route[0].results).toBe("out:fast path");
	});

	it("falls back when the category matches no route", async () => {
		const wf = defineWorkflow({
			name: "classify-fb",
			steps: [
				{
					id: "cr",
					type: "classify_route",
					classifier: { prompt: "c" },
					routes: { a: [{ id: "a1", type: "agent", prompt: "A" }] },
					fallback: [{ id: "fb", type: "agent", prompt: "fallback" }],
				},
			],
		});
		const { dispatch } = countingDispatch(
			makeFakeDispatch({
				value: (opts) => (opts.callId === "cr#classify" ? '{"category": "zzz"}' : `out:${opts.task}`),
			}),
		);
		const res = await runWorkflow({ workflow: wf, cwd: dir, now: 1000, dispatch });
		expect(res.status).toBe("completed");
		const r = res.steps[0].results as { category: string; matched: boolean; route: { results: unknown }[] };
		expect(r.category).toBe("zzz");
		expect(r.matched).toBe(false);
		expect(r.route[0].results).toBe("out:fallback");
	});
});

// ---------------------------------------------------------------------------
// regressions for review-found bugs
// ---------------------------------------------------------------------------

describe("composite correctness regressions", () => {
	it("adversarial coerces a stringified 'true' verdict (pass counted)", async () => {
		const wf = defineWorkflow({
			name: "coerce",
			steps: [{ id: "adv", type: "adversarial", produce: { prompt: "p" }, rubric: ["x"], judges: 3 }],
		});
		const dispatch = makeFakeDispatch({
			value: (opts) =>
				opts.callId === "adv#produce" ? "cand" : '{"pass": "true", "reason": "ok"}',
		});
		const res = await runWorkflow({ workflow: wf, cwd: dir, now: 1000, dispatch });
		expect(res.status).toBe("completed");
		const r = res.steps[0].results as { passCount: number; passed: boolean };
		expect(r.passCount).toBe(3); // all three string-"true" verdicts counted
		expect(r.passed).toBe(true);
	});

	it("tournament with every candidate failing → step failed (not done)", async () => {
		const wf = defineWorkflow({
			name: "tmt-fail",
			steps: [{ id: "tmt", type: "tournament", candidates: 2, judges: 2, produce: { prompt: "p" } }],
		});
		const dispatch = makeFakeDispatch({ errors: new Set(["tmt#cand1", "tmt#cand2"]) });
		const res = await runWorkflow({ workflow: wf, cwd: dir, now: 1000, dispatch });
		expect(res.status).toBe("failed");
		expect(res.steps[0].status).toBe("failed");
	});

	it("adversarial exceeding maxAgents → run failed with budget error (no overshoot)", async () => {
		const wf = defineWorkflow({
			name: "adv-budget",
			budget: { maxAgents: 2 },
			steps: [{ id: "adv", type: "adversarial", produce: { prompt: "p" }, rubric: ["x"], judges: 3 }],
		}); // 1 produce + 3 judges = 4 > maxAgents 2 → guardBatch throws before any dispatch
		const { dispatch, calls } = countingDispatch(makeFakeDispatch());
		const res = await runWorkflow({ workflow: wf, cwd: dir, now: 1000, dispatch });
		expect(res.status).toBe("failed");
		expect(res.error).toMatch(/budget|exhausted/i);
		expect(calls()).toBe(0); // pre-checked, nothing dispatched
	});

	it("parseFirstJson handles a brace inside a JSON string value", () => {
		expect(parseFirstJson('{"pass": true, "reason": "wrap in a } block"}')).toEqual({
			pass: true,
			reason: "wrap in a } block",
		});
	});
});
