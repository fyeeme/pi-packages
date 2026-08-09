/**
 * Shared phase-grouping logic (C1+D1) — used by the live progress widget
 * (index.ts) and the `/wf-inspect` view (src/inspect.ts) so both render with
 * identical grouping. Extracted as a pure function so it is unit-testable.
 *
 * Declared phases carry a header; ungrouped items collect into a header-less
 * default group interleaved at declaration order. When no phases are declared
 * (or none match), the whole item list is one default group (flat render).
 */

export interface PhaseDef {
	readonly title: string;
	readonly detail?: string;
	readonly stepIds: readonly string[];
}

export interface RenderGroup<T> {
	readonly kind: "phase" | "default";
	readonly title?: string;
	readonly detail?: string;
	readonly items: T[];
}

export function buildRenderGroups<T>(
	items: readonly T[],
	getId: (item: T) => string,
	phases?: readonly PhaseDef[],
): RenderGroup<T>[] {
	const stepPhase = new Map<string, { title: string; detail?: string }>();
	if (phases && phases.length > 0) {
		for (const ph of phases) for (const sid of ph.stepIds) stepPhase.set(sid, { title: ph.title, detail: ph.detail });
	}
	const groups: RenderGroup<T>[] = [];
	for (const item of items) {
		const ph = stepPhase.get(getId(item));
		const key = ph ? `phase:${ph.title}` : "default";
		const last = groups[groups.length - 1];
		const lastKey = last ? (last.kind === "phase" ? `phase:${last.title}` : "default") : "";
		if (last && lastKey === key) last.items.push(item);
		else groups.push(ph ? { kind: "phase", title: ph.title, detail: ph.detail, items: [item] } : { kind: "default", items: [item] });
	}
	return groups;
}
