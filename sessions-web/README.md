# session-web

Read-only web viewer for local pi session history. Registers the
`/session-web` command, which starts an HTTP server bound to `127.0.0.1`
and serves the sessions stored under `~/.pi/agent/sessions/`.

## Pages

- `/` — sidebar with sessions grouped by project directory (5 shown per
  group, rest behind "expand"), keyword filtering over first messages,
  session names, working directories, and full message text.
- `/session/:id` — conversation view (default): user messages as aligned
  bubbles, assistant replies rendered as markdown, thinking folded,
  model/compaction changes as status lines, and sibling branches shown as
  collapsed blocks at each fork point. Tool calls are not shown here — open
  the trace tab for them.
- `/session/:id?view=trace` — raw entry timeline (time / type / summary) for
  every session entry, including tool calls and results.

In the conversation view, `mermaid` code blocks render as inline diagrams
(all chart types supported by mermaid 12), follow the light/dark theme, and
open in a new tab when clicked. The mermaid library is fetched lazily from
the jsdelivr CDN on first use; when offline or when a diagram fails to
parse, the block degrades to the highlighted source plus an error line.

Markdown rendering follows the TUI renderer's support logic: HTML is shown
as escaped text (never rendered), markdown image markup is shown as text,
links show only their text, strikethrough uses strict `~~` rules, and LaTeX
delimiters (`$...$`, `$$...$$`) are detected with the same heuristics and
shown as text. Code blocks are highlighted with highlight.js.

The sidebar is drag-resizable (max 450px, double-click resets) and the page
has a light/dark theme toggle (light by default); both persist via
localStorage.

## Usage

```sh
pi --extension ./examples/extensions/session-web
```

Then inside pi:

```
/session-web           # start on the default port 8765
/session-web 9000      # start on a specific port
/session-web stop      # stop the server
```

Open the reported URL in a browser. The server also stops automatically when
the pi session ends.

## Constraints

- Read-only: the viewer never writes, edits, resumes, or deletes sessions.
- Local only: listens on 127.0.0.1; no remote access.
- Session ids are resolved through a filename scan of the sessions
  directory, so URL segments never reach the filesystem.
