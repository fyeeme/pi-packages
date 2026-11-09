# pi-serena-hooks

A [Serena](https://github.com/oraios/serena) bridge for [pi](https://pi.dev). It wires pi extension events to `serena-hooks`, Serena's Claude Code-compatible hook CLI — no `hook.json` needed. Serena then nudges the agent to activate the project at session start and to prefer its symbolic tools over raw `read`/`grep` bursts.

## Prerequisites

- The [pi](https://pi.dev) CLI.
- The Serena MCP server registered under the name `serena` in pi (`/mcp` shows a `serena` server). The reminders steer toward Serena's tools; without the server they have nothing to act on.
- The `serena-hooks` CLI on `PATH` (ships with Serena's Claude Code integration). Missing it does not break pi: the extension fails open and stays silent after a one-time UI warning.

## Install

```bash
# Global (user) install — available in every project
pi install npm:@fyeeme/pi-serena-hooks

# Project-local — written to .pi/settings.json, shareable with your team
pi install -l npm:@fyeeme/pi-serena-hooks

# Try it once without saving (current run only)
pi -e npm:@fyeeme/pi-serena-hooks
```

Source: [`fyeeme/pi-packages`](https://github.com/fyeeme/pi-packages).

## What it does

| pi event | serena-hooks command | Effect |
|---|---|---|
| `session_start` | `activate` | Runs once per session; the returned `additionalContext` (the activate prompt) is injected as a hidden custom message (`customType: "serena-activate"`) on the next agent run, telling the agent to activate the project and read Serena's instructions. |
| `session_compact` | *(re-arm)* | Compaction folds the injected activate message away; the extension re-arms so the next run carries it again. |
| `tool_call` | `remind` | For tool calls Serena counts (see below). When serena-hooks detects a drift streak (e.g. 8 consecutive raw reads), it answers `permissionDecision: "deny"` and the extension blocks the call with the hook's reason. Most calls produce no output and run through. |
| `session_shutdown` | `cleanup` | Deletes serena-hooks' per-session state. |

### Which tool calls reach `remind`

- `bash` — only when the command matches a content-search/read program (grep, egrep, fgrep, rg, ag, ack, ugrep, ug, cat, head, tail, sed, awk, less, more, bat, get-content, gc). Other commands are neutral to the counters and skip the spawn.
- `read` — payload maps pi's `path` to `file_path`, which serena-hooks uses to decide whether the target is a code file.
- `grep` — as-is.
- `mcp__serena__*` — passed through; a Serena symbolic tool call resets the drift counters inside serena-hooks.
- Everything else (`write`, `edit`, `ls`, …) is not counted.

`--client=claude-code` is passed automatically: pi's tool names match what serena-hooks expects in its claude-code client mode.

## Behavior notes

- **Fail open.** Any `serena-hooks` failure — missing binary, non-JSON stdout, crash, or the 5s timeout — resolves to "no decision". The tool call proceeds; only a structured `permissionDecision: "deny"` blocks.
- A missing `serena-hooks` binary is remembered; later events skip the spawn entirely. With a UI attached, you get one warning: `serena-hooks not found; Serena reminder hooks disabled`.
- A `remind` deny blocks with `permissionDecisionReason` (plus `additionalContext` when present) as the reason fed to the model.
- `remind` is a **fallback**, not the main steering mechanism — Serena gates it behind a burst counter plus a silence window after each nudge. Prefer the context-level steering below.

## Recommended: steer at the context level too

Serena's primary layer is its **context system**: `serena start-mcp-server --context <name>` injects a behavior-constraining prompt and trims tools that duplicate the host agent's built-ins.

This package ships [`pi.yml`](./pi.yml) — a pi-adapted context based on Serena's own `claude-code.yml`: symbol-first read/edit rules written against pi's tool names (`read`/`bash`/`edit`), and `excluded_tools` trimming the six Serena tools that duplicate pi built-ins (`read_file`, `execute_shell_command`, `find_file`, `list_dir`, `search_for_pattern`, `create_text_file`). Install and wire it up:

```bash
cp pi.yml ~/.serena/contexts/   # user contexts dir; a same-named context overrides the built-ins
```

```jsonc
// ~/.pi/agent/mcp.json
"serena": {
  "type": "stdio",
  "command": "serena",
  "args": ["start-mcp-server", "--project-from-cwd", "--context", "pi"]
}
```

What changes with `pi.yml` (`single_project: true` + `--project-from-cwd`):

- the project auto-activates at startup; `activate_project` and `get_current_config` are dropped from the toolset (the `activate` hook still helps — it nudges the agent to read the manual via `initial_instructions`);
- the six duplicate tools disappear, removing the temptation to use them;
- the symbol-first rules ride in the system prompt instead of arriving as after-the-fact nudges.

Keep the extension as the safety net: `remind` catches bursts the prompt didn't prevent, `activate` prompts the manual read, `cleanup` clears session state.
