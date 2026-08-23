# @fyeeme/pi-subagent-core

**共享的 pi 子进程 agent dispatch 核心，附带可选的 pi 扩展 —— 在 TUI 中实时渲染 agent 状态。**

Languages: [English](README.md) | **中文**

被 [`pi-review`](../pi-review) 与 [`pi-dynamic-workflows`](../pi-dynamic-workflows) 用作 spawn 原语（`spawnAgent`）的唯一事实来源；任何想要 Claude Code 风格 agent 监控 UI 的扩展也可以直接使用。

---

## 提供什么

### Dispatch 核心（纯库）

- `spawnAgent(registry, options)` —— 启动一个 `pi --mode json -p --no-session` 子进程，解析 `{message_end, tool_result_end, tool_execution_start/end, compaction_start, message_update}` NDJSON 事件；AbortSignal → SIGTERM，5s 后升级 SIGKILL。
- `mapWithConcurrencyLimit(items, concurrency, fn)` —— 有界并行 map，保持输入顺序；任一 worker 失败后停止派发新任务（不遗留孤儿 worker）。`concurrency` 参数可省略：省略时上限为有效默认值 —— 配置文件中的 `maxConcurrency`（选项 **3 / 5 / 8 / 10**，默认 **5**；见[配置](#配置仅基于文件)）。
- `createSpawnRegistry()` / `abortAgent(registry, callId)` —— per-call abort 表（`Map<callId, ChildProcess>` + 每个调用独立的 `AbortController`）：单独中止一个 callId 而不影响批次中的兄弟调用。
- `getPiInvocation(args)` —— 解析 `pi` 调用方式（重入当前脚本，或 PATH 上的 `pi`）。
- `getEffectiveMaxConcurrency()` —— 有效默认并发上限（"并发 agent 数量"设置）：配置文件中的 `maxConcurrency`（选项 3/5/8/10），缺省回退 `DEFAULT_MAX_CONCURRENCY`（5）。调用时读取，改文件后下一次 fan-out 即生效，无需重启。
- 类型：`AgentSpawnRegistry` / `AgentSpawnOptions` / `AgentSpawnResult` / `AgentUsage` / `AgentCallId` / `AgentAbortMap`。
- `monitor` —— `AgentMonitor` 单例（见下文）。

Workflow 专属机制（`skipAgent`/`retryAgent`/`AbortReason`/生命周期通知）刻意留在 `pi-dynamic-workflows`，构建于本核心之上。

### Agent UI（可选 pi 扩展）

`sub-agent.ts` + `ui/` 将 monitor 的实时状态渲染出来：

#### Widget（编辑器上方）

```
● Agents
├─ ⠹ Agent  Refactor auth module · ↻5≤30 · 5 tool uses · 33.8k token (62%) · 12.3s
│    ⎿  editing 2 files…
├─ ⠹ Explore  Find auth files · ↻3 · 3 tool uses · 12.4k token (8%) · 4.1s
│    ⎿  searching…
├─ ⠹ Agent  Long-running task · ↻42 · 38 tool uses · 91.0k token (84% · ⇊2) · 2m17s
│    ⎿  reading…
└─ ✓ Explore  Find auth files · ↻2 · 2 tool uses · 8.1k token · 3.0s
```

以动画 spinner + 实时统计渲染已启动 agent 的树：

- `↻5≤30` —— assistant 轮次；设置了生效 `maxTurns` 时附带边界。
- `5 tool uses` —— 已完成的工具执行次数。
- `33.8k token (62%)` —— 生命周期 token 总量（input + output + cacheWrite，不含 cacheRead），括号内为上下文窗口占用 `NN%`。颜色分档：<70% dim、70–85% warning、≥85% error；模型无声明 `contextWindow` 时省略。
- `⇊N` —— 该 agent 会话的 compaction 次数，>0 时展示，恒为 dim。
- `12.3s` —— 自启动以来的耗时（结束后冻结）。
- `⎿ editing 2 files…` —— 当前活动，由在途工具或流式响应尾部推导。

已结束的 agent 以 ✓/✗ 短暂驻留（完成 5s，出错/中止 10s）后退出；超限折叠为 `+N more (…)`，优先保留运行中的 agent。

#### FleetView（编辑器下方）

子代理运行时，编辑器下方渲染可导航列表：

```
  esc to interrupt · ← for agents · ↓ to manage

  ● main
  ○ Agent  Refactor auth module                                     12s · ↓ 33.8k tokens
  ○ Explore  Find auth files                                        11s · ↓ 13.1k tokens
                                                                    ↓ 3 more
```

- 在**空**提示符下按 ↓ 或 ← 激活列表；正常输入不受影响。
- ↑/↓ 移动选择（● 标记），窗口滚动保持选中可见，超出部分折叠为 `↑/↓ N more`。
- Enter 打开选中 agent 的实时会话覆盖层；Esc 返回提示符。
- 任何对话框（pi 自带菜单、扩展对话框）持有键盘时，列表不抢键。
- 已结束的 agent 在列表中驻留约 4s 后退出。

#### 会话查看器（覆盖层）

居中覆盖层，展示该 agent 的实时消息流 —— 与 `spawnAgent` 收集的是同一个数组：

- `[User]` 提示词、`[Assistant]` 文本（thinking 以 dim 渲染）、`[Tool: 名称]` 调用、`[Result: 名称]` 输出（截断至 500 字符）。
- 运行中自动滚动；↑↓/jk 滚动，PgUp/PgDn/Shift+↑↓ 翻页，Home/End 跳转。
- `x x`（连按两次）经该调用的 per-call AbortController → SIGTERM 停止 agent。
- `q`/Esc 关闭。agent 结束后查看器保持打开（最终输出仍可读）。

子进程没有 stdin，因此没有 steering —— 只有查看与停止。

#### `/agents` 命令

列出本会话的 agent（运行中 + 刚结束的）。Enter 打开选中 agent 的查看器。

## 配置（仅基于文件）

没有交互式设置界面。三个配置键，从两层文件读取，项目层覆盖全局层：

| 层级 | 路径 |
| --- | --- |
| 全局默认 | `<agentDir>/pi-subagent.json`（通常是 `~/.pi/agent/pi-subagent.json`） |
| 项目覆盖 | `<cwd>/.pi/pi-subagent.json` |

```json
{
  "widget": "background",
  "fleetView": true,
  "maxConcurrency": 3
}
```

### `widget` —— 编辑器上方 widget 展示什么

| 取值 | 行为 |
| --- | --- |
| `background`（默认） | 隐藏前台 agent —— 即以 `background: false` 启动、已作为 Agent 工具结果内联渲染的调用。其余（声明为后台的、以及未声明的 —— 当前所有消费者调用的形态）保持可见。 |
| `all` | 展示全部 agent。 |
| `off` | 完全隐藏 widget（FleetView 与 `/agents` 不受影响）。 |

扩展启动时读取一次；改动在下一个 pi 会话生效。

### `fleetView` —— 编辑器下方 FleetView

| 取值 | 行为 |
| --- | --- |
| `true`（默认） | 子代理运行时注册可导航的 main+agents 列表。 |
| `false` | 列表不注册、输入钩子不拦截任何按键。上方 widget 与 `/agents`（含会话查看器）不受影响。 |

扩展启动时读取一次；改动在下一个 pi 会话生效。

### `maxConcurrency` —— 并发 agent 数量上限

子代理 fan-out 的默认并发上限（`mapWithConcurrencyLimit` 省略 `concurrency` 时使用；经 `getEffectiveMaxConcurrency()` 解析 ceiling 的消费者同样使用 —— 例如 [`pi-review`](../pi-review) 的 `subagent` 工具 parallel 模式）。

| 取值 | 行为 |
| --- | --- |
| `3` / `5`（默认）/ `8` / `10` | 同时在途的子代理至多该数量。其他取值被丢弃并回退默认值。 |

调用时读取，改文件后下一次 fan-out 即生效，无需重启。消费者自带 env 覆盖时的优先级：env（`PI_MAX_CONCURRENT_SUBAGENTS`）→ 本文件 → 默认 5。按步骤显式传入 `concurrency` 的消费者（如 `pi-dynamic-workflows`）不受影响。

配置文件损坏时忽略并输出 stderr 警告；未知字段被丢弃。

### 会话生命周期

会话替换与退出时 —— `/new`、`/resume`、`/fork`、reload、quit —— 两个 UI 面被立即拆除：注销 widget、停止 spinner 与刷新定时器、释放 FleetView 输入钩子、关闭打开中的查看器。下一次 `session_start` 重新注册。`/new` 额外清空 monitor 的陈旧条目，上一个会话已结束的 agent 不会在新会话中复活。

### 工具执行时的兜底重接

每次 `tool_execution_start` 都对两个 UI 面重跑 `setUICtx(ctx.ui)` + `update()`（吸收自 tintinweb/pi-subagents）。`ctx.ui` 是扩展 runner 的共享 uiContext —— 惰性 getter，身份仅在 rebind 时变化 —— 因此稳态下只是身份比较早退。它恢复两类场景：

- pi 无通知地清除了扩展 widget（before-session-invalidate / reload 时的 `resetExtensionUI()` 会 dispose 组件并清空 map；主题切换同样会 invalidate 组件），以及
- rebind 使 `ctx.ui` 身份变化而我们的 `session_start` 已跑过 —— `setUICtx` 识别新对象并对新上下文重注册。

时序收益：触发 spawn 的那个工具调用（如 pi-review 的 `subagent`）本身就产生该事件，因此 UI 面必然在第一批 `callStarted` 通知到达前完成注册。

## `spawnAgent` 选项（UI 相关元数据）

`AgentSpawnOptions` 有两个纯观测 UI 元数据字段 —— 不影响子进程与返回结果：

- `displayName?: string` —— widget/FleetView 行显示名。默认 `"Agent"`。
- `background?: boolean` —— `false` 标记该调用为前台（默认 `background` widget 模式下隐藏），`true` 标记为后台，省略表示未声明（全模式可见）。

## 可观测性契约

`spawnAgent` 在每个生命周期缝隙（调用开始/结束、assistant 消息、工具执行开始/结束、compaction、流式文本）通知进程级 `monitor` 单例。契约如下：

- **纯观测** —— dispatch 路径从不回读 monitor 状态；消费者行为（`AgentSpawnResult`、转录、中止语义）不变。
- **彻底的故障隔离** —— 每处通知都包 try/catch；monitor 方法全部写成全函数（防御性 typeof 检查，仅 Map/算术操作）。UI 侧 bug 不可能破坏 spawn。
- **状态有界** —— 已结束调用驻留 60s（上限 20 条）供查看器晚读，之后懒清除。

## 接线

pi 的扩展 loader 对每个扩展入口使用 `moduleCache: false` 的独立 jiti，因此普通模块单例是**每个扩展副本一份**。monitor 与共享 UI 控制器因此挂在 `globalThis` 上（`Symbol.for` 注册键）：进程内加载的每个包副本收敛到同一对象，消费者的 `spawnAgent` 通知无论 UI 由哪个副本注册都能到达。

让 widget 亮起来需要满足两个条件：

1. **有扩展注册 UI。** 对 [`pi-review`](../pi-review)，manifest 入口从 `subagent` 工具导入的同一份依赖副本加载：

   ```json
   "pi": {
     "extensions": [
       "./index.ts",
       "./node_modules/@fyeeme/pi-subagent-core/sub-agent.ts"
     ]
   }
   ```

   `pi install` 会为包执行 `npm install`，因此依赖副本（含 `sub-agent.ts`）必然存在。独立安装（`pi install npm:@fyeeme/pi-subagent-core`）也会注册 UI。

2. **消费者依赖 `>= 0.5.0`** —— 该版本的 `spawnAgent` 通知进程级 monitor。旧副本的通知留在私有模块实例里，对 UI 不可见。

本地开发（symlink 检出）时，编辑后需将包文件同步进消费者的 `node_modules` 副本（或重装）—— jiti 不会跟踪过期副本上的编辑。

## 目录结构

```
pi-subagent-core/
├── index.ts          # dispatch 核心（spawnAgent、并发、registry、monitor 钩子）
├── monitor.ts        # AgentMonitor —— 进程级实时 agent 状态
├── settings.ts       # 基于文件的设置（widget / fleetView / maxConcurrency）
├── sub-agent.ts      # 可选 pi 扩展入口（widget + fleet + /agents）
├── ui/
│   ├── agent-widget.ts         # 编辑器上方 widget
│   ├── fleet-list.ts           # 编辑器下方 FleetView + 按键处理
│   ├── conversation-viewer.ts  # 覆盖层转录查看器
│   └── shared.ts               # 格式化 + 主题助手 + 模型目录
└── test/
    ├── dispatch.test.ts        # spawnAgent 语义（mock 子进程）
    ├── recursion-guard.test.ts # fan-out 深度策略
    ├── monitor.test.ts         # monitor 单元 + spawnAgent→monitor 集成
    ├── settings.test.ts        # pi-subagent.json 解析/分层/清洗
    └── extension.test.ts       # UI 生命周期：注册、拆除、/new、开关
```

## 开发

```bash
npm install --ignore-scripts
npm run typecheck   # tsc，strict
npm test            # vitest --run（无真实子进程；stdout 事件为 mock）
```

## 为什么存在

`pi-review` 与 `pi-dynamic-workflows` 曾各自实现同一 spawn 原语（文件头互相引用，两个 README 都写着"等 pi 将 `spawnAgent` 提升为公开导出后删除"）。本包是该核心的唯一事实来源。

当 pi 将 `spawnAgent` 提升为 `@earendil-works/pi-coding-agent` 公开导出后，本包应被删除并以该导入替代。

## 致谢

UI 层移植自 [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents) 的 agent widget 与 FleetView，并适配本包的子进程 dispatch 模型（无进程内 agent 会话、无 steering；仅查看与停止）。
