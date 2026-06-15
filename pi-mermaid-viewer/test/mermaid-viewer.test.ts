import { beforeEach, describe, expect, it, vi } from "vitest";
import { quoteBareLabels, renderHtml, extractMermaidBlocks, labelBlocks } from "../index.ts";
import type { DiagramData, MermaidBlock } from "../index.ts";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ============================================================================
// Helpers
// ============================================================================

function textContentBlock(text: string) {
	return { type: "text" as const, text };
}

function imageContentBlock() {
	return { type: "image" as const, source: { data: "abc", media_type: "image/png" } };
}

function assistantMessage(content: Array<{ type: string; text?: string }>) {
	return {
		role: "assistant" as const,
		content,
		timestamp: new Date().toISOString(),
	};
}

function userMessage(text: string) {
	return {
		role: "user" as const,
		content: [textContentBlock(text)],
		timestamp: new Date().toISOString(),
	};
}

function messageEntry(message: { role: string; content: unknown; timestamp: string }) {
	return {
		type: "message" as const,
		id: `msg-${Math.random().toString(36).slice(2)}`,
		parentId: null,
		timestamp: message.timestamp,
		message,
	};
}

function customEntry(customType: string, data?: unknown) {
	return {
		type: "custom" as const,
		id: `custom-${Math.random().toString(36).slice(2)}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		customType,
		data,
	};
}

/** Build a minimal mock ExtensionCommandContext for testing extractMermaidBlocks. */
function mockCtx(entries: Array<{ type: string; message?: unknown }>): ExtensionCommandContext {
	return {
		sessionManager: {
			getEntries: () => entries,
		},
		ui: { notify: vi.fn() },
		hasUI: true,
		cwd: "/test",
	} as unknown as ExtensionCommandContext;
}

// ============================================================================
// quoteBareLabels
// ============================================================================

describe("quoteBareLabels", () => {
	it("returns unchanged code for clean input", () => {
		const input = `graph TD\n  A --> B`;
		const result = quoteBareLabels(input);
		expect(result.code).toBe(input);
		expect(result.fixes).toEqual([]);
	});

	it("preserves emoji characters", () => {
		const input = "graph TD\n  A[Hello 😀 World 🚀] --> B";
		const result = quoteBareLabels(input);
		expect(result.code).toMatch(/😀/u);
		expect(result.code).toMatch(/🚀/u);
		expect(result.fixes).toEqual([]);
	});

	it("preserves emoji in rhombus labels with special chars (emoji stays, label quoted)", () => {
		const input = "A{done? ✅}";
		const result = quoteBareLabels(input);
		expect(result.code).toContain('A{"done? ✅"}');
		expect(result.code).toMatch(/✅/u);
	});

	it("wraps subgraph labels containing special characters in quotes", () => {
		const input = `graph TD
  subgraph Group (A)
    A --> B
  end`;
		const result = quoteBareLabels(input);
		expect(result.code).toContain('sg1 ["Group (A)"]');
		expect(result.fixes).toContain('subgraph Group (A)');
	});

	it("wraps subgraph labels with curly braces", () => {
		const input = `graph TD
  subgraph Items {x, y}
    A --> B
  end`;
		const result = quoteBareLabels(input);
		expect(result.code).toContain('sg1 ["Items {x, y}"]');
	});

	it("wraps subgraph labels with angle brackets", () => {
		const input = "graph TD\n  subgraph Conditional <x>\n    A --> B\n  end";
		const result = quoteBareLabels(input);
		expect(result.code).toContain('sg1 ["Conditional <x>"]');
	});

	it("does not wrap subgraph labels that already have brackets or quotes", () => {
		const input = 'graph TD\n  subgraph [Already Safe]\n    A --> B\n  end';
		const result = quoteBareLabels(input);
		expect(result.code).toBe(input);
		expect(result.fixes).toEqual([]);
	});

	it("does not wrap subgraph labels that start with double quotes", () => {
		const input = 'graph TD\n  subgraph "Already Quoted"\n    A --> B\n  end';
		const result = quoteBareLabels(input);
		expect(result.code).toBe(input);
	});

	it("increments subgraph counter for multiple wrapped subgraphs", () => {
		const input = `graph TD
  subgraph First (Group)
    A --> B
  end
  subgraph Second {Group}
    C --> D
  end`;
		const result = quoteBareLabels(input);
		expect(result.code).toContain('sg1 ["First (Group)"]');
		expect(result.code).toContain('sg2 ["Second {Group}"]');
	});

	it("wraps node labels containing special characters in double quotes", () => {
		const input = "graph TD\n  A[Node (with parens)] --> B";
		const result = quoteBareLabels(input);
		expect(result.code).toContain('A["Node (with parens)"]');
		expect(result.fixes).toContain('A […]');
	});

	it("wraps node labels with nested brackets", () => {
		const input = "graph TD\n  A[Value: {key}] --> B";
		const result = quoteBareLabels(input);
		expect(result.code).toContain('A["Value: {key}"]');
	});

	it("handles multiple node fixes in the same line", () => {
		const input = "A[Hello (world)] --> B[Goodbye {everyone}]";
		const result = quoteBareLabels(input);
		expect(result.code).toContain('A["Hello (world)"]');
		expect(result.code).toContain('B["Goodbye {everyone}"]');
	});

	it("strips existing double quotes from node labels before rewrapping", () => {
		const input = 'A["Already (quoted)"] --> B';
		const result = quoteBareLabels(input);
		expect(result.code).toContain('A["Already (quoted)"]');
	});

	it("does not modify node labels without special characters", () => {
		const input = "graph TD\n  A[Normal Label] --> B[Another]";
		const result = quoteBareLabels(input);
		expect(result.code).toBe(input);
	});

	// --- rhombus / decision nodes (the original failing case) ---

	it("wraps rhombus labels containing '?' and HTML tags", () => {
		const input = "flowchart TD\n  B{依赖框架注解?<br/>@Transactional}";
		const result = quoteBareLabels(input);
		expect(result.code).toContain('B{"依赖框架注解?<br/>@Transactional"}');
		expect(result.fixes).toContain('B {…}');
	});

	it("wraps rhombus labels with '@' and '/' separators", () => {
		const input = "A{a@b/c}";
		const result = quoteBareLabels(input);
		expect(result.code).toContain('A{"a@b/c"}');
	});

	it("does not modify rhombus labels without special characters", () => {
		const input = "A{是}";
		const result = quoteBareLabels(input);
		expect(result.code).toBe(input);
		expect(result.fixes).toEqual([]);
	});

	it("skips already-quoted rhombus labels", () => {
		const input = 'A{"already (quoted)"}';
		const result = quoteBareLabels(input);
		expect(result.code).toBe(input);
		expect(result.fixes).toEqual([]);
	});

	// --- other shapes ---

	it("wraps rounded node labels with special characters", () => {
		const input = "A(是?)";
		const result = quoteBareLabels(input);
		expect(result.code).toContain('A("是?")');
	});

	it("wraps circle node labels with special characters", () => {
		const input = "A((a@b))";
		const result = quoteBareLabels(input);
		expect(result.code).toContain('A(("a@b"))');
	});

	it("wraps hexagon node labels with special characters", () => {
		const input = "A{{x?y}}";
		const result = quoteBareLabels(input);
		expect(result.code).toContain('A{{"x?y"}}');
	});

	it("wraps subroutine node labels with special characters", () => {
		const input = "A[[a<b]]";
		const result = quoteBareLabels(input);
		expect(result.code).toContain('A[["a<b"]]');
	});

	it("wraps cylinder node labels with special characters", () => {
		const input = "A[(a@b)]";
		const result = quoteBareLabels(input);
		expect(result.code).toContain('A[("a@b")]');
	});

	it("wraps parallelogram node labels with special characters", () => {
		const input = "A[/a?b/]";
		const result = quoteBareLabels(input);
		expect(result.code).toContain('A[/"a?b"/]');
	});

	it("matches circle shape before rounded (greedy order)", () => {
		// A((x?)) must be treated as a circle, not as a rounded node
		// A( whose label happens to start with (x?
		const input = "A((x?))";
		const result = quoteBareLabels(input);
		expect(result.code).toBe('A(("x?"))');
	});

	it("wraps rectangle labels containing '?' or '@' (extended trigger set)", () => {
		const input = "A[what?] --> B[foo@bar]";
		const result = quoteBareLabels(input);
		expect(result.code).toContain('A["what?"]');
		expect(result.code).toContain('B["foo@bar"]');
	});

	it("heals the full real-world decision-tree diagram", () => {
		const input = [
			"flowchart TD",
			"  A[被测代码] --> B{依赖框架注解?<br/>@Transactional/@DS/AOP}",
			"  B -->|是| IT[需要集成测试]",
			"  B -->|否| C{执行真实外部 IO?<br/>SQL/Redis/MQ/HTTP}",
			"  C -->|是| IT",
			"  C -->|否| D{涉及多线程<br/>共享状态?}",
			"  D -->|是| IT",
			"  D -->|否| E{跨多个组件<br/>协议契约?}",
			"  E -->|是| IT",
			"  E -->|否| MOCK[Mock 单测足够]",
		].join("\n");
		const result = quoteBareLabels(input);
		// All rhombus nodes get quoted
		expect(result.code).toContain('B{"依赖框架注解?<br/>@Transactional/@DS/AOP"}');
		expect(result.code).toContain('C{"执行真实外部 IO?<br/>SQL/Redis/MQ/HTTP"}');
		expect(result.code).toContain('D{"涉及多线程<br/>共享状态?"}');
		expect(result.code).toContain('E{"跨多个组件<br/>协议契约?"}');
		// Rectangles without special chars are untouched
		expect(result.code).toContain("A[被测代码]");
		expect(result.code).toContain("IT[需要集成测试]");
		expect(result.code).toContain("MOCK[Mock 单测足够]");
		// Edge labels are untouched
		expect(result.code).toContain("B -->|是| IT");
	});

	it("returns empty string unchanged", () => {
		const result = quoteBareLabels("");
		expect(result.code).toBe("");
		expect(result.fixes).toEqual([]);
	});

	// --- regression: the bug that triggered the try-first redesign ---

	it("does NOT re-wrap the canonical `subgraph ID[\"..()..\"]` form (the original parse-error bug)", () => {
		const input = 'subgraph L1["Layer 1: RunDataEndListenerV2.processRunDataEnd()"]';
		const result = quoteBareLabels(input);
		expect(result.code).toBe(input);
		expect(result.fixes).toEqual([]);
	});

	it("does NOT re-wrap an already-quoted node label containing parens", () => {
		const input = 'A5["dealRunEndActivity()"]';
		const result = quoteBareLabels(input);
		expect(result.code).toBe(input);
		expect(result.fixes).toEqual([]);
	});

	it("leaves the full real-world four-layer flowchart untouched", () => {
		const input = [
			"flowchart LR",
			"    direction TB",
			'    subgraph L1["Layer 1: RunDataEndListenerV2.processRunDataEnd()"]',
			"        direction TB",
			'        A5["dealRunEndActivity()"]',
			"    end",
			'    subgraph L3["Layer 3: ActivityResultManager.runEnd()"]',
			'        C7["高光时刻(新/旧)"]',
			"    end",
			"    A5 --> B1",
		].join("\n");
		const result = quoteBareLabels(input);
		expect(result.code).toBe(input);
		expect(result.fixes).toEqual([]);
	});
});

