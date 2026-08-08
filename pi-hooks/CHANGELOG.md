# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.2] - 2026-08-08

### Breaking Changes

- Matchers are now **regex** (Claude Code compatible) instead of globs. Convert patterns like `plugin_serena_serena_*` → `plugin_serena_serena_.*`. `""`/`"*"` still match all; invalid regex falls back to literal.
- Minimum supported pi is now **0.84.1** (peer dependency `>=0.84.1`). Required because a denied PreToolUse now returns `terminate: true`, which was added to pi's `tool_call` event in 0.84.1 (#7715).

### Added

- PreToolUse blocking: `permissionDecision: "deny"` and exit code 2 now block the tool via pi's `{ block: true, reason, terminate: true }` (requires pi >= 0.84.1). `terminate` skips the follow-up LLM call only in an all-terminating batch; the block always applies.
- Claude Code-compatible stdin fields on every hook: `hook_event_name`, `cwd`, `permission_mode`, plus a real `session_id` (pi session UUID) and `transcript_path` (conversation JSONL path).
- SessionStart `matcher` now matches the session source (`startup`/`resume`/`clear`/...), mapped from the pi `session_start` reason.
- Per-hook `timeout` (seconds, default 60) and parallel execution of matching hooks.

### Changed

- SessionStart hooks now bind to the `session_start` event (was `before_agent_start`) so source matchers work; `additionalContext` is still injected via the `context` event.
- Config load result (including failure) is now cached per session — a missing/unreadable file no longer triggers a disk read on every event.
- Hook subprocesses are killed as a process group (grandchildren no longer orphaned); stdout is capped at 10 MB; multi-byte stdout is decoded once via `Buffer.concat` (no mojibake).
- `session_id` uses the platform `sessionManager.getSessionId()` instead of a `Date.now()` fallback; user-config lookup uses `os.homedir()` (Windows-compatible).

### Fixed

- Crash: writing stdin to a hook that ignores it raised an uncaught `EPIPE` and killed the whole pi process (stdin/stdout now swallow stream errors).
- Crash: unbounded stdout accumulation hit the V8 string limit (`RangeError`) and killed pi within ~0.3s.
- Crash: a syntactically valid but misshapen `hooks.json` (e.g. `{}`, `{ "hooks": null }`) threw `TypeError` inside awaited handlers; configs are now validated/normalized.
- Dropped `additionalContext` from non-empty-matcher PreToolUse groups.
- Repeated `[hooks] failed to parse` log spam on every event when the config file was unreadable.

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
