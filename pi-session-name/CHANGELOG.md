# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.6] - 2026-10-02

### Changed

- Dev toolchain pinned to `@earendil-works/pi-coding-agent`/`pi-ai` 1.0.0 (peer floors unchanged, `>=0.99.0`); typecheck and tests pass against 1.0.0 unchanged.

## [1.0.5] - 2026-10-01

### Removed

- **BREAKING**: the sibling-session title dedup is gone — the extension no longer scans local session files for other sessions' names, and prompts no longer embed a `<recent_session_titles>` block. Removed the exported `parseSessionTitle()` and `collectRecentSessionTitles()` helpers, the `recentTitles` option from all prompt builders, and `classifyKeep()`'s `recentTitles` parameter (classifier state drops `recentSessionTitles`). Prompts keep their general distinctiveness rules, so titles still lead with the concrete entity/error/identifier.
- **BREAKING**: the custom title-model override is gone — titles are always generated with the current session model (`ctx.model`). Removed the `model` field from `session-name.json`, the `PI_SESSION_NAME_MODEL_PROVIDER` / `PI_SESSION_NAME_MODEL_ID` environment variables, and the exported `resolveModel()` helper (its getAvailableOfType fallback chain went with it). Auto mode's classifier-based KEEP/NEW verdict is unaffected.

### Added

- Creation-time prefix: every set title becomes `yyyy-mm-dd hh:mm - title` (local timezone, parsed from the session file name). The resume picker sorts by last-modified, so editing an old session made its age invisible and it could get lost; the prefix keeps the original creation time visible. Opt out with `PI_SESSION_NAME_TIMESTAMP=false` or `"appendCreationTime": false` in `.pi/agent/session-name.json`.
- Prompt-style switch: `prompt: "concise" | "editorial"` (env `PI_SESSION_NAME_PROMPT`). `concise` (default) is the deepseek-harness system prompt verbatim with a 512-token budget; `editorial` adds pi's distinctiveness/concrete-detail rules with a 1024-token budget — measured A/B on 50 local sessions: concise 96% yield / p50 5.1 s, editorial denser titles / ~30% slower.
- New `mode: "follow"` (env `PI_SESSION_NAME_MODE=follow`): every settled turn regenerates the title unconditionally — the deepseek-harness `all-prompts` cadence — so the title tracks the conversation as its real subject emerges instead of freezing on an early-turn snapshot. Unlike `first`/`auto`, `follow` also keeps tracking a resumed session's inherited title (treated as the last revision, not a pin); `/rename` still pins either way.
- Title-hardening practices adapted from deepseek-harness's `session-title` package: (1) terminal- and spoof-safe title sanitization — ANSI/OSC/CSI/ESC escapes, C0/C1 control characters, and zero-width/bidi directional controls are stripped before acceptance, and truncation is code-point-safe (never splits a surrogate pair); (2) the conversation is JSON-framed in the prompt (`JSON.stringify` of the selected messages), so untrusted user text cannot forge structural delimiters like a fake `</conversation>` or `Assistant:` turn; (3) title generation caps the auxiliary call at `maxTokens: 512`, bounding runaway output; (4) prompt length targets are language-aware (CJK characters vs. non-CJK words).
- Auto mode's KEEP/NEW verdict now runs on a classifier model when the host has one (pi 0.99 `ModelRuntime.classify()`, bool question): a KEEP verdict skips the generation call entirely, and a NEW verdict generates the replacement through a rules-only prompt. Without a classifier — or when the classifier call fails — the original single-verdict `complete()` path runs unchanged.

### Changed

- **BREAKING**: the config file moved from `.pi/session-name.json` to `.pi/agent/session-name.json`.
- **BREAKING**: the title pipeline is now aligned 1:1 with deepseek-harness's `session-title` architecture wherever the pi extension host allows: (1) requests carry only **human messages** (assistant/system no longer enter a title prompt) in a **system/user split** — the system instruction is deepseek-harness's exact wording (plain text, no Markdown/XML/code/terminal codes, ~6 words / ~18 CJK chars) and the user payload is the JSON-framed message array; (2) `maxLength` is now a **UTF-8 byte budget** (200 bytes ≈ 200 ASCII chars or ~66 CJK chars, `truncateTitleUtf8` semantics) instead of a character count; (3) generation has a 20 s deadline composed with Esc/abort, and any failure (error, abort, timeout, non-`stop` finish, empty output) falls back to a **deterministic first-message title** (`fallbackSessionTitle`, zero LLM) instead of leaving the session untitled; (4) input carries a 16 KiB UTF-8 budget that narrows from the oldest non-first message.
- **BREAKING**: the default `mode` is now `"follow"` — every settled turn regenerates the title so it tracks the conversation's real subject instead of freezing on an early-turn snapshot (and across resumes: an inherited title is treated as the last revision). Set `mode: "first"` (or `PI_SESSION_NAME_MODE=first`) to keep the old one-shot behavior; `"auto"` remains available.
- ~~Model resolution accepts a provider-only `model` config~~ (superseded: the custom-model override was removed — see Removed above; title generation now reads `ctx.model` directly.)
- Peer dependency floor raised to `@earendil-works/pi-coding-agent >= 0.99.0`; dev toolchain pinned to 0.99.2.

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
