# pi-statusline

A rich custom status bar for [pi](https://pi.dev) that replaces the default footer.

## Features

- **Token usage**: input, output, cache read/write, total per session
- **Cost**: cumulative cost with currency auto-detection (¥ for DeepSeek, $ otherwise)
- **DeepSeek balance**: live account balance fetched on startup and cached for 5 minutes
- **Context window**: usage percentage and size
- **Timing**: elapsed time + tokens/sec for last response
- **MCP status**: connected server count and total tool count
- **Git branch**: current branch shown in cwd display

## Install

Requires the [pi](https://pi.dev) CLI.

### From npm (recommended)

```bash
# Global (user) install — available in every project
pi install npm:@fyeeme/pi-statusline

# Project-local — written to .pi/settings.json, shareable with your team
pi install -l npm:@fyeeme/pi-statusline

# Pinned version — skipped by `pi update`
pi install npm:@fyeeme/pi-statusline@1.0.0

# Try it once without saving (current run only)
pi -e npm:@fyeeme/pi-statusline
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

## Commands

| Command | Description |
|---|---|
| `/balance` | Force refresh DeepSeek account balance |
| `/currency [auto\|¥\|$]` | Toggle cost currency display |
| `/status-debug` | Dump session stats to `/tmp/pi-status-debug.log` |

## Status Bar Layout

```
~/projects/my-repo (main)                    deepseek-v3 · xhigh
in 12k, out 8k, cache 45k, total 65k · ¥0.12/50.00 · 12.3%/64k · 45s 38.2tok/s · MCP:2(15)
```

Line 1: cwd + git branch (left) | model + thinking level (right)
Line 2: token stats · cost/balance · context · timing · MCP

## MCP Integration

When used with [pi-mcp-adapter](https://www.npmjs.com/package/pi-mcp-adapter), the status bar shows live MCP connection status via `mcp:status` and `mcp:disconnect` events.
