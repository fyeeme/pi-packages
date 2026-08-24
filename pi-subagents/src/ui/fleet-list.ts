/**
 * ui/fleet-list.ts — Claude Code-style "FleetView" list rendered below the editor.
 *
 * Shows `main` + each running/queued subagent as a navigable list. Pressing ↓
 * (or ←) at an empty prompt activates the list; ↑/↓ move the selection
 * (filled ● marker), Enter opens the selected agent's live conversation
 * overlay, Esc returns to the prompt. Finished agents linger briefly.
 *
 * Mechanics (ported from tintinweb/pi-subagents): the list is a `belowEditor`
 * widget (render-only), and ALL key handling goes through `onTerminalInput` —
 * which fires before the focused editor and can `consume` keys — gated on
 * `getEditorText() === ""` so normal typing is untouched. While any dialog
 * (select/confirm/input, pi's own menus) owns the keyboard, the list stays
 * out of its keys.
 */
import { Editor, isKeyRelease, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentMonitor, AgentCallState } from "../monitor.ts";
import { ConversationViewer, VIEWPORT_HEIGHT_PCT } from "./conversation-viewer.ts";
import { formatFleetElapsed, formatFleetTokens, type Theme } from "./shared.ts";

/** Widget key for the below-editor fleet list (namespaced). */
const FLEET_KEY = "pi-subagents:fleet";
/** Max agent rows shown at once; extras collapse into a "↓ N more" indicator. */
const MAX_AGENT_ROWS = 5;
/** Re-render cadence so elapsed/token stats tick while agents run. */
const TICK_MS = 200;
/** How long a finished agent lingers in the list before it drops out. */
const FINISHED_LINGER_MS = 4_000;

/** Minimal UI surface the FleetView needs from `ctx.ui` (structural subset). */
export interface FleetUICtx {
	setWidget(
		key: string,
		content:
			| undefined
			| ((tui: unknown, theme: Theme) => { render(width: number): string[]; invalidate(): void }),
		options?: { placement?: "aboveEditor" | "belowEditor" },
	): void;
	onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
	getEditorText(): string;
	notify(message: string, type?: "info" | "warning" | "error"): void;
	custom<T>(
		factory: (
			tui: unknown,
			theme: Theme,
			keybindings: unknown,
			done: (result: T) => void,
		) => { render(width: number): string[]; invalidate(): void; dispose?(): void },
		options?: { overlay?: boolean; overlayOptions?: unknown },
	): Promise<T>;
}

/** Place `right` flush to `width`, truncating `left` first so the stats survive. */
function rightAlign(left: string, right: string, width: number): string {
	const rightW = visibleWidth(right);
	const maxLeft = Math.max(0, width - rightW - 1);
	const leftClamped = truncateToWidth(left, maxLeft);
	const gap = Math.max(1, width - visibleWidth(leftClamped) - rightW);
	return truncateToWidth(leftClamped + " ".repeat(gap) + right, width);
}

export class FleetList {
	private ui: FleetUICtx | undefined;
	private tui: { requestRender(): void; terminal: { columns: number; rows: number }; focusedComponent?: unknown } | undefined;
	private inputUnsub: (() => void) | undefined;
	private widgetRegistered = false;
	private timer: ReturnType<typeof setInterval> | undefined;
	/** Whether the FleetView is enabled (settings `fleetView`, default true).
	 *  When disabled the list never registers and never captures input. */
	private enabled = true;

	/** Whether arrow keys currently navigate the list (vs. flow to the editor). */
	private active = false;
	/** 0 = `main`, 1..N = subagents. */
	private selectedIndex = 0;
	/** Set while a conversation overlay is open; calling it closes the overlay. */
	private viewerClose: (() => void) | undefined;
	private viewingCallId: string | undefined;

