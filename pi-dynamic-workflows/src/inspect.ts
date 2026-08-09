/**
 * WorkflowInspect — fullscreen overlay viewer with a master-detail split.
 *
 * Opened via `/wf-inspect` as an overlay (`ctx.ui.custom(..., { overlay: true })`)
 * sized to ~90% × 80% of the terminal. The body is split into two panes that
 * fill the wide overlay instead of wasting it on a single narrow column:
 *
 *   ┌─ STEPS (left ~30%) ──────┬─ DETAIL (right ~70%) ──────────────┐
 *   │ ✓ gather   · 1.2k tok    │ collected 3 sources on topic X     │
 *   │▸✓ fan      · 8.4k tok    │ [fan#1] Research alpha.            │
 *   │ ○ refine   · pending     │ 8.4k tok · 3 agent(s) · 1240ms     │
 *   └──────────────────────────┴────────────────────────────────────┘
 *
 * Left: compact step list (always visible, ↑↓/j/k selects, auto-scrolls).
 * Right: the selected step's full results + stats (PgUp/PgDn/Shift+↑↓/Home/End
 * scrolls the detail). No toggle — detail is always shown for the selection.
 * esc/q exits.
 */
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { RunResult, StepResult } from "./types.ts";
import { buildRenderGroups, type PhaseDef } from "./ui-groups.ts";
import { BOLD, CYAN, DIM, GREEN, RED, YELLOW, fmtTokens } from "./format.ts";

/** Overlay maxHeight percentage — keep in sync with the index.ts overlayOptions. */
const VIEWPORT_HEIGHT_PCT = 80;
/** header(1) + sep(1) + col-header(1) + sep(1) + [body] + sep(1) + footer(1). */
const CHROME_LINES = 6;
const MIN_VIEWPORT = 3;
/** Left pane share of the width (rest goes to the detail pane + separator). */
const LEFT_PCT = 0.3;
const MIN_LEFT = 16;

/** Minimal TUI surface WorkflowInspect needs. Narrower than full `TUI`. */
export interface InspectTUI {
	requestRender(): void;
	terminal: { readonly rows: number };
}

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

/** Fit a (possibly ANSI-colored) string into exactly `w` visible columns:
 *  truncate with … if too long, pad with spaces if too short. */
function field(s: string, w: number): string {
	return truncateToWidth(s, w, "…", true);
}

export class WorkflowInspect {
	private readonly result: RunResult;
	private readonly tui: InspectTUI;
	private readonly close: () => void;
	private readonly phases?: readonly PhaseDef[];
	private selected = 0;
	/** Right-pane (detail) scroll offset; reset to 0 whenever selection changes. */
	private detailScroll = 0;
	/** Left-pane scroll offset; auto-adjusted to keep the selection visible. */
	private leftScroll = 0;
	/** Last known detail content height (set during render). Lets PgUp/PgDn
	 *  clamp an Infinity detailScroll (set by End) before arithmetic, so
	 *  End→PgUp is not swallowed by Infinity - vp = Infinity. */
	private lastMaxDetailScroll = 0;
	/** step index → row index within buildLeftLines() (phase title lines shift
	 *  step rows past their raw array index — selection must scroll by row). */
	private rowOfStep = new Map<number, number>();

	constructor(result: RunResult, tui: InspectTUI, close: () => void, phases?: readonly PhaseDef[]) {
		this.result = result;
		this.tui = tui;
		this.close = close;
		this.phases = phases;
	}

