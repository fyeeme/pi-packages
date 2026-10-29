# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-29

### Added

- First release: a read-only web viewer for local pi session history. The `/session-web` command starts an HTTP server bound to `127.0.0.1` (default port 8765, `/session-web stop` stops it, the server also closes on session shutdown). The list page groups sessions by project directory with keyword filtering over first messages, session names, working directories, and full message text; the session page renders conversations as user bubbles and markdown assistant replies (marked + highlight.js vendored from the pi package, inlined into the page), folds thinking into collapsible blocks, marks model/compaction changes as status lines, and shows sibling branches as collapsed blocks at each fork point; a `?view=trace` tab shows the raw entry timeline including tool calls. `mermaid` code blocks render as inline diagrams (mermaid fetched lazily from jsdelivr, degrading to highlighted source when offline or invalid). Markdown rendering follows the TUI renderer's support logic (HTML escaped, never rendered); the server is read-only and never writes, resumes, edits, or deletes sessions.
