# pi-thinking-ui

Faithful, terminal-native thinking visualization for [pi](https://pi.dev). Replaces pi's built-in thinking renderer with a three-mode (collapsed / summary / expanded) view that summarizes, classifies, and renders reasoning blocks as they stream.

## Features

- **Three view modes** — collapsed (one line), summary (key steps), expanded (full reasoning)
- **Semantic step roles** — each step is classified (`inspect`, `plan`, `compare`, `verify`, `write`, `search`, `error`) with a matching icon and color
- **Extractive summaries** — surfaces failures, decisions, and concrete artifacts (file paths, commands, symbols) instead of meta-chatter
- **Per-scope state** — view mode is tracked per working directory so different projects keep their own preference
- **Persistent defaults** — save a default mode for the current project or globally
- **Live mode switching** — cycle modes mid-session without restarting
- **Redacted-reasoning fallback** — shows a stable placeholder when the provider hides reasoning

## Install

Requires the [pi](https://pi.dev) CLI.

### From npm (recommended)

```bash
# Global (user) install — available in every project
pi install npm:@fyeeme/pi-thinking-ui

# Project-local — written to .pi/settings.json, shareable with your team
pi install -l npm:@fyeeme/pi-thinking-ui

# Pinned version — skipped by `pi update`
pi install npm:@fyeeme/pi-thinking-ui@1.0.0

# Try it once without saving (current run only)
pi -e npm:@fyeeme/pi-thinking-ui
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

## Usage

| Action | Effect |
|---|---|
| `Alt+T` | Cycle the current session's view: collapsed → summary → expanded |
| `/thinking-ui` | Cycle the view, or open a mode picker in interactive mode |
| `/thinking-ui collapsed` | Set the session view to `collapsed` (also: `summary`, `expanded`) |
| `/thinking-ui project expanded` | Save `expanded` as the default for this project |
| `/thinking-ui global summary` | Save `summary` as the default everywhere |
| `/thinking-ui project clear` | Remove the saved project default |

Aliases are accepted for modes: `c`/`collapse` → `collapsed`, `s`/`summaries` → `summary`, `e`/`expand`/`full` → `expanded`.

On startup the view mode is restored from (in order): the current session's saved mode, the project default, the global default, then `summary`.

## Requirements

Pi patches an internal assistant-message component at runtime. If pi's internals are incompatible with the patch, the extension logs a warning and falls back to pi's native thinking renderer for that session; persisted defaults still apply to future compatible sessions.
