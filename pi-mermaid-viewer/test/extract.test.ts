import { describe, expect, it } from "vitest";
import { extractMermaidBlocks, labelBlocks } from "../index.ts";
import type { MermaidBlock } from "../index.ts";
import {
	assistantMessage,
	customEntry,
	imageContentBlock,
	messageEntry,
	mockCtx,
	textContentBlock,
	userMessage,
} from "./helpers.ts";

describe("extractMermaidBlocks", () => {
	it("returns empty array when no entries", () => {
		expect(extractMermaidBlocks(mockCtx([]))).toEqual([]);
	});

	it("returns empty array when no mermaid blocks in messages", () => {
		const ctx = mockCtx([messageEntry(assistantMessage([textContentBlock("plain text")]))]);
		expect(extractMermaidBlocks(ctx)).toEqual([]);
	});

	it("ignores non-message entries", () => {
		const ctx = mockCtx([customEntry("some-type", { key: "val" })]);
		expect(extractMermaidBlocks(ctx)).toEqual([]);
	});

	it("ignores user messages", () => {
		const ctx = mockCtx([messageEntry(userMessage("```mermaid\ngraph TD\n  A --> B\n```"))]);
		expect(extractMermaidBlocks(ctx)).toEqual([]);
	});

	it("ignores code blocks that are not mermaid", () => {
		const ctx = mockCtx([messageEntry(assistantMessage([textContentBlock("```typescript\nconst x = 1;\n```")]))]);
		expect(extractMermaidBlocks(ctx)).toEqual([]);
	});

	it("extracts a single mermaid block", () => {
		const ctx = mockCtx([
			messageEntry(assistantMessage([textContentBlock("```mermaid\ngraph TD\n  A --> B\n```")])),
		]);
		const blocks = extractMermaidBlocks(ctx);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].raw).toBe("graph TD\n  A --> B");
		expect(blocks[0].label).toBe("Diagram 1");
	});

	it("extracts a block when the fence has trailing spaces after the language", () => {
		// The fence regex is /```mermaid\s*\n/ — trailing blanks between the
		// language and the newline must still match.
		const ctx = mockCtx([messageEntry(assistantMessage([textContentBlock("```mermaid   \nA --> B\n```")]))]);
		const blocks = extractMermaidBlocks(ctx);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].raw).toBe("A --> B");
	});

	it("extracts multiple blocks from one message", () => {
		const ctx = mockCtx([
			messageEntry(
				assistantMessage([
					textContentBlock(
						"```mermaid\ngraph TD\n  A --> B\n```\n\n```mermaid\nsequenceDiagram\n  A ->> B\n```",
					),
				]),
			),
		]);
		const blocks = extractMermaidBlocks(ctx);
		expect(blocks).toHaveLength(2);
		expect(blocks[0].raw).toBe("graph TD\n  A --> B");
		expect(blocks[1].raw).toBe("sequenceDiagram\n  A ->> B");
	});

	it("extracts blocks from multiple messages", () => {
		const ctx = mockCtx([
			messageEntry(assistantMessage([textContentBlock("```mermaid\nA --> B\n```")])),
			messageEntry(assistantMessage([textContentBlock("```mermaid\nC --> D\n```")])),
		]);
		const blocks = extractMermaidBlocks(ctx);
		expect(blocks).toHaveLength(2);
		expect(blocks[0].raw).toBe("A --> B");
		expect(blocks[1].raw).toBe("C --> D");
	});

	it("numbers diagrams incrementally across messages", () => {
		const ctx = mockCtx([
			messageEntry(assistantMessage([textContentBlock("```mermaid\nA --> B\n```")])),
			messageEntry(assistantMessage([textContentBlock("```mermaid\nC --> D\n```")])),
		]);
		const blocks = extractMermaidBlocks(ctx);
		expect(blocks).toHaveLength(2);
		expect(blocks[0].label).toBe("Diagram 1");
		expect(blocks[1].label).toBe("Diagram 2");
	});

	it("skips non-text content blocks (images)", () => {
		const ctx = mockCtx([
			messageEntry(assistantMessage([imageContentBlock(), textContentBlock("```mermaid\nA --> B\n```")])),
		]);
		const blocks = extractMermaidBlocks(ctx);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].raw).toBe("A --> B");
	});

	it("trims surrounding whitespace from the block body", () => {
		const ctx = mockCtx([
			messageEntry(
				assistantMessage([textContentBlock("Some text\n```mermaid\n  A --> B  \n```\nMore text")]),
			),
		]);
		const blocks = extractMermaidBlocks(ctx);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].raw).toBe("A --> B");
	});
});

describe("labelBlocks", () => {
	it("labels a single block as 'Diagram'", () => {
		const blocks: MermaidBlock[] = [{ raw: "A --> B", label: "original" }];
		labelBlocks(blocks);
		expect(blocks[0].label).toBe("Diagram");
	});

	it("labels two blocks with latest marker on first", () => {
		const blocks: MermaidBlock[] = [
			{ raw: "older", label: "x" },
			{ raw: "newer", label: "y" },
		];
		labelBlocks(blocks);
		expect(blocks).toHaveLength(2);
		expect(blocks[0].label).toBe("#2 (latest)");
		expect(blocks[1].label).toBe("#1");
	});

	it("labels three blocks correctly", () => {
		const blocks: MermaidBlock[] = [
			{ raw: "a", label: "x" },
			{ raw: "b", label: "y" },
			{ raw: "c", label: "z" },
		];
		labelBlocks(blocks);
		expect(blocks[0].label).toBe("#3 (latest)");
		expect(blocks[1].label).toBe("#2");
		expect(blocks[2].label).toBe("#1");
	});

	it("reverses the blocks array in place", () => {
		const blocks: MermaidBlock[] = [
			{ raw: "first", label: "x" },
			{ raw: "second", label: "y" },
			{ raw: "third", label: "z" },
		];
		labelBlocks(blocks);
		expect(blocks[0].raw).toBe("third");
		expect(blocks[1].raw).toBe("second");
		expect(blocks[2].raw).toBe("first");
	});
});
