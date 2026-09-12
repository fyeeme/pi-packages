# pi-todo

Phased todo lists for [pi](https://github.com/earendil-works/pi-coding-agent) — the oh-my-pi todo tool migrated to a pi extension.

The agent gets a `todo` tool: a phased task list (phases → tasks with lifecycle statuses) persisted with the session. You get a `/todo` command and a `todo_updated` event other extensions can consume (pi-goal uses it to attach live progress state to goal continuations).

The extension is a **cognitive-neutral notepad**: statuses change only through explicit ops, and none of the omp behavior-engineering survives — no system-prompt nudges, no stop-time nag loop, no hidden reminders. The list records state; it never steers the agent.

## Install

```bash
pi install npm:@fyeeme/pi-todo
```

No configuration, no settings, no flags — installed means active. Works in TUI, RPC, and headless (`-p`) modes.

## The tool

Nine operations over `phases: [{ phase, items: string[] }]` state:

| `op`       | Fields                    | Effect                                                    |
| ---------- | ------------------------- | --------------------------------------------------------- |
| `init`     | `list` (or flat `items`)  | Replace the whole list; all tasks start `pending`          |
| `start`    | `task`                    | Mark `in_progress` (explicit; other tasks untouched)      |
| `done`     | `task` or `phase`         | Mark `completed`                                           |
| `drop`     | `task` or `phase`         | Mark `abandoned` (never deleted)                           |
| `block`    | `task` or `phase`, `reason?` | Park open work awaiting external input; one-line reason |
| `unblock`  | `task` or `phase`         | `blocked` → `pending`, clears the note                     |
| `rm`       | `task?` or `phase?`       | Remove a task / clear a phase / clear everything           |
| `append`   | `phase`, `items`          | Add `pending` tasks; lazily creates the phase              |
| `view`     | —                         | Read-only snapshot                                         |

Semantics ported from oh-my-pi: batch-atomic duplicate rejection (a failing op applies nothing), `block` never reopens finished work, `view` never writes. Deliberate deviation: the single-`in_progress` invariant and the auto-promotion pointer are removed — statuses are set only by explicit ops, and multiple `in_progress` tasks are allowed.

## Command

The full oh-my-pi `/todo` verb set:

```
/todo                              Show current todos (Markdown checklist)
/todo edit                         Round-trip todos through the editor
/todo copy                         Print todos as Markdown
/todo export [<path>]              Write todos to file (default: TODO.md)
/todo import [<path>]              Replace todos from file (default: TODO.md)
/todo append [<phase>] <task...>   Append a task; phase fuzzy-matched or auto-created
/todo start  <task>                Mark task in_progress (fuzzy match)
/todo done   [<task|phase>]        Mark task/phase/all completed
/todo drop   [<task|phase>]        Mark task/phase/all abandoned
/todo rm     [<task|phase>]        Remove task/phase/all
```

## Event contract

After every successful mutation:

```ts
pi.events.emit("todo_updated", { phases }); // full snapshot; never on view/failure
```

### pi-goal integration

[pi-goal](../pi-goal) embeds a `<todo_context>` block into its per-turn goal context when the `todo` tool is active and the list is non-empty — live progress state for autonomous goal continuations. pi-todo is fully usable without pi-goal; pi-goal degrades silently without pi-todo.

## Persistence

Every mutation appends a full `todo-phases` snapshot entry to the session. On session start (resume/fork/tree navigation/reload), the latest valid snapshot on the **current branch** wins, so navigating the session tree restores the todo state of that point in history. Malformed entries are skipped, never fatal.

## Ported from oh-my-pi — what was dropped

Source: `oh-my-pi/packages/coding-agent/src/tools/todo.ts` (plus reminder, slash-command helpers, prompts). Behavior semantics are ported verbatim; host-internal surfaces with no pi counterpart are not:

| omp surface                                | Status in pi-todo                                        |
| ------------------------------------------ | -------------------------------------------------------- |
| mid-run todo nudge (tool-choice queue)      | Dropped — omp host-internal                               |
| eager-todo / prewalk system-prompt arming   | Dropped — cognitive-neutral refactor (no prompt steering) |
| Stop-reminder loop (checkCompletion, ×3 nag)| Dropped — cognitive-neutral refactor (no auto-continuation)|
| Manual-edit `<system-reminder>` injection   | Dropped — cognitive-neutral refactor                      |
| Single `in_progress` invariant / auto-promotion pointer | Dropped — statuses are explicit-only          |
| `/todo edit` + markdown round-trip          | Kept — via `ctx.ui.editor`                                |
| Sticky HUD / collapsed viewport / animations| Kept (viewport) in the transcript renderer; HUD dropped   |
| Subagent todo-match lighting                | Dropped — no subagent HUD contract                        |
| `todo.enabled` settings gate                | Dropped — no settings API by design: installed means active |

## Development

```bash
npm run typecheck   # from packages/extensions/pi-todo
npm run test        # vitest
```

License: MIT
