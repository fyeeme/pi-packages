import { afterAll, describe, expect, it } from "vitest";
import { quoteBareLabels } from "../index.ts";
import { nodeCheckSandbox } from "./helpers.ts";

const heal = (code: string) => quoteBareLabels(code);

// ============================================================================
// quoteBareLabels
// ============================================================================
// Runs only after Mermaid fails to parse a diagram. Correctly-quoted source
// must NEVER be rewritten — most cases below pin that guarantee from one side
// (bare labels get quoted) or the other (safe source passes through).

describe("quoteBareLabels", () => {
	// --- pass-through: nothing to heal ---

	it("returns unchanged code for clean input", () => {
		const input = `graph TD\n  A --> B`;
		const result = heal(input);
		expect(result.code).toBe(input);
		expect(result.fixes).toEqual([]);
	});

	it("preserves emoji characters", () => {
		const input = "graph TD\n  A[Hello 😀 World 🚀] --> B";
		const result = heal(input);
		expect(result.code).toMatch(/😀/u);
		expect(result.code).toMatch(/🚀/u);
		expect(result.fixes).toEqual([]);
	});

	it("preserves emoji in rhombus labels with special chars (emoji stays, label quoted)", () => {
		const result = heal("A{done? ✅}");
		expect(result.code).toContain('A{"done? ✅"}');
		expect(result.code).toMatch(/✅/u);
	});

	it("returns empty string unchanged", () => {
		const result = heal("");
		expect(result.code).toBe("");
		expect(result.fixes).toEqual([]);
	});

	// --- real-world diagrams must pass through verbatim ---
	// These pin the try-first guarantee: valid source is never rewritten.

	it("leaves the mermaid.live default sample diagram untouched", () => {
		// Reverse-engineered from https://mermaid.live/edit#pako:… (the URL
		// state is a JSON object, zlib-deflated, base64url-encoded). This is
		// the editor's built-in sample: box/rounded/rhombus nodes, labeled
		// pipe edges, and a fa: icon label — none contain a special char, so
		// the healer must return it verbatim.
		const input = [
			"flowchart TD",
			"    A[Christmas] -->|Get money| B(Go shopping)",
			"    B --> C{Let me think}",
			"    C -->|One| D[Laptop]",
			"    C -->|Two| E[iPhone]",
			"    C -->|Three| F[fa:fa-car Car]",
		].join("\n");
		const result = heal(input);
		expect(result.code).toBe(input);
		expect(result.fixes).toEqual([]);
	});

	it("leaves the full real-world four-layer flowchart untouched (regression)", () => {
		// The original parse-error bug: the sanitize-everything design
		// re-wrapped the already-correct subgraph ID["..().."] form.
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
		const result = heal(input);
		expect(result.code).toBe(input);
		expect(result.fixes).toEqual([]);
	});

	it("does NOT re-wrap the canonical `subgraph ID[\"..()..\"]` form", () => {
		const input = 'subgraph L1["Layer 1: RunDataEndListenerV2.processRunDataEnd()"]';
		expect(heal(input)).toEqual({ code: input, fixes: [] });
	});

	it("does NOT re-wrap an already-quoted node label containing parens", () => {
		const input = 'A5["dealRunEndActivity()"]';
		expect(heal(input)).toEqual({ code: input, fixes: [] });
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
		const result = heal(input);
		// All rhombus nodes get quoted
		expect(result.code).toContain('B{"依赖框架注解?<br/>@Transactional/@DS/AOP"}');
		expect(result.code).toContain('C{"执行真实外部 IO?<br/>SQL/Redis/MQ/HTTP"}');
		expect(result.code).toContain('D{"涉及多线程<br/>共享状态?"}');
		expect(result.code).toContain('E{"跨多个组件<br/>协议契约?"}');
		// Rectangles without special chars are untouched
		expect(result.code).toContain("A[被测代码]");
		expect(result.code).toContain("IT[需要集成测试]");
		expect(result.code).toContain("MOCK[Mock 单测足够]");
		// Edge labels without special chars stay bare
		expect(result.code).toContain("B -->|是| IT");
	});

	// --- subgraph labels ---

	it("wraps subgraph labels containing special characters in quotes", () => {
		const input = `graph TD\n  subgraph Group (A)\n    A --> B\n  end`;
		const result = heal(input);
		expect(result.code).toContain('sg1 ["Group (A)"]');
		expect(result.fixes).toContain("subgraph Group (A)");
	});

	it("wraps subgraph labels with curly braces", () => {
		const input = `graph TD\n  subgraph Items {x, y}\n    A --> B\n  end`;
		expect(heal(input).code).toContain('sg1 ["Items {x, y}"]');
	});

	it("wraps subgraph labels with angle brackets", () => {
		const input = "graph TD\n  subgraph Conditional <x>\n    A --> B\n  end";
		expect(heal(input).code).toContain('sg1 ["Conditional <x>"]');
	});

	it("does not wrap subgraph labels that already have brackets or quotes", () => {
		const input = 'graph TD\n  subgraph [Already Safe]\n    A --> B\n  end';
		expect(heal(input)).toEqual({ code: input, fixes: [] });
	});

	it("does not wrap subgraph labels that start with double quotes", () => {
		const input = 'graph TD\n  subgraph "Already Quoted"\n    A --> B\n  end';
		expect(heal(input).code).toBe(input);
	});

	it("increments subgraph counter for multiple wrapped subgraphs", () => {
		const input = `graph TD\n  subgraph First (Group)\n    A --> B\n  end\n  subgraph Second {Group}\n    C --> D\n  end`;
		const result = heal(input);
		expect(result.code).toContain('sg1 ["First (Group)"]');
		expect(result.code).toContain('sg2 ["Second {Group}"]');
	});

	// --- node labels: plain shapes ---

	it("wraps node labels containing special characters in double quotes", () => {
		const result = heal("graph TD\n  A[Node (with parens)] --> B");
		expect(result.code).toContain('A["Node (with parens)"]');
		expect(result.fixes).toContain("A […]");
	});

	it("wraps node labels with nested brackets", () => {
		expect(heal("graph TD\n  A[Value: {key}] --> B").code).toContain('A["Value: {key}"]');
	});

	it("handles multiple node fixes in the same line", () => {
		const result = heal("A[Hello (world)] --> B[Goodbye {everyone}]");
		expect(result.code).toContain('A["Hello (world)"]');
		expect(result.code).toContain('B["Goodbye {everyone}"]');
	});

	it("strips existing double quotes from node labels before rewrapping", () => {
		expect(heal('A["Already (quoted)"] --> B').code).toContain('A["Already (quoted)"]');
	});

	it("does not modify node labels without special characters", () => {
		const input = "graph TD\n  A[Normal Label] --> B[Another]";
		expect(heal(input)).toEqual({ code: input, fixes: [] });
	});

	it("wraps rectangle labels containing '?' or '@' (extended trigger set)", () => {
		const result = heal("A[what?] --> B[foo@bar]");
		expect(result.code).toContain('A["what?"]');
		expect(result.code).toContain('B["foo@bar"]');
	});

	// --- rhombus / decision nodes (the original failing case) ---

	it("wraps rhombus labels containing '?' and HTML tags", () => {
		const result = heal("flowchart TD\n  B{依赖框架注解?<br/>@Transactional}");
		expect(result.code).toContain('B{"依赖框架注解?<br/>@Transactional"}');
		expect(result.fixes).toContain("B {…}");
	});

	it("wraps rhombus labels with '@' and '/' separators", () => {
		expect(heal("A{a@b/c}").code).toContain('A{"a@b/c"}');
	});

	it("does not modify rhombus labels without special characters", () => {
		const input = "A{是}";
		expect(heal(input)).toEqual({ code: input, fixes: [] });
	});

	it("skips already-quoted rhombus labels", () => {
		const input = 'A{"already (quoted)"}';
		expect(heal(input)).toEqual({ code: input, fixes: [] });
	});

	// --- other shapes: each wrapper gets its label quoted ---

	it.each([
		{ shape: "rounded", input: "A(是?)", expected: 'A("是?")' },
		{ shape: "circle", input: "A((a@b))", expected: 'A(("a@b"))' },
		{ shape: "hexagon", input: "A{{x?y}}", expected: 'A{{"x?y"}}' },
		{ shape: "subroutine", input: "A[[a<b]]", expected: 'A[["a<b"]]' },
		{ shape: "cylinder", input: "A[(a@b)]", expected: 'A[("a@b")]' },
		{ shape: "parallelogram", input: "A[/a?b/]", expected: 'A[/"a?b"/]' },
	])("wraps $shape node labels with special characters", ({ input, expected }) => {
		expect(heal(input).code).toContain(expected);
	});

	it("matches circle shape before rounded (greedy order)", () => {
		// A((x?)) must be treated as a circle, not as a rounded node
		// A( whose label happens to start with (x?
		expect(heal("A((x?))").code).toBe('A(("x?"))');
	});

	// --- edge labels: pipe |..| / dotted -. .-> / dash -- --> ---

	it.each([
		{ trigger: "@", input: "API -->|@HttpExchange| DEVICE", expected: 'API -->|"@HttpExchange"| DEVICE', fix: "edge |@HttpExchange|" },
		{ trigger: "/", input: "A -->|GET /user| B", expected: 'A -->|"GET /user"| B', fix: "edge |GET /user|" },
		{ trigger: "()", input: "A -->|foo(x)| B", expected: 'A -->|"foo(x)"| B', fix: "edge |foo(x)|" },
	])("quotes a pipe edge label containing '$trigger'", ({ input, expected, fix }) => {
		// |foo(x)| must NOT be rewritten into a node `foo"(x)"` by the shape pass:
		// edge labels are parked as placeholders before the node pass runs.
		expect(heal(input)).toEqual({ code: expected, fixes: [fix] });
	});

	it("leaves a pipe edge label without special chars untouched", () => {
		const input = "B -->|是| IT[需要集成测试]";
		expect(heal(input)).toEqual({ code: input, fixes: [] });
	});

	it("leaves an already-quoted pipe edge label untouched", () => {
		const input = 'A -->|"@x"| B';
		expect(heal(input)).toEqual({ code: input, fixes: [] });
	});

	it("heals multiple pipe labels on one line", () => {
		expect(heal("A -->|@a| B -->|@b| C")).toEqual({
			code: 'A -->|"@a"| B -->|"@b"| C',
			fixes: ["edge |@a|", "edge |@b|"],
		});
	});

	it("quotes a dotted edge label containing a special char", () => {
		expect(heal("A -. @x .-> B")).toEqual({
			code: 'A -. "@x" .-> B',
			fixes: ["edge -. @x .->"],
		});
	});

	it("quotes a dash edge label containing a special char (arrow form)", () => {
		expect(heal("A -- @x --> B")).toEqual({
			code: 'A -- "@x" --> B',
			fixes: ["edge -- @x -->"],
		});
	});

	it("quotes a dash edge label (no-arrow form ---)", () => {
		expect(heal("A -- @x --- B")).toEqual({
			code: 'A -- "@x" --- B',
			fixes: ["edge -- @x ---"],
		});
	});

	it.each([
		{ input: "A --> B", why: "plain arrow" },
		{ input: "A -.-> B", why: "plain dotted link" },
		{ input: "A --- B", why: "plain --- link" },
	])("does not mistake a $why for a dash/dotted label", ({ input }) => {
		expect(heal(input)).toEqual({ code: input, fixes: [] });
	});

	it("heals node labels on a line that also has a healed edge label", () => {
		expect(heal("A[foo@bar] -->|@x| B[qux@z]")).toEqual({
			code: 'A["foo@bar"] -->|"@x"| B["qux@z"]',
			fixes: ["edge |@x|", "A […]", "B […]"],
		});
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
	const nodeCheck = nodeCheckSandbox();
	afterAll(() => nodeCheck.cleanup());

	it("preserves regex backslashes in the serialized source", () => {
		const src = quoteBareLabels.toString();
		expect(src).toContain("\\w"); // lost \w → backslashes corrupted
		expect(src).toContain("\\s"); // lost \s → backslashes corrupted
		expect(src).toContain("\\["); // lost \[ → backslashes corrupted
		expect(src).toContain("\\|"); // PIPE_RE \| — lost \| → edge labels break
	});

	it("serializes to a syntactically valid named function declaration", () => {
		expect(() => nodeCheck.check(quoteBareLabels.toString())).not.toThrow();
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
			"A -->|@HttpExchange| B",
			"A -. @x .-> B",
			"A -- @x --> B",
		];
		for (const c of cases) {
			expect(reimpl(c)).toEqual(quoteBareLabels(c));
		}
	});
});
