# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-08-07

### Added

- 把 [mattpocock/skills](https://github.com/mattpocock/skills) 的 13 个用户调用技能映射为短斜杠命令（`/grill-me` 等，等价于 `/skill:grill-me`），通过注入 pi `<skill>` 块实现，内容与 `/skill:<name>` 字节一致。
- 复用 pi 内置 `stripFrontmatter`（CRLF 安全），保证不同行尾的 `SKILL.md` 都能正确剥离 frontmatter。
- 可选的 `ask-matt` 路由 bootstrap（`MATTPOCOCK_ENABLE_BOOTSTRAP=1`，默认关闭），在 `session_start`/`session_compact` 后注入路由引导。