// ============================================================================
// renderHtml
// ============================================================================

describe("renderHtml", () => {
	it("embeds diagram data as JSON in the script tag", () => {
		const diagrams: DiagramData[] = [
			{ code: "graph TD\n  A --> B", label: "Diagram 1" },
		];
		const html = renderHtml(diagrams, "dark");
		expect(html).toContain('"code":"graph TD\\n  A --> B"');
		expect(html).toContain('"label":"Diagram 1"');
	});

	it("sets body class based on theme", () => {
		const darkHtml = renderHtml([], "dark");
		expect(darkHtml).toContain('class="bg-dark"');

		const lightHtml = renderHtml([], "light");
		expect(lightHtml).toContain('class="bg-light"');
	});

	it("sets INIT_BG variable to the theme in script", () => {
		const html = renderHtml([], "dark");
		expect(html).toContain('INIT_BG = "dark"');
	});

	it("initializes the custom theme dropdown label + active item", () => {
		const html = renderHtml([], "light");
		expect(html).toContain('getElementById("bg_label")');
		expect(html).toContain('data-bg="dark"');
		expect(html).toContain('data-bg="light"');
		expect(html).toContain('data-bg="white"');
		expect(html).not.toContain('id="bgsel"');   // native select removed
	});

	it("handles empty diagrams array", () => {
		const html = renderHtml([], "dark");
		expect(html).toContain("const DIAGRAMS = []");
		expect(html).toBeTruthy();
	});

	it("produces valid HTML structure with all key elements", () => {
		const diagrams: DiagramData[] = [
			{ code: "A --> B", label: "Test" },
		];
		const html = renderHtml(diagrams, "dark");

		// Document structure
		expect(html).toContain("<!DOCTYPE html>");
		expect(html).toContain("</html>");

		// UI elements
		expect(html).toContain("PNG");
		expect(html).toContain("SVG");
		expect(html).toContain('id="cb"');
		expect(html).toContain('id="sb"');

		// Download split button: one-click download + format switcher (event delegation, no inline onclick)
		expect(html).toContain('class="dl-main"');
		expect(html).toContain('id="dl_split"');
		expect(html).toContain('class="dl-toggle"');
		expect(html).toContain('data-fmt="png"');
		expect(html).toContain('data-fmt="svg"');
		// No inline onclick on download buttons (uses addEventListener delegation)
		expect(html).not.toContain('onclick="doDownload');
		expect(html).not.toContain('onclick="setFormat');
		expect(html).not.toContain('onclick="toggleDlMenu');
		// Default format label shown on the main button
		expect(html).toContain('id="dlm_fmt"');
		// No standalone SVG/PNG buttons anymore
		expect(html).not.toContain('>SVG</button>');
		expect(html).not.toContain('>PNG</button>');

		// Background selector (custom dropdown)
		expect(html).toContain('data-bg="dark"');
		expect(html).toContain('data-bg="light"');
		expect(html).toContain('data-bg="white"');

		// Zoom controls exist via onclick handlers
		expect(html).toContain("zoom(-10)");
		expect(html).toContain("zoom(10)");
		expect(html).toContain("zoom(0)");

		// Dark/Light/White theme selector
		expect(html).toContain('data-bg="dark"');
		expect(html).toContain('data-bg="light"');
		expect(html).toContain('data-bg="white"');
	});

	it("does not create tabs when only one diagram", () => {
		const diagrams: DiagramData[] = [
			{ code: "A --> B", label: "Only" },
		];
		const html = renderHtml(diagrams, "dark");
		// No tab creation logic for single diagram
		expect(html).toContain('if (DIAGRAMS.length > 1)');
		// Tabs div will be empty
	});

	it("embeds multiple diagrams correctly", () => {
		const diagrams: DiagramData[] = [
			{ code: "A --> B", label: "#1" },
			{ code: "C --> D", label: "#2" },
		];
		const html = renderHtml(diagrams, "dark");
		expect(html).toContain('"code":"A --> B"');
		expect(html).toContain('"code":"C --> D"');
		expect(html).toContain('"label":"#1"');
		expect(html).toContain('"label":"#2"');
	});

	it("does NOT embed a fixes field in the diagram JSON (try-first redesign: fixes are computed in-browser on retry)", () => {
		const diagrams: DiagramData[] = [
			{ code: "A --> B", label: "D" },
		];
		const html = renderHtml(diagrams, "dark");
		// The DIAGRAMS JSON payload must not carry a per-diagram fixes field.
		const payload = html.match(/const DIAGRAMS = (\[.*?\]);/s)?.[1] ?? "";
		expect(payload).not.toMatch(/"fixes"/);
		expect(payload).toContain('"code"');
		expect(payload).toContain('"label"');
	});
});

