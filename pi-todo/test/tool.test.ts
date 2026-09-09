import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import defaultExport from "../index.ts";
import { createTodoTool, TodoParamsSchema } from "../src/tool.ts";
import { restorePhasesFromEntries, TODO_PHASES_ENTRY_TYPE, TODO_REMINDER_ENTRY_TYPE } from "../src/restore.ts";
import { Value } from "typebox/value";
import type { TodoParams } from "../src/tool.ts";
import type { TodoPhase, TodoToolDetails } from "../src/state.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

// ---------------------------------------------------------------------------
// Fakes (pi-ask-user test style: drive the default export with a fake host)
// ---------------------------------------------------------------------------

interface FakeHost {
	pi: ExtensionAPI;
	tools: Array<Record<string, unknown>>;
	commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
	handlers: Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
	entryRenderers: Map<string, (entry: unknown, options: unknown, theme: unknown) => unknown>;
	entries: Array<{ type: string; customType: string; data?: unknown }>;
	emitted: Array<{ channel: string; data: unknown }>;
	sentMessages: Array<{
		customType: string;
		content: string;
		display: boolean;
		options?: { triggerTurn?: boolean; deliverAs?: string };
	}>;
}

function fakeHost(): FakeHost {
	const host: FakeHost = {
		pi: {} as ExtensionAPI,
		tools: [],
		commands: {},
		handlers: new Map(),
		entryRenderers: new Map(),
		entries: [],
		emitted: [],
		sentMessages: [],
	};
	host.pi = {
		registerTool: (tool: unknown) => {
			host.tools.push(tool as Record<string, unknown>);
		},
		registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
			host.commands[name] = options;
		},
		registerEntryRenderer: (
			customType: string,
			renderer: (entry: unknown, options: unknown, theme: unknown) => unknown,
		) => {
			host.entryRenderers.set(customType, renderer);
		},
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			const list = host.handlers.get(event) ?? [];
			list.push(handler);
			host.handlers.set(event, list);
		},
		appendEntry: (customType: string, data?: unknown) => {
			host.entries.push({ type: "custom", customType, data });
		},
		sendMessage: (
			message: { customType: string; content: string; display: boolean },
			options?: { triggerTurn?: boolean; deliverAs?: string },
		) => {
			host.sentMessages.push({ ...message, options });
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

function sessionManagerFake(entries: unknown[], branch?: unknown[]) {
	return {
		getEntries: () => entries,
		getBranch: () => branch ?? entries,
	};
}

const passthroughTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	strikethrough: (text: string) => text,
	dim: (text: string) => text,
} as never;