	private viewportHeight(): number {
		const rows = this.tui.terminal.rows > 0 ? this.tui.terminal.rows : 24;
		return Math.max(MIN_VIEWPORT, Math.floor((rows * VIEWPORT_HEIGHT_PCT) / 100) - CHROME_LINES);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q" || data === "Q") {
			this.close();
			return;
		}
		const n = this.result.steps.length;
		if (n === 0) return;
		const vp = this.viewportHeight();
		// Right-pane (detail) scroll.
		if (matchesKey(data, "pageUp") || matchesKey(data, "shift+up")) {
			// End may have left detailScroll as the Infinity sentinel (clamped to a
			// finite value only on the next render) — clamp before arithmetic so
			// Infinity - vp stays Infinity and PgUp appears dead.
			const cur = Math.min(this.detailScroll, this.lastMaxDetailScroll);
			this.detailScroll = Math.max(0, cur - vp);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "pageDown") || matchesKey(data, "shift+down")) {
			const cur = Math.min(this.detailScroll, this.lastMaxDetailScroll);
			this.detailScroll = cur + vp;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "home")) {
			this.detailScroll = 0;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "end")) {
			this.detailScroll = Number.POSITIVE_INFINITY;
			this.tui.requestRender();
			return;
		}
		// Selection moves — reset the detail pane to the top of the new step.
		if (matchesKey(data, "up") || data === "k") {
			this.selected = (this.selected - 1 + n) % n;
			this.detailScroll = 0;
			this.tui.requestRender();
		} else if (matchesKey(data, "down") || data === "j") {
			this.selected = (this.selected + 1) % n;
			this.detailScroll = 0;
			this.tui.requestRender();
		}
	}

	invalidate(): void {
		// No cached render state.
	}

	render(width: number): string[] {
		const r = this.result;
		const w = Math.max(width, 40);
		const leftW = Math.max(MIN_LEFT, Math.floor(w * LEFT_PCT));
		const rightW = Math.max(20, w - leftW - 1); // -1 for the "│" separator
		const sep = DIM("│");
		const hr = DIM("─".repeat(w));
		const out: string[] = [];

		// --- Header (full width) ---
		const degraded = r.degradedSteps?.length ? ` · ${r.degradedSteps.length} degraded` : "";
		const errTag = r.errorCategory ? ` [${r.errorCategory}]` : "";
		const head = `${BOLD(`workflow ${CYAN(r.runId)} → ${r.status}`)}  ${DIM(`${r.stats.agents} agents · ${fmtTokens(r.stats.tokens)} tok · ${(r.stats.durationMs / 1000).toFixed(1)}s${degraded}`)}`;
		out.push(field(r.error ? RED(`${head}  ${r.error}${errTag}`) : head, w));
		out.push(hr);

		// --- Column header ---
		const selStep = r.steps[this.selected];
		const colLeft = BOLD("STEPS");
		const colRight = DIM(`DETAIL${selStep ? ` · ${selStep.id} (${selStep.type})` : ""}`);
		out.push(field(colLeft, leftW) + sep + field(colRight, rightW));
		out.push(hr);

		// --- Body: two panes zipped row-by-row ---
		const vp = this.viewportHeight();
		const leftLines = this.buildLeftLines(leftW);
		// Keep the selected step visible in the left pane. leftLines may start
		// with phase title rows, so the selection's ROW (not its raw step index)
		// drives the window — otherwise phases push the selected step off-screen.
		const selRow = this.rowOfStep.get(this.selected) ?? this.selected;
		if (selRow < this.leftScroll) this.leftScroll = selRow;
		else if (selRow >= this.leftScroll + vp) this.leftScroll = selRow - vp + 1;
		this.leftScroll = Math.max(0, Math.min(this.leftScroll, Math.max(0, leftLines.length - vp)));

		const rightLines = selStep ? this.buildRightLines(selStep) : [DIM("(no step)")];
		const maxDetailScroll = Math.max(0, rightLines.length - vp);
		this.lastMaxDetailScroll = maxDetailScroll;
		this.detailScroll = Math.max(0, Math.min(this.detailScroll, maxDetailScroll));

		for (let i = 0; i < vp; i++) {
			const l = field(leftLines[this.leftScroll + i] ?? "", leftW);
			const rr = field(rightLines[this.detailScroll + i] ?? "", rightW);
			out.push(l + sep + rr);
		}

		// --- Footer ---
		out.push(hr);
		const footL = DIM("↑↓/j/k select · PgUp/PgDn/Shift+↑↓ scroll detail · Home/End · esc exit");
		const dPct = rightLines.length <= vp ? "all" : `${Math.round(((this.detailScroll + vp) / rightLines.length) * 100)}%`;
		const footR = DIM(`${this.detailScroll}/${rightLines.length} (${dPct}) · ${this.selected + 1}/${r.steps.length} steps`);
		out.push(field(footL, leftW) + sep + field(footR, rightW));
		return out;
	}

	/** Left pane: one compact line per step (status · id · type · tokens). */
	private buildLeftLines(w: number): string[] {
		const idxOf = new Map(this.result.steps.map((s, i) => [s.id, i]));
		const groups = buildRenderGroups(this.result.steps, (s) => s.id, this.phases);
		const lines: string[] = [];
		const rowOf = new Map<number, number>();
		// Every phase group renders its header (a phase interrupted by ungrouped
		// items produces two groups; deduplicating the second header would leave
		// an indented, header-less orphan row).
		for (const g of groups) {
			if (g.kind === "phase" && g.title) {
				lines.push(field(BOLD(g.title), w));
			}
			for (const s of g.items) {
				const i = idxOf.get(s.id) ?? 0;
				rowOf.set(i, lines.length);
				const sel = i === this.selected;
				const tok = s.stats.tokens > 0 ? ` · ${fmtTokens(s.stats.tokens)} tok` : "";
				const body = `${statusIcon(s.status)} ${s.id} ${DIM(`(${s.type})${tok}`)}`;
				lines.push(field(sel ? `${CYAN("▸")}${BOLD(body)}` : ` ${body}`, w));
			}
		}
		this.rowOfStep = rowOf;
		return lines;
	}

	/** Right pane: the selected step's full results + a stats footer line.
	 *  `results === undefined` means a live snapshot with nothing settled yet —
	 *  show an honest "in progress" marker instead of JSON.stringify(undefined). */
	private buildRightLines(s: StepResult): string[] {
		const lines: string[] = [];
		if (s.results === undefined) {
			lines.push(DIM("(in progress — no agent output settled yet)"));
		} else {
			const body = typeof s.results === "string" ? s.results : JSON.stringify(s.results, null, 2);
			for (const ln of body.split("\n")) lines.push(DIM(ln));
		}
		lines.push("");
		lines.push(DIM(`${fmtTokens(s.stats.tokens)} tok · ${s.stats.agents} agent(s) · ${s.stats.durationMs}ms · ${s.stats.failures} fail`));
		return lines;
	}

	dispose(): void {
		// Nothing to release.
	}
}
