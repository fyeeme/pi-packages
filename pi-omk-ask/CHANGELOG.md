# Changelog

## [Unreleased]

### Fixed

- Transcript no longer shows the questions twice around an ask: `renderCall` now renders only a `Ask · N questions`
  summary line while the dialog is pending, and the full framed question/options/answer block renders once from
  `renderResult` after the user answers. omp updates the framed block in place; pi's `ToolExecutionComponent` appends
  result renders below call renders, so the call-side block was removed instead of duplicated. The call-side
  streaming-args normalization (`normalizeRenderOptions`/`normalizeRenderQuestions`) became dead code and was removed.

## [0.1.0] - 2026-08-23

### Fixed

- Embedded prompt (Other/note) submit ordering: the input is now applied to state before the deferred timeout runs, so a countdown that expires mid-typing keeps the user's answer instead of discarding it and force-picking (omp `#promptForCustomInput` ordering; the old behavior was also asserted by a test, now corrected).
- Transcript rendering now measures at the live frame width instead of a hardcoded 80 columns, so narrow terminals no longer clip question text.
- `raceWithSignal` propagates dialog failures instead of swallowing them as a phantom "user cancelled" outcome (matches omp `untilAborted` and the local legacy-path helper).
- Restored omp's `helpText` construction for the legacy path's select dialogs.

### Changed

- Terminal bell on ask can be disabled with `PI_OMK_ASK_NOTIFY=0`; the `timeoutSeconds` schema description now states exactly when the countdown resets and what expiry picks.
- Removed unused imports and zero-call-site helper exports; typed the test harness result.

### Added

- Source migration of oh-my-pi's `ask` tool into a pi extension: `AskTool.execute` (chat redirect, empty-single-select cancellation, multi-question navigation loop), the tabbed `AskDialogComponent` (Submit review tab, radio/checkbox markers, per-answer notes, markdown/code previews, fixed-height panel, cursor-following scroll, inactivity countdown with deferred expiry mid-prompt), the legacy per-question selector path (multi-select toggle loop, `+ Done selecting`, timeout tolerance heuristic), the countdown timer, overlay box chrome, theme symbol defaults, and the `ask.md` tool description.
- pi host adaptation: rich dialog via `ctx.ui.custom()`, RPC degradation to native `ui.select`/`ui.editor`, headless hiding through `session_start` + `setActiveTools` with an execute backstop, `executionMode: "sequential"` in place of omp's exclusive concurrency, `timeoutSeconds` parameter replacing the settings-driven `ask.timeout`, terminal bell replacing desktop notifications, and keybinding-aware select keys via the injected `KeybindingsManager`.
- omp error semantics: cancel aborts the agent turn (`ctx.abort()` + tool error); unreachable hosts raise a distinct "question was never shown" error.
- 45 tests covering the dialog component, the legacy selector logic (driven against the full omp UIContext contract), and the tool's host gating.
