# Changelog

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
