import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import defaultExport from "../index.ts";
import type { AskToolDetails, ExtensionAskDialogResult } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const passthroughTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	strikethrough: (text: string) => text,
	underline: (text: string) => text,
} as never;

const KEY_MAP: Record<string, string> = {
	"\r": "tui.select.confirm",
	"\x1b": "tui.select.cancel",
	"\x1b[A": "tui.select.up",
	"\x1b[B": "tui.select.down",
};

const fakeKeybindings = {
	matches: (data: string, id: string) => KEY_MAP[data] === id,
	getKeys: () => [] as string[],
} as never;

const fakeTui = { requestRender: () => {}, terminal: { rows: 40, columns: 80 } };

/** TUI-style host: ui.custom mounts the dialog and tests drive it. */
class FakeTuiUi {
	dialogs: Array<{ handleInput: (data: string) => void; render: (w: number) => string[] }> = [];

	custom<T>(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (v: T) => void) => unknown): Promise<T> {
		return new Promise<T>(resolve => {
			const dialog = factory(fakeTui, passthroughTheme, fakeKeybindings, (value: T) => resolve(value)) as {
				handleInput: (data: string) => void;
				render: (w: number) => string[];
			};
			this.dialogs.push(dialog);
		});
	}

	select(_title: string, _options: string[]): Promise<string | undefined> {
		return Promise.resolve(undefined);
	}

	input(_title: string, _placeholder?: string): Promise<string | undefined> {
		return Promise.resolve(undefined);
	}

	editor(_title: string, _prefill?: string): Promise<string | undefined> {
		return Promise.resolve(undefined);
	}
}

/** RPC-style host: custom() resolves undefined; native dialogs carry the flow. */
class FakeRpcUi {
	selects: Array<{ title: string; options: string[]; opts?: Record<string, unknown> }> = [];
	selectScript: Array<string | undefined> = [];
	inputScript: Array<string | undefined> = [];
	inputs: Array<{ title: string; placeholder?: string }> = [];

	custom(): Promise<undefined> {
		return Promise.resolve(undefined);
	}

	select(title: string, options: string[], opts?: Record<string, unknown>): Promise<string | undefined> {
		this.selects.push({ title, options, opts });
		const choice = this.selectScript.shift();
		if (choice === "__HANG__") return new Promise(() => {});
		return Promise.resolve(choice);
	}

	input(title: string, placeholder?: string): Promise<string | undefined> {
		this.inputs.push({ title, placeholder });
		return Promise.resolve(this.inputScript.shift());
	}

	editor(title: string): Promise<string | undefined> {
		this.inputs.push({ title });
		return Promise.resolve(this.inputScript.shift());
	}
}

interface FakePi {
	tools: Map<string, { execute: (...args: never[]) => Promise<unknown> }>;
	handlers: Map<string, Array<(event: unknown, ctx: unknown) => Promise<unknown>>>;
	activeTools: string[];
	registerTool(tool: { name: string; execute: (...args: never[]) => Promise<unknown> }): void;
	on(event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>): void;
	getActiveTools(): string[];
	setActiveTools(names: string[]): void;
}

function createFakePi(): FakePi {
	const pi: FakePi = {
		tools: new Map(),
		handlers: new Map(),
		activeTools: ["read", "ask"],
		registerTool(tool) {
			pi.tools.set(tool.name, tool);
		},
		on(event, handler) {
			const list = pi.handlers.get(event) ?? [];
			list.push(handler);
			pi.handlers.set(event, list);
		},
		getActiveTools() {
			return [...pi.activeTools];
		},
		setActiveTools(names) {
			pi.activeTools = [...names];
		},
	};
	defaultExport(pi as never);
	return pi;
}

function makeCtx(ui: unknown, mode: "tui" | "rpc" | "print" = "tui"): Record<string, unknown> {
	return { hasUI: mode !== "print", mode, ui, abort: () => {} };
}

interface ToolResultLike {
	content: Array<{ type: string; text?: string }>;
	details?: Partial<AskToolDetails>;
}

async function runAsk(pi: FakePi, ui: unknown, params: object, mode: "tui" | "rpc" | "print" = "tui"): Promise<ToolResultLike> {
	const tool = pi.tools.get("ask");
	if (!tool) throw new Error("ask not registered");
	return (await tool.execute("call-1" as never, params as never, undefined as never, undefined as never, makeCtx(ui, mode) as never)) as ToolResultLike;
}

const SINGLE_PARAMS = {
	questions: [
		{
			id: "auth",
			question: "Which auth method?",
			options: [
				{ label: "JWT", description: "stateless bearer tokens" },
				{ label: "Session" },
			],
			recommended: 0,
		},
	],
};

// ---------------------------------------------------------------------------
// Registration & host gating
// ---------------------------------------------------------------------------

describe("ask tool registration", () => {
	beforeEach(() => {
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("registers the ask tool", () => {
		expect(createFakePi().tools.has("ask")).toBe(true);
	});

	it("hides the tool on session_start without UI", async () => {
		const pi = createFakePi();
		await pi.handlers.get("session_start")![0]!({}, { hasUI: false });
		expect(pi.getActiveTools()).not.toContain("ask");
	});

	it("keeps the tool when a UI is present", async () => {
		const pi = createFakePi();
		await pi.handlers.get("session_start")![0]!({}, { hasUI: true });
		expect(pi.getActiveTools()).toContain("ask");
	});

	it("throws a never-displayed error without a UI host", async () => {
		const pi = createFakePi();
		const ui = new FakeTuiUi();
		await expect(runAsk(pi, ui, SINGLE_PARAMS, "print")).rejects.toThrow(/never shown to the user/);
		expect(ui.dialogs.length).toBe(0);
	});

	it("rejects reserved option labels", async () => {
		const pi = createFakePi();
		const ui = new FakeTuiUi();
		await expect(
			runAsk(pi, ui, {
				questions: [{ ...SINGLE_PARAMS.questions[0]!, options: [{ label: "Chat about this" }, { label: "x" }] }],
			}),
		).rejects.toThrow(/reserved runtime label/);
	});
});

// ---------------------------------------------------------------------------
// Rich dialog path (TUI)
// ---------------------------------------------------------------------------

describe("ask tool rich dialog path", () => {
	beforeEach(() => {
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns omp single-question semantics", async () => {
		const pi = createFakePi();
		const ui = new FakeTuiUi();
		const pending = runAsk(pi, ui, SINGLE_PARAMS);
		await new Promise(r => setTimeout(r, 0));
		expect(ui.dialogs.length).toBe(1);
		ui.dialogs[0]!.handleInput("\r"); // select JWT, submit (single question)
		const result = await pending;
		expect(result.content[0].text).toBe("User selected: JWT");
		expect(result.details).toMatchObject({
			question: "Which auth method?",
			selectedOptions: ["JWT"],
			multi: false,
		});
	});

	it("returns omp multi-question semantics", async () => {
		const pi = createFakePi();
		const ui = new FakeTuiUi();
		const pending = runAsk(pi, ui, {
			questions: [
				...SINGLE_PARAMS.questions,
				{ id: "deploy", question: "Where?", options: [{ label: "staging" }, { label: "prod" }], multi: true },
			],
		});
		await new Promise(r => setTimeout(r, 0));
		ui.dialogs[0]!.handleInput("\r"); // q1 select+advance
		ui.dialogs[0]!.handleInput(" "); // q2 toggle staging
		ui.dialogs[0]!.handleInput("\r"); // advance to Submit tab
		ui.dialogs[0]!.handleInput("\r"); // submit
		const result = await pending;
		expect(result.content[0].text).toBe("User answers:\nauth: JWT\ndeploy: [staging]");
	});

	it("maps a chat redirect result", async () => {
		const pi = createFakePi();
		const ui = new FakeTuiUi();
		const pending = runAsk(pi, ui, SINGLE_PARAMS);
		await new Promise(r => setTimeout(r, 0));
		// Drive the dialog straight to a chat outcome via externalCancel is not
		// the chat path; instead simulate by resolving the custom promise with
		// a chat result — exercised through a dedicated host.
		const chatUi = {
			dialogs: [] as unknown[],
			custom<T>(): Promise<T> {
				return Promise.resolve({ kind: "chat" } as T);
			},
		};
		const chatResult = await runAsk(pi, chatUi, SINGLE_PARAMS);
		expect(chatResult.content[0].text).toContain("User chose to chat about this");
		expect(chatResult.details?.chatRedirect).toBe(true);
		void pending;
		void ui;
	});

	it("cancelling the dialog aborts the turn with an error (omp semantics)", async () => {
		const pi = createFakePi();
		const ui = new FakeTuiUi();
		let aborted = false;
		const tool = pi.tools.get("ask")!;
		const pending = tool.execute(
			"call-1" as never,
			SINGLE_PARAMS as never,
			undefined as never,
			undefined as never,
			{ hasUI: true, mode: "tui", ui, abort: () => (aborted = true) } as never,
		);
		await new Promise(r => setTimeout(r, 0));
		ui.dialogs[0]!.handleInput("\x1b"); // cancel
		await expect(pending).rejects.toThrow("Ask tool was cancelled by the user");
		expect(aborted).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Legacy path (RPC)
// ---------------------------------------------------------------------------

describe("ask tool legacy path (RPC)", () => {
	beforeEach(() => {
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("walks questions through native selects with progress titles", async () => {
		const pi = createFakePi();
		const ui = new FakeRpcUi();
		ui.selectScript.push("JWT", "+ Done selecting");
		const result = await runAsk(pi, ui, {
			questions: [
				...SINGLE_PARAMS.questions,
				{ id: "deploy", question: "Where?", options: [{ label: "staging" }, { label: "prod" }], multi: true },
			],
		}, "rpc");
		expect(ui.selects[0]?.title).toBe("Which auth method? (1/2)");
		expect(ui.selects[0]?.options).toEqual(["JWT (Recommended)", "Session", "Other (type your own)"]);
		expect(ui.selects[1]?.title).toBe("Where? (2/2)");
		expect(result.content[0].text).toBe("User answers:\nauth: JWT\ndeploy: []");
	});

	it("descriptions are dropped from pi's string[] select options", async () => {
		const pi = createFakePi();
		const ui = new FakeRpcUi();
		ui.selectScript.push("Session");
		await runAsk(pi, ui, SINGLE_PARAMS, "rpc");
		expect(ui.selects[0]?.options.every(o => typeof o === "string")).toBe(true);
	});

	it("Other routes through the editor with the windowed title", async () => {
		const pi = createFakePi();
		const ui = new FakeRpcUi();
		ui.selectScript.push("Other (type your own)");
		ui.inputScript.push("custom");
		const result = await runAsk(pi, ui, SINGLE_PARAMS, "rpc");
		expect(result.content[0].text).toBe("User provided custom input: custom");
		expect(ui.inputs[0]?.title).toContain("Which auth method?");
		expect(ui.inputs[0]?.title).toContain("Enter your response:");
	});

	it("a dismissed select cancels and aborts the turn", async () => {
		const pi = createFakePi();
		const ui = new FakeRpcUi();
		ui.selectScript.push(undefined);
		await expect(runAsk(pi, ui, SINGLE_PARAMS, "rpc")).rejects.toThrow("Ask tool was cancelled by the user");
	});

	it("timeout expiry auto-picks recommended and reports it", async () => {
		vi.useFakeTimers();
		try {
			const pi = createFakePi();
			const ui = new FakeRpcUi();
			ui.selectScript.push("__HANG__");
			const pending = runAsk(pi, ui, { questions: SINGLE_PARAMS.questions, timeoutSeconds: 5 }, "rpc");
			await vi.advanceTimersByTimeAsync(5600);
			const result = await pending;
			expect(result.content[0].text).toBe("User selected: JWT (auto-selected after timeout)");
			expect(result.details?.timedOut).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
});
