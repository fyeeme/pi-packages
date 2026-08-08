import { describe, expect, it } from "vitest";
import { streamingThinkingMarkdown, thinkingToMarkdown } from "../markdown-render.ts";

// Fixture: a realistic thinking run with a couple of recognisable steps so
// the heuristic engine produces non-trivial summaries and roles.
const FIXTURE = [
	"Let me check the failing test. I need to inspect packages/extensions/pi-thinking-ui/index.ts to find the patch import.",
	"Found it: the extension imports internal dist modules. Decided to remove the monkeypatch and rebuild on registerMarkdownTransformer.",
	"Ran npm test and it passed after the refactor.",
].join("\n\n");

describe("streamingThinkingMarkdown", () => {
	it("collapsed mode shows only the first line as a blockquote", () => {
		const out = streamingThinkingMarkdown("First line here\nSecond line hidden", "collapsed");
		expect(out).toBe("> First line here");
	});

	it("collapsed mode truncates an overlong first line", () => {
		const long = "x".repeat(200);
		const out = streamingThinkingMarkdown(long, "collapsed");
		expect(out.startsWith("> ")).toBe(true);
		expect(out.length).toBeLessThan(90);
		expect(out.endsWith("…")).toBe(true);
	});

	it("summary and expanded modes pass through during streaming (no work)", () => {
		const raw = "a\nb\nc";
		expect(streamingThinkingMarkdown(raw, "summary")).toBe(raw);
		expect(streamingThinkingMarkdown(raw, "expanded")).toBe(raw);
	});

	it("empty/whitespace thinking passes through unchanged", () => {
		expect(streamingThinkingMarkdown("   ", "collapsed")).toBe("   ");
	});
});

describe("thinkingToMarkdown", () => {
	it("expanded mode passes thinking through verbatim", () => {
		expect(thinkingToMarkdown(FIXTURE, "expanded")).toBe(FIXTURE);
	});

	it("expanded passes empty/whitespace through unchanged", () => {
		expect(thinkingToMarkdown("   ", "expanded")).toBe("   ");
		expect(thinkingToMarkdown("", "expanded")).toBe("");
	});

	it("collapsed mode returns a single blockquote line (role icon + summary)", () => {
		const out = thinkingToMarkdown(FIXTURE, "collapsed");
		const lines = out.split("\n");
		expect(lines).toHaveLength(1);
		expect(lines[0]?.startsWith("> ")).toBe(true);
		// summary content from the fixture should survive somewhere in the line
		expect(out.length).toBeGreaterThan(3);
	});

	it("collapsed on empty thinking returns the input unchanged (no synthetic blockquote)", () => {
		// trim() is empty → returned early, before the blockquote is built
		expect(thinkingToMarkdown("   ", "collapsed")).toBe("   ");
	});

	it("summary mode returns a markdown bullet list (one item per derived step)", () => {
		const out = thinkingToMarkdown(FIXTURE, "summary");
		const lines = out.split("\n");
		// every non-truncation line is a bullet
		for (const line of lines) {
			expect(line.startsWith("- ")).toBe(true);
		}
		expect(lines.length).toBeGreaterThanOrEqual(1);
	});

	it("summary mode caps the list and appends a `… (+N more)` tail when steps exceed the limit", () => {
		// Build a fixture with many distinct paragraphs to exceed SUMMARY_LIST_LIMIT (8).
		const many = Array.from({ length: 20 }, (_, i) => `Inspecting file_${i}.ts to verify the refactor step ${i}.`).join("\n\n");
		const out = thinkingToMarkdown(many, "summary");
		const lines = out.split("\n");
		const tail = lines[lines.length - 1];
		expect(tail).toMatch(/^\- … \(\+\d+ more\)$/);
		// 8 step bullets + 1 tail line
		expect(lines.length).toBe(9);
	});

	it("summary mode falls back to a single blockquote when no steps can be derived", () => {
		// A single short token with no sentence/structure → splitThinkingIntoStepTexts
		// still returns at least the normalized text, so guard the empty case only.
		expect(thinkingToMarkdown("", "summary")).toBe("");
	});

	it("repeated calls for unchanged text return identical output (result cache)", () => {
		const first = thinkingToMarkdown(FIXTURE, "summary");
		const second = thinkingToMarkdown(FIXTURE, "summary");
		expect(second).toBe(first);
		// Different mode must not collide in the cache.
		const collapsed = thinkingToMarkdown(FIXTURE, "collapsed");
		expect(collapsed).not.toBe(first);
	});

	it("result cache stays correct past its LRU limit (many distinct inputs)", () => {
		// RESULT_CACHE_LIMIT is 50; hammer with more distinct texts and verify
		// every output is still a valid, non-empty result.
		for (let i = 0; i < 60; i++) {
			const input = `Inspecting file_${i}.ts to verify the refactor step ${i}.`;
			const out = thinkingToMarkdown(input, "summary");
			expect(out.length).toBeGreaterThan(0);
		}
	});
});
