# Changelog

## [Unreleased]

### Fixed

- omp alignment pass (test + fix until behavior is identical to oh-my-pi goal mode):
  - `escapeXmlText` escapes only the `& < >` trio; quotes now stay verbatim in goal prompts, matching omp `sanitize-text.ts` (omp's goal-runtime tests pin this).
  - `/goal <objective>` while a goal is active now reports omp's status message instead of opening the menu; while paused it warns "Resume the current goal first...".
  - Dropping a goal now clears session state entirely (omp `commitState(undefined)`): `/goal show`, `/goal resume`, the menu, and `/guided-goal` treat a dropped goal like no goal, and a new `/goal <objective>` starts fresh.
  - Menu item label is omp's `Adjust budget…` (ellipsis); the budget prompt is an editor prefilled with the current budget (omp `#promptGoalBudgetEdit`).
  - Notification severities mirror omp: `showStatus` → info, `showWarning` → warning, `showError` → error (e.g. invalid budget input renders as an error).
  - Footer status segment reworked to omp `renderGoalMode`: `<icon> Goal <used>[/<budget>]` with the omp unicode icon set (🎯/⏸/⚠), visible only while enabled or paused; the pi-specific `waiting for user` suffix was removed.
  - Goal tool renderer strings match omp: call `⏳ Goal: set "…" · budget 5K`, result `◎ Goal: set ⟦active⟧` (⟦⟧ badge brackets, `goalBadgeColor`), error `✘ Goal: <op>` + two-space detail, no-goal `⚠ Goal: <op> · no active goal`; objective caps at omp TRUNCATE_LENGTHS (60 call / 100 result).
  - `/goal` description is omp's "Toggle goal mode (persistent autonomous objective for this session)"; argument completions mirror omp `buildArgumentCompletions` (trailing-space values, null past the subcommand word).
  - `/guided-goal` no longer emits a kickoff status message (omp shows none); `/goal resume` guard requires an actually-paused goal.
  - `/guided-goal` kickoff queues as a follow-up behind an in-flight run (omp `session.followUp`), never a steer.

### Added

- **Independent completion/impossibility evaluator** (`src/evaluator.ts` + `evaluator-complete.md` / `evaluator-impossible.md`), absorbed from Claude Code 2.1.261's goal design (bin/claude.exe, 2026-09-07) and going one step further than CC:
  - `goal({op:"complete"})` now requires `evidence` — the agent's per-deliverable audit of the current repo state — and is gated by an independent evaluator: a fresh `pi -p --no-session` subprocess (spawn resolution ported from pi-subagents' `getPiInvocation`) that re-verifies the repository itself (runs the checks; grounded, where CC's evaluator is transcript-only). Its JSON contract follows CC's: `{ok, reason}` with evidence quoting and the default direction "insufficient evidence = NOT met". A refuted claim keeps the goal active, returns the evaluator's findings in the tool result, and forbids re-claiming with the same evidence; omp's complete error semantics (no goal / already complete / dropped) are preserved before any evaluator spend. Evaluator unavailability (spawn failure, ~5 min timeout, unparseable/out-of-contract output) falls back to the omp self-audit completion, honestly labeled (`unavailable-fallback`); caller aborts rethrow.
  - New `goal({op:"impossible", reason})` op — CC's third verdict channel with its "the claim is evidence, not proof — independently confirm" rule: the evaluator adjudicates the impossibility claim; confirmation pauses the goal (`state.reason: "impossible-confirmed"`) with the tool result instructing an honest report to the user; refutation keeps it working; after 2 unconfirmed disputes (`Goal.impossibleReports`, persisted) the goal pauses for a human decision (`"impossible-disputed"`). An unadjudicated claim (evaluator unavailable) changes no state and routes to the user.
  - Tool details gain `evaluator: {verdict, reason}` (`confirmed` / `rejected` / `unavailable-fallback` / `impossible-confirmed` / `impossible-refuted` / `impossible-disputed` / `unavailable`), rendered as an evaluator line in the tool result.
  - `pauseGoal` accepts an explicit `reason`; `recordImpossibleReport` bumps + persists the dispute counter; `isGoal` accepts the optional `impossibleReports` field (old snapshots restore unchanged).
- `test/omp-alignment.test.ts`: 47-test alignment suite pinning pi-goal's commands, status segment, renderer strings, persistence, and escaping to omp sources verbatim.

## [1.0.0] - 2026-08-29

### Added

- Initial release: oh-my-pi goal mode ported to a pi extension.
- `goal` tool (`create`/`get`/`complete`/`resume`/`drop`) with omp's exact operation semantics, registered at load and kept out of the active toolset until goal mode or a guided interview needs it.
- `GoalRuntime` with omp's budget accounting verbatim: token deltas include cache writes and exclude cache reads, wall-clock seconds advance in whole persisted steps, budget-limit steering fires once per goal id, interrupts pause, cold resume auto-pauses, tree navigation preserves.
- Autonomous continuation loop with no-tool-call suppression and user-message re-arm.
- `/goal` (`set`/`show`/`pause`/`resume`/`drop`/`budget`) with interactive menu, and `/guided-goal` interview kickoff.
- Session persistence via `goal-state` / `goal-cleared` / `goal-completed` custom entries with branch-aware restore.
- pi-todo integration: live `<todo_context>` block inside the goal context message.
- `goal_updated` event bus broadcast for other extensions; footer status segment.
- `ui_prompt_start`/`ui_prompt_end` integration: continuation turns are withheld while a blocking dialog is open, resume when it closes while idle; footer reports "waiting for user".
- `agent_settled` status refresh, `/goal` argument autocomplete (`getArgumentCompletions`), multi-line objective editor, and a persistent `goal-completed` entry renderer (all per docs/extensions.md v0.84.4).

### Changed

- `goal` tool `op` parameter uses `StringEnum` instead of `Type.Union`/`Type.Literal` for Google API compatibility (docs/extensions.md, Custom Tools).
- Peer dependencies now require pi 0.84.4+ (`ui_prompt_start`/`ui_prompt_end` events).
