/**
 * Face-layer tests (B1+B2): the base workflow-subagent system prompt is
 * injected on every dispatch, participates in the cache key, and composes
 * with step overrides / per-step task prompts without duplication.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineWorkflow, runWorkflow } from "../src/index.ts";
import { makeFakeDispatch } from "./e2e/helpers.ts";
import type { AgentSpawnOptions } from "../src/agent/dispatch.ts";

/** Fresh isolated cwd per call — the journal must not leak across tests/runs. */
const tmp = (): string => mkdtempSync(join(tmpdir(), "wf-face-"));

/** Capture the (task, systemPrompt) the dispatch received for each callId. */
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

describe("B1+B2 base workflow-subagent system prompt", () => {
	it("injects the verbatim-discipline system prompt on a plain agent step", async () => {
		const { dispatch, seen } = capturingDispatch();
		const wf = defineWorkflow({ name: "face-plain", steps: [{ id: "a", type: "agent", prompt: "List three sources" }] });
		await runWorkflow({ workflow: wf, cwd: await tmp(), now: 1, dispatch });
		const sp = seen.get("a#1")?.systemPrompt ?? "";
		expect(sp).toContain("workflow orchestration script");
		expect(sp).toMatch(/verbatim/i);
		expect(sp).toMatch(/Done\./); // anti-confirmation discipline
		expect(sp).toMatch(/raw JSON/i);
	});

	it("a step systemPrompt override appends AFTER the base discipline", async () => {
		const { dispatch, seen } = capturingDispatch();
		const wf = defineWorkflow({
			name: "face-override",
			steps: [{ id: "a", type: "agent", prompt: "x", systemPrompt: "You are a TypeScript reviewer" }],
		});
		await runWorkflow({ workflow: wf, cwd: await tmp(), now: 1, dispatch });
		const sp = seen.get("a#1")?.systemPrompt ?? "";
		const baseIdx = sp.indexOf("workflow orchestration script");
		const overIdx = sp.indexOf("You are a TypeScript reviewer");
		expect(baseIdx).toBeGreaterThanOrEqual(0);
		expect(overIdx).toBeGreaterThan(baseIdx); // base first, override after
	});

	it("the base prompt participates in the cache key (same prompt+override → same key)", async () => {
		// Two identical runs in the SAME cwd: the second should be an all-cache-hit
		// resume (zero dispatches), proving the injected systemPrompt is part of the
		// key stably across runs.
		const dir = tmp();
		const { dispatch: d1, seen: s1 } = capturingDispatch();
		const wf = defineWorkflow({ name: "face-cachekey", steps: [{ id: "a", type: "agent", prompt: "do X" }] });
		await runWorkflow({ workflow: wf, cwd: dir, now: 1, dispatch: d1 });
		expect(s1.size).toBe(1);
		const { dispatch: d2, seen: s2 } = capturingDispatch();
		await runWorkflow({ workflow: wf, cwd: dir, now: 2, dispatch: d2 });
		expect(s2.size).toBe(0); // cached — no dispatch
	});

	it("judge task prompt is thinned (no generic 'ONLY JSON' rule) while system prompt carries discipline", async () => {
		const { dispatch, seen } = capturingDispatch();
		const wf = defineWorkflow({
			name: "face-judge",
			steps: [{ id: "adv", type: "adversarial", produce: { prompt: "write fn" }, rubric: ["correct"], judges: 1 }],
		});
		await runWorkflow({ workflow: wf, cwd: await tmp(), now: 1, dispatch });
		const judge = seen.get("adv#judge1");
		expect(judge).toBeDefined();
		// Task prompt keeps the schema request but drops the generic "ONLY JSON" phrasing.
		expect(judge!.task).toContain('"pass"');
		expect(judge!.task).not.toMatch(/Reply with ONLY JSON/);
		// System prompt carries the verbatim / raw-JSON discipline.
		expect(judge!.systemPrompt ?? "").toMatch(/raw JSON/i);
	});
});
