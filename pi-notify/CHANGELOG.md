# Changelog

## [Unreleased]

## [1.0.0] - 2026-11-09

### Added

- Initial packaging of [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) `extensions/notify.ts` (Apache-2.0) as `@fyeeme/pi-notify`: an `agent_settled` handler that sends a native OSC 777 desktop notification (`ESC ] 777 ; notify ; title ; body BEL`) when the agent has fully settled and is waiting for input. The last assistant text — tracked via `message_end`, since `AgentSettledEvent` carries no message list — is rendered through a plain markdown theme, stripped of terminal sequences and control characters, whitespace-collapsed onto one line, and truncated to 200 characters (`…`); an empty result falls back to the title `Ready for input`, otherwise the title is `π`.

### Fixed

- Removed a redundant `?? []` fallback on `agent_end`'s `messages` — the pi event contract types the field as required.
- **Notifications now fire on `agent_settled` instead of `agent_end`** (deliberate divergence from upstream). After `agent_end`, pi may still run an automatic retry, compaction, or queued continuation, so the "waiting for input" notification could fire while the agent was still working. Only `agent_settled` guarantees no automatic continuation; the notification body now uses the last assistant text tracked via `message_end` (sent also on abort, where the user may be away from the terminal).

### Changed

- Dev dependencies now pin `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, and `@earendil-works/pi-tui` at 1.5.0 (was 1.3.0), so type-check and tests run against the pi 1.5.0 types.

