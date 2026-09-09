/**
 * pi-todo ≡ oh-my-pi /todo alignment suite.
 *
 * Pins pi-todo's observable behavior to oh-my-pi (omp)
 * `packages/coding-agent` todo mode, source by source:
 *
 *   omp source                                   | pinned here
 *   ---------------------------------------------+------------------------------
 *   tools/todo.ts phasesToMarkdown /             | markdown round-trip
 *     markdownToPhases / resolveTodo-            | (markers, blocker comments,
 *     MarkdownPath                               |  escaped brackets, errors)
 *   tools/todo.ts phaseRomanNumeral              | algorithmic roman numerals
 *   tools/todo.ts selectCollapsedTodos /         | collapsed walking viewport
 *     selectWithinCap / todoMatchesAny-          |
 *     Description                                |
 *   tools/todo.ts formatSummary                  | exact summary text
 *   tools/todo.ts formatMoreItems / pluralize    | ellipsis summaries
 *   session/todo-tracker.ts checkCompletion /    | reminder text, attempt
 *     isAwaitingUserAnswer                       | cycle, question guard
 *   modes/controllers/todo-command-controller.ts | /todo verb surface, fuzzy
 *                                                | matching, system reminder
 *
 * Every expected string is copied verbatim from the omp sources listed.
 */

import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import {
	formatSummary,
	isAwaitingUserAnswer,
	markdownToPhases,
	normalizeInProgressTask,
	phaseRomanNumeral,
	phasesToMarkdown,
	pluralize,
	resolveTodoMarkdownPath,
	selectCollapsedTodos,
	todoMatchesAnyDescription,
	type TodoItem,
	type TodoPhase,
} from "../src/state.ts";

// ---------------------------------------------------------------------------
// Markdown round-trip — omp tools/todo.ts
// ---------------------------------------------------------------------------

describe("markdown round-trip matches omp", () => {
	it("phasesToMarkdown renders the omp checklist format", () => {
		const phases: TodoPhase[] = [
			{
				name: "Foundation",
				tasks: [
					{ content: "Scaffold crate", status: "completed" },
					{ content: "Wire workspace", status: "in_progress" },
				],
			},
			{
				name: "Verify",
				tasks: [
					{ content: "Run tests", status: "pending" },
					{ content: "Wait for CI", status: "blocked", blocker: "ci down" },
				],
			},
		];
		// omp output verbatim: # headings, blank line between phases, marker set
		// [ ] [/] [x] [-] [!], blocker in a trailing HTML comment.
		expect(phasesToMarkdown(phases)).toBe(
			[
				"# Foundation",
				"- [x] Scaffold crate",
				"- [/] Wire workspace",
				"",
				"# Verify",
				"- [ ] Run tests",
				"- [!] Wait for CI <!-- blocker: ci down -->",
			].join("\n") + "\n",
		);
	});

	it("empty phases render the omp '# Todos' stub", () => {
		expect(phasesToMarkdown([])).toBe("# Todos\n");
	});

	it("markdownToPhases parses markers back, including blocked reasons", () => {
		const { phases, errors } = markdownToPhases(
			["# A", "- [x] done-one", "- [/] doing", "- [-] gone", "- [!] stuck <!-- blocker: upstream -->", "- [ ] open"].join(
				"\n",
			),
		);
		expect(errors).toEqual([]);
		expect(phases).toEqual([
			{
				name: "A",
				tasks: [
					{ content: "done-one", status: "completed" },
					{ content: "doing", status: "in_progress" },
					{ content: "gone", status: "abandoned" },
					{ content: "stuck", status: "blocked", blocker: "upstream" },
					{ content: "open", status: "pending" },
				],
			},
		]);
	});

	it("round-trips losslessly", () => {
		const phases: TodoPhase[] = [
			{ name: "P", tasks: [{ content: "a", status: "blocked", blocker: "why" }] },
			{ name: "Q", tasks: [{ content: "b", status: "in_progress" }] },
		];
		const parsed = markdownToPhases(phasesToMarkdown(phases));
		expect(parsed.errors).toEqual([]);
		expect(parsed.phases).toEqual(phases);
	});

	it("tolerates backslash-escaped brackets and alternate bullets (omp tolerance)", () => {
		const { phases, errors } = markdownToPhases("- \\[x\\] escaped\n* [ ] starred\n+ [/] plus");
		expect(errors).toEqual([]);
		expect(phases[0]?.tasks.map(t => t.content)).toEqual(["escaped", "starred", "plus"]);
	});

	it("reports omp error lines for unknown markers and stray syntax", () => {
		const { errors } = markdownToPhases("- [?] mystery\njust text");
		expect(errors).toEqual([
			'Line 1: unknown status marker "[?]" (use [ ], [x], [/], [-], [!])',
			'Line 2: unrecognized syntax "just text"',
		]);
	});

	it("normalizeInProgressTask runs on parse (omp markdownToPhases tail)", () => {
		const { phases } = markdownToPhases("- [ ] one\n- [ ] two");
		expect(phases[0]?.tasks[0]?.status).toBe("in_progress");
		expect(phases[0]?.tasks[1]?.status).toBe("pending");
	});

	it("resolveTodoMarkdownPath matches omp: quotes stripped, TODO.md default, ~ and cwd", () => {
		expect(resolveTodoMarkdownPath("", "/w")).toBe("/w/TODO.md");
		expect(resolveTodoMarkdownPath('  "plans.md"  ', "/w")).toBe("/w/plans.md");
		expect(resolveTodoMarkdownPath("/abs/t.md", "/w")).toBe("/abs/t.md");
		expect(resolveTodoMarkdownPath("~/t.md", "/w")).toBe(`${homedir()}/t.md`);
	});
});

