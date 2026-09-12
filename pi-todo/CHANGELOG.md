# Changelog

## [Unreleased]

### Breaking Changes

- Cognitive-neutral refactor: pi-todo is now a neutral stateful notepad — statuses change only through explicit ops, and the list never steers the agent. Removed: eager-todo `promptGuidelines` (no more system-prompt nudges to plan first), the stop-reminder nag loop (`checkCompletion` / `⚠ N incomplete todos` transcript box / 3-attempt auto-continuation cycle), and the manual-edit `<system-reminder>` injection after `/todo` mutations. Motivation: the reminder loop plus the "or mark them complete" wording gave the agent a cheap escape hatch (tick boxes to silence the nag), and the plan-first nudges encouraged executing shallow 5–10-word labels without re-derivation.
- Removed `promptSnippet` from the tool definition (host docs allow omission): the tool no longer appears in the default system prompt's `Available tools` section, making the "no prompt steering" claim literal.
- Removed the single-`in_progress` invariant and the auto-promotion pointer (`normalizeInProgressTask`): `start` no longer demotes other `in_progress` tasks, completions never auto-promote a pending task, and multiple `in_progress` tasks are allowed. The five-status enum is unchanged (pi-goal's progress counting is unaffected).
- Removed the unused subagent description matcher (`todoMatchesAnyDescription`) and the `openTasks` helper, plus the now-parameterless `isMatched` viewport pipeline (`selectCollapsedTodos(tasks, cap)`).

### Changed

- Mutation results prepend a `Changed:` block listing every status transition (`- task [pending → blocked] (blocked: note) (phase)`), so a write is confirmed per-task even when the summary folds on lists over 20 tasks.
- Error results no longer fold: the thrown batch-error message always carries the full unchanged list, restoring the documented retry contract on big lists.
- The transcript renderer keeps the earliest open-work phase expanded (the active phase the summary reports) instead of relying on the removed auto-promotion pointer; stale pointer wording in renderer comments updated.
- Tool description (`todo.md`) reduced to mechanical documentation (ops, anatomy, lookup-key rules); all behavioral steering wording removed, including the earlier anti-laziness rules (evidence-gated `done`, re-plan license) — with the nag loop gone their premise no longer holds, and the notepad stays neutral.
- `formatSummary`'s worked-ahead note no longer references the removed auto-advancing pointer.
- Markdown round-trip no longer normalizes statuses on parse (`markdownToPhases`): `/todo edit` and `import` now restore statuses exactly as written.
- `formatSummary` folds its per-task dumps on mutation results once the list exceeds 20 tasks: remaining items capped at the first 10 with a `… N more open — call view` hint plus a single "Full checklist omitted" line. `view` (readOnly) still echoes the whole list. On big lists every `done`/`start` previously re-flooded the model context with the full checklist.
- `execute` clones phases 4 times per mutation instead of 8 (ownership handoff to the closure; persist/broadcast make their own entry-shaped snapshots); `getCompletionTransitions` generalized to `getStatusTransitions` whose result is now rendered instead of only feeding `completedTasks`.
- pi-goal's `goal-todo-context.md` no longer references the removed pointer/"stale in_progress" semantics (paired fix in @fyeeme/pi-goal).

## [1.0.0] - 2026-09-09

### Added

- Phased todo tool for pi: nine operations (`init`/`start`/`done`/`rm`/`drop`/`block`/`unblock`/`append`/`view`) over phase/task state with oh-my-pi-verbatim semantics (batch-atomic duplicate rejection, single `in_progress` invariant with earliest-pending auto-promotion, drop = abandoned, block skips finished work).
- Session persistence: full snapshot entry per mutation; branch-aware restore on session start/fork/tree navigation (`getBranch()`, so snapshots from abandoned branches no longer win the backward scan after `/fork` or `/tree`).
- `/todo` command with oh-my-pi's full verb set — `edit`, `copy`, `export`, `import`, `append`, `start`, `done`, `drop`, `rm`, `help` — with quote-aware tokenizing, fuzzy task/phase matching, and the Markdown round-trip (`phasesToMarkdown`/`markdownToPhases` with blocker HTML comments and escaped-bracket tolerance). Every mutation injects omp's `<system-reminder>` developer message ("The user manually modified the todo list (...)"), with explicit do-not-recreate notes after removals.
- Stop reminders matching omp `TodoTracker.checkCompletion`: a hidden `<system-reminder>` ("You stopped with N incomplete todo item(s)... (Reminder X/3)") queues a continuation turn, up to 3 attempts per user prompt, silent when the assistant's last line asks the user something (omp `isAwaitingUserAnswer`). The transcript note uses omp's `TodoReminderComponent` text: `⚠ N incomplete todos - reminder X/3` plus the italic unchecked list.
- Transcript rendering ports omp's renderer: call line `⏳ Todo · <op> <task> · N items`, result header `☑ Todo · N tasks`, roman-numeral phase headers with `closed/total` progress, touched-phase collapsing, tree glyphs (`├─`/`└─`), omp checkbox glyph set with strikethrough closed rows, and the collapsed walking viewport (`#5873`: last closed row leads, active work first, `… N more todos` summary).
- Tool prompt guidelines use omp's eager-todo wording.
- `todo_updated` event-bus broadcast after every successful mutation (pi-goal todo-context integration point).
- `test/omp-alignment.test.ts`: alignment suite pinning the markdown round-trip, roman numerals, collapsed-viewport selection, subagent-match helper, reminder guards, and summary text to omp sources verbatim.

### Fixed

- The `op` parameter uses `StringEnum` instead of a `Type.Union` of literals (Google API compatibility).
