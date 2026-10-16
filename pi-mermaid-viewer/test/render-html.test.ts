import { afterAll, describe, expect, it } from "vitest";
import { renderHtml } from "../index.ts";
import type { DiagramData } from "../index.ts";
import { nodeCheckSandbox } from "./helpers.ts";

// ============================================================================
// renderHtml
// ============================================================================
// renderHtml emits a self-contained page: CSS + markup + a generated ES
// module script that dynamically imports mermaid from a CDN. These tests
// assert the page contract from the Node side — payload serialization, theme
// wiring, UI structure, and that the generated script stays valid browser JS.
// Many assertions look like change-detectors, but each pins an invariant that
// previously regressed (see the inline comments); do not weaken them.

const page = (diagrams: DiagramData[] = [], theme: "dark" | "light" = "dark") =>
	renderHtml(diagrams, theme);

const sample = (): DiagramData[] => [{ code: "A --> B", label: "D" }];

describe("renderHtml", () => {
	describe("payload & theme", () => {
		it("embeds diagram data as JSON in the script tag", () => {
			const html = page([{ code: "graph TD\n  A --> B", label: "Diagram 1" }]);
			expect(html).toContain('"code":"graph TD\\n  A --> B"');
			expect(html).toContain('"label":"Diagram 1"');
		});

		it("sets body class based on theme", () => {
			expect(page([], "dark")).toContain('class="bg-dark"');
			expect(page([], "light")).toContain('class="bg-light"');
		});

		it("sets INIT_BG variable to the theme in script", () => {
			expect(page([], "dark")).toContain('INIT_BG = "dark"');
		});

		it("initializes the custom theme dropdown label + active item", () => {
			const html = page([], "light");
			expect(html).toContain('getElementById("bg_label")');
			expect(html).toContain('data-bg="dark"');
			expect(html).toContain('data-bg="light"');
			expect(html).toContain('data-bg="white"');
			expect(html).not.toContain('id="bgsel"'); // native select removed
		});

		it("handles empty diagrams array", () => {
			const html = page([], "dark");
			expect(html).toContain("const DIAGRAMS = []");
			expect(html).toBeTruthy();
		});

		it("embeds multiple diagrams correctly", () => {
			const html = page([
				{ code: "A --> B", label: "#1" },
				{ code: "C --> D", label: "#2" },
			]);
			expect(html).toContain('"code":"A --> B"');
			expect(html).toContain('"code":"C --> D"');
			expect(html).toContain('"label":"#1"');
			expect(html).toContain('"label":"#2"');
		});

		it("gates tab creation on diagram count", () => {
			// Tabs are only built when more than one diagram exists; with one
			// diagram the tabs bar stays empty (`Tabs:empty{display:none}`).
			const html = page(sample());
			expect(html).toContain("if (DIAGRAMS.length > 1)");
		});

		it("does NOT embed a fixes field in the diagram JSON (try-first redesign: fixes are computed in-browser on retry)", () => {
			const html = page(sample());
			// The DIAGRAMS JSON payload must not carry a per-diagram fixes field.
			const payload = html.match(/const DIAGRAMS = (\[.*?\]);/s)?.[1] ?? "";
			expect(payload).not.toMatch(/"fixes"/);
			expect(payload).toContain('"code"');
			expect(payload).toContain('"label"');
		});

		it("produces valid HTML structure with all key elements", () => {
			const html = page(sample());

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
			expect(html).not.toContain(">SVG</button>");
			expect(html).not.toContain(">PNG</button>");
		});
	});

	describe("canvas layout", () => {
		it("renders toolbar with position:fixed overlay", () => {
			expect(page(sample())).toMatch(/\.bar\{position:fixed/);
		});

		it("renders canvas viewport with overflow:hidden", () => {
			expect(page(sample())).toMatch(/canvas-viewport\{[^}]*overflow:hidden/);
		});

		it("zoom bar is grouped inside the toolbar (.grp), not fixed-centered", () => {
			const html = page(sample());
			expect(html).not.toMatch(/\.zoom-bar\{position:fixed/);
			expect(html).not.toContain("transform:translateX(-50%)");
			// It lives inside .bar now, as a .grp sibling of the main button group.
			expect(html).toContain('class="grp" id="zb"');
		});

		it("canvas viewport has top padding for floating bars", () => {
			expect(page(sample())).toMatch(/canvas-viewport\{[^}]*padding:60px 24px 24px 24px/);
		});

		it("tabs use position:fixed overlay", () => {
			expect(page(sample())).toMatch(/\.tabs\{position:fixed/);
		});

		it("zoom bar is nested inside .bar (no longer a standalone fixed element)", () => {
			const html = page(sample());
			expect(html).not.toContain('class="zoom-bar" id="zb"');
			expect(html).toContain('class="grp" id="zb"');
		});

		it("loading indicator exists with Loading diagram... text", () => {
			const html = page(sample());
			expect(html).toContain('class="loading" id="ld"');
			expect(html).toContain("Loading diagram...");
		});

		it("error div is inside canvas-viewport", () => {
			const h = page(sample());
			const canvasStart = h.indexOf('id="canvas-viewport"');
			const errPos = h.indexOf('class="err" id="er"');
			expect(errPos).toBeGreaterThan(canvasStart);
		});
	});

	describe("zoom & icon controls", () => {
		const zoomButtons = [
			{ id: "zout", title: "Zoom out" },
			{ id: "zin", title: "Zoom in" },
			{ id: "zreset", title: "Fit to view" },
		];

		it.each(zoomButtons)("$id button has an SVG child", ({ id }) => {
			expect(page(sample())).toMatch(new RegExp(`${id}[^>]*>\\s*<svg`));
		});

		it.each(zoomButtons)("$id button has title and aria-label", ({ id, title }) => {
			expect(page(sample())).toMatch(
				new RegExp(`id="${id}"[^>]*title="${title}"[^>]*aria-label="${title}"`),
			);
		});

		it("fullscreen button wires the Fullscreen API with pressed state", () => {
			const html = page(sample());
			expect(html).toContain('id="fs_btn"');
			expect(html).toContain("requestFullscreen");
			expect(html).toContain("fullscreenchange");
			// Esc exits natively; the button only toggles
			expect(html).toContain("document.exitFullscreen()");
		});

		it("fit button uses the diagonal expand icon; groups separated by thin dividers", () => {
			const html = page(sample());
			const fit = html.slice(html.indexOf('id="zreset"'), html.indexOf("</button>", html.indexOf('id="zreset"')));
			expect(fit).toContain('M4 20 20 4'); // diagonal expand arrow
			expect(html).toContain('class="vsep"');
		});

		it("no loud per-button hover colors (unified subtle hover only)", () => {
			const html = page(sample());
			expect(html).not.toContain("#e94560");
			expect(html).not.toContain("split-toggle");
		});

		it("all hovers share one subtle theme tint (--hover), not the heavy field fill", () => {
			const html = page(sample());
			expect(html).toContain("--hover:rgba(255,255,255,.08)");
			expect(html).toContain("--hover:rgba(36,41,47,.06)");
			expect(html).toContain("--hover:rgba(0,0,0,.05)");
			// toolbar hovers must use it
			expect(html).toContain(".bar button:hover,.bar select:hover{background:var(--hover)}");
			expect(html).toContain(".bar .ib:hover{background:var(--hover)}");
		});

		it("keyboard mapping: Cmd/Ctrl +/- zoom and Cmd/Ctrl+0 fits (page zoom prevented)", () => {
			const html = page(sample());
			expect(html).toContain('document.addEventListener("keydown"');
			expect(html).toContain('e.key === "-" || e.key === "_"');
			expect(html).toContain('e.key === "=" || e.key === "+"');
			expect(html).toContain('e.key === "0"');
			// the browser page-zoom must not fire alongside the canvas zoom
			const hits = (html.match(/e\.preventDefault\(\); window\.zoom\(/g) || []).length;
			expect(hits).toBe(3);
		});

		it("zoom % is visually hidden — the pill stays icon-only like the reference", () => {
			const html = page(sample());
			expect(html).toMatch(/id="zl" class="sr-only"/);
			expect(html).toContain("clip:rect(0,0,0,0)");
		});

		it("view toggles are plain icons; active state recolors only", () => {
			const html = page(sample());
			expect(html).toMatch(/id="rough_btn" title="Hand-drawn look"[^>]*class="ib"|class="ib" id="rough_btn"/);
			expect(html).toContain("#vt button.on{color:var(--accent)}");
			expect(html).not.toContain("#vt button.on{color:var(--accent);background");
		});

		it("zoom percentage label has aria-live=polite", () => {
			expect(page(sample())).toMatch(/id="zl"[^>]*aria-live="polite"/);
		});

		it("zoom percentage label has role=status", () => {
			expect(page(sample())).toMatch(/id="zl"[^>]*role="status"/);
		});

		it("buttons have focus-visible style for keyboard nav", () => {
			expect(page(sample())).toContain("focus-visible");
		});

		it("zoom bar is a rounded pill (mermaid.live floating toolbar)", () => {
			expect(page(sample())).toMatch(/zoom-bar\{[^}]*border-radius:9999px/);
		});

		it("zoom bar buttons use currentColor for SVGs", () => {
			expect(page(sample())).toContain("stroke:currentColor");
		});

		it("wheel handler zooms (covers trackpad pinch, which sends ctrl+wheel)", () => {
			const html = page(sample());
			expect(html).toContain('addEventListener("wheel"');
			expect(html).toContain("preventDefault");
		});

		it("disabled buttons have reduced opacity and no pointer events", () => {
			expect(page(sample())).toMatch(/button:disabled\{opacity:\.3;pointer-events:none\}/);
		});
	});

	describe("interaction states (viewBox pan/zoom engine)", () => {
		const script = () => page();

		it("zooms and pans via the SVG viewBox, not width/height or CSS offsets", () => {
			const s = script();
			expect(s).toContain('setAttribute("viewBox"');
			expect(s).toContain('preserveAspectRatio');
			expect(s).not.toContain("svgNaturalW"); // old natural-size scaling gone
		});

		it("wheel zoom is cursor-anchored (svg-pan-zoom zoomAtPoint)", () => {
			const s = script();
			expect(s).toContain('addEventListener("wheel"');
			expect(s).toContain("function zoomAt(mx, my, factor)");
			// plain wheel zooms — no ctrl/meta gate
			expect(s).not.toContain("e.ctrlKey || e.metaKey");
		});

		it("fit + center on every fresh render (svg-pan-zoom fit/center)", () => {
			const s = script();
			expect(s).toContain("function resetView()");
			// called from the render success branch ("Fit + center every fresh render")
			expect(s).toContain("// Fit + center fresh renders");
			// refit untouched views; live-edit re-renders keep the user's pan/zoom
			expect(s).toContain("if (pz.dirty) applyVB(); else resetView();");
			// natural bounds are cached per render — re-reading the viewBox after
			// applyVB would compute fit from our own output (drifted resets)
			expect(s).toContain("function captureNatural()");
		});

		it("zoom range matches svg-pan-zoom (0.2–12 → 20%–1200% of fit)", () => {
			const s = script();
			expect(s).toContain("rel >= MAX_REL");
			expect(s).toContain("rel <= MIN_REL");
		});

		it("single pointer stream with capture — the dual-listener drift source is gone", () => {
			const s = script();
			expect(s).toContain("setPointerCapture");
			expect(s).not.toContain('addEventListener("mousemove"');
			expect(s).not.toContain("style.left = _panX"); // CSS-offset pan gone
		});

		it("ResizeObserver refits when the user has not moved the view", () => {
			const s = script();
			expect(s).toContain("new ResizeObserver");
		});

		it("updateZoomButtons function exists in script", () => {
			expect(script()).toContain("function updateZoomButtons()");
		});
	});

	describe("export: PNG/SVG and emoji stripping", () => {
		it("export scales canvas to 3x natural SVG dimensions", () => {
			const html = page();
			expect(html).toContain("svgNaturalSize");
			expect(html).toContain("const scale = 3");
			expect(html).toContain("canvas.width = w * scale");
		});

		it("export uses current theme background color", () => {
			expect(page()).toContain("bgFill[currentBg]");
		});

		it("export PNG reads SVG viewBox for true 3x resolution", () => {
			const html = page();
			expect(html).toContain("viewBox?.baseVal");
			expect(html).toContain("getBBox");
		});

		it("SVG export serializes and downloads SVG file", () => {
			const html = page();
			expect(html).toContain("exportSvg");
			expect(html).toContain("image/svg+xml");
			expect(html).toContain(".svg");
		});

		it("defines an emoji regex constant for export", () => {
			const html = page();
			expect(html).toMatch(/EMOJI_RE/);
			expect(html).toMatch(/Emoji_Presentation/);
		});

		it("exportSvg strips emoji after serialization", () => {
			const html = page();
			const svgFn = html.slice(html.indexOf("window.exportSvg"), html.indexOf("window.exportPng"));
			expect(svgFn).toMatch(/serializeToString\(clone\)\.replace\(EMOJI_RE/);
		});

		it("exportPng strips emoji after serialization", () => {
			const html = page();
			const pngFn = html.slice(html.indexOf("window.exportPng"));
			expect(pngFn).toMatch(/serializeToString\(svgEl\)\.replace\(EMOJI_RE/);
		});
	});

	describe("generated module script is valid browser JS", () => {
		const nodeCheck = nodeCheckSandbox();
		afterAll(() => nodeCheck.cleanup());

		function extractScript(html: string): string {
			const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
			if (!m) throw new Error("no module script found in HTML");
			return m[1];
		}

		it("passes `node --check` on the full generated script", () => {
			const script = extractScript(page([{ code: "flowchart TD\nA-->B", label: "t" }]));
			expect(() => nodeCheck.check(script)).not.toThrow();
		});

		it("injects quoteBareLabels verbatim into the page", () => {
			expect(page([{ code: "flowchart TD\nA-->B", label: "t" }])).toContain(
				"function quoteBareLabels(code)",
			);
		});

		// --- tsx keepNames regression ---
		// Under tsx (the runtime pi uses for extensions), esbuild wraps the
		// healer's inner arrow functions with __name(fn, "...") helpers. The
		// serialized source then references a bare __name in the browser and
		// every heal-retry threw "__name is not defined" — invisible to vitest,
		// whose transpiler does not inject keepNames. The page now defines an
		// identity fallback before the injected function.
		it("defines an identity __name fallback before the injected healer", () => {
			const html = page([{ code: "flowchart TD\nA-->B", label: "t" }], "dark");
			const polyfill = html.indexOf("var __name =");
			const healer = html.indexOf("function quoteBareLabels(code)");
			expect(polyfill).toBeGreaterThan(-1);
			expect(healer).toBeGreaterThan(polyfill);
		});

		it("contains no stale sanitize() call or d.fixes reference", () => {
			const html = page([{ code: "flowchart TD\nA-->B", label: "t" }]);
			expect(html).not.toMatch(/\bsanitize\s*\(/);
			// `healed.fixes` is legit; `d.fixes` (DiagramData.fixes) must be gone.
			expect(html).not.toMatch(/(?<![a-zA-Z])d\.fixes\b/);
		});

		// --- EMOJI_RE template-backslash regression ---
		// The regex used to be authored inline in the renderHtml template literal,
		// which ate its backslashes: /[\p{Emoji...}]/gu → /[p{Emoji...}]/gu. As a
		// character class the broken regex matched the literal letters p/E/m/o/j/i/...
		// and stripped ~45% of every exported SVG, so Image.onerror fired and PNG
		// export silently never downloaded. SVG export survived only because it
		// serves a blob directly without round-tripping through an <img>.
		// The whole page script is now authored in String.raw (src/page-script.ts):
		// regex literals keep their backslashes verbatim, with no runtime
		// `new RegExp` assembly and no regex-source-string injection.
		it("EMOJI_RE is an inlined regex literal with backslashes intact (String.raw)", () => {
			const html = page([{ code: "flowchart TD\nA-->B", label: "t" }]);
			expect(html).toContain("const EMOJI_RE = /[\\p{Emoji_Presentation}");
			expect(html).not.toContain('new RegExp("'); // no runtime regex assembly
		});

		// --- dl-split overflow:hidden regression ---
		// The format-picker menu (.dl-pop) is absolutely positioned below .dl-split.
		// If .dl-split has overflow:hidden, the menu is clipped — it renders in the
		// DOM (getBoundingClientRect exists) but is invisible AND unclickable
		// (elementFromPoint hits the canvas behind it). Must stay overflow:visible.
		it("dl-split never uses overflow:hidden (would clip the format menu)", () => {
			const html = page([{ code: "flowchart TD\nA-->B", label: "t" }]);
			const m = html.match(/\.dl-split\{([^}]*)\}/);
			expect(m, ".dl-split rule not found").toBeTruthy();
			expect(m![1]).not.toMatch(/overflow:\s*hidden/);
		});
	});

	describe("DIAGRAMS payload escapes script-tag terminators", () => {
		it("a diagram containing </script> cannot terminate the module script early", () => {
			const html = page([
				{ code: "flowchart TD\nA-->B\nclick A callback '</script><img src=x>'", label: "t" },
			]);
			// The raw terminator must never appear inside the serialized payload...
			const payload = html.slice(html.indexOf("const DIAGRAMS = "), html.indexOf("const INIT_BG"));
			expect(payload).not.toContain("</script>");
			// ...and must survive as an escaped sequence the browser parses back to text.
			expect(payload).toContain("\\u003c/script>");
			// The page still closes exactly one module script after the payload.
			expect(html.match(/<\/script>/g)?.length).toBe(html.match(/<script/g)?.length);
		});
	});

	describe("view toggles: hand-drawn look and grid", () => {
		it("renders the two-button pill (rough + grid) with pressed state hooks", () => {
			const html = page();
			expect(html).toContain('class="grp" id="vt"');
			expect(html).toContain('id="rough_btn"');
			expect(html).toContain('id="grid_btn"');
			expect(html).toMatch(/id="rough_btn"[^>]*aria-pressed="false"/);
			expect(html).toMatch(/id="grid_btn"[^>]*aria-pressed="true"/);
		});

		it("hand-drawn look runs the mermaid.live pipeline (classic + Svg2Roughjs), with fallback", () => {
			const html = page();
			// mermaid.live does NOT use look:"handDrawn" (it paints clusters in
			// saturated accents); it roughifies a classic render via svg2roughjs
			expect(html).toContain('localStorage.setItem("mv:look"');
			expect(html).toContain("svg2roughjs@3.2.3/+esm");
			expect(html).toContain("async function roughify(svgText)");
			expect(html).toContain("if (drawLook) svg = await roughify(svg);");
			// a failed rough step must degrade to the classic render
			const roughFn = html.slice(html.indexOf("async function roughify"), html.indexOf('document.getElementById("bg_label")'));
			expect(roughFn).toContain("hand-drawn post-process failed");
			// toggling rough must re-render the diagram
			const roughHandler = html.slice(html.indexOf('getElementById("rough_btn").addEventListener'));
			expect(roughHandler).toContain("render(themeMap[currentBg]");
		});

		it("grid toggle is pure CSS (no re-render) and persists", () => {
			const html = page();
			expect(html).toContain('body.classList.toggle("no-grid", !showGrid)');
			expect(html).toContain("body.no-grid #canvas-viewport{background-image:none}");
			expect(html).toContain('localStorage.setItem("mv:grid"');
			const gridHandler = html.slice(html.indexOf('getElementById("grid_btn").addEventListener'));
			expect(gridHandler).not.toContain("render(");
		});
	});

	describe("full mermaid coverage (parity with mermaid.live)", () => {
		it("links the FontAwesome stylesheet in <head> (icon nodes)", () => {
			const html = page();
			const head = html.slice(0, html.indexOf("<body"));
			expect(head).toContain('rel="stylesheet"');
			expect(head).toContain("@fortawesome/fontawesome-free@6/css/all.min.css");
		});

		it("registers the ZenUML external diagram, degrading silently on CDN failure", () => {
			const html = page();
			expect(html).toContain("registerExternalDiagrams");
			expect(html).toContain("@mermaid-js/mermaid-zenuml@0");
			// Registration failure must not break built-in types.
			const loadFn = html.slice(
				html.indexOf("async function loadMermaid"),
				html.indexOf('document.getElementById("bg_label")'),
			);
			expect(loadFn).toContain("console.warn");
		});

		it("waits for the FontAwesome webfont before rendering icon diagrams", () => {
			const html = page();
			expect(html).toContain("const ICON_SYNTAX_RE = /(?:fa:fa-|icon:)/");
			expect(html).toContain("document.fonts.ready");
		});

		it("embeds the FontAwesome stylesheet into exported SVGs with icon nodes", () => {
			const html = page();
			const svgFn = html.slice(html.indexOf("window.exportSvg"), html.indexOf("window.exportPng"));
			expect(svgFn).toContain("@import url");
			expect(svgFn).toMatch(/ICON_SYNTAX_RE\.test/);
		});
	});
});
