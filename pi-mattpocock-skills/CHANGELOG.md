# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.1] - 2026-08-08

### Added

- `/matt-bootstrap [on|off]` 命令：切换 ask-matt bootstrap 引导并持久化到 `~/.pi/agent/mattpocock.json`（下次会话生效）；`MATTPOCOCK_ENABLE_BOOTSTRAP=1` 降级为一次性 enable 覆盖（仅当前进程）。
- 支持 `PI_CODING_AGENT_DIR`：skills 目录（`DEFAULT_SKILLS_DIR`）与 prefs 路径统一由 agent 目录派生（含 `~` 展开），不再硬编码 `~/.pi/agent`。
- `MATTPOCOCK_PREFS_FILE` 可覆盖 prefs 文件路径（自定义目录 / 测试隔离）。

### Changed

- `stripFrontmatter` 从值导入 `@earendil-works/pi-coding-agent` 改为内联实现（design D1）：值导入会把 agent-session 图拉进测试与运行时导致崩溃；内联复刻 pi 的 CRLF 归一化 + fence 切片逻辑，字节级一致。

### Fixed

- 发布期 typecheck 修复：`bootstrap.ts` 的 `AgentMessage` 导入从 `@earendil-works/pi-agent-core` 改为 `@earendil-works/pi-coding-agent` 的 `ContextEvent` 派生类型（provided import；`pi-agent-core` 不在扩展可用导入清单，且其 exports 不开放根导入，下游 typecheck 会失败）。`peerDependencies`/`devDependencies` 同步去掉 `pi-agent-core`，补 `pi-ai` 与 `vitest`。
- `session_compact` 后重注入被抑制：有损摘要保留 marker 时不再阻断完整引导重注入（compactionSummary 角色不计入“已注入”）。
- `writePrefs` 目标目录不存在时 ENOENT（自动 `mkdirSync` 父目录）。
- skill 文件缺失时命令静默丢弃 → 明确错误消息（对齐 pi `/skill:` 的 pass-through 语义）。
- `/matt-bootstrap` 未知参数静默 toggle → usage 提示；env 覆盖生效时关闭提示附注“本会话仍开启”。

## [1.0.0] - 2026-08-07

### Added

- 把 [mattpocock/skills](https://github.com/mattpocock/skills) 的 13 个用户调用技能映射为短斜杠命令（`/grill-me` 等，等价于 `/skill:grill-me`），通过注入 pi `<skill>` 块实现，内容与 `/skill:<name>` 字节一致。
- 复用 pi 内置 `stripFrontmatter`（CRLF 安全），保证不同行尾的 `SKILL.md` 都能正确剥离 frontmatter。
- 可选的 `ask-matt` 路由 bootstrap（`MATTPOCOCK_ENABLE_BOOTSTRAP=1`，默认关闭），在 `session_start`/`session_compact` 后注入路由引导。
