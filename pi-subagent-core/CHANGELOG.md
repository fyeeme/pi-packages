# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-08-08

### Added

- 初始发布：从 `pi-review` 与 `pi-dynamic-workflows` 抽取的共享 agent dispatch 核心——`spawnAgent`（一个 `pi --mode json -p --no-session` 子进程，解析 `{message_end, tool_result_end}` NDJSON，AbortSignal → SIGTERM + 5s SIGKILL 升级）、`mapWithConcurrencyLimit`（任一 worker 失败即停止派发新任务）、`createSpawnRegistry`/`abortAgent`（per-call abort 表）、`getPiInvocation`，以及 `AgentSpawnRegistry`/`AgentSpawnOptions`/`AgentSpawnResult`/`AgentUsage`/`AgentCallId`/`AgentAbortMap` 类型。
- 纯 TS 库，无 `pi` manifest（非扩展）；`pi-review` 与 `pi-dynamic-workflows` 声明 `file:` 依赖。
