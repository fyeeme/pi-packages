# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-09

### Added

- npm `files` now includes `CHANGELOG.md`, so published packages ship the changelog and pi 1.5.0 shows it under "Extension Updates" on the first fresh launch after an update (pi reads `CHANGELOG.md` from the package root by default; no `pi.changelogPath` needed).

### Changed

- Peak hours are now Monday-Friday 14:00:00-18:00:00 Beijing time (UTC+8): the session runs on `glm-5.3-flash` only inside that weekday window and on `glm-5.3-auto` at any other time, including all day on weekends. Previously the window applied to every day of the week.
- Dev dependencies now pin `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, and `@earendil-works/pi-tui` at 1.5.0 (was 1.3.0), so type-check and tests run against the pi 1.5.0 types.

### Fixed

- Wall-clock rule now runs the session on `glm-5.3-flash` only inside the Beijing-time window 14:00:00-18:00:00 and on `glm-5.3-auto` outside it. The previous implementation compared against a single 14:18:00 cutoff, which kept the session on flash for the whole morning and switched at the wrong moment.

## [0.1.0] - 2026-10-29

### Added

- First release, merging and superseding `@fyeeme/pi-virtual-models` and `@fyeeme/pi-timezone-model`. Two cooperating strategies in one extension: the virtual model `zai-coding-cn/glm-5.3-auto` routes by image presence (image-bearing user messages to `glm-5.3-flash`, text to `glm-5.3`; retries and continuations stay on the turn's model, with a fresh image tool result switching to flash; requests outside the agent loop go to flash when the conversation contains images; stale-ctx tolerant through a resolved-model cache), and a wall-clock rule runs the session on `glm-5.3-flash` before 14:18:00 Beijing time and on the virtual `glm-5.3-auto` from 14:18:00 on, enforced on `session_start` and before every agent run, idempotent while the current model matches. Layout follows the package convention: `index.ts` entry at the root, strategies under `src/` (`src/virtual-model.ts`, `src/timezone.ts`), tests under `test/`.
