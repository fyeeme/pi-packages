# pi-hooks

A Claude Code-compatible hooks runner for [pi](https://pi.dev). Reads `.pi/hooks.json` from your project and maps `SessionStart`, `PreToolUse`, and `Stop` events to pi lifecycle events — matching Claude Code's hooks protocol including stdin JSON and stdout `additionalContext` capture.

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

Create `.pi/hooks.json` in your project root:

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
            "command": "serena-hooks remind --client=claude-code"
          }
        ]
      },
      {
        "matcher": "plugin_serena_serena_.*",
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

| hooks.json event | pi event | Notes |
|---|---|---|
| `SessionStart` | `session_start` | Runs on session start/reload/switch. `matcher` matches the source (`startup`/`resume`/`clear`/...); empty matcher matches all. `additionalContext` is injected into the first user message via the `context` event. |
| `PreToolUse` | `tool_call` | Runs before each tool. `matcher` is a **regex** against the pi tool name. `additionalContext` is injected before the next LLM call. `permissionDecision: "deny"` or exit code 2 blocks the tool (`terminate: true`; in a single-tool / all-terminating batch this also skips the follow-up LLM call — requires pi >= 0.84.1). |
| `Stop` | `session_shutdown` | Runs on exit/reload/session switch. Cleanup only — `decision: "block"` is **not** honored (pi cannot prevent exit). Stop hooks are awaited, so a slow hook delays exit up to its `timeout` (default 60s); keep them fast. |

## Matcher semantics

`matcher` is a **regex** (Claude Code compatible), tested against the full tool name (PreToolUse) or session source (SessionStart):

- `""` or `"*"` — match all
- `"Edit|Write"` — match either
- `"Notebook.*"` — prefix match
- `"plugin_serena_serena_.*"` — all serena tools

> **Breaking change from 1.0.x:** matchers were previously interpreted as **globs** (`*`/`?`). If you upgraded, convert patterns like `plugin_serena_serena_*` → `plugin_serena_serena_.*`. Invalid regex matches nothing and warns once at first use (never throws).

## Protocol

Commands receive Claude Code-compatible JSON on stdin (`session_id` is the pi session UUID; `transcript_path` is the conversation JSONL path):

```json
{ "hook_event_name": "SessionStart", "session_id": "<uuid>", "transcript_path": "/path/to/session.jsonl", "cwd": "/proj", "permission_mode": "default", "source": "startup" }
{ "hook_event_name": "PreToolUse", "session_id": "<uuid>", "transcript_path": "...", "cwd": "/proj", "permission_mode": "default", "tool_name": "bash", "tool_input": {} }
{ "hook_event_name": "Stop", "session_id": "<uuid>", "transcript_path": "...", "cwd": "/proj", "permission_mode": "default" }
```

Commands may return JSON on stdout, or control flow via exit codes:

```json
{ "hookSpecificOutput": { "additionalContext": "context injected into the conversation" } }
{ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "blocked" } }
```

- exit code **0** with `additionalContext` → context injected.
- exit code **2** (PreToolUse) → tool call blocked (`terminate: true`); reason fed to the model. `terminate` skips the follow-up LLM call only when the denied call is in an all-terminating batch (pi >= 0.84.1, #7715); in a multi-tool batch the block always applies but the agent may continue.
- exit code **2** (Stop) → ignored (pi cannot block exit).
- other non-zero → logged, execution continues.
- non-JSON stdout → logged as a warning, ignored.
- each hook may set `"timeout"` (seconds, default 60); matching hooks run in **parallel**.

The `additionalContext` is injected into the pi conversation (appended to the last user message, never as a new turn).

## MCP Tool Names

Pi names MCP tools as `<serverName>_<toolName>` (not `mcp__server__tool` like Claude Code), so target them with regex like `plugin_serena_serena_.*`. Check your actual tool names with `/mcp` in pi to set the correct `matcher`.

## Config Override

Set `PI_HOOKS_CONFIG` env var to point to a custom config path.
