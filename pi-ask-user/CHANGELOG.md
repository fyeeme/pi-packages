# Changelog

## [Unreleased]

## [2.0.6] - 2026-11-09

### Changed

- Removed redundant defensive checks that contradict the type system: the rich-dialog result reconciliation throws in `index.ts` (`#buildResults` builds results 1:1 in `#questions` order), the impossible-input guards in `normalizeDialogQuestions` (typed parameters, typebox-validated upstream), six null guards over the equal-length `#questions`/`#states` loop reads in `src/ask-dialog.ts`, and the non-string branch of `renderInlineMarkdown` (string parameter).
- Removed provably-unreachable guards: the redundant `!ctx.ui` check in `index.ts` (`ui` is required on `ExtensionContext`) and the interval-clear guard in `CountdownTimer#startInterval` (its only caller `#start` runs before `#intervalId` is ever set; `dispose()` keeps its guard).
- Dev dependencies now pin `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, and `@earendil-works/pi-tui` at 1.5.0 (was 1.3.0), so type-check and tests run against the pi 1.5.0 types.

### Fixed

- RPC legacy path: multi questions inside multi-question asks no longer strand the user. pi's `ui.select` cannot fire ←/→ navigation, so the per-question loop now passes `allowForward: false` and the `✓ Done selecting` exit appears once a selection exists; the walk test asserts the option lists.
- Embedded Other-prompt title wraps at the dialog's live render width instead of `process.stdout.columns`, so it is no longer truncated twice inside the frame.
- `ask` schema: question `options` now require at least one item (`minItems: 1`); an empty list previously rendered an Other-only dialog with nothing to auto-select on timeout.
- `engines.node` raised to `>=22.19.0`, matching pi's own floor (the `.ts` source cannot run on Node 18).

### Removed

- `AskDialogOptions.onTimeout` option from `src/ask-dialog.ts` (no caller passed it; timeout auto-pick is internal to the dialog).
- Unused `import { truncateToWidth, visibleWidth }` from `src/compat.ts` (the re-export stays) and unreferenced `SYMBOLS` keys: `nav.selected`, `status.warning`, and the whole `format` entry.
- Dangling trailing JSDoc at the end of `index.ts` (its subject, `untilAborted`, lives in `src/ask-legacy.ts`).

## [2.0.5] - 2026-10-16

### Changed

- Single source of truth for shared ask plumbing: `index.ts` now uses `untilAborted` from `src/ask-legacy.ts` instead of its own byte-identical `raceWithSignal`; `src/ask-dialog.ts` imports `OTHER_OPTION` and `stripRecommendedSuffix` from `src/ask-legacy.ts` instead of redefining them.

### Removed

- Dead exports: `matchesKey`/`Key` re-export from `src/compat.ts` (importers use pi-tui directly), `formatKeyHints`, `RECOMMENDED_SUFFIX`, and the `SelectionResult` type are module-private now (zero external importers). Dropped a duplicated file-header comment block in `src/types.ts` and a ghost `note: undefined` field from a legacy-path test assertion (the note subsystem was removed in 2.0.1).

## [2.0.4] - 2026-10-02

### Changed

- Dev toolchain pinned to `@earendil-works/pi-coding-agent`/`pi-tui` 1.0.0 (peer floors unchanged, `>=0.99.0`); typecheck and tests pass against 1.0.0 unchanged.

## [2.0.3] - 2026-10-01

### Changed

- The `ask` tool now registers with pi 0.99 `exposure: "model-only"`: declared to the model, unreachable from codemode scripts and nested tool execution. No `outputSchema` is declared — model-only tools have no programmatic consumer of structured results. Model-facing dialog behavior is unchanged.
- Peer dependency floor raised to `@earendil-works/pi-coding-agent >= 0.99.0`; dev toolchain pinned to 0.99.2.

## [2.0.2] - 2026-09-09

### Fixed

- Terminal bell fires only in TUI mode (`ctx.mode === "tui"`) — RPC stdout is the JSON protocol channel.
- Removed an unreachable empty-questions error branch (the schema's `minItems: 1` already rejects it).

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
