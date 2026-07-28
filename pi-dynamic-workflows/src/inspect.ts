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

	render(_width: number): string[] {
		const r = this.result;
		const lines: string[] = [];
		lines.push(BOLD(`workflow ${CYAN(r.runId)} → ${r.status}`));
		lines.push(DIM(`  ${r.stats.agents} agents · ${fmtTokens(r.stats.tokens)} tok · ${(r.stats.durationMs / 1000).toFixed(1)}s`));
		if (r.error) lines.push(RED(`  error: ${r.error}`));
		lines.push(DIM(`  ↑↓ select · enter detail · esc exit`));
		lines.push("");

		r.steps.forEach((s, i) => {
			const sel = i === this.selected;
			const cursor = sel ? CYAN("▸") : " ";
			const head = `${cursor} ${statusIcon(s.status)} ${s.id} ${DIM(`(${s.type})`)}`;
			lines.push(sel ? BOLD(head) : head);
			if (sel && this.showDetail) {
				const body = typeof s.results === "string" ? s.results : JSON.stringify(s.results, null, 2);
				for (const ln of body.split("\n").slice(0, 8)) lines.push(`      ${DIM(ln)}`);
				lines.push(`      ${DIM(`${fmtTokens(s.stats.tokens)} tok · ${s.stats.agents} agent(s) · ${s.stats.durationMs}ms`)}`);
			}
		});
		return lines;
	}

	dispose(): void {
		// Nothing to release.
	}
}
