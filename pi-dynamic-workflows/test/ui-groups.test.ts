/**
 * buildRenderGroups — the shared phase-grouping pure function used by both the
 * live progress widget and /wf-inspect (C1+D1).
 */
import { describe, expect, it } from "vitest";
import { buildRenderGroups, type PhaseDef } from "../src/ui-groups.ts";

const steps = [{ id: "gather" }, { id: "fan" }, { id: "draft" }, { id: "refine" }];
const getId = (s: { id: string }): string => s.id;

describe("buildRenderGroups", () => {
	it("returns one default group when no phases are declared (flat render)", () => {
		const groups = buildRenderGroups(steps, getId);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.kind).toBe("default");
		expect(groups[0]?.items.map((s) => s.id)).toEqual(["gather", "fan", "draft", "refine"]);
	});

	it("groups steps under phase headers in declaration order", () => {
		const phases: readonly PhaseDef[] = [
			{ title: "Research", stepIds: ["gather", "fan"] },
			{ title: "Draft", stepIds: ["draft", "refine"] },
		];
		const groups = buildRenderGroups(steps, getId, phases);
		expect(groups.map((g) => (g.kind === "phase" ? `phase:${g.title}` : "default"))).toEqual([
			"phase:Research",
			"phase:Draft",
		]);
		expect(groups[0]?.items.map((s) => s.id)).toEqual(["gather", "fan"]);
		expect(groups[1]?.items.map((s) => s.id)).toEqual(["draft", "refine"]);
	});

	it("interleaves ungrouped steps into a header-less default group at declaration order", () => {
		const phases: readonly PhaseDef[] = [{ title: "Draft", stepIds: ["draft"] }];
		const groups = buildRenderGroups(steps, getId, phases);
		// gather (default) → phase:Draft (draft) → fan, refine (default) — wait,
		// fan comes after draft in declaration order but before refine: declaration
		// order is gather, fan, draft, refine → default(gather), phase(draft) is
		// after fan, so: default[gather], default[fan]? No — fan is before draft in
		// declaration order, so it lands in the default group BEFORE the Draft phase.
		expect(groups.map((g) => (g.kind === "phase" ? `phase:${g.title}` : "default"))).toEqual([
			"default",
			"phase:Draft",
			"default",
		]);
		expect(groups[0]?.items.map((s) => s.id)).toEqual(["gather", "fan"]);
		expect(groups[1]?.items.map((s) => s.id)).toEqual(["draft"]);
		expect(groups[2]?.items.map((s) => s.id)).toEqual(["refine"]);
	});

	it("phase detail is carried on the group", () => {
		const phases: readonly PhaseDef[] = [{ title: "Research", detail: "sources", stepIds: ["gather"] }];
		const groups = buildRenderGroups(steps, getId, phases);
		expect(groups[0]?.kind).toBe("phase");
		expect(groups[0]?.title).toBe("Research");
		expect(groups[0]?.detail).toBe("sources");
	});
});
