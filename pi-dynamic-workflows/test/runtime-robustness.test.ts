/**
 * Runtime-robustness tests (A5 taxonomy, A6 size/policy guards, A3 null-mode).
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineWorkflow, runWorkflow } from "../src/index.ts";
import { BudgetExceededError } from "../src/budget/index.ts";
import { DeterminismError } from "../src/determinism/ast-guard.ts";
import { WorkflowError } from "../src/errors.ts";
import { makeFakeDispatch } from "./e2e/helpers.ts";
import type { AgentSpawnOptions, AgentSpawnResult } from "../src/agent/dispatch.ts";
import type { Message } from "@earendil-works/pi-ai";

const tmp = (): string => mkdtempSync(join(tmpdir(), "wf-rr-"));

function capturingDispatch(): { dispatch: ReturnType<typeof makeFakeDispatch>; seen: Map<string, { task: string; systemPrompt?: string }>; } {
	const seen = new Map<string, { task: string; systemPrompt?: string }>();
	const dispatch = makeFakeDispatch({
		value: (opts: AgentSpawnOptions) => {
			seen.set(opts.callId, { task: opts.task, systemPrompt: opts.systemPrompt });
			return `out:${opts.task}`;
		},
	});
	return { dispatch, seen };
}

describe("A5 error taxonomy", () => {
	it("BudgetExceededError is a WorkflowError with the budget-exceeded category", () => {
		const e = new BudgetExceededError("x");
		expect(e).toBeInstanceOf(WorkflowError);
		expect(e.category).toBe("budget-exceeded");
	});

	it("DeterminismError is a WorkflowError with the determinism category", () => {
		const e = new DeterminismError("x");
		expect(e).toBeInstanceOf(WorkflowError);
		expect(e.category).toBe("determinism");
	});
});

describe("A6 input size and policy guards", () => {
	it("rejects an oversized prompt before any spawn (size-limit)", async () => {
		const { dispatch, seen } = capturingDispatch();
		const wf = defineWorkflow({ name: "rr-size", steps: [{ id: "a", type: "agent", prompt: "x".repeat(100) }] });
		const r = await runWorkflow({ workflow: wf, cwd: tmp(), now: 1, dispatch, maxPromptBytes: 8 });
		expect(r.status).toBe("failed");
		expect(r.error ?? "").toMatch(/exceeds limit/);
		expect(seen.size).toBe(0); // nothing dispatched
	});

	it("rejects non-printable control characters in the prompt", async () => {
		const { dispatch, seen } = capturingDispatch();
		const wf = defineWorkflow({ name: "rr-ctrl", steps: [{ id: "a", type: "agent", prompt: "hello\x00world" }] });
		const r = await runWorkflow({ workflow: wf, cwd: tmp(), now: 1, dispatch });
		expect(r.status).toBe("failed");
		expect(r.error ?? "").toMatch(/control char/i);
		expect(seen.size).toBe(0);
	});

	it("rejects bidi / zero-width / C1 / BOM format characters (injection vectors)", async () => {
		for (const [label, ch] of [
			["bidi RLO", "\u202e"],
			["bidi LRI", "\u2066"],
			["zero-width space", "\u200b"],
			["zero-width joiner", "\u200d"],
			["C1 NEL", "\u0085"],
			["BOM", "\ufeff"],
		] as const) {
			const { dispatch, seen } = capturingDispatch();
			const wf = defineWorkflow({ name: `rr-ctrl-${label}`, steps: [{ id: "a", type: "agent", prompt: `x${ch}y` }] });
			const r = await runWorkflow({ workflow: wf, cwd: tmp(), now: 1, dispatch });
			expect(r.status, `${label} must be rejected`).toBe("failed");
			expect(r.error ?? "", label).toMatch(/control char/i);
			expect(seen.size, label).toBe(0);
		}
	});

	it("rejects control characters in the systemPrompt too (no prompt-side dodge)", async () => {
		const { dispatch, seen } = capturingDispatch();
		const wf = defineWorkflow({
			name: "rr-sys-ctrl",
			steps: [{ id: "a", type: "agent", prompt: "clean prompt", systemPrompt: "good\u0000bad" }],
		});
		const r = await runWorkflow({ workflow: wf, cwd: tmp(), now: 1, dispatch });
		expect(r.status).toBe("failed");
		expect(r.error ?? "").toMatch(/control char/i);
		expect(seen.size).toBe(0);
	});

	it("rejects an oversized systemPrompt (size-limit covers both payloads)", async () => {
		const { dispatch, seen } = capturingDispatch();
		const wf = defineWorkflow({
			name: "rr-sys-size",
			steps: [{ id: "a", type: "agent", prompt: "clean prompt", systemPrompt: "x".repeat(100) }],
		});
		const r = await runWorkflow({ workflow: wf, cwd: tmp(), now: 1, dispatch, maxPromptBytes: 8 });
		expect(r.status).toBe("failed");
		expect(r.error ?? "").toMatch(/exceeds limit/);
		expect(seen.size).toBe(0); // nothing dispatched
	});

	it("maxDurationMs does not instantly exhaust under a deterministic now (wall-clock origin)", async () => {
		const { dispatch } = capturingDispatch();
		const wf = defineWorkflow({ name: "rr-dur", steps: [{ id: "a", type: "agent", prompt: "p" }] });
		// now: 1 is the documented deterministic inception — with a wall-clock
		// maxDurationMs budget the run must COMPLETE, not read as already-exhausted
		// (originMs must be Date.now(), not the caller's deterministic `now`).
		const r = await runWorkflow({ workflow: wf, cwd: tmp(), now: 1, dispatch, budget: { maxDurationMs: 60_000 } });
		expect(r.status).toBe("completed");
	});

	it("policy-gate denial aborts the run before any dispatch", async () => {
		const { dispatch, seen } = capturingDispatch();
		const wf = defineWorkflow({ name: "rr-gate", steps: [{ id: "a", type: "agent", prompt: "x" }] });
		const r = await runWorkflow({
			workflow: wf,
			cwd: tmp(),
			now: 1,
			dispatch,
			policyGate: async () => ({ allow: false, reason: "denied by test gate" }),
		});
		expect(r.status).toBe("failed");
		expect(r.error).toBe("denied by test gate");
		expect(seen.size).toBe(0);
	});
});

describe("A5 error category wiring", () => {
	it("surfaces errorCategory=dispatch-error when dispatch rejects (spawn failure)", async () => {
		const dispatch = async (_registry: never, _opts: AgentSpawnOptions): Promise<AgentSpawnResult> => {
			throw new Error("spawn ENOENT");
		};
		const wf = defineWorkflow({ name: "rr-dispatch-reject", steps: [{ id: "a", type: "agent", prompt: "x" }] });
		const r = await runWorkflow({ workflow: wf, cwd: tmp(), now: 1, dispatch: dispatch as never });
		expect(r.status).toBe("failed");
		expect(r.errorCategory).toBe("dispatch-error");
		expect(r.error ?? "").toMatch(/dispatch error/);
	});

	it("surfaces errorCategory=dispatch-error when the subprocess settles failed", async () => {
		const dispatch = async (_registry: never, opts: AgentSpawnOptions): Promise<AgentSpawnResult> => ({
			callId: opts.callId,
			exitCode: 1,
			messages: [],
			stderr: "provider 503",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			stopReason: "error",
			errorMessage: "upstream unavailable",
			aborted: false,
			maxTurnsReached: false,
		});
		const wf = defineWorkflow({ name: "rr-settled-fail", steps: [{ id: "a", type: "agent", prompt: "x" }] });
		const r = await runWorkflow({ workflow: wf, cwd: tmp(), now: 1, dispatch: dispatch as never });
		expect(r.status).toBe("failed");
		expect(r.errorCategory).toBe("dispatch-error");
	});

	it("does NOT retry a code step whose transform throws (deterministic failure)", async () => {
		let calls = 0;
		const { dispatch } = capturingDispatch();
		const wf = defineWorkflow({
			name: "rr-code-no-retry",
			steps: [
				{
					id: "c",
					type: "code",
					transform: () => {
						calls++;
						throw new Error("deterministic boom");
					},
					retry: { maxRetries: 2 },
				},
			],
		});
		const r = await runWorkflow({ workflow: wf, cwd: tmp(), now: 1, dispatch });
		expect(r.status).toBe("failed");
		expect(calls).toBe(1); // transform ran exactly once — no budget burned on a deterministic re-run
		expect(r.errorCategory).toBeUndefined();
	});

	it("propagates errorCategory through classify_route route steps", async () => {
		// Classifier settles ok and picks category "x"; the routed step's dispatch rejects.
		const dispatch = async (_registry: never, opts: AgentSpawnOptions): Promise<AgentSpawnResult> => {
			if (opts.callId.includes("#classify")) {
				return {
					callId: opts.callId,
					exitCode: 0,
					messages: [
						{
							role: "assistant",
							content: [{ type: "text", text: '{"category":"x"}' }],
							usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 }, totalTokens: 2 },
							model: "fake",
							stopReason: "stop",
						} as unknown as Message,
					],
					stderr: "",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 2, turns: 1 },
					model: "fake",
					stopReason: "stop",
					aborted: false,
					maxTurnsReached: false,
				};
			}
			throw new Error("route dispatch boom");
		};
		const wf = defineWorkflow({
			name: "rr-classify-prop",
			steps: [
				{
					id: "cl",
					type: "classify_route",
					classifier: { prompt: "classify it", model: "fake" },
					routes: { x: [{ id: "inner", type: "agent", prompt: "inner" }] },
					fallback: [],
				},
			],
		});
		const r = await runWorkflow({ workflow: wf, cwd: tmp(), now: 1, dispatch: dispatch as never });
		expect(r.status).toBe("failed");
		expect(r.errorCategory).toBe("dispatch-error");
	});
});

describe("A3 retry and token budget (throw path)", () => {
	it("retries a dispatch-error step up to maxRetries and succeeds", async () => {
		let attempts = 0;
		const dispatch = async (_registry: never, opts: AgentSpawnOptions): Promise<AgentSpawnResult> => {
			attempts++;
			if (attempts === 1) {
				return {
					callId: opts.callId,
					exitCode: 1,
					messages: [],
					stderr: "",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					stopReason: "error",
					errorMessage: "transient boom",
					aborted: false,
					maxTurnsReached: false,
				};
			}
			return {
				callId: opts.callId,
				exitCode: 0,
				messages: [
					{
						role: "assistant",
						content: [{ type: "text", text: "ok" }],
						usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0 }, totalTokens: 15 },
						model: "fake",
						stopReason: "stop",
					} as unknown as Message,
				],
				stderr: "",
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 15, turns: 1 },
				model: "fake",
				stopReason: "stop",
				aborted: false,
				maxTurnsReached: false,
			};
		};
		const wf = defineWorkflow({
			name: "rr-retry",
			steps: [{ id: "a", type: "agent", prompt: "x", retry: { maxRetries: 2 } }],
		});
		const r = await runWorkflow({ workflow: wf, cwd: tmp(), now: 1, dispatch: dispatch as never });
		expect(r.status).toBe("completed");
		expect(attempts).toBe(2); // first failed, second succeeded
		expect(r.steps[0]?.stats.failures).toBe(1);
	});

	it("gives up after maxRetries exhausted (dispatch keeps failing)", async () => {
		let attempts = 0;
		const dispatch = async (_registry: never, opts: AgentSpawnOptions): Promise<AgentSpawnResult> => {
			attempts++;
			return {
				callId: opts.callId,
				exitCode: 1,
				messages: [],
				stderr: "",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				stopReason: "error",
				errorMessage: "always boom",
				aborted: false,
				maxTurnsReached: false,
			};
		};
		const wf = defineWorkflow({
			name: "rr-retry-exhaust",
			steps: [{ id: "a", type: "agent", prompt: "x", retry: { maxRetries: 2 } }],
		});
		const r = await runWorkflow({ workflow: wf, cwd: tmp(), now: 1, dispatch: dispatch as never });
		expect(r.status).toBe("failed");
		expect(attempts).toBe(3); // initial + 2 retries
	});

	it("token budget exhaustion aborts a later sequential step under the default throw policy", async () => {
		const { dispatch } = capturingDispatch(); // each call settles 15 tokens (10 in + 5 out)
		const wf = defineWorkflow({
			name: "rr-tokens",
			budget: { maxTokens: 20 },
			steps: [
				{ id: "a", type: "agent", prompt: "1" },
				{ id: "b", type: "agent", prompt: "2" },
				{ id: "c", type: "agent", prompt: "3" },
			],
		});
		const r = await runWorkflow({ workflow: wf, cwd: tmp(), now: 1, dispatch });
		expect(r.status).toBe("failed");
		expect(r.error ?? "").toMatch(/budget|exhausted/i);
		expect(r.errorCategory).toBe("budget-exceeded");
	});

	it("token budget exhaustion degrades a later sequential step under the null policy", async () => {
		const { dispatch } = capturingDispatch();
		const wf = defineWorkflow({
			name: "rr-tokens-null",
			budget: { maxTokens: 20 },
			steps: [
				{ id: "a", type: "agent", prompt: "1" },
				{ id: "b", type: "agent", prompt: "2" },
				{ id: "c", type: "agent", prompt: "3", onBudgetExhaust: "null" },
			],
		});
		const r = await runWorkflow({ workflow: wf, cwd: tmp(), now: 1, dispatch });
		expect(r.status).toBe("completed");
		expect(r.degradedSteps).toEqual(["c"]);
		expect(r.steps[2]?.results).toBeNull();
	});

	it("policy-gate denial surfaces the policy-gate category", async () => {
		const { dispatch, seen } = capturingDispatch();
		const wf = defineWorkflow({ name: "rr-gate-cat", steps: [{ id: "a", type: "agent", prompt: "x" }] });
		const r = await runWorkflow({
			workflow: wf,
			cwd: tmp(),
			now: 1,
			dispatch,
			policyGate: async () => ({ allow: false, reason: "denied" }),
		});
		expect(r.status).toBe("failed");
		expect(r.errorCategory).toBe("policy-gate");
		expect(seen.size).toBe(0);
	});

	it("size-limit rejection surfaces its category on the run result", async () => {
		const { dispatch, seen } = capturingDispatch();
		const wf = defineWorkflow({ name: "rr-size-cat", steps: [{ id: "a", type: "agent", prompt: "x".repeat(100) }] });
		const r = await runWorkflow({ workflow: wf, cwd: tmp(), now: 1, dispatch, maxPromptBytes: 8 });
		expect(r.status).toBe("failed");
		expect(r.errorCategory).toBe("size-limit");
		expect(seen.size).toBe(0);
	});
});

describe("A3 per-step budget-exhaustion policy", () => {
	it("null-mode fan_out degrades excess items instead of aborting", async () => {
		const { dispatch, seen } = capturingDispatch();
		const wf = defineWorkflow({
			name: "rr-null",
			budget: { maxAgents: 2 },
			steps: [
				{ id: "fan", type: "fan_out", over: () => [1, 2, 3], agent: (i) => ({ prompt: `item ${i}` }), onBudgetExhaust: "null" },
			],
		});
		const r = await runWorkflow({ workflow: wf, cwd: tmp(), now: 1, dispatch });
		expect(r.status).toBe("completed");
		expect(seen.size).toBe(2); // only 2 fit the maxAgents:2 lifetime cap
		expect(r.degradedSteps).toEqual(["fan"]);
		const results = r.steps[0].results as unknown[];
		expect(results).toHaveLength(3);
		expect(results.filter((x) => x === null).length).toBe(1); // the degraded slot
	});

	it("a default (throw) step after an exhausted budget still aborts — critical steps stay strict", async () => {
		const { dispatch, seen } = capturingDispatch();
		const wf = defineWorkflow({
			name: "rr-strict",
			budget: { maxAgents: 2 },
			steps: [
				{ id: "fan", type: "fan_out", over: () => [1, 2, 3], agent: (i) => ({ prompt: `${i}` }), onBudgetExhaust: "null" },
				{ id: "produce", type: "agent", prompt: "produce" }, // default throw
			],
		});
		const r = await runWorkflow({ workflow: wf, cwd: tmp(), now: 1, dispatch });
		expect(r.status).toBe("failed"); // produce hit the exhausted budget and threw
		expect(r.degradedSteps).toEqual(["fan"]); // fan degraded, produce did not
		expect(seen.has("produce#1")).toBe(false); // produce never dispatched
	});
});

describe("C · budget cap semantics (spawn-gate soft limits)", () => {
	it("throw-policy fan_out over capacity fails budget-exceeded before any dispatch (C4)", async () => {
		const { dispatch, seen } = capturingDispatch();
		const wf = defineWorkflow({
			name: "c4-fan-throw",
			budget: { maxAgents: 2 },
			steps: [{ id: "fan", type: "fan_out", over: () => [1, 2, 3], agent: (i) => ({ prompt: `item ${i}` }) }],
		});
		const r = await runWorkflow({ workflow: wf, cwd: tmp(), now: 1, dispatch });
		expect(r.status).toBe("failed");
		expect(r.errorCategory).toBe("budget-exceeded");
		expect(seen.size).toBe(0); // guardBatch refused the whole batch before any spawn
	});

	it("a single in-flight agent may exceed the token cap (soft limit, not a hard kill)", async () => {
		// No 4th item exists to trigger a guardSpawn check, so the cap is not
		// enforced as a hard kill — the lone agent completes and its spend is recorded.
		const { dispatch } = capturingDispatch();
		const wf = defineWorkflow({
			name: "c4-soft",
			budget: { maxTokens: 1 },
			steps: [{ id: "a", type: "agent", prompt: "x" }],
		});
		const r = await runWorkflow({ workflow: wf, cwd: tmp(), now: 1, dispatch });
		expect(r.status).toBe("completed"); // soft cap: spend (15) exceeds maxTokens (1) but the agent wasn't killed
		expect(r.stats.tokens).toBe(15);
	});
});

describe("D · path guard + code step coverage", () => {
	it("rejects a workflow name that escapes the workflow dir (D9)", async () => {
		const { dispatch } = capturingDispatch();
		const wf = defineWorkflow({ name: "..", steps: [{ id: "a", type: "agent", prompt: "x" }] });
		await expect(runWorkflow({ workflow: wf, cwd: tmp(), now: 1, dispatch })).rejects.toThrow(/invalid characters/);
	});

	it("rejects names with separators / control chars (D9)", async () => {
		const { dispatch } = capturingDispatch();
		for (const name of ["a/b", "a\\b", "a\u0000b"]) {
			const wf = defineWorkflow({ name, steps: [{ id: "a", type: "agent", prompt: "x" }] });
			await expect(runWorkflow({ workflow: wf, cwd: tmp(), now: 1, dispatch })).rejects.toThrow(/invalid characters/);
		}
	});

	it("code step runs the transform synchronously with zero tokens (D10)", async () => {
		const { dispatch } = capturingDispatch();
		const wf = defineWorkflow({
			name: "d10-code",
			steps: [{ id: "score", type: "code", transform: () => [1, 2, 3].map((i) => i * 2) }],
		});
		const r = await runWorkflow({ workflow: wf, cwd: tmp(), now: 1, dispatch });
		expect(r.status).toBe("completed");
		expect(r.steps[0]?.results).toEqual([2, 4, 6]);
		expect(r.steps[0]?.stats.tokens).toBe(0);
	});

	it("code step transform error surfaces as a failed step (D10)", async () => {
		const { dispatch } = capturingDispatch();
		const wf = defineWorkflow({
			name: "d10-code-err",
			steps: [{ id: "boom", type: "code", transform: () => { throw new Error("nope"); } }],
		});
		const r = await runWorkflow({ workflow: wf, cwd: tmp(), now: 1, dispatch });
		expect(r.status).toBe("failed");
		expect(r.error ?? "").toMatch(/code error: nope/);
	});
});

describe("D11 · step model applies to judges", () => {
	/** A dispatch that records the model each call was sent with. */
	function modelCapturingDispatch(): { dispatch: ReturnType<typeof makeFakeDispatch>; seen: Map<string, string | undefined> } {
		const seen = new Map<string, string | undefined>();
		const dispatch = makeFakeDispatch({
			value: (opts) => {
				seen.set(opts.callId, opts.model);
				return '{"pass":true,"reason":"ok"}';
			},
		});
		return { dispatch, seen };
	}

	it("adversarial produce.model is inherited by every judge", async () => {
		const { dispatch, seen } = modelCapturingDispatch();
		const wf = defineWorkflow({
			name: "d11-adv",
			steps: [
				{ id: "adv", type: "adversarial", produce: { prompt: "candidate", model: "judge-model-X" }, rubric: ["x"], judges: 3 },
			],
		});
		const r = await runWorkflow({ workflow: wf, cwd: tmp(), now: 1, dispatch });
		expect(r.status).toBe("completed");
		expect(seen.get("adv#produce")).toBe("judge-model-X");
		expect(seen.get("adv#judge1")).toBe("judge-model-X");
		expect(seen.get("adv#judge2")).toBe("judge-model-X");
		expect(seen.get("adv#judge3")).toBe("judge-model-X");
	});

	it("an explicit judge.model overrides, per-field, for judges only", async () => {
		const { dispatch, seen } = modelCapturingDispatch();
		const wf = defineWorkflow({
			name: "d11-adv-override",
			steps: [
				{
					id: "adv",
					type: "adversarial",
					produce: { prompt: "candidate", model: "produce-M" },
					rubric: ["x"],
					judges: 2,
					judge: { model: "judge-M" },
				},
			],
		});
		await runWorkflow({ workflow: wf, cwd: tmp(), now: 1, dispatch });
		expect(seen.get("adv#produce")).toBe("produce-M"); // produce unchanged
		expect(seen.get("adv#judge1")).toBe("judge-M"); // judge override wins
		expect(seen.get("adv#judge2")).toBe("judge-M");
	});

	it("tournament produce.model is inherited by every judge", async () => {
		const { dispatch, seen } = modelCapturingDispatch();
		const wf = defineWorkflow({
			name: "d11-tour",
			steps: [
				{ id: "tour", type: "tournament", produce: { prompt: "candidate", model: "tour-M" }, candidates: 2, judges: 2 },
			],
		});
		await runWorkflow({ workflow: wf, cwd: tmp(), now: 1, dispatch });
		expect(seen.get("tour#cand1")).toBe("tour-M");
		expect(seen.get("tour#judge1")).toBe("tour-M");
		expect(seen.get("tour#judge2")).toBe("tour-M");
	});
});

