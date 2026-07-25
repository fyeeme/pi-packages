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

| pi event                     | peon-ping event        | Occurs when                     |
|------------------------------|------------------------|---------------------------------|
| `session_start`              | `SessionStart`         | Pi starts or resumes a session  |
| `turn_start`                 | `UserPromptSubmit`     | You submit a prompt             |
| `turn_end`                   | `Stop`                 | Agent finishes responding       |
| `tool_result` (isError)      | `PostToolUseFailure`   | A tool call fails               |
| `session_shutdown`           | `SessionEnd`           | Session ends                    |

## Configuration

### Environment variable

| Variable | Description |
|----------|-------------|
| `PEON_SH` | Absolute path to `peon.sh` / `peon.ps1`. Overrides all automatic discovery. |

### peon.sh Discovery

pi-peon-ping 自动查找已安装的 `peon.sh`，优先级如下（高 → 低）：

| 优先级 | 来源 | 路径 |
|--------|------|------|
| 1 | `$PEON_SH` 环境变量 | 用户指定 |
| 2 | Homebrew (macOS) | `$(brew --prefix peon-ping)/libexec/peon.sh` |
| 3 | curl 安装 (Linux/macOS) | `~/.claude/hooks/peon-ping/peon.sh` |
| 4 | `--openpeon` 模式 | `~/.openpeon/hooks/peon-ping/peon.sh` |
| 5 | OpenClaw 安装 | `~/.openclaw/hooks/peon-ping/peon.sh` |
| 6 | Windows/Git Bash WSL2 回退 | `~/.claude/hooks/peon-ping/peon.ps1` |

当找到 `.ps1` 文件时，自动使用 `powershell` 而非 `bash` 执行。

### peon-ping 配置

所有 peon-ping 的功能配置通过 `peon` CLI 进行：

```bash
peon packs use glados          # Switch sound pack
peon packs install --all       # Install all packs
peon trainer on                # Enable trainer mode
peon notifications off         # Mute popups but keep sounds
peon mobile ntfy my-topic      # Push notifications to phone
peon ssh-audio relay           # Route audio for remote sessions
```

## Uninstall

```bash
rm -rf ~/.pi/agent/extensions/pi-peon-ping
```

## How It Works

This is a thin adapter — it does not play sounds or send notifications directly. Instead, it finds `peon.sh` (from the peon-ping install) and spawns it with a JSON payload on each lifecycle event. `peon.sh` handles all sound selection, playback, notifications, and trainer logic.

The tab title is updated to reflect current agent state: `● working...` during a turn, `✓ done` on completion, `✗ error` on tool failures.

## Credits

Based on the [oh-my-pi (omp) adapter](https://github.com/PeonPing/peon-ping/tree/main/adapters/omp) from the peon-ping project. Sound packs by [OpenPeon](https://openpeon.com/).
