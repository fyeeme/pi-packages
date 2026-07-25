# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.1] - 2025-07-15

### Fixed

- Process hang when hook command ignores SIGTERM: added SIGKILL escalation after 5s grace window
- Race condition between `close` and `error` events: added `finish()` guard to prevent double-resolve

## [1.0.0] - 2025-05-31

### Added

- Initial release
- Claude Code-compatible hooks runner for pi
- SessionStart hooks via `before_agent_start` with context injection
- PreToolUse hooks via `tool_call` with queued context injection
- Stop hooks via `session_shutdown`
- All additionalContext injected via `context` event into last user message
- Config loaded from `.pi/hooks.json` or `PI_HOOKS_CONFIG` env var
- Glob matching for tool name matchers
