/**
 * conversation-viewer.test.ts — the single-agent overlay component: content
 * rendering per role, scroll/navigation keys, close semantics, the two-press
 * stop gesture, and the revision-signature render skip.
 */
import { describe, expect, it, vi } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import { ConversationViewer } from "../src/ui/conversation-viewer.ts";
import type { AgentMonitor, AgentCallState } from "../src/monitor.ts";

const theme = {
	fg: (_c: string, s: string) => s,
	bold: (s: string) => s,
};

function makeState(overrides: Partial<AgentCallState> = {}): AgentCallState {
	return {
		callId: "c1",
		id: "SwiftOtter",
		displayName: "scout",
		description: "map the repo layout",
		startedAt: Date.now() - 5_000,
		controller: new AbortController(),
		messages: [],
		model: "deepseek/chat",
		status: "running",
		turns: 1,
		toolUses: 1,
		lifetimeTokens: 1234,
		contextTokens: 8000,
		compactions: 0,
		activeTools: new Map<string, string>(),
		responseTail: "",
		completedAt: undefined,
		...overrides,
	} as unknown as AgentCallState;
}

function makeTui(rows = 24) {
	const requestRender = vi.fn();
	return { tui: { requestRender, terminal: { rows } }, requestRender };
}

function makeMonitor() {
	const listeners: Array<() => void> = [];
	const monitor = {
		subscribe: (fn: () => void) => {
			listeners.push(fn);
			return () => {
				const i = listeners.indexOf(fn);
				if (i >= 0) listeners.splice(i, 1);
			};
		},
		abort: vi.fn(),
		notify: () => {},
	} as unknown as AgentMonitor;
	return { monitor, listeners };
}

const userMsg = (text: string): Message =>
	({ role: "user", content: [{ type: "text", text }] }) as unknown as Message;
const assistantMsg = (text: string): Message =>
	({ role: "assistant", content: [{ type: "text", text }] }) as unknown as Message;
const toolResultMsg = (text: string): Message =>
	({
		role: "toolResult",
		toolName: "bash",
		content: [{ type: "text", text }],
	}) as unknown as Message;