	private readonly monitor: AgentMonitor;
	/** Agent snapshot taken once per update() tick and reused by
	 *  clampSelection/handleKey/renderBar — previously each 200ms tick scanned
	 *  the monitor up to three times (update + clamp + render) for the same
	 *  state. Entry 0 of the conceptual roster is always `main`, so agent
	 *  indexes into this array are `selectedIndex - 1`. */
	private currentRecords: AgentCallState[] = [];

	constructor(monitor: AgentMonitor) {
		this.monitor = monitor;
	}

	// ---- Lifecycle ----

	/**
	 * Enable/disable the list (settings `fleetView`). Disabling deactivates
	 * navigation and unregisters the widget on the next update; the input hook
	 * stays registered but immediately returns undefined, so no keys are
	 * captured while disabled.
	 */
	setEnabled(enabled: boolean): void {
		if (enabled === this.enabled) return;
		this.enabled = enabled;
		if (!enabled) this.active = false;
		this.update();
	}

	/** Capture the UI context and (re)register the global input handler. */
	setUICtx(ui: FleetUICtx): void {
		if (ui === this.ui) return;
		try {
			this.inputUnsub?.();
		} catch {
			/* ignore */
		}
		this.ui = ui;
		this.widgetRegistered = false;
		this.tui = undefined;
		try {
			this.inputUnsub = ui.onTerminalInput((data) => this.handleKey(data));
		} catch {
			/* input hook unavailable (non-interactive) — list stays render-only */
		}
	}

	/** Ensure the re-render timer is running (called when a call starts).
	 *  Never armed without a UI context: after dispose() a late monitor event
	 *  must not resurrect the interval — update() early-returns on `!this.ui`
	 *  and would never reach the clearInterval branch, ghost-running a 200ms
	 *  no-op timer until the next session. */
	ensureTimer(): void {
		if (this.ui && !this.timer) {
			this.timer = setInterval(() => this.update(), TICK_MS);
		}
	}

	dispose(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		try {
			this.inputUnsub?.();
		} catch {
			/* ignore */
		}
		this.inputUnsub = undefined;
		if (this.viewerClose) {
			try {
				this.viewerClose();
			} catch {
				/* ignore */
			}
			this.viewerClose = undefined;
		}
		this.viewingCallId = undefined;
		if (this.ui && this.widgetRegistered) {
			try {
				this.ui.setWidget(FLEET_KEY, undefined);
			} catch {
				/* ignore */
			}
		}
		this.widgetRegistered = false;
		this.tui = undefined;
		this.active = false;
		// Null last so a viewerClose() microtask above can't re-register the widget.
		this.ui = undefined;
	}

