/**
 * pi-goal — extension wiring tests (fake host, pi-ask-user test style).
 *
 * Drives the default export through a fake ExtensionAPI to pin the event
 * wiring: toolset toggling, context injection, continuation loop, suppression,
 * interrupt pausing, completion exit, and restore.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import defaultExport from "../index.ts";
import { GOAL_CLEARED_ENTRY_TYPE, GOAL_COMPLETED_ENTRY_TYPE, GOAL_STATE_ENTRY_TYPE } from "../src/restore.ts";
import type { Goal } from "../src/state.ts";

// The real evaluator spawns a `pi -p` subprocess; wiring tests pin event
// flow, not spawning — confirm every evaluation.
vi.mock("../src/evaluator.ts", () => ({
	runGoalEvaluator: async () => ({ status: "confirmed", reason: "wiring" }),
}));

// ---------------------------------------------------------------------------
// Fake host
// ---------------------------------------------------------------------------

interface FakeHost {
	pi: ExtensionAPI;
	tools: Array<Record<string, unknown>>;
	commands: Record<
		string,
		{ handler: (args: string, ctx: unknown) => Promise<void>; getArgumentCompletions?: (prefix: string) => unknown }
	>;
	handlers: Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
	entries: Array<{ type: string; customType: string; data?: unknown; id: string }>;
	sentMessages: Array<{
		customType: string;
		content: string;
		display: boolean;
		options?: { deliverAs?: string; triggerTurn?: boolean };
	}>;
	sentUserMessages: Array<{ content: string; options?: { deliverAs?: string } }>;
	emitted: Array<{ channel: string; data: unknown }>;
	activeTools: string[];
	statuses: Map<string, string | undefined>;
	notifications: string[];
	entryRenderers: Map<string, (entry: unknown, options: unknown, theme: unknown) => unknown>;
}

function fakeHost(): FakeHost {
	const host: FakeHost = {
		pi: {} as ExtensionAPI,
		tools: [],
		commands: {},
		handlers: new Map(),
		entries: [],
		sentMessages: [],
		sentUserMessages: [],
		emitted: [],
		activeTools: ["read", "bash", "edit"],
		statuses: new Map(),
		notifications: [],
		entryRenderers: new Map(),
	};
	let entryCounter = 0;
	host.pi = {
		registerTool: (tool: unknown) => {
			host.tools.push(tool as Record<string, unknown>);
			host.activeTools.push((tool as { name: string }).name);
		},
		registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
			host.commands[name] = options;
		},
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			const list = host.handlers.get(event) ?? [];
			list.push(handler);
			host.handlers.set(event, list);
		},
		registerEntryRenderer: (
			customType: string,
			renderer: (entry: unknown, options: unknown, theme: unknown) => unknown,
		) => {
			host.entryRenderers.set(customType, renderer);
		},
		registerMessageRenderer: () => {},
		appendEntry: (customType: string, data?: unknown) => {
			host.entries.push({ type: "custom", customType, data, id: `entry-${++entryCounter}` });
		},
		sendMessage: (
			message: { customType: string; content: string; display: boolean },
			options?: { deliverAs?: string; triggerTurn?: boolean },
		) => {
			host.sentMessages.push({ ...message, options });
		},
		sendUserMessage: (content: string, options?: { deliverAs?: string }) => {
			host.sentUserMessages.push({ content, options });
		},
		getActiveTools: () => [...host.activeTools],
		setActiveTools: (names: string[]) => {
			host.activeTools = [...names];
		},
		events: {
			emit: (channel: string, data: unknown) => {
				host.emitted.push({ channel, data });
			},
			on: () => () => {},
		},
	} as unknown as ExtensionAPI;
	return host;
}

function createContext(host: FakeHost, overrides: { entries?: unknown[]; pending?: boolean; idle?: boolean } = {}) {
	return {
		ui: {
			notify: (text: string) => {
				host.notifications.push(text);
			},
			setStatus: (key: string, text: string | undefined) => {
				if (text === undefined) host.statuses.delete(key);
				else host.statuses.set(key, text);
			},
			confirm: async () => true,
			select: async () => undefined,
			input: async () => undefined,
			editor: async () => undefined,
		},
		hasUI: true,
		mode: "tui",
		cwd: "/tmp",
		isIdle: () => overrides.idle ?? true,
		hasPendingMessages: () => overrides.pending ?? false,
		sessionManager: {
			getEntries: () => overrides.entries ?? host.entries,
			getBranch: () => overrides.entries ?? host.entries,
		},
	};
}

async function fire(host: FakeHost, event: string, payload: unknown, ctx?: unknown): Promise<void> {
	const list = host.handlers.get(event) ?? [];
	for (const handler of list) {
		await handler(payload, ctx ?? createContext(host));
	}
}

function goalTool(host: FakeHost): Record<string, unknown> {
	const tool = host.tools.find((t) => t.name === "goal");
	if (!tool) throw new Error("goal tool not registered");
	return tool;
}

async function callGoalTool(
	host: FakeHost,
	params: Record<string, unknown>,
): Promise<{ details: { goal?: Goal | null } }> {
	const tool = goalTool(host);
	const execute = tool.execute as (
		id: string,
		params: unknown,
		signal: undefined,
		onUpdate: undefined,
		ctx: unknown,
	) => Promise<{ details: { goal?: Goal | null } }>;
	return execute("call-1", params, undefined, undefined, createContext(host));
}

function makeEntries(goal: Goal, enabled: boolean): unknown[] {
	return [
		{
			type: "custom",
			customType: GOAL_STATE_ENTRY_TYPE,
			id: "e1",
			data: { enabled, goal: { ...goal } },
		},
	];
}

const baseGoal: Goal = {
	id: "g-1",
	objective: "Make the tests pass",
	status: "active",
	tokenBudget: undefined,
	tokensUsed: 0,
	timeUsedSeconds: 0,
	createdAt: 0,
	updatedAt: 0,
};

function assistantMessage(stopReason: string): unknown {
	return { role: "assistant", stopReason, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

describe("pi-goal extension wiring", () => {
	it("registers the goal tool, /goal, and /guided-goal", () => {
		const host = fakeHost();
		defaultExport(host.pi);
		expect(host.tools.map((t) => t.name)).toContain("goal");
		expect(host.commands.goal).toBeDefined();
		expect(host.commands["guided-goal"]).toBeDefined();
	});

	it("session_start with no goal removes the goal tool from the active set", async () => {
		const host = fakeHost();
		defaultExport(host.pi);
		await fire(host, "session_start", { type: "session_start", reason: "startup" });
		expect(host.activeTools).not.toContain("goal");
		expect(host.activeTools).toContain("read");
	});

	it("session_start restores a persisted active goal, re-adds the tool, then pauses it (omp onThreadResumed)", async () => {
		const host = fakeHost();
		defaultExport(host.pi);
		const ctx = createContext(host, { entries: makeEntries(baseGoal, true) });
		await fire(host, "session_start", { type: "session_start", reason: "resume" }, ctx);

		expect(host.activeTools).toContain("goal");
		// Cold resume auto-pauses active goals and persists that.
		const pauseEntry = [...host.entries].reverse().find((e) => e.customType === GOAL_STATE_ENTRY_TYPE);
		expect(pauseEntry?.data).toMatchObject({ enabled: false, goal: { status: "paused" } });
		// omp footer segment: pause icon + usage.
		expect(host.statuses.get("goal")).toBe("⏸ Goal 0");
	});

	it("/goal <objective> creates the goal, toggles tools, and submits the objective", async () => {
		const host = fakeHost();
		defaultExport(host.pi);
		await fire(host, "session_start", { type: "session_start", reason: "startup" });

		await host.commands.goal!.handler("Rewrite the docs", createContext(host));

		expect(host.activeTools).toContain("goal");
		const stateEntry = host.entries.find((e) => e.customType === GOAL_STATE_ENTRY_TYPE);
		expect(stateEntry?.data).toMatchObject({
			enabled: true,
			goal: { objective: "Rewrite the docs", status: "active" },
		});
		expect(host.sentUserMessages).toHaveLength(1);
		expect(host.sentUserMessages[0]?.content).toBe("Rewrite the docs");
		expect(host.emitted.some((e) => e.channel === "goal_updated")).toBe(true);
		// omp footer segment: goal icon + usage.
		expect(host.statuses.get("goal")).toBe("🎯 Goal 0");
	});

	it("before_agent_start injects the hidden goal-mode-context message only while a goal is active", async () => {
		const host = fakeHost();
		defaultExport(host.pi);
		await fire(host, "session_start", { type: "session_start", reason: "startup" });

		let result: unknown;
		const handler = host.handlers.get("before_agent_start")?.[0];
		result = await handler!({ prompt: "hi", systemPrompt: "" }, createContext(host));
		expect(result).toBeUndefined();

		await host.commands.goal!.handler("Do the thing", createContext(host));
		result = await handler!({ prompt: "hi", systemPrompt: "" }, createContext(host));
		expect(result).toMatchObject({ message: { customType: "goal-mode-context", display: false } });
		const content = (result as { message: { content: string } }).message.content;
		expect(content).toContain("<goal_context>");
		expect(content).toContain("Do the thing");
	});

	it("agent_end schedules a continuation when the goal is still active", async () => {
		const host = fakeHost();
		defaultExport(host.pi);
		await fire(host, "session_start", { type: "session_start", reason: "startup" });
		await host.commands.goal!.handler("Do the thing", createContext(host));
		host.sentMessages.length = 0;

		await fire(host, "agent_start", { type: "agent_start" });
		await fire(host, "tool_execution_end", {
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "bash",
			result: {},
			isError: false,
		});
		await fire(host, "agent_end", { type: "agent_end", messages: [assistantMessage("toolUse")] });

		const continuation = host.sentMessages.find((m) => m.customType === "goal-continuation");
		expect(continuation).toBeDefined();
		expect(continuation?.display).toBe(false);
		expect(continuation?.options).toMatchObject({ triggerTurn: true, deliverAs: "followUp" });
	});

	it("suppresses the next continuation when a continuation turn produced no tool calls", async () => {
		const host = fakeHost();
		defaultExport(host.pi);
		await fire(host, "session_start", { type: "session_start", reason: "startup" });
		await host.commands.goal!.handler("Do the thing", createContext(host));
		host.sentMessages.length = 0;

		// Continuation turn: agent replies with no tool calls.
		await fire(host, "agent_start", { type: "agent_start" });
		await fire(host, "agent_end", { type: "agent_end", messages: [assistantMessage("stop")] });
		expect(host.sentMessages.filter((m) => m.customType === "goal-continuation")).toHaveLength(1);

		// That turn's end marks suppression: the following end schedules nothing.
		host.sentMessages.length = 0;
		await fire(host, "agent_start", { type: "agent_start" });
		await fire(host, "agent_end", { type: "agent_end", messages: [assistantMessage("stop")] });
		expect(host.sentMessages.filter((m) => m.customType === "goal-continuation")).toHaveLength(0);

		// A real user message re-arms the loop.
		await fire(host, "message_start", { type: "message_start", message: { role: "user" } });
		await fire(host, "agent_start", { type: "agent_start" });
		await fire(host, "tool_execution_end", {
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "read",
			result: {},
			isError: false,
		});
		host.sentMessages.length = 0;
		await fire(host, "agent_end", { type: "agent_end", messages: [assistantMessage("stop")] });
		expect(host.sentMessages.filter((m) => m.customType === "goal-continuation")).toHaveLength(1);
	});

	it("interrupt aborts pause the goal instead of continuing", async () => {
		const host = fakeHost();
		defaultExport(host.pi);
		await fire(host, "session_start", { type: "session_start", reason: "startup" });
		await host.commands.goal!.handler("Do the thing", createContext(host));
		host.sentMessages.length = 0;

		await fire(host, "agent_start", { type: "agent_start" });
		await fire(host, "agent_end", { type: "agent_end", messages: [assistantMessage("aborted")] });

		expect(host.sentMessages.filter((m) => m.customType === "goal-continuation")).toHaveLength(0);
		// omp footer segment: pause icon + usage.
		expect(host.statuses.get("goal")).toBe("⏸ Goal 0");
		const pauseEntry = [...host.entries].reverse().find((e) => e.customType === GOAL_STATE_ENTRY_TYPE);
		expect(pauseEntry?.data).toMatchObject({ enabled: false, goal: { status: "paused" } });
	});

	it("tool-driven complete exits goal mode at agent_end with the completion summary", async () => {
		const host = fakeHost();
		defaultExport(host.pi);
		await fire(host, "session_start", { type: "session_start", reason: "startup" });
		await host.commands.goal!.handler("Do the thing", createContext(host));

		await callGoalTool(host, { op: "complete", evidence: "tests pass" });
		// Still active toolset until the run ends.
		expect(host.activeTools).toContain("goal");

		await fire(host, "agent_start", { type: "agent_start" });
		await fire(host, "agent_end", { type: "agent_end", messages: [assistantMessage("stop")] });

		expect(host.activeTools).not.toContain("goal");
		expect(host.entries.some((e) => e.customType === GOAL_COMPLETED_ENTRY_TYPE)).toBe(true);
		expect(host.entries.some((e) => e.customType === GOAL_CLEARED_ENTRY_TYPE)).toBe(true);
		expect(host.notifications).toContain("Goal mode completed.");
		expect(host.statuses.has("goal")).toBe(false);
		expect(host.sentMessages.filter((m) => m.customType === "goal-continuation")).toHaveLength(0);
	});

	it("budget-limit steering sends one hidden steer message when usage crosses the budget", async () => {
		const host = fakeHost();
		defaultExport(host.pi);
		await fire(host, "session_start", { type: "session_start", reason: "startup" });
		await host.commands.goal!.handler("Do the thing", createContext(host));
		await host.commands.goal!.handler("budget 10", createContext(host));

		// turn_start snapshots the baseline (no usage entries yet).
		await fire(host, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 });
		// Usage arrives via an assistant message entry (same shape pi persists).
		host.entries.push({
			type: "message",
			customType: "",
			id: "m1",
			data: undefined,
			message: {
				role: "assistant",
				stopReason: "toolUse",
				usage: { input: 25, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		} as never);

		await fire(host, "tool_execution_end", {
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "read",
			result: {},
			isError: false,
		});

		const steer = host.sentMessages.find((m) => m.customType === "goal-budget-limit");
		expect(steer).toBeDefined();
		expect(steer?.display).toBe(false);
		expect(steer?.options).toMatchObject({ deliverAs: "steer" });
		// omp footer segment: warning icon + used/budget.
		expect(host.statuses.get("goal")).toBe("⚠ Goal 25/10");

		// A second flush must not steer again (once per goal id).
		host.sentMessages.length = 0;
		host.entries.push({
			type: "message",
			customType: "",
			id: "m2",
			data: undefined,
			message: {
				role: "assistant",
				stopReason: "toolUse",
				usage: { input: 50, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		} as never);
		await fire(host, "tool_execution_end", {
			type: "tool_execution_end",
			toolCallId: "t2",
			toolName: "read",
			result: {},
			isError: false,
		});
		expect(host.sentMessages.filter((m) => m.customType === "goal-budget-limit")).toHaveLength(0);
	});

	it("/guided-goal queues a hidden interview kickoff", async () => {
		const host = fakeHost();
		defaultExport(host.pi);
		await fire(host, "session_start", { type: "session_start", reason: "startup" });

		await host.commands["guided-goal"]!.handler("make a cli", createContext(host));
		const kickoff = host.sentMessages.find((m) => m.customType === "guided-goal");
		expect(kickoff).toBeDefined();
		expect(kickoff?.display).toBe(false);
		expect(kickoff?.content).toContain("<rough-goal>");
		expect(kickoff?.content).toContain("make a cli");
		expect(host.activeTools).toContain("goal");
	});

	it("/goal pause and /goal resume round-trip through the runtime", async () => {
		const host = fakeHost();
		defaultExport(host.pi);
		await fire(host, "session_start", { type: "session_start", reason: "startup" });
		await host.commands.goal!.handler("Do the thing", createContext(host));

		await host.commands.goal!.handler("pause", createContext(host));
		expect(host.activeTools).not.toContain("goal");
		expect(host.notifications).toContain("Goal mode paused.");

		await host.commands.goal!.handler("resume", createContext(host));
		expect(host.activeTools).toContain("goal");
		expect(host.notifications).toContain("Goal mode resumed.");
	});

	it("/goal drop requires confirmation and clears state", async () => {
		const host = fakeHost();
		defaultExport(host.pi);
		await fire(host, "session_start", { type: "session_start", reason: "startup" });
		await host.commands.goal!.handler("Do the thing", createContext(host));

		await host.commands.goal!.handler("drop", createContext(host));
		expect(host.entries.some((e) => e.customType === GOAL_CLEARED_ENTRY_TYPE)).toBe(true);
		expect(host.notifications).toContain("Goal dropped.");
		expect(host.statuses.has("goal")).toBe(false);
	});

	// ----------------------------------------------------------------
	// docs/extensions.md conformance: ui_prompt_start/end, agent_settled,
	// getArgumentCompletions, registerEntryRenderer
	// ----------------------------------------------------------------

	it("withholds continuation while a blocking UI prompt is open, resumes when it closes while idle", async () => {
		const host = fakeHost();
		defaultExport(host.pi);
		await fire(host, "session_start", { type: "session_start", reason: "startup" });
		await host.commands.goal!.handler("Do the thing", createContext(host));
		host.sentMessages.length = 0;

		// Agent settles while a dialog (e.g. /goal drop confirm) is open.
		// omp's footer segment has no dialog state; the status text stays put.
		await fire(host, "ui_prompt_start", { type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm" });
		expect(host.statuses.get("goal")).toBe("🎯 Goal 0");

		await fire(host, "agent_start", { type: "agent_start" });
		await fire(host, "agent_end", { type: "agent_end", messages: [assistantMessage("stop")] });
		expect(host.sentMessages.filter((m) => m.customType === "goal-continuation")).toHaveLength(0);

		// Dialog closes while idle: the withheld continuation is scheduled now.
		const idleCtx = createContext(host, { idle: true });
		await fire(host, "ui_prompt_end", { type: "ui_prompt_end", reason: "ui_prompt", kind: "confirm" }, idleCtx);
		expect(host.statuses.get("goal")).not.toContain("waiting for user");
		expect(host.sentMessages.filter((m) => m.customType === "goal-continuation")).toHaveLength(1);
	});

	it("does not schedule on ui_prompt_end while the agent is still streaming", async () => {
		const host = fakeHost();
		defaultExport(host.pi);
		await fire(host, "session_start", { type: "session_start", reason: "startup" });
		await host.commands.goal!.handler("Do the thing", createContext(host));
		host.sentMessages.length = 0;

		// Another extension's ask_user dialog opens mid-run and closes; the run
		// is still going, so scheduling must wait for its agent_end.
		await fire(host, "ui_prompt_start", { type: "ui_prompt_start", reason: "ui_prompt", kind: "custom" });
		await fire(host, "agent_start", { type: "agent_start" });
		await fire(
			host,
			"ui_prompt_end",
			{ type: "ui_prompt_end", reason: "ui_prompt", kind: "custom" },
			createContext(host, { idle: false }),
		);
		expect(host.sentMessages.filter((m) => m.customType === "goal-continuation")).toHaveLength(0);

		await fire(host, "agent_end", { type: "agent_end", messages: [assistantMessage("stop")] });
		expect(host.sentMessages.filter((m) => m.customType === "goal-continuation")).toHaveLength(1);
	});

	it("refreshes the status on agent_settled (status integrations per docs)", async () => {
		const host = fakeHost();
		defaultExport(host.pi);
		await fire(host, "session_start", { type: "session_start", reason: "startup" });
		await host.commands.goal!.handler("Do the thing", createContext(host));

		host.statuses.clear();
		await fire(host, "agent_settled", { type: "agent_settled" });
		expect(host.statuses.get("goal")).toBe("🎯 Goal 0");
	});

	it("registers /goal argument completions (omp buildArgumentCompletions shape)", () => {
		const host = fakeHost();
		defaultExport(host.pi);
		const completions = host.commands.goal!.getArgumentCompletions;
		expect(completions).toBeDefined();

		const subs = completions!("") as Array<{ value: string }>;
		expect(subs.map((s) => s.value)).toEqual(["set ", "show ", "pause ", "resume ", "drop ", "budget "]);
		expect(completions!("dr") as Array<{ value: string }>).toEqual([
			{ value: "drop ", label: "drop", description: "Drop the current goal" },
		]);
		// omp: null once the prefix passes the subcommand word.
		expect(completions!("budget ")).toBeNull();
		expect(completions!("set some objective")).toBeNull();
	});

	it("renders the goal-completed entry persistently (registerEntryRenderer per docs)", () => {
		const host = fakeHost();
		defaultExport(host.pi);
		const renderer = host.entryRenderers.get(GOAL_COMPLETED_ENTRY_TYPE);
		expect(renderer).toBeDefined();

		const passthroughTheme = { fg: (_color: string, text: string) => text };
		const component = renderer!(
			{
				type: "custom",
				customType: GOAL_COMPLETED_ENTRY_TYPE,
				data: { objective: "Ship it", tokensUsed: 6049, timeUsedSeconds: 20 },
			},
			{ expanded: false },
			passthroughTheme,
		) as { text: string };
		expect(component.text).toContain("Goal completed: Ship it");
		expect(component.text).toContain("6K (no budget) tokens");
		expect(component.text).toContain("20s");
	});
});
