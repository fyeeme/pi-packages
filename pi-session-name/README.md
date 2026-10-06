# pi-session-name

[![npm version](https://img.shields.io/npm/v/@fyeeme/pi-session-name)](https://www.npmjs.com/package/@fyeeme/pi-session-name)
[![License](https://img.shields.io/npm/l/@fyeeme/pi-session-name)](LICENSE)

Auto-name [pi](https://pi.dev) sessions with a short LLM-generated title so `--resume` lists are easy to scan — instead of the raw first message.

## Features

- **Follow-mode** (default) — regenerates the title every turn, so it tracks the conversation as its real subject emerges (never freezes on an early-turn snapshot)
- **First-mode** — names the session once on first agent response, then leaves it alone
- **Auto-mode** — re-evaluates each turn (KEEP/NEW verdict); the title tracks the current topic
- **Never overwrites manual names** — detects `/name`, `--name`, the resume picker's rename, or any other extension calling `setSessionName`, and locks itself for the rest of the session
- **Creation-time prefix** — every title is prefixed `yyyy-mm-dd hh:mm - …` so sessions edited later still show when they were created (the list sorts by last-modified)
- **`/rename [name]`** — rename the current session on demand. With an argument it sets that name; without, it generates one from the conversation
- **Language-aware** — titles use the same language as your first message
- **Distinctive titles** — summarizes the concrete main task instead of copying greetings or opening filler
- **Optional short titles** — configure a hard `maxWords` limit, such as three words for a terminal tab
- **Optional conversation context** — include bounded assistant text and the latest compaction summary to clarify vague requests
- **Graceful failure** — preserves an existing title when a model call fails; only unnamed sessions get a first-message fallback

## Prerequisites

- [pi](https://pi.dev) >= 0.99.0 (uses `agent_settled` / `session_info_changed` events and authenticated model-registry calls)

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
cd pi-packages/pi-session-name

# Symlink to pi extensions
ln -s "$(pwd)" ~/.pi/agent/extensions/pi-session-name
```

## Usage

No configuration needed for the default `follow` mode. Just install and use pi — the session is named (and re-named) as turns settle, tracking the conversation.

> **Tip**: `follow` regenerates the title every turn (one short model call per settled turn). If you only want a one-shot name, set `"mode": "first"` — the session is named after the first turn and never touched again. `"auto"` re-evaluates each turn with a cheap classifier (KEEP/NEW) before paying for a regeneration.

If you want to change behavior, see [Configuration](#configuration).

### Commands

| Command | Description |
|---------|-------------|
| `/rename <name>` | Rename session to `<name>` and lock out auto-naming |
| `/rename` | Generate a descriptive name from the current conversation |

> **Note**: `/rename` is a manual action — once used, auto-naming is locked for the rest of the session. This is consistent with pi's built-in `/name` command.

## Configuration

Create `session-name.json` in your personal Pi agent directory (normally
`~/.pi/agent/`) to set defaults for all projects, or create
`.pi/agent/session-name.json` in a project for overrides. Precedence is
**built-in defaults → personal file → project file → environment variables**.
The personal location follows Pi's `PI_CODING_AGENT_DIR` override.

```json
{
	"mode": "auto",
	"maxLength": 200
}
```

For short, conversation-aware titles suitable for terminal tabs:

```json
{
	"mode": "auto",
	"maxWords": 3,
	"includeAssistantContext": true,
	"appendCreationTime": false
}
```

The extra settings are opt-in: existing defaults and mode choices remain the
same. `maxWords` counts whitespace-delimited words **before** byte truncation
and excludes the creation-time prefix. An overlong generated title is rejected,
not clipped to an arbitrary three-word fragment. Explicit `/rename <name>`
bypasses the word limit but still applies terminal sanitization and `maxLength`.
For languages without word spaces, retain `maxLength` as the size limit.
Invalid configuration values are ignored rather than replacing valid defaults.

### Options

| Option | Default | Env override | Description |
|--------|---------|--------------|-------------|
| `mode` | `"follow"` | `PI_SESSION_NAME_MODE` | `"follow"` — regenerate every turn (all-prompts cadence); `"first"` — name once; `"auto"` — re-evaluate each turn (KEEP/NEW) |
| `maxLength` | `200` | `PI_SESSION_NAME_MAX_LENGTH` | UTF-8 byte budget for accepted titles (200 bytes ≈ 200 ASCII chars or ~66 CJK chars) |
| `maxWords` | Unset | `PI_SESSION_NAME_MAX_WORDS` | Optional positive safe integer limiting generated title words; applies to both prompt styles and KEEP/NEW requests |
| `includeAssistantContext` | `false` | `PI_SESSION_NAME_INCLUDE_ASSISTANT_CONTEXT` | Include role-labelled user/assistant text and the latest compaction summary; excludes thinking, images, tools, system messages, and custom messages |
| `prompt` | `"concise"` | `PI_SESSION_NAME_PROMPT` | `"concise"` — task-focused summaries, 512-token budget (default); `"editorial"` — adds distinctiveness/concrete-detail rules, 1024-token budget |
| `enabled` | `true` | `PI_SESSION_NAME_ENABLED=false` | Master switch to disable auto-naming |
| `appendCreationTime` | `true` | `PI_SESSION_NAME_TIMESTAMP=false` | Prefix every title with the session's creation time — `yyyy-mm-dd hh:mm - title`. The resume list sorts by last-modified, so an edited old session resurfaces at the top; the prefix keeps its original age visible. Parsed from the session file name (best effort: no stamp, no prefix). |

Titles are generated with the model you're already chatting with (`ctx.model`) — there is no model override. Calls go through Pi's authenticated model registry: `complete()` for non-reasoning models and provider-neutral `streamSimple()` for reasoning-capable models. The latter uses low effort **only for the auxiliary title request**, letting Pi map it to supported provider options; the main session's model and thinking settings are unchanged. API keys and OAuth subscription logins both work without extra credentials.

### Environment variables only

If you prefer environment variables over a config file:

```bash
export PI_SESSION_NAME_MODE=auto
export PI_SESSION_NAME_MAX_LENGTH=150
export PI_SESSION_NAME_MAX_WORDS=3
export PI_SESSION_NAME_INCLUDE_ASSISTANT_CONTEXT=true
export PI_SESSION_NAME_ENABLED=true
```

## How it works

### Modes

- **`follow`** (default) — every settled turn regenerates the title unconditionally (the deepseek-harness `all-prompts` cadence): the title always tracks the conversation's current subject, including across resumes (an inherited title is treated as the last revision, not a pin). Costs one short generation call per turn; the title may change between turns — `/rename` pins it for good.
- **`first`** — one title after the first turn. Cheapest, but the title freezes on the early-turn snapshot: if the conversation's real subject emerges later, the title drifts.
- **`auto`** — after the first title, each settled turn runs a KEEP/NEW verdict (a classifier model when the host has one); KEEP costs no generation call, NEW regenerates. Balanced.

### Prompt styles

Two system-prompt styles ship:

- **`concise`** (default) — task-focused summaries with plain-text output discipline and approximate language-aware length targets; 512-token output budget.
- **`editorial`** — additionally emphasizes distinctive concrete entities, errors, and identifiers; 1024-token output budget.

An explicit `maxWords` overrides either style's approximate word target. Switch
styles in either configuration file (`"prompt": "editorial"`) or with
`PI_SESSION_NAME_PROMPT=editorial`.

### Pipeline

1. On `agent_settled`, the extension collects bounded human text from the current branch. With `includeAssistantContext: true`, it instead frames role-labelled user/assistant text plus the latest compaction summary. Human intent remains authoritative; tool results, thinking blocks, images, system messages, and custom messages are excluded.
2. The model receives a separate `systemPrompt` and a JSON-framed user payload. Both share a 16 KiB UTF-8 input budget. Oversized windows narrow from older non-first messages, preserving the opening request and recent tail; oversized text is shortened without splitting code points.
3. The current session model generates the title within the prompt style's output budget. There are no provider-specific defaults or model overrides.
4. Output is terminal-sanitized and checked against optional `maxWords` before applying the UTF-8 `maxLength` budget. On error, abort, timeout, non-`stop` finish, or invalid output, an **existing title stays unchanged**. Only an unnamed session gets the deterministic first-message fallback (up to `maxWords`, or eight words when unset).
5. The title is set via `pi.setSessionName()`. Session changes, new turns, shutdown, or manual renames invalidate pending results so they cannot overwrite newer state.
6. `first` generates once; `follow` regenerates each settled turn; `auto` prefers a classifier KEEP/NEW verdict when available and otherwise uses a completion verdict. Oversized classifier inputs skip to the bounded completion path.
7. A manual rename locks background naming for the rest of the session. `/rename` without arguments summarizes the **whole selected conversation window**, rather than only the opening request; it remains a manual action and pins the result. A failed explicit generation reports a warning and preserves an existing title.

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

# 5. Graceful degradation (model unavailable / model call fails)
# → No errors, session runs normally
```

## Development and verification

From this package directory:

```bash
npm ci
npm test
npm run typecheck
```

The package has a self-contained TypeScript configuration and does not require
an external workspace configuration. Tests mock model calls and isolate both
personal configuration files and `PI_SESSION_NAME_*` variables; they do not
require API credentials or a running model provider.

## API (for extension developers)

This extension exposes utilities that other extensions can import:

```typescript
import {
	buildTitleMessages,
	normalizeSessionTitle,
	fallbackSessionTitle,
	buildTitleRequest,
	buildVerdictRequest,
	loadConfig,
	generateTitle,
} from "@fyeeme/pi-session-name";
```

See `src/core.ts` for complete signatures. Existing calls remain valid;
`normalizeSessionTitle(raw, maxBytes, maxWords?)`,
`buildTitleRequest(mode, messages, style?, maxWords?)`, and
`buildVerdictRequest(currentName, messages, style?, maxWords?)` accept an optional
word limit. `buildTitleMessages` remains human-only regardless of configuration.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT
