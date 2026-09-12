/**
 * pi-todo — transcript rendering.
 *
 * Ported from oh-my-pi `packages/coding-agent/src/tools/todo.ts` (renderer
 * section), adapted to pi's split renderCall/renderResult slots: omp merges
 * call+result into one framed block (mergeCallAndResult), while pi renders the
 * call line and result lines separately. Strings, glyphs, colors, roman
 * numerals, per-phase progress, touched-phase collapsing, and the collapsed
 * walking viewport all match omp:
 *   - call:   ⏳(muted) Todo · <op> <task> <phase> N items (dim meta; the
 *             op's fields join with spaces, multiple ops join with ·)
 *   - result: ☑(accent) Todo · N tasks + per-phase tree
 *   - tasks:  ☑ success strikethrough / ☐ accent in-progress / ☐ error
 *             strikethrough abandoned / ☐ warning blocked (note) / ☐ dim pending
 *   - tree:   ├─ / └─ dim branch glyphs with the muted trailing summary
 * Dropped (host-internal, no pi counterpart): strike animations and spinner
 * frames (final strike state renders), subagent-match lighting (matcher
 * removed with the cognitive-neutral refactor; pending renders dim), framed
 * block chrome.
 */

import { Text, type Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	type TodoCompletionTransition,
	type TodoItem,
	isClosedTodo,
	phaseRomanNumeral,
	selectCollapsedTodos,
	type TodoPhase,
	type TodoToolDetails,
} from "./state.ts";

/** Display cap: keeps transcript lines width-safe without knowing the terminal width. */
const MAX_LINE = 100;

/** omp PREVIEW_LIMITS.COLLAPSED_ITEMS. */
const COLLAPSED_ITEMS = 8;

function clip(text: string): string {
	const single = text.replace(/[\t\n\r]+/g, " ");
	return single.length > MAX_LINE ? `${single.slice(0, MAX_LINE - 1)}…` : single;
}

// =============================================================================
// Render args normalization (omp normalizeTodoArg)
// =============================================================================

type TodoRenderOp = {
	op?: string;
	task?: string;
	phase?: string;
	items?: string[];
};

/** New single-op shape `{op,...}`; legacy `{ops:[...]}` still seen in old transcripts. */
type TodoRenderArgs = TodoRenderOp & {
	ops?: TodoRenderOp[];
};

/**
 * Normalize streaming/legacy render args to a flat op list. Accepts the new
 * top-level `{op,...}` shape (returned as a one-element list), the legacy
 * `{ops:[...]}` batch from old transcripts, and partially-parsed streaming
 * deltas without crashing.
 */
function normalizeTodoArg(args: TodoRenderArgs | undefined): TodoRenderOp[] {
	if (!args || typeof args !== "object") return [];
	if (Array.isArray(args.ops)) {
		return args.ops.filter((entry): entry is TodoRenderOp => !!entry && typeof entry === "object");
	}
	return typeof args.op === "string" ? [args] : [];
}

// =============================================================================
// Phase headers (omp formatPhaseDisplayName / formatPhaseProgress)
// =============================================================================

function formatPhaseDisplayName(name: string, oneBasedIndex: number): string {
	return `${phaseRomanNumeral(oneBasedIndex)}. ${clip(name)}`;
}

/** Dim `closed/total` suffix — counts completed + abandoned (omp isClosedTodo). */
function formatPhaseProgress(phase: TodoPhase, theme: Theme): string {
	const done = phase.tasks.filter(isClosedTodo).length;
	return theme.fg("dim", `  ${done}/${phase.tasks.length}`);
}

/** One-line summary for a collapsed (untouched) phase: dim header + progress. */
function formatPhaseSummary(phase: TodoPhase, oneBasedIndex: number, theme: Theme): string {
	const name = theme.fg("dim", theme.bold(formatPhaseDisplayName(phase.name, oneBasedIndex)));
	return `${name}${formatPhaseProgress(phase, theme)}`;
}

// =============================================================================
// Task lines (omp formatTodoLine, final strike state)
// =============================================================================

