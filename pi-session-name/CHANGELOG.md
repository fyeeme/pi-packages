# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.4] - 2026-09-17

### Added

- Conflict-aware naming: `collectRecentSessionTitles` / `parseSessionTitle` scan local sibling session files (newest first, 60s TTL cache) and inject the recent titles into both the first-title and auto-rename prompts, so a generated title never duplicates or rewords one already in the session list. The current session's file and its own name are excluded; any storage read failure degrades silently to no list.

### Changed

- Prompt rewrite for distinctiveness: titles must lead with the concrete entity, error, or identifier instead of generic labels ("bug fix", "code review"); parentheses are banned from output; auto-mode titles now aim for 30-55 characters and prefer capturing the conversation's root cause or conclusion over staying short.
- README tip: in `first` mode the session is named after the first turn — switch to `"mode": "auto"` when the key point usually emerges only in later turns.

## [1.0.3] - 2026-09-09

### Changed

- Project config path uses `CONFIG_DIR_NAME` instead of a hardcoded `.pi`.
- Title generation forwards `ctx.signal` so aborts cancel the nested model call.

## [1.0.2] - 2025-07-25

### Fixed

- Race condition where auto-generated title could overwrite manual rename when `generateTitle` async call completes after user renamed the session

## [1.0.1] - 2025-07-25

### Added

- `/rename [name]` command: manually rename the current session on demand. With a name argument it sets that name; with no argument it auto-generates one from the conversation. Invoking it locks out background auto-naming (manual control), consistent with `/name`.

### Changed

- Title-generation prompt now favors descriptive titles (key entity + action + goal, ~15-40 characters) over terse labels. Previously the prompt emphasized "short/concise", which produced overly brief session names.

## [1.0.0] - 2025-07-20

### Added

- Initial release
- Auto-name pi sessions with a short LLM-generated title on first `agent_settled`
- `first` mode (default): name once, never overwrite
- `auto` mode: re-evaluate each turn, rename when the topic drifts (LLM returns `KEEP` or a new title)
- Never overwrites manual names (`/name`, `--name`, RPC, other extensions)
- Title follows the language of the user's first message
- Config via `.pi/session-name.json` and `PI_SESSION_NAME_*` env vars
