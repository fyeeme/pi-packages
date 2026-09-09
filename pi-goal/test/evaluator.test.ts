/**
 * pi-goal — independent evaluator tests.
 *
 * Pins the CC 2.1.261-absorbed contract: strict JSON verdict parsing with the
 * "insufficient evidence = not met" default direction, grounded prompt
 * assembly (objective + claim embedded as escaped data), and the
 * unavailable-fallback behavior for spawn/timeout/parse failures. The spawn
 * is injected — no subprocess runs in tests.
 */

import { describe, expect, it } from "vitest";
import {
	buildEvaluatorPrompt,
	extractJsonObject,
	runGoalEvaluator,
	type EvaluatorSpawn,
} from "../src/evaluator.ts";

function spawnReturning(stdout: string): { spawn: EvaluatorSpawn; calls: { args: string[]; cwd: string }[] } {
	const calls: { args: string[]; cwd: string }[] = [];
	return {
		calls,
		spawn: async (invocation, opts) => {
			calls.push({ args: invocation.args, cwd: opts.cwd });
			return stdout;
		},
	};
}

const COMPLETE_REQUEST = { mode: "complete" as const, objective: "Ship it", claim: "ran the tests; all green" };
const IMPOSSIBLE_REQUEST = { mode: "impossible" as const, objective: "Ship it", claim: "no network access" };
const RUN_OPTS = { cwd: "/tmp/repo" };

describe("extractJsonObject", () => {
	it("parses a clean JSON object", () => {
		expect(extractJsonObject('{"ok": true, "reason": "tests pass"}')).toEqual({
			ok: true,
			reason: "tests pass",
		});
	});

	it("parses fenced and prose-wrapped JSON", () => {
		const fenced = '```json\n{"ok": false, "reason": "missing"}\n```';
		expect(extractJsonObject(fenced)).toEqual({ ok: false, reason: "missing" });
		const wrapped = 'The verdict is: {"ok": true, "reason": "evidence"} — done.';
		expect(extractJsonObject(wrapped)).toEqual({ ok: true, reason: "evidence" });
	});

	it("returns undefined for garbage or non-object JSON", () => {
		expect(extractJsonObject("no json here")).toBeUndefined();
		expect(extractJsonObject('[1, 2, 3]')).toBeUndefined();
		expect(extractJsonObject("")).toBeUndefined();
	});
});

describe("runGoalEvaluator — complete mode", () => {
	it("maps ok:true to confirmed and ok:false to refuted", async () => {
		const confirmed = spawnReturning('{"ok": true, "reason": "npm test exits 0"}');
		const confirmedOutcome = await runGoalEvaluator(COMPLETE_REQUEST, {
			...RUN_OPTS,
			spawn: confirmed.spawn,
		});
		expect(confirmedOutcome).toEqual({ status: "confirmed", reason: "npm test exits 0" });

		const refuted = spawnReturning('{"ok": false, "reason": "build fails: TS2345"}');
		const refutedOutcome = await runGoalEvaluator(COMPLETE_REQUEST, { ...RUN_OPTS, spawn: refuted.spawn });
		expect(refutedOutcome).toEqual({ status: "refuted", reason: "build fails: TS2345" });
	});

	it("embeds the escaped objective and claim in the prompt and runs pi non-interactively", async () => {
		const run = spawnReturning('{"ok": true}');
		await runGoalEvaluator(
			{ mode: "complete", objective: "Fix <the> bug & ship", claim: "evidence with <tags>" },
			{ ...RUN_OPTS, spawn: run.spawn },
		);
		expect(run.calls).toHaveLength(1);
		const { args, cwd } = run.calls[0]!;
		expect(cwd).toBe("/tmp/repo");
		const prompt = args.at(-1)!;
		// getPiInvocation may prefix the current script (node <script> ...);
		// the flags must sit immediately before the prompt either way.
		const flagIndex = args.indexOf("-p");
		expect(flagIndex).toBeGreaterThan(-1);
		expect(args.slice(flagIndex, flagIndex + 2)).toEqual(["-p", "--no-session"]);
		expect(args.at(-1)).toBe(prompt);
		expect(prompt).toContain("&lt;the&gt; bug &amp; ship");
		expect(prompt).toContain("evidence with &lt;tags&gt;");
		expect(prompt).toContain("independent completion evaluator");
	});

	it("treats out-of-contract verdicts as unavailable", async () => {
		const noOk = spawnReturning('{"verdict": "maybe"}');
		expect(await runGoalEvaluator(COMPLETE_REQUEST, { ...RUN_OPTS, spawn: noOk.spawn })).toMatchObject({
			status: "unavailable",
		});
		const notObject = spawnReturning('"ok"');
		expect(await runGoalEvaluator(COMPLETE_REQUEST, { ...RUN_OPTS, spawn: notObject.spawn })).toMatchObject({
			status: "unavailable",
		});
	});
});