// ============================================================================
// extractMermaidBlocks
// ============================================================================

describe("extractMermaidBlocks", () => {
	it("returns empty array when no entries", () => {
		const ctx = mockCtx([]);
		expect(extractMermaidBlocks(ctx)).toEqual([]);
	});

	it("returns empty array when no mermaid blocks in messages", () => {
		const ctx = mockCtx([
			messageEntry(assistantMessage([textContentBlock("plain text")])),
		]);
		expect(extractMermaidBlocks(ctx)).toEqual([]);
	});

	it("ignores non-message entries", () => {
		const ctx = mockCtx([customEntry("some-type", { key: "val" })]);
		expect(extractMermaidBlocks(ctx)).toEqual([]);
	});

	it("ignores user messages", () => {
		const userMsg = userMessage("```mermaid\ngraph TD\n  A --> B\n```");
		const ctx = mockCtx([messageEntry(userMsg)]);
		expect(extractMermaidBlocks(ctx)).toEqual([]);
	});

	it("extracts a single mermaid block", () => {
		const msg = assistantMessage([
			textContentBlock("```mermaid\ngraph TD\n  A --> B\n```"),
		]);
		const ctx = mockCtx([messageEntry(msg)]);
		const blocks = extractMermaidBlocks(ctx);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].raw).toBe("graph TD\n  A --> B");
		expect(blocks[0].label).toBe("Diagram 1");
	});

	it("extracts multiple blocks from one message", () => {
		const msg = assistantMessage([
			textContentBlock(
				"```mermaid\ngraph TD\n  A --> B\n```\n\n```mermaid\nsequenceDiagram\n  A ->> B\n```",
			),
		]);
		const ctx = mockCtx([messageEntry(msg)]);
		const blocks = extractMermaidBlocks(ctx);
		expect(blocks).toHaveLength(2);
		expect(blocks[0].raw).toBe("graph TD\n  A --> B");
		expect(blocks[1].raw).toBe("sequenceDiagram\n  A ->> B");
	});

	it("extracts blocks from multiple messages", () => {
		const msg1 = assistantMessage([textContentBlock("```mermaid\nA --> B\n```")]);
		const msg2 = assistantMessage([textContentBlock("```mermaid\nC --> D\n```")]);
		const ctx = mockCtx([messageEntry(msg1), messageEntry(msg2)]);
		const blocks = extractMermaidBlocks(ctx);
		expect(blocks).toHaveLength(2);
		expect(blocks[0].raw).toBe("A --> B");
		expect(blocks[1].raw).toBe("C --> D");
	});

	it("skips non-text content blocks (images)", () => {
		const msg = assistantMessage([
			imageContentBlock(),
			textContentBlock("```mermaid\nA --> B\n```"),
		]);
		const ctx = mockCtx([messageEntry(msg)]);
		const blocks = extractMermaidBlocks(ctx);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].raw).toBe("A --> B");
	});

	it("handles mermaid block with surrounding whitespace", () => {
		const msg = assistantMessage([
			textContentBlock("Some text\n```mermaid\n  A --> B  \n```\nMore text"),
		]);
		const ctx = mockCtx([messageEntry(msg)]);
		const blocks = extractMermaidBlocks(ctx);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].raw).toBe("A --> B");
	});

	it("handles mermaid block with no language specifier space", () => {
		const msg = assistantMessage([textContentBlock("```mermaid\nA --> B\n```")]);
		const ctx = mockCtx([messageEntry(msg)]);
		const blocks = extractMermaidBlocks(ctx);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].raw).toBe("A --> B");
	});

	it("numbers diagrams incrementally across messages", () => {
		const msg1 = assistantMessage([textContentBlock("```mermaid\nA --> B\n```")]);
		const msg2 = assistantMessage([textContentBlock("```mermaid\nC --> D\n```")]);
		const ctx = mockCtx([messageEntry(msg1), messageEntry(msg2)]);
		const blocks = extractMermaidBlocks(ctx);
		expect(blocks).toHaveLength(2);
		expect(blocks[0].label).toBe("Diagram 1");
		expect(blocks[1].label).toBe("Diagram 2");
	});

	it("ignores code blocks that are not mermaid", () => {
		const msg = assistantMessage([
			textContentBlock("```typescript\nconst x = 1;\n```"),
		]);
		const ctx = mockCtx([messageEntry(msg)]);
		expect(extractMermaidBlocks(ctx)).toEqual([]);
	});
});

