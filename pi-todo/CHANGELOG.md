# Changelog

## [Unreleased]

## [1.0.5] - 2026-11-09

### Breaking Changes

- Rewritten from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) `extensions/todos.ts` (Apache-2.0): the file-based todo system replaces the oh-my-pi phased-todo port entirely (single-file `index.ts`, behavior identical to the source). Todos now live as markdown files under `.pi/todos` (or `PI_TODO_PATH`) instead of session entries; sessions written by 1.x restore nothing.
- Tool surface: the nine phase operations (`init`/`start`/`done`/`rm`/`drop`/`block`/`unblock`/`append`/`view` over `phases`) are replaced by `list`/`list-all`/`get`/`create`/`update`/`append`/`delete`/`claim`/`release` over `TODO-<hex>`-identified file records with session claim/release semantics and per-todo lock files (30-minute TTL, interactive steal of stale locks).
- Command: the oh-my-pi `/todo` verb set (`edit`/`copy`/`export`/`import`/`append`/`start`/`done`/`drop`/`rm`) is replaced by `/todos` — an interactive todo manager (fuzzy search, actions menu, detail overlay, work/refine editor prefills) in TUI, a grouped plain-text list headless.
- Garbage collection on session start via `.pi/todos/settings.json` (`gc`, `gcDays`): closed todos older than the threshold are deleted.

### Added

- `outputSchema` on the `todo` tool with matching `structuredContent` on every result: success payloads mirror the JSON text (grouped list / todo record), failures return `{ error }` — codemode scripts now receive structured data instead of text.

### Fixed

- `/todos` guards the interactive manager with `ctx.mode === "tui"` instead of `ctx.hasUI`: in RPC mode `custom()` returns `undefined` (RPC extension UI protocol), so the command silently did nothing; RPC now prints the grouped plain-text list like print/json mode.
- The `todo` tool description no longer resolves its directory label from `process.cwd()` at registration; it names the session todos dir (`<session cwd>/.pi/todos` or `PI_TODO_PATH`) instead of a possibly-wrong absolute path.
- The collapsed "to expand" hint now uses `keyHint()` from the tool render context instead of the one imported from `@earendil-works/pi-coding-agent` (pi 1.5.0): the imported copy cannot see the host's keybindings, so the hint rendered without its key.

### Removed

- `todo_updated` event bus and `todo-phases` session entries (the old pi-goal integration contract; pi-goal 2.0 no longer consumes them).
- `listTodosSync` and `getTodosDirLabel` (zero callers after the rewrite).
- The `src/` module split (state/tool/render/commands/restore) and its oh-my-pi semantics: phases, batch-atomic duplicate rejection, the single-`in_progress` invariant debates, and markdown export/import round-trips.

### Changed

- Dev dependencies now pin `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, and `@earendil-works/pi-tui` at 1.5.0 (was 1.3.0), so type-check and tests run against the pi 1.5.0 types.
- `tsconfig.json` maps `@earendil-works/pi-ai` to pi-coding-agent's extension view (`dist/core/extensions/pi-ai-extension-view.d.ts`). pi-ai 1.5.0 no longer re-exports TypeBox and its published `StringEnum` returns a pi-schema `Schema<T>`, which broke `Static` inference inside `Type.Object()`; the view is the same module pi maps the import to at run time, so `StringEnum` infers as TypeBox `TUnsafe<T>` again. Source imports are unchanged.

## [1.0.4] - 2026-10-16

### Fixed

- Re-blocking a task without a `reason` keeps the existing blocker note — notes refine one way (unset → set → replaced) instead of being wiped by a bare re-block.
- Declared `@earendil-works/pi-ai` in peer/dev dependencies: `src/tool.ts` imports `StringEnum` from it at runtime (monorepo `check:runtime-deps` gate; parity with the family's peer floor `>=0.99.0`).
- `TodoRenderArgsPublic` no longer omits `items` — `renderTodoCall` reads `e.items` for the "N items" meta, so the public type now matches the implementation (drops an `as never` cast from a render test). A copy-paste-misplaced omp-alignment test title now describes what it asserts.

### Changed

- `formatMoreItems` is module-private now (zero external importers); `applyOpsToPhases`'s doc comment names its real caller (the `/todo` command's apply path, not `/todo clear`).

## [1.0.3] - 2026-10-02

### Changed

- Dev toolchain pinned to `@earendil-works/pi-coding-agent`/`pi-tui` 1.0.0 (peer floors unchanged, `>=0.99.0`); typecheck and tests pass against 1.0.0 unchanged.

## [1.0.2] - 2026-10-01

### Changed

- Peer dependency floor raised to `@earendil-works/pi-coding-agent >= 0.99.0`; dev toolchain pinned to 0.99.2 (typecheck and tests pass against 0.99.2 unchanged).

## [1.0.1] - 2026-09-12

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
- Internal cleanup: the 15 duplicated three-payload error returns in the `todo` tool's `execute` are now one `todoToolError` helper, the two `/todos` dialog components share a `selectListTheme` factory, and `renderResult` resolves its action label from an `ACTION_LABELS` lookup instead of a seven-branch conditional. No behavior change.

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
