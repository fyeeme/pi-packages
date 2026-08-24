/**
 * Seed library workflow: review-extension — the extensions-submodule review
 * fan-out distilled from this repository's review-local-extensions-fanout
 * pipeline: scope the changed packages first, then one reviewer per changed
 * extension directory (parallelism 3), then merge.
 *
 * Input: newline-separated list of changed paths under packages/extensions
 * (or a single path). Prompts use prompt functions (ctx.input /
 * ctx.step(id)) — the TS API does not substitute {{...}} tokens.
 * Runtime-single-file: `import type` is erased at load (see
 * review-local-diff.ts).
 */
import type { WorkflowDefinition } from "../src/index.ts";

export const workflow: WorkflowDefinition = {
	name: "review-extension",
	description: "Review each changed extension package: one reviewer per package (parallelism 3), merged findings",
	budget: { maxAgents: 9, maxTokens: 2_000_000 },
	steps: [
		{
			id: "scope",
			type: "agent",
			prompt: (ctx) =>
				"The input lists changed paths under packages/extensions. Reduce it to the set of " +
				"distinct top-level extension directories (e.g. \"pi-review\", \"pi-subagents\"). " +
				"Return ONLY the directory names, one per line, no commentary.\n\n" +
				String(ctx.input),
		},
		{
			id: "reviewers",
			type: "fan_out",
			over: (ctx) =>
				String(ctx.step("scope").results)
					.split("\n")
					.map((l) => l.trim())
					.filter(Boolean),
			parallelism: 3,
			agent: (pkg, _index, ctx) => ({
				prompt:
					`Review the uncommitted changes in packages/extensions/${pkg} (run ` +
					`\`git -C packages/extensions/${pkg} diff\` yourself; read the touched files for ` +
					`context). Report findings as \`file:line\` — one-line summary — the concrete cost. ` +
					`Cover correctness, reuse, simplification, efficiency, altitude. Report only.\n\n` +
					`Changed paths:\n${ctx.input}`,
			}),
			merge: (results) => results.join("\n---\n"),
		},
	],
};

export default workflow;
