# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-08-10

### Added

- **workflow 子 agent 系统提示（B1+B2）**：每次 agent 派发注入基础系统提示（verbatim 返回纪律——禁止 "Done." 寒暄、纯 JSON 不加 fence），step 的 `systemPrompt` 覆盖追加在其后；judge/rank 任务 prompt 瘦身为只含 schema（此前重复的 "ONLY JSON" 措辞移除）。
- **phase 分组渲染（C1）**：`workflow.phases`（`PhaseSchema`）接线进 `buildProgressWidget` 与 `/wf-inspect`——步骤按阶段标题嵌套，未分组步骤按声明顺序落入隐式默认组；未声明 phases 时保持平铺渲染。
- **每次调用 model 展示（A8/C4）**：进度组件显示服务该调用的模型（来自 `AgentSpawnResult.model`）。
- **`log` 步骤原语（C2）**：零派发零 token 的叙事步骤，触发 `onLog` 监听器，在进度组件中渲染为独立叙事行。
- **按步骤预算降级（A3）**：`onBudgetExhaust: "null"` 让预算耗尽的步骤返回 `null` 而非中止运行（`degradedSteps` 记录）；默认 `"throw"` 保持 fail-fast。降级在 `guardSpawn` 原子保留点实现，并发 fan-out 无 TOCTOU。
- **错误分类法（A5）**：`WorkflowError` + `category` 判别（budget-exceeded / determinism / size-limit / control-chars / compile / policy-gate / killed / dispatch-error / unexpected-state）；`BudgetExceededError`/`DeterminismError` 改为继承它并携带类别；重试默认仅针对 `dispatch-error`/`unexpected-state`。`RunResult.errorCategory` 把终止类别的分类透传到运行结果边界（policy-gate / size-limit / budget-exceeded 等）。
- **输入尺寸与策略守卫（A6）**：`maxPromptBytes`（默认 256 KB）在派发前拒绝超大 prompt（`size-limit`）；拒绝非打印控制字符（`control-chars`）；可选 `policyGate` 在首个 agent 派发前门控（`policy-gate`）。
- **流式文本预览（C3）**：`pi-subagent-core` 的 `spawnAgent` 新增可选 `onUpdate` 回调转发 `message_update` delta；经 `dispatchAgentCall` 桥接到 `onUpdate` 监听器；进度组件展示最近启动调用（最晚 3 行）的流式尾部。
- **run_workflow 子进程递归 opt-in（review）**：`RunWorkflowOptions.allowChildRecursion`（默认 false）——工作流 agent 子进程默认不再注册 subagent/fan-out 工具（抽取共享核心后行为回退，此前静默丢失）；显式 opt-in 恢复，受 `PI_SUBAGENT_MAX_SPAWN_DEPTH` 上限约束。

### Changed

- `@fyeeme/pi-subagent-core` 依赖从 `file:../pi-subagent-core` 改为 `^0.3.0`（npm registry）：0.3.0 包含 C3 所需的 `onUpdate` 回调与 `mapWithConcurrencyLimit` 的 allSettled 收拢语义；修复发布阻断——`file:` 指向包根之外的相对路径，npm 发布后消费方无法解析。
- 缓存键前缀 `wf:` → `wf2:`：B1+B2 让每个缓存键参与系统提示，前缀升级使旧 journal 干净失效（一次性的重派发成本）。
- 进度组件 `buildProgressWidget` 按 `renderGroups` 分组渲染（阶段/默认组，与 `/wf-inspect` 共享 `src/ui-groups.ts` 纯函数），无 phases 时行为不变。
- 预算的 `maxDurationMs` 维度改用活时钟（引擎守卫点用 `Date.now()`；引擎代码不受 AST 守卫约束，确定性仅约束 workflow 本体）：墙钟超时真正触发 `budget-exceeded`，不再是 advisory。
- `AgentLifecycleListeners` 新增 `onLog`/`onUpdate`；`onAgentEnd` 新增 `model` 参数（向后兼容，均为可选）。
- **模板解析严格性（review F3，行为变更）**：`fill()` 对 prompt 中任何未知/越界 `{{...}}`（如 agent prompt 里的 `{{item}}`、fan_out item prompt 里的 `{{step.X}}`、字面量花括号模板）从 0.1.0 的原样透传改为抛 `compile` 类别错误并中止运行；README 已声明该破坏，含字面量花括号的既有 prompt 需要调整。
- dispatch 底层抽取到共享包 `@fyeeme/pi-subagent-core`：`src/agent/dispatch.ts` 的 `spawnAgent`/`mapWithConcurrencyLimit`/`createSpawnRegistry`/`abortAgent`/共享类型改从核心导入并 re-export；workflows 专属的 `skipAgent`/`retryAgent`/`AbortReason`/lifecycle 通知层保留在本包。行为不变（cache-resume、per-agent abort、预算/上限均不受影响）。
- 新增公开 barrel `sessions/spawn.ts`（README §7 文档化的 `createSpawnRegistry`/`abortAgent`/`skipAgent`/`retryAgent` 导出路径，此前未实现）；`files` 加入 `sessions/**/*.ts`。
- 新增 `@fyeeme/pi-subagent-core` 依赖（`^0.1.0`，从 npm registry 解析）。

### Fixed

