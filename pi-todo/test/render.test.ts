import { describe, expect, it } from "vitest";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { renderTodoCall, renderTodoResult } from "../src/render.ts";
import type { TodoPhase, TodoToolDetails } from "../src/state.ts";

// Identity theme: assertions see omp's plain strings. Colors are structurally
// exercised by the renderer code (fg calls carry omp's color names).
const identityTheme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
	strikethrough: (text: string) => text,
	italic: (text: string) => text,
} as unknown as Theme;

function result(
	op: TodoToolDetails["op"],
	phases: TodoPhase[],
	completedTasks?: TodoToolDetails["completedTasks"],
): AgentToolResult<TodoToolDetails> {
	return { content: [], details: { op, phases, storage: "memory", completedTasks } };
}

function options(isPartial = false, expanded = false): ToolRenderResultOptions {
	return { expanded, isPartial };
}

function text(component: { render(width: number): string[] }): string {
	return component
		.render(200)
		.map(line => line.trimEnd())
		.join("\n");
}

function phase(name: string, statuses: TodoPhase["tasks"][number]["status"][]): TodoPhase {
	return { name, tasks: statuses.map((status, i) => ({ content: `${name.toLowerCase()}-${i + 1}`, status })) };
}

// ---------------------------------------------------------------------------
// Call line — omp renderCall: ⏳ Todo · <op> <task> <phase> N items
// ---------------------------------------------------------------------------

describe("todo render: call line (omp renderStatusLine shape)", () => {
	it("renders the pending header with op meta", () => {
		const out = text(renderTodoCall({ op: "done", task: "Wire workspace" }, identityTheme));
		expect(out).toBe("⏳ Todo · done Wire workspace");
	});

	it("joins multiple meta fragments and counts items", () => {
		const out = text(
			renderTodoCall(
				{ op: "init", phase: "Auth", items: ["a", "b", "c"] } as never,
				identityTheme,
			),
		);
		// omp joins a single op's parts with spaces (multi-op entries join " · ").
		expect(out).toBe("⏳ Todo · init Auth 3 items");
	});

	it("falls back to update when no op is present", () => {
		const out = text(renderTodoCall({}, identityTheme));
		expect(out).toBe("⏳ Todo · update");
	});
});

// ---------------------------------------------------------------------------
// Result — omp renderResult: ☑ Todo · N tasks header + phase tree
// ---------------------------------------------------------------------------

