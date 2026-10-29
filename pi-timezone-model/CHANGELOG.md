# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-29

### Added

- First release: picks the session model by Beijing wall-clock time — `zai-coding-cn/glm-5.3-flash` before 14:18:00, `zai-coding-cn/glm-5.3-auto` from 14:18:00 on. The rule runs on `session_start` and before every agent run, so a session left open across the cutoff switches on the next message. Beijing time has no daylight saving time, so a plain UTC+8 offset is exact year-round regardless of the host timezone. Switching is idempotent while the current model already matches; switches and missing models are reported through one `ui.notify` line. Manual `/model` picks are overridden on the next prompt — both enabled models are governed by the rule, so this is intentional.
