/**
 * Extension wrapper tests: run_workflow tool failure semantics.
 *
 * pi's tool contract is throw-on-failure — returning `{ isError: true }` is a
 * dead flag (the agent loop hardcodes isError:false for returned values), so
 * failed runs must throw. These tests exercise the registered tool's execute
 * without spawning subprocesses: maxAgents: 0 makes the budget gate refuse
 * every spawn before any dispatch happens.
 */
import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import defaultExport from "../index.ts";

function fakeHost(): ExtensionAPI {
	const tools: Record<string, Record<string, unknown>> = {};
	const host = {
		registerTool: (tool: unknown) => {
			const name = (tool as { name: string }).name;
			tools[name] = tool as Record<string, unknown>;
		},
		registerCommand: () => {},
		registerEntryRenderer: () => {},
		on: () => {},
		appendEntry: () => {},
		events: { emit: () => {}, on: () => () => {} },
	} as unknown as ExtensionAPI;
	(host as unknown as { __tools: typeof tools }).__tools = tools;
	return host;
}

function runWorkflowTool(host: ExtensionAPI): Record<string, unknown> {
	const tools = (host as unknown as { __tools: Record<string, Record<string, unknown>> }).__tools;
	expect(tools.run_workflow).toBeDefined();
	return tools.run_workflow;
}

const BROKEN_WORKFLOW = {
	name: "wrapper-fail",
	steps: [{ id: "a", type: "agent" as const, prompt: "nope" }],
};

describe("run_workflow extension wrapper", () => {
	it("throws (does not return isError) when a run fails — budget-gated, no subprocess spawned", async () => {
		const host = fakeHost();
		defaultExport(host);
		const tool = runWorkflowTool(host);

		const execute = tool.execute as (id: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: unknown) => Promise<unknown>;
		const error = await execute("call-1", { workflow: BROKEN_WORKFLOW, budget: { maxAgents: 0 }, now: 1 }, undefined, undefined, {
			cwd: "/tmp",
			ui: { notify: () => {} },
			scopedModels: [],
			modelRegistry: { getAll: () => [] },
		}).then(
			() => null,
			(err: unknown) => (err instanceof Error ? err : new Error(String(err))),
		);

		expect(error).toBeInstanceOf(Error);
		expect(error?.message).toContain("run_workflow");
	});

	it("throws on missing inline workflow instead of returning an error payload", async () => {
		const host = fakeHost();
		defaultExport(host);
		const tool = runWorkflowTool(host);

		const execute = tool.execute as (id: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: unknown) => Promise<unknown>;
		const error = await execute("call-1", {}, undefined, undefined, {
			cwd: "/tmp",
			ui: { notify: () => {} },
			scopedModels: [],
			modelRegistry: { getAll: () => [] },
		}).then(
			() => null,
			(err: unknown) => (err instanceof Error ? err : new Error(String(err))),
		);

		expect(error?.message).toContain("provide either a `workflow`");
	});
});
