/**
 * ui/agent-widget.ts — persistent widget showing running/completed agents
 * above the editor.
 *
 * Renders a tree of the monitor's live calls: animated spinner, display name,
 * task description, stats (turns ↻N≤M · tool uses · tokens (context %) ·
 * elapsed) and a current-activity line (⎿ editing 2 files…). Finished agents
 * linger briefly (completed 5s, error/aborted 10s) with ✓/✗, then drop out.
 *
 * Widget mode (see concurrency.ts): "background" (default) drops only agents the
 * spawner explicitly declared foreground; "all" shows everything; "off" hides
 * the widget entirely.
 *
 * Mechanics (ported from tintinweb/pi-subagents): the widget is registered
 * once via setWidget's callback form; subsequent updates call requestRender()
 * on the captured TUI (no component replacement, no layout thrash). An 80ms
 * timer drives the spinner while agents are active and stops when idle.
 */
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentMonitor, AgentCallState } from "../monitor.ts";
import type { WidgetMode } from "../concurrency.ts";
import {
	contextUtilizationPercent,
	describeActivity,
	fgPreservingNestedStyles,
	formatMs,
	formatSessionTokens,
	formatTurns,
	SPINNER,
	type Theme,
} from "./shared.ts";

/** Maximum rendered lines before overflow collapse kicks in. */
const MAX_WIDGET_LINES = 12;
/** How long a finished agent lingers: completed vs error/aborted. */
const FINISHED_LINGER_MS = 5_000;
const ERROR_LINGER_MS = 10_000;
/** Spinner / stats refresh cadence while agents are active. */
const TICK_MS = 80;

/** Widget registration key (namespaced to avoid clashing with other extensions). */
const WIDGET_KEY = "pi-subagents:agents";

/** Minimal UI surface the widget needs from `ctx.ui` (structural subset). */
export interface WidgetUICtx {
	setWidget(
		key: string,
		content:
			| undefined
			| ((tui: unknown, theme: Theme) => { render(width: number): string[]; invalidate(): void }),
		options?: { placement?: "aboveEditor" | "belowEditor" },
	): void;
}

export class AgentWidget {
	private uiCtx: WidgetUICtx | undefined;
	private widgetFrame = 0;
	private widgetInterval: ReturnType<typeof setInterval> | undefined;
	/** Whether the widget callback is currently registered with the TUI. */
	private widgetRegistered = false;
	/** Cached TUI reference from the widget factory, used for requestRender(). */
	private tui: { requestRender(): void } | undefined;

	private readonly monitor: AgentMonitor;
	/** Read live at render/update time — selects which agents the widget shows. */
	private readonly mode: () => WidgetMode;
	/** Monitor snapshot taken once per update() tick and reused by
	 *  renderWidgetBody() — scanning the monitor twice per 80ms tick (update +
	 *  render) duplicates the sweep + array copy for the same state. */
	private agentsSnapshot: AgentCallState[] = [];

	constructor(monitor: AgentMonitor, mode: () => WidgetMode = () => "background") {
		this.monitor = monitor;
		this.mode = mode;
	}

	/**
	 * Agents eligible for the widget, per the current WidgetMode:
	 *   - `off`: none.
	 *   - `background`: drop only agents *known* to be foreground
	 *     (`background === false`); keep everything else — declared background,
	 *     and undeclared (undefined) spawns, which is every current consumer
	 *     call. Excluding rather than allow-listing means only proven-
	 *     foreground runs drop out; nothing else silently vanishes.
	 *   - `all`: every agent.
	 */
	private widgetAgents(): AgentCallState[] {
		const all = this.monitor.list();
		switch (this.mode()) {
			case "off":
				return [];
			case "background":
				return all.filter((a) => a.background !== false);
			default:
				return all;
		}
	}

	/** Set the UI context (from session_start). Re-registers on change. */
	setUICtx(ctx: WidgetUICtx): void {
		if (ctx === this.uiCtx) return;
		this.uiCtx = ctx;
		this.widgetRegistered = false;
		this.tui = undefined;
	}

