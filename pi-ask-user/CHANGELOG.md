# Changelog

## [Unreleased]

## [2.0.1] - 2026-08-27

Renamed to `@fyeeme/pi-ask-user` (formerly `@fyeeme/pi-omp-ask`, whose 2.0.0 release carried this codebase); the lightweight `ask_user` extension formerly published under this name now lives as `@fyeeme/pi-ask-user-lite`.

### Changed

- README synced with the current code: per-answer-note and chat-redirect references removed, the transcript description updated to the compact one-line render, and the timeout expiry wording fixed (recommended option, not "noted or recommended"); added a sister-extension comparison table and a user-facing Features section.
- Transcript subtraction: `renderResult` now renders one compact `question → answer` line per question (multi-question lines prefixed `[id]`) instead of a framed block that re-listed every option with radio/checkbox markers; unselected options no longer appear in the transcript, and the framed chrome (`FramedComponent`) is gone.
- The Submit review tab now appears only for 3+ questions or any `multi` question; 1–2 single-select questions advance Enter-to-submit without a review page.
- Side-by-side preview: on wide terminals (inner width ≥ 80) questions carrying previews split into an options pane and a preview pane that follows the cursor (fzf-style, anchored at the top of the body); narrow terminals keep the inline preview under each option.

### Fixed

- IME drift in the custom-input prompt, fixed the way pi's TUI documents it (Focusable / "Container Components with Embedded Inputs"): the dialog now implements `Focusable` (propagating focus to an embedded pi-tui `Input` while the prompt is open), and the `Input` renders the input line itself — emitting `CURSOR_MARKER` at the cursor so the TUI positions the hardware cursor and the IME candidate window at the input point — with the full pi-tui input semantics for free: multi-char CJK IME commits, grapheme-aware cursor/delete (emoji as one unit), bracketed paste buffering, kitty CSI-u printable decoding, undo, and kill ring.
- Transcript no longer shows the questions twice around an ask: `renderCall` now renders only a `Ask · N questions`
  summary line while the dialog is pending, and the full framed question/options/answer block renders once from
  `renderResult` after the user answers. omp updates the framed block in place; pi's `ToolExecutionComponent` appends
  result renders below call renders, so the call-side block was removed instead of duplicated. The call-side
  streaming-args normalization (`normalizeRenderOptions`/`normalizeRenderQuestions`) became dead code and was removed.
### Removed

- The per-answer note subsystem (`n` key, `✎ note` markers, note lines in the Submit review and transcript, `note` fields in results/details, and the legacy path's note plumbing).
- Dead chat-redirect surface: `ExtensionAskDialogChatResult`, `AskToolDetails.chatRedirect`/`questions`, and the unreachable `kind: "chat"` branches (the dialog never produced a chat result).


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
