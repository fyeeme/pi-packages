# Changelog

## [Unreleased]

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
