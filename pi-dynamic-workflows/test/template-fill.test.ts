/**
 * Template interpolation tests — single-pass `fill()` (cluster A of
 * harden-workflow-edges). Guards the injection class proven by review M2:
 * substituted values must be opaque, so a literal {{...}} inside input/item/
 * step results is emitted verbatim and never re-evaluated.
 */
import { describe, expect, it } from "vitest";
import { fill } from "../index.ts";
import { WorkflowError } from "../src/errors.ts";
import type { StepContext, StepStats } from "../src/types.ts";

const zero: StepStats = { tokens: 0, cost: 0, durationMs: 0, agents: 0, failures: 0 };

/** Minimal StepContext stub: input + a map of completed step results. */
function ctx(input: unknown, steps: Record<string, unknown> = {}): StepContext {
	return {
		input,
		step(id: string) {
			if (!(id in steps)) throw new Error(`step "${id}" has not executed yet (or does not exist)`);
			return { results: steps[id], stats: zero };
		},
	};
}

/** Capture a thrown value as a WorkflowError (or rethrow if nothing threw). */
function thrown(fn: () => void): unknown {
	try {
		fn();
	} catch (e) {
		return e;
	}
	throw new Error("expected fill() to throw");
}

describe("fill — single-pass template interpolation", () => {
	it("resolves {{input}}", () => {
		expect(fill("Summarize: {{input}}", "agent", ctx("hello"), undefined, "s")).toBe("Summarize: hello");
	});

	it("resolves {{step.<id>}} from a prior step result", () => {
		expect(fill("Review: {{step.extract}}", "agent", ctx("x", { extract: ["a", "b"] }), undefined, "s")).toBe(
			'Review: ["a","b"]',
		);
	});

	it("stringifies object step results", () => {
		expect(fill("{{step.o}}", "agent", ctx("x", { o: { a: 1 } }), undefined, "s")).toBe('{"a":1}');
	});

	it("does NOT re-evaluate {{...}} inside input (injection guard)", () => {
		// The headline M2 fix: input containing a token-like sequence is opaque.
		expect(fill("echo: {{input}}", "agent", ctx("see {{step.x}}"), undefined, "s")).toBe("echo: see {{step.x}}");
	});

	it("does NOT re-evaluate {{...}} inside a step result", () => {
		expect(fill("{{step.a}}", "agent", ctx("x", { a: "{{input}}" }), undefined, "s")).toBe("{{input}}");
	});

	it("does NOT re-evaluate {{...}} inside an item value", () => {
		expect(fill("{{item}}", "fanout-item", ctx("x"), "v={{input}}", "s")).toBe("v={{input}}");
	});

	it("resolves both {{input}} and {{item}} in a fan-out item prompt", () => {
		expect(fill("ctx={{input}} item={{item}}", "fanout-item", ctx("root"), "a", "fan")).toBe("ctx=root item=a");
	});

	it("emits multiple tokens and surrounding literal text in one pass", () => {
		expect(fill("[{{input}}]+{{step.a}}!", "agent", ctx("in", { a: 7 }), undefined, "s")).toBe("[in]+7!");
	});

	it("{{item}} outside a fan-out item prompt fails categorized", () => {
		const e = thrown(() => fill("{{item}}", "agent", ctx("x"), undefined, "s"));
		expect(e).toBeInstanceOf(WorkflowError);
		expect((e as WorkflowError).category).toBe("compile");
	});

	it("{{step.<id>}} inside a fan-out item prompt fails categorized naming the token", () => {
		const e = thrown(() => fill("{{step.x}}", "fanout-item", ctx("x", { x: 1 }), "a", "fan"));
		expect(e).toBeInstanceOf(WorkflowError);
		expect((e as WorkflowError).category).toBe("compile");
		expect((e as WorkflowError).message).toContain("{{step.x}}");
		expect((e as WorkflowError).message).toContain('"fan"'); // names the referencing step
	});

	it("unknown step reference fails categorized naming the token", () => {
		const e = thrown(() => fill("{{step.missing}}", "agent", ctx("x"), undefined, "s"));
		expect(e).toBeInstanceOf(WorkflowError);
		expect((e as WorkflowError).category).toBe("compile");
		expect((e as WorkflowError).message).toContain("{{step.missing}}");
	});

	it("unknown token fails categorized", () => {
		const e = thrown(() => fill("{{foo}}", "agent", ctx("x"), undefined, "s"));
		expect(e).toBeInstanceOf(WorkflowError);
		expect((e as WorkflowError).category).toBe("compile");
	});

	it("a prompt with no tokens is returned unchanged", () => {
		expect(fill("plain prompt", "agent", ctx("x"), undefined, "s")).toBe("plain prompt");
	});
});
