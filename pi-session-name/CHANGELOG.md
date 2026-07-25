# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.1] - 2025-07-25

### Fixed

- Race condition where auto-generated title could overwrite manual rename when `generateTitle` async call completes after user renamed the session

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
