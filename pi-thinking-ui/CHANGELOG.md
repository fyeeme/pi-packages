## [Unreleased]

## [1.1.0] - 2026-08-08

### Removed

- Internal monkeypatch of pi compiled modules (`internal-patch.ts`, `render.ts`) — thinking rendering no longer imports `dist/modes/interactive/...` internals; it now uses the provided `registerMarkdownTransformer` hook only.

### Changed

- Thinking rendering rebuilt on `registerMarkdownTransformer` (new `markdown-render.ts`): `collapsed` → one blockquote line (role icon + summary), `summary` → bullet list of derived step summaries (capped, `… (+N more)` tail), `expanded` → passthrough. Reuses the pure-heuristic `parse.ts` engine.
- Streaming: the full heuristic derivation now runs only on finalize/restore/resize; during streaming a cheap first-line view is shown for `collapsed` (pi's transformer contract requires synchronous, inexpensive transformers).
- `state.ts` slimmed: removed patch bookkeeping and the now-unused active-thinking-state / message-scope-ownership subsystems.
- Mode switching re-renders via the existing `refreshThinkingUI` (`setHiddenThinkingLabel` toggle); mode resolution for rendering is process-global (transformer context carries no message/scope identity).

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
