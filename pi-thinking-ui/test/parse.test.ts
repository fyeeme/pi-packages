import { describe, expect, it } from "vitest";
import {
	deriveStepCore,
	deriveThinkingUI,
	iconForThinkingRole,
	inferThinkingRole,
	parseThinkingMode,
	splitThinkingIntoStepTexts,
	summarizeThinkingText,
} from "../parse.ts";

// ---------------------------------------------------------------------------
// parseThinkingMode
// ---------------------------------------------------------------------------

describe("parseThinkingMode", () => {
	it("maps canonical names", () => {
		expect(parseThinkingMode("collapsed")).toBe("collapsed");
		expect(parseThinkingMode("summary")).toBe("summary");
		expect(parseThinkingMode("expanded")).toBe("expanded");
	});

	it("maps aliases", () => {
		expect(parseThinkingMode("collapse")).toBe("collapsed");
		expect(parseThinkingMode("c")).toBe("collapsed");
		expect(parseThinkingMode("summaries")).toBe("summary");
		expect(parseThinkingMode("s")).toBe("summary");
		expect(parseThinkingMode("expand")).toBe("expanded");
		expect(parseThinkingMode("full")).toBe("expanded");
		expect(parseThinkingMode("e")).toBe("expanded");
	});

	it("is case-insensitive and trims whitespace", () => {
		expect(parseThinkingMode("  SUMMARY  ")).toBe("summary");
		expect(parseThinkingMode("Collapsed")).toBe("collapsed");
	});

	it("returns undefined for empty or unknown input", () => {
		expect(parseThinkingMode("")).toBeUndefined();
		expect(parseThinkingMode("   ")).toBeUndefined();
		expect(parseThinkingMode("xyz")).toBeUndefined();
		expect(parseThinkingMode("explode")).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// iconForThinkingRole
// ---------------------------------------------------------------------------

describe("iconForThinkingRole", () => {
	it("returns a distinct glyph per known role", () => {
		const icons = {
			inspect: iconForThinkingRole("inspect"),
			plan: iconForThinkingRole("plan"),
			compare: iconForThinkingRole("compare"),
			verify: iconForThinkingRole("verify"),
			write: iconForThinkingRole("write"),
			search: iconForThinkingRole("search"),
			error: iconForThinkingRole("error"),
			default: iconForThinkingRole("default"),
		};
		expect(new Set(Object.values(icons)).size).toBe(8);
	});

	it("returns the default glyph for the default role", () => {
		expect(iconForThinkingRole("default")).toBe("·");
	});
});

// ---------------------------------------------------------------------------
// inferThinkingRole
// ---------------------------------------------------------------------------

describe("inferThinkingRole", () => {
	it("detects error role from failure/stack-trace cues", () => {
		expect(inferThinkingRole("I need to fix the error in the stack trace")).toBe("error");
		expect(inferThinkingRole("the build failed and threw an exception")).toBe("error");
	});

	it("detects verify role from test/validate cues", () => {
		expect(inferThinkingRole("run the tests to verify it works")).toBe("verify");
		expect(inferThinkingRole("validate the output")).toBe("verify");
	});

	it("detects compare role", () => {
		expect(inferThinkingRole("compare option A versus option B")).toBe("compare");
		expect(inferThinkingRole("trade-off between the two approaches")).toBe("compare");
	});

	it("detects search role", () => {
		expect(inferThinkingRole("grep and find the symbol")).toBe("search");
		expect(inferThinkingRole("locate the definition")).toBe("search");
	});

	it("detects write role", () => {
		expect(inferThinkingRole("implement the new function and edit the file")).toBe("write");
		expect(inferThinkingRole("refactor the module")).toBe("write");
	});

	it("detects plan role", () => {
		expect(inferThinkingRole("plan the approach and strategy")).toBe("plan");
	});

	it("falls back to default when no cue matches", () => {
		expect(inferThinkingRole("hello world foo bar")).toBe("default");
	});
});

// ---------------------------------------------------------------------------
// splitThinkingIntoStepTexts
// ---------------------------------------------------------------------------

describe("splitThinkingIntoStepTexts", () => {
	it("returns [] for empty input", () => {
		expect(splitThinkingIntoStepTexts("")).toEqual([]);
		expect(splitThinkingIntoStepTexts("   ")).toEqual([]);
	});

	it("returns a single step for non-paragraph text", () => {
		expect(splitThinkingIntoStepTexts("single line")).toEqual(["single line"]);
	});

	it("splits on double newlines into paragraphs", () => {
		expect(splitThinkingIntoStepTexts("a\n\nb\n\nc")).toEqual(["a", "b", "c"]);
	});

	it("trims whitespace around chunks", () => {
		expect(splitThinkingIntoStepTexts("\n\n  a  \n\n\n b \n\n")).toEqual(["a", "b"]);
	});

	it("splits list paragraphs into individual items", () => {
		const out = splitThinkingIntoStepTexts("First step.\n\n- item one\n- item two\n- item three");
		expect(out.length).toBe(4);
		expect(out[1]).toContain("item one");
		expect(out[2]).toContain("item two");
		expect(out[3]).toContain("item three");
	});
});

// ---------------------------------------------------------------------------
// summarizeThinkingText
// ---------------------------------------------------------------------------

describe("summarizeThinkingText", () => {
	it("returns the fallback for empty input", () => {
		expect(summarizeThinkingText("")).toBe("Reasoning is hidden by the provider.");
	});

	it("honors a custom fallback", () => {
		expect(summarizeThinkingText("", "Nothing to show.")).toBe("Nothing to show.");
	});

	it("produces a concise, capitalized summary ending in punctuation", () => {
		const summary = summarizeThinkingText(
			"I need to read packages/foo.ts and inspect the bar() function before editing.",
		);
		expect(summary.length).toBeLessThanOrEqual(84);
		expect(summary.endsWith(".")).toBe(true);
		expect(summary).toContain("packages/foo.ts");
	});

	it("surfaces explicit failures", () => {
		const summary = summarizeThinkingText("The npm test failed with exit code 1.");
		expect(summary.toLowerCase()).toContain("failed");
		expect(summary.endsWith(".")).toBe(true);
	});

	it("truncates long output to the summary budget", () => {
		const long = "I will now ".repeat(50) + "do something.";
		const summary = summarizeThinkingText(long);
		expect(summary.length).toBeLessThanOrEqual(84);
	});
});

// ---------------------------------------------------------------------------
// deriveThinkingUI
// ---------------------------------------------------------------------------

describe("deriveThinkingUI", () => {
	it("returns [] for no blocks", () => {
		expect(deriveThinkingUI([])).toEqual([]);
	});

	it("produces a single fallback step for a redacted block with no text", () => {
		const steps = deriveThinkingUI([{ contentIndex: 0, text: "", redacted: true }]);
		expect(steps).toHaveLength(1);
		const step = steps[0]!;
		expect(step.id).toBe("0-0");
		expect(step.contentIndex).toBe(0);
		expect(step.blockIndex).toBe(0);
		expect(step.stepIndex).toBe(0);
		expect(step.summary).toBe("Reasoning is hidden by the provider.");
		expect(step.role).toBe("default");
		expect(step.hasExplicitFailure).toBe(false);
	});

	it("splits visible text into steps with stable ids and icons", () => {
		const steps = deriveThinkingUI([
			{ contentIndex: 2, text: "I need to read packages/foo.ts.\n\nI will verify the tests pass." },
		]);
		expect(steps.length).toBeGreaterThanOrEqual(2);
		for (const [index, step] of steps.entries()) {
			expect(step.id).toBe(`2-${index}`);
			expect(step.contentIndex).toBe(2);
			expect(step.blockIndex).toBe(0);
			expect(step.stepIndex).toBe(index);
			expect(step.icon).toBeTruthy();
			expect(step.summary.endsWith(".")).toBe(true);
		}
	});

	it("carries baseline/challenger summaries and event metadata", () => {
		const steps = deriveThinkingUI([
			{ contentIndex: 0, text: "The npm test failed with exit code 1." },
		]);
		const step = steps[0]!;
		expect(typeof step.baselineSummary).toBe("string");
		expect(typeof step.challengerSummary).toBe("string");
		expect(Array.isArray(step.summaryEvents)).toBe(true);
		expect(typeof step.collapsedPriority).toBe("number");
	});
});

// ---------------------------------------------------------------------------
// deriveStepCore + caching resolver contract
// ---------------------------------------------------------------------------

describe("deriveStepCore + caching resolver", () => {
	const BLOCKS = [
		{ contentIndex: 0, text: "I need to read packages/foo.ts.\n\nThe npm test failed with exit code 1." },
	];

	it("is a pure function: identical input yields identical output", () => {
		const a = deriveStepCore("I need to read packages/foo.ts.");
		const b = deriveStepCore("I need to read packages/foo.ts.");
		expect(a).toEqual(b);
	});

	it("a caching resolver produces identical steps to the default resolver", () => {
		const cache = new Map<string, ReturnType<typeof deriveStepCore>>();
		const cachingResolver = (stepText: string) => {
			const cached = cache.get(stepText);
			if (cached) return cached;
			const core = deriveStepCore(stepText);
			cache.set(stepText, core);
			return core;
		};

		const cached = deriveThinkingUI(BLOCKS, cachingResolver);
		const fresh = deriveThinkingUI(BLOCKS);

		expect(cached).toEqual(fresh);
	});

	it("a caching resolver avoids recomputation for identical step texts", () => {
		const cache = new Map<string, ReturnType<typeof deriveStepCore>>();
		let computeCalls = 0;
		const cachingResolver = (stepText: string) => {
			const cached = cache.get(stepText);
			if (cached) return cached;
			computeCalls += 1;
			const core = deriveStepCore(stepText);
			cache.set(stepText, core);
			return core;
		};

		const first = deriveThinkingUI(BLOCKS, cachingResolver);
		const firstCalls = computeCalls;
		const second = deriveThinkingUI(BLOCKS, cachingResolver);

		// Without content-addressed caching, calls would double.
		expect(second).toEqual(first);
		expect(computeCalls).toBe(firstCalls);
	});
});
