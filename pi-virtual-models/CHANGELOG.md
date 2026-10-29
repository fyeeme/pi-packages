# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-29

### Added

- First release: a virtual model `zai-coding-cn/glm-5.3-auto` that routes by image presence — a user message carrying images (image blocks or image file paths in the text) goes to `glm-5.3-flash` (native image reading), any other user message goes to `glm-5.3` (text only). Tool follow-ups and retries stay on the model that handled the turn, keeping prompt caches and thinking signatures valid; the one exception is a fresh image tool result, which switches the next request to flash. Requests outside the agent loop (e.g. compaction) go to flash when the conversation contains images. The extension never depends on a live extension ctx (ThinkRail stale-ctx tolerance): physical models are cached on first lookup, a stale ctx falls back to the cache, and a cold start returns an identity-only stub the dispatcher re-resolves itself.
