/**
 * pi-goal — extension wiring tests (fake host, pi-ask-user test style).
 *
 * Drives the default export through a fake ExtensionAPI to pin the goal.ts
 * behavior: session-entry persistence and restore, system-prompt injection,
 * agent_end token/time accounting, budget-limit flips, error/abort handling,
 * single-flight continuation queueing, context pruning, the /goal command,
 * and the get_goal/create_goal/update_goal tools.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import defaultExport from "../index.ts";

interface CapturedEntry {
	type: "custom";
	customType: string;
	data: unknown;
}

interface SentMessage {
	message: {
		customType?: string;
		content: string;
		display?: boolean;
		details?: { goalId?: string };
	};
	options?: { triggerTurn?: boolean; deliverAs?: string };
}

interface FakeUI {
	notify: (text: string, severity?: string) => void;
	confirm: (title: string, message?: string) => Promise<boolean>;
	editor: (title: string, prefill?: string) => Promise<string | undefined>;
	setStatus: (key: string, value: string | undefined) => void;
	theme: { fg: (color: string, text: string) => string };
}

interface FakeCtx {
	hasUI: boolean;
	isIdle: () => boolean;
	hasPendingMessages: () => boolean;
	sessionManager: { getBranch: () => CapturedEntry[]; getSessionId: () => string };
	ui: FakeUI;
}

type Handler = (event: unknown, ctx: FakeCtx) => unknown | Promise<unknown>;

interface FakeHost {
	pi: unknown;
	tools: Map<string, { name: string; execute: (...args: unknown[]) => Promise<unknown> }>;
	commands: Map<string, { handler: (args: string, ctx: FakeCtx) => Promise<void>; getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string; description?: string }> | null }>;
	handlers: Map<string, Handler[]>;
	entries: CapturedEntry[];
	sent: SentMessage[];
	notifications: Array<{ text: string; severity?: string }>;
	statuses: Map<string, string | undefined>;
	makeCtx: (overrides?: Partial<Omit<FakeCtx, "ui">> & { ui?: Partial<FakeUI> }) => FakeCtx;
	fire: (event: string, ev: unknown, ctx?: FakeCtx) => Promise<void>;
}

function fakeHost(): FakeHost {
	const host: FakeHost = {
		pi: {},
		tools: new Map(),
		commands: new Map(),
		handlers: new Map(),
		entries: [],
		sent: [],
		notifications: [],
		statuses: new Map(),
		makeCtx: () => {
			throw new Error("not initialized");
		},
		fire: async () => {
			throw new Error("not initialized");
		},
	};
	const pi = {
		registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => {
			host.tools.set(tool.name, tool);
		},
		registerCommand: (
			name: string,
			options: { handler: (args: string, ctx: FakeCtx) => Promise<void>; getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string; description?: string }> | null },
		) => {
			host.commands.set(name, options);
		},
		on: (event: string, handler: Handler) => {
			const list = host.handlers.get(event) ?? [];
			list.push(handler);
			host.handlers.set(event, list);
		},
		appendEntry: (customType: string, data: unknown) => {
			host.entries.push({ type: "custom", customType, data });
		},
		sendMessage: (message: SentMessage["message"], options?: SentMessage["options"]) => {
			host.sent.push({ message, options });
		},
	};
	host.pi = pi;
	defaultExport(pi as unknown as ExtensionAPI);

	host.makeCtx = (overrides) => {
		const ctx: FakeCtx = {
			hasUI: false,
			isIdle: () => true,
			hasPendingMessages: () => false,
			sessionManager: { getBranch: () => host.entries, getSessionId: () => "session-1" },
			ui: {
				notify: (text, severity) => host.notifications.push({ text, severity }),
				confirm: async () => true,
				editor: async () => undefined,
				setStatus: (key, value) => host.statuses.set(key, value),
				theme: { fg: (_color, text) => text },
			},
		};
		return { ...ctx, ...overrides, ui: { ...ctx.ui, ...overrides?.ui } };
	};

	host.fire = async (event, ev, ctx) => {
		for (const handler of host.handlers.get(event) ?? []) {
			await handler(ev, ctx ?? host.makeCtx());
		}
	};

	return host;
}

function goalEntry(action: string, goal: Record<string, unknown> | null): CapturedEntry {
	return {
		type: "custom",
		customType: "goal",
		data: { version: 2, action, goal },
	};
}

function assistantMessage(usage: { input?: number; cacheRead?: number; output?: number; totalTokens?: number }, extra?: Record<string, unknown>) {
	return { role: "assistant", usage, stopReason: "stop", ...extra };
}

async function runTool(host: FakeHost, name: string, params: unknown = {}, ctx?: FakeCtx) {
	const tool = host.tools.get(name);
	if (!tool) throw new Error(`tool ${name} not registered`);
	return await tool.execute("call-1", params, undefined, undefined, ctx ?? host.makeCtx());
}

async function runCommand(host: FakeHost, args: string, ctx?: FakeCtx) {
	const command = host.commands.get("goal");
	if (!command) throw new Error("command goal not registered");
	await command.handler(args, ctx ?? host.makeCtx());
}

function lastPersisted(host: FakeHost): CapturedEntry | undefined {
	return [...host.entries].reverse().find((entry) => entry.customType === "goal");
}

describe("restore (session_start / session_tree)", () => {
	it("restores no goal from an empty branch", async () => {
		const host = fakeHost();
		await host.fire("session_start", {});
		expect(await runTool(host, "get_goal")).toMatchObject({ details: { goal: null } });
	});

	it("restores the latest goal entry on the branch", async () => {
		const host = fakeHost();
		host.entries.push(goalEntry("set", { id: "g1", objective: "ship it", status: "paused", tokensUsed: 10, timeUsedSeconds: 5, createdAt: 1, updatedAt: 2 }));
		await host.fire("session_start", {});
		const result = (await runTool(host, "get_goal")) as { details: { goal: { objective: string; status: string } } };
		expect(result.details.goal.objective).toBe("ship it");
		expect(result.details.goal.status).toBe("paused");
	});

	it("a later clear entry (goal null) removes the goal", async () => {
		const host = fakeHost();
		host.entries.push(
			goalEntry("set", { id: "g1", objective: "ship it", status: "complete", tokensUsed: 1, timeUsedSeconds: 1, createdAt: 1, updatedAt: 2 }),
			goalEntry("clear", null),
		);
		await host.fire("session_start", {});
		expect(await runTool(host, "get_goal")).toMatchObject({ details: { goal: null } });
	});

	it("normalizes legacy statuses and repairs malformed fields", async () => {
		const host = fakeHost();
		host.entries.push(
			goalEntry("status", {
				id: "g1",
				objective: "x & y",
				status: "usage_limited",
				tokensUsed: -5,
				timeUsedSeconds: "bogus",
				createdAt: 1,
				updatedAt: 2,
			}),
		);
		await host.fire("session_start", {});
		const result = (await runTool(host, "get_goal")) as { details: { goal: { status: string; tokensUsed: number; timeUsedSeconds: number; objective: string } } };
		expect(result.details.goal.status).toBe("usageLimited");
		expect(result.details.goal.tokensUsed).toBe(0);
		expect(result.details.goal.timeUsedSeconds).toBe(0);
		expect(result.details.goal.objective).toBe("x & y");
	});

	it("an active restored goal re-arms elapsed-time accounting", async () => {
		const host = fakeHost();
		host.entries.push(goalEntry("set", { id: "g1", objective: "work", status: "active", tokenBudget: 1_000_000, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 }));
		await host.fire("session_start", {});
		vi.setSystemTime(Date.now() + 10_000);
		const result = (await runTool(host, "get_goal")) as { details: { goal: { timeUsedSeconds: number } } };
		expect(result.details.goal.timeUsedSeconds).toBe(10);
	});

	it("session_tree restores through the same path", async () => {
		const host = fakeHost();
		host.entries.push(goalEntry("set", { id: "g1", objective: "tree", status: "active", tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 }));
		await host.fire("session_tree", {});
		const result = (await runTool(host, "get_goal")) as { details: { goal: { objective: string } } };
		expect(result.details.goal.objective).toBe("tree");
	});
});

describe("before_agent_start injection", () => {
	it("appends the active-goal system prompt for an active goal", async () => {
		const host = fakeHost();
		await runCommand(host, "ship the release");
		const results = await Promise.all(
			(host.handlers.get("before_agent_start") ?? []).map((handler) => handler({ systemPrompt: "BASE" }, host.makeCtx())),
		);
		const injection = results.find((result) => result !== undefined) as { systemPrompt: string } | undefined;
		expect(injection?.systemPrompt.startsWith("BASE\n\nActive thread goal:")).toBe(true);
		expect(injection?.systemPrompt).toContain("<untrusted_objective>\nship the release\n</untrusted_objective>");
	});

	it("returns undefined without an active goal", async () => {
		const host = fakeHost();
		const results = await Promise.all((host.handlers.get("before_agent_start") ?? []).map((handler) => handler({ systemPrompt: "BASE" }, host.makeCtx())));
		expect(results.every((result) => result === undefined)).toBe(true);
	});

	it("returns undefined for a paused goal", async () => {
		const host = fakeHost();
		await runCommand(host, "ship the release");
		await runCommand(host, "pause");
		const results = await Promise.all((host.handlers.get("before_agent_start") ?? []).map((handler) => handler({ systemPrompt: "BASE" }, host.makeCtx())));
		expect(results.every((result) => result === undefined)).toBe(true);
	});
});

describe("agent_end accounting", () => {
	it("adds assistant usage tokens (input - cacheRead + output) to the active goal", async () => {
		const host = fakeHost();
		await runCommand(host, "work");
		await host.fire("agent_start", {});
		await host.fire("agent_end", { messages: [assistantMessage({ input: 1_000, cacheRead: 200, output: 300 })] });
		const persisted = lastPersisted(host);
		expect(persisted).toMatchObject({ customType: "goal", data: { action: "account" } });
		const goal = (persisted?.data as { goal: { tokensUsed: number } }).goal;
		expect(goal.tokensUsed).toBe(1_100);
	});

	it("falls back to totalTokens when the measured usage is zero", async () => {
		const host = fakeHost();
		await runCommand(host, "work");
		await host.fire("agent_start", {});
		await host.fire("agent_end", { messages: [assistantMessage({ totalTokens: 700 })] });
		const goal = (lastPersisted(host)?.data as { goal: { tokensUsed: number } }).goal;
		expect(goal.tokensUsed).toBe(700);
	});

	it("accounts elapsed wall-clock seconds", async () => {
		const host = fakeHost();
		await runCommand(host, "work");
		vi.setSystemTime(Date.now() + 5_000);
		await host.fire("agent_start", {});
		vi.setSystemTime(Date.now() + 4_000);
		await host.fire("agent_end", { messages: [] });
		const goal = (lastPersisted(host)?.data as { goal: { timeUsedSeconds: number } }).goal;
		expect(goal.timeUsedSeconds).toBe(9);
	});

	it("crossing the budget flips to budgetLimited, notifies, and queues no continuation", async () => {
		const host = fakeHost();
		await runTool(host, "create_goal", { objective: "work", token_budget: 500 });
		await host.fire("agent_start", {});
		await host.fire("agent_end", { messages: [assistantMessage({ input: 800, output: 100 })] });
		const persisted = lastPersisted(host);
		expect((persisted?.data as { goal: { status: string } }).goal.status).toBe("budgetLimited");
		const notice = host.sent.find((m) => m.message.customType === "goal-ui");
		expect(notice?.message.content.startsWith("Goal limited by budget")).toBe(true);
		expect(host.sent.some((m) => m.message.customType === "goal-continuation")).toBe(false);
	});

	it("a run error with a usage/rate/quota/limit message pauses as usageLimited", async () => {
		const host = fakeHost();
		await runCommand(host, "work");
		await host.fire("agent_start", {});
		await host.fire("agent_end", { messages: [assistantMessage({ input: 10 }, { stopReason: "error", errorMessage: "rate limit exceeded" })] });
		const persisted = lastPersisted(host);
		expect(persisted?.data).toMatchObject({ action: "status", goal: { status: "usageLimited" } });
	});

	it("a run error with a generic message pauses as blocked", async () => {
		const host = fakeHost();
		await runCommand(host, "work");
		await host.fire("agent_start", {});
		await host.fire("agent_end", { messages: [assistantMessage({ input: 10 }, { stopReason: "error", errorMessage: "socket hang up" })] });
		const persisted = lastPersisted(host);
		expect(persisted?.data).toMatchObject({ action: "status", goal: { status: "blocked" } });
	});

	it("an abort in headless mode pauses the goal", async () => {
		const host = fakeHost();
		await runCommand(host, "work");
		host.sent.length = 0;
		await host.fire("agent_start", {});
		await host.fire("agent_end", { messages: [assistantMessage({ input: 10 }, { stopReason: "aborted" })] });
		const persisted = lastPersisted(host);
		expect(persisted?.data).toMatchObject({ action: "status", goal: { status: "paused" } });
		expect(host.sent.some((m) => m.message.customType === "goal-continuation")).toBe(false);
	});

	it("an abort with a UI confirmation declined keeps the goal and queues a continuation", async () => {
		const host = fakeHost();
		await runCommand(host, "work");
		await host.fire("agent_start", {});
		await host.fire(
			"agent_end",
			{ messages: [assistantMessage({ input: 10 }, { stopReason: "aborted" })] },
			host.makeCtx({ hasUI: true, ui: { confirm: async () => false } }),
		);
		expect(host.sent.some((m) => m.message.customType === "goal-continuation")).toBe(true);
	});
});

describe("continuation queueing", () => {
	it("queues exactly one continuation after a clean agent_end", async () => {
		const host = fakeHost();
		await runCommand(host, "ship it");
		host.sent.length = 0;
		await host.fire("agent_start", {});
		await host.fire("agent_end", { messages: [assistantMessage({ input: 10 })] });
		const continuations = host.sent.filter((m) => m.message.customType === "goal-continuation");
		expect(continuations).toHaveLength(1);
		expect(continuations[0]?.message.display).toBe(false);
		expect(continuations[0]?.message.details?.goalId).toBeTruthy();
		expect(continuations[0]?.options).toMatchObject({ triggerTurn: true });
		expect(continuations[0]?.message.content).toContain("<untrusted_objective>");
	});

	it("does not queue while messages are pending", async () => {
		const host = fakeHost();
		await runCommand(host, "ship it");
		host.sent.length = 0;
		await host.fire("agent_start", {});
		await host.fire("agent_end", { messages: [] }, host.makeCtx({ hasPendingMessages: () => true }));
		expect(host.sent.some((m) => m.message.customType === "goal-continuation")).toBe(false);
	});

	it("an idle session sends triggerTurn; a busy session sends followUp", async () => {
		const host = fakeHost();
		await runCommand(host, "ship it");
		host.sent.length = 0;
		await host.fire("agent_start", {});
		await host.fire("agent_end", { messages: [] }, host.makeCtx({ isIdle: () => false }));
		const continuation = host.sent.find((m) => m.message.customType === "goal-continuation");
		expect(continuation?.options).toMatchObject({ triggerTurn: true, deliverAs: "followUp" });
	});
});

describe("context pruning", () => {
	it("keeps only the newest continuation of the active goal and drops goal-ui messages", async () => {
		const host = fakeHost();
		await runCommand(host, "ship it");
		const goalId = ((lastPersisted(host)?.data as { goal: { id: string } }).goal).id;
		const messages = [
			{ role: "custom", customType: "goal-ui", content: "old ui" },
			{ role: "custom", customType: "goal-continuation", content: "stale", details: { goalId } },
			{ role: "custom", customType: "goal-continuation", content: "latest", details: { goalId } },
			{ role: "custom", customType: "goal-continuation", content: "other goal", details: { goalId: "other" } },
			{ role: "user", content: "hi" },
		];
		const results = await Promise.all((host.handlers.get("context") ?? []).map((handler) => handler({ messages }, host.makeCtx())));
		const filtered = (results[0] as { messages: typeof messages }).messages;
		expect(filtered.map((m) => (m as { content: string }).content)).toEqual(["latest", "hi"]);
	});

	it("drops all continuations once the goal is complete", async () => {
		const host = fakeHost();
		await runCommand(host, "ship it");
		const goalId = ((lastPersisted(host)?.data as { goal: { id: string } }).goal).id;
		await runTool(host, "update_goal", { status: "complete" });
		const messages = [
			{ role: "custom", customType: "goal-continuation", content: "c", details: { goalId } },
			{ role: "user", content: "hi" },
		];
		const results = await Promise.all((host.handlers.get("context") ?? []).map((handler) => handler({ messages }, host.makeCtx())));
		const filtered = (results[0] as { messages: typeof messages }).messages;
		expect(filtered).toHaveLength(1);
	});
});

describe("/goal command", () => {
	it("without arguments shows the summary of the active goal", async () => {
		const host = fakeHost();
		await runCommand(host, "ship it");
		await runCommand(host, "");
		const notice = host.sent.find((m) => m.message.customType === "goal-ui");
		expect(notice?.message.content).toContain("Status: active");
		expect(notice?.message.content).toContain("Objective: ship it");
	});

	it("with no goal set shows usage help", async () => {
		const host = fakeHost();
		await runCommand(host, "");
		const notice = host.sent.find((m) => m.message.customType === "goal-ui");
		expect(notice?.message.content.startsWith("Usage: /goal <objective>")).toBe(true);
	});

	it("an objective sets the goal, persists, and queues a continuation", async () => {
		const host = fakeHost();
		await runCommand(host, "ship it");
		const persisted = lastPersisted(host);
		expect(persisted).toMatchObject({ customType: "goal", data: { action: "set", goal: { objective: "ship it", status: "active" } } });
		expect(host.sent.some((m) => m.message.customType === "goal-continuation")).toBe(true);
	});

	it("clear removes the goal and persists a null snapshot", async () => {
		const host = fakeHost();
		await runCommand(host, "ship it");
		await runCommand(host, "clear");
		const persisted = lastPersisted(host);
		expect(persisted).toMatchObject({ customType: "goal", data: { action: "clear", goal: null } });
		expect(await runTool(host, "get_goal")).toMatchObject({ details: { goal: null } });
	});

	it("pause and resume round-trip the status", async () => {
		const host = fakeHost();
		await runCommand(host, "ship it");
		await runCommand(host, "pause");
		expect(lastPersisted(host)?.data).toMatchObject({ action: "status", goal: { status: "paused" } });
		await runCommand(host, "resume");
		expect(lastPersisted(host)?.data).toMatchObject({ action: "status", goal: { status: "active" } });
	});

	it("resume of a goal without elapsed time queues a continuation", async () => {
		const host = fakeHost();
		await runCommand(host, "ship it");
		await runCommand(host, "pause");
		host.sent.length = 0;
		await runCommand(host, "resume");
		expect(host.sent.some((m) => m.message.customType === "goal-continuation")).toBe(true);
	});

	it("edit requires interactive mode", async () => {
		const host = fakeHost();
		await runCommand(host, "ship it");
		await runCommand(host, "edit");
		const notice = host.sent.find((m) => m.message.customType === "goal-ui" && m.message.content.includes("/goal edit requires interactive mode"));
		expect(notice).toBeDefined();
	});

	it("edit replaces the objective through the editor", async () => {
		const host = fakeHost();
		await runCommand(host, "ship it");
		await runCommand(host, "edit", host.makeCtx({ hasUI: true, ui: { editor: async () => "ship it faster" } }));
		const persisted = lastPersisted(host);
		expect(persisted).toMatchObject({ customType: "goal", data: { action: "edit", goal: { objective: "ship it faster" } } });
	});

	it("edit cancelled by the editor notifies and changes nothing", async () => {
		const host = fakeHost();
		await runCommand(host, "ship it");
		const before = lastPersisted(host);
		await runCommand(host, "edit", host.makeCtx({ hasUI: true, ui: { editor: async () => undefined } }));
		expect(lastPersisted(host)).toBe(before);
		expect(host.notifications.some((n) => n.text === "Goal edit cancelled")).toBe(true);
	});

	it("an empty objective is rejected by the tools with the validation error", async () => {
		const host = fakeHost();
		await expect(runTool(host, "create_goal", { objective: "   " })).rejects.toThrow(
			"goal objective must not be empty",
		);
	});

	it("an oversized objective is rejected", async () => {
		const host = fakeHost();
		await runCommand(host, "x".repeat(4_001));
		const notice = host.sent.find((m) => m.message.customType === "goal-ui");
		expect(notice?.message.content).toContain("Goal objective is too long");
	});

	it("replacing an unfinished goal requires confirmation in interactive mode", async () => {
		const host = fakeHost();
		await runCommand(host, "first");
		await runCommand(host, "second");
		// headless: rejected
		const notice = host.sent.find((m) => m.message.customType === "goal-ui" && m.message.content.includes("unfinished goal already exists"));
		expect(notice).toBeDefined();
	});

	it("the replacement confirm dialog declines keep the original goal", async () => {
		const host = fakeHost();
		await runCommand(host, "first");
		const firstId = ((lastPersisted(host)?.data as { goal: { id: string } }).goal).id;
		await runCommand(host, "second", host.makeCtx({ hasUI: true, ui: { confirm: async () => false } }));
		const kept = lastPersisted(host)?.data as { goal: { id: string; objective: string } };
		expect(kept.goal.id).toBe(firstId);
		expect(kept.goal.objective).toBe("first");
	});

	it("argument completions list clear/edit/pause/resume", async () => {
		const host = fakeHost();
		const command = host.commands.get("goal");
		const completions = command?.getArgumentCompletions?.("") ?? [];
		expect(completions.map((item) => item.value).sort()).toEqual(["clear", "edit", "pause", "resume"]);
		expect(command?.getArgumentCompletions?.("xyz")).toBeNull();
	});
});

describe("tools", () => {
	it("get_goal reports the wire shape with threadId and budget", async () => {
		const host = fakeHost();
		await runTool(host, "create_goal", { objective: "work" });
		const result = (await runTool(host, "get_goal")) as { details: { goal: Record<string, unknown>; remainingTokens: number } };
		expect(result.details.goal).toMatchObject({ threadId: "session-1", objective: "work", status: "active", tokenBudget: 2_000_000 });
		expect(result.details.remainingTokens).toBe(2_000_000);
	});

	it("each tool returns structuredContent equivalent to the content JSON", async () => {
		const host = fakeHost();
		const created = (await runTool(host, "create_goal", { objective: "work", token_budget: 1000 })) as {
			content: Array<{ type: string; text: string }>;
			structuredContent: unknown;
		};
		expect(created.structuredContent).toEqual(JSON.parse(created.content[0]!.text));
		const got = (await runTool(host, "get_goal")) as { content: Array<{ type: string; text: string }>; structuredContent: unknown };
		expect(got.structuredContent).toEqual(JSON.parse(got.content[0]!.text));
		const updated = (await runTool(host, "update_goal", { status: "complete" })) as {
			content: Array<{ type: string; text: string }>;
			structuredContent: unknown;
		};
		expect(updated.structuredContent).toEqual(JSON.parse(updated.content[0]!.text));
		expect(updated.structuredContent).toMatchObject({ goal: { status: "complete" } });
	});

	it("create_goal persists a set entry and defaults the budget to 2M", async () => {
		const host = fakeHost();
		await runTool(host, "create_goal", { objective: "work" });
		expect(lastPersisted(host)?.data).toMatchObject({ action: "set", goal: { objective: "work", tokenBudget: 2_000_000 } });
	});

	it("create_goal honors an explicit budget and rejects invalid ones", async () => {
		const host = fakeHost();
		await runTool(host, "create_goal", { objective: "work", token_budget: 123 });
		expect((lastPersisted(host)?.data as { goal: { tokenBudget: number } }).goal.tokenBudget).toBe(123);
		await runTool(host, "update_goal", { status: "complete" });
		await expect(runTool(host, "create_goal", { objective: "again", token_budget: 0 })).rejects.toThrow(
			"goal budgets must be positive integers",
		);
	});

	it("create_goal fails while an unfinished goal exists", async () => {
		const host = fakeHost();
		await runTool(host, "create_goal", { objective: "work" });
		await expect(runTool(host, "create_goal", { objective: "another" })).rejects.toThrow("unfinished goal");
	});

	it("create_goal replaces a completed goal", async () => {
		const host = fakeHost();
		await runTool(host, "create_goal", { objective: "first" });
		await runTool(host, "update_goal", { status: "complete" });
		await runTool(host, "create_goal", { objective: "second" });
		expect(lastPersisted(host)?.data).toMatchObject({ action: "set", goal: { objective: "second" } });
	});

	it("update_goal complete persists the status and includes the completion report", async () => {
		const host = fakeHost();
		await runTool(host, "create_goal", { objective: "work", token_budget: 1000 });
		const result = (await runTool(host, "update_goal", { status: "complete" })) as { details: { goal: { status: string }; completionBudgetReport: string | null } };
		expect(result.details.goal.status).toBe("complete");
		expect(result.details.completionBudgetReport).toContain("tokens used: 0 of 1000");
		expect(lastPersisted(host)?.data).toMatchObject({ action: "status", goal: { status: "complete" } });
	});

	it("update_goal blocked persists the blocked status without a report", async () => {
		const host = fakeHost();
		await runTool(host, "create_goal", { objective: "work" });
		const result = (await runTool(host, "update_goal", { status: "blocked" })) as { details: { goal: { status: string }; completionBudgetReport: string | null } };
		expect(result.details.goal.status).toBe("blocked");
		expect(result.details.completionBudgetReport).toBeNull();
	});
});

describe("restore edge cases", () => {
	it("the later of two goal entries wins", async () => {
		const host = fakeHost();
		host.entries.push(
			goalEntry("set", { id: "g1", objective: "first", status: "active", tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 }),
			goalEntry("edit", { id: "g1", objective: "second", status: "paused", tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 2 }),
		);
		await host.fire("session_start", {});
		const result = (await runTool(host, "get_goal")) as { details: { goal: { objective: string; status: string } } };
		expect(result.details.goal.objective).toBe("second");
		expect(result.details.goal.status).toBe("paused");
	});

	it("an invalid persisted budget is dropped (budgetless goal)", async () => {
		const host = fakeHost();
		host.entries.push(
			goalEntry("set", { id: "g1", objective: "work", status: "active", tokenBudget: -5, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 }),
		);
		await host.fire("session_start", {});
		const result = (await runTool(host, "get_goal")) as { details: { goal: { tokenBudget: number | null }; remainingTokens: number | null } };
		expect(result.details.goal.tokenBudget).toBeNull();
		expect(result.details.remainingTokens).toBeNull();
	});

	it("a restored complete goal is replaced by a new objective without confirmation", async () => {
		const host = fakeHost();
		host.entries.push(
			goalEntry("status", { id: "g1", objective: "done", status: "complete", tokensUsed: 1, timeUsedSeconds: 1, createdAt: 1, updatedAt: 2 }),
		);
		await host.fire("session_start", {});
		await runCommand(host, "fresh start");
		expect(lastPersisted(host)?.data).toMatchObject({ action: "set", goal: { objective: "fresh start", status: "active" } });
	});
});

describe("before_agent_start injection details", () => {
	it("carries usage and budget numbers from the restored goal", async () => {
		const host = fakeHost();
		host.entries.push(
			goalEntry("account", { id: "g1", objective: "work", status: "active", tokenBudget: 1000, tokensUsed: 100, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 }),
		);
		await host.fire("session_start", {});
		const results = await Promise.all(
			(host.handlers.get("before_agent_start") ?? []).map((handler) => handler({ systemPrompt: "BASE" }, host.makeCtx())),
		);
		const injection = results.find((result) => result !== undefined) as { systemPrompt: string } | undefined;
		expect(injection?.systemPrompt).toContain("Tokens used: 100");
		expect(injection?.systemPrompt).toContain("Token budget: 1000");
		expect(injection?.systemPrompt).toContain("Tokens remaining: 900");
	});

	it("returns undefined for blocked and usageLimited goals", async () => {
		for (const status of ["blocked", "usageLimited", "budgetLimited", "complete"]) {
			const host = fakeHost();
			host.entries.push(
			goalEntry("status", { id: "g1", objective: "work", status, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 }),
		);
			await host.fire("session_start", {});
			const results = await Promise.all(
				(host.handlers.get("before_agent_start") ?? []).map((handler) => handler({ systemPrompt: "BASE" }, host.makeCtx())),
		);
			expect(results.every((result) => result === undefined), status).toBe(true);
		}
	});
});

describe("agent_end accounting guards", () => {
	it("a goal created mid-run (no agent_start) is not accounted", async () => {
		const host = fakeHost();
		await runCommand(host, "work");
		await host.fire("agent_end", { messages: [assistantMessage({ input: 500, output: 100 })] });
		const result = (await runTool(host, "get_goal")) as { details: { goal: { tokensUsed: number } } };
		expect(result.details.goal.tokensUsed).toBe(0);
		expect(lastPersisted(host)?.data).toMatchObject({ action: "set" });
	});

	it("a goal replaced after agent_start is not accounted to the new goal", async () => {
		const host = fakeHost();
		await runCommand(host, "first");
		await host.fire("agent_start", {});
		await runCommand(host, "second", host.makeCtx({ hasUI: true, ui: { confirm: async () => true } }));
		await host.fire("agent_end", { messages: [assistantMessage({ input: 500, output: 100 })] });
		const result = (await runTool(host, "get_goal")) as { details: { goal: { objective: string; tokensUsed: number } } };
		expect(result.details.goal.objective).toBe("second");
		expect(result.details.goal.tokensUsed).toBe(0);
	});

	it("sums multiple assistant messages and ignores other roles", async () => {
		const host = fakeHost();
		await runCommand(host, "work");
		await host.fire("agent_start", {});
		await host.fire("agent_end", {
			messages: [
				{ role: "user", content: "hi" },
			{ role: "toolResult", content: "out" },
			assistantMessage({ input: 100, cacheRead: 0, output: 50 }),
			assistantMessage({ input: 10, cacheRead: 30, output: 5, totalTokens: 20 }),
			],
		});
		const goal = (lastPersisted(host)?.data as { goal: { tokensUsed: number } }).goal;
		expect(goal.tokensUsed).toBe(155);
	});

	it("a zero-usage, zero-elapsed run persists no account entry", async () => {
		const host = fakeHost();
		await runCommand(host, "work");
		host.sent.length = 0;
		await host.fire("agent_start", {});
		await host.fire("agent_end", { messages: [] });
		expect(host.entries.filter((entry) => entry.customType === "goal" && (entry.data as { action: string }).action === "account")).toHaveLength(0);
	});

	it("reaching the budget exactly flips to budgetLimited", async () => {
		const host = fakeHost();
		await runTool(host, "create_goal", { objective: "work", token_budget: 500 });
		await host.fire("agent_start", {});
		await host.fire("agent_end", { messages: [assistantMessage({ input: 500 })] });
		expect(lastPersisted(host)?.data).toMatchObject({ goal: { status: "budgetLimited", tokensUsed: 500 } });
	});

	it("staying under the budget keeps the goal active with a continuation", async () => {
		const host = fakeHost();
		await runTool(host, "create_goal", { objective: "work", token_budget: 5000 });
		await host.fire("agent_start", {});
		await host.fire("agent_end", { messages: [assistantMessage({ input: 100 })] });
		expect(lastPersisted(host)?.data).toMatchObject({ goal: { status: "active", tokensUsed: 100 } });
		expect(host.sent.some((m) => m.message.customType === "goal-continuation")).toBe(true);
	});

	it("a paused goal at agent_end persists nothing and queues nothing", async () => {
		const host = fakeHost();
		host.entries.push(
			goalEntry("status", { id: "g1", objective: "work", status: "paused", tokensUsed: 7, timeUsedSeconds: 1, createdAt: 1, updatedAt: 2 }),
		);
		await host.fire("session_start", {});
		const entriesBefore = host.entries.length;
		await host.fire("agent_start", {});
		await host.fire("agent_end", { messages: [assistantMessage({ input: 100 })] });
		expect(host.entries.length).toBe(entriesBefore);
		expect(host.sent.some((m) => m.message.customType === "goal-continuation")).toBe(false);
	});
});

describe("continuation single-flight and failure", () => {
	it("a second agent_end without agent_start queues no second continuation", async () => {
		const host = fakeHost();
		await runCommand(host, "work");
		host.sent.length = 0;
		await host.fire("agent_start", {});
		await host.fire("agent_end", { messages: [] });
		await host.fire("agent_end", { messages: [] });
		expect(host.sent.filter((m) => m.message.customType === "goal-continuation")).toHaveLength(1);
	});

	it("a failed sendMessage notifies, and the next run can queue again", async () => {
		const host = fakeHost();
		await runCommand(host, "work");
		host.sent.length = 0;
		const pi = host.pi as { sendMessage: (message: unknown, options?: unknown) => void };
		const original = pi.sendMessage;
		pi.sendMessage = () => {
			throw new Error("boom");
		};
		await host.fire("agent_start", {});
		await host.fire("agent_end", { messages: [] });
		pi.sendMessage = original;
		expect(host.notifications.some((n) => n.text.startsWith("Failed to queue goal continuation: boom"))).toBe(true);
		await host.fire("agent_end", { messages: [] });
		expect(host.sent.filter((m) => m.message.customType === "goal-continuation")).toHaveLength(1);
	});

	it("the continuation prompt carries the budget numbers", async () => {
		const host = fakeHost();
		await runTool(host, "create_goal", { objective: "work", token_budget: 2000 });
		host.sent.length = 0;
		await host.fire("agent_start", {});
		await host.fire("agent_end", { messages: [assistantMessage({ input: 500 })] });
		const continuation = host.sent.find((m) => m.message.customType === "goal-continuation");
		expect(continuation?.message.content).toContain("Tokens used: 500");
		expect(continuation?.message.content).toContain("Token budget: 2000");
		expect(continuation?.message.content).toContain("Tokens remaining: 1500");
	});
});

describe("context pruning without a goal", () => {
	it("drops all goal-ui and continuation messages once no goal exists", async () => {
		const host = fakeHost();
		const messages = [
			{ role: "custom", customType: "goal-ui", content: "ui" },
			{ role: "custom", customType: "goal-continuation", content: "c", details: { goalId: "whatever" } },
			{ role: "user", content: "hi" },
		];
		const results = await Promise.all((host.handlers.get("context") ?? []).map((handler) => handler({ messages }, host.makeCtx())));
		const filtered = (results[0] as { messages: typeof messages }).messages;
		expect(filtered).toHaveLength(1);
		expect((filtered[0] as { content: string }).content).toBe("hi");
	});
});

describe("command edge cases", () => {
	it("subcommands match case-insensitively", async () => {
		const host = fakeHost();
		await runCommand(host, "ship it");
		await runCommand(host, "PAUSE");
		expect(lastPersisted(host)?.data).toMatchObject({ action: "status", goal: { status: "paused" } });
	});

	it("clear without a goal persists a null snapshot and says so", async () => {
		const host = fakeHost();
		await runCommand(host, "clear");
		expect(lastPersisted(host)?.data).toMatchObject({ action: "clear", goal: null });
		const notice = host.sent.find((m) => m.message.customType === "goal-ui" && m.message.content.includes("No goal to clear"));
		expect(notice).toBeDefined();
	});

	it("pause and resume without a goal report the error", async () => {
		const host = fakeHost();
		await runCommand(host, "pause");
		await runCommand(host, "resume");
		const failures = host.sent.filter(
			(m) => m.message.customType === "goal-ui" && m.message.content.includes("Failed to update thread goal"),
		);
		expect(failures).toHaveLength(2);
		expect(failures[0]?.message.content).toContain("cannot update goal because no goal exists");
	});

	it("a confirmed replacement swaps the goal for a new id", async () => {
		const host = fakeHost();
		await runCommand(host, "first");
		const firstId = ((lastPersisted(host)?.data as { goal: { id: string } }).goal).id;
		await runCommand(host, "second", host.makeCtx({ hasUI: true, ui: { confirm: async () => true } }));
		const persisted = lastPersisted(host)?.data as { action: string; goal: { id: string; objective: string } };
		expect(persisted.action).toBe("set");
		expect(persisted.goal.id).not.toBe(firstId);
		expect(persisted.goal.objective).toBe("second");
	});

	it("editing a budgetLimited goal revives it to active and queues a continuation", async () => {
		const host = fakeHost();
		await runTool(host, "create_goal", { objective: "work", token_budget: 100 });
		await host.fire("agent_start", {});
		await host.fire("agent_end", { messages: [assistantMessage({ input: 150 })] });
		host.sent.length = 0;
		await runCommand(host, "edit", host.makeCtx({ hasUI: true, ui: { editor: async () => "work v2" } }));
		expect(lastPersisted(host)?.data).toMatchObject({ action: "edit", goal: { objective: "work v2", status: "active" } });
		expect(host.sent.some((m) => m.message.customType === "goal-continuation")).toBe(true);
	});

	it("goal-ui messages never trigger a turn", async () => {
		const host = fakeHost();
		await runCommand(host, "ship it");
		const notice = host.sent.find((m) => m.message.customType === "goal-ui");
		expect(notice?.options).toMatchObject({ triggerTurn: false });
	});

	it("the budgetLimited summary offers only edit and clear", async () => {
		const host = fakeHost();
		await runTool(host, "create_goal", { objective: "work", token_budget: 100 });
		await host.fire("agent_start", {});
		await host.fire("agent_end", { messages: [assistantMessage({ input: 150 })] });
		host.sent.length = 0;
		await runCommand(host, "");
		const notice = host.sent.find((m) => m.message.customType === "goal-ui");
		expect(notice?.message.content).toContain("Status: limited by budget");
		expect(notice?.message.content).toContain("Commands: /goal edit, /goal clear");
	});
});

describe("tool edge cases", () => {
	it("create_goal rejects an oversized objective", async () => {
		const host = fakeHost();
		await expect(runTool(host, "create_goal", { objective: "x".repeat(4_001) })).rejects.toThrow(
			"Goal objective is too long",
		);
	});

	it("update_goal without a goal throws", async () => {
		const host = fakeHost();
		await expect(runTool(host, "update_goal", { status: "complete" })).rejects.toThrow(
			"cannot update goal because no goal exists",
		);
	});

	it("update_goal complete reports elapsed time", async () => {
		const host = fakeHost();
		await runCommand(host, "work");
		vi.setSystemTime(Date.now() + 3_000);
		await host.fire("agent_start", {});
		await host.fire("agent_end", { messages: [] });
		const result = (await runTool(host, "update_goal", { status: "complete" })) as { details: { completionBudgetReport: string | null } };
		expect(result.details.completionBudgetReport).toContain("time used: 3s");
	});
});

describe("status footer", () => {
	it("is only written in interactive mode", async () => {
		const host = fakeHost();
		await runCommand(host, "ship it");
		expect(host.statuses.size).toBe(0);
	});

	it("renders per-status texts", async () => {
		const host = fakeHost();
		await runCommand(host, "ship it", host.makeCtx({ hasUI: true }));
		expect(host.statuses.get("goal")).toBe("Pursuing goal (0 / 2M)");
		await runCommand(host, "pause", host.makeCtx({ hasUI: true }));
		expect(host.statuses.get("goal")).toBe("Goal paused (/goal resume)");
		await runCommand(host, "resume", host.makeCtx({ hasUI: true }));
		await runTool(host, "update_goal", { status: "blocked" }, host.makeCtx({ hasUI: true }));
		expect(host.statuses.get("goal")).toBe("Goal blocked (/goal resume)");
		await runCommand(host, "clear", host.makeCtx({ hasUI: true }));
		expect(host.statuses.get("goal")).toBeUndefined();
	});

	it("budgetLimited and complete render their own texts", async () => {
		const host = fakeHost();
		host.entries.push(
			goalEntry("status", { id: "g1", objective: "work", status: "budgetLimited", tokensUsed: 5, timeUsedSeconds: 0, createdAt: 1, updatedAt: 2 }),
		);
		await host.fire("session_start", {}, host.makeCtx({ hasUI: true }));
		expect(host.statuses.get("goal")).toBe("Goal budget reached");
	});
});

describe("time accounting", () => {
	it("elapsed time freezes while paused", async () => {
		const host = fakeHost();
		await runCommand(host, "work");
		vi.setSystemTime(Date.now() + 5_000);
		await runCommand(host, "pause");
		const atPause = ((await runTool(host, "get_goal")) as { details: { goal: { timeUsedSeconds: number } } }).details.goal.timeUsedSeconds;
		vi.setSystemTime(Date.now() + 10_000);
		const later = ((await runTool(host, "get_goal")) as { details: { goal: { timeUsedSeconds: number } } }).details.goal.timeUsedSeconds;
		expect(atPause).toBe(5);
		expect(later).toBe(5);
	});

	it("get_goal snapshots live elapsed seconds mid-session", async () => {
		const host = fakeHost();
		await runCommand(host, "work");
		vi.setSystemTime(Date.now() + 4_000);
		const result = (await runTool(host, "get_goal")) as { details: { goal: { timeUsedSeconds: number } } };
		expect(result.details.goal.timeUsedSeconds).toBe(4);
	});
});

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});
