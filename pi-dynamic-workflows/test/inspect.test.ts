/**
 * WorkflowInspect — TUI component tests.
 *
 * Primary purpose: catch the template-literal escape regression where `${x}`
 * was corrupted to `\${x}` (legal JS, but renders literal text instead of the
 * interpolated value). The key assertion is `not.toContain("${")` on every
 * rendered line — any escaped interpolation fails the test.
 */
import { describe, expect, it } from "vitest";
import { WorkflowInspect } from "../src/inspect.ts";
import type { RunResult } from "../src/types.ts";

/** Minimal RunResult factory for tests. */
function makeResult(overrides: Partial<RunResult> = {}): RunResult {
	return {
		runId: "run-xyz-001",
		status: "completed",
		steps: [
			{
				id: "gather",
				type: "agent",
				status: "done",
				results: "collected 3 sources",
				stats: { tokens: 1200, cost: 0.0042, durationMs: 450, agents: 1, failures: 0 },
			},
			{
				id: "summarize",
				type: "agent",
				status: "done",
				results: "summary text here",
				stats: { tokens: 800, cost: 0.0028, durationMs: 300, agents: 1, failures: 0 },
			},
		],
		stats: { tokens: 2000, cost: 0.007, durationMs: 750, agents: 2, failures: 0 },
		...overrides,
	};
}

/** A no-op TUI stand-in. */
const noopTui = { requestRender(): void {}, terminal: { rows: 24 } };

