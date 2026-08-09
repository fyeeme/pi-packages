/**
 * Progress-UI tests (C1 phases, A8/C4 per-call model, C2 log step).
 *
 * The widget itself (index.ts) needs a TUI mock, so these tests cover the
 * contract boundaries: the log step fires onLog with zero stats, onAgentEnd
 * carries the serving model, and WorkflowInspect renders phase headers.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineWorkflow, runWorkflow } from "../src/index.ts";
import { buildProgressWidget } from "../index.ts";
import { WorkflowInspect } from "../src/inspect.ts";
import { makeFakeDispatch } from "./e2e/helpers.ts";
import type { AgentSpawnOptions, AgentSpawnResult } from "../src/agent/dispatch.ts";
import type { RunResult } from "../src/types.ts";

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

describe("C1 phase grouping in WorkflowInspect", () => {
	const tui = { requestRender: () => {}, terminal: { rows: 24 } };
	const close = () => {};

	function resultOf(ids: string[]): RunResult {
		return {
			runId: "r1",
			status: "completed",
			steps: ids.map((id) => ({
				id,
				type: "agent" as const,
				status: "done" as const,
				results: "out",
				stats: { tokens: 10, cost: 0, durationMs: 1, agents: 1, failures: 0 },
			})),
			stats: { tokens: 20, cost: 0, durationMs: 2, agents: 2, failures: 0 },
		};
	}

	it("renders phase headers and indents grouped steps", () => {
		const r = resultOf(["gather", "draft", "refine"]);
		const insp = new WorkflowInspect(
			r,
			tui,
			close,
			[
				{ title: "Research", stepIds: ["gather"] },
				{ title: "Draft", stepIds: ["draft", "refine"] },
			],
		);
		const out = insp.render(80).join("\n");
		expect(out).toContain("Research");
		expect(out).toContain("Draft");
		// Steps are indented under phase headers (4 spaces), header lines are not.
		const lines = out.split("\n");
		// gather renders as a step row (the phase header row carries no step text).
		expect(lines.find((l) => l.includes("gather"))).toBeDefined();
		expect(lines.find((l) => l.includes("Research") && !l.includes("gather"))).toBeDefined();
	});

	it("stays flat when no phases are declared", () => {
		const r = resultOf(["a", "b"]);
		const insp = new WorkflowInspect(r, tui, close);
		const out = insp.render(80).join("\n");
		expect(out).not.toContain("Research"); // no phase headers when none are declared
		expect(out).toContain("a");
		expect(out).toContain("b");
	});
});

describe("live snapshot output capture (fix: detail pane showed fabricated progress)", () => {
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

	it("detail pane renders undefined results as an honest in-progress marker, not 'undefined'", () => {
		const tui2 = { requestRender: () => {}, terminal: { rows: 24 } };
		const r: RunResult = {
			runId: "live",
			status: "completed",
			steps: [
				{
					id: "fan",
					type: "fan_out",
					status: "running",
					results: undefined,
					stats: { tokens: 0, cost: 0, durationMs: 0, agents: 0, failures: 0 },
				},
			],
			stats: { tokens: 0, cost: 0, durationMs: 0, agents: 0, failures: 0 },
		};
		const insp = new WorkflowInspect(r, tui2, () => {});
		const out = insp.render(80).join("\n");
		expect(out).not.toContain("undefined");
		expect(out).toContain("in progress");
	});
});

describe("buildProgressWidget — terminal-state ordering", () => {
	it("onAgentEnd does not overwrite a skipped call with failed", () => {
		const seen: (string[] | undefined)[] = [];
		const widget = buildProgressWidget(
			[{ id: "a", type: "agent" }],
			(lines) => seen.push(lines),
			() => {},
		);
		widget.onAgentStart!("a#1"); // running
		widget.onAgentSkip!("a#1"); // external skip → skipped
		widget.onAgentEnd!("a#1", false); // the aborted subprocess settles — must NOT stamp failed
		const snap = widget.snapshot();
		expect(snap.steps[0]?.status).toBe("skipped");
		const rendered = seen.at(-1)?.join("\n") ?? "";
		expect(rendered).toContain("⏭");
		expect(rendered).not.toContain("✗");
	});

	it("onAgentEnd does not overwrite a retried call with failed", () => {
		const widget = buildProgressWidget([{ id: "a", type: "agent" }], () => {}, () => {});
		widget.onAgentStart!("a#1");
		widget.onAgentRetry!("a#1");
		widget.onAgentEnd!("a#1", false);
		// Retried is transient in the widget (the runner re-dispatches), so the
		// settle must not flip it to failed either.
		const snap = widget.snapshot();
		expect(snap.steps[0]?.status).not.toBe("failed");
	});

	it("a genuinely failed call still stamps failed", () => {
		const widget = buildProgressWidget([{ id: "a", type: "agent" }], () => {}, () => {});
		widget.onAgentStart!("a#1");
		widget.onAgentEnd!("a#1", false); // real failure — status was running
		expect(widget.snapshot().steps[0]?.status).toBe("failed");
	});
});
