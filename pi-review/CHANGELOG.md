# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-08-07

### Added

- `/code-review` 命令：effort 级别审查（low/medium/high/xhigh/max），支持 `--fix`/`--comment`/`--share` 与 target；sticky last-used effort（持久化到 `~/.pi/.pi-review-state.json`），无显式级别时复用上次。
- `/code-simplify` 命令：reuse/simplification/efficiency/altitude 清理；handler 按 `ctx.getContextUsage()` 决定 parallel 4-agent vs single-pass（确定性决策，非纯 prompt 可复现）。
- `subagent` 工具：通用并行/顺序子 agent fan-out（真实 pi 子进程）；每个 agent 完整对话转录落盘并附路径，内联预览超长时截断；chain 模式硬失败即停；maxTurns 预算停止与外部取消区分标记。
- 内置 `skills/code-review` 与 `skills/simplify`（跟随本包发布，不再依赖 `~/.pi/agent/skills/`）。
- `mapWithConcurrencyLimit` 任一 worker 失败即停止派发新任务，避免失败后孤儿子进程继续派发。

### Fixed

- chain 模式空文本步骤现在清空链上下文，不再向后续步骤传递陈旧的"上一步输出"。
- 转录渲染补全 thinking 与 toolCall 块并为 toolResult 消息标注工具名，使"全量转录"名副其实。
