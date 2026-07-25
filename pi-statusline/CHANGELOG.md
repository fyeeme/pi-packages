# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.2] - 2025-07-15

### Fixed

- `getCachedUsage` crash when TTL expires and model provider has no registered UsageProvider (TypeError on null)
- `scanWeeklyTokens` UTC/local timezone mismatch: file date parsing now uses local timezone to match `startOfCurrentWeekLocal`
- Unhandled rejection in `refreshUsage` fire-and-forget callers: added catch-all error handler

### Changed

- Background usage refresh now deduplicates concurrent TTL-expired callers via memoized `refreshInFlight` promise
- Weekly token scan results cached for 1 minute to reduce redundant filesystem I/O

### Removed

- MCP server status segment from footer and its event listeners (`mcp:status`/`mcp:disconnect`): no pi version emits these events

## [1.0.1] - 2026-06-19

### Fixed

- ZAI weekly token count for plans without a `unit:6` weekly quota now comes from the backend `model-usage` API for the current natural week (Mon 00:00 UTC → now) instead of scanning local session files, so it matches the backend's per-week tally. Footer label changed from `7d:` to `W:` to reflect the natural-week window.

### Changed

- Natural-week window (DeepSeek local scan and ZAI fallback) now uses the host's local timezone instead of UTC, so "this week" matches the user's expectation. Both providers share the same boundary via `startOfCurrentWeekLocal`.

### Removed

- `quota/` directory (`QuotaCalculator` and its DeepSeek/ZAI implementations) and the `quotaCalculator` field on `UsageProvider`. These were never invoked at runtime; the live logic lives in the providers directly.

## [1.0.1] - 2026-06-19

### Fixed

- Tighten tokens-per-second spacing in the footer timing segment: render `39.5tok/s` instead of `39.5 tok/s`.

## [1.0.0] - 2025-05-31

### Added

- Initial release
- Two-line footer: cwd + git branch (left) / model + thinking level (right), and token stats line
- Token usage: input, output, cache read/write, total per session
- Cost display with auto currency detection (¥ for DeepSeek, $ otherwise)
- DeepSeek account balance fetched on startup, cached 5 minutes
- Context window usage percentage and size
- Elapsed time and tokens/sec for last response
- MCP server connection count and tool count via `mcp:status` / `mcp:disconnect` events
- `/balance` command to force-refresh DeepSeek balance
- `/currency [auto|¥|$]` command to toggle cost currency
- `/status-debug` command to dump session stats to log file
