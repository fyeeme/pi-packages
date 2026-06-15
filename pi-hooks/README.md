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
        "matcher": "plugin_serena_serena_*",
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
| `SessionStart` | `session_start` | Runs on startup. `additionalContext` sent via `sendUserMessage`. |
| `PreToolUse` (empty matcher) | `tool_call` | Runs before every tool with real `tool_name`. `additionalContext` injected before next LLM call. |
| `PreToolUse` (pattern matcher) | `tool_call` | Glob match against pi tool name (e.g. `plugin_serena_serena_*`). |
| `Stop` | `session_shutdown` | Runs on exit. |

## Protocol

Commands receive Claude Code-compatible JSON on stdin:

```json
{ "type": "session_start", "session_id": "...", "transcript_path": "..." }
{ "type": "pre_tool_use", "session_id": "...", "tool_name": "bash", "tool_input": {} }
{ "type": "stop", "session_id": "..." }
```

Commands may return JSON on stdout:

```json
{ "hookSpecificOutput": { "additionalContext": "..." } }
```

The `additionalContext` is injected into the pi conversation.

## MCP Tool Names

Pi names MCP tools as `<serverName>_<toolName>` (not `mcp__server__tool` like Claude Code). Check your actual tool names with `/mcp` in pi to set the correct `matcher`.

## Config Override

Set `PI_HOOKS_CONFIG` env var to point to a custom config path.