describe("ConversationViewer", () => {
	it("renders the header, per-role transcript blocks, and the footer", () => {
		const { tui } = makeTui(40); // tall terminal so every role block fits the viewport
		const { monitor } = makeMonitor();
		const state = makeState({
			messages: [userMsg("find the entrypoints"), assistantMsg("found 2"), toolResultMsg("src/a.ts src/b.ts")],
		});
		const viewer = new ConversationViewer(tui, monitor, state, theme, () => {});
		const lines = viewer.render(80); // rows=24 → viewport 10; use a tall terminal so all roles fit

		expect(lines[1]).toContain("scout");
		expect(lines[1]).toContain("map the repo layout");
		expect(lines.join("\n")).toContain("[User]");
		expect(lines.join("\n")).toContain("find the entrypoints");
		expect(lines.join("\n")).toContain("[Assistant]");
		expect(lines.join("\n")).toContain("[Result: bash]");
		expect(lines.join("\n")).toContain("q/Esc close");
		viewer.dispose();
	});

	it("shows the waiting placeholder before the first message and drops boilerplate-only user prompts", () => {
		const { tui } = makeTui();
		const { monitor } = makeMonitor();
		const empty = makeState();
		const viewer = new ConversationViewer(tui, monitor, empty, theme, () => {});
		expect(viewer.render(80).join("\n")).toContain("(waiting for first message");
		viewer.dispose();

		// isBoilerplateLine-filtered prompts render nothing for that message.
		const state = makeState({ messages: [userMsg("Repo cwd: /x\nRepo信息: stuff")] });
		const viewer2 = new ConversationViewer(tui, monitor, state, theme, () => {});
		expect(viewer2.render(80).join("\n")).not.toContain("[User]");
		viewer2.dispose();
	});

	it("home jumps to the top and end re-arms autoscroll to the bottom", () => {
		const { tui } = makeTui(10); // viewport = max(3, 7-6) = 3 content rows
		const { monitor } = makeMonitor();
		const messages: Message[] = [];
		for (let i = 0; i < 8; i++) messages.push(assistantMsg(`answer chunk ${i}`));
		const state = makeState({ messages });
		const viewer = new ConversationViewer(tui, monitor, state, theme, () => {});

		viewer.render(80); // seeds lastLineCount; autoscroll pins to bottom
		const bottom = viewer.render(80);
		// rows 3..5 are the viewport (top border, header, mid rule come first)
		expect(bottom[3]).toContain("answer chunk 7");

		viewer.handleInput("\x1b[H"); // Home
		const top = viewer.render(80);
		expect(top[3]).toContain("[Assistant]");
		expect(top[4]).toContain("answer chunk 0");

		viewer.handleInput("\x1b[F"); // End
		expect(viewer.render(80)[3]).toContain("answer chunk 7");
		viewer.dispose();
	});

	it("q closes via done(undefined) and Esc does the same", () => {
		const { tui } = makeTui();
		const { monitor } = makeMonitor();
		const done = vi.fn();
		const v1 = new ConversationViewer(tui, monitor, makeState(), theme, done);
		v1.handleInput("q");
		expect(done).toHaveBeenCalledWith(undefined);

		const v2 = new ConversationViewer(tui, monitor, makeState(), theme, done);
		v2.handleInput("\x1b");
		expect(done).toHaveBeenCalledTimes(2);
	});

	it("x x stops a running agent; any other key disarms; finished agents offer no stop", () => {
		const { tui } = makeTui();
		const { monitor } = makeMonitor();
		const onStop = vi.fn();
		const running = makeState();
		const viewer = new ConversationViewer(tui, monitor, running, theme, () => {}, onStop);

		viewer.render(80);
		viewer.handleInput("x");
		expect(viewer.render(80).join("\n")).toContain("x again to STOP");
		viewer.handleInput("\x1b[A"); // up disarms
		viewer.handleInput("x"); // arms again
		viewer.handleInput("x"); // confirms
		expect(onStop).toHaveBeenCalledTimes(1);
		viewer.dispose();

		const finished = makeState({ status: "completed", completedAt: Date.now() });
		const done2 = vi.fn();
		const v2 = new ConversationViewer(tui, monitor, finished, theme, done2, onStop);
		v2.render(80);
		v2.handleInput("x");
		v2.handleInput("x");
		expect(onStop).toHaveBeenCalledTimes(1); // not stoppable once finished
		expect(v2.render(80).join("\n")).not.toContain("x stop");
		v2.dispose();
	});

	it("subscribe notifications skip repaints when the viewed agent's revision is unchanged", () => {
		const { tui, requestRender } = makeTui();
		const { monitor, listeners } = makeMonitor();
		const state = makeState({ messages: [assistantMsg("hello")] });
		const viewer = new ConversationViewer(tui, monitor, state, theme, () => {});
		requestRender.mockClear();

		listeners[0]!(); // first notify: revision changes → repaint
		expect(requestRender).toHaveBeenCalledTimes(1);
		listeners[0]!(); // nothing changed → skipped
		expect(requestRender).toHaveBeenCalledTimes(1);

		state.messages.push(assistantMsg("more")); // revision changes
		listeners[0]!();
		expect(requestRender).toHaveBeenCalledTimes(2);
		viewer.dispose();
	});

	it("dispose unsubscribes from the monitor", () => {
		const { tui } = makeTui();
		const { monitor, listeners } = makeMonitor();
		const viewer = new ConversationViewer(tui, monitor, makeState(), theme, () => {});
		expect(listeners).toHaveLength(1);
		viewer.dispose();
		expect(listeners).toHaveLength(0);
	});
});
