/**
 * pi-todo — /todo command.
 *
 * Ported from oh-my-pi `todo-command-controller.ts` (+ its ACP helper in
 * slash-commands/helpers/todo.ts): view, edit, copy, export, import, append,
 * start, done, drop, rm, help — with quote-aware tokenizing and fuzzy
 * task/phase matching. The omp developer system-reminder injection after
 * manual edits was removed in the cognitive-neutral refactor.
 *
 * Host-internal surfaces map to pi:
 *   $EDITOR round-trip      → ctx.ui.editor (prefilled Markdown)
 *   clipboard copy          → printed (extension API has no clipboard write;
 *                             mirrors omp's own ACP fallback text)
 *   user_todo_edit entry    → "todo-phases" snapshot (pi-todo's documented
 *                             entry contract, read back by restore and
 *                             pi-goal's todo bridge)
 */

import { readFileSync, writeFileSync } from "node:fs";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	type TodoItem,
	type TodoOpEntry,
	applyOpsToPhases,
	clonePhases,
	type TodoPhase,
	markdownToPhases,
	phasesToMarkdown,
	resolveTodoMarkdownPath,
} from "./state.ts";
import { commitPhases, type TodoToolDeps } from "./tool.ts";

/** Same dependency contract as the tool path (single write-back invariant). */
export type TodoCommandDeps = TodoToolDeps;

const USAGE = [
	"Usage: /todo <verb> [args]",
	"  /todo                              Show current todos",
	"  /todo edit                         Open todos in the editor (Markdown round-trip)",
	"  /todo copy                         Print todos as Markdown",
	"  /todo export [<path>]              Write todos to file (default: TODO.md)",
	"  /todo import [<path>]              Replace todos from file (default: TODO.md)",
	"  /todo append [<phase>] <task...>   Append a task; phase fuzzy-matched or auto-created",
	"  /todo start  <task>                Mark task in_progress (fuzzy content match)",
	"  /todo done   [<task|phase>]        Mark task/phase/all completed",
	"  /todo drop   [<task|phase>]        Mark task/phase/all abandoned",
	"  /todo rm     [<task|phase>]        Remove task/phase/all",
].join("\n");

// =============================================================================
// Argument tokenizer (respects double-quoted strings) — omp tokenize
// =============================================================================

function tokenize(input: string): string[] {
	const tokens: string[] = [];
	let cur = "";
	let inQuote = false;
	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (ch === "\\" && i + 1 < input.length) {
			cur += input[++i];
			continue;
		}
		if (ch === '"') {
			inQuote = !inQuote;
			continue;
		}
		if (!inQuote && /\s/.test(ch)) {
			if (cur) {
				tokens.push(cur);
				cur = "";
			}
			continue;
		}
		cur += ch;
	}
	if (cur) tokens.push(cur);
	return tokens;
}

// =============================================================================
// Name normalization + fuzzy matching — omp #append / findPhaseFuzzy / findTaskFuzzy
// =============================================================================

function titleCase(s: string): string {
	return s
		.split(/\s+/)
		.filter(Boolean)
		.map(word => word[0].toUpperCase() + word.slice(1))
		.join(" ");
}

/** Capitalize first letter only — keeps acronyms / casing in the rest intact. */
function titleCaseSentence(s: string): string {
	const trimmed = s.trim();
	if (!trimmed) return trimmed;
	return trimmed[0].toUpperCase() + trimmed.slice(1);
}

interface TodoTaskMatch {
	task: TodoItem;
	phase: TodoPhase;
}

function findPhaseFuzzy(phases: TodoPhase[], query: string): TodoPhase | undefined {
	const q = query.trim().toLowerCase();
	if (!q) return undefined;
	// Exact name (case-insensitive)
	const byName = phases.find(p => p.name.toLowerCase() === q);
	if (byName) return byName;
	// Substring (prefer prefix match)
	const prefixMatches = phases.filter(p => p.name.toLowerCase().startsWith(q));
	if (prefixMatches.length === 1) return prefixMatches[0];
	const subMatches = phases.filter(p => p.name.toLowerCase().includes(q));
	if (subMatches.length === 1) return subMatches[0];
	return undefined;
}

function findTaskFuzzy(phases: TodoPhase[], query: string): TodoTaskMatch | undefined {
	const q = query.trim().toLowerCase();
	if (!q) return undefined;
	// Exact content (case-insensitive)
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.content.toLowerCase() === q) return { task, phase };
		}
	}
	const matches: TodoTaskMatch[] = [];
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.content.toLowerCase().includes(q)) {
				matches.push({ task, phase });
			}
		}
	}
	if (matches.length === 1) return matches[0];
	// Prefer single in_progress/pending hit when ambiguous
	const active = matches.filter(m => m.task.status === "in_progress" || m.task.status === "pending");
	if (active.length === 1) return active[0];
	return undefined;
}

