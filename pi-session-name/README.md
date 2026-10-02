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
- **Distinctive titles** — leads with the concrete entity/error/identifier, so similar sessions don't blur together (~15-40 chars)
- **Graceful failure** — model unavailable or model call fails? Stays silent, never blocks the session

## Prerequisites

- [pi](https://pi.dev) >= 0.99.0 (uses `agent_settled` / `session_info_changed` events and `ctx.modelRegistry.complete()` / `classify()`)

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

Create `.pi/agent/session-name.json` in your project root:

```json
{
	"mode": "auto",
	"maxLength": 200
}
```

### Options

| Option | Default | Env override | Description |
|--------|---------|--------------|-------------|
| `mode` | `"follow"` | `PI_SESSION_NAME_MODE` | `"follow"` — regenerate every turn (all-prompts cadence); `"first"` — name once; `"auto"` — re-evaluate each turn (KEEP/NEW) |
| `maxLength` | `200` | `PI_SESSION_NAME_MAX_LENGTH` | UTF-8 byte budget for accepted titles (200 bytes ≈ 200 ASCII chars or ~66 CJK chars) |
| `prompt` | `"concise"` | `PI_SESSION_NAME_PROMPT` | `"concise"` — deepseek-harness wording, 512-token budget (default); `"editorial"` — adds distinctiveness/concrete-detail rules, 1024-token budget |
| `enabled` | `true` | `PI_SESSION_NAME_ENABLED=false` | Master switch to disable auto-naming |
| `appendCreationTime` | `true` | `PI_SESSION_NAME_TIMESTAMP=false` | Prefix every title with the session's creation time — `yyyy-mm-dd hh:mm - title`. The resume list sorts by last-modified, so an edited old session resurfaces at the top; the prefix keeps its original age visible. Parsed from the session file name (best effort: no stamp, no prefix). |

Titles are generated with the model you're already chatting with (`ctx.model`) — there is no model override. Model calls go through `ctx.modelRegistry.complete()`, which resolves authentication at request time — API keys and OAuth subscription logins both work, with no extra API key configuration.

### Environment variables only

If you prefer environment variables over a config file:

```bash
export PI_SESSION_NAME_MODE=auto
export PI_SESSION_NAME_MAX_LENGTH=150
export PI_SESSION_NAME_ENABLED=true
```

## How it works

### Modes

- **`follow`** (default) — every settled turn regenerates the title unconditionally (the deepseek-harness `all-prompts` cadence): the title always tracks the conversation's current subject, including across resumes (an inherited title is treated as the last revision, not a pin). Costs one short generation call per turn; the title may change between turns — `/rename` pins it for good.
- **`first`** — one title after the first turn. Cheapest, but the title freezes on the early-turn snapshot: if the conversation's real subject emerges later, the title drifts.
- **`auto`** — after the first title, each settled turn runs a KEEP/NEW verdict (a classifier model when the host has one); KEEP costs no generation call, NEW regenerates. Balanced.

### Prompt styles

Two system-prompt styles ship (measured A/B on 50 local sessions with a reasoning model, glm-5.3-flash):

- **`concise`** (default) — deepseek-harness wording verbatim: four lines of format discipline, no editorial content rules. 96% title yield, p50 latency 5.1 s, uniform lengths.
- **`editorial`** — same architecture plus pi's distinctiveness rules (never a generic headline; carry the concrete module/error/identifier). Titles are more information-dense, but the extra rules induce longer chain-of-thought on reasoning models, so the output budget is raised to 1024 tokens and latency runs ~30% higher.

Switch in `.pi/agent/session-name.json` (`"prompt": "editorial"`) or via `PI_SESSION_NAME_PROMPT=editorial`.

### Pipeline (deepseek-harness discipline, 1:1 where the host allows)

1. On `agent_settled`, the extension collects the eligible **human messages** (assistant/system never enter a title request): first message plus the recent tail, per-message cap, and a 16 KiB UTF-8 input budget that narrows from the oldest non-first message
2. It sends a **system/user split** request: the system instruction carries the output discipline (plain text, no Markdown/XML/code/terminal codes, language of the messages, ~6 words / ~18 CJK chars); the user payload is the JSON-framed message array, so untrusted text cannot forge structural delimiters
3. Output is normalized — ANSI/OSC/CSI/control/bidi stripping, quote/punctuation trimming — and capped by a **UTF-8 byte budget** (`maxLength`, default 200 bytes ≈ 200 ASCII chars or ~66 CJK chars)
4. On any failure (provider error, abort, 20 s timeout, non-`stop` finish, empty output), a **deterministic fallback** names the session from the first human message's leading words — zero LLM involvement
5. The title is set via `pi.setSessionName()`, which updates the resume picker immediately
6. In `first` mode, it stops there. `follow` regenerates every turn (all-prompts cadence). `auto` runs a KEEP/NEW verdict (classifier when available)
7. If a manual rename is detected (`session_info_changed` with a name the extension didn't set), auto-naming locks permanently

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

See `index.ts` for complete type signatures.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT
