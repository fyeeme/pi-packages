# pi-session-name

[![npm version](https://img.shields.io/npm/v/@fyeeme/pi-session-name)](https://www.npmjs.com/package/@fyeeme/pi-session-name)
[![License](https://img.shields.io/npm/l/@fyeeme/pi-session-name)](LICENSE)

Auto-name [pi](https://pi.dev) sessions with a short LLM-generated title so `--resume` lists are easy to scan — instead of the raw first message.

## Features

- **First-mode** (default) — names the session once on first agent response, then leaves it alone
- **Auto-mode** — re-evaluates each turn; the title tracks the current topic
- **Never overwrites manual names** — detects `/name`, `--name`, the resume picker's rename, or any other extension calling `setSessionName`, and locks itself for the rest of the session
- **`/rename [name]`** — rename the current session on demand. With an argument it sets that name; without, it generates one from the conversation
- **Language-aware** — titles use the same language as your first message
- **Descriptive titles** — key entity + action + goal (~15-40 chars), not terse labels
- **Graceful failure** — model unavailable or no API key? Stays silent, never blocks the session

## Prerequisites

- [pi](https://pi.dev) >= 0.80.0 (uses `agent_settled` / `session_info_changed` events)

## Installation

### As a pi package (recommended)

```bash
# Global (user) install
pi install @fyeeme/pi-session-name

# Project-local (.pi/settings.json)
pi install -l @fyeeme/pi-session-name

# Try once without saving
pi -e @fyeeme/pi-session-name
```

### Manual (development)

```bash
# Clone the repo
git clone https://github.com/fyeeme/pi-packages.git
cd pi-packages/packages/extensions/pi-session-name

# Symlink to pi extensions
ln -s "$(pwd)" ~/.pi/agent/extensions/pi-session-name
```

## Usage

No configuration needed for the default `first` mode. Just install and use pi — your first session will auto-name itself.

If you want to change behavior, see [Configuration](#configuration).

### Commands

| Command | Description |
|---------|-------------|
| `/rename <name>` | Rename session to `<name>` and lock out auto-naming |
| `/rename` | Generate a descriptive name from the current conversation |

> **Note**: `/rename` is a manual action — once used, auto-naming is locked for the rest of the session. This is consistent with pi's built-in `/name` command.

## Configuration

Create `.pi/session-name.json` in your project root:

```json
{
	"mode": "auto",
	"maxLength": 200,
	"model": { "provider": "openai", "id": "gpt-4o-mini" }
}
```

### Options

| Option | Default | Env override | Description |
|--------|---------|--------------|-------------|
| `mode` | `"first"` | `PI_SESSION_NAME_MODE` | `"first"` — name once; `"auto"` — re-evaluate each turn |
| `maxLength` | `200` | `PI_SESSION_NAME_MAX_LENGTH` | Character cap for generated titles |
| `enabled` | `true` | `PI_SESSION_NAME_ENABLED=false` | Master switch to disable auto-naming |
| `model` | current session model | `PI_SESSION_NAME_MODEL_PROVIDER` + `PI_SESSION_NAME_MODEL_ID` | Override the model used to generate titles |

By default the extension uses the model you're already chatting with (`ctx.model`), so no extra API key is needed.

### Environment variables only

If you prefer environment variables over a config file:

```bash
export PI_SESSION_NAME_MODE=auto
export PI_SESSION_NAME_MAX_LENGTH=150
export PI_SESSION_NAME_ENABLED=true
export PI_SESSION_NAME_MODEL_PROVIDER=openai
export PI_SESSION_NAME_MODEL_ID=gpt-4o-mini
```

## How it works

1. On `agent_settled` (after the first turn completes), the extension builds a condensed text of the conversation
2. It asks the LLM (same model as the session, unless overridden) to generate a descriptive title
3. The title is set via `pi.setSessionName()`, which updates the resume picker immediately
4. In `first` mode, it stops there. In `auto` mode, each subsequent turn re-evaluates: the LLM returns either `KEEP` or a new title
5. If a manual rename is detected (`session_info_changed` with a name the extension didn't set), auto-naming locks permanently

## Smoke test

```bash
# 1. Fresh session with auto-naming
pi -e @fyeeme/pi-session-name
# Ask a question, wait for reply → resume picker shows a generated title

# 2. Manual rename protection
/name foo
# Chat a few turns → name stays "foo" (locked)

# 3. Auto mode: topic tracking
# Set mode to "auto", shift topic across turns → name updates; same topic → stays

# 4. /rename command
/rename foo    # → name is "foo", locked
/rename        # → generates a fresh name from the conversation

# 5. Graceful degradation (unset model's API key)
# → No errors, session runs normally
```

## API (for extension developers)

This extension exposes utilities that other extensions can import:

```typescript
import {
	buildConversationText,
	cleanTitle,
	buildFirstPrompt,
	buildAutoPrompt,
	loadConfig,
	generateTitle,
} from "@fyeeme/pi-session-name";
```

See `index.ts` for complete type signatures.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT
