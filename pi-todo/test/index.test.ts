/**
 * pi-todo — extension wiring tests (fake host, pi-goal test style).
 *
 * Drives the default export through a fake ExtensionAPI against a real
 * temp filesystem to pin the todos.ts behavior: todos dir bootstrap and
 * garbage collection on session_start, the todo tool's nine actions
 * (list, list-all, get, create, update, append, delete, claim, release),
 * file format round-trips, lock handling (fresh, stale headless, stale
 * stolen interactively), the headless /todos command, and the transcript
 * renderers.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import defaultExport from "../index.ts";

const TODO_PATH_ENV = "PI_TODO_PATH";
const LOCK_TTL_MS = 30 * 60 * 1000;

interface FakeUI {
	notify: (text: string, severity?: string) => void;
	confirm: (title: string, message?: string) => Promise<boolean>;
}

interface FakeCtx {
	cwd: string;
	hasUI: boolean;
	mode: "tui" | "rpc" | "json" | "print";
	sessionManager: { getSessionId: () => string; getSessionFile: () => string };
	ui: FakeUI;
}

type Handler = (event: unknown, ctx: FakeCtx) => unknown | Promise<unknown>;

interface RegisteredTool {
	name: string;
	execute: (...args: unknown[]) => Promise<unknown>;
	renderCall: (args: unknown, theme: unknown) => { render: (width: number) => string[] };
	renderResult: (
		result: unknown,
		args: { expanded: boolean; isPartial: boolean },
		theme: unknown,
		context?: { keyText: () => string; keyHint: (keybinding: string, description: string) => string },
	) => { render: (width: number) => string[] };
}

interface FakeHost {
	tools: Map<string, RegisteredTool>;
	commands: Map<string, { handler: (args: string, ctx: FakeCtx) => Promise<void> }>;
	handlers: Map<string, Handler[]>;
	notifications: Array<{ text: string; severity?: string }>;
	cwd: string;
	makeCtx: (overrides?: Partial<Omit<FakeCtx, "ui">> & { ui?: Partial<FakeUI> }) => FakeCtx;
	fire: (event: string, ev: unknown, ctx?: FakeCtx) => Promise<void>;
}

function fakeHost(cwd: string): FakeHost {
	const host: FakeHost = {
		tools: new Map(),
		commands: new Map(),
		handlers: new Map(),
		notifications: [],
		cwd,
		makeCtx: () => {
			throw new Error("not initialized");
		},
		fire: async () => {
			throw new Error("not initialized");
		},
	};
	const pi = {
		registerTool: (tool: RegisteredTool) => {
			host.tools.set(tool.name, tool);
		},
		registerCommand: (name: string, options: { handler: (args: string, ctx: FakeCtx) => Promise<void> }) => {
			host.commands.set(name, options);
		},
		on: (event: string, handler: Handler) => {
			const list = host.handlers.get(event) ?? [];
			list.push(handler);
			host.handlers.set(event, list);
		},
	};
	defaultExport(pi as unknown as ExtensionAPI);

	host.makeCtx = (overrides) => {
		const ctx: FakeCtx = {
			cwd: host.cwd,
			hasUI: false,
			mode: "print",
			sessionManager: {
				getSessionId: () => "session-1",
				getSessionFile: () => "session-1.json",
			},
			ui: {
				notify: (text, severity) => host.notifications.push({ text, severity }),
				confirm: async () => true,
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

const fakeTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

const fakeKeybindingHints = {
	keyText: () => "",
	keyHint: (_keybinding: string, description: string) => description,
};

interface ToolResult {
	content: Array<{ type: string; text: string }>;
	structuredContent?: unknown;
	details: {
		action: string;
		todo?: {
			id: string;
			title: string;
			tags: string[];
			status: string;
			created_at: string;
			assigned_to_session?: string;
			body: string;
		};
		todos?: Array<{ id: string; status: string; assigned_to_session?: string; created_at: string }>;
		currentSessionId?: string;
		error?: string;
	};
}

async function runTool(host: FakeHost, params: Record<string, unknown>, ctx?: FakeCtx): Promise<ToolResult> {
	const tool = host.tools.get("todo");
	if (!tool) throw new Error("tool todo not registered");
	return (await tool.execute("call-1", params, undefined, undefined, ctx ?? host.makeCtx())) as ToolResult;
}

async function runCommand(host: FakeHost, args: string, ctx?: FakeCtx): Promise<void> {
	const command = host.commands.get("todos");
	if (!command) throw new Error("command todos not registered");
	await command.handler(args, ctx ?? host.makeCtx());
}

function render(component: { render: (width: number) => string[] } | undefined): string {
	if (!component) return "";
	return component.render(120).join("\n");
}

/** Parses a serialized todo file: pretty-printed JSON front matter, blank line, body. */
function parseTodoFile(content: string): { frontMatter: Record<string, unknown>; body: string } {
	const end = content.indexOf("\n}\n");
	expect(end).toBeGreaterThan(0);
	const frontMatter = JSON.parse(content.slice(0, end + 2)) as Record<string, unknown>;
	const body = content.slice(end + 3).replace(/^\n+/, "");
	return { frontMatter, body };
}

interface RawTodo {
	id: string;
	title: string;
	status?: string;
	created_at: string;
	assigned_to_session?: string;
	tags?: string[];
	body?: string;
}

async function writeRawTodo(todosDir: string, todo: RawTodo): Promise<void> {
	const fm: Record<string, unknown> = {
		id: todo.id,
		title: todo.title,
		tags: todo.tags ?? [],
		status: todo.status ?? "open",
		created_at: todo.created_at,
	};
	if (todo.assigned_to_session) fm.assigned_to_session = todo.assigned_to_session;
	const serialized = JSON.stringify(fm, null, 2) + (todo.body ? `\n\n${todo.body}\n` : "\n");
	await fs.writeFile(path.join(todosDir, `${todo.id}.md`), serialized, "utf8");
}

async function createTodo(host: FakeHost, params: Record<string, unknown>, ctx?: FakeCtx): Promise<string> {
	const result = await runTool(host, { action: "create", ...params }, ctx);
	const todo = result.details.todo;
	if (!todo) throw new Error(`create failed: ${result.content[0]?.text}`);
	expect(todo.id).toMatch(/^[0-9a-f]{8}$/);
	return todo.id;
}

describe("pi-todo (todos.ts port)", () => {
	let base: string;
	let todosDir: string;
	let host: FakeHost;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		delete process.env[TODO_PATH_ENV];
		base = await fs.mkdtemp(path.join(os.tmpdir(), "pi-todo-test-"));
		todosDir = path.join(base, ".pi", "todos");
		host = fakeHost(base);
	});

	afterEach(async () => {
		delete process.env[TODO_PATH_ENV];
		await fs.rm(base, { recursive: true, force: true }).catch(() => undefined);
	});

	describe("session_start", () => {
		it("creates the todos directory under ctx.cwd by default", async () => {
			await host.fire("session_start", {});
			expect((await fs.stat(todosDir)).isDirectory()).toBe(true);
		});

		it("PI_TODO_PATH overrides the todos directory", async () => {
			const override = path.join(base, "custom-todos");
			process.env[TODO_PATH_ENV] = override;
			await host.fire("session_start", {});
			expect((await fs.stat(override)).isDirectory()).toBe(true);
		});

		it("gc deletes old closed todos and keeps open and fresh closed ones", async () => {
			await fs.mkdir(todosDir, { recursive: true });
			await fs.writeFile(
				path.join(todosDir, "settings.json"),
				JSON.stringify({ gc: true, gcDays: 7 }),
				"utf8",
			);
			const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
			await writeRawTodo(todosDir, { id: "aaaaaaaa", title: "old closed", status: "closed", created_at: old });
			await writeRawTodo(todosDir, { id: "bbbbbbbb", title: "old open", created_at: old });
			await writeRawTodo(todosDir, { id: "cccccccc", title: "fresh closed", status: "closed", created_at: new Date().toISOString() });

			await host.fire("session_start", {});

			await expect(fs.stat(path.join(todosDir, "aaaaaaaa.md"))).rejects.toThrow();
			await expect(fs.stat(path.join(todosDir, "bbbbbbbb.md"))).resolves.toBeDefined();
			await expect(fs.stat(path.join(todosDir, "cccccccc.md"))).resolves.toBeDefined();
		});

		it("gc disabled keeps old closed todos", async () => {
			await fs.mkdir(todosDir, { recursive: true });
			await fs.writeFile(path.join(todosDir, "settings.json"), JSON.stringify({ gc: false }), "utf8");
			const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
			await writeRawTodo(todosDir, { id: "aaaaaaaa", title: "old closed", status: "closed", created_at: old });

			await host.fire("session_start", {});

			await expect(fs.stat(path.join(todosDir, "aaaaaaaa.md"))).resolves.toBeDefined();
		});
	});

	describe("todo tool — create/get", () => {
		it("create writes a markdown file with JSON front matter and returns TODO-<hex>", async () => {
			const id = await createTodo(host, { title: "Add tests", tags: ["qa"], body: "Notes here." });

			const content = await fs.readFile(path.join(todosDir, `${id}.md`), "utf8");
			const { frontMatter, body } = parseTodoFile(content);
			expect(frontMatter).toMatchObject({ id, title: "Add tests", tags: ["qa"], status: "open" });
			expect(frontMatter.created_at).toEqual(expect.any(String));
			expect(new Date(frontMatter.created_at as string).toString()).not.toBe("Invalid Date");
			expect(body).toBe("Notes here.\n");
		});

		it("create echoes the new todo with the TODO- prefixed id", async () => {
			const id = await createTodo(host, { title: "Ship it" });
			const result = await runTool(host, { action: "get", id });
			expect(result.details.todo).toMatchObject({ id, title: "Ship it", status: "open" });
			expect(result.content[0]?.text).toContain(`"id": "TODO-${id}"`);
		});

		it("get accepts TODO-<hex>, raw hex, and #<hex> id forms", async () => {
			const id = await createTodo(host, { title: "Same todo" });
			for (const variant of [`TODO-${id}`, id, `#${id}`]) {
				const result = await runTool(host, { action: "get", id: variant });
				expect(result.details.todo?.id).toBe(id);
			}
			expect((await runTool(host, { action: "get", id: `TODO-${id.toUpperCase()}` })).details.todo?.id).toBe(id);
		});

		it("create without a title and get without an id return error details", async () => {
			const noTitle = await runTool(host, { action: "create" });
			expect(noTitle.details.error).toBe("title required");
			expect(noTitle.content[0]?.text).toBe("Error: title required");

			const noId = await runTool(host, { action: "get" });
			expect(noId.details.error).toBe("id required");

			const badId = await runTool(host, { action: "get", id: "not-hex!" });
			expect(badId.details.error).toBe("Invalid todo id. Expected TODO-<hex>.");
		});

		it("get of a missing todo reports not found", async () => {
			const result = await runTool(host, { action: "get", id: "deadbeef" });
			expect(result.details.error).toBe("not found");
			expect(result.content[0]?.text).toBe("Todo TODO-deadbeef not found");
		});
	});

	describe("todo tool — list/list-all", () => {
		it("list returns assigned and open todos only; list-all includes closed", async () => {
			const assigned = await createTodo(host, { title: "mine" });
			await runTool(host, { action: "claim", id: assigned });
			await createTodo(host, { title: "open one" });
			const closed = await createTodo(host, { title: "done one" });
			await runTool(host, { action: "update", id: closed, status: "closed" });

			const listed = await runTool(host, { action: "list" });
			expect(listed.details.todos?.map((todo) => todo.id)).toEqual([assigned, expect.any(String)]);
			expect(listed.details.currentSessionId).toBe("session-1");
			const listPayload = JSON.parse(listed.content[0]?.text ?? "{}") as { assigned: unknown[]; open: unknown[]; closed: unknown[] };
			expect(listPayload.assigned).toHaveLength(1);
			expect(listPayload.open).toHaveLength(1);
			expect(listPayload.closed).toHaveLength(0);
			expect(JSON.stringify(listPayload)).toContain(`TODO-${assigned}`);

			const all = await runTool(host, { action: "list-all" });
			expect(all.details.todos).toHaveLength(3);
			const allPayload = JSON.parse(all.content[0]?.text ?? "{}") as { closed: unknown[] };
			expect(allPayload.closed).toHaveLength(1);
		});

		it("sorting: assigned first among open, open before closed, created_at ascending", async () => {
			await fs.mkdir(todosDir, { recursive: true });
			await writeRawTodo(todosDir, { id: "aaaa0001", title: "open old", created_at: "2026-01-01T00:00:00.000Z" });
			await writeRawTodo(todosDir, { id: "aaaa0002", title: "assigned", created_at: "2026-01-02T00:00:00.000Z", assigned_to_session: "other" });
			await writeRawTodo(todosDir, { id: "aaaa0003", title: "closed", created_at: "2026-01-03T00:00:00.000Z", status: "closed" });
			await writeRawTodo(todosDir, { id: "aaaa0004", title: "open older", created_at: "2025-12-31T00:00:00.000Z" });

			const all = await runTool(host, { action: "list-all" });
			expect(all.details.todos?.map((todo) => todo.id)).toEqual(["aaaa0002", "aaaa0004", "aaaa0001", "aaaa0003"]);
		});

		it("non-markdown files are ignored; a garbage markdown file lists with defaults", async () => {
			await fs.mkdir(todosDir, { recursive: true });
			await fs.writeFile(path.join(todosDir, "notes.txt"), "not a todo", "utf8");
			await fs.writeFile(path.join(todosDir, "dddddddd.md"), "no front matter at all", "utf8");

			const all = await runTool(host, { action: "list-all" });
			expect(all.details.todos).toHaveLength(1);
			expect(all.details.todos?.[0]).toMatchObject({ id: "dddddddd", title: "", status: "open" });
		});
	});

	describe("todo tool — update/append", () => {
		it("update replaces fields and closing clears the assignment", async () => {
			const id = await createTodo(host, { title: "old title", body: "old body" });
			await runTool(host, { action: "claim", id });

			const result = await runTool(host, { action: "update", id, title: "new title", tags: ["x"], status: "closed", body: "new body" });
			expect(result.details.todo).toMatchObject({ id, title: "new title", tags: ["x"], status: "closed" });
			expect(result.details.todo?.assigned_to_session).toBeUndefined();

			const onDisk = parseTodoFile(await fs.readFile(path.join(todosDir, `${id}.md`), "utf8"));
			expect(onDisk.frontMatter).toMatchObject({ title: "new title", status: "closed" });
			expect("assigned_to_session" in onDisk.frontMatter).toBe(false);
		});

		it("update backfills a missing created_at", async () => {
			await fs.mkdir(todosDir, { recursive: true });
			await writeRawTodo(todosDir, { id: "eeeeeeee", title: "legacy", created_at: "" });

			const result = await runTool(host, { action: "update", id: "eeeeeeee", title: "refreshed" });
			expect(result.details.todo?.created_at).toEqual(expect.any(String));
			expect(new Date(result.details.todo?.created_at ?? "").toString()).not.toBe("Invalid Date");
		});

		it("update of a missing todo reports not found", async () => {
			const result = await runTool(host, { action: "update", id: "deadbeef", title: "x" });
			expect(result.details.error).toBe("not found");
		});

		it("append adds the text after a blank line; an empty append is a no-op", async () => {
			const id = await createTodo(host, { title: "journal", body: "first" });

			const appended = await runTool(host, { action: "append", id, body: "second" });
			expect(appended.details.todo?.body).toBe("first\n\nsecond\n");

			const empty = await runTool(host, { action: "append", id, body: "   " });
			expect(empty.details.todo?.body).toBe("first\n\nsecond\n");
		});

		it("append to a fresh todo with no body writes the text directly", async () => {
			const id = await createTodo(host, { title: "scratch" });
			const appended = await runTool(host, { action: "append", id, body: "note" });
			expect(appended.details.todo?.body).toBe("note\n");
		});
	});

	describe("todo tool — claim/release", () => {
		it("claim assigns the current session and is idempotent", async () => {
			const id = await createTodo(host, { title: "work" });
			const first = await runTool(host, { action: "claim", id });
			expect(first.details.todo?.assigned_to_session).toBe("session-1");
			const second = await runTool(host, { action: "claim", id });
			expect(second.details.error).toBeUndefined();
			expect(second.details.todo?.assigned_to_session).toBe("session-1");
		});

		it("claim by another session needs force", async () => {
			const id = await createTodo(host, { title: "contested" });
			await runTool(host, { action: "claim", id });
			const other = host.makeCtx({ sessionManager: { getSessionId: () => "session-2", getSessionFile: () => "session-2.json" } });

			const denied = await runTool(host, { action: "claim", id }, other);
			expect(denied.details.error).toContain("already assigned to session session-1");

			const forced = await runTool(host, { action: "claim", id, force: true }, other);
			expect(forced.details.todo?.assigned_to_session).toBe("session-2");
		});

		it("claim on a closed todo errors", async () => {
			const id = await createTodo(host, { title: "finished" });
			await runTool(host, { action: "update", id, status: "closed" });
			const result = await runTool(host, { action: "claim", id });
			expect(result.details.error).toBe("Todo TODO-" + id + " is closed");
		});

		it("release drops the assignment; another session needs force", async () => {
			const id = await createTodo(host, { title: "shared" });
			await runTool(host, { action: "claim", id });
			const other = host.makeCtx({ sessionManager: { getSessionId: () => "session-2", getSessionFile: () => "session-2.json" } });

			const denied = await runTool(host, { action: "release", id }, other);
			expect(denied.details.error).toContain("assigned to session session-1");

			const forced = await runTool(host, { action: "release", id, force: true }, other);
			expect(forced.details.todo?.assigned_to_session).toBeUndefined();

			const unassigned = await runTool(host, { action: "release", id });
			expect(unassigned.details.error).toBeUndefined();
			expect(unassigned.details.todo?.assigned_to_session).toBeUndefined();
		});
	});

	describe("todo tool — delete", () => {
		it("delete removes the file and returns the deleted record", async () => {
			const id = await createTodo(host, { title: "temp" });
			const result = await runTool(host, { action: "delete", id });
			expect(result.details.todo?.id).toBe(id);
			await expect(fs.stat(path.join(todosDir, `${id}.md`))).rejects.toThrow();
		});

		it("delete of a missing todo reports not found", async () => {
			const result = await runTool(host, { action: "delete", id: "deadbeef" });
			expect(result.details.error).toBe("Todo TODO-deadbeef not found");
		});
	});

	describe("locking", () => {
		it("a fresh lock file blocks mutations", async () => {
			const id = await createTodo(host, { title: "locked" });
			await fs.writeFile(path.join(todosDir, `${id}.lock`), "{}", "utf8");

			const result = await runTool(host, { action: "claim", id });
			expect(result.details.error).toContain("is locked");
		});

		it("a stale lock in headless mode errors with the rerun hint", async () => {
			const id = await createTodo(host, { title: "stale" });
			const lockPath = path.join(todosDir, `${id}.lock`);
			await fs.writeFile(lockPath, "{}", "utf8");
			const stale = new Date(Date.now() - (LOCK_TTL_MS + 60_000));
			await fs.utimes(lockPath, stale, stale);

			const result = await runTool(host, { action: "update", id, title: "x" });
			expect(result.details.error).toContain("lock is stale; rerun in interactive mode");
		});

		it("a stale lock is stolen after an interactive confirmation", async () => {
			const id = await createTodo(host, { title: "steal me" });
			const lockPath = path.join(todosDir, `${id}.lock`);
			await fs.writeFile(lockPath, "{}", "utf8");
			const stale = new Date(Date.now() - (LOCK_TTL_MS + 60_000));
			await fs.utimes(lockPath, stale, stale);

			const ctx = host.makeCtx({ hasUI: true, ui: { confirm: async () => true } });
			const result = await runTool(host, { action: "update", id, title: "stolen" }, ctx);
			expect(result.details.error).toBeUndefined();
			expect(result.details.todo?.title).toBe("stolen");
			await expect(fs.stat(lockPath)).rejects.toThrow();
		});
	});

	describe("structured output", () => {
		it("success results carry structuredContent equal to the JSON text", async () => {
			const id = await createTodo(host, { title: "structured", body: "notes" });
			const got = await runTool(host, { action: "get", id });
			expect(got.structuredContent).toEqual(JSON.parse(got.content[0].text));

			const listed = await runTool(host, { action: "list-all" });
			expect(listed.structuredContent).toEqual(JSON.parse(listed.content[0].text));
		});

		it("error results carry an error payload", async () => {
			const missing = await runTool(host, { action: "get", id: "deadbeef" });
			expect(missing.structuredContent).toEqual({ error: "Todo TODO-deadbeef not found" });

			const noId = await runTool(host, { action: "claim" });
			expect(noId.structuredContent).toEqual({ error: "Error: id required" });
		});
	});

	describe("/todos command", () => {
		it("headless prints the grouped todo list", async () => {
			const assigned = await createTodo(host, { title: "claimed task" });
			await runTool(host, { action: "claim", id: assigned });
			await createTodo(host, { title: "free task" });

			const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
			let logged = "";
			try {
				await runCommand(host, "");
			} finally {
				logged = (log.mock.calls[0]?.[0] as string) ?? "";
				expect(log).toHaveBeenCalledTimes(1);
				log.mockRestore();
			}
			expect(logged).toContain("Assigned todos (1):");
			expect(logged).toContain("Open todos (1):");
			expect(logged).toContain("Closed todos (0):");
			expect(logged).toContain("TODO-" + assigned);
			expect(logged).toContain("free task");
		});

		it("rpc mode prints the grouped todo list instead of a no-op custom() dialog", async () => {
			await createTodo(host, { title: "rpc visible" });
			const ctx = host.makeCtx({ mode: "rpc", hasUI: true });

			const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
			let logged = "";
			try {
				await runCommand(host, "", ctx);
			} finally {
				logged = (log.mock.calls[0]?.[0] as string) ?? "";
				log.mockRestore();
			}
			expect(logged).toContain("Open todos (1):");
			expect(logged).toContain("rpc visible");
		});
	});

	describe("renderers", () => {
		it("renderCall shows the action, the normalized id, and the title", async () => {
			const tool = host.tools.get("todo");
			const text = render(tool?.renderCall({ action: "update", id: "TODO-abcd1234", title: "Fix it" }, fakeTheme));
			expect(text).toContain("todo update");
			expect(text).toContain("TODO-abcd1234");
			expect(text).toContain('"Fix it"');
		});

		it("renderResult renders errors", async () => {
			const tool = host.tools.get("todo");
			const text = render(
				tool?.renderResult(
					{ content: [{ type: "text", text: "Todo TODO-deadbeef not found" }], details: { action: "get", error: "not found" } },
					{ expanded: false, isPartial: false },
					fakeTheme,
					fakeKeybindingHints,
				),
			);
			expect(text).toContain("Error: not found");
		});

		it("renderResult marks mutations with a check prefix", async () => {
			const tool = host.tools.get("todo");
			const created = await runTool(host, { action: "create", title: "fresh" });
			const text = render(tool?.renderResult(created, { expanded: false, isPartial: false }, fakeTheme, fakeKeybindingHints));
			expect(text.split("\n")[0]).toContain("✓ Created");
		});

		it("renderResult collapses sections and appends an expand hint when closed todos exist", async () => {
			for (let i = 0; i < 4; i += 1) {
				const id = await createTodo(host, { title: `done ${i}` });
				await runTool(host, { action: "update", id, status: "closed" });
			}
			const all = await runTool(host, { action: "list-all" });
			const tool = host.tools.get("todo");

			const collapsed = render(tool?.renderResult(all, { expanded: false, isPartial: false }, fakeTheme, fakeKeybindingHints));
			expect(collapsed).toContain("... 1 more");
			expect(collapsed).toContain("to expand");

			const expanded = render(tool?.renderResult(all, { expanded: true, isPartial: false }, fakeTheme, fakeKeybindingHints));
			expect(expanded).toContain("done 3");
			expect(expanded).not.toContain("... 1 more");
		});

		it("renderResult shows a processing placeholder for partial results", async () => {
			const tool = host.tools.get("todo");
			const text = render(tool?.renderResult({ content: [], details: { action: "list", todos: [] } }, { expanded: false, isPartial: true }, fakeTheme, fakeKeybindingHints));
			expect(text).toContain("Processing...");
		});
	});
});
