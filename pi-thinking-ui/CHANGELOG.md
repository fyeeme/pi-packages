## [Unreleased]

## [1.0.1] - 2025-07-25

### Changed
- Default thinking view mode is now `collapsed` instead of `summary`
- Step-core cache: completed step summaries are memoized by step text, avoiding re-summarization of unchanged steps during streaming (linearizes per-derive summarization cost)
- Inlined `blocksLengthFingerprint` at its single call site

### Fixed
- Respect the host `hideThinkingBlock` setting: when thinking is hidden, the extension falls back to Pi's native hidden-label renderer instead of forcing the custom thinking UI
- Three-mode thinking visualization: `collapsed`, `summary`, `expanded`
- Deterministic step derivation from raw thinking text
- Semantic role inference with icons and colors
- Scoped persistence (session, project, global) with restore precedence
- `/thinking-ui` command with tab completions
- `Alt+T` shortcut for mode cycling
- Statusline integration via `ctx.ui.setStatus`
- Degraded session fallback when runtime patching fails
