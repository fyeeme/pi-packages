# Changelog

## [Unreleased]

## [2.0.2] - 2026-09-09

### Fixed

- `ask_user` no longer crashes in RPC mode: `ctx.ui.custom()` is TUI-only (it resolves to `undefined` under RPC), so RPC hosts now degrade to native `select`/`input` dialogs — multi-select via a "Done selecting" pick loop, "Other" via `input`, and timeout auto-selecting the recommended options.

## [2.0.1] - 2026-08-27

First release under the `@fyeeme/pi-ask-user-lite` name; the entries below describe the 2.0.0 feature set published under the old `@fyeeme/pi-ask-user` name (code is identical apart from the rename).

### Added

- Review page: multi-question dialogs summarize all answers (custom inputs, notes, unanswered warnings) after the last question; `enter` confirms, `left` revises before submitting. Single-question dialogs keep submitting immediately.
- Per-question status strip (`●`/`○` chips labeled with `header`) showing which questions are answered.
- Inline free-text editor for `Other` answers and notes: the option list stays visible while typing, `esc` returns to the rows, an empty submit declines, and revising prefills the previous text. The dialog no longer closes and reopens around a plain input.
- Numbered options: rows render `1. label` and answers echo the number back to the LLM (`auth: 1. JWT`).
- `tab` / `shift+tab` as aliases for `right` / `left` question navigation.

### Fixed

- Single-select questions no longer look multi-selectable: `space` is now a no-op outside `multi` mode, and selecting a different option replaces the previous `(o)` marker instead of stacking another one.
- Multi-select `enter` with nothing checked is now a no-op instead of recording an empty answer that lit the status chip `●` but echoed `(no selection)` back to the LLM. Users who mean "none of these" can say so via `Other`.

### Changed

- Submitting a custom `Other` answer now also clears stale checkbox marks from the same question.
- Answering a revisited question now jumps to the next unanswered question (or straight to the review page when everything is answered) instead of always stepping one forward and forcing a re-walk of already-answered questions.
- Renamed `@fyeeme/pi-ask-user` → `@fyeeme/pi-ask-user-lite` (directory renamed to match); the 2.0.0 npm release happened under the old `@fyeeme/pi-ask-user` name. The omp ask port formerly published as `@fyeeme/pi-omp-ask` now owns the `pi-ask-user` name (tool `ask`).
- README: rename narrative corrected, a sister-extension comparison table (pi-ask-user vs pi-ask-user-lite) added, and the inline-editor (pi-tui `Editor` embedding) and compact transcript features documented.


## [1.2.0] - 2026-07-20

### Added

- `/ask-demo` command: interactive four-phase battery covering all question types, free-form `Other` input, timeout auto-selection, chat redirect, and cancel semantics — each phase reports the exact text the LLM would receive.

## [1.1.0] - 2026-07-20

### Added

- Single full-screen dialog for all questions: `[n/m]` progress counter, `←`/`→` navigation between questions, answer revision with preserved cursor/selection state.
- `timeoutSeconds` parameter: overall budget; on expiry unanswered questions auto-select the recommended option and are flagged `timedOut` in the result.
- `header` question chip, option `preview` lines rendered under the cursored row, and `note` attachment via the `n` key.
- `Chat about this` reserved row: ends the call with a `chatRedirect` result so the LLM can switch to discussion.
- Reserved-label collision check in the execution path (fails fast instead of rendering duplicate rows).
- Agent abort now closes an open dialog and settles the tool as cancelled instead of leaving it pending.

### Changed

- Multi-select `enter` records the current checkbox set as-is (`space` toggles); re-selecting a single-select option replaces a previous custom input.

## [1.0.0] - 2026-07-20

### Added

- `ask_user` tool: multi-question clarifying prompts with single/multi select, recommended defaults, option descriptions, and free-form "Other" input.
- Custom TUI picker (radio/checkbox) rendered via `ctx.ui.custom`; answers persisted in tool result details for branch-safe replay.