// =============================================================================
// Command handler
// =============================================================================

export function createTodoCommand(deps: TodoCommandDeps): (args: string, ctx: ExtensionCommandContext) => Promise<void> {
	return async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
		const trimmed = args.trim();
		if (!trimmed) {
			showCurrent(deps, ctx);
			return;
		}

		const spaceIdx = trimmed.search(/\s/);
		const verb = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
		const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

		switch (verb) {
			case "edit":
				await editInEditor(deps, ctx);
				return;
			case "copy":
				copyMarkdown(deps, ctx);
				return;
			case "export":
				await exportToFile(deps, ctx, rest);
				return;
			case "import":
				await importFromFile(deps, ctx, rest);
				return;
			case "help":
			case "?":
				emit(ctx, USAGE);
				return;
			case "append":
				append(deps, ctx, rest);
				return;
			case "start":
				start(deps, ctx, rest);
				return;
			case "done":
				mutateStatus(deps, ctx, rest, "completed");
				return;
			case "drop":
				mutateStatus(deps, ctx, rest, "abandoned");
				return;
			case "rm":
				remove(deps, ctx, rest);
				return;
			default:
				emit(ctx, `Unknown /todo verb "${verb}".\n${USAGE}`, "error");
		}
	};
}

/** Headless-safe output: notify in dialog-capable UIs, stderr text elsewhere. */
function emit(ctx: ExtensionCommandContext, text: string, severity: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(text, severity);
		return;
	}
	// stderr: stdout carries the protocol in json/rpc/print modes.
	console.error(text);
}

function showCurrent(deps: TodoCommandDeps, ctx: ExtensionCommandContext): void {
	const phases = deps.getPhases();
	if (phases.length === 0) {
		emit(ctx, "No todos. Use /todo append <task> to start one.");
		return;
	}
	emit(ctx, phasesToMarkdown(phases).trimEnd());
}

function copyMarkdown(deps: TodoCommandDeps, ctx: ExtensionCommandContext): void {
	const phases = deps.getPhases();
	// omp ACP fallback (no clipboard in the extension API either):
	// "Copy not available in ACP mode; printing instead".
	const markdown = phases.length === 0 ? "" : phasesToMarkdown(phases).trimEnd();
	emit(ctx, `Copy not available without a clipboard integration; printing instead:\n\n${markdown || "No todos."}`);
}

