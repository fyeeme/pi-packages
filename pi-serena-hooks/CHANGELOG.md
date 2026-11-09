# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-11-08

### Added

- Initial release. Bridges pi extension events to `serena-hooks`, Serena's Claude Code-compatible hook CLI: `activate` on `session_start` (injects the activate prompt as a hidden custom message, re-armed after compaction), `remind` on `tool_call` (blocks bash/read/grep calls when serena-hooks reports a drift streak; Serena tool calls reset its counters), `cleanup` on `session_shutdown`. Fails open: a missing `serena-hooks` binary disables the extension with a one-time UI warning.