describe("todo render: result (omp renderer)", () => {
	it("renders the omp header and a touched phase with tree glyphs and omp colors", () => {
		const out = text(
			renderTodoResult(
				result("start", [phase("Foundation", ["completed", "in_progress", "pending"])]),
				options(),
				identityTheme,
			),
		);
		// omp header: tool.todo glyph accent + title + dim "· N tasks".
		expect(out).toContain("☑ Todo · 3 tasks");
		// Single-phase render has no phase header line and no tree indent.
		expect(out).toContain("☑ foundation-1");
		expect(out).toContain("☐ foundation-2");
		expect(out).toContain("☐ foundation-3");
		// No frame labels: collapsed selection is identity at 3 of cap 8.
		expect(out).not.toContain("more todos");
	});

	it("collapsed viewport shows the last closed row plus open work (omp #5873)", () => {
		const out = text(
			renderTodoResult(result("done", [phase("A", ["completed", "abandoned", "blocked"])]), options(), identityTheme),
		);
		// Closed lead = LAST closed task only (COLLAPSED_CLOSED_CONTEXT 1);
		// open work (blocked) always renders.
		expect(out).not.toContain("a-1");
		expect(out).toContain("☐ a-2");
		expect(out).toContain("☐ a-3 (blocked)");
	});

	it("renders blocker notes", () => {
		const phases: TodoPhase[] = [
			{
				name: "A",
				tasks: [{ content: "a-1", status: "blocked", blocker: "ci down" }],
			},
		];
		const out = text(renderTodoResult(result("block", phases), options(), identityTheme));
		expect(out).toContain("a-1 (blocked: ci down)");
	});

	it("collapses untouched phases to the omp one-line summary with roman numerals", () => {
		const completed: NonNullable<TodoToolDetails["completedTasks"]> = [
			{ phase: "Foundation", content: "foundation-1" },
		];
		const out = text(
			renderTodoResult(
				result("done", [phase("Foundation", ["completed", "in_progress"]), phase("Verify", ["pending"])], completed),
				options(),
				identityTheme,
			),
		);
		// Foundation is touched (completion transition + in_progress) → expanded.
		expect(out).toContain("I. Foundation  1/2");
		expect(out).toContain("└─ ☐ foundation-2");
		// Verify untouched → one-line dim summary, tasks hidden.
		expect(out).toContain("II. Verify  0/1");
		expect(out).not.toContain("verify-1");
	});

	it("expands every phase when the view is toggled expanded", () => {
		const out = text(
			renderTodoResult(
				result("view", [phase("A", ["pending"]), phase("B", ["pending"])]),
				options(false, true),
				identityTheme,
			),
		);
		expect(out).toContain("a-1");
		expect(out).toContain("b-1");
	});

	it("computeTouchedPhases consumes the call args via the render context (omp args fold)", () => {
		// done on phase Two: Two is touched (completion + op phase); One is the
		// earliest phase with open work, so it stays expanded too (no pointer).
		const phases = [phase("One", ["pending"]), phase("Two", ["completed", "pending"])];
		const completed: NonNullable<TodoToolDetails["completedTasks"]> = [{ phase: "Two", content: "two-1" }];
		const out = text(
			renderTodoResult(
				result("done", phases, completed),
				options(),
				identityTheme,
				{ op: "done", phase: "Two" },
			),
		);
		expect(out).toContain("I. One  0/1");
		// Active phase (earliest open work) never collapses to a summary line.
		expect(out).toContain("one-1");
		expect(out).toContain("II. Two  1/2");
		expect(out).toContain("two-2");
	});

	it("multi-phase render indents tree lines under roman-numeral headers", () => {
		const out = text(
			renderTodoResult(
				result("init", [phase("Foundation", ["in_progress"]), phase("Verify", ["pending"])]),
				options(),
				identityTheme,
			),
		);
		expect(out).toContain("I. Foundation  0/1");
		expect(out).toContain("  └─ ☐ foundation-1");
		expect(out).toContain("II. Verify  0/1");
	});

	it("collapsed viewport caps at 8 rows with the omp more-todos summary", () => {
		const tasks = Array.from({ length: 10 }, (_, i) => ({
			content: `t-${i + 1}`,
			status: (i === 0 ? "in_progress" : "pending") as never,
		}));
		const out = text(renderTodoResult(result("init", [{ name: "A", tasks }]), options(), identityTheme));
		expect(out).toContain("… 2 more todos");
		expect(out).not.toContain("t-10");
	});

	it("keeps the last closed row visible above the open window (omp #5873 lead)", () => {
		const tasks = [
			{ content: "done-early", status: "completed" as const },
			...Array.from({ length: 9 }, (_, i) => ({ content: `t-${i + 1}`, status: "pending" as const })),
		];
		const out = text(renderTodoResult(result("init", [{ name: "A", tasks }]), options(), identityTheme));
		expect(out.indexOf("done-early")).toBeGreaterThanOrEqual(0);
		expect(out).toContain("… 1 more todo");
	});

	it("renders the omp empty-list fallback under the header", () => {
		const out = text(
			renderTodoResult(
				{
					content: [{ type: "text", text: "Todo list cleared." }],
					details: { op: "rm", phases: [], storage: "memory" },
				},
				options(),
				identityTheme,
			),
		);
		expect(out).toBe("☑ Todo · 0 tasks\n  Todo list cleared.");
	});

	it("renders the full tree while streaming — isPartial only flips the omp block state", () => {
		const out = text(
			renderTodoResult(result("init", [phase("A", ["pending"])]), options(true), identityTheme),
		);
		expect(out).toBe("☑ Todo · 1 tasks\n└─ ☐ a-1");
	});
});
