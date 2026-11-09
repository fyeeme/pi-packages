# Changelog

## [Unreleased]

## [1.0.7] - 2026-11-09

### Breaking Changes

- Rewritten from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) `extensions/goal.ts` (Apache-2.0): the implementation replaces the oh-my-pi port entirely (single-file `index.ts`, behavior identical to the source). Sessions written by 1.x restore as having no goal — the persisted entry format changed from `goal-state`/`goal-cleared` snapshots to versioned `goal` action entries (`{ version: 2, action: set|edit|status|clear|account, goal }`).
- Tool surface: the single `goal` tool (create/get/complete/resume/drop/impossible) is now three tools — `get_goal`, `create_goal`, `update_goal` (`complete`/`blocked` only).
- Statuses: `budget-limited` → `budgetLimited`; `dropped` removed (goals are `clear`ed); new `blocked` and `usageLimited` statuses. Every goal now carries a token budget (default 2,000,000, matching the source; omp allowed budgetless goals).
- `/goal` UX: menu + `set`/`show`/`budget <N|off>`/`drop` subcommands replaced by goal.ts semantics — bare `/goal` shows the summary, an argument sets a goal, subcommands are `clear`/`edit`/`pause`/`resume`.
- Completion is self-graded again (per the source): the evaluator gate and `impossible` channel are gone; completion/blocked audits live in the injected prompts instead.

### Removed

- Independent evaluator subprocess (`complete` evidence gate, `impossible` op with dispute cap).
- `/guided-goal` interview command.
- `goal_updated` extension event bus.
- pi-todo integration (`todo_updated` events, `todo-phases` entries, footer task progress, `<todo_context>` block).
- Budget-limit one-shot steering message; `agent_before_settle` continuation drafts; `context_with_system` per-request injection (goal.ts injects via `before_agent_start` systemPrompt append); context slimming; `goal-completed` transcript entry renderer.

### Changed

- Peer dependencies reduced to `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `typebox` (dropped `pi-tui`, `pi-agent-core`).
- Test suite rebuilt around the new behavior (43 fake-host wiring tests; was 160).
- Dev dependencies now pin `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, and `@earendil-works/pi-tui` at 1.5.0 (was 1.3.0), so type-check and tests run against the pi 1.5.0 types.
- `tsconfig.json` maps `@earendil-works/pi-ai` to pi-coding-agent's extension view (`dist/core/extensions/pi-ai-extension-view.d.ts`). pi-ai 1.5.0 no longer re-exports TypeBox and its published `StringEnum` returns a pi-schema `Schema<T>`, which broke `Static` inference inside `Type.Object()`; the view is the same module pi maps the import to at run time, so `StringEnum` infers as TypeBox `TUnsafe<T>` again. Source imports are unchanged.

### Added

- `outputSchema` + `structuredContent` on the three data tools (`get_goal`, `create_goal`, `update_goal`): the schema mirrors the wire response (`goal` object or null, `remainingTokens`, `completionBudgetReport`), and every result now carries `structuredContent` so codemode scripts receive structured data instead of parsing the text content.

### Fixed

- Removed an unreachable status guard from `update_goal`: the parameter schema is `StringEnum(["complete", "blocked"])` and typebox validation rejects other values before `execute` runs, so the in-executor check could never fire.
- README now states the default token budget as 2,000,000 tokens, matching `DEFAULT_TOKEN_BUDGET`, the test suite, and the package description (it said 5,000,000).

## [1.0.6] - 2026-10-16

### Fixed

- Context hygiene: the budget-limit steer is now stamped with `details.goalId` and pruned from the model view once its goal is no longer live (completed/dropped/paused or mode exited) — previously the last steer lingered after the goal ended.
- README drift: evaluator timeout is 10 min (not ≈ 5), suite size is 160 tests (not 118); package description now lists the `impossible` op.

### Removed

