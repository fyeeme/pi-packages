/**
 * classify_route classifier hook — pi 0.99 `ModelRuntime.classify()` path.
 *
 * Model discovery (design D3): a step-declared `model` is honored only when it
 * resolves to a classifier-type model with working credentials; otherwise the
 * first available classifier on the host. None → `undefined` (the runner falls
 * back to the agent path). The choice question's criteria are the route names;
 * the answer is returned verbatim so undeclared categories resolve through
 * fallback sub-steps exactly like the agent path (Routing equivalence).
 */
import type { ClassifierApi, ClassifierContext, ClassifierModel, ClassifierResult } from "@earendil-works/pi-ai";
import type { ClassifyHook } from "./types.ts";

/** The registry surface the hook needs — satisfied by the extension context's
 *  ModelRegistry (pi 0.99+); tests mock this narrow slice. */
export interface ClassifierRegistrySlice {
	getAvailableOfType(type: "classifier"): Promise<readonly ClassifierModel<ClassifierApi>[]>;
	classify(model: ClassifierModel<ClassifierApi>, context: ClassifierContext): Promise<ClassifierResult>;
}

export function createClassifyHook(registry: ClassifierRegistrySlice): ClassifyHook {
	return async (prompt, routeNames, model) => {
		const available = await registry.getAvailableOfType("classifier");
		if (available.length === 0) return undefined;
		const chosen = (model ? available.find((m) => m.id === model) : undefined) ?? available[0]!;

		const result = await registry.classify(chosen, {
			state: { prompt, routes: [...routeNames] },
			questions: {
				route: {
					type: "choice",
					instructions: prompt,
					criteria: Object.fromEntries(routeNames.map((name) => [name, name])),
				},
			},
		});
		if (result.stopReason !== "stop") return undefined;
		const answer = result.answers.route;
		if (answer?.type !== "choice") return undefined;

		const u = result.usage;
		return {
			category: answer.choice,
			usage: u
				? {
						input: u.input ?? 0,
						output: u.output ?? 0,
						cacheRead: u.cacheRead ?? 0,
						cacheWrite: u.cacheWrite ?? 0,
						totalTokens: u.totalTokens ?? (u.input ?? 0) + (u.output ?? 0),
						cost: u.cost?.total ?? 0,
					}
				: undefined,
		};
	};
}
