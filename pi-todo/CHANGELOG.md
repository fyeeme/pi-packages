# Changelog

## [Unreleased]

### Changed

- omp alignment pass (test + fix until behavior is identical to oh-my-pi todo mode):
  - `/todo` gains the full oh-my-pi verb set — `edit`, `copy`, `export`, `import`, `append`, `start`, `done`, `drop`, `rm`, `help` — with quote-aware tokenizing, fuzzy task/phase matching, and the Markdown round-trip (`phasesToMarkdown`/`markdownToPhases` with blocker HTML comments and escaped-bracket tolerance). The pi-invented `clear` verb was replaced by omp's verbs.
  - Every `/todo` mutation injects omp's `<system-reminder>` developer message ("The user manually modified the todo list (...)"), with explicit do-not-recreate notes after removals.
  - Stop reminders now match omp `TodoTracker.checkCompletion`: a hidden `<system-reminder>` ("You stopped with N incomplete todo item(s)... (Reminder X/3)") queues a continuation turn, up to 3 attempts per user prompt, silent when the assistant's last line asks the user something (omp `isAwaitingUserAnswer`). The transcript note uses omp's `TodoReminderComponent` text: `⚠ N incomplete todos - reminder X/3` plus the italic unchecked list.
  - Transcript rendering ports omp's renderer: call line `⏳ Todo · <op> <task> · N items`, result header `☑ Todo · N tasks`, roman-numeral phase headers with `closed/total` progress, touched-phase collapsing, tree glyphs (`├─`/`└─`), omp checkbox glyph set with strikethrough closed rows, and the collapsed walking viewport (`#5873`: last closed row leads, active work first, `… N more todos` summary).
  - Tool prompt guidelines use omp's eager-todo wording.

### Added

- `test/omp-alignment.test.ts`: alignment suite pinning the markdown round-trip, roman numerals, collapsed-viewport selection, subagent-match helper, reminder guards, and summary text to omp sources verbatim.

### Fixed

- The `op` parameter uses `StringEnum` instead of a `Type.Union` of literals (Google API compatibility).
- session_start restore is branch-aware (`getBranch()`): snapshots from abandoned branches no longer win the backward scan after `/fork` or `/tree` navigation.

## [1.0.0]

### Added

- Phased todo tool for pi: nine operations (`init`/`start`/`done`/`rm`/`drop`/`block`/`unblock`/`append`/`view`) over phase/task state with oh-my-pi-verbatim semantics (batch-atomic duplicate rejection, single `in_progress` invariant with earliest-pending auto-promotion, drop = abandoned, block skips finished work)
- Session persistence: full snapshot entry per mutation; branch-aware restore on session start/fork/tree navigation
- `/todo` command: view the list; `/todo clear` removes settled tasks with confirmation in dialog-capable UIs
- Stop reminders: transcript-anchored entry when an agent run settles with pending/in-progress work, with per-session attempt counter
- `todo_updated` event-bus broadcast after every successful mutation (pi-goal todo-context integration point)
