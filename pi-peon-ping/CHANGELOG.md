# Changelog

## [Unreleased]

## [1.1.0] - 2026-07-26

### Added

- New lifecycle event mappings: `session_before_compact` → `PreCompact` (context compaction) and `tool_call` for `ask_user_question` → `PermissionRequest` (input required)
- Category-aware event firing — reads peon-ping `config.json` and skips spawning `peon.sh` for events whose category is toggled off. New helpers: `EVENT_CATEGORY`, `resolveConfigPath`, `readPeonConfig`, `isCategoryEnabled`
- `findPeonCli` / `execPeonCli` utility functions for CLI invocation of peon.sh
- `peon-ping-toggle` and `peon-ping-use` commands

### Changed

- Map `UserPromptSubmit` and `Stop` to `before_agent_start` and `agent_end` (once per prompt) instead of `turn_start` / `turn_end` (once per turn), so the completion sound fires once per agent run rather than on every turn

## [1.0.0] - 2025-07-25

### Added

- Initial release of pi-peon-ping
- Route pi lifecycle events through peon.sh:
  - `session_start` → `SessionStart`
  - `turn_start` → `UserPromptSubmit`
  - `turn_end` → `Stop`
  - `tool_result` (isError) → `PostToolUseFailure`
  - `session_shutdown` → `SessionEnd`
- Terminal tab title updates with visual status indicators
- Auto-discovery of peon.sh at standard install paths
