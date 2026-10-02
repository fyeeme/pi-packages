# pi-hooks

A Claude Code-compatible hooks runner for [pi](https://pi.dev). Reads your hooks configuration and maps `SessionStart`, `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `PreCompact`, `Stop`, and `SessionEnd` events to pi lifecycle events — matching Claude Code's hooks protocol including stdin JSON and stdout `additionalContext` capture.

**Config resolution order** (first file that defines at least one hook wins):

1. `PI_HOOKS_CONFIG` env var (exclusive single source when set)
2. `~/.pi/agent/hook.json` — user-global, **top priority**
3. `<project>/.pi/hook.json` — project-local fallback
4. `~/.pi/hook.json` — home-directory fallback

A file that parses but defines no hooks (e.g. `{}`, or a leftover file in an older schema) does not shadow lower-priority files — the chain falls through. Note the chain is winner-take-all: configs are never merged.

> **Breaking change from 1.0.5:** the config file was renamed `hooks.json` → `hook.json` (all three locations). Rename your existing file; `PI_HOOKS_CONFIG` is unaffected.

## Install

Requires the [pi](https://pi.dev) CLI.

### From npm (recommended)

```bash
# Global (user) install — available in every project
pi install npm:@fyeeme/pi-hooks

# Project-local — written to .pi/settings.json, shareable with your team
pi install -l npm:@fyeeme/pi-hooks

# Pinned version — skipped by `pi update`
pi install npm:@fyeeme/pi-hooks@1.0.0

# Try it once without saving (current run only)
pi -e npm:@fyeeme/pi-hooks
```

### From GitHub

Source: [`fyeeme/pi-packages`](https://github.com/fyeeme/pi-packages).

```bash
# HTTPS shorthand
pi install git:github.com/fyeeme/pi-packages
# Pin to a tag or commit (skipped by `pi update`)
pi install git:github.com/fyeeme/pi-packages@v1.0.0
# Raw URL form
pi install https://github.com/fyeeme/pi-packages
```

See the Pi Packages guide on [pi.dev](https://pi.dev) for the full list of source types, scopes, and `pi update` behavior.

## Configuration

Create `~/.pi/agent/hook.json` (user-global, highest file priority — runs in every project) or `.pi/hook.json` in a project root (used only when no global config defines hooks):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "serena-hooks activate --client=claude-code"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "serena-hooks remind --client=claude-code",
            "denyAsContext": true
          }
        ]
      },
      {
        "matcher": "mcp__serena__.*",
        "hooks": [
          {
            "type": "command",
            "command": "serena-hooks auto-approve --client=claude-code"
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "serena-hooks cleanup --client=claude-code"
          }
        ]
      }
    ]
  }
}
```

## Event Mapping

| hook.json event | pi event | Notes |
|---|---|---|
| `SessionStart` | `session_start` | Runs when a session starts, resumes, forks, or switches — **not** on `reload` (a runtime rebind must not re-run hooks mid-session). `matcher` matches the mapped Claude Code source: `startup` (default), `resume` (resume + fork), `clear` (new session); empty matcher matches all. `additionalContext` is injected into the first user message via the `context` event. |
| `PreToolUse` | `tool_call` | Runs before each tool. `matcher` is a **regex** against the pi tool name. `additionalContext` is injected before the next LLM call. `permissionDecision: "deny"` or exit code 2 blocks the tool (`terminate: true`; in a single-tool / all-terminating batch this also skips the follow-up LLM call — requires pi >= 0.84.1). |
| `PostToolUse` | `tool_result` | Runs after each tool. `matcher` is a regex against the tool name. stdin carries `tool_name`, `tool_input`, and `tool_response` (pi's shape: text `content` parts, `structuredContent` when the tool declares an outputSchema, `isError`). `additionalContext` is injected before the next LLM call; a deny cannot undo the finished call — its reason is injected as `[PostToolUse hook] …` context (same as CC feeding it to the next turn). |
| `UserPromptSubmit` | `before_agent_start` | Runs when the user submits a prompt. stdin carries `prompt`. `additionalContext` is injected before the next LLM call. pi has no blocking result at this boundary, so `decision: "block"`/exit 2 is demoted to a `[UserPromptSubmit hook] …` context note. |
| `PreCompact` | `session_before_compact` | Runs before context compaction. `matcher` matches the trigger: `manual` (/compact) or `auto` (threshold/overflow). stdin carries `trigger` and `custom_instructions`. Side-effect only (backups/snapshots); output control is not honored. |
| `Stop` | `session_shutdown` | Runs on exit/reload/session switch. Cleanup only — `decision: "block"` is **not** honored (pi cannot prevent exit). Stop hooks are awaited, so a slow hook delays exit up to its `timeout` (default 60s); keep them fast. |
| `SessionEnd` | `session_shutdown` | Fires for real session ends only: `quit` → reason `exit`, `new` → reason `clear`. `reload`/`resume`/`fork` tear the extension runtime down mid-conversation and run Stop cleanup only. `matcher` matches the mapped reason. |

## Matcher semantics

`matcher` is a **regex** (Claude Code compatible), tested against the full tool name (PreToolUse) or session source (SessionStart):

- `""` or `"*"` — match all
- `"Edit|Write"` — match either
- `"Notebook.*"` — prefix match
- `"mcp__serena__.*"` — all tools of the `serena` MCP server

> **Breaking change from 1.0.x:** matchers were previously interpreted as **globs** (`*`/`?`). If you upgraded, convert patterns like `mcp__serena__*` → `mcp__serena__.*`. Invalid regex matches nothing and warns once per pattern (never throws).

## Protocol

Commands receive Claude Code-compatible JSON on stdin (`session_id` is the pi session UUID; `transcript_path` is the conversation JSONL path):

```json
{ "hook_event_name": "SessionStart", "session_id": "<uuid>", "transcript_path": "/path/to/session.jsonl", "cwd": "/proj", "permission_mode": "default", "source": "startup" }
{ "hook_event_name": "PreToolUse", "session_id": "<uuid>", "transcript_path": "...", "cwd": "/proj", "permission_mode": "default", "tool_name": "bash", "tool_input": {} }
{ "hook_event_name": "PostToolUse", "session_id": "<uuid>", "transcript_path": "...", "cwd": "/proj", "permission_mode": "default", "tool_name": "bash", "tool_input": {}, "tool_response": { "content": ["done"], "isError": false } }
{ "hook_event_name": "UserPromptSubmit", "session_id": "<uuid>", "transcript_path": "...", "cwd": "/proj", "permission_mode": "default", "prompt": "fix the bug" }
{ "hook_event_name": "PreCompact", "session_id": "<uuid>", "transcript_path": "...", "cwd": "/proj", "permission_mode": "default", "trigger": "auto", "custom_instructions": "" }
{ "hook_event_name": "Stop", "session_id": "<uuid>", "transcript_path": "...", "cwd": "/proj", "permission_mode": "default" }
{ "hook_event_name": "SessionEnd", "session_id": "<uuid>", "transcript_path": "...", "cwd": "/proj", "permission_mode": "default", "reason": "exit" }
```

`permission_mode` defaults to `"default"`. pi itself has no CC-style permission modes; set `PI_HOOKS_PERMISSION_MODE` to expose a different value to hook scripts that branch on it (e.g. serena-hooks `auto-approve` checks for a permissive mode).

Commands may return JSON on stdout, or control flow via exit codes:

```json
{ "hookSpecificOutput": { "additionalContext": "context injected into the conversation" } }
{ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "blocked" } }
```

- exit code **0** with `additionalContext` → context injected.
- exit code **2** (PreToolUse) **with a JSON deny payload** (`permissionDecision: "deny"`) → tool call blocked (`terminate: true`); reason fed to the model. `terminate` skips the follow-up LLM call only when the denied call is in an all-terminating batch (pi >= 0.84.1, #7715); in a multi-tool batch the block always applies but the agent may continue.
- exit code **2** (PostToolUse / UserPromptSubmit) → cannot block (the tool already ran / pi has no prompt-blocking result); reason injected as `[<event> hook] …` context.
- exit code **2** without parseable JSON (e.g. a broken command like `python3` failing to open a script) → treated as a crash, not a deny: warning on stderr, tool call proceeds. This keeps a misconfigured hook from hard-blocking every tool call.
- exit code **2** (Stop) → ignored (pi cannot block exit).
- other non-zero → logged, execution continues.
- non-JSON stdout → logged as a warning, ignored.
- each hook may set `"timeout"` (seconds, default 60); matching hooks run in **parallel** (capped at 8 concurrent).
- pressing Esc mid-turn kills running hook processes (SIGTERM → SIGKILL escalation, same as the timeout path); an already-aborted turn does not spawn hooks at all.
- safety caps: hook stdout is capped at 10 MB (the hook is killed beyond that); injected `additionalContext` is capped at 50 KB / 2000 lines with a truncation notice.
- each hook may set `"denyAsContext": true` — demote a deny (`permissionDecision: "deny"`, or exit 2 carrying a JSON deny payload) to `additionalContext`: the tool call proceeds and the nudge text is injected before the next LLM call (appended to the last user message) instead of blocking. Intended for nudge-style hooks like `serena-hooks remind`, where hard-blocking a read burst stops the agent dead. Injected text: the hook's `additionalContext` if present, otherwise the deny reason.

The `additionalContext` is injected into the pi conversation (appended to the last user message, never as a new turn).

## MCP Tool Names

Pi names MCP tools `mcp__<server>__<tool>` (same scheme as Claude Code), so target them with regex like `mcp__serena__.*`. Check your actual tool names with `/mcp` in pi to set the correct `matcher`.

## Using pi-hooks with Serena

[Serena](https://github.com/oraios/serena) ships a `serena-hooks` CLI (Claude Code compatible) whose four subcommands map cleanly onto pi-hooks events. With Serena's MCP server running in pi (confirm with `/mcp` — you should see a `serena` server), drop this into `~/.pi/agent/hook.json` (global) or the project's `.pi/hook.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "serena-hooks activate --client=claude-code" }]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "serena-hooks remind --client=claude-code",
            "denyAsContext": true
          }
        ]
      },
      {
        "matcher": "mcp__serena__.*",
        "hooks": [{ "type": "command", "command": "serena-hooks auto-approve --client=claude-code" }]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "serena-hooks cleanup --client=claude-code" }]
      }
    ]
  }
}
```

What each hook does:

| Event | Command | Role |
|---|---|---|
| `SessionStart` | `activate` | Prompts the agent to activate the project and read Serena's instructions at session start. |
| `PreToolUse` (`""`) | `remind` | Nudges the agent to prefer Serena's symbolic tools over raw `read`/`grep`. Runs before every tool call. Set `denyAsContext: true` so its deny becomes a context nudge instead of a hard block (recommended). |
| `PreToolUse` (`mcp__serena__.*`) | `auto-approve` | Auto-approves Serena tool calls while the client is in a permissive permission mode. |
| `Stop` | `cleanup` | Clears per-session hook state on exit. |

**Get the matcher prefix right.** pi registers an MCP server's tools as `mcp__<server>__<tool>`. With Serena registered as the `serena` MCP server in `mcp.json` (the default), tools are named `mcp__serena__find_symbol`, `mcp__serena__find_referencing_symbols`, … → use `mcp__serena__.*`. Run `/mcp` in pi to confirm your exact prefix.

> ⚠️ **`auto-approve` is currently inert under pi-hooks.** `serena-hooks auto-approve` only emits its approval when stdin reports a permissive `permission_mode` (`acceptEdits` or `auto`), but pi-hooks always sends `permission_mode: "default"` today. The hook still runs but stays silent, so pi's own permission flow applies. `activate`, `remind`, and `cleanup` are unaffected. This will resolve once pi-hooks forwards the real permission mode.

`--client=claude-code` is correct for pi: pi-hooks speaks the Claude Code hooks protocol, so Serena treats pi as a Claude Code client.

### Recommended: steer at the context level, not only via hooks

`serena-hooks remind` is a **fallback**, not the main steering mechanism. Serena gates it behind a burst counter (8 consecutive `read`/`grep` calls in the currently installed release line, 3 in upstream master) plus a 120-second silence window after every nudge — so most `read` calls legitimately produce no output. The primary layer is Serena's **context system**: `serena start-mcp-server --context <name>` injects a behavior-constraining prompt and trims tools that duplicate the host agent's built-ins.

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

Optionally control how the model reaches Serena's tools with `exposure` / `toolExposure` (see pi's MCP docs for 0.99+ semantics): `"exposure": "codemode"` has the model batch Serena calls inside codemode scripts, `"exposure": "deferred"` loads them one by one via `tool_search`, and `toolExposure` can single out tools (e.g. `"initial_instructions": "direct"`).

What changes with `pi.yml` (`single_project: true` + `--project-from-cwd`):

- the project auto-activates at startup; `activate_project` and `get_current_config` are dropped from the toolset (the SessionStart `activate` hook still helps — it nudges the agent to read the manual via `initial_instructions`);
- the six duplicate tools disappear, removing the temptation to use them;
- the symbol-first rules ride in the system prompt instead of arriving as after-the-fact nudges.

Keep the hooks as a fallback: `remind` with `denyAsContext: true` (catches bursts the prompt didn't prevent), `activate`, and `cleanup` all stay useful; `auto-approve` remains inert under pi (see warning above).

## Config Override

Set `PI_HOOKS_CONFIG` env var to point to a custom config path (exclusive single source; when set, no other location is consulted).