- Dead symbols: the never-emitted `goal_continuation_requested` variant of `GoalRuntimeEvent`, the zero-reference `GoalTerminalMetricEmission` type, and the never-called `GoalRuntime.clearAccounting()` method (internal cleanup uses the private `#clearActiveAccounting`).

## [1.0.5] - 2026-10-02

### Changed

- Relaxed the `@earendil-works/pi-agent-core` peer dependency from exact `0.99.2` to `>=0.99.0`, matching the other peer floors.
- Dev toolchain pinned to `@earendil-works/pi-agent-core`/`pi-ai`/`pi-coding-agent`/`pi-tui` 1.0.0; typecheck and tests pass against 1.0.0 unchanged.

## [1.0.4] - 2026-10-01

### Added

- Objective length cap (`MAX_OBJECTIVE_CHARS`, 4,000 code points) enforced by the runtime on `create` and `replace` — the objective is re-injected into context on every continuation and passed to the evaluator subprocess, so an oversized one silently burns budget every turn; the error guides long instructions into a referenced file. Counting is code-point-based, not UTF-16 units. (Borrowed from mitsuhiko/agent-stuff `extensions/goal.ts`.)

### Fixed

- Print/json/rpc modes could never create a goal: `session_start` removed the `goal` tool from the active set when no goal existed (omp sdk.ts parity), but non-interactive modes have no `/goal` or `/guided-goal` command to re-arm it — leaving the model unable to start a goal at all (found via live goal-mode testing). The tool is now only removed in TUI mode.
- The run that creates/resumes a goal via the tool never saw the goal context prompt: `before_agent_start` injection only fires on the next agent run, and the command-path steer was not wired to the tool path (found via live goal-mode testing). The tool now fires an `onActivated` hook so the host injects the goal context into the current run as a steer.
- The evaluator subprocess ran with full extension discovery: any other installed goal extension (with an active-goal system prompt) would pollute the judge that is supposed to be independent, and the startup overhead contributed to live 300s timeouts. It now runs lean (`--no-extensions --no-skills`), the default timeout is raised to 600s, and `GOAL_EVALUATOR_TIMEOUT_MS` overrides it.

### Changed

- Context hygiene: hidden goal messages no longer accumulate in the LLM's view. A `context` handler keeps only the newest `goal-mode-context` and `goal-budget-limit` messages plus the newest `goal-continuation` stamped for the currently active goal id (`details.goalId`); stale ones — including all continuations once no goal is active — are dropped from the model's view, not from the transcript. (Borrowed from mitsuhiko/agent-stuff `extensions/goal.ts`.)
- Run-error handling: when a run ends with an assistant `stopReason: "error"`, the active goal now pauses (persisted) instead of letting the continuation loop fire into a likely retry loop, with a classified notice — provider usage/rate/quota/limit errors read differently from generic faults. Abort behavior is unchanged. (Borrowed from mitsuhiko/agent-stuff `extensions/goal.ts`.)
- Peer dependency floor raised to `@earendil-works/pi-coding-agent >= 0.99.0`; dev toolchain pinned to 0.99.2 (typecheck and tests pass against 0.99.2 unchanged).

## [1.0.2] - 2026-09-16

### Changed

- Prompt copy in the injected `<todo_context>` block: stale-item guidance now reads "stale, already finished, or superseded" (was "no longer active pointer") and ends with "Statuses only change through explicit todo ops — call `start` on the task you are working on" instead of the stale-in-progress phrasing.

## [1.0.1] - 2026-09-11

### Added

- Footer task progress: with pi-todo live, the goal status segment appends ` · <closed>/<total> tasks` (closed = completed + abandoned, empty phases ignored) — e.g. `🎯 Goal 12K/399K · 3/10 tasks`. Restored from `todo-phases` session entries on session start/tree navigation.
- Missing `todo_updated` event wiring: pi-goal now subscribes to pi-todo's documented `todo_updated` broadcast (payload-validated), keeping the todo context and footer progress live between session restores. Previously `todoPhases` only refreshed on session start/tree navigation, so in-session todo mutations left the context stale.

## [1.0.0] - 2026-09-09

