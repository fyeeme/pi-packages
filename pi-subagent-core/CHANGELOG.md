# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `text.ts` — `Message.content` 防御性文本提取的单一实现：`contentTextBlocks`/`contentText`（string | content-block 数组 → 文本块）与 `lastAssistantText`（最后一条非空 assistant 文本，排除中间轮次口水话）。供消费方（pi-review 的 `subagent` 工具与 `/code-simplify` handler、会话查看器）共用，取代各自的手写拷贝。
- **并发 agent 数量可配置（默认 5，选项 3/5/8/10）**：配置文件 `maxConcurrency` 键（全局 `<agentDir>/pi-subagent.json` + 项目 `<cwd>/.pi/pi-subagent.json` 两层，项目覆盖全局；取值仅接受 3/5/8/10，非法值丢弃回退 5）；核心导出 `getEffectiveMaxConcurrency()`（调用时读取，改文件下一次 fan-out 即生效）与 `MAX_CONCURRENCY_OPTIONS`；`mapWithConcurrencyLimit` 省略 `concurrency` 时由写死 `DEFAULT_MAX_CONCURRENCY` 改为读取该有效默认（显式传 `concurrency` 的调用不变）。
- **子代理 UI 层**（移植自 tintinweb/pi-subagents，适配本包的子进程 dispatch 模型）：
  - `monitor.ts` — 模块级 `AgentMonitor` 单例：`spawnAgent` 在每个生命周期缝隙（call 开始/结束、assistant 消息、工具执行开始/结束、compaction、流式文本）通知它。纯观测：dispatch 路径从不回读 monitor 状态，且每处通知都包在 try/catch 里 —— UI 侧故障不可能影响 spawn。状态有界：已结束的 call 保留 60s（上限 20 条）供查看器晚读，之后懒清除。
  - 编辑器上方常驻 widget（`ui/agent-widget.ts`）：spinner + `↻5≤30` 回合计数 · 工具使用数 · `33.8k token (62% · ⇊2)`（上下文占比按 <70% dim / 70–85% warning / ≥85% error 着色；无声明 contextWindow 的模型省略；compaction 次数 >0 时以 `⇊N` 附注）· 耗时 · `⎿ editing 2 files…` 活动行。完成后短暂驻留（✓/✗，5s/10s）后退出；超限折叠为 `+N more (…)`。默认 `widget: "background"`（仅后台运行；前台 agent 已内联渲染为工具结果，避免双重渲染）。
  - FleetView（`ui/fleet-list.ts`）：子代理运行时在编辑器下方渲染 Claude Code 风格可导航列表（`esc to interrupt · ← for agents · ↓ to manage`）；空提示符下按 ↓/← 激活，↑/↓ 选择，Enter 打开会话查看器覆盖层，Esc 返回。按键经 `onTerminalInput` 拦截（仅空编辑器时激活，对话框持有键盘时不抢键）。
  - 会话查看器（`ui/conversation-viewer.ts`）：实时滚动转录（user/assistant 文本与 thinking/工具调用/截断的工具结果），`x x` 双击经 per-call AbortController 停止 agent；子进程无 stdin，无 steering。
  - `/agents` 命令：列出会话 agent（Enter 打开查看器）。无交互式设置界面 —— 三个配置键仅通过配置文件 `pi-subagent.json` 设置：`widget`（all/background/off，默认 background，启动时读取）、`fleetView`（布尔，默认 true，启动时读取 —— 关闭后列表不注册、输入钩子不拦截按键，widget 与 `/agents` 不受影响）、`maxConcurrency`（3/5/8/10，默认 5，调用时读取）。
  - 会话生命周期：`session_shutdown`（quit、`/new`、`/resume`、`/fork`、reload）时立即拆除两个 UI 面 —— 注销 widget、停止 spinner/刷新定时器、释放 FleetView 输入钩子、关闭打开中的查看器；下一次 `session_start` 重新注册；`/new` 额外清空 monitor 陈旧条目，旧会话已结束的 agent 不在新会话复活。
  - 双语文档：完整的中（`README.zh-CN.md`）/ 英（`README.md`）README。
  - 设置模块更名（0.5.0 未发布直接修订，无兼容层）：`loadUiSettings`/`SubagentUiSettings` → `loadCoreSettings`/`SubagentCoreSettings`；配置文件 `pi-subagent-core.json` → `pi-subagent.json`；配置键 `widgetMode` → `widget`、`maxConcurrentAgents` → `maxConcurrency`。
  - **agent 描述与转录显示收敛**：模型常把仓库上下文样板行（`Repo cwd: <path> (description). Repo信息`）写进子代理 prompt —— 该行不再成为 widget/FleetView/`/agents` 行的 agent 描述（`isBoilerplateLine` 前缀过滤，全样板时回退原首行，数据层 task 不变）；查看器 `[User]` 区同样过滤该行（纯样板消息整条跳过）；`[Assistant]` 文本输出限制为 2000 字符预览（超长截断并标注）、thinking 限制 1000 字符。
  - `tool_execution_start` UI 兜底重接（吸收自 tintinweb/pi-subagents，见其 index.ts:1134「Grab UI context from first tool execution」）：每次工具执行时对 widget/fleet 做 `setUICtx`（`ctx.ui` 是 runner 的共享 uiContext，同 binding 内恒同对象 → 幂等早退，无逐调用抖动）+ `update()`。恢复两类真实场景：① pi 的 `resetExtensionUI()`（before-session-invalidate、/reload）无通知地 `clearExtensionWidgets()`，或主题切换触发组件 `invalidate()` 后注册标志失效——下一次工具执行即重注册；② rebind 后 `ctx.ui` 身份变化（无 session_start 兜底）——setUICtx 识别新对象并针对新上下文重注册。时序收益：触发 spawn 的那个工具调用（如 `subagent`）本身就产生该事件，注册必然先于第一批 callStarted 通知。
  - 单元测试补充：`settings.test.ts`（文件名/两层合并/键解析/非法值清洗/无旧名兼容/坏文件降级）、`extension.test.ts`（UI 生命周期：注册方位、shutdown 即时注销、`/new` 清空且不复活、`widget: off`、`fleetView: false` 不注册不抢键且 `/agents` 查看器仍可用、resume 后重注册、`tool_execution_start` 兜底重接四例：invalidate 后恢复、rebind 新 ctx 重注册、稳态同 ctx 不抖动、session_start 未绑 UI 时由首次工具执行唤醒）。
  - 包现为可选 pi 扩展：`package.json` 新增 `pi` manifest（`./sub-agent.ts`）与 `pi-package` keyword；peer 依赖新增 `@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui`。


