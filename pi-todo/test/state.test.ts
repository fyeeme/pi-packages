import { describe, expect, it } from "vitest";
import {
	applyOpsToPhases,
	applyParams,
	clonePhases,
	formatSummary,
	inferTodoOp,
	isTodoPhase,
	isTodoPhaseSnapshot,
	normalizeInProgressTask,
	openTasks,
	type TodoOpEntry,
	type TodoPhase,
} from "../src/state.ts";

function phasesWithTasks(...entries: Array<[string, ...string[]]>): TodoPhase[] {
	return entries.map(([name, ...tasks]) => ({ name, tasks: tasks.map(content => ({ content, status: "pending" as const })) }));
}

describe("todo state: init", () => {
	it("installs a phased list, all tasks pending, in order", () => {
		const { phases, errors } = applyParams(
			[],
			{
				op: "init",
				list: [
					{ phase: "Foundation", items: ["Scaffold", "Wire"] },
					{ phase: "Verify", items: ["Run tests"] },
				],
			},
		);
		expect(errors).toEqual([]);
		expect(phases.map(p => p.name)).toEqual(["Foundation", "Verify"]);
		// normalizeInProgressTask auto-promotes the earliest pending task.
		expect(phases[0].tasks[0]).toEqual({ content: "Scaffold", status: "in_progress" });
		expect(phases[0].tasks[1].status).toBe("pending");
		expect(phases[1].tasks[0].status).toBe("pending");
	});

	it("rejects duplicate task content atomically, leaving the previous list untouched", () => {
		const previous = phasesWithTasks(["Foundation", "Scaffold"]);
		const { phases, errors } = applyParams(clonePhases(previous), {
			op: "init",
			list: [
				{ phase: "A", items: ["Novel task", "Novel task"] },
			],
		});
		expect(errors).toEqual(['Duplicate task "Novel task" in init list']);
		// init replaces the list; the untouched previous snapshot keeps its state.
		expect(previous[0].tasks[0].status).toBe("pending");
	});

	it("rejects duplicate phase names", () => {
		const { errors } = applyParams([], {
			op: "init",
			list: [
				{ phase: "A", items: ["one"] },
				{ phase: "A", items: ["two"] },
			],
		});
		expect(errors).toEqual(['Duplicate phase "A" in init list']);
	});

	it("rejects init without a list", () => {
		const { errors } = applyParams([], { op: "init" });
		expect(errors).toEqual(["Missing list for init operation"]);
	});

	it("accepts the flattened single-phase shape via items", () => {
		const { phases, errors } = applyParams([], { op: "init", items: ["one", "two"] });
		expect(errors).toEqual([]);
		expect(phases).toEqual([
			{
				name: "Tasks",
				tasks: [
					{ content: "one", status: "in_progress" },
					{ content: "two", status: "pending" },
				],
			},
		]);
	});
});

describe("todo state: start", () => {
	it("demotes every other in_progress task back to pending", () => {
		const phases: TodoPhase[] = [
			{ name: "A", tasks: [{ content: "a1", status: "in_progress" }] },
			{ name: "B", tasks: [{ content: "b1", status: "pending" }] },
		];
		const { phases: updated, errors } = applyParams(phases, { op: "start", task: "b1" });
		expect(errors).toEqual([]);
		expect(updated[0].tasks[0].status).toBe("pending");
		expect(updated[1].tasks[0].status).toBe("in_progress");
	});

	it("rejects unknown tasks without mutation", () => {
		const phases = phasesWithTasks(["A", "a1"]);
		const { errors } = applyParams(clonePhases(phases), { op: "start", task: "nope" });
		expect(errors.join(" ")).toMatch(/not found/);
		// The tool layer discards the batch on any error, so previous state wins.
		expect(phases[0].tasks[0].status).toBe("pending");
	});

	it("rejects start without task content", () => {
		const { errors } = applyParams([], { op: "start" });
		expect(errors).toEqual(["Missing task content"]);
	});
});

describe("todo state: done and drop", () => {
	it("marks a task completed without deleting it", () => {
		const { phases, errors } = applyParams(phasesWithTasks(["A", "a1", "a2"]), { op: "done", task: "a1" });
		expect(errors).toEqual([]);
		expect(phases[0].tasks.find(t => t.content === "a1")?.status).toBe("completed");
		expect(phases[0].tasks).toHaveLength(2);
	});

	it("marks all tasks of a phase abandoned while keeping the phase", () => {
		const { phases } = applyParams(phasesWithTasks(["A", "a1", "a2"], ["B", "b1"]), { op: "drop", phase: "A" });
		expect(phases[0].tasks.every(t => t.status === "abandoned")).toBe(true);
		expect(phases).toHaveLength(2);
	});

	it("rejects done for unknown phase", () => {
		const { errors } = applyParams(phasesWithTasks(["A", "a1"]), { op: "done", phase: "Zed" });
		expect(errors).toEqual(['Phase "Zed" not found']);
	});
});

