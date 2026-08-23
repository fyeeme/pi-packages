/**
 * Lifecycle-listener contract tests (C2 log step, A8/C4 per-call model, C3
 * streaming bridge, live output capture).
 *
 * The former progress-widget / /wf-inspect tests were removed together with
 * those surfaces (live progress now renders via the shared
 * @fyeeme/pi-subagent-core extension); the engine-level listener contracts
 * they covered are kept here, plus the displayName contract for the shared
 * monitor UI.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineWorkflow, runWorkflow } from "../src/index.ts";
import { makeFakeDispatch } from "./e2e/helpers.ts";
import type { AgentSpawnOptions } from "../src/agent/dispatch.ts";

const tmp = (): string => mkdtempSync(join(tmpdir(), "wf-ui-"));

/** Fake dispatch that stamps a fixed model on every result (A8/C4). */
function modelDispatch(model: string): ReturnType<typeof makeFakeDispatch> {
	return makeFakeDispatch({
		value: (_opts: AgentSpawnOptions) => "out",
		model,
	});
}

describe("C2 log step", () => {
	it("fires onLog with (stepId, message) and records zero-token stats", async () => {
		const seen: { stepId: string; message: string }[] = [];
		const wf = defineWorkflow({
			name: "ui-log",
			steps: [
				{ id: "gather", type: "agent", prompt: "gather" },
				{ id: "note", type: "log", message: "Phase 1 complete, 50 sources gathered" },
				{ id: "draft", type: "agent", prompt: "draft" },
			],
		});
		const r = await runWorkflow({
			workflow: wf,
			cwd: tmp(),
			now: 1,
			dispatch: makeFakeDispatch(),
			listeners: {
				onLog(stepId, message) {
					seen.push({ stepId, message });
				},
			},
		});
		expect(seen).toEqual([{ stepId: "note", message: "Phase 1 complete, 50 sources gathered" }]);
		const note = r.steps.find((s) => s.id === "note");
		expect(note?.type).toBe("log");
		expect(note?.status).toBe("done");
		expect(note?.stats.tokens).toBe(0);
		expect(note?.stats.agents).toBe(0);
	});
});

describe("A8/C4 per-call model on onAgentEnd", () => {
	it("onAgentEnd carries the serving model from the spawn result", async () => {
		const models: string[] = [];
		const wf = defineWorkflow({ name: "ui-model", steps: [{ id: "a", type: "agent", prompt: "x" }] });
		await runWorkflow({
			workflow: wf,
			cwd: tmp(),
			now: 1,
			dispatch: modelDispatch("anthropic/claude-haiku-4-5"),
			listeners: {
				onAgentEnd(_callId, _ok, _stats, model) {
					if (model) models.push(model);
				},
			},
		});
		expect(models).toEqual(["anthropic/claude-haiku-4-5"]);
	});
});

describe("C3 streaming bridge", () => {
	it("dispatchAgentCall forwards spawn deltas to the lifecycle onUpdate listener", async () => {
		const seen: { callId: string; partial: string }[] = [];
		const dispatch = makeFakeDispatch({
			value: (opts) => {
				// Emulate a subprocess emitting two message_update deltas mid-call.
				opts.onUpdate?.("Hel");
				opts.onUpdate?.("lo");
				return "out";
			},
		});
		const wf = defineWorkflow({ name: "ui-stream", steps: [{ id: "a", type: "agent", prompt: "x" }] });
		const r = await runWorkflow({
			workflow: wf,
			cwd: tmp(),
			now: 1,
			dispatch,
			listeners: {
				onUpdate(callId, partial) {
					seen.push({ callId, partial });
				},
			},
		});
		expect(seen).toEqual([
			{ callId: "a#1", partial: "Hel" },
			{ callId: "a#1", partial: "lo" },
		]);
		expect(r.status).toBe("completed");
	});

	it("no onUpdate listener → spawn gets no bridge and run is unaffected", async () => {
		const dispatch = makeFakeDispatch({
			value: (opts) => {
				expect(opts.onUpdate).toBeUndefined();
				return "out";
			},
		});
		const wf = defineWorkflow({ name: "ui-stream-none", steps: [{ id: "a", type: "agent", prompt: "x" }] });
		const r = await runWorkflow({ workflow: wf, cwd: tmp(), now: 1, dispatch });
		expect(r.status).toBe("completed");
	});
});

describe("live output capture", () => {
	it("onAgentEnd carries the settled agent's output text", async () => {
		const outputs: string[] = [];
		const wf = defineWorkflow({ name: "ui-live-out", steps: [{ id: "a", type: "agent", prompt: "x" }] });
		await runWorkflow({
			workflow: wf,
			cwd: tmp(),
			now: 1,
			dispatch: makeFakeDispatch({ value: () => "REAL agent output" }),
			listeners: {
				onAgentEnd(_callId, _ok, _stats, _model, output) {
					if (output) outputs.push(output);
				},
			},
		});
		expect(outputs).toEqual(["REAL agent output"]);
	});
});

describe("shared-monitor displayName (pi-subagent-core UI)", () => {
	it("dispatches carry displayName = step id for the shared agent widget", async () => {
		const names = new Map<string, string | undefined>();
		const dispatch = makeFakeDispatch({
			value: (opts: AgentSpawnOptions) => {
				names.set(opts.callId, opts.displayName);
				return "out";
			},
		});
		const wf = defineWorkflow({
			name: "ui-display-name",
			steps: [
				{
					id: "fan",
					type: "fan_out",
					over: () => ["a", "b"],
					agent: (item) => ({ prompt: `Research ${item}.` }),
				},
			],
		});
		const r = await runWorkflow({ workflow: wf, cwd: tmp(), now: 1, dispatch });
		expect(r.status).toBe("completed");
		// Both fan_out item calls carry the STEP id ("fan"), not the raw callId.
		expect(names.get("fan#1")).toBe("fan");
		expect(names.get("fan#2")).toBe("fan");
	});
});
