# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-08-09

### Added

- 递归护栏（harden-code-simplify，Decision A3）：新增 `allowChildRecursion`/`maxSpawnDepth` 选项；`spawnAgent` 向子进程传播三个 env——`PI_SUBAGENT_DEPTH`（本进程在 agent 树中的深度，0=顶层）、`PI_SUBAGENT_RECURSION_ALLOWED`（spawner 是否显式授权本子进程递归）、`PI_SUBAGENT_MAX_SPAWN_DEPTH`（可选硬上限，到顶即解除子进程的 fan-out 工具）。默认子进程拿不到 fan-out 工具，递归在物理上不可能——这是 CC `depth>=3` 守卫在 pi（子进程深度恒 0）上的忠实且更简等价物。
- 纯函数策略核心（可单测）：`parsePositiveInt`（严格正整数解析，非法返回 null）、`currentSpawnDepth`、`isFanoutToolAllowed`（顶层始终暴露；子进程仅在显式授权且未到上限时暴露 fan-out 工具）。

### Changed

- `AgentSpawnOptions` 新增 `allowChildRecursion?`/`maxSpawnDepth?`；`spawnAgent` 现在为子进程显式构造 `env`（此前继承 `process.env`），注入上述三个递归护栏变量。行为对未使用新选项的调用方保持兼容。
- 精简打包与依赖：`files` 移除不存在的 `src/**/*.ts` glob；移除未使用的 `@earendil-works/pi-coding-agent` peer/dev 依赖（core 仅依赖 `@earendil-works/pi-ai`）。

### Fixed

- `writePromptToTempFile` 在 `writeFile` 失败时改用 `rm(tmpDir, { recursive, force })` 清理临时目录：原先 `rmdir` 在 `writeFile` 已部分写入文件（ENOSPC/EIO 中途）时抛 `ENOTEMPTY` 被吞掉，会遗留含 prompt 的孤儿目录；现在连部分文件一并清除。

## [0.1.0] - 2026-08-08

### Added

- 初始发布：从 `pi-review` 与 `pi-dynamic-workflows` 抽取的共享 agent dispatch 核心——`spawnAgent`（一个 `pi --mode json -p --no-session` 子进程，解析 `{message_end, tool_result_end}` NDJSON，AbortSignal → SIGTERM + 5s SIGKILL 升级）、`mapWithConcurrencyLimit`（任一 worker 失败即停止派发新任务）、`createSpawnRegistry`/`abortAgent`（per-call abort 表）、`getPiInvocation`，以及 `AgentSpawnRegistry`/`AgentSpawnOptions`/`AgentSpawnResult`/`AgentUsage`/`AgentCallId`/`AgentAbortMap` 类型。
- 纯 TS 库，无 `pi` manifest（非扩展）；`pi-review` 与 `pi-dynamic-workflows` 声明 `file:` 依赖。
