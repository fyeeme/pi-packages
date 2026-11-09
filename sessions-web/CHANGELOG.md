# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-11-09

### Added

- npm `files` now includes `CHANGELOG.md`, so published packages ship the changelog and pi 1.5.0 shows it under "Extension Updates" on the first fresh launch after an update (pi reads `CHANGELOG.md` from the package root by default; no `pi.changelogPath` needed).

### Fixed

- Removed defenses against paths the type system already guarantees: the session-id capture is used directly when decoding (`[^/]+` regex capture is never empty, so `?? ""` is gone), the required `SessionTreeNode.children` array is read without `?? []` in the four tree walks, and the `hasGetTree` runtime guard is gone — `renderViewBody` calls `SessionManager.getTree()` directly.

### Changed

- Dev dependencies now pin `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, and `@earendil-works/pi-tui` at 1.5.0 (was 1.3.0), so type-check and tests run against the pi 1.5.0 types.

## [0.1.0] - 2026-10-29

### Added

- First release: a read-only web viewer for local pi session history. The `/session-web` command starts an HTTP server bound to `127.0.0.1` (default port 8765, `/session-web stop` stops it, the server also closes on session shutdown). The list page groups sessions by project directory with keyword filtering over first messages, session names, working directories, and full message text; the session page renders conversations as user bubbles and markdown assistant replies (marked + highlight.js vendored from the pi package, inlined into the page), folds thinking into collapsible blocks, marks model/compaction changes as status lines, and shows sibling branches as collapsed blocks at each fork point; a `?view=trace` tab shows the raw entry timeline including tool calls. `mermaid` code blocks render as inline diagrams (mermaid fetched lazily from jsdelivr, degrading to highlighted source when offline or invalid). Markdown rendering follows the TUI renderer's support logic (HTML escaped, never rendered); the server is read-only and never writes, resumes, edits, or deletes sessions.