describe("lifecycle listener error isolation", () => {
	it("a throwing onUpdate listener does not break the run (warn + continue)", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const dispatch = makeFakeDispatch({
				value: (opts) => {
					opts.onUpdate?.("delta");
					return "out";
				},
			});
			const wf = defineWorkflow({ name: "rr-bad-listener", steps: [{ id: "a", type: "agent", prompt: "x" }] });
			const r = await runWorkflow({
				workflow: wf,
				cwd: tmp(),
				now: 1,
				dispatch,
				listeners: {
					onUpdate() {
						throw new Error("listener boom");
					},
				},
			});
			expect(r.status).toBe("completed");
			expect(warnSpy).toHaveBeenCalled();
			expect(String(warnSpy.mock.calls[0]?.[0] ?? "")).toMatch(/onUpdate listener threw/);
		} finally {
			warnSpy.mockRestore();
		}
	});
});

describe("A3 fan_out failure terminates hung in-flight siblings (fail-fast abort)", () => {
	it("aborts a hung sibling when another item errors — no permanent hang", async () => {
		// fan#1 hangs until its per-call controller aborts; fan#2 errors. The
		// failure must abort fan#1 (SIGTERM via the registry controller) so the
		// run fails fast instead of waiting forever on the stalled subprocess.
		const dispatch = makeFakeDispatch({ hang: new Set(["fan#1"]), errors: new Set(["fan#2"]) });
		const wf = defineWorkflow({
			name: "rr-fan-hang",
			steps: [{ id: "fan", type: "fan_out", over: () => [1, 2], agent: (i) => ({ prompt: `p${i}` }), parallelism: 2 }],
		});
		const r = await runWorkflow({ workflow: wf, cwd: tmp(), now: 1, dispatch });
		expect(r.status).toBe("failed");
		expect(r.error ?? "").toMatch(/fan/);
	});
});
