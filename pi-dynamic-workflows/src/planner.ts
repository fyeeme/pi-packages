/**
 * Heuristic planner — a keyword sketch that turns a natural-language goal into
 * a WorkflowDefinition by picking a step type from cues in the text.
 *
 * @deprecated This is an EXPERIMENTAL heuristic scaffold, not a real planner.
 *   Freeform NL → full workflow (with real fan-out items, route branches,
 *   rubrics) needs an LLM and is non-deterministic, which this deterministic
 *   engine deliberately avoids. The keyword match only decides the step SHAPE;
 *   structural fields the keywords cannot infer (route tables, fan-out item
 *   lists) are left as defaults the caller refines. Think of the output as a
 *   scaffold to edit, not a finished plan. May be removed or replaced in a
 *   future version once a proper LLM-based planner is available.
 */
import type { StepDefinition, WorkflowDefinition } from "./types.ts";

export interface HeuristicPlanOptions {
	/** Candidates for the tournament heuristic. Default 3. */
	readonly tournamentCandidates?: number;
	/** Judges for the tournament/adversarial heuristics. Default 3. */
	readonly judges?: number;
}

/**
 * Map a goal string to a single-step workflow by keyword:
 *   - compare/versus/best-of → tournament (N candidates, M judges)
 *   - review/judge/critique  → adversarial (produce + judges, default rubric)
 *   - classify/categorize/route → classify_route (empty routes — caller fills)
 *   - otherwise              → single agent
 *
 * @deprecated See module-level deprecation notice. This is an experimental
 *   heuristic that produces a scaffold to edit, not a finished workflow.
 */
export function heuristicallyPlan(goal: string, opts: HeuristicPlanOptions = {}): WorkflowDefinition {
	const g = goal.toLowerCase();
	const judges = opts.judges ?? 3;

	let primary: StepDefinition;
	if (/\b(compare|versus|vs\.?|best of|competing)\b/.test(g)) {
		primary = {
			id: "tournament",
			type: "tournament",
			candidates: opts.tournamentCandidates ?? 3,
			judges,
			produce: { prompt: goal },
		};
	} else if (/\b(review|judge|critique|adversarial|evaluate)\b/.test(g)) {
		primary = {
			id: "adversarial",
			type: "adversarial",
			produce: { prompt: goal },
			rubric: ["correctness", "clarity", "completeness"],
			judges,
		};
	} else if (/\b(classify|categor|route|dispatch)\b/.test(g)) {
		primary = {
			id: "classify",
			type: "classify_route",
			classifier: { prompt: goal },
			routes: {}, // keywords can't infer the route table — caller fills it in
		};
	} else {
		primary = { id: "agent", type: "agent", prompt: goal };
	}

	return { name: "heuristic", steps: [primary] };
}