### Changed

- `describeTask`（agent 行描述）改为 `indexOf` 增量扫描首个非样板非空行：task 内嵌完整 diff（上限 ~400KB），原 `split+map+filter` 每次 spawn 都物化整套行数组。
- 设置读取按文件 (mtimeMs, size) 缓存：`maxConcurrency` 每次调用时读取的语义不变（改文件下一次 fan-out 即生效），但未变更的文件只付一次 stat 而非 read+JSON.parse。
- agent widget / FleetView 每个 tick 只取一次 monitor 快照（原 80ms tick 扫 2 遍、200ms tick 扫 3 遍：update/clamp/render 各自 `monitor.list()` → sweep + 数组拷贝）。
- 会话查看器：导航键滚动钳制复用 render 时缓存的行数（原每次按键重建整套 wrap 转录）；agent 结束后自停 1s 刷新 tick（耗时冻结于 completedAt，subscribe 监听器覆盖迟来的变化）。
- `AgentSpawnOptions` 新增两个纯 UI 元数据字段（不影响子进程与返回结果）：`displayName`（widget/FleetView 行显示名，默认 `"Agent"`）、`background`（声明前后台：`false` = 前台 —— 默认 widget 模式下隐藏；省略 = 未声明 —— 全模式可见，即当前所有消费者调用的形态）。

## [0.4.0] - 2026-08-16

### Added

- **Max concurrency 选项（写死默认 5）**：导出常量 `DEFAULT_MAX_CONCURRENCY`（= 5，源码写死，无 env、无配置文件）；`mapWithConcurrencyLimit` 新增可省略 `concurrency` 的重载 `mapWithConcurrencyLimit(items, fn)` —— 省略时上限即该常量。需要不同上限的调用方显式传 `concurrency`（显式传入的既有调用行为不变，零破坏）。

## [0.3.3] - 2026-08-11

### Added

- `AgentSpawnOptions.thinking`：透传 `--thinking` 层级（off|minimal|low|medium|high|xhigh|max）给子进程；省略时子进程跑模型默认层级。fan-out 子代理的思考深度首次可控制（此前独立子进程不继承主会话 thinking）。

## [0.3.2] - 2026-08-09

### Fixed

- `maxSpawnDepth` 选项改走 `parsePositiveInt` 校验：0/负值/非数字不再透传（此前 `maxSpawnDepth: 0` 会以字符串 `"0"` 进子进程 env，被解读为「无上限」——方向性危险），非法值回退继承 `PI_SUBAGENT_MAX_SPAWN_DEPTH`。
- 注释/文档修正（review L 系列）：`mapWithConcurrencyLimit`「first rejection wins」实为「最低索引 worker 的 rejection 胜出」；`AgentSpawnResult.maxTurnsReached` 与 `aborted` 并非互斥（maxTurns 路径两者同为 true）。

## [0.3.1] - 2026-08-09

### Fixed

- `onUpdate` 回调错误隔离（review L3）：回调抛错不再影响事件解析——stdout `data` 路径不崩宿主进程，`close` 路径的尾行处理不跳过 `resolve`（此前可能让 `spawnAgent` promise 永不 settle 并泄漏 registry 条目）。

## [0.3.0] - 2026-08-09

### Added

- 流式文本转发（harden-dynamic-workflows，C3）：`AgentSpawnOptions` 新增可选 `onUpdate` 回调；`spawnAgent` 解析 stdout 时转发 `message_update` 事件的增量文本块（delta chunk），未提供回调时保持原有丢弃行为。最终 `message_end`/`tool_result_end` 收集不变。

### Changed

- `mapWithConcurrencyLimit` 在任一 worker 失败后改为等待全部 in-flight worker settle 再抛错（`Promise.allSettled` + 首个 rejection）：失败不再遗留已派发的子进程在后台继续运行。语义由「立即抛错、可能孤儿子进程」改为「先收拢再抛」。

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