async function executeTool(tool: Record<string, unknown>, params: unknown): Promise<AgentToolResult<TodoToolDetails>> {
	const execute = tool.execute as (id: string, params: unknown) => Promise<AgentToolResult<TodoToolDetails>>;
	return execute("call-1", params);
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

describe("todo tool schema", () => {
	it("rejects empty items inside init list entries (minItems 1)", () => {
		const ok = Value.Check(TodoParamsSchema, { op: "init", list: [{ phase: "A", items: ["one"] }] });
		const bad = Value.Check(TodoParamsSchema, { op: "init", list: [{ phase: "A", items: [] }] });
		expect(ok).toBe(true);
		expect(bad).toBe(false);
	});

	it("accepts a stray empty top-level items array (op-specific errors handle it)", () => {
		expect(Value.Check(TodoParamsSchema, { op: "view", items: [] })).toBe(true);
	});

	it("rejects unknown operations", () => {
		expect(Value.Check(TodoParamsSchema, { op: "explode" })).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// prepareArguments (missing-op inference)
// ---------------------------------------------------------------------------

describe("todo tool prepareArguments", () => {
	function setup(initial: TodoPhase[] = []) {
		let state = initial;
		const tool = createTodoTool({
			getPhases: () => state,
			setPhases: next => {
				state = next;
			},
			persist: () => {},
			broadcast: () => {},
		});
		return { tool, getState: () => state };
	}

	it("infers init from a non-empty list", () => {
		const { tool } = setup();
		const prepared = (tool.prepareArguments as (args: unknown) => TodoParams)({ list: [{ phase: "A", items: ["a"] }] });
		expect(prepared.op).toBe("init");
	});

	it("infers append from items plus phase", () => {
		const { tool } = setup([{ name: "A", tasks: [{ content: "x", status: "in_progress" }] }]);
		const prepared = (tool.prepareArguments as (args: unknown) => TodoParams)({ items: ["y"], phase: "A" });
		expect(prepared.op).toBe("append");
	});

	it("infers init from bare items only when nothing exists", () => {
		const empty = setup();
		expect((empty.tool.prepareArguments as (args: unknown) => TodoParams)({ items: ["y"] }).op).toBe("init");
		const occupied = setup([{ name: "A", tasks: [{ content: "x", status: "pending" }] }]);
		expect((occupied.tool.prepareArguments as (args: unknown) => TodoParams)({ items: ["y"] }).op).toBeUndefined();
	});

	it("leaves explicit ops untouched", () => {
		const { tool } = setup();
		const args = { op: "view", items: [] };
		expect((tool.prepareArguments as (args: unknown) => TodoParams)(args)).toEqual(args);
	});
});

// ---------------------------------------------------------------------------
// Execute end-to-end
// ---------------------------------------------------------------------------

describe("todo tool execute", () => {
	it("applies init, persists a snapshot, and broadcasts once", async () => {
		const host = fakeHost();
		defaultExport(host.pi);
		const tool = host.tools[0] as Record<string, unknown>;
		const result = await executeTool(tool, {
			op: "init",
			list: [{ phase: "Foundation", items: ["scaffold", "wire"] }],
		});
		expect(result.details?.op).toBe("init");
		expect(result.details?.storage).toBe("session");
		expect(result.details?.phases[0].tasks[0].status).toBe("in_progress");
		expect(result.content[0]).toMatchObject({ type: "text" });
		expect(host.entries).toHaveLength(1);
		expect(host.entries[0].customType).toBe(TODO_PHASES_ENTRY_TYPE);
		expect(host.emitted).toEqual([{ channel: "todo_updated", data: { phases: result.details?.phases.map((p: TodoPhase) => ({ ...p, tasks: [...p.tasks] })) } }]);
	});

	it("discards failing batches wholesale: no persist, no broadcast, throws", async () => {
		const host = fakeHost();
		defaultExport(host.pi);
		const tool = host.tools[0] as Record<string, unknown>;
		await executeTool(tool, { op: "init", list: [{ phase: "A", items: ["a1"] }] });
		host.entries.length = 0;
		host.emitted.length = 0;

		const thrown = await executeTool(tool, { op: "append", phase: "B", items: ["novel", "a1"] }).then(
			() => null,
			(err: unknown) => (err instanceof Error ? err : new Error(String(err))),
		);
		expect(thrown).toBeInstanceOf(Error);
		// The thrown message carries the unchanged list for the model's retry.
		expect(thrown?.message).toContain("already exists");
		expect(thrown?.message).toContain("a1");
		expect(host.entries).toHaveLength(0);
		expect(host.emitted).toHaveLength(0);
	});

	it("treats view as a read: no persist, no broadcast", async () => {
		const host = fakeHost();
		defaultExport(host.pi);
		const tool = host.tools[0] as Record<string, unknown>;
		await executeTool(tool, { op: "init", list: [{ phase: "A", items: ["a1"] }] });
		host.entries.length = 0;
		host.emitted.length = 0;

		const result = await executeTool(tool, { op: "view" });
		expect(result.details?.op).toBe("view");
		expect(host.entries).toHaveLength(0);
		expect(host.emitted).toHaveLength(0);
	});

	it("reports completion transitions for done", async () => {
		const host = fakeHost();
		defaultExport(host.pi);
		const tool = host.tools[0] as Record<string, unknown>;
		await executeTool(tool, { op: "init", list: [{ phase: "A", items: ["a1", "a2"] }] });
		const result = await executeTool(tool, { op: "done", task: "a1" });
		expect(result.details?.completedTasks).toEqual([{ phase: "A", content: "a1" }]);
	});
});

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

describe("todo restore", () => {
	it("restores the latest valid snapshot and skips malformed entries", () => {
		const entries = [
			{ type: "message", role: "user" },
			{ type: "custom", customType: TODO_PHASES_ENTRY_TYPE, data: { phases: [{ name: "A", tasks: [{ content: "old", status: "completed" }] }] } },
			{ type: "custom", customType: TODO_PHASES_ENTRY_TYPE, data: { phases: "garbage" } },
			{ type: "custom", customType: TODO_PHASES_ENTRY_TYPE, data: { phases: [{ name: "B", tasks: [{ content: "new", status: "pending" }] }] } },
		];
		const restored = restorePhasesFromEntries(entries);
		expect(restored).toEqual([{ name: "B", tasks: [{ content: "new", status: "pending" }] }]);
	});

	it("returns empty for sessions without todo entries", () => {
		expect(restorePhasesFromEntries([{ type: "message", role: "user" }])).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Session wiring: session_start restore + stop reminder
// ---------------------------------------------------------------------------

describe("todo extension wiring", () => {
	it("restores state on session_start", async () => {
		const host = fakeHost();
		defaultExport(host.pi);
		const entries = [
			{ type: "custom", customType: TODO_PHASES_ENTRY_TYPE, data: { phases: [{ name: "A", tasks: [{ content: "kept", status: "in_progress" }] }] } },
		];
		const handlers = host.handlers.get("session_start") ?? [];
		for (const handler of handlers) {
			await handler({ type: "session_start", reason: "resume" }, { sessionManager: sessionManagerFake(entries) });
		}
		const tool = host.tools[0] as Record<string, unknown>;
		const result = await executeTool(tool, { op: "view" });
		expect(result.details?.phases).toEqual([{ name: "A", tasks: [{ content: "kept", status: "in_progress" }] }]);
	});

	it("restore is branch-aware: abandoned-branch snapshots never win", async () => {
		const host = fakeHost();
		defaultExport(host.pi);
		// Full file contains a LATER snapshot written on an abandoned branch
		// (created by /fork or /tree); the current branch ends at the older one.
		const allEntries = [
			{ type: "custom", customType: TODO_PHASES_ENTRY_TYPE, data: { phases: [{ name: "Current", tasks: [{ content: "current-task", status: "in_progress" }] }] } },
			{ type: "custom", customType: TODO_PHASES_ENTRY_TYPE, data: { phases: [{ name: "Abandoned", tasks: [{ content: "abandoned-task", status: "pending" }] }] } },
		];
		const currentBranch = [allEntries[0]];
		const handlers = host.handlers.get("session_start") ?? [];
		for (const handler of handlers) {
			await handler({ type: "session_start", reason: "resume" }, { sessionManager: sessionManagerFake(allEntries, currentBranch) });
		}
		const tool = host.tools[0] as Record<string, unknown>;
		const result = await executeTool(tool, { op: "view" });
		expect(result.details?.phases).toEqual([{ name: "Current", tasks: [{ content: "current-task", status: "in_progress" }] }]);
	});

	it("stop reminder matches omp checkCompletion: nag text, followUp turn, 3-attempt cycle", async () => {
		const host = fakeHost();
		defaultExport(host.pi);
		const tool = host.tools[0] as Record<string, unknown>;
		const endHandlers = host.handlers.get("agent_end") ?? [];
		const assistantMsg = { role: "assistant", content: [{ type: "text", text: "Working on it." }] };
		const fireAgentEnd = async () => {
			for (const handler of endHandlers) {
				await handler({ type: "agent_end", messages: [assistantMsg] }, {});
			}
		};

		// No todos: silent.
		await fireAgentEnd();
		expect(host.sentMessages.filter(m => m.customType === "todo-reminder")).toHaveLength(0);

		// Blocked-only work is parked, not nagged (omp counts pending+in_progress).
		await executeTool(tool, { op: "init", list: [{ phase: "A", items: ["a1"] }] });
		await executeTool(tool, { op: "block", task: "a1", reason: "ci down" });
		await fireAgentEnd();
		expect(host.sentMessages.filter(m => m.customType === "todo-reminder")).toHaveLength(0);

		// A pending task survives: omp reminder text + continuation turn.
		await executeTool(tool, { op: "append", phase: "A", items: ["a2"] });
		await fireAgentEnd();
		const first = host.sentMessages.find(m => m.customType === "todo-reminder");
		expect(first?.display).toBe(false);
		expect(first?.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
		expect(first?.content).toContain("<system-reminder>");
		expect(first?.content).toContain("You stopped with 1 incomplete todo item(s):");
		expect(first?.content).toContain("- A\n  - a2");
		expect(first?.content).toContain("(Reminder 1/3)");
		// Transcript-anchored component text (omp TodoReminderComponent).
		const reminderEntry = host.entries.find(e => e.customType === TODO_REMINDER_ENTRY_TYPE);
		expect(reminderEntry?.data).toMatchObject({ count: 1, attempt: 1, maxAttempts: 3 });

		// Attempts count up to the omp default max of 3, then stop.
		host.sentMessages.length = 0;
		await fireAgentEnd();
		await fireAgentEnd();
		await fireAgentEnd();
		const reminders = host.sentMessages.filter(m => m.customType === "todo-reminder");
		expect(reminders).toHaveLength(2);
		expect(reminders[0]?.content).toContain("(Reminder 2/3)");
		expect(reminders[1]?.content).toContain("(Reminder 3/3)");

		// omp resetCycle: a fresh user prompt restarts the cycle.
		const startHandlers = host.handlers.get("message_start") ?? [];
		for (const handler of startHandlers) {
			await handler({ type: "message_start", message: { role: "user" } }, {});
		}
		host.sentMessages.length = 0;
		await fireAgentEnd();
		expect(host.sentMessages.filter(m => m.customType === "todo-reminder")).toHaveLength(1);
		expect(host.sentMessages[0]?.content).toContain("(Reminder 1/3)");

		// Close everything: silent again.
		host.sentMessages.length = 0;
		await executeTool(tool, { op: "done", task: "a2" });
		await executeTool(tool, { op: "unblock", task: "a1" });
		await executeTool(tool, { op: "done", task: "a1" });
		await fireAgentEnd();
		expect(host.sentMessages.filter(m => m.customType === "todo-reminder")).toHaveLength(0);
	});

	it("skips the reminder when the assistant ended by asking the user (omp isAwaitingUserAnswer)", async () => {
		const host = fakeHost();
		defaultExport(host.pi);
		await executeTool(host.tools[0] as Record<string, unknown>, {
			op: "init",
			list: [{ phase: "A", items: ["a1"] }],
		});
		const endHandlers = host.handlers.get("agent_end") ?? [];
		for (const handler of endHandlers) {
			await handler(
				{
					type: "agent_end",
					messages: [{ role: "assistant", content: [{ type: "text", text: "Which database should I use?" }] }],
				},
				{},
			);
		}
		expect(host.sentMessages.filter(m => m.customType === "todo-reminder")).toHaveLength(0);
	});

	it("registers an entry renderer for reminders and a /todo command", () => {
		const host = fakeHost();
		defaultExport(host.pi);
		expect(host.entryRenderers.has(TODO_REMINDER_ENTRY_TYPE)).toBe(true);
		expect(host.commands.todo).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// /todo command (omp todo-command-controller verb set)
// ---------------------------------------------------------------------------

describe("todo command", () => {
	function commandHost() {
		const host = fakeHost();
		defaultExport(host.pi);
		const tool = host.tools[0] as Record<string, unknown>;
		return { host, run: host.commands.todo.handler, tool };
	}

	interface UiStub {
		notifications: Array<{ text: string; type?: string }>;
		notify(text: string, type?: string): void;
	}

	function uiStub(): UiStub {
		const notifications: Array<{ text: string; type?: string }> = [];
		return {
			notifications,
			notify: (text: string, type?: string) => {
				notifications.push({ text, type });
			},
		};
	}

	function makeCtx(ui: UiStub, extra: Record<string, unknown> = {}) {
		return {
			hasUI: true,
			ui: { ...ui, confirm: async () => true, editor: async () => undefined },
			cwd: "/tmp",
			...extra,
		};
	}

	it("empty /todo shows the Markdown checklist (omp phasesToMarkdown view)", async () => {
		const { run, tool } = commandHost();
		await executeTool(tool, {
			op: "init",
			list: [{ phase: "Auth", items: ["a1", "a2"] }],
		});
		const ui = uiStub();
		await run("", makeCtx(ui));
		expect(ui.notifications[0]?.text).toContain("# Auth");
		// omp normalizeInProgressTask auto-promotes the first pending task.
		expect(ui.notifications[0]?.text).toContain("- [/] a1");
		expect(ui.notifications[0]?.text).toContain("- [ ] a2");
	});

	it("empty state reports the omp hint", async () => {
		const { run } = commandHost();
		const ui = uiStub();
		await run("", makeCtx(ui));
		expect(ui.notifications[0]?.text).toBe("No todos. Use /todo append <task> to start one.");
	});

	it("append fuzzy-matches the phase and title-cases the task (omp #append)", async () => {
		const { run, tool } = commandHost();
		await executeTool(tool, { op: "init", list: [{ phase: "Auth Work", items: ["a1"] }] });
		const ui = uiStub();
		await run("append auth wire oauth", makeCtx(ui));
		expect(ui.notifications[0]?.text).toBe("Appended to Auth Work: Wire oauth");
		const view: string[] = [];
		await run("", { hasUI: true, ui: { notify: (m: string) => view.push(m) } });
		expect(view.join("\n")).toContain("- [ ] Wire oauth");
	});

	it("append without a phase targets the last phase; quoted tasks tokenize", async () => {
		const { run, tool } = commandHost();
		await executeTool(tool, {
			op: "init",
			list: [
				{ phase: "One", items: ["x"] },
				{ phase: "Two", items: ["y"] },
			],
		});
		const ui = uiStub();
		// omp tokenizer: backslash-escaped quotes survive inside a quoted run.
		await run('append "fix the \\"quoted\\" thing"', makeCtx(ui));
		expect(ui.notifications[0]?.text).toBe('Appended to Two: Fix the "quoted" thing');
	});

	it("start fuzzy-matches a task (omp #start)", async () => {
		const { run, tool } = commandHost();
		await executeTool(tool, { op: "init", list: [{ phase: "A", items: ["Wire OAuth providers"] }] });
		const ui = uiStub();
		await run("start oauth", makeCtx(ui));
		expect(ui.notifications[0]?.text).toBe("Started: Wire OAuth providers");
	});

	it("start without a match reports the omp error", async () => {
		const { run } = commandHost();
		const ui = uiStub();
		await run("start nonexistent", makeCtx(ui));
		expect(ui.notifications[0]?.text).toBe('No task matched "nonexistent". Use /todo to list current tasks.');
		expect(ui.notifications[0]?.type).toBe("error");
	});

	it("done marks a task / a phase / everything (omp #mutateStatus)", async () => {
		const { host, run, tool } = commandHost();
		await executeTool(tool, {
			op: "init",
			list: [
				{ phase: "One", items: ["t1", "t2"] },
				{ phase: "Two", items: ["t3"] },
			],
		});

		const ui = uiStub();
		await run("done t1", makeCtx(ui));
		expect(ui.notifications[0]?.text).toBe("Marked completed: t1");

		await run("done two", makeCtx(ui));
		expect(ui.notifications[1]?.text).toBe("Marked phase Two completed.");

		await run("done", makeCtx(ui));
		expect(ui.notifications[2]?.text).toBe("Marked all tasks completed.");

		const view: string[] = [];
		await run("", { hasUI: true, ui: { notify: (m: string) => view.push(m) } });
		// omp #showCurrent renders the Markdown checklist.
		expect(view.join("\n")).toContain("- [x] t1");
		expect(view.join("\n")).toContain("- [x] t3");
		expect(host.entries.some(e => e.customType === TODO_PHASES_ENTRY_TYPE)).toBe(true);
	});

	it("drop marks abandoned; rm removes tasks and phases (omp verbs)", async () => {
		const { host, run, tool } = commandHost();
		await executeTool(tool, {
			op: "init",
			list: [
				{ phase: "One", items: ["t1", "t2"] },
				{ phase: "Two", items: ["t3"] },
			],
		});

		const ui = uiStub();
		await run("drop t1", makeCtx(ui));
		expect(ui.notifications[0]?.text).toBe("Marked abandoned: t1");

		await run("rm t2", makeCtx(ui));
		expect(ui.notifications[1]?.text).toBe("Removed: t2");

		await run("rm two", makeCtx(ui));
		expect(ui.notifications[2]?.text).toBe("Removed phase: Two");

		// /todo rm (no arg) clears everything with the omp removed-intent reminder.
		host.sentMessages.length = 0;
		await run("rm", makeCtx(ui));
		expect(ui.notifications[3]?.text).toBe("Cleared all todos.");
		const reminder = host.sentMessages.find(m => m.customType === "todo-user-edit");
		expect(reminder?.content).toContain("The user manually modified the todo list (/todo rm (all)).");
		expect(reminder?.content).toContain(
			"The user intentionally cleared the todo list. Do NOT recreate or re-populate it",
		);
		expect(reminder?.display).toBe(false);
	});

	it("unknown task/phase targets report the omp error", async () => {
		const { run, tool } = commandHost();
		await executeTool(tool, { op: "init", list: [{ phase: "A", items: ["a1"] }] });
		const ui = uiStub();
		await run("done zap", makeCtx(ui));
		expect(ui.notifications[0]?.text).toBe('No task or phase matched "zap".');
		expect(ui.notifications[0]?.type).toBe("error");
	});

	it("copy prints the Markdown checklist (omp ACP fallback text)", async () => {
		const { run, tool } = commandHost();
		await executeTool(tool, { op: "init", list: [{ phase: "A", items: ["a1"] }] });
		const ui = uiStub();
		await run("copy", makeCtx(ui));
		expect(ui.notifications[0]?.text).toContain("Copy not available");
		expect(ui.notifications[0]?.text).toContain("- [/] a1");
	});

	it("help prints the omp usage block; unknown verbs error with it", async () => {
		const { run } = commandHost();
		const ui = uiStub();
		await run("help", makeCtx(ui));
		expect(ui.notifications[0]?.text).toContain("Usage: /todo <verb> [args]");
		expect(ui.notifications[0]?.text).toContain("/todo append [<phase>] <task...>");

		await run("explode", makeCtx(ui));
		expect(ui.notifications[1]?.type).toBe("error");
		expect(ui.notifications[1]?.text).toContain('Unknown /todo verb "explode".');
		expect(ui.notifications[1]?.text).toContain("Usage: /todo <verb> [args]");
	});

	it("export writes the Markdown file; import restores it (omp round-trip)", async () => {
		const { host, run, tool } = commandHost();
		await executeTool(tool, {
			op: "init",
			list: [
				{ phase: "One", items: ["t1"] },
				{ phase: "Two", items: ["t2", "t3"] },
			],
		});
		await executeTool(tool, { op: "done", task: "t1" });

		const ui = uiStub();
		const target = path.join(tmpdir(), `pi-todo-test-${Date.now()}.md`);
		await run(`export ${target}`, makeCtx(ui));
		expect(ui.notifications[0]?.text).toBe(`Wrote todos to ${target}`);
		const written = readFileSync(target, "utf8");
		expect(written).toContain("# One");
		expect(written).toContain("- [x] t1");

		// Wipe state, then import.
		await run("rm", makeCtx(ui));
		ui.notifications.length = 0;
		await run(`import ${target}`, makeCtx(ui));
		expect(ui.notifications[0]?.text).toBe(`Imported 2 phase(s), 3 task(s) from ${target}.`);
		const view: string[] = [];
		await run("", { hasUI: true, ui: { notify: (m: string) => view.push(m) } });
		expect(view.join("\n")).toContain("[x] t1");
		expect(view.join("\n")).toContain("# Two");
		void host;
	});

	it("import failure reports the omp read error", async () => {
		const { run } = commandHost();
		const ui = uiStub();
		await run("import /nonexistent/pi-todo-missing.md", makeCtx(ui));
		expect(ui.notifications[0]?.text).toContain("Failed to read todos:");
		expect(ui.notifications[0]?.type).toBe("error");
	});

	it("edit round-trips through the dialog editor (omp $EDITOR adaptation)", async () => {
		const { host, run, tool } = commandHost();
		await executeTool(tool, { op: "init", list: [{ phase: "A", items: ["a1"] }] });
		const edited = "# A\n- [/] a1\n- [ ] a2\n";
		const ui = uiStub();
		const ctx = makeCtx(ui, {});
		(ctx.ui as Record<string, unknown>).editor = async () => edited;
		await run("edit", ctx);
		expect(ui.notifications[0]?.text).toBe("Todos updated from editor: 1 phase(s), 2 task(s).");
		// Reminder tells the agent about the manual edit (omp #commit step 3).
		const reminder = host.sentMessages.find(m => m.customType === "todo-user-edit");
		expect(reminder?.content).toContain("The user manually modified the todo list (/todo edit).");
		expect(reminder?.content).toContain("<system-reminder>");
	});

	it("edit cancel leaves todos unchanged with the omp warning", async () => {
		const { host, run, tool } = commandHost();
		await executeTool(tool, { op: "init", list: [{ phase: "A", items: ["a1"] }] });
		host.sentMessages.length = 0;
		const ui = uiStub();
		const ctx = makeCtx(ui);
		(ctx.ui as Record<string, unknown>).editor = async () => undefined;
		await run("edit", ctx);
		expect(ui.notifications[0]?.text).toBe("Editor exited without saving; todos unchanged.");
		expect(ui.notifications[0]?.type).toBe("warning");
		expect(host.sentMessages).toHaveLength(0);
	});

	it("headless mode degrades to stderr text", async () => {
		const { run, tool } = commandHost();
		await executeTool(tool, { op: "init", list: [{ phase: "A", items: ["a1"] }] });
		const stderr: string[] = [];
		const spy = vi.spyOn(console, "error").mockImplementation((message: unknown) => {
			stderr.push(String(message));
		});
		await run("", { hasUI: false, ui: { notify: () => {} } });
		expect(stderr.at(-1)).toContain("- [/] a1");
		spy.mockRestore();
	});
});
