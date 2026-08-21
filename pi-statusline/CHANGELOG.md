# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.1] - 2026-08-21

### Fixed

- Support `deepseek-v4-flash-vision-exp` (V4 Flash Vision): the model was missing from the CNY price table, so its cost fell back to pi's recorded USD price (understated ~7x for CNY accounts, often rendering `¥0.00`). Official pricing is identical to V4-Flash (images are billed as tokens, no vision surcharge); the model now follows the same peak/off-peak rates.

## [1.2.0] - 2026-08-21

### Added

- Adopt DeepSeek's peak/off-peak pricing (effective 2026-08-17): the price table is split into peak/off-peak columns (flash: cache-hit input ¥0.05/0.10, cache-miss input ¥1.5/3.0, output ¥4.5/9.0; pro: cache-hit input ¥0.15/0.30, cache-miss input ¥4.5/9.0, output ¥13.5/27.0 per million tokens); `isDeepSeekPeakTime()` determines peak hours in Beijing time (UTC+8, no DST; 9:00-12:00, 14:00-18:00), independent of the host timezone.
- Session cost is recomputed per message using the peak/off-peak rate of the message's own timestamp (`AssistantMessage.timestamp`), so long sessions spanning 9:00/12:00/14:00/18:00 boundaries price each message correctly; the DeepSeek usage segment appends the current period (`peak`/`off-peak`).
- The registry pricing patch follows the current period (peak or off-peak); the footer render detects period flips and re-aligns the registry so pi's recorded `usage.cost` tracks the period.

### Changed

- Pricing logic refactored into a strategy pattern (new `pricing/` module): the `PricingStrategy` interface (`messageCost`/`defaultCurrency`/`applyPricingPatch`/`shouldRefreshPatch`/`footerTag`) defines each provider's price model; DeepSeek is implemented as `DeepSeekPricingStrategy`, dispatched by provider via `getPricingStrategy()`; `cost.ts` removed. Session stats and rendering depend only on the interface — future DeepSeek price changes or GLM/ZAI pricing models only touch/add the corresponding strategy, never the `token-usage`/`index` core flow.

## [1.1.1] - 2026-08-08

### Fixed

- 会话级 token/cost/tok-s 在分叉会话（`/fork`、`/tree`）后不再把整棵树计入：`SessionTokenUsageCalculator.compute` 与 `agent_end` 累计输出改用 `sessionManager.getBranch()`（仅当前分支）；`/status-debug` 仍保留全量 `getEntries()` 用于诊断。
- 切换 provider（`/model` deepseek↔zai）后状态栏不再短暂显示上一个 provider 的用量段：`getCachedUsage` 在缓存 provider 与当前 provider 不匹配时返回 null，等待 `model_select` 触发的新刷新落地。
- ZAI 用量段对 `zai-coding-cn` provider 不再永久漏显示：`ZaiResult.provider` 记录实际 provider key（`zai`/`zai-coding-cn`），provider guard 不再因字面量 `"zai"` 误判（code-review #1）。
- tok/s 改用本次 agent run 的 output/耗时（`event.messages`），分子分母同口径，不再受 /fork 放弃分支的累计耗时影响；同时消除 `agent_end` 对模块级 `lastCtx` 的依赖（code-review #2）。
- `/status-debug` 的 msg 遍历改用 `getBranch()`，与 `tokenCalculator.compute` 口径一致（code-review #7）。
- `SessionTokenUsageCalculator.compute` 内 `deepSeekBilledInCny()` 冗余的第二次调用复用已有变量（code-review #8）。

### Changed

- 移除 `package.json` 中已废弃的 MCP 描述与 keyword（MCP 状态段自 1.0.2 起已移除）。
- 新增 `session_shutdown` 清理 usage cache：`/resume` 或 `/new` 进入不同 provider 时立即刷新，而非沿用上一会话缓存。
- `devDependencies` 对齐当前平台（`@earendil-works/pi-coding-agent`/`pi-ai`/`pi-tui` `0.77.0` → `0.84.1`），便于利用 `thinking_level_select`、`getAvailableProviderCount` 等新类型。
- README 状态栏示例 `deepseek-v3` → `deepseek-v4-pro`（`deepseek-v3` 已不在 0.84.x 模型库）。

## [1.1.0] - 2026-08-07

### Added

- DeepSeek 结算币种感知定价（新模块 `cost.ts`）：CNY 计费账户按官方 ¥ 单价重算（flash ¥1/¥2/¥0.02、pro ¥3/¥6/¥0.025 每百万 tokens），修正 pi 内置 USD 价低估约 7 倍；USD 计费账户保持 pi 内置价。
- balance API 自动探测账户结算币种；`/currency` 手动覆盖（auto/¥/$），切换后即时刷新注册表定价。
- 币种判定后即时对齐运行时注册表定价（覆盖与还原均可逆、跟随结算币种）。

### Fixed

- USD 计费账户启动后不再整场会话停在 CNY 价：balance 探测到币种后立即重新应用定价补丁。
- 会话内新增 deepseek 模型（编辑 `models.json` + reload）后再次应用定价补丁时，不再因陈旧快照 + `registerProvider` 整表替换丢弃新增模型。

## [1.0.2] - 2025-07-15

### Fixed

- `getCachedUsage` crash when TTL expires and model provider has no registered UsageProvider (TypeError on null)
- `scanWeeklyTokens` UTC/local timezone mismatch: file date parsing now uses local timezone to match `startOfCurrentWeekLocal`
- Unhandled rejection in `refreshUsage` fire-and-forget callers: added catch-all error handler

### Changed

- Background usage refresh now deduplicates concurrent TTL-expired callers via memoized `refreshInFlight` promise
- Weekly token scan results cached for 1 minute to reduce redundant filesystem I/O

### Removed

- MCP server status segment from footer and its event listeners (`mcp:status`/`mcp:disconnect`): no pi version emits these events

## [1.0.1] - 2026-06-19

### Fixed

- ZAI weekly token count for plans without a `unit:6` weekly quota now comes from the backend `model-usage` API for the current natural week (Mon 00:00 UTC → now) instead of scanning local session files, so it matches the backend's per-week tally. Footer label changed from `7d:` to `W:` to reflect the natural-week window.

### Changed

- Natural-week window (DeepSeek local scan and ZAI fallback) now uses the host's local timezone instead of UTC, so "this week" matches the user's expectation. Both providers share the same boundary via `startOfCurrentWeekLocal`.

### Removed

- `quota/` directory (`QuotaCalculator` and its DeepSeek/ZAI implementations) and the `quotaCalculator` field on `UsageProvider`. These were never invoked at runtime; the live logic lives in the providers directly.

## [1.0.1] - 2026-06-19

### Fixed

- Tighten tokens-per-second spacing in the footer timing segment: render `39.5tok/s` instead of `39.5 tok/s`.

## [1.0.0] - 2025-05-31

### Added

- Initial release
- Two-line footer: cwd + git branch (left) / model + thinking level (right), and token stats line
- Token usage: input, output, cache read/write, total per session
- Cost display with auto currency detection (¥ for DeepSeek, $ otherwise)
- DeepSeek account balance fetched on startup, cached 5 minutes
- Context window usage percentage and size
- Elapsed time and tokens/sec for last response
- MCP server connection count and tool count via `mcp:status` / `mcp:disconnect` events
- `/balance` command to force-refresh DeepSeek balance
- `/currency [auto|¥|$]` command to toggle cost currency
- `/status-debug` command to dump session stats to log file