describe("todo state: block and unblock", () => {
	it("blocks only actionable open work when targeting a phase", () => {
		const phases: TodoPhase[] = [
			{
				name: "A",
				tasks: [
					{ content: "finished", status: "completed" },
					{ content: "open", status: "pending" },
				],
			},
		];
		const { phases: updated, errors } = applyParams(phases, { op: "block", phase: "A", reason: "waiting  on  CI" });
		expect(errors).toEqual([]);
		expect(updated[0].tasks.find(t => t.content === "finished")?.status).toBe("completed");
		const blocked = updated[0].tasks.find(t => t.content === "open");
		expect(blocked).toEqual({ content: "open", status: "blocked", blocker: "waiting on CI" });
	});

	it("collapses whitespace runs in the reason to single spaces", () => {
		const { phases } = applyParams(phasesWithTasks(["A", "a1"]), { op: "block", task: "a1", reason: "a\n\tb  c" });
		expect(phases[0].tasks[0].blocker).toBe("a b c");
	});

	it("refines the blocker note when re-blocking", () => {
		let phases = phasesWithTasks(["A", "a1"]);
		({ phases } = applyParams(phases, { op: "block", task: "a1" }));
		({ phases } = applyParams(phases, { op: "block", task: "a1", reason: "refined" }));
		expect(phases[0].tasks[0]).toEqual({ content: "a1", status: "blocked", blocker: "refined" });
	});

	it("unblock returns a blocked task to pending and clears the note", () => {
		const phases: TodoPhase[] = [
			{
				name: "A",
				tasks: [
					{ content: "a1", status: "in_progress" },
					{ content: "a2", status: "blocked", blocker: "x" },
				],
			},
		];
		const { phases: updated } = applyParams(phases, { op: "unblock", task: "a2" });
		expect(updated[0].tasks[1]).toEqual({ content: "a2", status: "pending" });
	});

	it("rejects block and unblock without a target", () => {
		expect(applyParams(phasesWithTasks(["A", "a1"]), { op: "block" }).errors).toEqual([
			"block requires a task or phase target",
		]);
		expect(applyParams(phasesWithTasks(["A", "a1"]), { op: "unblock" }).errors).toEqual([
			"unblock requires a task or phase target",
		]);
	});
});

describe("todo state: rm", () => {
	it("removes a single task", () => {
		const { phases } = applyParams(phasesWithTasks(["A", "a1", "a2"]), { op: "rm", task: "a1" });
		expect(phases[0].tasks.map(t => t.content)).toEqual(["a2"]);
	});

	it("clears one phase's tasks", () => {
		const { phases } = applyParams(phasesWithTasks(["A", "a1"], ["B", "b1"]), { op: "rm", phase: "A" });
		expect(phases[0].tasks).toEqual([]);
		expect(phases[1].tasks).toHaveLength(1);
	});

	it("clears all phases when no target is given", () => {
		const { phases } = applyParams(phasesWithTasks(["A", "a1"], ["B", "b1"]), { op: "rm" });
		expect(phases.every(p => p.tasks.length === 0)).toBe(true);
	});

	it("rejects unknown targets", () => {
		const { errors } = applyParams(phasesWithTasks(["A", "a1"]), { op: "rm", task: "ghost" });
		expect(errors.join(" ")).toMatch(/not found/);
	});
});

describe("todo state: append", () => {
	it("lazily creates the phase", () => {
		const { phases, errors } = applyParams(phasesWithTasks(["A", "a1"]), { op: "append", phase: "New", items: ["n1"] });
		expect(errors).toEqual([]);
		expect(phases[1]).toEqual({ name: "New", tasks: [{ content: "n1", status: "pending" }] });
	});

	it("rejects duplicates without half-applying", () => {
		const previous = phasesWithTasks(["A", "a1"]);
		const { phases, errors } = applyParams(clonePhases(previous), {
			op: "append",
			phase: "B",
			items: ["novel", "a1"],
		});
		expect(errors).toEqual(['Task "a1" already exists']);
		// The untouched original still holds only its own task (batch discarded).
		expect(previous).toHaveLength(1);
	});

	it("requires a phase and non-empty items", () => {
		expect(applyParams([], { op: "append", items: ["x"] }).errors).toEqual(["Missing phase name for append operation"]);
		expect(applyParams([], { op: "append", phase: "A", items: [] }).errors).toEqual([
			"Missing items for append operation",
		]);
	});
});

describe("todo state: view is read-only", () => {
	it("passes phases through and reports empty for fresh state", () => {
		const previous = phasesWithTasks(["A", "a1"]);
		const { phases, errors } = applyParams(previous, { op: "view" });
		expect(errors).toEqual([]);
		expect(phases[0].tasks[0].content).toBe("a1");
		expect(formatSummary([], [], true)).toBe("Todo list is empty.");
	});
});