	/** Ensure the spinner/stats timer is running (called when a call starts). */
	ensureTimer(): void {
		// Never arm without a UI context: after dispose() a late monitor event
		// (e.g. a callEnded arriving after session_shutdown) must not resurrect
		// the interval — that would ghost-run the timer and, via update(),
		// re-register the widget on the torn-down session's UI.
		if (this.uiCtx && !this.widgetInterval) {
			this.widgetInterval = setInterval(() => this.update(), TICK_MS);
		}
	}

	/** Whether a finished agent should still be shown (time-based linger). */
	private shouldShowFinished(state: AgentCallState, now: number): boolean {
		if (state.completedAt == null) return false;
		const linger = state.status === "completed" ? FINISHED_LINGER_MS : ERROR_LINGER_MS;
		return now - state.completedAt < linger;
	}

	/** Render one finished agent line (✓ / ✗ aborted / ✗ error / ✓ (turn limit)). */
	private renderFinishedLine(a: AgentCallState, theme: Theme): string {
		let icon: string;
		let statusText = "";
		if (a.status === "completed") {
			if (a.maxTurnsReached) {
				icon = theme.fg("warning", "✓");
				statusText = theme.fg("warning", " (turn limit)");
			} else {
				icon = theme.fg("success", "✓");
			}
		} else if (a.status === "aborted") {
			icon = theme.fg("error", "✗");
			statusText = theme.fg("warning", " aborted");
		} else {
			icon = theme.fg("error", "✗");
			const errMsg = a.errorMessage ? `: ${a.errorMessage.slice(0, 60)}` : "";
			statusText = theme.fg("error", ` error${errMsg}`);
		}

		const duration = formatMs((a.completedAt ?? Date.now()) - a.startedAt);
		const parts: string[] = [];
		if (a.turns > 0) parts.push(formatTurns(a.turns, a.maxTurns));
		if (a.toolUses > 0) parts.push(`${a.toolUses} tool use${a.toolUses === 1 ? "" : "s"}`);
		parts.push(duration);

		return (
			`${icon} ${theme.bold(a.displayName)}  ${theme.fg("dim", a.description)} ` +
			`${theme.fg("dim", "·")} ${theme.fg("dim", parts.join(" · "))}${statusText}`
		);
	}

	/**
	 * Build the widget body. Running agents render two lines (header +
	 * activity); finished agents one line. Overflow collapses finished agents
	 * first, then running, into a "+N more (…)" summary.
	 */
	private renderWidgetBody(width: number, theme: Theme): string[] {
		const now = Date.now();
		const allAgents = this.agentsSnapshot;
		const running = allAgents.filter((a) => a.status === "running");
		const finished = allAgents.filter((a) => a.status !== "running" && this.shouldShowFinished(a, now));
		if (running.length === 0 && finished.length === 0) return [];

		const frame = SPINNER[this.widgetFrame % SPINNER.length];
		const runningBlocks: string[][] = [];
		for (const a of running) {
			const elapsed = formatMs(now - a.startedAt);
			const percent = contextUtilizationPercent(a.contextTokens, a.model);
			const tokenText =
				a.lifetimeTokens > 0 ? formatSessionTokens(a.lifetimeTokens, percent, theme, a.compactions) : "";
			const parts: string[] = [];
			parts.push(formatTurns(a.turns, a.maxTurns));
			if (a.toolUses > 0) parts.push(`${a.toolUses} tool use${a.toolUses === 1 ? "" : "s"}`);
			if (tokenText) parts.push(tokenText);
			parts.push(elapsed);

			const activity = describeActivity(a.activeTools, a.responseTail);
			runningBlocks.push([
				`${theme.fg("accent", frame)} ${theme.bold(a.displayName)}  ${theme.fg("muted", a.description)} ${theme.fg("dim", "·")} ${fgPreservingNestedStyles(theme, "dim", parts.join(" · "))}`,
				theme.fg("dim", `  ⎿  ${activity}`),
			]);
		}
		const finishedBlocks = finished.map((a) => [this.renderFinishedLine(a, theme)]);

		// Assemble with the overflow cap: heading (1) is reserved.
		const maxBody = MAX_WIDGET_LINES - 1;
		const blocks: string[][] = [];
		let hiddenRunning = 0;
		let hiddenFinished = 0;

		if (runningBlocks.length * 2 + finishedBlocks.length <= maxBody) {
			blocks.push(...runningBlocks, ...finishedBlocks);
		} else {
			// Overflow — running agents take priority; finished fold into the count.
			let budget = maxBody - 1; // reserve one line for the overflow summary
			for (const block of runningBlocks) {
				if (budget >= 2) {
					blocks.push(block);
					budget -= 2;
				} else {
					hiddenRunning++;
				}
			}
			for (const block of finishedBlocks) {
				if (budget >= 1) {
					blocks.push(block);
					budget--;
				} else {
					hiddenFinished++;
				}
			}
			const overflowParts: string[] = [];
			if (hiddenRunning > 0) overflowParts.push(`${hiddenRunning} running`);
			if (hiddenFinished > 0) overflowParts.push(`${hiddenFinished} finished`);
			blocks.push([theme.fg("dim", `+${hiddenRunning + hiddenFinished} more (${overflowParts.join(", ")})`)]);
		}

		// Emit with tree connectors; the last visible block gets └─ / plain indent.
		const lines: string[] = [];
		blocks.forEach((block, i) => {
			const isLast = i === blocks.length - 1;
			const connector = isLast ? "└─" : "├─";
			const continuation = isLast ? "   " : "│  ";
			lines.push(`${theme.fg("dim", connector)} ${block[0]}`);
			for (let j = 1; j < block.length; j++) {
				lines.push(`${theme.fg("dim", continuation)}${block[j]}`);
			}
		});
		// Clamp every line to the render width (an over-wide line would wrap and
		// desync pi's line-diff → flicker). truncateToWidth is ANSI/wide-char aware.
		return lines.map((l) => truncateToWidth(l, width));
	}

