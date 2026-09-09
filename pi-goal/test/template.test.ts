/**
 * pi-goal — template renderer tests.
 *
 * The renderer replaces omp `prompt.render` for the goal prompt templates; it
 * must support exactly the constructs those templates use and nothing more.
 */

import { describe, expect, it } from "vitest";
import { escapeXmlText, renderTemplate } from "../src/template.ts";

describe("renderTemplate", () => {
	it("interpolates variables", () => {
		expect(renderTemplate("Hello {{name}}, {{count}}!", { name: "world", count: "3" })).toBe("Hello world, 3!");
	});

	it("renders unknown variables as empty strings", () => {
		expect(renderTemplate("a{{missing}}b", {})).toBe("ab");
	});

	it("supports if with a truthy condition", () => {
		expect(renderTemplate("A{{#if flag}}yes{{/if}}B", { flag: "x" })).toBe("AyesB");
	});

	it("supports if with a falsy condition", () => {
		expect(renderTemplate("A{{#if flag}}yes{{/if}}B", { flag: "" })).toBe("AB");
		expect(renderTemplate("A{{#if flag}}yes{{/if}}B", {})).toBe("AB");
	});

	it("supports else branches", () => {
		const template = "{{#if todoContext}}[{{todoContext}}]{{/if}}";
		expect(renderTemplate(template, { todoContext: "T" })).toBe("[T]");
		expect(renderTemplate(template, {})).toBe("");
	});

	it("renders the goal-mode-context template shape (if with newline body)", () => {
		const template = "{{goalContext}}\n{{#if todoContext}}\n{{todoContext}}\n{{/if}}";
		// omp prompt.render emits the same blank line between the two blocks.
		expect(renderTemplate(template, { goalContext: "G", todoContext: "T" })).toBe("G\n\nT\n");
		expect(renderTemplate(template, { goalContext: "G" })).toBe("G\n");
	});

	it("iterates each with item field shadowing", () => {
		const template = "{{#each phases}}- {{name}}:\n{{#each tasks}}  - [{{status}}] {{content}}\n{{/each}}{{/each}}";
		const out = renderTemplate(template, {
			phases: [
				{
					name: "P1",
					tasks: [
						{ status: "done", content: "a" },
						{ status: "open", content: "b" },
					],
				},
				{ name: "P2", tasks: [{ status: "open", content: "c" }] },
			],
		});
		expect(out).toBe("- P1:\n  - [done] a\n  - [open] b\n- P2:\n  - [open] c\n");
	});

	it("renders {{#if initial}}...{{else}}...{{/if}} like the guided-goal template", () => {
		const template =
			"{{#if initial}}\n<rough-goal>\n{{initial}}\n</rough-goal>\n{{else}}\nNo objective stated.\n{{/if}}";
		expect(renderTemplate(template, { initial: "build a birdhouse" })).toBe(
			"\n<rough-goal>\nbuild a birdhouse\n</rough-goal>\n",
		);
		expect(renderTemplate(template, {})).toBe("\nNo objective stated.\n");
	});

	it("skips each over non-array values", () => {
		expect(renderTemplate("a{{#each items}}x{{/each}}b", { items: "nope" })).toBe("ab");
		expect(renderTemplate("a{{#each items}}x{{/each}}b", {})).toBe("ab");
	});

	it("throws on unclosed blocks and stray closers", () => {
		expect(() => renderTemplate("{{#if flag}}oops", { flag: 1 })).toThrow();
		expect(() => renderTemplate("{{/if}}", {})).toThrow();
	});

	it("caches parses (same template rendered twice)", () => {
		const template = "{{#if x}}y{{/if}}";
		expect(renderTemplate(template, { x: 1 })).toBe("y");
		expect(renderTemplate(template, {})).toBe("");
	});
});

describe("escapeXmlText", () => {
	it("escapes the XML-significant trio and leaves quotes verbatim (omp semantics)", () => {
		expect(escapeXmlText(`&<>'"`)).toBe("&amp;&lt;&gt;'\"");
	});
});