// ============================================================================
// labelBlocks
// ============================================================================

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

// ============================================================================
// HTML structure assertions — canvas layout (tasks 3.1)
// ============================================================================

describe("renderHtml — canvas layout structure", () => {
	function html() {
		return renderHtml([{ code: "A --> B", label: "D" }], "dark");
	}

	it("renders toolbar with position:fixed overlay", () => {
		expect(html()).toMatch(/\.bar\{position:fixed/);
	});

	it("renders canvas viewport with overflow:hidden", () => {
		expect(html()).toMatch(/canvas-viewport\{[^}]*overflow:hidden/);
	});

	it("zoom bar is grouped inside the toolbar (.grp), not fixed-centered", () => {
		expect(html()).not.toMatch(/\.zoom-bar\{position:fixed/);
		expect(html()).not.toContain("transform:translateX(-50%)");
		// It lives inside .bar now, as a .grp sibling of the main button group.
		expect(html()).toContain('class="grp" id="zb"');
	});

	it("canvas viewport has top padding for floating bars", () => {
		expect(html()).toMatch(/canvas-viewport\{[^}]*padding:60px 24px 24px 24px/);
	});

	it("tabs use position:fixed overlay", () => {
		expect(html()).toMatch(/\.tabs\{position:fixed/);
	});

	it("zoom bar is nested inside .bar (no longer a standalone fixed element)", () => {
		const h = html();
		expect(h).not.toContain('class="zoom-bar" id="zb"');
		expect(h).toContain('class="grp" id="zb"');
	});

	it("loading indicator exists with Loading diagram... text", () => {
		expect(html()).toContain('class="loading" id="ld"');
		expect(html()).toContain("Loading diagram...");
	});

	it("error div is inside canvas-viewport", () => {
		const h = html();
		const canvasStart = h.indexOf("id=\"canvas-viewport\"");
		const errPos = h.indexOf('class="err" id="er"');
		expect(errPos).toBeGreaterThan(canvasStart);
	});
});

// ============================================================================
// HTML structure assertions — icon controls (tasks 3.2)
// ============================================================================

describe("renderHtml — icon controls", () => {
	function html() {
		return renderHtml([{ code: "A --> B", label: "D" }], "dark");
	}

	it("zoom-out button has SVG child", () => {
		expect(html()).toContain('id="zout"');
		expect(html()).toMatch(/zout[^>]*>\s*<svg/);
	});

	it("zoom-in button has SVG child", () => {
		expect(html()).toContain('id="zin"');
		expect(html()).toMatch(/zin[^>]*>\s*<svg/);
	});

	it("reset button has SVG child", () => {
		expect(html()).toContain('id="zreset"');
		expect(html()).toMatch(/zreset[^>]*>\s*<svg/);
	});

	it("zoom-out button has title and aria-label", () => {
		expect(html()).toMatch(/id="zout"[^>]*title="Zoom out"[^>]*aria-label="Zoom out"/);
	});

	it("zoom-in button has title and aria-label", () => {
		expect(html()).toMatch(/id="zin"[^>]*title="Zoom in"[^>]*aria-label="Zoom in"/);
	});

	it("reset button has title and aria-label", () => {
		expect(html()).toMatch(/id="zreset"[^>]*title="Reset view"[^>]*aria-label="Reset view"/);
	});

	it("zoom percentage label has aria-live=polite", () => {
		expect(html()).toMatch(/id="zl"[^>]*aria-live="polite"/);
	});

	it("zoom percentage label has role=status", () => {
		expect(html()).toMatch(/id="zl"[^>]*role="status"/);
	});

	it("buttons have focus-visible style for keyboard nav", () => {
		expect(html()).toContain("focus-visible");
	});

	it("zoom bar has rounded border-radius", () => {
		expect(html()).toMatch(/zoom-bar\{[^}]*border-radius:10px/);
	});

	it("zoom bar buttons use currentColor for SVGs", () => {
		expect(html()).toContain("stroke:currentColor");
	});

	it("trackpad pinch-to-zoom handler exists", () => {
		expect(html()).toContain('addEventListener("wheel"');
		expect(html()).toContain("ctrlKey");
		expect(html()).toContain("preventDefault");
	});

	it("disabled buttons have reduced opacity and no pointer events", () => {
		expect(html()).toMatch(/button:disabled\{opacity:\.3;pointer-events:none\}/);
	});
});

// ============================================================================
// HTML structure assertions — new states (tasks 3.3)
// ============================================================================

describe("renderHtml — interaction states", () => {
	it("zoom uses SVG attribute sizing not CSS transform", () => {
		const h = renderHtml([], "dark");
		expect(h).toContain("svgNaturalW");
		expect(h).toContain('setAttribute("width"');
		expect(h).toContain('setAttribute("height"');
	});

	it("updateZoomButtons function exists in script", () => {
		const h = renderHtml([], "dark");
		expect(h).toContain("function updateZoomButtons()");
	});

	it("zooms disable zoom-in at 400%", () => {
		const h = renderHtml([], "dark");
		expect(h).toContain('zin").disabled = zoomLevel >= 400');
	});

	it("zooms disable zoom-out at 25%", () => {
		const h = renderHtml([], "dark");
		expect(h).toContain('zout").disabled = zoomLevel <= 25');
	});

	it("reset calls resetPan to zero pan position", () => {
		const h = renderHtml([], "dark");
		expect(h).toContain("resetPan");
	});

	it("tab switch resets zoom to 100%", () => {
		const h = renderHtml([], "dark");
		expect(h).toContain("zoomLevel = 100");
	});
});

// ============================================================================
// HTML structure assertions — PNG export (tasks 3.5)
// ============================================================================

describe("renderHtml — PNG export", () => {
	it("export scales canvas to 3x natural SVG dimensions", () => {
		const h = renderHtml([], "dark");
		expect(h).toContain("svgNaturalSize");
		expect(h).toContain("const scale = 3");
		expect(h).toContain("canvas.width = w * scale");
	});

	it("export uses current theme background color", () => {
		const h = renderHtml([], "dark");
		expect(h).toContain('bgFill[currentBg]');
	});

	it("export PNG reads SVG viewBox for true 2x resolution", () => {
		const h = renderHtml([], "dark");
		expect(h).toContain("viewBox?.baseVal");
		expect(h).toContain("getBBox");
	});

	it("SVG export serializes and downloads SVG file", () => {
		const h = renderHtml([], "dark");
		expect(h).toContain("exportSvg");
		expect(h).toContain("image/svg+xml");
		expect(h).toContain(".svg");
	});
});

// ============================================================================
// HTML structure assertions — export strips emoji, display keeps them (task)
// ============================================================================

describe("renderHtml — export strips emoji while display keeps them", () => {
	it("defines an emoji regex constant for export", () => {
		const h = renderHtml([], "dark");
		expect(h).toMatch(/EMOJI_RE/);
		expect(h).toMatch(/Emoji_Presentation/);
	});

	it("exportSvg strips emoji after serialization", () => {
		const h = renderHtml([], "dark");
		const svgFn = h.slice(h.indexOf("window.exportSvg"), h.indexOf("window.exportPng"));
		expect(svgFn).toMatch(/serializeToString\(clone\)\.replace\(EMOJI_RE/);
	});

	it("exportPng strips emoji after serialization", () => {
		const h = renderHtml([], "dark");
		const pngFn = h.slice(h.indexOf("window.exportPng"));
		expect(pngFn).toMatch(/serializeToString\(svgEl\)\.replace\(EMOJI_RE/);
	});
});

// ============================================================================
// toString() injection invariant — guards the template-backslash gotcha
// ============================================================================
// quoteBareLabels is authored without type annotations and injected into the
// rendered page via Function.prototype.toString(). Template literals EAT
// backslashes, so authoring regex-bearing JS inline in renderHtml() would
// corrupt the regexes (\w → w, \s → s). Authoring at module scope + .toString()
// avoids that. These tests lock the invariant in place.

describe("quoteBareLabels.toString() survives template-literal injection", () => {
	it("preserves regex backslashes in the serialized source", () => {
		const src = quoteBareLabels.toString();
		expect(src).toContain("\\w");   // lost \w → backslashes corrupted
		expect(src).toContain("\\s");   // lost \s → backslashes corrupted
		expect(src).toContain("\\[");   // lost \[ → backslashes corrupted
	});

	it("serializes to a syntactically valid named function declaration", () => {
		const src = quoteBareLabels.toString();
		// node --check verifies it parses as a standalone script
		const file = join(tmpdir(), `qlb-check-${Date.now()}.js`);
		writeFileSync(file, src);
		expect(() => execFileSync("node", ["--check", file])).not.toThrow();
	});

	it("re-evaluates into a function with identical behavior", () => {
		const src = quoteBareLabels.toString();
		// eslint-disable-next-line no-eval
		const reimpl = (0, eval)("(" + src + ")") as typeof quoteBareLabels;
		const cases = [
			'subgraph L1["x()"]',
			"B{注解?}",
			"subgraph 裸?",
			"A[plain] --> B[x?]",
		];
		for (const c of cases) {
			expect(reimpl(c)).toEqual(quoteBareLabels(c));
		}
	});
});

// ============================================================================
// renderHtml integration — generated <script> must be valid browser JS
// ============================================================================

describe("renderHtml: generated <script> is valid browser JS", () => {
	function extractScript(html: string): string {
		const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
		if (!m) throw new Error("no module script found in HTML");
		return m[1];
	}

	it("passes `node --check` on the full generated script", () => {
		const html = renderHtml([{ code: "flowchart TD\nA-->B", label: "t" }], "dark");
		const script = extractScript(html);
		const file = join(tmpdir(), `mvm-check-${Date.now()}.js`);
		writeFileSync(file, script);
		expect(() => execFileSync("node", ["--check", file])).not.toThrow();
	});

	it("injects quoteBareLabels verbatim into the page", () => {
		const html = renderHtml([{ code: "flowchart TD\nA-->B", label: "t" }], "dark");
		expect(html).toContain("function quoteBareLabels(code)");
	});

	it("contains no stale sanitize() call or d.fixes reference", () => {
		const html = renderHtml([{ code: "flowchart TD\nA-->B", label: "t" }], "dark");
		expect(html).not.toMatch(/\bsanitize\s*\(/);
		// `healed.fixes` is legit; `d.fixes` (DiagramData.fixes) must be gone.
		expect(html).not.toMatch(/(?<![a-zA-Z])d\.fixes\b/);
	});

	// --- EMOJI_RE template-backslash regression ---
	// The regex used to be authored inline in the template literal, which ate
	// its backslashes: /[\p{Emoji...}]/gu → /[p{Emoji...}]/gu. As a character
	// class the broken regex matched the literal letters p/E/m/o/j/i/... and
	// stripped ~45% of every exported SVG, so Image.onerror fired and PNG
	// export silently never downloaded. SVG export survived only because it
	// serves a blob directly without round-tripping through an <img>.
	it("EMOJI_RE is built from an injected source string (backslashes survive)", () => {
		const html = renderHtml([{ code: "flowchart TD\nA-->B", label: "t" }], "dark");
		expect(html).toContain('new RegExp("[\\\\p{Emoji_Presentation}');
		expect(html).not.toMatch(/EMOJI_RE = \/\[/);   // no inlined literal regex
	});

	// --- dl-split overflow:hidden regression ---
	// The format-picker menu (.dl-pop) is absolutely positioned below .dl-split.
	// If .dl-split has overflow:hidden, the menu is clipped — it renders in the
	// DOM (getBoundingClientRect exists) but is invisible AND unclickable
	// (elementFromPoint hits the canvas behind it). Must stay overflow:visible.
	it("dl-split never uses overflow:hidden (would clip the format menu)", () => {
		const html = renderHtml([{ code: "flowchart TD\nA-->B", label: "t" }], "dark");
		const m = html.match(/\.dl-split\{([^}]*)\}/);
		expect(m, ".dl-split rule not found").toBeTruthy();
		expect(m![1]).not.toMatch(/overflow:\s*hidden/);
	});
});