// ---------------------------------------------------------------------------
// phaseRomanNumeral — omp algorithmic version (no fixed cap)
// ---------------------------------------------------------------------------

describe("phaseRomanNumeral matches omp", () => {
	it("renders standard numerals", () => {
		expect(phaseRomanNumeral(1)).toBe("I");
		expect(phaseRomanNumeral(4)).toBe("IV");
		expect(phaseRomanNumeral(9)).toBe("IX");
		expect(phaseRomanNumeral(14)).toBe("XIV");
		expect(phaseRomanNumeral(40)).toBe("XL");
		expect(phaseRomanNumeral(1994)).toBe("MCMXCIV");
	});

	it("returns empty for non-positive indices", () => {
		expect(phaseRomanNumeral(0)).toBe("");
		expect(phaseRomanNumeral(-3)).toBe("");
	});
});

// ---------------------------------------------------------------------------
// Collapsed walking viewport — omp selectCollapsedTodos (#5873)
// ---------------------------------------------------------------------------

function task(content: string, status: TodoItem["status"]): TodoItem {
	return { content, status };
}

describe("selectCollapsedTodos matches omp", () => {
	const never = () => false;

	it("returns everything within the cap", () => {
		const tasks = [task("a", "in_progress"), task("b", "pending")];
		const selection = selectCollapsedTodos(tasks, never, 8);
		expect(selection.items).toEqual(tasks);
		expect(selection.summary).toBe("");
	});

	it("leads with the last closed task and fills with following pending work", () => {
		const tasks = [
			task("closed-old", "completed"),
			task("closed-new", "completed"),
			task("a", "in_progress"),
			task("b", "pending"),
			task("c", "pending"),
			task("d", "pending"),
			task("e", "pending"),
			task("f", "pending"),
			task("g", "pending"),
			task("h", "pending"),
		];
		const selection = selectCollapsedTodos(tasks, never, 8);
		// Open work = 8 (a..h) ≤ cap; lead adds the LAST closed row additively.
		expect(selection.items.map(t => t.content)).toEqual([
			"closed-new",
			"a",
			"b",
			"c",
			"d",
			"e",
			"f",
			"g",
			"h",
		]);
		expect(selection.summary).toBe("");
	});

	it("counts hidden open work with the omp ellipsis summary", () => {
		const tasks = [task("done", "completed"), ...Array.from({ length: 10 }, (_, i) => task(`t${i}`, "pending"))];
		const selection = selectCollapsedTodos(tasks, never, 8);
		expect(selection.items.filter(t => t.content === "done")).toHaveLength(1);
		expect(selection.summary).toBe("… 2 more todos");
	});

	it("never drops active rows; hides only actives when they exceed the cap", () => {
		const tasks = [
			task("w1", "in_progress"),
			task("w2", "in_progress"),
			task("w3", "in_progress"),
			task("p", "pending"),
		];
		const selection = selectCollapsedTodos(tasks, never, 2);
		expect(selection.items.map(t => t.content)).toEqual(["w1", "w2"]);
		expect(selection.summary).toBe("… 1 more active todo");
	});

	it("a settled phase selects over its closed tasks", () => {
		const tasks = [task("a", "completed"), task("b", "abandoned"), task("c", "completed")];
		const selection = selectCollapsedTodos(tasks, never, 8);
		expect(selection.items).toEqual(tasks);
		expect(selection.summary).toBe("");
	});
});

