/**
 * ui/conversation-viewer.ts — live conversation overlay for one spawned agent.
 *
 * Scrollable view over the monitor's live message array (the same reference
 * spawnAgent appends to): user prompt, assistant text/thinking, tool calls
 * (with truncated results). Rendering is event-driven: monitor.subscribe
 * notifications request renders (a per-agent revision check skips no-op
 * repaints), with no fixed-interval polling timer.
 *
 * Keys: ↑↓ / j k scroll · PgUp PgDn / Shift+↑↓ page · Home/End · q/Esc close
 * · x x (double-press) stops the agent via monitor.abort(). Subprocesses have
 * no stdin, so there is no steering — viewing and stopping only.
 */
import type { Message } from "@earendil-works/pi-ai";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { isBoilerplateLine, type AgentMonitor, type AgentCallState } from "../monitor.ts";
import { contentText } from "../text.ts";
import {
	contextUtilizationPercent,
	describeActivity,
	fgPreservingNestedStyles,
	formatMs,
	formatSessionTokens,
	type Theme,
} from "./shared.ts";

/** Base lines consumed by chrome: top border + header + sep + footer sep + footer + bottom border. */
const CHROME_LINES_BASE = 6;
const MIN_VIEWPORT = 3;
/** Height ceiling shared with the overlay's maxHeight option. */
export const VIEWPORT_HEIGHT_PCT = 70;
/** Truncation cap for tool results inside the transcript view. */
const RESULT_PREVIEW_CHARS = 500;
/** Cap for one assistant text block (the "agents output") in the transcript
 *  view — long final answers are collapsed to a preview with a marker. */
const ASSISTANT_TEXT_LIMIT = 2000;
/** Cap for one thinking block (internal reasoning) in the transcript view. */
const THINKING_TEXT_LIMIT = 1000;

/** Structural TUI surface the viewer needs. */
export interface ViewerTui {
	requestRender(): void;
	terminal: { rows: number };
}

/** Extract readable text from a Message content — shared core extractor
 *  (string | content-block array → concatenated text blocks). */

export class ConversationViewer {
	private scrollOffset = 0;
	private autoScroll = true;
	private closed = false;
	private unsubscribe: (() => void) | undefined;
	/** Line count from the last render — handleInput needs only the total for
	 *  scroll clamping, and rebuilding the whole wrapped transcript per key
	 *  press is O(transcript) work render() repeats anyway. */
	private lastLineCount = 0;
	/** Cheap revision signature of the viewed state — the subscribe listener
	 *  skips requestRender when nothing about THIS agent changed (a parallel
	 *  fan-out's other agents emitChange constantly). */
	private lastSeenRevision = "";
	/** Two-press confirm guard for the stop key. */
	private stopArmed = false;

	private readonly tui: ViewerTui;
	private readonly monitor: AgentMonitor;
	private readonly state: AgentCallState;
	private readonly theme: Theme;
	private readonly done: (result: undefined) => void;
	/** Abort the agent shown here. Omitted → no stop affordance. */
	private readonly onStop?: () => void;

	constructor(
		tui: ViewerTui,
		monitor: AgentMonitor,
		state: AgentCallState,
		theme: Theme,
		done: (result: undefined) => void,
		onStop?: () => void,
	) {
		this.tui = tui;
		this.monitor = monitor;
		this.state = state;
		this.theme = theme;
		this.done = done;
		this.onStop = onStop;
		this.unsubscribe = this.monitor.subscribe(() => {
			if (this.closed) return;
			// Skip when nothing about the VIEWED agent changed — every call in the
			// process shares one listener set, so an unrelated fan-out sibling's
			// messageEnd/toolEnd would otherwise rebuild this transcript each time.
			const s = this.state;
			const rev = `${s.messages.length}:${s.turns}:${s.toolUses}:${s.status}:${s.responseTail.length}:${s.activeTools.size}`;
			if (rev === this.lastSeenRevision) return;
			this.lastSeenRevision = rev;
			this.tui.requestRender();
		});
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "q")) {
			this.close();
			return;
		}

		// Stop/abort (two-press: first x arms, second confirms, any other key disarms).
		if (matchesKey(data, "x")) {
			if (this.isStoppable()) {
				if (this.stopArmed) {
					this.stopArmed = false;
					try {
						this.onStop?.();
					} catch {
						/* ignore */
					}
				} else {
					this.stopArmed = true;
				}
				this.tui.requestRender();
			}
			return;
		}
		if (this.stopArmed) this.stopArmed = false;

		const totalLines = this.lastLineCount;
		const viewportHeight = this.viewportHeight();
		const maxScroll = Math.max(0, totalLines - viewportHeight);

		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			this.autoScroll = this.scrollOffset >= maxScroll;
		} else if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
			this.autoScroll = this.scrollOffset >= maxScroll;
		} else if (matchesKey(data, "pageUp") || matchesKey(data, "shift+up")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - viewportHeight);
			this.autoScroll = false;
		} else if (matchesKey(data, "pageDown") || matchesKey(data, "shift+down")) {
			this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewportHeight);
			this.autoScroll = this.scrollOffset >= maxScroll;
		} else if (matchesKey(data, "home")) {
			this.scrollOffset = 0;
			this.autoScroll = false;
		} else if (matchesKey(data, "end")) {
			this.scrollOffset = maxScroll;
			this.autoScroll = true;
		}
	}

	render(width: number): string[] {
		if (width < 6) return []; // too narrow for any meaningful rendering
		const th = this.theme;
		const innerW = width - 4; // border + padding
		const lines: string[] = [];

		// truncateToWidth's pad=true already fills to exactly innerW — no
		// separate padding pass needed.
		const row = (content: string) =>
			th.fg("border", "│") + " " + truncateToWidth(content, innerW, "…", true) + " " + th.fg("border", "│");
		const hrTop = th.fg("border", `╭${"─".repeat(width - 2)}╮`);
		const hrBot = th.fg("border", `╰${"─".repeat(width - 2)}╯`);
		const hrMid = row(th.fg("dim", "─".repeat(Math.max(0, innerW))));

		// Header: status icon · name · description · stats
		lines.push(hrTop);
		const statusIcon =
			this.state.status === "running"
				? th.fg("accent", "●")
				: this.state.status === "completed"
					? th.fg("success", "✓")
					: th.fg("error", "✗"); // aborted and error share the ✗ mark
		const duration = formatMs((this.state.completedAt ?? Date.now()) - this.state.startedAt);
		const headerParts: string[] = [duration];
		if (this.state.toolUses > 0) headerParts.unshift(`${this.state.toolUses} tool use${this.state.toolUses === 1 ? "" : "s"}`);
		if (this.state.turns > 0) headerParts.unshift(`${this.state.turns} turn${this.state.turns === 1 ? "" : "s"}`);
		if (this.state.lifetimeTokens > 0) {
			const percent = contextUtilizationPercent(this.state.contextTokens, this.state.model);
			headerParts.push(formatSessionTokens(this.state.lifetimeTokens, percent, th, this.state.compactions));
		}
		lines.push(
			row(
				`${statusIcon} ${th.bold(this.state.displayName)}${this.state.id ? th.fg("dim", ` ${this.state.id}`) : ""}  ${th.fg("muted", this.state.description)} ${th.fg("dim", "·")} ${fgPreservingNestedStyles(th, "dim", headerParts.join(" · "))}`,
			),
		);
		lines.push(hrMid);

		// Content viewport — rebuilt every render from the live messages array.
		const contentLines = this.buildContentLines(innerW);
		this.lastLineCount = contentLines.length;
		const viewportHeight = this.viewportHeight();
		const maxScroll = Math.max(0, contentLines.length - viewportHeight);
		if (this.autoScroll) this.scrollOffset = maxScroll;
		const visibleStart = Math.min(this.scrollOffset, maxScroll);
		const visible = contentLines.slice(visibleStart, visibleStart + viewportHeight);
		for (let i = 0; i < viewportHeight; i++) {
			lines.push(row(visible[i] ?? ""));
		}

		// Footer: actions left, navigation right.
		lines.push(hrMid);
		const actions: string[] = [];
		if (this.isStoppable()) {
			actions.push(this.stopArmed ? th.fg("error", "x again to STOP") : th.fg("dim", "x stop"));
		}
		const footerRight = th.fg("dim", "↑↓ scroll · PgUp/PgDn · q/Esc close");
		const footerLeft = actions.join(th.fg("dim", " · "));
		const footerGap = Math.max(1, innerW - visibleWidth(footerLeft) - visibleWidth(footerRight));
		lines.push(row(footerLeft + " ".repeat(footerGap) + footerRight));
		lines.push(hrBot);

		return lines;
	}

	invalidate(): void {
		/* no cached state to clear */
	}

	dispose(): void {
		this.closed = true;
		if (this.unsubscribe) {
			this.unsubscribe();
			this.unsubscribe = undefined;
		}
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		this.done(undefined);
	}

	/** Stoppable only while a stop handler exists and the agent is still running. */
	private isStoppable(): boolean {
		return !!this.onStop && this.state.status === "running";
	}

	private viewportHeight(): number {
		const maxRows = Math.floor((this.tui.terminal.rows * VIEWPORT_HEIGHT_PCT) / 100);
		return Math.max(MIN_VIEWPORT, maxRows - this.chromeLines());
	}

	private chromeLines(): number {
		return CHROME_LINES_BASE;
	}

	private buildContentLines(width: number): string[] {
		if (width <= 0) return [];
		const th = this.theme;
		const messages = this.state.messages;
		const lines: string[] = [];

		if (messages.length === 0) {
			lines.push(th.fg("dim", "(waiting for first message…)"));
			return lines;
		}

		let needsSeparator = false;
		for (const msg of messages) {
			const rendered = this.renderMessage(msg, width);
			if (rendered.length === 0) continue;
			if (needsSeparator) lines.push(th.fg("dim", "───"));
			lines.push(...rendered);
			needsSeparator = true;
		}

		// Streaming indicator for running agents.
		if (this.state.status === "running") {
			const activity = describeActivity(this.state.activeTools, this.state.responseTail);
			lines.push("");
			lines.push(truncateToWidth(th.fg("accent", "▍ ") + th.fg("dim", activity), width));
		}

		return lines.map((l) => truncateToWidth(l, width));
	}

	/** Render one message as display lines (empty array → skip the message). */
	private renderMessage(msg: Message, width: number): string[] {
		const th = this.theme;
		const lines: string[] = [];
		const role = (msg as { role?: unknown }).role;

		if (role === "user") {
			const text = contentText((msg as { content?: unknown }).content).trim();
			if (!text) return lines;
			// Drop injected repo-context boilerplate lines ("Repo cwd: … Repo信息")
			// from the displayed prompt; the message is skipped entirely when it
			// carried nothing else.
			const visible = text
				.split("\n")
				.map((l) => l.trim())
				.filter((l) => l.length > 0 && !isBoilerplateLine(l))
				.join("\n");
			if (!visible) return lines;
			lines.push(th.fg("accent", "[User]"));
			for (const line of wrapTextWithAnsi(visible, width)) lines.push(line);
			return lines;
		}

		if (role === "assistant") {
			const content = (msg as { content?: unknown }).content;
			const textParts: string[] = [];
			const thinkingParts: string[] = [];
			const toolCalls: string[] = [];
			if (typeof content === "string") {
				textParts.push(content);
			} else if (Array.isArray(content)) {
				for (const block of content) {
					if (!block || typeof block !== "object") continue;
					const b = block as { type?: string; text?: unknown; thinking?: unknown; name?: unknown };
					if (b.type === "text" && typeof b.text === "string" && b.text) textParts.push(b.text);
					else if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking)
						thinkingParts.push(b.thinking);
					else if (b.type === "toolCall" && typeof b.name === "string") toolCalls.push(b.name);
				}
			}
			if (textParts.length === 0 && thinkingParts.length === 0 && toolCalls.length === 0) return lines;
			lines.push(th.bold("[Assistant]"));
			for (const thinking of thinkingParts) {
				const preview =
					thinking.length > THINKING_TEXT_LIMIT
						? `${thinking.slice(0, THINKING_TEXT_LIMIT)}… (truncated)`
						: thinking;
				for (const line of wrapTextWithAnsi(`(thinking) ${preview}`.trim(), width)) {
					lines.push(th.fg("dim", line));
				}
			}
			const assistantText = textParts.join("\n").trim();
			const preview =
				assistantText.length > ASSISTANT_TEXT_LIMIT
					? `${assistantText.slice(0, ASSISTANT_TEXT_LIMIT)}\n… (output truncated)`
					: assistantText;
			for (const line of wrapTextWithAnsi(preview, width)) lines.push(line);
			for (const name of toolCalls) {
				lines.push(truncateToWidth(th.fg("muted", `  [Tool: ${name}]`), width));
			}
			return lines;
		}

		if (role === "toolResult") {
			const m = msg as { content?: unknown; toolName?: unknown };
			const text = contentText(m.content).trim();
			if (!text) return lines;
			const toolName = typeof m.toolName === "string" ? m.toolName : "tool";
			lines.push(th.fg("muted", `[Result: ${toolName}]`));
			const preview =
				text.length > RESULT_PREVIEW_CHARS ? `${text.slice(0, RESULT_PREVIEW_CHARS)}… (truncated)` : text;
			for (const line of wrapTextWithAnsi(preview, width)) lines.push(th.fg("dim", line));
			return lines;
		}

		return lines;
	}
}
