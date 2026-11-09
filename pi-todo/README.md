# pi-todo

File-based todos for [pi](https://github.com/earendil-works/pi-coding-agent): every todo is a standalone markdown file under `.pi/todos`, claimable by sessions and shared across them — a lightweight task board for the agent and for you.

Rewritten from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) `extensions/todos.ts` (Apache-2.0). The implementation is carried over as-is; single-file `index.ts`, no build step. Earlier releases were a port of oh-my-pi's phased todo tool — see [CHANGELOG](./CHANGELOG.md) for what changed.

## What it does

- **One `todo` tool** with nine actions: `list` (assigned + open), `list-all` (includes closed), `get`, `create`, `update` (replaces fields), `append` (adds to the body), `delete`, `claim`, `release`. Ids are shown as `TODO-<hex>`; every `id` parameter accepts `TODO-<hex>`, the raw hex, or `#<hex>`.
- **Markdown-file storage** in `.pi/todos` (override with `PI_TODO_PATH`): each `<id>.md` starts with a JSON front-matter block (`{ id, title, tags, status, created_at, assigned_to_session }`), followed by a blank line and the long-form body.
- **Claim/release protocol** — `claim` assigns the current session (cleared automatically when the todo closes); claiming another session's todo requires `force`. The tool description tells the agent to claim before working and close when done.
- **Per-todo lock files** (`<id>.lock`) guard every mutation with a 30-minute TTL: fresh locks block with the owner's session, stale locks error headless and are stolen after a confirmation in interactive mode.
- **Garbage collection** on session start, configured by `.pi/todos/settings.json` (`{ "gc": true, "gcDays": 7 }`): closed todos older than `gcDays` are deleted; open todos are never collected.
- **`/todos` command** — an interactive manager in TUI (fuzzy search, action menu, markdown detail overlay, work/refine shortcuts that prefill the editor) and a grouped plain-text list headless.

## Install

```bash
pi install npm:@fyeeme/pi-todo
```

or copy/link this directory into `~/.pi/agent/extensions/` (global) or `.pi/extensions/` (project).

## Usage

The agent drives the tool; a typical flow:

```
todo list                       → see assigned/open todos, pick one
todo claim TODO-932a7665        → assign it to this session
todo update TODO-932a7665 status=closed   → when done
```

You can manage todos yourself:

```
/todos            → search, view, close/reopen, release, delete, copy, "work on"/"refine"
```

Because todos are plain files, they survive sessions, work across concurrent sessions, and are diffable in git if you commit the directory.

## Development

```bash
npm install --ignore-scripts
npm test        # vitest
npm run typecheck
```

## License

MIT. Derived from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) `extensions/todos.ts` (Apache-2.0).
