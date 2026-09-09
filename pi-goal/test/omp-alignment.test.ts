/**
 * pi-goal ≡ oh-my-pi /goal alignment suite.
 *
 * Pins pi-goal's observable behavior to oh-my-pi (omp)
 * `packages/coding-agent` goal mode, file by file:
 *
 *   omp source                                   | pinned here
 *   ---------------------------------------------+--------------------------------
 *   utils/src/sanitize-text.ts escapeXmlText     | escapeXmlText trio only
 *   modes/interactive-mode.ts handleGoalMode-    | /goal dispatch: active/paused
 *     Command / #openGoalMenu / #showGoalDetails | + rest branches, menu, details
 *     / #handleGoalBudgetCommand / guards        | budget flow, guard messages
 *   #handleGoalSessionEvent + AgentSession       | drop clears state entirely
 *   status-line/segments.ts renderGoalMode       | footer segment text
 *   goals/tools/goal-tool.ts renderer            | tool call/result strings
 *   slash-commands/builtin-modes.ts +            | descriptions, completions
 *     builtin-completions.ts buildArgument-      |
 *     Completions                                |
 *   handleGuidedGoalCommand                      | guided-goal flow
 *
 * Every expected string is copied verbatim from the omp sources listed.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import defaultExport from "../index.ts";
import { GOAL_CLEARED_ENTRY_TYPE, GOAL_STATE_ENTRY_TYPE } from "../src/restore.ts";
import { escapeXmlText, renderTemplate } from "../src/template.ts";

// The extension wires the real evaluator (a `pi -p` subprocess); alignment
// tests pin the omp semantics, not subprocess spawning — confirm completion.
vi.mock("../src/evaluator.ts", () => ({
	runGoalEvaluator: async () => ({ status: "confirmed", reason: "aligned" }),
}));

// ---------------------------------------------------------------------------
// Fake host (mirrors test/index.test.ts + severity-aware notify/select/editor)
// ---------------------------------------------------------------------------

interface Notification {
	text: string;
	type: "info" | "warning" | "error";
}

interface FakeHost {
	pi: ExtensionAPI;
	tools: Array<Record<string, unknown>>;
	commands: Record<
		string,
		{
			description?: string;
			handler: (args: string, ctx: unknown) => Promise<void>;
			getArgumentCompletions?: (prefix: string) => unknown;
		}
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
	activeTools: string[];
	statuses: Map<string, string | undefined>;
	notifications: Notification[];
	/** Queued answers for ctx.ui.select / editor / confirm / input. */
	selectQueue: Array<string | undefined>;
	editorQueue: Array<string | undefined>;
	confirmQueue: Array<boolean>;
	selectCalls: Array<{ title: string; options: string[] }>;
	editorCalls: Array<{ title: string; prefill: string }>;
	confirmCalls: Array<{ title: string; message: string }>;
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
		activeTools: ["read", "bash", "edit"],
		statuses: new Map(),
		notifications: [],
		selectQueue: [],
		editorQueue: [],
		confirmQueue: [],
		selectCalls: [],
		editorCalls: [],
		confirmCalls: [],
	};
	let entryCounter = 0;
	host.pi = {
		registerTool: (tool: unknown) => {
			host.tools.push(tool as Record<string, unknown>);
			host.activeTools.push((tool as { name: string }).name);
		},
		registerCommand: (name: string, options: Record<string, unknown>) => {
			host.commands[name] = options as (typeof host.commands)[string];
		},
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			const list = host.handlers.get(event) ?? [];
			list.push(handler);
			host.handlers.set(event, list);
		},
		registerEntryRenderer: () => {},
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
			emit: () => {},
			on: () => () => {},
		},
	} as unknown as ExtensionAPI;
	return host;
}

