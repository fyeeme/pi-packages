/**
 * Seed library workflow: review-local-diff — the local-diff review pipeline
 * actually run in this repository (distilled from the .pi/workflows journals
 * of review-local-changes / review-local-extensions-fanout runs).
 *
 * Input: the unified diff to review (run input). Fan out one finder per
 * angle (parallelism 4), adversarially verify a merged candidate list, and
 * return the verified findings. Budget and parallelism are declared here as
 * data — the engine enforces them.
 *
 * Prompts reference run context via prompt FUNCTIONS (ctx.input /
 * ctx.step(id)) — the {{...}} template tokens are the inline-JSON tool
 * surface only; the TS API never substitutes them in plain strings.
 *
 * Runtime-single-file: `import type` is erased at load, so nothing outside
 * this file executes and the ast determinism guard's entry-only scan covers
 * everything that runs (a VALUE import from another file would not be
 * scanned — keep imports type-only).
 */
import type { WorkflowDefinition } from "../src/index.ts";

const ANGLES = ["correctness", "reuse", "simplification", "efficiency", "altitude"] as const;

export const workflow: WorkflowDefinition = {
	name: "review-local-diff",
	description: "Fan out diff-scoped finders, adversarially verify the merged candidates, return verified findings",
	budget: { maxAgents: 12, maxTokens: 2_000_000 },
	steps: [
		{
			id: "finders",
			type: "fan_out",
			over: () => [...ANGLES],
			parallelism: 4,
			agent: (angle, _index, ctx) => ({
				prompt:
					`You are a code-review finder for the "${angle}" angle. Review the diff below. ` +
					`Report each finding as \`file:line\` — one-line summary — the concrete cost ` +
					`(for correctness: the input/state that triggers it → wrong output). Report only; ` +
					`an empty list is a valid answer.\n\nDiff:\n${ctx.input}`,
			}),
			merge: (results) => results.join("\n---\n"),
		},
		{
			id: "verify",
			type: "adversarial",
			produce: {
				prompt: (ctx) =>
					"Dedup and merge these code-review findings into a numbered candidate list " +
					"(same defect + same location + same reason → keep one; different reasons for " +
					"the same line are NOT duplicates — keep both). Return only the numbered list.\n\n" +
					String(ctx.step("finders").results),
			},
			rubric: [
				"finding is concretely actionable (file:line present)",
				"the failure scenario or cost is stated and realistic",
				"not a duplicate of another kept finding",
			],
			judges: 3,
			minPass: 2,
		},
	],
};

export default workflow;
