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
const noopTui = { requestRender(): void {} };

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
		const lines = comp.render(80).filter((l) => l.includes("gather") || l.includes("summarize"));
		expect(lines).toHaveLength(2);
		// Order preserved.
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
		const errLine = lines.find((l) => l.includes("error:"));
		expect(errLine).toBeDefined();
		expect(errLine).toContain('step "gather" failed');
	});

	it("expands the selected step's real result body on detail toggle", () => {
		const comp = new WorkflowInspect(makeResult(), noopTui, () => {});
		// Toggle detail on the first step (selected=0 by default).
		comp.handleInput("\r");
		const lines = comp.render(80);

		// The detail body must show the real results string, not "${...}".
		const bodyLine = lines.find((l) => l.includes("collected 3 sources"));
		expect(bodyLine).toBeDefined();
		for (const line of lines) {
			expect(line).not.toContain("${");
		}
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
		comp.handleInput("\r"); // expand detail
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

	it("enter toggles detail visibility", () => {
		const comp = new WorkflowInspect(makeResult(), noopTui, () => {});
		const before = comp.render(80).join("\n");
		comp.handleInput("\r");
		const after = comp.render(80).join("\n");
		// Detail adds the results body line.
		expect(after).toContain("collected 3 sources");
		expect(before).not.toContain("collected 3 sources");
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
});