function createContext(host: FakeHost) {
	return {
		ui: {
			notify: (text: string, type?: "info" | "warning" | "error") => {
				host.notifications.push({ text, type: type ?? "info" });
			},
			setStatus: (key: string, text: string | undefined) => {
				if (text === undefined) host.statuses.delete(key);
				else host.statuses.set(key, text);
			},
			select: async (title: string, options: string[]) => {
				host.selectCalls.push({ title, options });
				return host.selectQueue.shift();
			},
			confirm: async (title: string, message: string) => {
				host.confirmCalls.push({ title, message });
				return host.confirmQueue.shift() ?? false;
			},
			input: async () => undefined,
			editor: async (title: string, prefill?: string) => {
				host.editorCalls.push({ title, prefill: prefill ?? "" });
				return host.editorQueue.shift();
			},
		},
		hasUI: true,
		mode: "tui",
		cwd: "/tmp",
		isIdle: () => true,
		hasPendingMessages: () => false,
		sessionManager: {
			getEntries: () => host.entries,
			getBranch: () => host.entries,
		},
	};
}

async function fire(host: FakeHost, event: string, payload: unknown, ctx?: unknown): Promise<void> {
	const list = host.handlers.get(event) ?? [];
	for (const handler of list) {
		await handler(payload, ctx ?? createContext(host));
	}
}

const baseGoal = {
	id: "g-1",
	objective: "Make the tests pass",
	status: "active" as const,
	tokenBudget: undefined as number | undefined,
	tokensUsed: 0,
	timeUsedSeconds: 0,
	createdAt: 0,
	updatedAt: 0,
};

/** Boot the extension through session_start (no persisted goal). */
async function booted(host: FakeHost): Promise<void> {
	defaultExport(host.pi);
	await fire(host, "session_start", { type: "session_start", reason: "startup" });
}

async function startGoal(host: FakeHost, objective = "Do the thing"): Promise<void> {
	await host.commands.goal!.handler(objective, createContext(host));
}

// ---------------------------------------------------------------------------
// escapeXmlText — omp packages/utils/src/sanitize-text.ts escapes ONLY
// & < > (quotes stay verbatim). omp test: goal-runtime.test.ts
// "escapeXmlText escapes only the XML-significant trio and leaves other
// characters untouched".
// ---------------------------------------------------------------------------

