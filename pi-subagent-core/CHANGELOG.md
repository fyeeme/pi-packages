# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-08-24

### Added

- `text.ts` — single implementation of defensive `Message.content` text extraction: `contentTextBlocks`/`contentText` (string | content-block array → text blocks) and `lastAssistantText` (last non-empty assistant text, excluding intermediate-round chatter). Shared by consumers (pi-review's `subagent` tool and `/code-simplify` handler, and the conversation viewer), replacing their hand-rolled copies.
- **Configurable concurrent agent count (default 5, options 3/5/8/10)**: `maxConcurrency` key in the config file (global `<agentDir>/pi-subagent.json` + project `<cwd>/.pi/pi-subagent.json` layers, project overriding global; only 3/5/8/10 accepted, invalid values dropped with fallback to 5); the core exports `getEffectiveMaxConcurrency()` (read at call time; editing the file takes effect on the next fan-out) and `MAX_CONCURRENCY_OPTIONS`; `mapWithConcurrencyLimit` with `concurrency` omitted now reads that effective default instead of the hardcoded `DEFAULT_MAX_CONCURRENCY` (calls passing `concurrency` explicitly are unchanged).
- **Subagent UI layer** (ported from tintinweb/pi-subagents, adapted to this package's subprocess dispatch model):
  - `monitor.ts` — module-level `AgentMonitor` singleton: `spawnAgent` notifies it at every lifecycle seam (call start/end, assistant messages, tool execution start/end, compaction, streaming text). Purely observational: the dispatch path never reads monitor state back, and every notification is wrapped in try/catch — a UI-side failure cannot affect spawn. Bounded state: finished calls are kept 60s (max 20 entries) for late viewer reads, then lazily swept.
  - Persistent widget above the editor (`ui/agent-widget.ts`): spinner + `↻5≤30` turn counter · tool-use count · `33.8k token (62% · ⇊2)` (context percentage colored dim <70% / warning 70–85% / error ≥85%; omitted for models without a declared contextWindow; compaction count >0 annotated as `⇊N`) · elapsed time · `⎿ editing 2 files…` activity line. Lingers briefly on completion (✓/✗, 5s/10s) then exits; overflow collapses to `+N more (…)`. Default `widget: "background"` (background agents only; foreground agents are already rendered inline as tool results, avoiding double rendering).
  - FleetView (`ui/fleet-list.ts`): while subagents run, renders a Claude Code-style navigable list below the editor (`esc to interrupt · ← for agents · ↓ to manage`); activated by ↓/← at an empty prompt, ↑/↓ to select, Enter opens the conversation viewer overlay, Esc returns. Keys are intercepted via `onTerminalInput` (activated only at an empty editor; never steals keys while a dialog holds the keyboard).
  - Conversation viewer (`ui/conversation-viewer.ts`): live-scrolling transcript (user/assistant text with thinking/tool calls/truncated tool results); double `x x` stops the agent via a per-call AbortController; the subprocess has no stdin, no steering.
  - `/agents` command: lists session agents (Enter opens the viewer). No interactive settings UI — the three config keys are set only via the `pi-subagent.json` file: `widget` (all/background/off, default background, read at startup), `fleetView` (boolean, default true, read at startup — when off, the list is not registered and the input hook intercepts no keys; widget and `/agents` are unaffected), `maxConcurrency` (3/5/8/10, default 5, read at call time).
  - Session lifecycle: on `session_shutdown` (quit, `/new`, `/resume`, `/fork`, reload) both UI surfaces are torn down immediately — widget unregistered, spinner/refresh timers stopped, FleetView input hook released, open viewer closed; the next `session_start` re-registers; `/new` additionally clears stale monitor entries so agents finished in the old session don't revive in the new one.
  - Bilingual docs: full Chinese (`README.zh-CN.md`) / English (`README.md`) READMEs.
  - Settings module rename (revised directly in the unreleased 0.5.0, no compat layer): `loadUiSettings`/`SubagentUiSettings` → `loadCoreSettings`/`SubagentCoreSettings`; config file `pi-subagent-core.json` → `pi-subagent.json`; config keys `widgetMode` → `widget`, `maxConcurrentAgents` → `maxConcurrency`.
  - **Agent description & transcript display convergence**: models often write the repo-context boilerplate line (`Repo cwd: <path> (description). Repo信息`) into subagent prompts — that line is no longer used as the agent description in widget/FleetView/`/agents` rows (`isBoilerplateLine` prefix filter, falling back to the original first line when everything matches; the data-layer task is unchanged); the viewer's `[User]` section filters the same line (purely boilerplate messages are skipped entirely); `[Assistant]` text output is limited to a 2000-char preview (truncated with a note) and thinking to 1000 chars.
  - `tool_execution_start` UI re-attachment fallback (absorbed from tintinweb/pi-subagents, see its index.ts:1134 "Grab UI context from first tool execution"): on every tool execution, `setUICtx` runs against widget/fleet (`ctx.ui` is the runner's shared uiContext, always the same object within a binding → idempotent early return, no per-call jitter) + `update()`. Recovers two real scenarios: ① pi's `resetExtensionUI()` (before-session-invalidate, /reload) calling `clearExtensionWidgets()` without notice, or a theme switch invalidating components and the registration flag — the next tool execution re-registers; ② `ctx.ui` identity changing after rebind (no session_start fallback) — setUICtx recognizes the new object and re-registers against the new context. Timing benefit: the very tool call that triggers spawn (e.g. `subagent`) produces this event itself, so registration necessarily precedes the first batch of callStarted notifications.
  - Unit test additions: `settings.test.ts` (file names/two-layer merge/key parsing/invalid-value cleansing/no legacy-name compat/corrupt-file degradation), `extension.test.ts` (UI lifecycle: registration position, immediate unregistration on shutdown, `/new` clears without revival, `widget: off`, `fleetView: false` registers nothing and steals no keys while the `/agents` viewer still works, re-registration after resume, four `tool_execution_start` fallback cases: recovery after invalidate, re-registration on a rebound ctx, steady-state same-ctx without jitter, wake-up by first tool execution when session_start had no bound UI).
  - The package is now an optional pi extension: `package.json` gains the `pi` manifest (`./sub-agent.ts`) and the `pi-package` keyword; peer deps add `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`.

### Changed

- `describeTask` (agent row description) now does an incremental `indexOf` scan for the first non-boilerplate non-empty line: tasks embed the full diff (capped at ~400KB), and the original `split+map+filter` materialized the entire line array on every spawn.
- Settings reads are cached per file by (mtimeMs, size): `maxConcurrency`'s read-at-call-time semantics are unchanged (editing the file takes effect on the next fan-out), but an unchanged file now costs one stat instead of read+JSON.parse.
- The agent widget / FleetView take a single monitor snapshot per tick (previously the 80ms tick scanned twice and the 200ms tick three times: update/clamp/render each called `monitor.list()` → sweep + array copy).
- Conversation viewer: navigation-key scroll clamping reuses the line count cached at render time (previously every keypress rebuilt the entire wrapped transcript); the 1s refresh tick self-stops after the agent finishes (elapsed time frozen at completedAt; a subscribe listener covers late changes).
- `AgentSpawnOptions` gains two pure UI metadata fields (no effect on the subprocess or the returned result): `displayName` (display name for widget/FleetView rows, default `"Agent"`) and `background` (declares foreground/background: `false` = foreground — hidden under the default widget mode; omitted = undeclared — visible in all modes, i.e. the shape all current callers use).

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