describe("runGoalEvaluator — impossible mode", () => {
	it("maps impossible:true/false onto confirmed/refuted", async () => {
		const confirmed = spawnReturning('{"impossible": true, "reason": "self-contradictory condition"}');
		expect(await runGoalEvaluator(IMPOSSIBLE_REQUEST, { ...RUN_OPTS, spawn: confirmed.spawn })).toEqual({
			status: "confirmed",
			reason: "self-contradictory condition",
		});
		const refuted = spawnReturning('{"impossible": false, "reason": "found a workable path"}');
		expect(await runGoalEvaluator(IMPOSSIBLE_REQUEST, { ...RUN_OPTS, spawn: refuted.spawn })).toEqual({
			status: "refuted",
			reason: "found a workable path",
		});
	});

	it("uses the impossibility prompt template", async () => {
		const run = spawnReturning('{"impossible": false}');
		await runGoalEvaluator(IMPOSSIBLE_REQUEST, { ...RUN_OPTS, spawn: run.spawn });
		expect(run.calls[0]!.args.at(-1)).toContain("IMPOSSIBLE");
	});
});

describe("runGoalEvaluator — failure paths", () => {
	it("spawn errors are unavailable; caller aborts rethrow", async () => {
		const failing: EvaluatorSpawn = async () => {
			throw new Error("spawn ENOENT");
		};
		expect(await runGoalEvaluator(COMPLETE_REQUEST, { ...RUN_OPTS, spawn: failing })).toEqual({
			status: "unavailable",
			detail: "spawn ENOENT",
		});

		const abortController = new AbortController();
		const aborting: EvaluatorSpawn = async () => {
			throw new Error("aborted");
		};
		abortController.abort();
		await expect(
			runGoalEvaluator(COMPLETE_REQUEST, {
				...RUN_OPTS,
				spawn: aborting,
				signal: abortController.signal,
			}),
		).rejects.toThrow("goal evaluation aborted");
	});

	it("timeouts surface as unavailable with the timeout detail", async () => {
		const timingOut: EvaluatorSpawn = async () => {
			const err = new Error("Command timed out") as Error & { killed: boolean };
			err.killed = true;
			throw err;
		};
		const outcome = await runGoalEvaluator(COMPLETE_REQUEST, { ...RUN_OPTS, spawn: timingOut });
		expect(outcome).toMatchObject({ status: "unavailable" });
		if (outcome.status === "unavailable") {
			expect(outcome.detail).toContain("timed out");
		}
	});

	it("empty and unparseable output are unavailable", async () => {
		const empty = spawnReturning("   \n");
		expect(await runGoalEvaluator(COMPLETE_REQUEST, { ...RUN_OPTS, spawn: empty.spawn })).toMatchObject({
			status: "unavailable",
			detail: "evaluator produced no output",
		});
		const garbage = spawnReturning("I could not decide.");
		const outcome = await runGoalEvaluator(COMPLETE_REQUEST, { ...RUN_OPTS, spawn: garbage.spawn });
		expect(outcome).toMatchObject({ status: "unavailable" });
		if (outcome.status === "unavailable") {
			expect(outcome.detail).toContain("unparseable evaluator output");
		}
	});
});

describe("buildEvaluatorPrompt", () => {
	it("truncates oversized objectives and claims with a marker", () => {
		const prompt = buildEvaluatorPrompt({
			mode: "complete",
			objective: "x".repeat(5000),
			claim: "y".repeat(9000),
		});
		expect(prompt).toContain("…[truncated]");
		expect(prompt.length).toBeLessThan(20_000);
	});
});