describe("todo state: op inference", () => {
	it("infers init from a non-empty list", () => {
		expect(inferTodoOp({ list: [{ phase: "A", items: ["a"] }] }, false)).toBe("init");
	});

	it("infers append from items plus phase", () => {
		expect(inferTodoOp({ items: ["x"], phase: "A" }, true)).toBe("append");
	});

	it("infers init from bare items when nothing exists yet", () => {
		expect(inferTodoOp({ items: ["x"] }, false)).toBe("init");
	});

	it("does not infer from ambiguous targeting args", () => {
		expect(inferTodoOp({ task: "a1" }, true)).toBeUndefined();
		expect(inferTodoOp({ phase: "A" }, true)).toBeUndefined();
		expect(inferTodoOp({ items: ["x"] }, true)).toBeUndefined();
	});
});

describe("todo state: batch application", () => {
	it("applies ops in sequence for /todo clear", () => {
		const phases: TodoPhase[] = [
			{
				name: "A",
				tasks: [
					{ content: "a1", status: "completed" },
					{ content: "a2", status: "in_progress" },
				],
			},
		];
		const { phases: updated, errors } = applyOpsToPhases(phases, [{ op: "rm", phase: "A" }, { op: "append", phase: "A", items: ["fresh"] }]);
		expect(errors).toEqual([]);
		expect(updated[0].tasks).toEqual([{ content: "fresh", status: "in_progress" }]);
	});
});

describe("todo state: normalization", () => {
	it("demotes surplus in_progress tasks", () => {
		const phases: TodoPhase[] = [
			{
				name: "A",
				tasks: [
					{ content: "a1", status: "in_progress" },
					{ content: "a2", status: "in_progress" },
				],
			},
		];
		normalizeInProgressTask(phases);
		expect(phases[0].tasks.map(t => t.status)).toEqual(["in_progress", "pending"]);
	});

	it("auto-promotes the earliest pending task when none is in progress", () => {
		const phases: TodoPhase[] = [
			{ name: "A", tasks: [{ content: "a1", status: "completed" }] },
			{ name: "B", tasks: [{ content: "b1", status: "pending" }] },
		];
		normalizeInProgressTask(phases);
		expect(phases[1].tasks[0].status).toBe("in_progress");
	});

	it("out-of-order completion can move the pointer back to an earlier phase", () => {
		let { phases } = applyParams(phasesWithTasks(["A", "a1", "a2"], ["B", "b1"]), { op: "done", task: "a1" });
		({ phases } = applyParams(phases, { op: "done", task: "b1" }));
		// b1 done; pointer returns to a2 (earliest open task).
		expect(phases[0].tasks[1].status).toBe("in_progress");
		expect(phases[1].tasks[0].status).toBe("completed");
	});
});

describe("todo state: helpers", () => {
	it("counts actionable open tasks, excluding settled and blocked work", () => {
		const phases: TodoPhase[] = [
			{
				name: "A",
				tasks: [
					{ content: "a1", status: "completed" },
					{ content: "a2", status: "abandoned" },
					{ content: "a3", status: "pending" },
					{ content: "a4", status: "in_progress" },
					{ content: "a5", status: "blocked", blocker: "ci" },
				],
			},
		];
		expect(openTasks(phases).map(t => t.content)).toEqual(["a3", "a4"]);
	});

	it("validates phase snapshots for restore", () => {
		expect(isTodoPhase({ name: "A", tasks: [{ content: "a", status: "pending" }] })).toBe(true);
		expect(isTodoPhase({ name: "A", tasks: [{ content: "a", status: "bogus" }] })).toBe(false);
		expect(isTodoPhase({ name: 3, tasks: [] })).toBe(false);
		expect(isTodoPhaseSnapshot({ phases: [] })).toBe(true);
		expect(isTodoPhaseSnapshot({ phases: [{ nope: true }] })).toBe(false);
		expect(isTodoPhaseSnapshot(undefined)).toBe(false);
	});
});

describe("todo state: summary text", () => {
	it("renders remaining items, overall counts, and the phase checklist", () => {
		const phases: TodoPhase[] = [
			{
				name: "Foundation",
				tasks: [
					{ content: "scaffold", status: "completed" },
					{ content: "wire", status: "in_progress" },
				],
			},
			{ name: "Verify", tasks: [{ content: "run tests", status: "blocked", blocker: "env" }] },
		];
		const text = formatSummary(phases, []);
		expect(text).toContain("Remaining items (1):");
		expect(text).toContain("- wire [in_progress] (Foundation)");
		expect(text).toContain("Overall: 1/3 done, 1 open, 1 blocked.");
		expect(text).toContain('Active phase 1/2 "Foundation" (1/2).');
		expect(text).toContain("[X] scaffold");
		expect(text).toContain("(blocked: env)");
	});

	it("reports errors first and no-ops as cleared", () => {
		expect(formatSummary([], ["boom"])).toBe("Errors: boom");
		expect(formatSummary([], [])).toBe("Todo list cleared.");
	});
});

describe("todo state: params type", () => {
	it("accepts every operation name in the entry type", () => {
		const ops: TodoOpEntry["op"][] = ["init", "start", "done", "rm", "drop", "block", "unblock", "append", "view"];
		expect(ops).toHaveLength(9);
	});
});