	/** Re-register/refresh the below-editor widget; clears it when idle. */
	update(): void {
		if (!this.ui) return;
		const records = (this.currentRecords = this.enabled ? this.agentRecords() : []);
		const hasAgents = records.length > 0;

		if (!hasAgents) {
			if (this.widgetRegistered) {
				try {
					this.ui.setWidget(FLEET_KEY, undefined);
				} catch {
					/* ignore */
				}
				this.widgetRegistered = false;
				this.tui = undefined;
			}
			if (this.timer) {
				clearInterval(this.timer);
				this.timer = undefined;
			}
			this.active = false;
			this.selectedIndex = 0;
			return;
		}

		this.clampSelection();
		this.ensureTimer(); // keep stats ticking whenever the list is shown

		if (!this.widgetRegistered) {
			try {
				this.ui.setWidget(
					FLEET_KEY,
					(tui, theme) => {
						this.tui = tui as typeof this.tui;
						return {
							render: (w: number) => this.renderBar(w, theme),
							invalidate: () => {
								this.widgetRegistered = false;
								this.tui = undefined;
							},
						};
					},
					{ placement: "belowEditor" },
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

	// ---- Roster ----

	/**
	 * Agents shown in the list, earliest-launched first. Included: running,
	 * the agent currently being viewed, and recently-finished ones (they
	 * linger briefly before dropping out).
	 */
	private agentRecords(): AgentCallState[] {
		const now = Date.now();
		return this.monitor
			.list()
			.filter(
				(a) =>
					a.status === "running" ||
					a.callId === this.viewingCallId ||
					(a.completedAt != null && now - a.completedAt < FINISHED_LINGER_MS),
			);
	}

	private clampSelection(): void {
		// Roster = main + currentRecords → max selectable index is its length.
		const max = this.currentRecords.length;
		if (this.selectedIndex > max) this.selectedIndex = Math.max(0, max);
		if (this.selectedIndex < 0) this.selectedIndex = 0;
	}

	// ---- Key handling ----

	/** Returns `{consume:true}` to swallow a key, or undefined to let it through. */
	handleKey(data: string): { consume?: boolean; data?: string } | undefined {
		if (!this.enabled || !this.ui) return undefined;
		// Input listeners receive BOTH key-press and key-release (the kitty
		// protocol emits both, and matchesKey matches either) — act on press
		// only, or every tap would move/fire twice.
		if (isKeyRelease(data)) return undefined;
		// While an overlay is open, let it own all input.
		if (this.viewerClose) return undefined;
		// Input listeners fire BEFORE the focused component, and dialogs swap
		// the prompt editor out while getEditorText() still reads the detached —
		// empty — editor. When anything but the editor owns the keyboard, stay
		// out of its keys.
		if (!this.editorHasFocus()) {
			if (this.active) this.deactivate();
			return undefined;
		}

		if (!this.active) {
			// Activate: ↓ or ← at an empty prompt moves focus into the list.
			const isActivator = matchesKey(data, "down") || matchesKey(data, "left");
			if (isActivator && this.currentRecords.length > 0 && this.getEditorTextSafe() === "") {
				this.active = true;
				this.selectedIndex = 0;
				this.update();
				return { consume: true };
			}
			return undefined;
		}

		// Active — arrows navigate, Enter opens, Esc / Up-past-top exits.
		if (matchesKey(data, "down")) {
			const max = this.currentRecords.length;
			this.selectedIndex = Math.min(max, this.selectedIndex + 1);
			this.update();
			return { consume: true };
		}
		if (matchesKey(data, "up")) {
			if (this.selectedIndex === 0) {
				this.deactivate();
				return { consume: true };
			}
			this.selectedIndex -= 1;
			this.update();
			return { consume: true };
		}
		if (matchesKey(data, "escape")) {
			this.deactivate();
			return { consume: true };
		}
		if (matchesKey(data, Key.enter)) {
			this.openSelected();
			return { consume: true };
		}

		// Any other key cancels navigation and flows to the editor.
		this.deactivate();
		return undefined;
	}

	private getEditorTextSafe(): string {
		try {
			return this.ui?.getEditorText() ?? "";
		} catch {
			return "";
		}
	}

	/**
	 * True when pi's prompt editor owns the keyboard. pi's editor is an
	 * `Editor` subclass while every dialog/selector is not, and pi aliases
	 * pi-tui to its own copy, so `instanceof` is a reliable identity check.
	 * `getFocusedComponent()` is pi-tui's public accessor; the `unknown` cast
	 * covers a pi version that predates it (falling back to the focus being
	 * unknowable = editor, so activation keeps working).
	 */
	private editorHasFocus(): boolean {
		let focused: unknown;
		try {
			const tui = this.tui as { getFocusedComponent?(): unknown } | undefined;
			focused = tui?.getFocusedComponent ? tui.getFocusedComponent() : this.tui?.focusedComponent;
		} catch {
			focused = undefined;
		}
		return focused == null || focused instanceof Editor;
	}

	private deactivate(): void {
		this.active = false;
		this.selectedIndex = 0;
		this.update();
	}

	// ---- Viewer overlay ----

	private openSelected(): void {
		if (this.selectedIndex === 0) {
			// `main` = return to the prompt; the native transcript is already shown.
			this.deactivate();
			return;
		}
		const state = this.currentRecords[this.selectedIndex - 1];
		if (!state) {
			this.deactivate();
			return;
		}
		this.openAgent(state.callId);
	}

	/** Open the conversation overlay for one agent (also used by /agents). */
	openAgent(callId: string): void {
		const state = this.monitor.get(callId);
		if (!this.ui) return;
		if (!state) {
			this.ui.notify("Agent is no longer available.", "info");
			return;
		}
		this.viewingCallId = state.callId;

		try {
			void this.ui
				.custom<undefined>(
					(tui, theme, _keybindings, done) => {
						const viewer = new ConversationViewer(
							tui as ConversationViewer["tui"],
							this.monitor,
							state,
							theme,
							done,
							() => {
								if (this.monitor.abort(state.callId)) {
									this.ui?.notify(`Stopped "${state.description}".`, "info");
								}
							},
						);
						this.viewerClose = () => done(undefined);
						return viewer;
					},
					{
						overlay: true,
						overlayOptions: { anchor: "center", width: "90%", maxHeight: `${VIEWPORT_HEIGHT_PCT}%` },
					},
				)
				.then(
					() => this.clearViewer(),
					() => this.clearViewer(),
				);
		} catch (err) {
			this.viewingCallId = undefined;
			this.ui.notify(`Failed to open agent view: ${err instanceof Error ? err.message : String(err)}`, "error");
		}
	}

	/** Reset overlay state and return to the list (on close, auto-close, or error). */
	private clearViewer(): void {
		if (this.viewingCallId) {
			const idx = this.currentRecords.findIndex((a) => a.callId === this.viewingCallId);
			if (idx >= 0) this.selectedIndex = idx + 1;
		}
		this.viewerClose = undefined;
		this.viewingCallId = undefined;
		this.update();
	}

	// ---- Rendering ----

	private renderBar(width: number, theme: Theme): string[] {
		const agents = this.currentRecords;
		if (agents.length === 0) return [];
		// Clamp locally so a render between a roster shrink and the next update()
		// never loses the selection marker.
		const sel = Math.min(this.selectedIndex, agents.length);

		const hint = this.active
			? "↑↓ select · enter view · esc back"
			: "esc to interrupt · ← for agents · ↓ to manage";
		const lines: string[] = [];
		lines.push(truncateToWidth(`  ${theme.fg("dim", hint)}`, width));
		lines.push("");
		lines.push(truncateToWidth(`  ${this.bullet(0, sel, theme)} main`, width));

		// Window the agent rows so the selected one stays visible.
		const visible = Math.min(MAX_AGENT_ROWS, agents.length);
		const selAgent = Math.max(0, sel - 1);
		const start = selAgent < visible ? 0 : selAgent - visible + 1;
		const hiddenBelow = agents.length - (start + visible);

		if (start > 0) lines.push(rightAlign("", theme.fg("dim", `↑ ${start} more`), width));
		for (let a = start; a < start + visible; a++) {
			lines.push(this.renderAgentRow(a + 1, sel, agents[a]!, width, theme));
		}
		if (hiddenBelow > 0) lines.push(rightAlign("", theme.fg("dim", `↓ ${hiddenBelow} more`), width));

		return lines;
	}

	private bullet(rosterIndex: number, sel: number, theme: Theme): string {
		return rosterIndex === sel ? theme.fg("accent", "●") : theme.fg("dim", "○");
	}

	private renderAgentRow(rosterIndex: number, sel: number, state: AgentCallState, width: number, theme: Theme): string {
		const left = `  ${this.bullet(rosterIndex, sel, theme)} ${theme.fg("muted", state.displayName)}  ${state.description}`;
		const elapsedMs = (state.completedAt ?? Date.now()) - state.startedAt; // freezes once finished
		const right = theme.fg("dim", `${formatFleetElapsed(elapsedMs)} · ${formatFleetTokens(state.lifetimeTokens)}`);
		return rightAlign(left, right, width);
	}
}
