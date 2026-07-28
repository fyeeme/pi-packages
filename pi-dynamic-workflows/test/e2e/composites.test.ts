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

describe("adversarial", () => {
	it("grades a candidate and tallies pass/fail by majority", async () => {
		const wf = defineWorkflow({
			name: "adversarial",
			steps: [{ id: "adv", type: "adversarial", produce: { prompt: "write a haiku" }, rubric: ["5-7-5 syllables", "seasonal reference"], judges: 3 }],
		});
		const { dispatch, calls } = countingDispatch(makeFakeDispatch({
			value: (opts) => {
				if (opts.callId === "adv#produce") return "haiku text";
				if (opts.callId === "adv#judge3") return '{"pass": false, "reason": "no season"}';
				return '{"pass": true, "reason": "ok"}';
			},
		}));
		const res = await runWorkflow({ workflow: wf, cwd: dir, now: 1000, dispatch });
		expect(res.status).toBe("completed");
		expect(calls()).toBe(4);
		const r = res.steps[0].results as { passed: boolean; passCount: number; minPass: number; judges: { pass: boolean }[] };
		expect(r.passCount).toBe(2);
		expect(r.passed).toBe(true);
		expect(r.judges).toHaveLength(3);
	});

	it("participates in cache-resume: re-run dispatches nothing", async () => {
		const wf = defineWorkflow({
			name: "adv-cache",
			steps: [{ id: "adv", type: "adversarial", produce: { prompt: "p" }, rubric: ["x"], judges: 2 }],
		});
		const value = (opts: { callId: string }) => opts.callId === "adv#produce" ? "c" : '{"pass": true, "reason": ""}';
		const d1 = countingDispatch(makeFakeDispatch({ value }));
		await runWorkflow({ workflow: wf, cwd: dir, now: 1000, dispatch: d1.dispatch });
		expect(d1.calls()).toBe(3);
		const d2 = countingDispatch(makeFakeDispatch({ value }));
		await runWorkflow({ workflow: wf, cwd: dir, now: 1000, dispatch: d2.dispatch });
		expect(d2.calls()).toBe(0);
	});
});

describe("tournament", () => {
	it("generates distinct candidates, judges rank, picks the majority winner", async () => {
		const wf = defineWorkflow({
			name: "tournament",
			steps: [{ id: "tmt", type: "tournament", candidates: 2, produce: { prompt: "solve X" }, judges: 2 }],
		});
		const { dispatch, calls } = countingDispatch(makeFakeDispatch({
			value: (opts) => {
				if (opts.callId.startsWith("tmt#cand")) return "approach " + opts.callId;
				return '{"winner": 0, "reason": "first is better"}';
			},
		}));
		const res = await runWorkflow({ workflow: wf, cwd: dir, now: 1000, dispatch });
		expect(res.status).toBe("completed");
		expect(calls()).toBe(4);
		const r = res.steps[0].results as { candidates: string[]; winner: number; judges: unknown[] };
		expect(r.candidates).toHaveLength(2);
		expect(r.winner).toBe(0);
		expect(r.judges).toHaveLength(2);
	});
});

describe("classify_route", () => {
	it("classifies and runs the matching route", async () => {
		const wf = defineWorkflow({
			name: "classify",
			steps: [{ id: "cr", type: "classify_route", classifier: { prompt: (ctx: any) => "classify: " + ctx.input }, routes: { fast: [{ id: "f1", type: "agent", prompt: "fast path" }] }, fallback: [{ id: "fb", type: "agent", prompt: "fallback" }] }],
		});
		const { dispatch, calls } = countingDispatch(makeFakeDispatch({
			value: (opts) => opts.callId === "cr#classify" ? '{"category": "fast"}' : "out:" + opts.task,
		}));
		const res = await runWorkflow({ workflow: wf, cwd: dir, now: 1000, dispatch, input: "the input" });
		expect(res.status).toBe("completed");
		expect(calls()).toBe(2);
		const r = res.steps[0].results as { category: string; matched: boolean; routeStatus: string };
		expect(r.category).toBe("fast");
		expect(r.matched).toBe(true);
		expect(r.routeStatus).toBe("completed");
	});

	it("falls back when the category matches no route", async () => {
		const wf = defineWorkflow({
			name: "classify-fb",
			steps: [{ id: "cr", type: "classify_route", classifier: { prompt: "c" }, routes: { a: [{ id: "a1", type: "agent", prompt: "A" }] }, fallback: [{ id: "fb", type: "agent", prompt: "fallback" }] }],
		});
		const { dispatch } = countingDispatch(makeFakeDispatch({
			value: (opts) => opts.callId === "cr#classify" ? '{"category": "zzz"}' : "out:" + opts.task,
		}));
		const res = await runWorkflow({ workflow: wf, cwd: dir, now: 1000, dispatch });
		expect(res.status).toBe("completed");
		const r = res.steps[0].results as { category: string; matched: boolean; route: { results: unknown }[] };
		expect(r.category).toBe("zzz");
		expect(r.matched).toBe(false);
		expect(r.route[0].results).toBe("out:fallback");
	});
});

describe("composite correctness regressions", () => {
	it("adversarial coerces a stringified true verdict", async () => {
		const wf = defineWorkflow({
			name: "coerce",
			steps: [{ id: "adv", type: "adversarial", produce: { prompt: "p" }, rubric: ["x"], judges: 3 }],
		});
		const dispatch = makeFakeDispatch({
			value: (opts) => opts.callId === "adv#produce" ? "cand" : '{"pass": "true", "reason": "ok"}',
		});
		const res = await runWorkflow({ workflow: wf, cwd: dir, now: 1000, dispatch });
		expect(res.status).toBe("completed");
		const r = res.steps[0].results as { passCount: number; passed: boolean };
		expect(r.passCount).toBe(3);
		expect(r.passed).toBe(true);
	});

	it("tournament with every candidate failing", async () => {
		const wf = defineWorkflow({
			name: "tmt-fail",
			steps: [{ id: "tmt", type: "tournament", candidates: 2, judges: 2, produce: { prompt: "p" } }],
		});
		const dispatch = makeFakeDispatch({ errors: new Set(["tmt#cand1", "tmt#cand2"]) });
		const res = await runWorkflow({ workflow: wf, cwd: dir, now: 1000, dispatch });
		expect(res.status).toBe("failed");
		expect(res.steps[0].status).toBe("failed");
	});

	it("adversarial exceeding maxAgents", async () => {
		const wf = defineWorkflow({
			name: "adv-budget",
			budget: { maxAgents: 2 },
			steps: [{ id: "adv", type: "adversarial", produce: { prompt: "p" }, rubric: ["x"], judges: 3 }],
		});
		const { dispatch, calls } = countingDispatch(makeFakeDispatch());
		const res = await runWorkflow({ workflow: wf, cwd: dir, now: 1000, dispatch });
		expect(res.status).toBe("failed");
		expect(res.error).toMatch(/budget|exhausted/i);
		expect(calls()).toBe(0);
	});

	it("parseFirstJson handles a brace inside a JSON string value", () => {
		expect(parseFirstJson('{"pass": true, "reason": "wrap in a } block"}')).toEqual({
			pass: true,
			reason: "wrap in a } block",
		});
	});
});
