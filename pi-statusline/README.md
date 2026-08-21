# pi-statusline

[![npm version](https://img.shields.io/npm/v/@fyeeme/pi-statusline)](https://www.npmjs.com/package/@fyeeme/pi-statusline)
[![License](https://img.shields.io/npm/l/@fyeeme/pi-statusline)](LICENSE)

A rich custom status bar for [pi](https://pi.dev) that replaces the default footer. Provider-aware: shows live account balance for **DeepSeek** and rolling quota for **GLM/ZAI**, plus session tokens, cost, context window, and timing.

## Features

- **Provider-aware usage** — special support for DeepSeek and GLM/ZAI (see [Provider Support](#provider-support))
- **Token usage**: input, output, cache read/write, total per session, with cache hit rate
- **Cost**: cumulative session cost with currency auto-detection (¥ for DeepSeek/CNY, $ otherwise)
- **Context window**: usage percentage and size
- **Timing**: elapsed time + tokens/sec for last response
- **Git branch**: current branch shown in cwd display

## Provider Support

This extension uses a provider-aware strategy: when the active model belongs to a supported provider, the status bar shows live account-level usage data fetched directly from that provider's API. Other providers fall back to session-scoped cost only.

### DeepSeek

Shows live **account balance** and **weekly token usage**.

| Segment | Example | Source |
|---------|---------|--------|
| Balance | `¥0.12/50.00` | `GET /user/balance` (cached 5 min) |
| Weekly tokens | `7d:1.2M` | Local session file scan (rolling 7 days) |

- Currency auto-detected as `¥` (CNY) from the balance API response
- Session cost follows DeepSeek's peak/off-peak pricing (since 2026-08-17): peak hours are 9:00-12:00 and 14:00-18:00 Beijing time, off-peak is half price. Each message is priced at the rate of its own timestamp; the footer marks the current period (`peak` / `off-peak`).
- Balance is fetched on startup and refreshed in the background; cached for 5 minutes
- Triggered when `model.provider === "deepseek"`

### GLM / ZAI

Shows **5-hour rolling quota** and **weekly quota** (or natural-week usage as fallback).

| Segment | Example | Source |
|---------|---------|--------|
| 5h quota | `Usage 42%(1h23m)` | `GET /api/monitor/usage/quota/limit` (`unit:3`) |
| Weekly quota | `W:35%(1.2M,3d4h)` | `quota/limit` (`unit:6`) + `model-usage` API |
| Natural week | `W:1.2M` | `model-usage` API (Mon 00:00 local → now) |

- **5-hour rolling window**: percentage used + countdown to reset
- **Weekly quota**: if the plan exposes a `unit:6` weekly limit, shows percentage, tokens, and reset countdown; otherwise falls back to real usage for the current natural week (host local timezone)
- **Account level**: also fetched (visible in `/status-debug`)
- Supports both `zai` (`api.z.ai`) and `zai-coding-cn` (`open.bigmodel.cn`) endpoints

### Other providers

Session-scoped cost only (`$0.12` or `¥0.12`), with no live account data.

## Install

Requires the [pi](https://pi.dev) CLI.

### From npm (recommended)

```bash
# Global (user) install — available in every project
pi install @fyeeme/pi-statusline

# Project-local — written to .pi/settings.json, shareable with your team
pi install -l @fyeeme/pi-statusline

# Pinned version — skipped by `pi update`
pi install @fyeeme/pi-statusline@1.0.2

# Try it once without saving (current run only)
pi -e @fyeeme/pi-statusline
```

### From GitHub

Source: [`fyeeme/pi-packages`](https://github.com/fyeeme/pi-packages).

```bash
# HTTPS shorthand
pi install git:github.com/fyeeme/pi-packages
# Pin to a tag or commit (skipped by `pi update`)
pi install git:github.com/fyeeme/pi-packages@v1.0.2
# Raw URL form
pi install https://github.com/fyeeme/pi-packages
```

See the Pi Packages guide on [pi.dev](https://pi.dev) for the full list of source types, scopes, and `pi update` behavior.

## Commands

| Command | Description |
|---|---|
| `/currency [auto\|¥\|$]` | Toggle cost currency display (`auto` follows DeepSeek → ¥) |
| `/status-debug` | Dump session stats + provider usage to `/tmp/pi-status-debug.log` |

## Status Bar Layout

```
~/projects/my-repo (main)                    deepseek-v4-pro · xhigh
tokens 65k(in 12k, out 8k, cache 45k) · ¥0.12/50.00 · 7d:1.2M · 45.2%/64k · 2m30s 38.2tok/s
```

**Line 1**: cwd + git branch (left) | model + thinking level (right)

**Line 2**: token stats · provider usage · context window · timing

### GLM/ZAI example

```
~/projects/my-repo (main)                       glm-4.6 · high
tokens 65k(in 12k, out 8k, cache 45k) · Usage 42%(1h23m) · W:35%(1.2M,3d4h) · 45.2%/64k · 2m30s 38.2tok/s
```

## Environment Variables

None required. API keys are resolved automatically by pi's model registry for the active provider.

## How It Works

The extension registers a `UsageProvider` per supported provider and refreshes usage data in the background (on startup, on model switch, and after each agent run). Results are cached with a 5-minute TTL (DeepSeek) or per-refresh (ZAI) to avoid hammering the provider APIs.

All network calls are best-effort with a 5-second timeout — failures stay silent and never block the status bar.

> **Platform API note:** the custom footer relies on `ctx.ui.setFooter`'s third parameter — `footerData: ReadonlyFooterDataProvider` (for `getGitBranch`/`getExtensionStatuses`/`onBranchChange`) — and on returning `dispose` from the footer factory. These are part of the 0.84.x `ExtensionAPI` surface (see `dist/core/extensions/types.d.ts`), but pi's `docs/extensions.md` currently documents only the `(tui, theme)` form. If a future pi release changes the `setFooter` signature, check this extension's footer wiring first.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT
