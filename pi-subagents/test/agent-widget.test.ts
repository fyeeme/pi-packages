/**
 * agent-widget.test.ts — regression tests for the widget's dispose/re-attach
 * lifecycle. Regression: a late monitor event after session_shutdown (e.g. the
 * callEnded of an agent aborted by the session switch) re-armed the 80ms timer
 * via the process-global monitor.subscribe callback and, because dispose()
 * kept `uiCtx`, update() re-registered the widget on the torn-down session's
 * UI — stale ✗ agent lines resurrecting in the next session plus a ghost
 * timer after quit. dispose() must drop uiCtx and ensureTimer() must not arm
 * without one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentMonitor } from "../src/monitor.ts";
import { AgentWidget, type WidgetUICtx } from "../src/ui/agent-widget.ts";

/** Minimal recording WidgetUICtx. */
function fakeUi(): WidgetUICtx & { setWidget: ReturnType<typeof vi.fn<WidgetUICtx["setWidget"]>> } {
	const setWidget = vi.fn<WidgetUICtx["setWidget"]>();
	return { setWidget };
}

function startAgent(monitor: AgentMonitor, callId: string): void {
	monitor.callStarted({
		callId,
		task: `task for ${callId}`,
		controller: new AbortController(),
		messages: [],
	});
}

describe("AgentWidget dispose lifecycle", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("a running agent registers the widget and arms exactly one spinner timer", () => {
		const monitor = new AgentMonitor();
		const ui = fakeUi();
		const widget = new AgentWidget(monitor);
		startAgent(monitor, "a1");
		widget.setUICtx(ui);
		widget.update();
		expect(ui.setWidget).toHaveBeenCalledTimes(1); // factory registration
		expect(vi.getTimerCount()).toBe(1);
	});

	it("late monitor event after dispose neither re-registers the widget nor re-arms the timer", () => {
		const monitor = new AgentMonitor();
		const ui = fakeUi();
		const widget = new AgentWidget(monitor);
		startAgent(monitor, "a1");
		widget.setUICtx(ui);
		widget.update(); // registration (call 1) + timer armed

		// session_shutdown: unregisters (call 2), clears the timer, drops uiCtx.
		widget.dispose();
		expect(ui.setWidget).toHaveBeenCalledTimes(2);
		expect(ui.setWidget).toHaveBeenLastCalledWith(expect.any(String), undefined);
		expect(vi.getTimerCount()).toBe(0);

		// The late callEnded arrives after shutdown; the process-global
		// monitor.subscribe callback wakes the surfaces exactly like this.
		monitor.callEnded("a1", { aborted: true, exitCode: 1, maxTurnsReached: false });
		widget.ensureTimer();
		widget.update();
		vi.advanceTimersByTime(2_000);

		expect(ui.setWidget).toHaveBeenCalledTimes(2); // no stale re-registration
		expect(vi.getTimerCount()).toBe(0); // no ghost interval
	});

	it("a fresh session_start re-attaches after dispose", () => {
		const monitor = new AgentMonitor();
		const ui1 = fakeUi();
		const ui2 = fakeUi();
		const widget = new AgentWidget(monitor);
		startAgent(monitor, "a1");
		widget.setUICtx(ui1);
		widget.update();
		widget.dispose();

		// Next session: uiCtx was nulled, so undefined !== ctx.ui must NOT hit
		// the identity early-return — the widget registers against the new ctx.
		startAgent(monitor, "a2");
		widget.setUICtx(ui2);
		widget.update();
		expect(ui2.setWidget).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(1);
	});
});