/** omp theme.checkbox unicode set (checkbox.checked / checkbox.unchecked). */
const CHECKBOX = { checked: "☑", unchecked: "☐" } as const;

function formatTodoLine(item: TodoItem, theme: Theme): string {
	const label = clip(item.content);
	const box = CHECKBOX.unchecked;
	switch (item.status) {
		case "completed":
			return theme.fg("success", `${CHECKBOX.checked} ${theme.strikethrough(label)}`);
		case "in_progress":
			return theme.fg("accent", `${box} ${label}`);
		case "abandoned":
			return theme.fg("error", `${box} ${theme.strikethrough(label)}`);
		case "blocked": {
			const note = item.blocker ? `blocked: ${clip(item.blocker)}` : "blocked";
			return theme.fg("warning", `${box} ${label} (${note})`);
		}
		default:
			return theme.fg("dim", `${box} ${label}`);
	}
}

// =============================================================================
// Tree lines (omp renderTreeList trailingSummary branch)
// =============================================================================

const TREE_BRANCH = "├─";
const TREE_LAST = "└─";

interface TreeLineOptions {
	items: TodoItem[];
	/** Trailing muted summary row; empty string renders none (omp contract). */
	trailingSummary?: string;
	renderItem: (item: TodoItem) => string;
	theme: Theme;
}

function renderTreeLines({ items, trailingSummary: summary, renderItem, theme }: TreeLineOptions): string[] {
	const lines: string[] = [];
	for (let i = 0; i < items.length; i++) {
		const rendered = renderItem(items[i]);
		if (!rendered) continue;
		const isLast = summary === "" && i === items.length - 1;
		const prefix = `${theme.fg("dim", isLast ? TREE_LAST : TREE_BRANCH)} `;
		lines.push(`${prefix}${rendered}`);
	}
	if (summary !== undefined && summary !== "") {
		lines.push(`${theme.fg("dim", TREE_LAST)} ${theme.fg("muted", summary)}`);
	}
	return lines;
}

// =============================================================================
// Touched-phase diffing (omp computeTouchedPhases)
// =============================================================================

/**
 * Phases the latest update touched, plus the phase where the work now sits:
 * the earliest phase still holding open work (the same "active phase" the
 * summary text reports). Returns `null` when there is no usable signal,
 * meaning "render every phase fully" — this preserves the legacy view and the
 * manual-expand path.
 */
function computeTouchedPhases(
	args: TodoRenderArgs | undefined,
	phases: TodoPhase[],
	completedTasks: TodoCompletionTransition[],
): Set<string> | null {
	const touched = new Set<string>();
	// Explicitly started work stays expanded.
	for (const phase of phases) {
		if (phase.tasks.some(task => task.status === "in_progress")) touched.add(phase.name);
	}
	// Without the omp auto-promotion pointer there may be no in_progress task at
	// all; keep the earliest open-work phase expanded so the phase the agent
	// works on next never collapses to a one-line summary.
	const activePhase = phases.find(phase =>
		phase.tasks.some(task => task.status === "pending" || task.status === "in_progress"),
	);
	if (activePhase) touched.add(activePhase.name);
	// Phases with a task that just transitioned to completed in this update.
	for (const transition of completedTasks) touched.add(transition.phase);
	// Phases explicitly named by the ops that ran. `init` replaces the whole
	// list, so the entire plan is fresh and every phase counts as touched.
	const ops = normalizeTodoArg(args);
	for (const op of ops) {
		if (op.op === "init") {
			for (const phase of phases) touched.add(phase.name);
			break;
		}
		if (typeof op.phase === "string" && op.phase && phases.some(phase => phase.name === op.phase)) {
			touched.add(op.phase);
		}
		if (typeof op.task === "string" && op.task) {
			const located = phases.find(phase => phase.tasks.some(task => task.content === op.task));
			if (located) touched.add(located.name);
		}
	}
	return touched.size > 0 ? touched : null;
}

// =============================================================================
// Call / result renderers
// =============================================================================

export type TodoRenderArgsPublic = Omit<TodoRenderOp, "items">;

export function renderTodoCall(args: TodoRenderArgsPublic, theme: Theme): Component {
	// omp renderCall: renderStatusLine({icon:"pending", title:"Todo", meta})
	// with one meta entry per op: "<op> <task> <phase> N items".
	const opsList = normalizeTodoArg(args as TodoRenderArgs);
	const ops =
		opsList.length === 0
			? ["update"]
			: opsList.map(e => {
					const parts = [clip(e.op ?? "update")];
					if (e.task) parts.push(clip(e.task));
					if (e.phase) parts.push(clip(e.phase));
					if (Array.isArray(e.items) && e.items.length) {
						parts.push(`${e.items.length} item${e.items.length === 1 ? "" : "s"}`);
					}
					return parts.join(" ");
				});
	const line =
		`${theme.fg("muted", "⏳")} ${theme.fg("accent", "Todo")}` +
		(ops.length > 0 ? ` ${theme.fg("dim", `· ${ops.join(" · ")}`)}` : "");
	return new Text(line, 0, 0);
}

export function renderTodoResult(
	result: AgentToolResult<TodoToolDetails>,
	options: ToolRenderResultOptions,
	theme: Theme,
	args?: TodoRenderArgsPublic,
): Component {
	// Errors never reach this renderer: pi tools throw on failure and the host
	// shell renders the thrown message in the standard error block.
	const phases = (result.details?.phases ?? []).filter(phase => phase.tasks.length > 0);
	const completedTasks = result.details?.completedTasks ?? [];
	const allTasks = phases.flatMap(phase => phase.tasks);
	// omp header: tool.todo glyph (accent) + title + "N tasks" dim meta.
	const header = `${theme.fg("accent", "☑")} ${theme.fg("accent", "Todo")} ${theme.fg("dim", `· ${allTasks.length} tasks`)}`;

	if (allTasks.length === 0) {
		// omp: provider fallback text on one dim line under the header.
		const fallback = clip(result.content?.find(content => content.type === "text")?.text ?? "No todos");
		return new Text(`${header}\n  ${theme.fg("dim", fallback)}`, 0, 0);
	}

	const bodyLines: string[] = [];
	const multiPhase = phases.length > 1;
	const indent = multiPhase ? "  " : "";
	// Collapse phases this update didn't touch down to a one-line summary so a
	// single task flip doesn't redraw every phase's full task list. The manual
	// expand toggle (and the no-signal fallback) still shows all.
	const touched = options.expanded || !multiPhase ? null : computeTouchedPhases(args as TodoRenderArgs, phases, completedTasks);

	for (let p = 0; p < phases.length; p++) {
		const phase = phases[p];
		if (touched && !touched.has(phase.name)) {
			bodyLines.push(formatPhaseSummary(phase, p + 1, theme));
			continue;
		}
		if (multiPhase) {
			// Progress belongs on the expanded header too: the collapsed viewport
			// below hides closed rows, so without it the active phase would be the
			// one phase with no visible completion signal at all.
			const name = theme.fg("accent", theme.bold(formatPhaseDisplayName(phase.name, p + 1)));
			bodyLines.push(`${name}${formatPhaseProgress(phase, theme)}`);
		}
		// Collapsed: walking viewport — the last closed task leads, then active
		// work, then following pending tasks (omp #5873). Expanded: every task.
		const treeLines = options.expanded
			? renderTreeLines({ items: phase.tasks, renderItem: todo => formatTodoLine(todo, theme), theme })
			: (() => {
					const selection = selectCollapsedTodos(phase.tasks, COLLAPSED_ITEMS);
					return renderTreeLines({
						items: selection.items,
						trailingSummary: selection.summary,
						renderItem: todo => formatTodoLine(todo, theme),
						theme,
					});
				})();
		for (const line of treeLines) {
			bodyLines.push(`${indent}${line}`);
		}
	}

	return new Text([header, ...bodyLines].join("\n"), 0, 0);
}