	/** Force an immediate widget refresh (spinner advance + re-render). */
	update(): void {
		if (!this.uiCtx) return;
		const now = Date.now();
		const allAgents = (this.agentsSnapshot = this.widgetAgents());
		const hasActive = allAgents.some((a) => a.status === "running");
		// Finished entries use the SAME linger window as renderWidgetBody
		// (shouldShowFinished) — otherwise the widget stays registered and the
		// 80ms timer keeps scanning for ~55s after the last visible row drops
		// (the monitor retains finished calls 60s for late viewers).
		const hasFinished = allAgents.some(
			(a) => a.status !== "running" && a.completedAt != null && this.shouldShowFinished(a, now),
		);

		if (!hasActive && !hasFinished) {
			if (this.widgetRegistered) {
				try {
					this.uiCtx.setWidget(WIDGET_KEY, undefined);
				} catch {
					/* ignore */
				}
				this.widgetRegistered = false;
				this.tui = undefined;
			}
			if (this.widgetInterval) {
				clearInterval(this.widgetInterval);
				this.widgetInterval = undefined;
			}
			return;
		}

		this.widgetFrame++;
		this.ensureTimer();

		if (!this.widgetRegistered) {
			try {
				this.uiCtx.setWidget(
					WIDGET_KEY,
					(tui, theme) => {
						this.tui = tui as { requestRender(): void };
						return {
							render: (width: number) => this.renderWidgetBody(width, theme),
							invalidate: () => {
								// Theme changed — force re-registration so the factory
								// captures the fresh theme on the next update.
								this.widgetRegistered = false;
								this.tui = undefined;
							},
						};
					},
					{ placement: "aboveEditor" },
				);
				this.widgetRegistered = true;
			} catch {
				/* registration failed — retry on next update */
			}
		} else {
			try {
				this.tui?.requestRender();
			} catch {
				/* ignore */
			}
		}
	}

	dispose(): void {
		if (this.widgetInterval) {
			clearInterval(this.widgetInterval);
			this.widgetInterval = undefined;
		}
		if (this.uiCtx) {
			try {
				this.uiCtx.setWidget(WIDGET_KEY, undefined);
			} catch {
				/* ignore */
			}
		}
		// Drop the context (mirrors FleetList nulling `this.ui`) so late monitor
		// events after session_shutdown cannot re-register the widget. The next
		// session_start re-attaches via setUICtx — undefined !== ctx.ui, so the
		// identity early-return doesn't skip it.
		this.uiCtx = undefined;
		this.widgetRegistered = false;
		this.tui = undefined;
	}
}