describe("WorkflowInspect — render()", () => {
	it("interpolates the real runId and status (no literal template syntax)", () => {
		const comp = new WorkflowInspect(makeResult(), noopTui, () => {});
		const lines = comp.render(80);

		// The header line must contain the actual runId value, not the literal "${...}".
		expect(lines[0]).toContain("run-xyz-001");
		expect(lines[0]).toContain("completed");

		// REGRESSION GUARD: no rendered line may contain literal "${" — that
		// signature means a template interpolation was escaped to a string literal.
		for (const line of lines) {
			expect(line).not.toContain("${");
		}
	});

	it("renders one status line per step, in declared order", () => {
		const comp = new WorkflowInspect(makeResult(), noopTui, () => {});
		// Step rows live in the left pane and carry a status icon; the column header
		// also names the selected step, so filter on the icon to exclude it.
		const lines = comp.render(80).filter((l) => (l.includes("gather") || l.includes("summarize")) && l.includes("✓"));
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("gather");
		expect(lines[1]).toContain("summarize");
	});

	it("shows the real stats values (tokens), not literal template syntax", () => {
		const comp = new WorkflowInspect(makeResult(), noopTui, () => {});
		const lines = comp.render(80);
		// 2000 tokens → "2.0k"
		const statsLine = lines.find((l) => l.includes("2.0k"));
		expect(statsLine).toBeDefined();
		for (const line of lines) {
			expect(line).not.toContain("${");
		}
	});

	it("shows the error message when status is failed", () => {
		const comp = new WorkflowInspect(
			makeResult({ status: "failed", error: 'step "gather" failed' }),
			noopTui,
			() => {},
		);
		const lines = comp.render(80);
		// The error text appears in the header line (red).
		const errLine = lines.find((l) => l.includes('step "gather" failed'));
		expect(errLine).toBeDefined();
		for (const line of lines) {
			expect(line).not.toContain("${");
		}
	});

	it("shows the selected step's result body in the detail pane (always on)", () => {
		const comp = new WorkflowInspect(makeResult(), noopTui, () => {});
		// gather is selected by default → its results fill the right pane.
		let lines = comp.render(80);
		expect(lines.find((l) => l.includes("collected 3 sources"))).toBeDefined();
		for (const line of lines) {
			expect(line).not.toContain("${");
		}
		// Switching selection swaps the detail pane content.
		comp.handleInput("j");
		lines = comp.render(80);
		expect(lines.find((l) => l.includes("summary text here"))).toBeDefined();
	});

	it("truncates long lines to the terminal width (no overflow crash)", () => {
		const longResult = "x".repeat(500);
		const comp = new WorkflowInspect(
			makeResult({
				steps: [
					{
						id: "big",
						type: "agent",
						status: "done",
						results: longResult,
						stats: { tokens: 10, cost: 0, durationMs: 1, agents: 1, failures: 0 },
					},
				],
			}),
			noopTui,
			() => {},
		);
		comp.handleInput("\r"); // enter is a no-op in the split layout (detail always shown)
		comp.handleInput("\r");
		const lines = comp.render(60);
		for (const line of lines) {
			// ANSI escape codes inflate the raw string length; strip them before
			// measuring visible width. A reasonable upper bound: no line's raw
			// length should wildly exceed width + a small ANSI margin.
			const visible = line.replace(/\x1b\[[0-9;]*m/g, "");
			expect(visible.length).toBeLessThanOrEqual(61);
		}
	});
});

describe("WorkflowInspect — handleInput()", () => {
	it("↓ / j moves selection down, wrapping at the end", () => {
		const comp = new WorkflowInspect(makeResult(), noopTui, () => {});
		comp.handleInput("j"); // 0 → 1
		const linesDown = comp.render(80);
		const selDown = linesDown.find((l) => l.includes("▸"));
		expect(selDown).toContain("summarize");

		comp.handleInput("j"); // 1 → 0 (wrap)
		const linesWrap = comp.render(80);
		const selWrap = linesWrap.find((l) => l.includes("▸"));
		expect(selWrap).toContain("gather");
	});

	it("↑ / k moves selection up, wrapping at the start", () => {
		const comp = new WorkflowInspect(makeResult(), noopTui, () => {});
		comp.handleInput("k"); // 0 → 1 (wrap up)
		const lines = comp.render(80);
		const sel = lines.find((l) => l.includes("▸"));
		expect(sel).toContain("summarize");
	});

	it("↓ / j switches the detail pane to the next step's results", () => {
		const comp = new WorkflowInspect(makeResult(), noopTui, () => {});
		expect(comp.render(80).join("\n")).toContain("collected 3 sources"); // gather's detail
		comp.handleInput("j");
		expect(comp.render(80).join("\n")).toContain("summary text here"); // summarize's detail
	});

	it("esc / q closes the inspector", () => {
		let closed = false;
		const comp = new WorkflowInspect(makeResult(), noopTui, () => {
			closed = true;
		});
		comp.handleInput("q");
		expect(closed).toBe(true);

		closed = false;
		comp.handleInput(""); // ESC
		expect(closed).toBe(true);
	});

	it("End→PgUp scrolls up from the bottom (Infinity sentinel is clamped)", () => {
		const longBody = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
		const comp = new WorkflowInspect(
			makeResult({
				steps: [
					{
						id: "long",
						type: "agent",
						status: "done",
						results: longBody,
						stats: { tokens: 10, cost: 0, durationMs: 1, agents: 1, failures: 0 },
					},
				],
			}),
			noopTui,
			() => {},
		);
		comp.handleInput("\u001b[F"); // End (matchesKey does not recognize the literal "end")
		comp.render(80); // clamps Infinity → maxDetailScroll
		const bottom = comp.render(80);
		expect(bottom[bottom.length - 1]).toContain("29/42"); // 40 body + 2 chrome lines − 13 vp

		comp.handleInput("\u001b[5~"); // PgUp — must NOT be swallowed by Infinity - vp
		const after = comp.render(80);
		expect(after[after.length - 1]).toContain("16/42");
	});

	it("renders every phase group's header (no dedup'd, header-less orphan rows)", () => {
		const steps = [
			{ id: "a", type: "agent" as const, status: "done" as const, results: "A", stats: { tokens: 1, cost: 0, durationMs: 1, agents: 1, failures: 0 } },
			{ id: "b", type: "agent" as const, status: "done" as const, results: "B", stats: { tokens: 1, cost: 0, durationMs: 1, agents: 1, failures: 0 } },
			{ id: "c", type: "agent" as const, status: "done" as const, results: "C", stats: { tokens: 1, cost: 0, durationMs: 1, agents: 1, failures: 0 } },
		];
		// Phase P is interrupted by default-group step b → two P groups (a | b | c).
		const comp = new WorkflowInspect(makeResult({ steps }), noopTui, () => {}, [
			{ title: "P", stepIds: ["a", "c"] },
		]);
		const lines = comp.render(80).join("\n");
		// Bold header rows only — "P" alone also appears in the footer/column header.
		expect(lines.match(/\u001b\[1mP\u001b\[0m/g) ?? []).toHaveLength(2); // both P group headers render
	});

	it("keeps the selected step visible when phase header rows shift the left pane", () => {
		const steps = Array.from({ length: 15 }, (_, i) => ({
			id: `s${i + 1}`,
			type: "agent" as const,
			status: "done" as const,
			results: `out ${i + 1}`,
			stats: { tokens: 10, cost: 0, durationMs: 1, agents: 1, failures: 0 },
		}));
		const comp = new WorkflowInspect(
			makeResult({ steps }),
			noopTui,
			() => {},
			[{ title: "Phase One", stepIds: ["s1"] }],
		);
		// 14× ↓ → select s15 (index 14). Its left-pane ROW is 15 (s1 is preceded by
		// the phase header), so a window computed from the raw index (14) would push
		// it off-screen. Regression: selection must stay visible.
		for (let i = 0; i < 14; i++) comp.handleInput("j");
		const lines = comp.render(80);
		const sel = lines.find((l) => l.includes("\u25b8"));
		expect(sel).toBeDefined();
		expect(sel).toContain("s15");
	});
});
