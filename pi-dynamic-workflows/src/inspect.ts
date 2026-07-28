/**
 * WorkflowInspect — interactive TUI component for reviewing a finished run.
 *
 * Opened via the `/wf-inspect` command (ctx.ui.custom), which gives the
 * component keyboard focus. Render shows the run summary + a selectable step
 * list; the selected step expands inline to show its result + stats.
 *
 * Keys: ↑↓ (or j/k) move selection, enter/space toggles detail, esc/q exits.
 *
 * This is the pi analogue of Claude Code's task-list / agent-detail panel:
 * CC renders it inline with Ink; pi renders it as a modal custom component
 * (the setWidget progress panel is non-interactive by design — custom is the
 * only ctx.ui surface that grants keyboard focus).
 */
import { matchesKey } from "@earendil-works/pi-tui";
import type { RunResult, StepResult } from "./types.ts";

const GREEN = (s: string): string => `\x1b[32m${s}\x1b[0m`;
const RED = (s: string): string => `\x1b[31m${s}\x1b[0m`;
const YELLOW = (s: string): string => `\x1b[33m${s}\x1b[0m`;
const DIM = (s: string): string => `\x1b[2m${s}\x1b[0m`;
const BOLD = (s: string): string => `\x1b[1m${s}\x1b[0m`;
const CYAN = (s: string): string => `\x1b[36m${s}\x1b[0m`;

function statusIcon(status: StepResult["status"]): string {
	switch (status) {
		case "done":
			return GREEN("✓");
		case "failed":
			return RED("✗");
		case "skipped":
			return YELLOW("⏭");
		default:
			return YELLOW("⏳");
	}
}

function fmtTokens(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

const ANSI_SGR = /\x1b\[[0-9;]*m/g;

/** Truncate a line to fit within `maxW - indent` VISIBLE columns; append … if cut.
 *  Measures visible width (strips ANSI SGR codes) so colored headers/body that
 *  visually fit aren't over-truncated, and avoids slicing off a closing reset
 *  (which would leak BOLD/CYAN/DIM into every subsequent terminal line). */
function clip(line: string, maxW: number, indent = 0): string {
	const cap = maxW - indent;
	const visible = line.replace(ANSI_SGR, "");
	if (visible.length <= cap) return line; // fits → keep colors
	return visible.slice(0, Math.max(0, cap - 1)) + "…";
}

export class WorkflowInspect {
	private readonly result: RunResult;
	private readonly tui: { requestRender(): void };
	private readonly close: () => void;
	private selected = 0;
	private showDetail = false;

	constructor(
		result: RunResult,
		tui: { requestRender(): void },
		close: () => void,
	) {
		this.result = result;
		this.tui = tui;
		this.close = close;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q" || data === "Q") {
			this.close();
			return;
		}
		const n = this.result.steps.length;
		if (n === 0) return;
		if (matchesKey(data, "up") || data === "k") {
			this.selected = (this.selected - 1 + n) % n;
			this.tui.requestRender();
		} else if (matchesKey(data, "down") || data === "j") {
			this.selected = (this.selected + 1) % n;
			this.tui.requestRender();
		} else if (data === "\r" || data === " " || data === "enter") {
			this.showDetail = !this.showDetail;
			this.tui.requestRender();
		}
	}

	invalidate(): void {
		// No cached render state.
	}

	render(width: number): string[] {
		const r = this.result;
		const maxW = Math.max(width, 40);
		const lines: string[] = [];

		lines.push(clip(BOLD(`workflow ${CYAN(r.runId)} → ${r.status}`), maxW));
		lines.push(clip(DIM(`  ${r.stats.agents} agents · ${fmtTokens(r.stats.tokens)} tok · ${(r.stats.durationMs / 1000).toFixed(1)}s`), maxW));
		if (r.error) lines.push(clip(RED(`  error: ${r.error}`), maxW));
		lines.push(DIM("  ↑↓ select · enter detail · esc exit"));
		lines.push("");

		r.steps.forEach((s, i) => {
			const sel = i === this.selected;
			const cursor = sel ? CYAN("▸") : " ";
			const head = `${cursor} ${statusIcon(s.status)} ${s.id} ${DIM(`(${s.type})`)}`;
			lines.push(clip(sel ? BOLD(head) : head, maxW));
			if (sel && this.showDetail) {
				const body = typeof s.results === "string" ? s.results : JSON.stringify(s.results, null, 2);
				for (const ln of body.split("\n").slice(0, 8)) lines.push(clip(`      ${DIM(ln)}`, maxW, 6));
				lines.push(clip(`      ${DIM(`${fmtTokens(s.stats.tokens)} tok · ${s.stats.agents} agent(s) · ${s.stats.durationMs}ms`)}`, maxW, 6));
			}
		});
		return lines;
	}

	dispose(): void {
		// Nothing to release.
	}
}