### Added

- Initial release: oh-my-pi goal mode ported to a pi extension.
- `goal` tool (`create`/`get`/`complete`/`resume`/`drop`/`impossible`) with omp's exact operation semantics, registered at load and kept out of the active toolset until goal mode or a guided interview needs it.
- **Independent completion/impossibility evaluator** (`src/evaluator.ts` + `evaluator-complete.md` / `evaluator-impossible.md`), absorbed from Claude Code 2.1.261's goal design (bin/claude.exe, 2026-09-07) and going one step further than CC:
  - `goal({op:"complete"})` requires `evidence` — the agent's per-deliverable audit of the current repo state — and is gated by an independent evaluator: a fresh `pi -p --no-session` subprocess (spawn resolution ported from pi-subagents' `getPiInvocation`) that re-verifies the repository itself (runs the checks; grounded, where CC's evaluator is transcript-only). Its JSON contract follows CC's: `{ok, reason}` with evidence quoting and the default direction "insufficient evidence = NOT met". A refuted claim keeps the goal active, returns the evaluator's findings in the tool result, and forbids re-claiming with the same evidence; omp's complete error semantics (no goal / already complete / dropped) are preserved before any evaluator spend. Evaluator unavailability (spawn failure, ~5 min timeout, unparseable/out-of-contract output) falls back to the omp self-audit completion, honestly labeled (`unavailable-fallback`); caller aborts rethrow.
  - New `goal({op:"impossible", reason})` op — CC's third verdict channel with its "the claim is evidence, not proof — independently confirm" rule: the evaluator adjudicates the impossibility claim; confirmation pauses the goal (`state.reason: "impossible-confirmed"`) with the tool result instructing an honest report to the user; refutation keeps it working; after 2 unconfirmed disputes (`Goal.impossibleReports`, persisted) the goal pauses for a human decision (`"impossible-disputed"`). An unadjudicated claim (evaluator unavailable) changes no state and routes to the user.
  - Tool details gain `evaluator: {verdict, reason}` (`confirmed` / `rejected` / `unavailable-fallback` / `impossible-confirmed` / `impossible-refuted` / `impossible-disputed` / `unavailable`), rendered as an evaluator line in the tool result.
  - `pauseGoal` accepts an explicit `reason`; `recordImpossibleReport` bumps + persists the dispute counter; `isGoal` accepts the optional `impossibleReports` field (old snapshots restore unchanged).
- `GoalRuntime` with omp's budget accounting verbatim: token deltas include cache writes and exclude cache reads, wall-clock seconds advance in whole persisted steps, budget-limit steering fires once per goal id, interrupts pause, cold resume auto-pauses, tree navigation preserves.
- Autonomous continuation loop with no-tool-call suppression and user-message re-arm.
- `/goal` (`set`/`show`/`pause`/`resume`/`drop`/`budget`) with interactive menu, and `/guided-goal` interview kickoff.
- Session persistence via `goal-state` / `goal-cleared` / `goal-completed` custom entries with branch-aware restore.
- pi-todo integration: live `<todo_context>` block inside the goal context message.
- `goal_updated` event bus broadcast for other extensions; footer status segment.
- `ui_prompt_start`/`ui_prompt_end` integration: continuation turns are withheld while a blocking dialog is open and resume when it closes while idle.
- `agent_settled` status refresh, `/goal` argument autocomplete (`getArgumentCompletions`), multi-line objective editor, and a persistent `goal-completed` entry renderer (all per docs/extensions.md v0.84.4).
- `test/omp-alignment.test.ts`: 47-test alignment suite pinning pi-goal's commands, status segment, renderer strings, persistence, and escaping to omp sources verbatim.

### Changed

- `goal` tool `op` parameter uses `StringEnum` instead of `Type.Union`/`Type.Literal` for Google API compatibility (docs/extensions.md, Custom Tools).
- Peer dependencies now require pi 0.84.4+ (`ui_prompt_start`/`ui_prompt_end` events).

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
