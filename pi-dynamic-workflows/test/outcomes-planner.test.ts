import { describe, expect, it } from "vitest";
import { collect, filePathCollector, jsonCollector, urlCollector } from "../src/outcomes.ts";
import { heuristicallyPlan } from "../src/planner.ts";

describe("outcome collectors", () => {
	it("urlCollector extracts http(s) URLs", () => {
		expect(urlCollector("see https://a.com/x and http://b.io/y done")).toEqual(["https://a.com/x", "http://b.io/y"]);
		expect(urlCollector("no links here")).toBeUndefined();
	});

	it("filePathCollector extracts paths and filenames, excludes URLs", () => {
		const out = filePathCollector("edit src/index.ts and /etc/hosts and ~/repo/README.md");
		expect(out).toContain("src/index.ts");
		expect(out).toContain("/etc/hosts");
		expect(out).toContain("~/repo/README.md");
		expect(filePathCollector("https://x.com")).toBeUndefined(); // a bare URL has no path/filename match
	});

	it("jsonCollector extracts the first balanced JSON object", () => {
		expect(jsonCollector('noise {"a":1,"b":[2,3]} tail')).toEqual({ a: 1, b: [2, 3] });
		expect(jsonCollector('arr [1, "x", true]')).toEqual([1, "x", true]);
		expect(jsonCollector("no json")).toBeUndefined();
	});

	it("collect dispatches by spec kind", () => {
		expect(collect({ kind: "url" }, "go https://x.io")).toEqual(["https://x.io"]);
		expect(collect<string[]>({ kind: "file_path" }, "see src/a.ts")).toContain("src/a.ts");
		expect(collect({ kind: "json" }, '{"k":"v"}')).toEqual({ k: "v" });
	});

	it("collect honors a custom url pattern", () => {
		expect(collect({ kind: "url", pattern: /ftp:\/\/[^\s]+/g }, "ftp://h/x and https://y")).toEqual(["ftp://h/x"]);
	});
});

describe("heuristicallyPlan — keyword step-type sketch", () => {
	it("compare → tournament", () => {
		const wf = heuristicallyPlan("compare three sorting approaches");
		expect(wf.steps[0].type).toBe("tournament");
	});

	it("review → adversarial", () => {
		const wf = heuristicallyPlan("review this patch for correctness");
		expect(wf.steps[0].type).toBe("adversarial");
		const step = wf.steps[0] as unknown as { rubric: string[] };
		expect(step.rubric.length).toBeGreaterThan(0);
	});

	it("classify → classify_route with empty routes (caller fills)", () => {
		const wf = heuristicallyPlan("classify the ticket and route it");
		expect(wf.steps[0].type).toBe("classify_route");
		expect((wf.steps[0] as unknown as { routes: Record<string, unknown[]> }).routes).toEqual({});
	});

	it("default → single agent", () => {
		const wf = heuristicallyPlan("summarize this article");
		expect(wf.steps[0].type).toBe("agent");
	});

	it("produced workflow is runnable-shaped (valid StepDefinition union)", () => {
		const wf = heuristicallyPlan("evaluate the design");
		// exercises that the emitted shape matches the runner's input contract
		expect(wf.name).toBe("heuristic");
		expect(wf.steps).toHaveLength(1);
	});
});
