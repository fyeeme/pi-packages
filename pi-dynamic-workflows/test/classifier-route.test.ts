/**
 * classify_route classifier path (spec: workflow-classifier-routing).
 *
 * Covers the pi 0.99 ModelRuntime.classify() routing path end-to-end through
 * runWorkflow's injectable `classify` hook, plus the fallback contract (no
 * classifier / hook failure → the original agent path) and the classifier-hook
 * factory's model discovery and result mapping.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineWorkflow, runWorkflow } from "../src/index.ts";
import { createClassifyHook, type ClassifierRegistrySlice } from "../src/classifier-hook.ts";
import type { ClassifyHook, ClassifyHookResult } from "../src/types.ts";
import { makeFakeDispatch } from "./e2e/helpers.ts";
import type { AgentSpawnOptions } from "../src/agent/dispatch.ts";

const tmp = (): string => mkdtempSync(join(tmpdir(), "wf-cr-"));

function routeWorkflow() {
	return defineWorkflow({
		name: "cr-routes",
		steps: [
			{
				id: "s",
				type: "classify_route",
				classifier: { prompt: "pick a lane" },
				routes: {
					a: [{ id: "a1", type: "agent", prompt: "do a" }],
					b: [{ id: "b1", type: "agent", prompt: "do b" }],
				},
				fallback: [{ id: "f1", type: "agent", prompt: "do fallback" }],
			},
		],
	});
}

/** Dispatch that answers the `#classify` call with a category JSON. */
function agentClassifyDispatch(category: string, seen: Map<string, { task: string }>) {
	return makeFakeDispatch({
		value: (opts: AgentSpawnOptions) => {
			seen.set(opts.callId, { task: opts.task });
			return opts.callId.endsWith("#classify") ? JSON.stringify({ category }) : `out:${opts.task}`;
		},
	});
}

describe("classify_route classifier path (runWorkflow hook)", () => {
	it("classifier decides the route: no #classify dispatch, path recorded", async () => {
		const seen = new Map<string, { task: string }>();
		const dispatch = agentClassifyDispatch("a", seen);
		const hook: ClassifyHook = async () =>
			({ category: "b", usage: { input: 20, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 24, cost: 0.001 } });

		const r = await runWorkflow({ workflow: routeWorkflow(), cwd: tmp(), now: 1, dispatch, classify: hook });

		expect(r.status).toBe("completed");
		const step = r.steps[0]!;
		expect(step.status).toBe("done");
		expect(step.results).toMatchObject({ category: "b", matched: true, path: "classifier" });
		// Only the route sub-step dispatched — the classification itself spawned nothing.
		const callIds = [...seen.keys()];
		expect(callIds.filter((k) => k.includes("#classify"))).toEqual([]);
		expect(callIds.length).toBe(1);
		expect(callIds[0]!.startsWith("b1")).toBe(true);
		// Classifier usage lands in the step stats (truthful accounting):
		// classifier 20/4 + the route sub-step's dispatch 10/5 = 30/9.
		expect(step.stats.tokens).toBeGreaterThanOrEqual(24);
		expect(step.stats.usage).toMatchObject({ input: 30, output: 9 });
	});

	it("hook returning undefined (no classifier) falls back to the agent path", async () => {
		const seen = new Map<string, { task: string }>();
		const dispatch = agentClassifyDispatch("a", seen);
		const hook: ClassifyHook = async () => undefined;

		const r = await runWorkflow({ workflow: routeWorkflow(), cwd: tmp(), now: 1, dispatch, classify: hook });

		expect(r.status).toBe("completed");
		expect(r.steps[0]!.results).toMatchObject({ category: "a", matched: true, path: "agent" });
		const ids1 = [...seen.keys()];
		expect(ids1.length).toBe(2);
		expect(ids1.filter((k) => k.includes("#classify")).length).toBe(1);
		expect(ids1.filter((k) => k.startsWith("a1")).length).toBe(1);
	});

	it("hook throwing falls back to the agent path", async () => {
		const seen = new Map<string, { task: string }>();
		const dispatch = agentClassifyDispatch("b", seen);
		const hook: ClassifyHook = async () => {
			throw new Error("classifier provider 500");
		};

		const r = await runWorkflow({ workflow: routeWorkflow(), cwd: tmp(), now: 1, dispatch, classify: hook });

		expect(r.status).toBe("completed");
		expect(r.steps[0]!.results).toMatchObject({ category: "b", matched: true, path: "agent" });
		const ids2 = [...seen.keys()];
		expect(ids2.length).toBe(2);
		expect(ids2.filter((k) => k.includes("#classify")).length).toBe(1);
		expect(ids2.filter((k) => k.startsWith("b1")).length).toBe(1);
	});

	it("undeclared category on the classifier path resolves through fallback sub-steps", async () => {
		const seen = new Map<string, { task: string }>();
		const dispatch = agentClassifyDispatch("a", seen);
		const hook: ClassifyHook = async () => ({ category: "zzz" });

		const r = await runWorkflow({ workflow: routeWorkflow(), cwd: tmp(), now: 1, dispatch, classify: hook });

		expect(r.status).toBe("completed");
		expect(r.steps[0]!.results).toMatchObject({ category: "zzz", matched: false, path: "classifier" });
		const ids3 = [...seen.keys()];
		expect(ids3.length).toBe(1);
		expect(ids3[0]!.startsWith("f1")).toBe(true);
	});

	it("no hook registered → pure agent path, unchanged", async () => {
		const seen = new Map<string, { task: string }>();
		const dispatch = agentClassifyDispatch("b", seen);

		const r = await runWorkflow({ workflow: routeWorkflow(), cwd: tmp(), now: 1, dispatch });

		expect(r.status).toBe("completed");
		expect(r.steps[0]!.results).toMatchObject({ category: "b", matched: true, path: "agent" });
	});
});

