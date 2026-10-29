# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-29

### Added

- First release, merging and superseding `@fyeeme/pi-virtual-models` and `@fyeeme/pi-timezone-model`. Two cooperating strategies in one extension: the virtual model `zai-coding-cn/glm-5.3-auto` routes by image presence (image-bearing user messages to `glm-5.3-flash`, text to `glm-5.3`; retries and continuations stay on the turn's model, with a fresh image tool result switching to flash; requests outside the agent loop go to flash when the conversation contains images; stale-ctx tolerant through a resolved-model cache), and a wall-clock rule runs the session on `glm-5.3-flash` before 14:18:00 Beijing time and on the virtual `glm-5.3-auto` from 14:18:00 on, enforced on `session_start` and before every agent run, idempotent while the current model matches. Layout follows the package convention: `index.ts` entry at the root, strategies under `src/` (`src/virtual-model.ts`, `src/timezone.ts`), tests under `test/`.
