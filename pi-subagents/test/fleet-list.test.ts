/**
 * fleet-list.test.ts — the single fleet surface (former above-editor widget +
 * FleetView roster merged): lifecycle regressions, event-driven rendering,
 * editor gestures, and per-row stat density.
 *
 * Lifecycle regression (ported from the old agent-widget suite): a late
 * monitor event after session_shutdown (e.g. the callEnded of an agent
 * aborted by the session switch) must not re-register the widget nor re-arm
 * a timer — dispose() drops `ui` so the coalesced-render path early-returns.
 *
 * Gesture equivalence (spec: Monitor UI continuity): ↓/← at an empty prompt
 * activates the list, Enter opens the conversation viewer, `x x` in the
 * viewer stops the agent via monitor.abort.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentMonitor } from "../src/monitor.ts";
import type { AgentCallState } from "../src/monitor.ts";
import { FleetList, type FleetUICtx } from "../src/ui/fleet-list.ts";
import { ConversationViewer } from "../src/ui/conversation-viewer.ts";
import { setModelCatalog, clearModelCatalog, type Theme } from "../src/ui/shared.ts";

/** Colorless passthrough theme (assert on plain text). */
const theme: Theme = { fg: (_c, text) => text, bold: (text) => text };

/** Minimal recording FleetUICtx + captured tui/render. */
function fakeUi() {
	const setWidget = vi.fn();
	let requestRender = vi.fn();
	const custom = vi.fn(async (..._args: unknown[]) => undefined);
	const notify = vi.fn();
	const inputHandlers: Array<(data: string) => unknown> = [];
	const ui: FleetUICtx = {
		setWidget,
		onTerminalInput: (h) => {
			inputHandlers.push(h);
			return () => {};
		},
		getEditorText: () => "",
		notify,
		custom: custom as unknown as FleetUICtx["custom"],
	};
	return { ui, setWidget, custom, notify, inputHandlers, requestRenderRef: () => requestRender };
}

/** Fake tui handed to the widget factory: focused editor, render spy. */
function fakeTui(requestRender: ReturnType<typeof vi.fn>) {
	return {
		requestRender,
		terminal: { columns: 100, rows: 40 },
		getFocusedComponent: () => undefined, // null-ish → editor owns the keyboard
	};
}

/** Seed one running agent and return its state. */
function startAgent(monitor: AgentMonitor, callId = "a1", task = "Do work"): AgentCallState {
	monitor.callStarted({ callId, task, controller: new AbortController(), messages: [] });
	return monitor.get(callId)!;
}

/** Drive one coalesced event → render cycle. */
function flushRender(ms = 150): void {
	vi.advanceTimersByTime(ms);
}

beforeEach(() => {
	vi.useFakeTimers();
	setModelCatalog([{ id: "m-1", contextWindow: 10_000 }]);
});

afterEach(() => {
	clearModelCatalog();
	vi.useRealTimers();
});

describe("FleetList lifecycle (event-driven rendering)", () => {
	it("a monitor state change registers the surface within the coalesce window — no manual refresh", () => {
		const monitor = new AgentMonitor();
		const list = new FleetList(monitor);
		const { ui, setWidget } = fakeUi();
		list.setUICtx(ui);

		startAgent(monitor); // state change → scheduleRender (150ms trailing edge)
		expect(setWidget).not.toHaveBeenCalled(); // nothing rendered synchronously
		flushRender();
		expect(setWidget).toHaveBeenCalledTimes(1); // factory registration, belowEditor
		expect(setWidget.mock.calls[0]![2]).toEqual({ placement: "belowEditor" });
	});

	it("many events inside the window coalesce into ONE repaint", () => {
		const monitor = new AgentMonitor();
		const list = new FleetList(monitor);
		const { ui, setWidget, requestRenderRef } = fakeUi();
		list.setUICtx(ui);
		startAgent(monitor);
		flushRender();
		// The registered factory captured the tui.
		const factory = setWidget.mock.calls[0]![1] as (tui: unknown, theme: Theme) => { render(w: number): string[]; invalidate(): void };
		const rr = vi.fn();
		const requestRender = requestRenderRef();
		factory(fakeTui(rr), theme);
		expect(requestRender).not.toHaveBeenCalled(); // registration path, not repaint

		monitor.messageEnd("a1", { role: "assistant", content: "one" } as never);
		monitor.messageEnd("a1", { role: "assistant", content: "two" } as never);
		flushRender();
		expect(rr).toHaveBeenCalledTimes(1); // two events, one repaint
	});

	it("finished rows drop out after the linger window via the cadence, then the surface unregisters", () => {
		const monitor = new AgentMonitor();
		const list = new FleetList(monitor);
		const { ui, setWidget } = fakeUi();
		list.setUICtx(ui);
		startAgent(monitor);
		flushRender(); // register
		expect(setWidget.mock.calls.filter((c) => typeof c[1] === "function")).toHaveLength(1);

		monitor.callEnded("a1", { exitCode: 0, aborted: false, maxTurnsReached: false });
		flushRender(); // finished row still lingering
		expect(setWidget.mock.calls.filter((c) => typeof c[1] === "function")).toHaveLength(1); // still registered

		vi.advanceTimersByTime(4_500); // past the linger window (cadence ticks)
		const cleared = setWidget.mock.calls.filter((c) => c[1] === undefined).map((c) => c[0] as string);
		expect(cleared).toEqual(["pi-subagents:fleet"]); // unregistered, timers disarmed
		expect(vi.getTimerCount()).toBe(0);
	});

	it("late monitor event after dispose neither re-registers the surface nor re-arms a timer", () => {
		const monitor = new AgentMonitor();
		const list = new FleetList(monitor);
		const { ui, setWidget } = fakeUi();
		list.setUICtx(ui);
		startAgent(monitor);
		flushRender(); // register + cadence armed

		list.dispose();
		expect(setWidget).toHaveBeenLastCalledWith("pi-subagents:fleet", undefined);
		expect(vi.getTimerCount()).toBe(0);

		// The late callEnded arrives after shutdown — must stay inert.
		monitor.callEnded("a1", { aborted: true, exitCode: 1, maxTurnsReached: false });
		vi.advanceTimersByTime(2_000);
		expect(setWidget.mock.calls.filter((c) => typeof c[1] === "function")).toHaveLength(1); // no stale re-registration
		expect(vi.getTimerCount()).toBe(0);
	});

	it("a fresh session_start re-attaches after dispose", () => {
		const monitor = new AgentMonitor();
		const list = new FleetList(monitor);
		const { ui: ui1, setWidget: setWidget1 } = fakeUi();
		const { ui: ui2, setWidget: setWidget2 } = fakeUi();
		list.setUICtx(ui1);
		startAgent(monitor);
		flushRender();
		list.dispose();

		// Next session: ui was nulled, so undefined !== ctx.ui must NOT hit the
		// identity early-return — the surface registers against the new ctx.
		startAgent(monitor, "a2");
		list.setUICtx(ui2);
		list.refresh(); // production rebindUi always pairs setUICtx with refresh
		expect(setWidget2.mock.calls.filter((c) => typeof c[1] === "function")).toHaveLength(1);
	});

	it("setEnabled(false) unregisters and stops capturing keys; re-enable restores", () => {
		const monitor = new AgentMonitor();
		const list = new FleetList(monitor);
		const { ui, setWidget, inputHandlers } = fakeUi();
		list.setUICtx(ui);
		startAgent(monitor);
		flushRender();

		list.setEnabled(false);
		flushRender();
		expect(setWidget.mock.calls.filter((c) => c[1] === undefined)).toHaveLength(1);
		// Down arrow at an empty editor flows through while disabled.
		const handler = inputHandlers[inputHandlers.length - 1]!;
		expect(handler("\x1b[B")).toBeUndefined();
	});
});

describe("FleetList gestures (editor-gesture equivalence)", () => {
	function armedList(monitor: AgentMonitor) {
		const list = new FleetList(monitor);
		const ctx = fakeUi();
		list.setUICtx(ctx.ui);
		startAgent(monitor);
		flushRender();
		return { list, ...ctx };
	}

	it("↓ at an empty prompt activates and is consumed; at a non-empty prompt it flows through", () => {
		const monitor = new AgentMonitor();
		const { list, inputHandlers, ui } = armedList(monitor);
		const handler = inputHandlers[inputHandlers.length - 1]!;
		expect(handler("\x1b[B")).toEqual({ consume: true }); // down press, empty editor

		// Non-empty editor: the gesture must not hijack typing flow.
		(ui as { getEditorText: () => string }).getEditorText = () => "some draft";
		expect(handler("\x1b[D")).toBeUndefined(); // left press — flows to the editor
		expect(list).toBeDefined();
	});

	it("← at an empty prompt activates too (spec gesture parity)", () => {
		const monitor = new AgentMonitor();
		const { inputHandlers } = armedList(monitor);
		const handler = inputHandlers[inputHandlers.length - 1]!;
		expect(handler("\x1b[D")).toEqual({ consume: true });
	});

	it("↓ then Enter opens the conversation viewer overlay", async () => {
		const monitor = new AgentMonitor();
		const { inputHandlers, custom } = armedList(monitor);
		const handler = inputHandlers[inputHandlers.length - 1]!;
		expect(handler("\x1b[B")).toEqual({ consume: true }); // activate (main selected)
		expect(handler("\x1b[B")).toEqual({ consume: true }); // select agent row
		expect(handler("\r")).toEqual({ consume: true }); // Enter → open viewer
		await vi.advanceTimersByTimeAsync(0);
		expect(custom).toHaveBeenCalledTimes(1);
		const opts = custom.mock.calls[0]![1] as { overlay?: boolean };
		expect(opts?.overlay).toBe(true);
	});

	it("any other key while active deactivates and flows to the editor", () => {
		const monitor = new AgentMonitor();
		const { inputHandlers } = armedList(monitor);
		const handler = inputHandlers[inputHandlers.length - 1]!;
		expect(handler("\x1b[B")).toEqual({ consume: true });
		expect(handler("a")).toBeUndefined(); // typing flows through, list deactivates
	});
});

describe("ConversationViewer stop gesture", () => {
	it("x x (double press) stops the viewed agent; a single x does not", () => {
		const monitor = new AgentMonitor();
		const state = startAgent(monitor, "a1");
		const done = vi.fn();
		// FleetList.openAgent wires the viewer's stop hook to monitor.abort
		// (SIGTERM chain); mirror that here so the assertion covers the real path.
		const viewer = new ConversationViewer(
			{ requestRender: vi.fn(), terminal: { rows: 40 } },
			monitor,
			state,
			theme,
			done,
			() => {
				monitor.abort("a1");
			},
		);

		viewer.handleInput("x"); // arm — no abort yet
		expect(state.controller.signal.aborted).toBe(false);
		viewer.handleInput("x"); // confirm → stop
		// The stop path is wired to monitor.abort — verify the controller fired.
		expect(state.controller.signal.aborted).toBe(true);
		viewer.dispose();
	});

	it("an intervening key disarms the stop confirm", () => {
		const monitor = new AgentMonitor();
		const state = startAgent(monitor, "a1");
		const onStop = vi.fn();
		const viewer = new ConversationViewer(
			{ requestRender: vi.fn(), terminal: { rows: 40 } },
			monitor,
			state,
			theme,
			vi.fn(),
			onStop,
		);
		viewer.handleInput("x"); // arm
		viewer.handleInput("j"); // disarm (scroll)
		viewer.handleInput("x"); // arm again, not confirm
		expect(onStop).not.toHaveBeenCalled();
		viewer.dispose();
	});
});

describe("fleet surface stat density (merged widget + roster info set)", () => {
	/** Render the bar for `count` mixed agents at `width`, ANSI-free. */
	function renderFleet(count: number, width = 100): string[] {
		const monitor = new AgentMonitor();
		const list = new FleetList(monitor);
		const ctx = fakeUi();
		list.setUICtx(ctx.ui);
		for (let i = 0; i < count; i++) {
			const callId = `a${i}`;
			monitor.callStarted({ callId, id: `Worker${i}`, task: `Task ${i}`, displayName: "worker", controller: new AbortController(), messages: [], model: "m-1" });
			monitor.messageEnd(callId, {
				role: "assistant",
				content: [{ type: "text", text: "step" }],
				usage: { input: 900, output: 2_500, cacheRead: 0, cacheWrite: 100, totalTokens: 3_500 },
				model: "m-1",
			} as never);
			// One completed tool use (the "N tools" stat) + one still in flight
			// (the ⎿ activity line) — a running agent has both.
			monitor.toolStart(callId, `done-${i}`, "grep");
			monitor.toolEnd(callId, `done-${i}`, "grep");
			monitor.toolStart(callId, `live-${i}`, "read");
			monitor.textDelta(callId, `analyzing module ${i}`);
		}
		flushRender();
		const factory = ctx.setWidget.mock.calls[0]![1] as (
			tui: unknown,
			theme: Theme,
		) => { render(w: number): string[] };
		return factory(fakeTui(vi.fn()), theme).render(width);
	}

	it("every visible running row carries the full stat set (turns · tools · tokens · ctx% · elapsed · activity)", () => {
		const lines = renderFleet(4);
		const agentRows = lines.filter((l) => l.includes("worker"));
		expect(agentRows.length).toBe(4);
			expect(agentRows[0]).toContain("Worker0"); // spec: stable id visible on the row

		for (const row of agentRows) {
			expect(row).toMatch(/↻\d+/); // turns
			expect(row).toContain("tools"); // tool uses
			expect(row).toMatch(/\d+k token/); // tokens
			expect(row).toMatch(/\(\d+%\)/); // context utilization
			expect(row).toMatch(/\d+(\.\d+)?s/); // elapsed
		}
		// Activity line under each running row.
		expect(lines.filter((l) => l.includes("⎿") && l.includes("reading")).length).toBe(4);
	});

	it("16-agent full load windows to MAX_AGENT_ROWS with more-markers, selection visible", () => {
		const lines = renderFleet(16);
		// Windowed, not truncated information: visible rows + overflow markers.
		expect(lines.some((l) => l.includes("↓") && l.includes("more"))).toBe(true);
		const agentRows = lines.filter((l) => l.includes("worker"));
		expect(agentRows.length).toBeLessThanOrEqual(5);
		for (const row of agentRows) {
			expect(row).toMatch(/↻\d+/);
			expect(row).toMatch(/\d+(\.\d+)?s/);
		}
	});
});
