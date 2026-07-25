# pi-peon-ping

peon-ping adapter for [pi](https://github.com/earendil-works/pi-coding-agent). Routes pi lifecycle events through `peon.sh` for sound packs, desktop notifications, and trainer reminders.

## Features

- **Sound packs** — Warcraft, StarCraft, Portal, Red Alert, and 160+ game character voice packs
- **Desktop notifications** — overlay banners when the terminal is not focused
- **Trainer reminders** — Pavel-style daily exercise nagging
- **SSH/devcontainer relay** — sounds play on your local machine, not the remote
- **Mobile notifications** — push to your phone via ntfy, Pushover, or Telegram
- **Tab title updates** — `● project: working...` / `✓ project: done` / `✗ project: error`

## Prerequisites

Install [peon-ping](https://github.com/PeonPing/peon-ping) first:

**Option 1: Homebrew**

```bash
brew install PeonPing/tap/peon-ping
```

**Option 2: Installer script (macOS, Linux, WSL2)**

```bash
curl -fsSL https://raw.githubusercontent.com/PeonPing/peon-ping/main/install.sh | bash
```

## Installation

### As a pi package

```bash
pi install @fyeeme/pi-peon-ping
```

### Manual (development)

Copy `index.ts` to `~/.pi/agent/extensions/pi-peon-ping/` (global) or `.pi/extensions/pi-peon-ping/` (project-local), then restart pi.

### From the monorepo

This package lives at `packages/extensions/pi-peon-ping/`. To use it locally, symlink or copy the `index.ts` to your extensions directory:

```bash
ln -s $(pwd)/packages/extensions/pi-peon-ping ~/.pi/agent/extensions/pi-peon-ping
```

## Event Mapping

Each pi event is mapped to a peon-ping event, which peon-ping routes to a sound
**category** — the keys under `categories` in `~/.openpeon/config.json`. Toggle a
category off there to silence just that event without touching the others.

| pi event | peon-ping event | category | Occurs when |
|---|---|---|---|
| `session_start` | `SessionStart` | `session.start` | Pi starts or resumes a session |
| `before_agent_start` | `UserPromptSubmit` | `task.acknowledge` | You submit a prompt (once per agent run) |
| `agent_end` | `Stop` | `task.complete` | An agent run finishes (once per prompt) |
| `tool_result` (isError) | `PostToolUseFailure` | `task.error` | A tool call fails |
| `tool_call` (`ask_user_question`) | `PermissionRequest` | `input.required` | Agent asks you a question |
| `session_before_compact` | `PreCompact` | `resource.limit` | Context is about to be compacted |
| `session_shutdown` | `SessionEnd` | — | Session ends (always fires) |

> **Why `agent_end` / `before_agent_start` instead of `turn_*`?**
> A single agent run spans multiple turns (e.g. several tool calls in a row).
> Mapping `turn_end` → `Stop` would fire the completion sound on every turn;
> `agent_end` fires once per prompt, which is what the completion sound should
> mean. Same reasoning for `before_agent_start` vs `turn_start`.

> **`input.required` needs the `ask_user_question` tool**, provided by an
> extension such as [@juicesharp/rpiv-ask-user-question](https://github.com/juicesharp/rpiv-ask-user-question).
> It listens for the `tool_call` event with `toolName === "ask_user_question"`.
> Without such a tool installed, this category never fires.

## Configuration

### Environment variable

| Variable | Description |
|----------|-------------|
| `PEON_SH` | Absolute path to `peon.sh` / `peon.ps1`. Overrides all automatic discovery. |

### peon.sh Discovery

pi-peon-ping auto-discovers the installed `peon.sh` with the following priority (high → low):

| Priority | Source | Path |
|----------|--------|------|
| 1 | `$PEON_SH` env var | User-specified |
| 2 | Homebrew (macOS) | `$(brew --prefix peon-ping)/libexec/peon.sh` |
| 3 | curl install (Linux/macOS) | `~/.claude/hooks/peon-ping/peon.sh` |
| 4 | `--openpeon` mode | `~/.openpeon/hooks/peon-ping/peon.sh` |
| 5 | OpenClaw install | `~/.openclaw/hooks/peon-ping/peon.sh` |
| 6 | Windows/Git Bash WSL2 fallback | `~/.claude/hooks/peon-ping/peon.ps1` |

When a `.ps1` file is found, it is automatically run with `powershell` instead of `bash`.

### peon-ping 配置

所有 peon-ping 的功能配置通过 `peon` CLI 进行：

```bash
peon packs use glados          # Switch sound pack
peon packs install --all       # Install all packs
peon trainer on                # Enable trainer mode
peon notifications off         # Mute popups but keep sounds
peon mute                      # Mute all sounds (toggle back with `peon toggle`)
peon mobile ntfy my-topic      # Push notifications to phone
peon ssh-audio relay           # Route audio for remote sessions
```

## Uninstall

```bash
rm -rf ~/.pi/agent/extensions/pi-peon-ping
```

## How It Works

This is a thin adapter — it does not play sounds or send notifications directly. Instead, it finds `peon.sh` (from the peon-ping install) and spawns it with a JSON payload on each lifecycle event. `peon.sh` handles all sound selection, playback, notifications, and trainer logic.

The tab title reflects agent state: `● working...` when an agent run starts, `✓ done` when it finishes, `✗ error` on tool failures.

## Credits

Based on the [oh-my-pi (omp) adapter](https://github.com/PeonPing/peon-ping/tree/main/adapters/omp) from the peon-ping project. Sound packs by [OpenPeon](https://openpeon.com/).