- **缓存键前缀 wf3→wf4（review 缓存版本失效）**：`CACHE_KEY_PREFIX` 常量 + bump 纪律注释；manifest keys 上限（`MAX_MANIFEST_KEYS=2000`，不再随历史 run 单调膨胀）+ `writeManifest` 崩溃 tmp 残留清理（sweep 置于写入前，避免误删自身）。
- **ast-guard 绕过修复（review）**：模板字符串下标 Date[now]（NoSubstitutionTemplateLiteral）与括号包裹 `(Date).now()`（ParenthesizedExpression）不再绕过；局部遮蔽限制写入注释。
- **widget disposed 标志（review）**：`cleanup()` 后 abort 窗口内迟到的流式事件/状态写入不再通过 `setWidget` 重建已销毁的进度面板。
- **resume.cachedTotal 统计口径（review）**：改以 `exec.dispatched` 为分母——覆盖 null 退化与 dispatch 抛错路径（此前 `cacheHits + dispatchStarts` 少计退化、多计未启动的 dispatch）。
- **原语计数统一（review）**：package.json/README/types.ts 注释从 7/9 混用统一为 10（StageType 实际值）；README 步骤表补 `sub_workflow`/`loop_until_dry` 两行。
- **A5 错误分类法接线（review M1+M2）**：`runWithRetry` 改为按 `RETRYABLE_CATEGORIES` 门控重试——只有携带 `dispatch-error` 类别的失败自动重试（dispatch reject 与子进程结算失败都构造该类别），code transform 抛错与终端类别不再被盲目重跑；`RunResult.errorCategory` 在 dispatch 失败、`classify_route`/`sub_workflow` 嵌套失败时不再为 undefined（经 `StepResult.errorCategory` 逐层透传）。`buildProgressWidget` 导出（与 `fill` 同等的可测性模式）。
- **inspect 滚动（review M3 遗留 + L2）**：左栏窗口改用选中步骤在 `leftLines` 中的实际行号（phase 标题行不再使选中步骤滚出视口）；`End` 后的 `Infinity` 哨兵按上次已知内容高度先钳制再计算，`End→PgUp` 不再被吞；phase 组标题去重移除——被未分组项打断的 phase 第二组也渲染标题，不再有孤立缩进行（widget 与 `/wf-inspect` 同步）。
- **widget 终态不被覆盖**：`onAgentEnd` 不再把 `skipped`/`retried`/`cached` 状态覆写为 `failed`（abort 后子进程 settle 仍会触发 `notifyEnd(false)`）。
- **CONTROL_CHARS 守卫扩展（review）**：正则从 C0+DEL 扩为覆盖 C1（U+0080–U+009F）、零宽与 bidi 格式字符（U+200B–U+200F / U+202A–U+202E / U+2060–U+206F / U+FEFF）——此前错误信息声称拦「non-printable control characters」但 bidi/零宽/BOM 全部放行。
- 修正报告 §7 发现的符号归因错误：`src/cache/key.ts` 与 `src/budget/caps.ts` 注释中引用的 CC 内部符号名（`Hid`/`tA_`/`ews`/`DSo`）实为 ANSI 颜色/HTML 实体/Zod/git 配置等无关符号——改为机制描述，不再钉死具体 minified 名。
- **maxDurationMs 时钟错配（review F1）**：`BudgetPool` 的 originMs 改从调用方确定性 `now` 切到 `Date.now()`（父运行与 `inheritBudget: false` 的子池都改）——此前守卫点用活时钟而 originMs 用确定性钟，传 `now: 1` 等确定性值 + `maxDurationMs` 会让预算在首个守卫点即读作耗尽。
- **A6 守卫移到缓存命中之后并覆盖 systemPrompt（review F6/F7）**：尺寸/控制字符检查不再挡 resume 重放（调低 `maxPromptBytes` 不再杀死已缓存调用的回放）；检查同时覆盖任务 prompt 与 effective systemPrompt（含基础纪律 prompt），二进制/超大内容无法通过塞进 systemPrompt 绕过守卫。
- **扩展入口暴露 `log` 步骤与 `onBudgetExhaust`（review F4）**：`run_workflow` 工具的 TypeBox StepSchema/StepData/buildWorkflow 补齐两者——此前新特性仅在代码级 `defineWorkflow` 可用，工具调用被 schema 拒绝。
- **复合步骤 null 降级返回 null（review F10）**：`adversarial`/`classify_route` 在 `onBudgetExhaust: "null"` 下降级的 produce/classifier 现在让步骤返回 `null` 结果（不再派发 judges/路由、不再伪造空 candidate/空 category 的 done 结果），与 README A3 契约一致。
- **adversarial 校验 judges ≥ 1（review F11）**：`judges: 0` 不再产生空真 `passed: true`（与 tournament 的显式校验对齐）。
- **sub_workflow 的函数型 input 现被 await（review F12）**：类型同步放宽为允许 Promise（与 CodeStep/LogStep 的异步约定一致）——此前异步 input 会把原始 Promise 泄漏进子 ctx.input（`[object Promise]`），rejection 静默丢失。
- **manifest.keys 死重移除（review F15）**：`RunManifest.keys` 写入/解析从未被读取（缓存命中统计早已改为运行期观测），删除字段与收集遍历，`writeManifest` 只写 `runId`/`at`。
- **共享 UI/解析助手（review F14）**：`stepIdOf`/`fmtTokens`/ANSI 颜色助手抽到新模块 `src/format.ts`，`index.ts`/`src/inspect.ts`/`src/runner/stage-executor.ts` 三处逐字重复的本地拷贝删除。
- **fan_out/复合步骤失败快速终止在飞兄弟（review F5）**：`dispatchAgentCall` 在任一失败点（settle 失败、dispatch 抛错、A6 size/control 拒绝）经 `abortStepCalls` SIGTERM 同步骤在飞调用——allSettled 等待不再因一个挂死子进程而永久阻塞，失败能及时传播（降级/abort 不触发，不误杀兄弟）。统一收口在 `dispatchAgentCall` 内部，不依赖共享库新 API（消费方依赖 npm `@fyeeme/pi-subagent-core@^0.3.2`）。
