# pi-todo

Phased todo lists for [pi](https://github.com/earendil-works/pi-coding-agent) — the oh-my-pi todo tool migrated to a pi extension.

The agent gets a `todo` tool: a phased task list (phases → tasks with lifecycle statuses) persisted with the session. You get a `/todo` command, a transcript reminder when the agent stops with unfinished work, and a `todo_updated` event other extensions can consume (pi-goal uses it to attach live progress state to goal continuations).

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
| `start`    | `task`                    | Mark `in_progress`; demotes every other `in_progress` task |
| `done`     | `task` or `phase`         | Mark `completed`                                           |
| `drop`     | `task` or `phase`         | Mark `abandoned` (never deleted)                           |
| `block`    | `task` or `phase`, `reason?` | Park open work awaiting external input; one-line reason |
| `unblock`  | `task` or `phase`         | `blocked` → `pending`, clears the note                     |
| `rm`       | `task?` or `phase?`       | Remove a task / clear a phase / clear everything           |
| `append`   | `phase`, `items`          | Add `pending` tasks; lazily creates the phase              |
| `view`     | —                         | Read-only snapshot                                         |

Semantics kept verbatim from oh-my-pi: batch-atomic duplicate rejection (a failing op applies nothing), a single `in_progress` invariant with the earliest pending task auto-promoted on every mutation, `block` never reopens finished work, `view` never writes.

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

Every mutation commits a `<system-reminder>` hidden message telling the agent the user manually modified the list (with explicit intent notes after removals, so it never rebuilds cleared items).

## Stop reminders

When an agent run ends while tasks are still `pending`/`in_progress`, oh-my-pi's reminder loop kicks in: a hidden `<system-reminder>` message ("You stopped with N incomplete todo item(s)... (Reminder X/3)") is queued as a follow-up turn so the agent continues or marks work done, and a `⚠ N incomplete todos - reminder X/3` note is anchored in the transcript. The cycle allows 3 reminders, restarts on each new user prompt, and stays silent when the assistant's last line is a question to the user (the ball is in your court) or when only `blocked` tasks remain — those are parked awaiting external input.

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
| eager-todo / prewalk system-prompt arming   | Replaced by `promptGuidelines` on the tool definition     |
| `/todo edit` + markdown round-trip          | Dropped — no host editor surface                          |
| Sticky HUD / collapsed viewport / animations| Dropped — omp TUI-internal                                |
| Subagent todo-match lighting                | Dropped — no subagent HUD contract                        |
| `todo.enabled` settings gate                | Dropped — no settings API by design: installed means active |

## Development

```bash
npm run typecheck   # from packages/extensions/pi-todo
npm run test        # vitest
```

License: MIT