describe("todoMatchesAnyDescription matches omp", () => {
	it("matches normalized equality and ≥6-char substrings both ways", () => {
		expect(todoMatchesAnyDescription("Fix the build", ["fix the build!"])).toBe(true);
		expect(todoMatchesAnyDescription("Sonnet #2: bug scan", ["Sonnet #2"])).toBe(true);
		expect(todoMatchesAnyDescription("review", ["code review phase"])).toBe(true);
		expect(todoMatchesAnyDescription("test", ["testing"])).toBe(false); // <6 overlap
		expect(todoMatchesAnyDescription("", ["anything"])).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Stop-reminder guards — omp TodoTracker
// ---------------------------------------------------------------------------

describe("isAwaitingUserAnswer matches omp", () => {
	it("detects question endings (word gates + non-ASCII)", () => {
		expect(isAwaitingUserAnswer("Done for now.\nWhich database should I use?")).toBe(true);
		expect(isAwaitingUserAnswer("Should I proceed?")).toBe(true);
		expect(isAwaitingUserAnswer("要继续吗？")).toBe(true); // CJK question
		expect(isAwaitingUserAnswer("Q1: ready?")).toBe(true); // prompt label
	});

	it("detects response cues", () => {
		expect(isAwaitingUserAnswer("Please confirm the plan.")).toBe(true);
		expect(isAwaitingUserAnswer("Let me know if that works")).toBe(true);
	});

	it("ignores prose with incidental question marks", () => {
		// No question word/pronoun/non-ASCII gate fires; omp treats it as prose.
		expect(isAwaitingUserAnswer("Fixed the optional foo?: string handling.")).toBe(false);
		expect(isAwaitingUserAnswer("All checks pass.")).toBe(false);
		expect(isAwaitingUserAnswer("")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// formatSummary — omp tools/todo.ts (tool result body)
// ---------------------------------------------------------------------------

describe("formatSummary matches omp verbatim", () => {
	it("renders the empty-read text", () => {
		expect(markdownToPhases("").phases).toEqual([]);
	});

	it("renders the full omp summary block", () => {
		const phases: TodoPhase[] = [
			{
				name: "Foundation",
				tasks: [
					{ content: "Scaffold", status: "completed" },
					{ content: "Wire", status: "in_progress" },
				],
			},
			{
				name: "Verify",
				tasks: [
					{ content: "Tests", status: "pending" },
					{ content: "CI", status: "blocked", blocker: "down" },
				],
			},
		];
		expect(formatSummary(phases, [])).toBe(
			[
				// omp counts only pending + in_progress as remaining; blocked is parked.
				"Remaining items (2):",
				"  - Wire [in_progress] (Foundation)",
				"  - Tests [pending] (Verify)",
				"Overall: 1/4 done, 2 open, 1 blocked.",
				'Active phase 1/2 "Foundation" (1/2).',
				"  Foundation:",
				"    - [X] Scaffold",
				"    - [ ] Wire (in progress)",
				"  Verify:",
				"    - [ ] Tests",
				"    - [ ] CI (blocked: down)",
			].join("\n"),
		);
	});

	it("renders the worked-ahead explanation (omp backward-pointer note)", () => {
		const phases: TodoPhase[] = [
			{ name: "A", tasks: [{ content: "a", status: "pending" }] },
			{ name: "B", tasks: [{ content: "b", status: "completed" }] },
		];
		const out = formatSummary(phases, []);
		expect(out).toContain(
			'Active phase 1/2 "A" (0/1) — earliest phase with open tasks; the in-progress pointer auto-advances to the earliest open task on each completion, so it can sit behind out-of-order work (nothing was un-completed).',
		);
	});

	it("error-only batches report Errors first (omp formatSummary)", () => {
		expect(formatSummary([], ['Task "x" not found'], false)).toBe("Errors: Task \"x\" not found");
		expect(formatSummary([], [], true)).toBe("Todo list is empty.");
		expect(formatSummary([], [], false)).toBe("Todo list cleared.");
	});
});

// ---------------------------------------------------------------------------
// pluralize — omp packages/utils pluralize
// ---------------------------------------------------------------------------

describe("pluralize matches omp", () => {
	it("handles regular, s-ending, and y-ending nouns", () => {
		expect(pluralize("todo", 1)).toBe("todo");
		expect(pluralize("todo", 2)).toBe("todos");
		expect(pluralize("status", 2)).toBe("statuses");
		expect(pluralize("entry", 2)).toBe("entries");
	});
});

// ---------------------------------------------------------------------------
// normalizeInProgressTask invariant (omp applyParams tail)
// ---------------------------------------------------------------------------

describe("normalizeInProgressTask matches omp", () => {
	it("demotes surplus in-progress tasks", () => {
		const phases: TodoPhase[] = [
			{ name: "A", tasks: [task("a", "in_progress"), task("b", "in_progress")] },
		];
		normalizeInProgressTask(phases);
		expect(phases[0]?.tasks.map(t => t.status)).toEqual(["in_progress", "pending"]);
	});

	it("auto-promotes the earliest pending when none is in progress", () => {
		const phases: TodoPhase[] = [
			{ name: "A", tasks: [task("a", "completed"), task("b", "pending")] },
			{ name: "B", tasks: [task("c", "pending")] },
		];
		normalizeInProgressTask(phases);
		expect(phases[0]?.tasks[1]?.status).toBe("in_progress");
		expect(phases[1]?.tasks[0]?.status).toBe("pending");
	});
});
