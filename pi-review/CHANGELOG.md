# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `/code-simplify` 安全网（harden-code-simplify）：Phase 2 现在是 apply→verify→revert 闭环——快照受改文件、应用修复、跑 handler 从 `package.json` 探测到的验证命令（`check`/`test`/`lint`/`typecheck`，注入到 trigger 消息，可观测）；验证失败按文件粒度自动回滚（Decision B4：常态只跑 1 次验证，失败才升级到逐文件隔离），绝不留验证失败的树。复用既有 `review_report`（新增 `level: "simplify"`）上报结构化 apply-outcome（`fully/mostly/partially/not_achieved`）替代自由文本 summary。
- `subagent` 工具并发上限可配：`PI_MAX_CONCURRENT_SUBAGENTS` env（默认 8，与 CC `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` 对等）；非法值回退默认。
- `subagent` 工具默认 turn 预算：调用方省略 `maxTurns` 时应用默认 25（防止 fan-out agent 无界消耗）；显式 `0` 仍被忠实兑现。
- `review_report` 工具：CC `ReportFindings` 的 Pi 对等物（verdict/`outcome` 枚举对齐 CC v2.1.226 二进制实证）。code-review skill 验证去重后调用它上报结构化 findings——渲染中文 Markdown 报告（表 + 详情）回对话，并落盘机器可读 JSON 到 `<cwd>/.pi/review/` 供 CI / `--fix` / `--comment` 消费。补上 pi-review 最大短板（无结构化输出），打开 CI 集成通路。

### Changed

- `@fyeeme/pi-subagent-core` 依赖从 `file:../pi-subagent-core` 改为 `^0.3.0`（npm registry）：修复发布阻断——`file:` 指向包根之外的相对路径，npm 发布后消费方安装解析失败（ENOENT/MODULE_NOT_FOUND）；0.3.0 提供 `isFanoutToolAllowed` 等所需导出。
- `subagent` 工具默认禁止递归（harden-code-simplify，Decision A3）：子进程默认不再注册 `subagent` 工具，除非调用方在子进程的 `tools` 白名单里显式列入（对应 `allowChildRecursion`）——递归在物理上不可能。**行为变更**（更安全，非破坏：已发布的两个命令都不需要嵌套 fan-out）。需要多级 fan-out 时设 `PI_SUBAGENT_MAX_SPAWN_DEPTH` 解锁并设上限。
- `review_report` 的 `level` 枚举新增 `simplify`（simplify 复用该工具上报 apply-outcome，不携带 verdict）。
- code-review skill 的 `max` 档语义注明：与 `xhigh` 的 fan-out/verify/sweep 结构完全相同，差别仅在模型 reasoning effort（CC v2.1.226 注释实证 `max → same structure as xhigh (the API reasoning effort differs, not the fan-out)`）；运行时不支持调节 reasoning effort 时 max 在结构上退化为 xhigh。
- `review_report` 工具声明 `renderResult`，对话内报告改走 pi 的 `Markdown` 渲染器（带边框、宽度自适应的汇总表），不再被工具结果的纯文本回退当作裸 `|`/`|---|` 硬换行。结构化 JSON 落盘（`<cwd>/.pi/review/`）不变；仅影响交互 TUI 渲染，`pi -p` 不变。新增 `@earendil-works/pi-tui` peer 依赖。

### Fixed

- `subagent` 工具 `parallelism` 整数防御（review）：小数/非正值经 `Math.floor(Math.max(1, …))` 收敛——此前 `parallelism: 3.5` 直达 `mapWithConcurrencyLimit` 抛 `RangeError: Invalid array length`；schema 描述注明 integer ≥ 1。`maxTurns` 描述修正（不再声称「Omit for unlimited」——默认预算 25，显式 `0` 为首条消息后 abort）。
- `review_report` 表头 `target` 反引号转义（target 含反引号会提前闭合 inline code 撑破表头）；verdict 注释弱化「mirror CC verbatim / binary-verified」为「follow the CC shape」，并注明 REFUTED 在 skill 流程中被 drop、罕见上报。
- `/code-simplify` 快照/回滚补齐（review M4 残留）：Step 1 快照改为 `mkdir -p /tmp/pi-simplify-baseline/$(dirname <file>)` 再 `cp`——子目录文件（如 `src/a.ts`）不再因目标父目录缺失而 ENOENT；Step 3a 回滚新增「删除修复新建的文件」步骤（新建文件无基线条目，此前会残留）。

## [1.0.1] - 2026-08-08

### Changed

- 抽取共享 dispatch 核心到新包 `@fyeeme/pi-subagent-core`：删除本地 `src/agent/dispatch.ts`（`spawnAgent`/`mapWithConcurrencyLimit`/`createSpawnRegistry`/`abortAgent`/`getPiInvocation` + 类型），`subagent` 工具改从共享包导入。行为不变（`abortSubagent` 语义、maxTurns/转录均保持），dispatch 成为单一真相源（与 `pi-dynamic-workflows` 共用）。新增 `@fyeeme/pi-subagent-core` 依赖（`^0.1.0`，从 npm registry 解析）。

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