async function exportToFile(deps: TodoCommandDeps, ctx: ExtensionCommandContext, rest: string): Promise<void> {
	const phases = deps.getPhases();
	if (phases.length === 0) {
		emit(ctx, "No todos to export.", "warning");
		return;
	}
	try {
		const target = resolveTodoMarkdownPath(rest, ctx.cwd);
		writeFileSync(target, phasesToMarkdown(phases), "utf8");
		emit(ctx, `Wrote todos to ${target}`);
	} catch (error) {
		emit(ctx, `Failed to write todos: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

async function importFromFile(deps: TodoCommandDeps, ctx: ExtensionCommandContext, rest: string): Promise<void> {
	let source = "";
	let content: string;
	try {
		source = resolveTodoMarkdownPath(rest, ctx.cwd);
		content = readFileSync(source, "utf8");
	} catch (error) {
		emit(ctx, `Failed to read todos: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}
	const { phases, errors } = markdownToPhases(content);
	if (errors.length > 0) {
		emit(ctx, `Could not parse ${source}:\n  ${errors.join("\n  ")}`, "error");
		return;
	}
	commitPhases(deps, phases);
	const taskCount = phases.reduce((sum, p) => sum + p.tasks.length, 0);
	emit(ctx, `Imported ${phases.length} phase(s), ${taskCount} task(s) from ${source}.`);
}

function append(deps: TodoCommandDeps, ctx: ExtensionCommandContext, rest: string): void {
	const tokens = tokenize(rest);
	if (tokens.length === 0) {
		emit(ctx, "Usage: /todo append [<phase>] <task...>", "error");
		return;
	}

	const current = deps.getPhases();
	let phaseName: string | undefined;
	let content: string;

	if (tokens.length === 1) {
		content = tokens[0];
	} else {
		phaseName = tokens[0];
		content = tokens.slice(1).join(" ");
	}

	const next = clonePhases(current);
	let targetPhase: TodoPhase;

	if (phaseName) {
		const existing = findPhaseFuzzy(next, phaseName);
		targetPhase = existing ?? { name: titleCase(phaseName), tasks: [] };
		if (!existing) next.push(targetPhase);
	} else if (next.length > 0) {
		targetPhase = next[next.length - 1];
	} else {
		targetPhase = { name: "Todos", tasks: [] };
		next.push(targetPhase);
	}

	const finalContent = titleCaseSentence(content);
	targetPhase.tasks.push({ content: finalContent, status: "pending" });

	commitPhases(deps, next);
	emit(ctx, `Appended to ${targetPhase.name}: ${finalContent}`);
}

function start(deps: TodoCommandDeps, ctx: ExtensionCommandContext, rest: string): void {
	if (!rest) {
		emit(ctx, "Usage: /todo start <task>", "error");
		return;
	}
	const hit = findTaskFuzzy(deps.getPhases(), rest);
	if (!hit) {
		emit(ctx, `No task matched "${rest}". Use /todo to list current tasks.`, "error");
		return;
	}
	applyAndCommit(deps, ctx, [{ op: "start", task: hit.task.content }], `Started: ${hit.task.content}`);
}

/** Shared tail of every mutating verb: apply ops, commit on success, report.
 *  A failing batch is discarded wholesale (state unchanged) and its errors
 *  surface as one error line. */
function applyAndCommit(
	deps: TodoCommandDeps,
	ctx: ExtensionCommandContext,
	ops: TodoOpEntry[],
	successMessage: string,
): void {
	const { phases, errors } = applyOpsToPhases(deps.getPhases(), ops);
	if (errors.length > 0) {
		emit(ctx, errors.join("; "), "error");
		return;
	}
	commitPhases(deps, phases);
	emit(ctx, successMessage);
}

function mutateStatus(
	deps: TodoCommandDeps,
	ctx: ExtensionCommandContext,
	rest: string,
	target: "completed" | "abandoned",
): void {
	const op = target === "completed" ? "done" : "drop";
	const current = deps.getPhases();
	const trimmedArg = rest.trim();
	if (!trimmedArg) {
		// no-arg: apply to all
		applyAndCommit(deps, ctx, [{ op }], `Marked all tasks ${target}.`);
		return;
	}

	const taskHit = findTaskFuzzy(current, trimmedArg);
	if (taskHit) {
		applyAndCommit(deps, ctx, [{ op, task: taskHit.task.content }], `Marked ${target}: ${taskHit.task.content}`);
		return;
	}

	const phaseHit = findPhaseFuzzy(current, trimmedArg);
	if (phaseHit) {
		applyAndCommit(deps, ctx, [{ op, phase: phaseHit.name }], `Marked phase ${phaseHit.name} ${target}.`);
		return;
	}

	emit(ctx, `No task or phase matched "${trimmedArg}".`, "error");
}

function remove(deps: TodoCommandDeps, ctx: ExtensionCommandContext, rest: string): void {
	const current = deps.getPhases();
	const trimmedArg = rest.trim();
	if (!trimmedArg) {
		commitPhases(deps, []);
		emit(ctx, "Cleared all todos.");
		return;
	}
	const taskHit = findTaskFuzzy(current, trimmedArg);
	if (taskHit) {
		applyAndCommit(deps, ctx, [{ op: "rm", task: taskHit.task.content }], `Removed: ${taskHit.task.content}`);
		return;
	}
	const phaseHit = findPhaseFuzzy(current, trimmedArg);
	if (phaseHit) {
		applyAndCommit(deps, ctx, [{ op: "rm", phase: phaseHit.name }], `Removed phase: ${phaseHit.name}`);
		return;
	}
	emit(ctx, `No task or phase matched "${trimmedArg}".`, "error");
}

/** omp #editInExternalEditor with pi's dialog editor as the $EDITOR surface. */
async function editInEditor(deps: TodoCommandDeps, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		emit(
			ctx,
			"/todo edit requires the TUI editor; use /todo export then /todo import for non-interactive edits.",
			"warning",
		);
		return;
	}
	const current = deps.getPhases();
	const initialMarkdown =
		current.length > 0 ? phasesToMarkdown(current) : "# Todos\n- [ ] (replace this with your tasks)\n";

	const result = await ctx.ui.editor("Todo (Markdown round-trip)", initialMarkdown);
	if (result === null || result === undefined) {
		emit(ctx, "Editor exited without saving; todos unchanged.", "warning");
		return;
	}
	const { phases: parsed, errors } = markdownToPhases(result);
	if (errors.length > 0) {
		emit(ctx, `Could not parse Markdown:\n  ${errors.join("\n  ")}`, "error");
		return;
	}
	commitPhases(deps, parsed);
	const taskCount = parsed.reduce((sum, p) => sum + p.tasks.length, 0);
	emit(ctx, `Todos updated from editor: ${parsed.length} phase(s), ${taskCount} task(s).`);
}