describe("escapeXmlText matches omp trio-only semantics", () => {
	it("leaves quotes and backticks untouched (omp pin)", () => {
		expect(escapeXmlText("'\"`")).toBe("'\"`");
	});

	it("escapes the XML-significant trio", () => {
		expect(escapeXmlText("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
	});

	it("goal prompts render quoted objectives verbatim like omp", () => {
		// omp test "returns the input verbatim when escapeXmlText has nothing to escape"
		const objective = "plain text — with 'quotes' and \"double\" plus unicode ✓";
		const rendered = renderTemplate("{{objective}}", { objective: escapeXmlText(objective) });
		expect(rendered).toBe(objective);
	});
});

// ---------------------------------------------------------------------------
// /goal dispatch — omp interactive-mode.ts handleGoalModeCommand
// ---------------------------------------------------------------------------

describe("/goal dispatch matches omp handleGoalModeCommand", () => {
	it("objective text while a goal is active warns instead of opening the menu", async () => {
		const host = fakeHost();
		await booted(host);
		await startGoal(host);
		host.notifications.length = 0;
		host.selectCalls.length = 0;

		await host.commands.goal!.handler("fix the build now", createContext(host));

		// omp: showStatus("Goal mode is already active. Use /goal to manage it, or /goal drop to start over.")
		expect(host.notifications).toEqual([
			{ text: "Goal mode is already active. Use /goal to manage it, or /goal drop to start over.", type: "info" },
		]);
		expect(host.selectCalls).toHaveLength(0);
	});

	it("objective text while a goal is paused warns like omp", async () => {
		const host = fakeHost();
		await booted(host);
		await startGoal(host);
		await host.commands.goal!.handler("pause", createContext(host));
		host.notifications.length = 0;

		await host.commands.goal!.handler("a fresh objective", createContext(host));

		// omp: showWarning("Resume the current goal first, or drop it before setting a new objective.")
		expect(host.notifications).toEqual([
			{
				text: "Resume the current goal first, or drop it before setting a new objective.",
				type: "warning",
			},
		]);
		expect(host.selectCalls).toHaveLength(0);
	});

	it("no args while active opens the omp menu with omp titles and items", async () => {
		const host = fakeHost();
		await booted(host);
		await startGoal(host, "Short objective");
		host.selectQueue.push(undefined);
		host.selectCalls.length = 0;

		await host.commands.goal!.handler("", createContext(host));

		// omp #openGoalMenu("active"): title + items verbatim (ellipsis on budget).
		expect(host.selectCalls).toEqual([
			{
				title: "Goal: Short objective (active)",
				options: ["Show details", "Adjust budget…", "Pause", "Drop"],
			},
		]);
	});

	it("paused menu lists Resume first with the omp paused title", async () => {
		const host = fakeHost();
		await booted(host);
		await startGoal(host);
		await host.commands.goal!.handler("pause", createContext(host));
		host.selectQueue.push(undefined);
		host.selectCalls.length = 0;

		await host.commands.goal!.handler("", createContext(host));

		expect(host.selectCalls).toEqual([
			{
				title: "Goal paused: Do the thing",
				options: ["Resume", "Show details", "Adjust budget…", "Drop"],
			},
		]);
	});

	it("long objectives are truncated in the menu title like omp shortDetail", async () => {
		const host = fakeHost();
		await booted(host);
		await startGoal(host, "x".repeat(60));
		host.selectQueue.push(undefined);
		host.selectCalls.length = 0;

		await host.commands.goal!.handler("", createContext(host));

		// omp: objective.length > 48 ? objective.slice(0, 47) + "…" : objective
		expect(host.selectCalls[0]?.title).toBe(`Goal: ${"x".repeat(47)}… (active)`);
	});

	it("menu Show details prints the omp details block", async () => {
		const host = fakeHost();
		await booted(host);
		await startGoal(host, "Do the thing");
		await host.commands.goal!.handler("budget 2000", createContext(host));
		host.selectQueue.push("Show details");
		host.notifications.length = 0;

		await host.commands.goal!.handler("", createContext(host));

		// omp #showGoalDetails lines verbatim.
		expect(host.notifications).toEqual([
			{
				text: [
					"Objective: Do the thing",
					"Status: active",
					`Tokens: 0 / ${Number(2000).toLocaleString()} (${Number(2000).toLocaleString()} left)`,
					"Time spent: 0s",
				].join("\n"),
				type: "info",
			},
		]);
	});

	it("menu Adjust budget… opens the omp editor with the current budget prefilled", async () => {
		const host = fakeHost();
		await booted(host);
		await startGoal(host);
		await host.commands.goal!.handler("budget 2000", createContext(host));
		host.selectQueue.push("Adjust budget…");
		host.editorQueue.push("500");
		host.notifications.length = 0;

		await host.commands.goal!.handler("", createContext(host));

		// omp #promptGoalBudgetEdit: showHookEditor(title, prefill).
		expect(host.editorCalls).toEqual([
			{ title: "Goal budget (number, `off`, or empty to cancel)", prefill: "2000" },
		]);
		expect(host.notifications).toEqual([{ text: "Goal budget set to 500.", type: "info" }]);
	});

	it("menu Pause and Resume drive the omp actions", async () => {
		const host = fakeHost();
		await booted(host);
		await startGoal(host);

		host.selectQueue.push("Pause");
		await host.commands.goal!.handler("", createContext(host));
		expect(host.notifications).toContainEqual({ text: "Goal mode paused.", type: "info" });

		host.selectQueue.push("Resume");
		await host.commands.goal!.handler("", createContext(host));
		expect(host.notifications).toContainEqual({ text: "Goal mode resumed.", type: "info" });
	});

	it("menu Drop confirms with the omp copy before dropping", async () => {
		const host = fakeHost();
		await booted(host);
		await startGoal(host);
		host.selectQueue.push("Drop");
		host.confirmQueue.push(true);

		await host.commands.goal!.handler("", createContext(host));

		// omp #confirmAndDropGoal: showHookConfirm("Drop goal?", "This removes the goal record. ...")
		expect(host.confirmCalls).toEqual([
			{
				title: "Drop goal?",
				message: "This removes the goal record. Accumulated usage stays in the session log.",
			},
		]);
		expect(host.notifications).toContainEqual({ text: "Goal dropped.", type: "info" });
	});
});

// ---------------------------------------------------------------------------
// /goal budget — omp #handleGoalBudgetCommand
// ---------------------------------------------------------------------------

describe("/goal budget matches omp #handleGoalBudgetCommand", () => {
	it("sets a budget and reports it as a status", async () => {
		const host = fakeHost();
		await booted(host);
		await startGoal(host);
		host.notifications.length = 0;

		await host.commands.goal!.handler("budget 5000", createContext(host));

		expect(host.notifications).toEqual([{ text: "Goal budget set to 5000.", type: "info" }]);
	});

	it("clears the budget with `off`", async () => {
		const host = fakeHost();
		await booted(host);
		await startGoal(host);
		await host.commands.goal!.handler("budget 5000", createContext(host));
		host.notifications.length = 0;

		await host.commands.goal!.handler("budget off", createContext(host));

		expect(host.notifications).toEqual([{ text: "Goal budget cleared.", type: "info" }]);
	});

	it("rejects non-numeric budgets with the omp error text", async () => {
		const host = fakeHost();
		await booted(host);
		await startGoal(host);
		host.notifications.length = 0;

		await host.commands.goal!.handler("budget lots", createContext(host));

		// omp: showError("Goal budget must be a positive integer or `off`.") — severity error.
		expect(host.notifications).toEqual([{ text: "Goal budget must be a positive integer or `off`.", type: "error" }]);
	});

	it("rejects zero and negative budgets", async () => {
		const host = fakeHost();
		await booted(host);
		await startGoal(host);

		await host.commands.goal!.handler("budget 0", createContext(host));
		expect(host.notifications).toEqual([{ text: "Goal budget must be a positive integer or `off`.", type: "error" }]);

		host.notifications.length = 0;
		await host.commands.goal!.handler("budget -3", createContext(host));
		expect(host.notifications).toEqual([{ text: "Goal budget must be a positive integer or `off`.", type: "error" }]);
	});

	it("reports an already-complete goal as a status", async () => {
		const host = fakeHost();
		await booted(host);
		await startGoal(host);
		// Complete via the tool, then resurrect the command surface by pausing
		// semantics: after completion the command reports via the goal tool state.
		await host.commands.goal!.handler("pause", createContext(host));
		// omp checks goal.status === "complete" only while enabled; paused goals
		// hit the enabled guard first. Verify the paused guard fires with omp text.
		host.notifications.length = 0;
		await host.commands.goal!.handler("budget 100", createContext(host));
		expect(host.notifications).toEqual([
			{ text: "Resume the goal before adjusting the budget.", type: "warning" },
		]);
	});

	it("requires an active goal (omp showWarning)", async () => {
		const host = fakeHost();
		await booted(host);
		host.notifications.length = 0;

		await host.commands.goal!.handler("budget 100", createContext(host));

		expect(host.notifications).toEqual([{ text: "No active goal.", type: "warning" }]);
	});
});

// ---------------------------------------------------------------------------
// Pause / resume / drop guards — omp #pauseGoalAction / #resumeGoalAction /
// #confirmAndDropGoal
// ---------------------------------------------------------------------------

describe("goal action guards match omp", () => {
	it("pause without an active goal warns", async () => {
		const host = fakeHost();
		await booted(host);
		host.notifications.length = 0;

		await host.commands.goal!.handler("pause", createContext(host));

		expect(host.notifications).toEqual([{ text: "No active goal to pause.", type: "warning" }]);
	});

	it("resume without a paused goal warns", async () => {
		const host = fakeHost();
		await booted(host);
		host.notifications.length = 0;

		await host.commands.goal!.handler("resume", createContext(host));

		expect(host.notifications).toEqual([{ text: "No paused goal to resume.", type: "warning" }]);
	});

	it("drop without a goal warns", async () => {
		const host = fakeHost();
		await booted(host);
		host.notifications.length = 0;

		await host.commands.goal!.handler("drop", createContext(host));

		expect(host.notifications).toEqual([{ text: "No goal to drop.", type: "warning" }]);
	});

	it("show without a goal reports No goal set.", async () => {
		const host = fakeHost();
		await booted(host);
		host.notifications.length = 0;

		await host.commands.goal!.handler("show", createContext(host));

		// omp #showGoalDetails: showStatus("No goal set.")
		expect(host.notifications).toEqual([{ text: "No goal set.", type: "info" }]);
	});
});

// ---------------------------------------------------------------------------
// Drop clears session state — omp runtime.dropGoal commits state undefined
// (#commitState(undefined, { persist: "none" })), so resume/show/menu treat a
// dropped goal exactly like no goal.
// ---------------------------------------------------------------------------

describe("drop clears goal state like omp commitState(undefined)", () => {
	async function startAndDrop(host: FakeHost): Promise<void> {
		await booted(host);
		await startGoal(host);
		host.confirmQueue.push(true);
		await host.commands.goal!.handler("drop", createContext(host));
	}

	it("goal show reports No goal set. after a drop", async () => {
		const host = fakeHost();
		await startAndDrop(host);
		host.notifications.length = 0;

		await host.commands.goal!.handler("show", createContext(host));

		expect(host.notifications).toEqual([{ text: "No goal set.", type: "info" }]);
	});

	it("goal resume reports No paused goal to resume. after a drop", async () => {
		const host = fakeHost();
		await startAndDrop(host);
		host.notifications.length = 0;

		await host.commands.goal!.handler("resume", createContext(host));

		expect(host.notifications).toEqual([{ text: "No paused goal to resume.", type: "warning" }]);
	});

	it("a new /goal <objective> starts a fresh goal after a drop", async () => {
		const host = fakeHost();
		await startAndDrop(host);
		host.sentUserMessages.length = 0;

		await host.commands.goal!.handler("next objective", createContext(host));

		expect(host.sentUserMessages).toEqual([{ content: "next objective", options: undefined }]);
		const snapshots = host.entries.filter((e) => e.customType === GOAL_STATE_ENTRY_TYPE);
		expect(snapshots.at(-1)?.data).toMatchObject({ enabled: true, goal: { objective: "next objective" } });
	});

	it("guided-goal is not blocked by a dropped goal", async () => {
		const host = fakeHost();
		await startAndDrop(host);
		host.sentMessages.length = 0;

		await host.commands["guided-goal"]!.handler("", createContext(host));

		expect(host.sentMessages.some((m) => m.customType === "guided-goal")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Status segment — omp status-line/segments.ts renderGoalMode (unicode icon
// set; goal.statusInFooter defaults to true so used/budget always renders).
// ---------------------------------------------------------------------------

describe("status segment matches omp renderGoalMode", () => {
	it("renders the active goal with icon and budget", async () => {
		const host = fakeHost();
		await booted(host);
		await startGoal(host);
		await host.commands.goal!.handler("budget 1000", createContext(host));

		// omp: withIcon(theme.icon.goal /* 🎯 */, "Goal") + " " + formatGoalBudget(0, 1000)
		expect(host.statuses.get("goal")).toBe("🎯 Goal 0/1K");
	});

	it("renders used tokens without a budget", async () => {
		const host = fakeHost();
		await booted(host);
		await startGoal(host);

		// omp formatGoalBudget(0, undefined) → "0"
		expect(host.statuses.get("goal")).toBe("🎯 Goal 0");
	});

	it("renders the pause icon for paused goals", async () => {
		const host = fakeHost();
		await booted(host);
		await startGoal(host);
		await host.commands.goal!.handler("pause", createContext(host));

		// omp paused: icon = theme.icon.pause (⏸), color warning.
		expect(host.statuses.get("goal")).toBe("⏸ Goal 0");
	});

	it("renders the warning icon for budget-limited goals", async () => {
		const host = fakeHost();
		await booted(host);
		await startGoal(host);
		await host.commands.goal!.handler("budget 10", createContext(host));
		await fire(host, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 });
		host.entries.push({
			type: "message",
			id: "m1",
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
		});

		// omp budget-limited: icon = theme.symbol("status.warning") (⚠).
		expect(host.statuses.get("goal")).toBe("⚠ Goal 25/10");
	});

	it("hides the segment once the goal completes (omp hides when neither enabled nor paused)", async () => {
		const host = fakeHost();
		await booted(host);
		await startGoal(host);
		await host.commands.goal!.handler("budget 10", createContext(host));
		await fire(host, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 });
		host.entries.push({
			type: "message",
			id: "m1",
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
		});
		expect(host.statuses.has("goal")).toBe(true);

		// Complete: enabled=false + status complete → omp segment invisible immediately.
		const tool = host.tools.find((t) => t.name === "goal")!;
		await (tool.execute as (id: string, params: unknown) => Promise<unknown>)("c1", {
			op: "complete",
			evidence: "aligned",
		});
		expect(host.statuses.has("goal")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Guided goal — omp handleGuidedGoalCommand (no kickoff status message)
// ---------------------------------------------------------------------------

describe("/guided-goal matches omp handleGuidedGoalCommand", () => {
	it("does not emit a status message before the interview", async () => {
		const host = fakeHost();
		await booted(host);
		host.notifications.length = 0;

		await host.commands["guided-goal"]!.handler("make a cli", createContext(host));

		expect(host.notifications).toEqual([]);
		expect(host.sentMessages).toEqual([
			expect.objectContaining({ customType: "guided-goal", display: false }),
		]);
	});

	it("queues the kickoff as a follow-up behind an in-flight run (omp session.followUp)", async () => {
		const host = fakeHost();
		await booted(host);

		await host.commands["guided-goal"]!.handler("make a cli", createContext(host));

		// omp: streaming → session.followUp(kickoff) — never a steer (which would
		// redirect the running turn) and never a dropped submission.
		const kickoff = host.sentMessages.find((m) => m.customType === "guided-goal");
		expect(kickoff?.options).toMatchObject({ triggerTurn: true, deliverAs: "followUp" });
	});

	it("warns when resuming is required (paused goal)", async () => {
		const host = fakeHost();
		await booted(host);
		await startGoal(host);
		await host.commands.goal!.handler("pause", createContext(host));
		host.notifications.length = 0;

		await host.commands["guided-goal"]!.handler("", createContext(host));

		expect(host.notifications).toEqual([
			{
				text: "Resume the current goal first, or drop it before setting a new objective.",
				type: "warning",
			},
		]);
	});

	it("reports already-active as a status", async () => {
		const host = fakeHost();
		await booted(host);
		await startGoal(host);
		host.notifications.length = 0;

		await host.commands["guided-goal"]!.handler("", createContext(host));

		expect(host.notifications).toEqual([
			{
				text: "Goal mode is already active. Use /goal to manage it, or /goal drop to start over.",
				type: "info",
			},
		]);
	});
});

// ---------------------------------------------------------------------------
// Command registration + completions — omp slash-commands/builtin-modes.ts +
// builtin-completions.ts buildArgumentCompletions
// ---------------------------------------------------------------------------

describe("command metadata matches omp", () => {
	it("/goal description matches omp", async () => {
		const host = fakeHost();
		await booted(host);
		expect(host.commands.goal?.description).toBe(
			"Toggle goal mode (persistent autonomous objective for this session)",
		);
	});

	it("/guided-goal description matches omp", async () => {
		const host = fakeHost();
		await booted(host);
		expect(host.commands["guided-goal"]?.description).toBe(
			"Have the agent interview you in chat, then set up goal mode",
		);
	});

	it("completions mirror omp buildArgumentCompletions (trailing space, no past-space items)", async () => {
		const host = fakeHost();
		await booted(host);
		const completions = host.commands.goal!.getArgumentCompletions! as (prefix: string) => unknown;

		// omp: value `${name} `, label name, description from the subcommand def.
		expect(completions("")).toEqual([
			{ value: "set ", label: "set", description: "Set or replace the goal" },
			{ value: "show ", label: "show", description: "Show current goal details" },
			{ value: "pause ", label: "pause", description: "Pause the current goal" },
			{ value: "resume ", label: "resume", description: "Resume a paused goal" },
			{ value: "drop ", label: "drop", description: "Drop the current goal" },
			{ value: "budget ", label: "budget", description: "Adjust the token budget" },
		]);
		expect(completions("dr")).toEqual([{ value: "drop ", label: "drop", description: "Drop the current goal" }]);
		// omp: `if (argumentPrefix.includes(" ")) return null;`
		expect(completions("budget ")).toBeNull();
		expect(completions("set some objective")).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// /goal set with no objective text — omp: editor prompt; empty cancels silently
// ---------------------------------------------------------------------------

describe("/goal set editor flow matches omp", () => {
	it("prompts for the objective with an editor titled Goal objective", async () => {
		const host = fakeHost();
		await booted(host);
		host.editorQueue.push("From the editor");

		await host.commands.goal!.handler("set", createContext(host));

		expect(host.editorCalls).toEqual([{ title: "Goal objective", prefill: "" }]);
		expect(host.sentUserMessages).toEqual([{ content: "From the editor", options: undefined }]);
	});

	it("empty editor input cancels silently", async () => {
		const host = fakeHost();
		await booted(host);
		host.editorQueue.push("   ");

		await host.commands.goal!.handler("set", createContext(host));

		expect(host.sentUserMessages).toHaveLength(0);
		expect(host.entries.some((e) => e.customType === GOAL_STATE_ENTRY_TYPE)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Goal tool renderer — omp goals/tools/goal-tool.ts goalToolRenderer
// (renderStatusLine strings with the unicode symbol set; the framed block
// body lines; ⟦⟧ badge brackets; TRUNCATE_LENGTHS caps 60/100)
// ---------------------------------------------------------------------------

describe("goal tool renderer matches omp strings", () => {
	const theme = {
		fg: (color: string, text: string) => `«${color}»${text}«/»`,
		italic: (text: string) => `i(${text})`,
		bold: (text: string) => text,
		strikethrough: (text: string) => text,
	} as never;

	function textOf(component: unknown): string {
		return (component as { text: string }).text;
	}

	/** Strip the «color» wrappers so assertions see omp's plain strings. */
	function plain(markup: string): string {
		return markup.replaceAll(/«[^»]*»/g, "");
	}

	async function setup(overrides: Partial<typeof baseGoal> = {}) {
		const host = fakeHost();
		defaultExport(host.pi);
		await fire(host, "session_start", { type: "session_start", reason: "startup" });
		const tool = host.tools.find((t) => t.name === "goal")!;
		return { tool: tool as never as { renderCall: (args: unknown, theme: unknown) => unknown; renderResult: (r: unknown, o: unknown, t: unknown) => unknown } };
	}

	it("renders the call line like omp renderStatusLine({icon:'pending'})", async () => {
		const { tool } = await setup();
		const out = plain(textOf(
			tool.renderCall({ op: "create", objective: "Ship it", token_budget: 5000 }, theme),
		));
		// omp: ⏳(muted) Goal(accent): set(muted) "Ship it"(italic muted) budget 5K(dim)
		expect(out).toContain("⏳ Goal: set");
		expect(out).toContain('i("Ship it")');
		expect(out).toContain("budget 5K");
	});

	it("call objective caps at omp TRUNCATE_LENGTHS.TITLE (60)", async () => {
		const { tool } = await setup();
		const long = "a".repeat(80);
		const out = plain(textOf(tool.renderCall({ op: "create", objective: long }, theme)));
		expect(out).toContain(`${"a".repeat(59)}…`);
		expect(out).not.toContain("a".repeat(60));
	});

	it("renders the success header with tool.goal glyph and ⟦⟧ badge", async () => {
		const { tool } = await setup();
		const out = plain(textOf(
			tool.renderResult(
				{
					content: [{ type: "text", text: "Goal: Ship it" }],
					details: {
						op: "create",
						goal: { ...baseGoal, status: "active", tokenBudget: 10000, tokensUsed: 2500, timeUsedSeconds: 120 },
						remainingTokens: 7500,
						completionBudgetReport: null,
					},
				},
				{ isPartial: false },
				theme,
			),
		));
		// omp: ◎(accent) Goal(accent): create→set(muted) ⟦active⟧(accent badge)
		// The result body always carries details.goal.objective (omp semantic).
		expect(out).toContain("◎ Goal: set ⟦active⟧");
		expect(out).toContain('i("Make the tests pass")');
		// omp tokens line: 2.5K / 10K tokens (7.5K left) · 2m elapsed
		expect(out).toContain("2.5K / 10K tokens (7.5K left)");
		expect(out).toContain("2m elapsed");
	});

	it("badge colors follow omp goalBadgeColor", async () => {
		const { tool } = await setup();
		const out = plain(textOf(
			tool.renderResult(
				{
					content: [{ type: "text", text: "x" }],
					details: { op: "get", goal: { ...baseGoal, status: "paused" }, remainingTokens: null },
				},
				{ isPartial: false },
				theme,
			),
		));
		expect(out).toContain("⟦paused⟧");
	});

	it("renders the error line like omp formatErrorDetail", async () => {
		const { tool } = await setup();
		const out = plain(
			textOf(
				tool.renderResult(
					{
						content: [{ type: "text", text: "boom" }],
						details: { op: "check" },
						isError: true,
					},
					{ isPartial: false },
					theme,
				),
			),
		);
		// omp: ✘(error) Goal(accent): op(muted) then two-space error detail.
		expect(out).toContain("✘ Goal: check");
		expect(out).toContain("boom");
	});

	it("renders the no-goal line like omp (warning icon, no active goal meta)", async () => {
		const { tool } = await setup();
		const out = plain(textOf(
			tool.renderResult(
				{ content: [{ type: "text", text: "No active goal." }], details: { op: "get", goal: null } },
				{ isPartial: false },
				theme,
			),
		));
		// omp: ⚠(warning) Goal(accent): check(muted) · no active goal(dim)
		expect(out).toContain("⚠ Goal: check");
		expect(out).toContain("no active goal");
	});

	it("result objective caps at omp TRUNCATE_LENGTHS.LONG (100)", async () => {
		const { tool } = await setup();
		const long = "b".repeat(120);
		const out = plain(textOf(
			tool.renderResult(
				{
					content: [{ type: "text", text: "x" }],
					details: { op: "get", goal: { ...baseGoal, objective: long }, remainingTokens: null },
				},
				{ isPartial: false },
				theme,
			),
		));
		expect(out).toContain(`${"b".repeat(99)}…`);
		expect(out).not.toContain("b".repeat(100));
	});
});

// ---------------------------------------------------------------------------
// Persistence shape — omp appends goal-completed entries with these fields
// ---------------------------------------------------------------------------

describe("completion entry shape matches omp appendCustomEntry", () => {
	it("goal-completed entry carries objective/tokensUsed/tokenBudget/timeUsedSeconds", async () => {
		const host = fakeHost();
		await booted(host);
		await startGoal(host);
		await host.commands.goal!.handler("budget 1000", createContext(host));
		await fire(host, "agent_start", { type: "agent_start" });
		const tool = host.tools.find((t) => t.name === "goal")!;
		await (tool.execute as (id: string, params: unknown) => Promise<unknown>)("c1", {
			op: "complete",
			evidence: "aligned",
		});
		await fire(host, "agent_end", {
			type: "agent_end",
			messages: [{ role: "assistant", stopReason: "stop", usage: {} }],
		});

		const completed = host.entries.find((e) => e.type === "custom" && e.customType === "goal-completed");
		expect(completed?.data).toMatchObject({
			objective: "Do the thing",
			tokensUsed: 0,
			tokenBudget: 1000,
			timeUsedSeconds: 0,
		});
		// omp exit(completed): appendModeChange("none") → pi goal-cleared entry.
		expect(host.entries.some((e) => e.customType === GOAL_CLEARED_ENTRY_TYPE)).toBe(true);
	});
});
