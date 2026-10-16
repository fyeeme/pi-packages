# Changelog

## [1.0.3] - 2026-10-16

### Added

- **Split view is now a live editor** (live preview on the left, editable source on the right): the read-only source box became a textarea with a line-number gutter (scroll-synced), Tab inserts an indent, and edits re-render the diagram after a 400ms debounce. Parse errors keep the last good diagram visible next to the message instead of blanking the canvas; re-renders triggered by edits preserve the user's pan/zoom (only untouched views refit). Auto-fixed source is written back into the editor so the fix is visible.
- **Toolbar redrawn to mermaid.live's floating-pill language** (from its toolbar screenshot): one white, fully-rounded pill with thin vertical dividers and 20px/2px-stroke icons — corner-bracket **Fullscreen** toggle (new, with `aria-pressed` state), magnifier-minus / magnifier-plus zoom, and a diagonal **Fit to view** arrow replacing the circular-reset icon (same `zoom(0)` fit+center action). The zoom % is visually hidden (`sr-only`, aria-live kept) so the pill stays icon-only; the hand-drawn/grid toggles are plain icons whose active state recolors to the accent instead of boxing; text buttons are transparent and take the pill surface, coloring on hover.
- **Hand-drawn look toggle** and **grid background toggle** (the two controls from mermaid.live's floating toolbar, reverse-engineered from its `rough`/`grid` URL state): a new two-button pill in the toolbar, both settings persist via localStorage like the download format. Hand-drawn replicates mermaid.live's actual pipeline — a classic render post-processed through **svg2roughjs@3.2.3** — NOT mermaid's native `look:"handDrawn"`, which paints clusters in saturated accents instead of the pastel fills the classic `redux-color` theme produces. Any rough-step failure degrades to the classic render.
- **svg-pan-zoom-style pan/zoom engine** (reverse-engineered from mermaid.live's `PanZoomState`, which wraps the svg-pan-zoom library): the canvas now drives the SVG **viewBox** instead of stacking CSS `left/top` offsets on top of `text-align:center` — wheel zoom anchors at the cursor (`zoomAtPoint` semantics), drag-to-pan runs on one captured pointer stream, every fresh render refits and recenters (`fit:true center:true`), and a ResizeObserver refits untouched views. Zoom range matches svg-pan-zoom (20%–1200% of fit). This eliminates the drift: cursor-anchored zoom verified at 0.0000 drift, drag mapping exact to <0.01 unit, pan round-trips accumulate zero error. Fixed in the same pass: mermaid's `useMaxWidth` inline `max-width` clamped the canvas back to natural size (top-left parking), and a broken `height:100%` chain (`#svg` div had no height) let the SVG's intrinsic ratio inflate the viewport.
- **mermaid@12.2.0 pinned (the version mermaid.live runs) with `redux-color` as the default theme** — white node fills, black strokes, pastel cluster fills (`#FDF4FF`/`#F0FDFA`), dark backgrounds map to `redux-dark-color`; no configuration needed — and the **canvas grid matches mermaid.live exactly** (2px dots on a 30px pitch, measured from its shipped CSS). ZenUML re-verified compatible with 12.2.0.
- **Full mermaid@11 diagram coverage** (parity with mermaid.live): FontAwesome icon nodes (`fa:fa-*`, `icon:*`) now load the FA webfont in `<head>` and wait for it before the first render; ZenUML registers at runtime from `@mermaid-js/mermaid-zenuml` (CDN); the lazy ELK layout chunks (`flowchart-elk`) were verified to render from the CDN build with no registration. Exported SVGs with icon nodes embed the FA stylesheet so glyphs survive outside the page.

### Changed

- **Source layout**: the single 34KB `index.ts` is split into `src/` modules (`healer` / `theme` / `extract` / `browser` / `page-script` / `render`), mirroring mermaid.live's util-layer separation; `index.ts` stays the extension entry and re-exports the public API. Tests split per unit under `test/` (with golden-vector round-trips and a `node --check` sandbox that no longer leaks temp files).

### Fixed

- **Washed-out labels on light/white themes**: `body{color:#c9d1d9}` hardcoded the dark-theme text color, and mermaid's foreignObject labels inherit the page color — cluster titles rendered light gray on light backgrounds (both in the page and in svg2roughjs output). Body color now follows the theme variable.
- **tsx `__name` crash in the heal-retry path**: under tsx (pi's extension runtime), esbuild's keepNames wraps the healer's inner arrow functions with `__name()` helpers, so the browser-injected `quoteBareLabels` threw `__name is not defined` on every parse-failure retry — invisible to vitest, whose transpiler does not inject keepNames. The page now defines an identity `__name` fallback before the injected function (caught by Chrome DevTools visual verification).
- **Script-tag escape**: the serialized `DIAGRAMS` payload now escapes `<` (plus U+2028/2029) — a diagram whose source contains `</script>` can no longer terminate the page's module script and break the whole preview.
- **Tmp accumulation**: `/mermaid` writes to a per-process fixed path (`pi-mermaid-preview-<pid>.html`, overwritten each run) instead of leaving a timestamped file behind on every invocation.
- **Cross-platform theme detection**: Linux (GNOME `gsettings color-scheme`) and Windows (`AppsUseLightTheme` registry) now detect dark mode; previously only macOS was probed and everything else fell back to light.
- Doc drift: PNG export renders at 3x (scale = 3), not 2x — README and a test title said 2x.

## [1.0.2] - 2026-10-02

### Changed

- Dev toolchain pinned to `@earendil-works/pi-coding-agent` 1.0.0 (peer floors unchanged, `>=0.99.0`); typecheck and tests pass against 1.0.0 unchanged.

## [1.0.1] - 2026-10-01

### Changed

- Peer dependency floor raised to `@earendil-works/pi-coding-agent >= 0.99.0`; dev toolchain pinned to 0.99.2 (typecheck and tests pass against 0.99.2 unchanged).


## [1.0.0] - 2026-06-15

### Fixed
- **Format-switcher menu was invisible.** The `.dl-split` container had `overflow:hidden` (for rounded corners), which clipped the absolutely-positioned `.dl-pop` format menu — it existed in the DOM but was neither visible nor clickable (`elementFromPoint` hit the canvas behind it). Removed `overflow:hidden` and moved the rounding to the individual buttons. SVG/PNG export itself was unaffected.
- **PNG export silently failed** (download never triggered). Root cause: the `EMOJI_RE` regex was authored inline inside the `renderHtml` template literal, whose backslash-eating corrupted `/[\p{Emoji...}]/gu` into `/[p{Emoji...}]/gu`. As a character class that matches the literal letters p/E/m/o/j/i/..., it stripped ~45% of every exported SVG, so the `<img>` used to rasterize failed to load (`onerror`), `img.onload` never fired, and PNG export hung forever. SVG export was unaffected (it serves the blob directly). Fixed by authoring the regex source at module scope and injecting it, like `quoteBareLabels`.

### Changed
- **Toolbar: zoom controls moved inline with the main buttons.** The zoom bar is no longer a separate fixed-centered element; it now sits left of the main button group inside the right-aligned toolbar, with an 8px gap between the two groups.
- **Download: one-click split button.** Replaced the two-step dropdown with a split button: clicking `[⬇ PNG]` downloads PNG immediately; the small `[▾]` caret opens a format picker (PNG/SVG). The chosen format is shown on the main button and remembered across renders via `localStorage` (`mv:dlFormat`).
- **Toolbar stays right-aligned and no longer wraps** (`white-space:nowrap`, removed `flex-wrap`).
- **Try-first / fix-on-failure rendering.** Source is now passed to Mermaid verbatim; the bare-label healer (`quoteBareLabels`) runs *only* if Mermaid rejects the original, then retries once. This makes it structurally impossible to corrupt valid source. The previous up-front `sanitize()` re-wrapped already-correct `subgraph ID["…()"]` lines in extra quotes, causing guaranteed parse errors on method names containing `()`.
- The healer now correctly skips the canonical `subgraph ID[...]` form (not just `subgraph [...]` / `subgraph "..."`).
- Healed source is surfaced in the split view / copy when a fix succeeds; the notice reads "Auto-fixed" instead of "Sanitized".

### Added
- Initial release: `/mermaid` command to render Mermaid diagrams from the conversation in the browser.
- Supports dark, light, and white backgrounds.
- Zoom controls and 2x PNG export.
- Split view to see source code alongside rendered diagram.
- Emoji and special-character sanitization for Mermaid compatibility.
- Auto-quoting node labels containing `?`, `@`, `<`, `>`, `/`, `&`, `#`, `!` (and `(){}[]`) across all common shapes: rectangle, rhombus, rounded, circle, hexagon, subroutine, cylinder, parallelogram. Fixes parse errors like `B{注解?<br/>@Transactional}`.
- Emoji support: emoji are now preserved and rendered natively (previously stripped). Verified with Mermaid v11 + `securityLevel: "loose"` + `htmlLabels: true`. Emoji are kept on screen but stripped from SVG/PNG exports for portability.
- Multi-diagram navigation when conversation contains multiple blocks.
- Unit tests for the redesign in `test/mermaid-viewer.test.ts` (vitest, 98 cases): `quoteBareLabels` healing/idempotency + the regression that motivated try-first, the `toString()` template-injection invariant (guards the backslash-eating gotcha), and `renderHtml` output validity (`node --check` on the generated `<script>`, healer injected, no stale `sanitize`/`d.fixes`). Added `"test": "vitest --run"` script.
- **Edge labels are now auto-quoted.** The healer previously covered only node labels and skipped edge labels entirely (the suite even asserted `// Edge labels are untouched`), so a link like `A -->|@HttpExchange| B` failed with `Parse error ... got 'LINK_ID'` and no fix was attempted. `quoteBareLabels` now heals all three Mermaid edge-label forms — pipe `|text|`, dotted `-. text .->`, and dash `-- text -->` / `-- text ---` — quoting any bare label containing a special char (`@`, `/`, `()`, …). Labels are stashed behind placeholders before the node-shape pass, so `|foo(x)|` is never mistaken for a node `foo(x)`. Added 13 edge-label cases + 3 `toString()` re-eval cases (111 tests total).