describe("createClassifyHook (model discovery + result mapping)", () => {
	const modelA = { id: "jev-a", provider: "p1" } as never;
	const modelB = { id: "jev-b", provider: "p2" } as never;

	function registry(opts: {
		models?: never[];
		answer?: { choice: string; stopReason?: "stop" | "error"; usage?: never };
		calls?: { classify: Array<{ model: unknown; context: unknown }> };
	}): ClassifierRegistrySlice {
		return {
			getAvailableOfType: async () => opts.models ?? [],
			classify: async (model: never, context: never) => {
				opts.calls?.classify.push({ model, context });
				return {
					api: "classify" as never,
					provider: "p1" as never,
					model: (model as { id: string }).id,
					answers: opts.answer ? { route: { type: "choice" as const, choice: opts.answer.choice, probabilities: {}, confidence: 1 } } : {},
					usage: opts.answer?.usage,
					stopReason: opts.answer?.stopReason ?? "stop",
					timestamp: 0,
				} as never;
			},
		};
	}

	it("returns undefined when the host has no classifier model", async () => {
		const hook = createClassifyHook(registry({}));
		await expect(hook("p", ["a", "b"])).resolves.toBeUndefined();
	});

	it("classifies with the first available model; criteria are the route names", async () => {
		const calls: { classify: Array<{ model: unknown; context: unknown }> } = { classify: [] };
		const usage = { input: 3, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 6, cost: { total: 0.0005 } } as never;
		const hook = createClassifyHook(registry({ models: [modelA, modelB], answer: { choice: "b", usage }, calls }));

		const result = await hook("prompt", ["a", "b"], undefined);

		expect(result).toMatchObject({ category: "b", usage: { input: 3, output: 2, totalTokens: 6, cost: 0.0005 } });
		expect(calls.classify[0]!.model).toBe(modelA);
		const context = calls.classify[0]!.context as { state: { routes: string[] }; questions: Record<string, { criteria: Record<string, string> }> };
		expect(context.state.routes).toEqual(["a", "b"]);
		expect(context.questions.route!.criteria).toEqual({ a: "a", b: "b" });
	});

	it("prefers a step-declared model that is a classifier; ignores one that is not", async () => {
		const calls: { classify: Array<{ model: unknown; context: unknown }> } = { classify: [] };
		const hook = createClassifyHook(registry({ models: [modelA, modelB], answer: { choice: "a" }, calls }));

		await hook("p", ["a", "b"], "jev-b");
		expect(calls.classify[0]!.model).toBe(modelB);

		await hook("p", ["a", "b"], "claude-haiku"); // chat id — not among classifiers
		expect(calls.classify[1]!.model).toBe(modelA);
	});

	it("a non-stop classifier result falls back (undefined)", async () => {
		const hook = createClassifyHook(registry({ models: [modelA], answer: { choice: "a", stopReason: "error" } }));
		await expect(hook("p", ["a"])).resolves.toBeUndefined();
	});

	it("a hook result object satisfies ClassifyHookResult without usage", async () => {
		const hook = createClassifyHook(registry({ models: [modelA], answer: { choice: "a" } }));
		const r: ClassifyHookResult | undefined = await hook("p", ["a"]);
		expect(r).toEqual({ category: "a" });
	});
});
