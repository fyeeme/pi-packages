# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- File-based turn budgets: `maxTurns` for the four dispatch sites — `subagent` (/review finder batches), `verifier` (/review Phase 2 verifiers), `gapHunt` (/review Phase 3 gap-hunt), `simplify` (/simplify PARALLEL cleaners) — read from `<agentDir>/pi-review.json` with `<cwd>/.pi/pi-review.json` overriding (same two-layer pattern as pi-subagents). Prompt templates now carry `{{finder-max-turns}}` / `{{verifier-max-turns}}` / `{{gap-hunt-max-turns}}` / `{{simplify-max-turns}}` placeholders rendered from config; positive-integer values only, and with no config file the defaults (20 / 15 / 15 / 15) render the pre-config literals byte-for-byte, so behavior is unchanged. The skills now note that a budget stated in the trigger message wins over their built-in defaults (Phase 2 previously stated NO verifier budget — the model guessed 15).
- `/review` trigger now injects the detected verification command (`{{verify}}`, same `verifyLine` source as /simplify); the code-review skill's `--fix` flow consumes it: run verification after applying fixes and before the structured re-report, reverting and marking `skipped` any finding whose fix breaks verification (verification stays opportunistic — no detected command means re-report directly and say so).
- code-review skill `--comment` aligned with CC 2.1.261: GitHub posts one inline comment per finding (suggestion block only when it fully fixes the issue) with a `gh api repos/{owner}/{repo}/pulls/{pr}/comments` fallback; GitLab MRs post ONE general note via `glab mr note` (inline threads need `glab api .../discussions` and are opt-in); a non-PR/MR target prints the findings and notes `--comment` was ignored.

### Changed

- Skill renamed to match the command: `skills/code-review/` → `skills/review/` (frontmatter `name: code-review` → `name: review`), so the chain reads `/review` → `prompts/review.md` → `skills/review/SKILL.md`, mirroring `/simplify` → `prompts/simplify.*.md` → `skills/simplify/SKILL.md`. Manifest, dispatcher path, tests, and agent descriptions updated in step. `/skill:code-review` invocations become `/skill:review`; the `/review` command itself is unchanged (the skill loads via the trigger message path, not by name). Also fixed a stale in-body pointer: the simplify skill's Phase 0 intro told the model bugs are what "`/code-review`" is for — a command that does not exist in Pi; it now says `/review`. CC-lineage mentions of the upstream `code-review` skill (origin comments, verbatim tool-description mirrors in `review_report.ts`) are deliberately unchanged.
- Re-verified the reverse against Claude Code CLI v2.1.261 (2026-09-05, bin/claude.exe raw bytes; previous basis v2.1.223): the 2.1.217-era background Workflow (Scope/Find/Verify/Sweep/Synthesize) is gone upstream — phases live inline in the skill and high/xhigh/max run inside a CC background agent (still no Pi counterpart; the skill stays inline, and the Phase 0.5 scope block remains our absorption of the old workflow's Scope phase). 2.1.261 also ships flag-gated effort variants (e.g. an inline dedup-only xhigh); the uniform medium+ = fan-out + grouped verify / sweep at xhigh/max linearization is kept. Synced deltas: the Altitude angle body (root-cause phrasing + "name that change") in both skills and `agents/cleaner-altitude.md`; the sweep focus list (moved/extracted code that dropped a guard or anchor; second-tier footguns — dataclass default evaluated once, `hash()` non-determinism, lock-scope shrink, predicate methods with side effects; setup/teardown asymmetry in tests; config defaults flipped) into Phase 3 and `agents/gap-hunter.md`; the no-unsolicited-artifacts rule (the `review_report` call IS the report; `--share` stays the explicit opt-in); the effort-semantics framing (low/medium: fewer, high-confidence findings; high→max: broader coverage, may include uncertain findings) and the xhigh/max "a missed bug ships" recall stance. Everything else verified byte-identical upstream and left as carried: correctness angles A–E, Reuse/Simplification/Efficiency/Conventions bodies, the CONFIRMED/PLAUSIBLE/REFUTED rubric with PLAUSIBLE-by-default, the low-effort Turn 1/Turn 2 flow with the test/fixture skip list, the 8/10 finder allocation, /simplify's two mode bodies and Phase 2 apply rules, the `{level, findings}` report contract (`short_summary` ≤60, `category` slug, `verdict`, `outcome` 三档), and sticky last-effort.

### Fixed

- `review_report` string-enum parameters (`verdict`, `outcome`, `level`) use `StringEnum` for Google API compatibility.
- The report JSON sink directory uses `CONFIG_DIR_NAME` instead of a hardcoded `.pi`.
- `/simplify` diff resolution is abortable via `ctx.signal`.
- The third `promptGuidelines` bullet names `review_report` explicitly (guidelines are appended flat, so "Use this tool" was ambiguous).

## [2.0.0] - 2026-08-25

**Major release** (from 1.1.1), headlined by the sandwich refactor: methodology lives in skills, orchestration strategy is prompt-template data, review angles are subagent definitions, and the plugin entry composes `@fyeeme/pi-subagents` 2.0.0 from npm as the fan-out engine. Command renames are breaking (`/code-review` → `/review`, `/code-simplify` → `/simplify`). Highlights below.

### Breaking Changes

- Extension wiring rebuilt on composition: the `pi.extensions` manifest no longer loads `./node_modules/@fyeeme/pi-subagents/extension.ts` (the path hack); instead this package's factory calls pi-subagents' exported extension factory (`piSubagents(pi)`). Single-install works out of the box with the tool/UI version-pinned to this package's dependency copy; a standalone pi-subagents install coexists (idempotent composition guard).

### Fixed

- Availability probing guidance: `subagent` is an extension tool, invisible to the `mcp` gateway's tool search — a session that probed via `mcp({search})` saw "No tools matching subagent" and wrongly degraded to sequential self-review even with the tool registered. `prompts/review.md` and the code-review skill's Phase 1 now state to judge availability from the session's tool list and never probe via `mcp` search. (The underlying `/reload` tool loss is fixed in `@fyeeme/pi-subagents`.)

## [1.2.0] - 2026-08-24

Sandwich refactor (openspec change `subagent-sandwich-refactor`): the orchestration strategy moves from hardcoded command handlers into data, and subagent spawning moves to `@fyeeme/pi-subagents`.

### Breaking Changes

- Commands renamed: `/code-review` → `/review`, `/code-simplify` → `/simplify` (effort levels, flags, sticky-effort state, and argument semantics unchanged; `~/.pi/.pi-review-state.json` carries over).
- The bundled `subagent` tool and the `simplify_fanout` tool are REMOVED from this package. Fan-out is delegated to the `subagent` tool of `@fyeeme/pi-subagents` (single/parallel/chain, agent-name referencing). Anything that scripted `simplify_fanout` must switch to `subagent` parallel mode with the cleaner agents.
- The four cleanup angles are no longer a TS constant: they ship as bundled agent definitions (`agents/cleaner-{reuse,simplification,efficiency,altitude}.md`), alongside `finder-*` (correctness A–E + conventions), `verifier`, and `gap-hunter`.
- Dependency replaces `@fyeeme/pi-subagent-core` with `@fyeeme/pi-subagents` (the old package is retired).

### Added

- Prompt-template orchestration layer (`prompts/`): `review.md`, `simplify.parallel.md`, `simplify.single.md` — parallel-strategy guards declared as frontmatter data (`parallel-when.context-below`, `parallel-when.diff-chars-below`), evaluated by the generic dispatcher (`src/dispatch.ts`). Editing a template changes the strategy with no code change.
- Bundled agent set under `agents/` (12 definitions) invoked via the `subagent` tool by name.
- Skills register natively via the `pi` manifest field (`pi.skills`) instead of the bundled-path-plus-trigger mechanism.
- `subagent` tool calls gain `maxTurns` (per-call turn budget; finder batch 20 / gap-hunt 15 as the skills instruct) and `parallelism` (capped by the shared ceiling).

### Changed

- `src/dispatch.ts` is the only command layer: gathers deterministic runtime variables (diff via the unchanged candidate ladder, context usage, sticky effort), evaluates the template-declared guards, renders the `{{var}}` template, and hands the message to the session. `decideSimplifyMode` semantics preserved with thresholds sourced from template data.
- Diff resolution/parsing pure functions relocated verbatim to `src/diff.ts` (`getRepoDiff`, `resolveDiffScope`, `buildContextPackage`, `detectVerifyCommand`, `verifyLine`); tests carried over (`test/diff.test.ts`).
- Drift anchors re-pointed: `test/angle-sync.test.ts` now anchors skill angle bodies ↔ cleaner agent definitions ↔ template agent references (both directions); `test/dispatch.test.ts` anchors guard evaluation, effort parsing, and template phase structure.

### Removed

- `src/commands/` (code-review.ts, code-simplify.ts), `src/tools/subagent.ts`, `src/tools/simplify_fanout`, `src/concurrency.ts`, `SIMPLIFY_ANGLES`, `decideSimplifyMode`, `buildParallelTrigger`/`buildSinglePassTrigger`/`buildSimplifyTasks`/`formatFanoutResults` — all superseded by the template + agent assets or by pi-subagents.

## [1.1.1] - 2026-08-24

### Added

- `/code-simplify` opening aligned with CC observability (visible Phase 0 + tool-gated fan-out): trigger messages in both modes now carry the handler-resolved scope, changed-file index, and an **exact reproduction command** (`getRepoDiff` ok result gains `gitCommand`, with `-C <gitRoot>`/range/path limits) — the instructed model first visibly runs that command to read the diff and writes a 2–4 line change-intent summary before anything may start. PARALLEL mode is no longer dispatched directly by the command handler: after Phase 0 the model calls the new `simplify_fanout` tool (the counterpart of CC's Agent call). The tool re-resolves the diff itself (never trusting diff text passed by the model — also fixing the CC-observed flaw where its model didn't inline the diff), re-checks fan-out conditions with fresh context usage (falls back to single-pass with `fanned_out: false` when unmet), embeds the diff into the 4 angle tasks and dispatches via the shared subagent core (maxTurns 15 / read-only allowlist / maxConcurrency constraint / onUpdate progress counting); findings return as a tool result in the same turn and flow into Phase 2. New pure functions `buildParallelTrigger`/`buildSinglePassTrigger`/`formatFanoutResults` with tests; `simplify_fanout` and `subagent` are both registered under the `isFanoutToolAllowed()` recursion guard.
- `/code-simplify` diff scope is now **path/submodule-aware** (`findGitRoot`/`resolveDiffScope`): when the target is a path, its nearest git root is located — a target inside a git submodule (e.g. `@packages/extensions/pi-review/`) takes the diff in the submodule's own repository (the parent repo's `git diff` only sees a dirty pointer, not the real changes inside), limited by relative path; a target that is itself a git root takes the full diff. Non-path targets (branch/PR) keep whole-diff. `git` calls moved to argv-array `execFile` (no shell-injection risk, no TUI main-thread blocking). Fixes observed behavior: the 4 cleanup agents previously saw only journal/manifest runtime artifacts and the submodule pointer; they now get the real code changes inside the submodule.
- `/code-simplify` PARALLEL mode now runs the 4 cleanup agents (Reuse/Simplification/Efficiency/Altitude) via **direct command-handler calls into `@fyeeme/pi-subagent-core`**: the handler uses `getRepoDiff` (git diff; prompts and exits when not a git repo / no changes) + `buildSimplifyTasks` + `spawnAgent`/`mapWithConcurrencyLimit` (each agent `maxTurns: 15`, read-only tool allowlist read/grep/find/ls/bash, model inherited from the session, `displayName` set to the angle name) — agents appear live in the agent widget / FleetView and honor the `maxConcurrency` config; when done, the 4 findings sets are handed to the model for Phase 2 (apply/verify/report, `fanned_out: true`). No longer relies on the model calling the subagent tool itself. SINGLE-PASS mode keeps its original behavior (one message; the model works the four angles inline). The simplify skill's PARALLEL section updated in step (Phase 1 is done by the command; the model only merges/dedups + Phase 2).
- `subagent` tool concurrency ceiling is now config-driven: `PI_MAX_CONCURRENT_SUBAGENTS` env → pi-subagent-core `maxConcurrency` setting (options 3/5/8/10, default 5; `pi-subagent.json` global + project layers) → 5. Default lowered from 20 to 5 (read at call time, editing the file takes effect immediately); env override stays highest priority; an explicit `parallelism` argument is unchanged.
- Wired in `@fyeeme/pi-subagent-core`'s subagent UI layer: the `pi` manifest adds `./node_modules/@fyeeme/pi-subagent-core/sub-agent.ts` as an extension entry, loaded from the same dependency copy as the `subagent` tool — the agent widget above the editor, FleetView below, conversation viewer, and `/agents` command ship with the package and share monitor state with the tool. Dependency bumped to `^0.5.0`. Local development requires syncing the core package into this package's `node_modules` copy first (the wiring mechanism is now documented in pi-subagents' README "Wiring" section).
- The 4 cleanup agent tasks now embed a zero-token context package (`buildContextPackage`, parsed handler-side from the diff, costs no parent context): repo root path, matched diff scope label, and a changed-file index with insert/delete counts (truncated with a remainder note above 200 files); single-pass trigger messages carry it too, saving each agent's 1–3 rounds of `git diff --stat` reconnaissance.

### Changed

- `/code-simplify` diff range widened from unstaged `git diff` only to the full changed-code cascade: prefer `git diff <merge-base @{upstream} HEAD>` (unpushed commits + staged + unstaged, matching the simplify skill Phase 0), fall back to `git diff HEAD` without an upstream, and to `--staged`/unstaged in a fresh repo with no commits; `getRepoDiff` returns a discriminated union `DiffOutcome` (ok / no-repo / empty / git-error, ok carries gitRoot + scope label), and the actually matched scope is written into agent prompts and trigger messages. An empty diff exits early in both modes (single-pass previously let the model spin an empty round).
- `/code-simplify` mode decision gains a diff-size guard: `DIFF_TOO_LARGE_CHARS = 400_000` (≈100k tokens per copy; 4 fan-out copies cost ~400k input tokens in prompts alone) or more downgrades to single-pass; `decideSimplifyMode` now returns `{mode, reasons}`, with the reasons (context unknown / no subagent / context near-full / diff too large) embedded in the trigger message so the decision is observable.
- `/code-simplify` mode decision drops the leftover `hasSubagent` gate: PARALLEL mode long since dispatched via handler-side direct calls into `@fyeeme/pi-subagent-core`, independent of subagent tool registration; the cleanup agents' tool allowlist (read/grep/find/ls/bash) never contained fan-out tools, so recursion stays physically bounded. The simplify skill's preconditions and SINGLE-PASS section rewritten to match.
- `/code-simplify` git calls moved from `execFileSync` to promisified `execFile` (`GitRunner` signature made async, `getRepoDiff` returns a Promise): the handler is an async function, so large-repo diffs no longer block the TUI main thread (the worst case previously froze spinner/input across 5 serial git processes).
- `/code-simplify`'s fan-out ceiling and the `subagent` tool now share one resolver (exported `getMaxConcurrency`): the `PI_MAX_CONCURRENT_SUBAGENTS` env → `maxConcurrency` settings priority is consistent across the package's two fan-out paths (the handler side previously read only the settings file and ignored the env override).
- `Message.content` defensive text parsing converged onto pi-subagent-core's single implementation (`contentText`/`lastAssistantText`): the hand-rolled copies in `code-simplify.ts` and `subagent.ts` are deleted.
- Each cleanup agent task no longer repeats the full angle definition text (definitions are injected only via systemPrompt, saving one copy of definition tokens per agent); `callId` loses its meaningless `-index-Date.now()` suffix; `DIFF_SCOPES` flattened into a `Record<DiffScopeKind, string>` label table (kind no longer stored inside the value); two identical branches of `resolveDiffScope` merged.
- `SIMPLIFY_ANGLES` (TS) and the skill's angle prose are now covered by the `angle-sync` sync test (wording drift goes red); the Reuse definition aligned with the skill text (period → em dash).
- `resultText` takes only the last non-empty assistant text and is now exported with tests; intermediate progress chatter ("Let me check…") no longer leaks into the findings returned to the parent context.

### Fixed

- `code-review` skill Phase 1 finder dispatch gains turn-budget discipline (aligning with the runaway-exploration guard Phase 3 gap-hunt already had): finder batches set an explicit `maxTurns: 20`, finder prompts declare a tool-call budget, the last assistant message must be the JSON candidate array (an empty `[]` is valid; partial output beats none), and a finder that hits the cap with no JSON is recorded as a failed angle and re-dispatched on a narrower file slice. Fixes field observation: on a 168-file diff, 7/10 finders burned all 30 turns with zero output, silently losing angles and cascading into gap-hunt + a second verify wave (~15 minutes).
- `getRepoDiff` git failures are no longer swallowed as "no changes": when all candidates fail (broken repo, diff exceeding the 10MB maxBuffer) it reports `git-error` with the real error message.
- The `subagent` tool no longer concatenates intermediate-round assistant chatter ("Let me check …") into the inline result: text extraction converged onto pi-subagent-core's shared `lastAssistantText` (last non-empty assistant message), the same semantics as `/code-simplify` — the two hand-rolled parsers previously shared a name but not semantics, and the fix had landed on only one of them. (Regression test added.)
- Aborted agents in `/code-simplify` fan-out no longer masquerade as "(no findings)": the `failed` predicate is now the single condition `exitCode !== 0`; aborted is annotated separately (partial findings already written are kept).
## [1.0.3] - 2026-08-16

### Changed

- 依赖 `@fyeeme/pi-subagent-core` `^0.3.3` → `^0.4.0`（tracking 升级：core 新增 `DEFAULT_MAX_CONCURRENCY` 常量与可省略 `concurrency` 的重载，本包所有调用点均显式传入 concurrency，行为不变）。

### Removed

- 删除空占位文件 `README.zh-CN.md`（pack 清单从未包含它，无分发影响）。

## [1.0.2] - 2026-08-14

### Breaking Changes

- `review_report` 的 `outcome` 枚举由 5 档（`fully_achieved` / `mostly_achieved` / `partially_achieved` / `not_achieved` / `unclear_from_transcript`）替换为 CC `ReportFindings` 实证三档 `fixed` / `skipped` / `no_change_needed`（2.1.227 二进制实证，2.1.223/226/227 三版本一致）。simplify 的 apply-outcome 同步重映射：`fixed` = 应用且验证通过；`skipped` = 真实但未应用（含部分应用与回滚）；`no_change_needed` = 不适用。工具入口对旧五档值归一化为 `skipped` 并附注，调用不失败。
- `review_report` 的 `verdict` 枚举收窄为 `CONFIRMED` / `PLAUSIBLE`（去除 `REFUTED`，与 CC schema 一致）；携带非法 verdict（含 `REFUTED`）的 finding 在工具入口被剔除，其余正常处理。
- `/code-review` 的 finder 分配由「每正确性角度一 finder + 1 合并 cleanup」改为 CC inline 8/10 finder：medium/high = 3 correctness（A/B/C）+ 3 cleanup 各一 + altitude + conventions；xhigh/max = 5 correctness（A–E）+ 同上。effort 差异由四元组 `{correctnessAngles, perAngle, maxFindings, sweep}` 参数化：medium `{3,6,8,false}`、high `{3,6,10,false}`、xhigh `{5,8,15,true}`、max 同 xhigh。

### Added

- `review_report` 新增 `short_summary`（≤60 字符纯声明）——汇总表概述列优先使用，详情块保留完整 `summary`；schema optional、流程必填（CC 输出模板契约）。
- `review_report` 新增 `report_id`——落盘 JSON 与报告头部携带，fixed-later 再上报复用同 id 供消费方归并。
- code-review skill 新增 Phase 0.5 Scope 先行：主会话统一确定 diff/文件清单/CLAUDE.md conventions/变更摘要，组装范围块嵌入所有 finder/verifier/gap-hunt 的 subagent prompt；空 diff 提前终止。
- code-review skill 验证阶段改为按 `(file, line)` 分组、每组一个 verifier 返回逐一 verdict（吸收 CC workflow group-verify，~40% verifier 减员为期望值）；遗漏索引的候选丢弃，不臆造 PLAUSIBLE。
- code-review skill 新增 fixed-later 义务（CC `Q8m`）：本会话后续修复已上报 findings 必须再次调用 `review_report` 更新 `outcome`，先于任何文字总结。
- 新增 `test/skill-schema-sync.test.ts`：断言两份 SKILL.md 的 outcome 枚举文本与 schema 常量一致（防漂移），旧五档值不得残留。
- `subagent` 工具新增 `thinking` 参数（`off|minimal|low|medium|high|xhigh|max`）：透传 `--thinking` 给每个子进程——fan-out 子代理不再跑在模型默认思考层级（CC 的 Agent fork 继承主会话 effort，pi 的独立子进程此前无法控制）。/code-review 的 effort→thinking 映射由调用方（skill 流程）决定。

### Changed

- `subagent` 工具 fan-out 默认值对齐 CC 2.1.227：并发上限默认 8 → **20**（对齐 `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS ?? 20`，`PI_MAX_CONCURRENT_SUBAGENTS` env 仍可覆盖）；默认回合预算 25 → **50**（对齐 `FORKED_AGENT_DEFAULT_MAX_TURNS`，显式 `maxTurns` 仍优先）。**BREAKING（行为）**：fan-out 并发更宽、单 agent 成本上限翻倍。
- simplify SKILL 出处注释升级为 2.1.227 符号级实证（`Dii` 模式守卫 / `ok` 深度 / `wV` 深度上限 / `Pa` allowlist 匹配 / `mi`="Agent"（别名 `oj`="Task"）/ `VBv`/`KBv` 模式体 / `$u` 命令注册 / `nJu`/`lKs` 参数默认值）；`code-simplify.ts` 的 parity 注释同步 `_Yo` → `Dii` 符号名。
- simplify 技能体逐字核对（见 change 内 `skill-verification.md`）：四角度正文、Phase 1 派发指令、SINGLE-PASS 前提段恢复 CC 2.1.227 逐字（含换行与角度间空行）；code-review SKILL 共享角度段同步修正，`angle-sync` 保持通过。
- code-review skill effort 语义区分 recall 档：high/xhigh/max 单非 REFUTED 票即保留（不得因不确定性丢弃）；medium 保持 precision。
- code-review skill xhigh/max 新增 suppression 禁令：不同 finder 对同一行不同理由的候选全部记录（record both），互不抑制。
- xhigh/max 报告上限数值化（15），gap-hunt 上限 8 个新候选。
- `review_report.ts` 的 `renderResult` 用类型谓词收窄替代 filter 后二次类型判断。
- `pi-subagent-core` 的 `mapWithConcurrencyLimit` 重复 JSDoc 注释块去重（无行为变化）。

### Fixed

- 修正 1.0.1 中「verdict/outcome 枚举对齐 CC v2.1.226 二进制实证」的错误声明（见下方勘误）；README "Status" 段同步更新。

## [1.0.1] - 2026-08-10

### Added

- `/code-simplify` 安全网（harden-code-simplify）：Phase 2 现在是 apply→verify→revert 闭环——快照受改文件、应用修复、跑 handler 从 `package.json` 探测到的验证命令（`check`/`test`/`lint`/`typecheck`，注入到 trigger 消息，可观测）；验证失败按文件粒度自动回滚（Decision B4：常态只跑 1 次验证，失败才升级到逐文件隔离），绝不留验证失败的树。复用既有 `review_report`（新增 `level: "simplify"`）上报结构化 apply-outcome（`fully/mostly/partially/not_achieved`）替代自由文本 summary。
- `subagent` 工具并发上限可配：`PI_MAX_CONCURRENT_SUBAGENTS` env（默认 8，与 CC `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` 对等）；非法值回退默认。
- `subagent` 工具默认 turn 预算：调用方省略 `maxTurns` 时应用默认 25（防止 fan-out agent 无界消耗）；显式 `0` 仍被忠实兑现。
- `review_report` 工具：CC `ReportFindings` 的 Pi 对等物。code-review skill 验证去重后调用它上报结构化 findings——渲染中文 Markdown 报告（表 + 详情）回对话，并落盘机器可读 JSON 到 `<cwd>/.pi/review/` 供 CI / `--fix` / `--comment` 消费。补上 pi-review 最大短板（无结构化输出），打开 CI 集成通路。**勘误**：本版宣称「verdict/`outcome` 枚举对齐 CC v2.1.226 二进制实证」不实——当时 shipped 的 5 档 `outcome`（`fully_achieved`…）与 3 值 `verdict`（含 `REFUTED`）并非 CC 形状；2.1.227 逆向实证 CC 实为 3 档 outcome（`fixed`/`skipped`/`no_change_needed`）与 2 值 verdict（`CONFIRMED`/`PLAUSIBLE`），2.0.0 已修正。

### Changed

- `@fyeeme/pi-subagent-core` 依赖从 `file:../pi-subagent-core` 改为 `^0.3.0`（npm registry）：修复发布阻断——`file:` 指向包根之外的相对路径，npm 发布后消费方安装解析失败（ENOENT/MODULE_NOT_FOUND）；0.3.0 提供 `isFanoutToolAllowed` 等所需导出。
- `subagent` 工具默认禁止递归（harden-code-simplify，Decision A3）：子进程默认不再注册 `subagent` 工具，除非调用方在子进程的 `tools` 白名单里显式列入（对应 `allowChildRecursion`）——递归在物理上不可能。**行为变更**（更安全，非破坏：已发布的两个命令都不需要嵌套 fan-out）。需要多级 fan-out 时设 `PI_SUBAGENT_MAX_SPAWN_DEPTH` 解锁并设上限。
- `review_report` 的 `level` 枚举新增 `simplify`（simplify 复用该工具上报 apply-outcome，不携带 verdict）。
- code-review skill 的 `max` 档语义注明：与 `xhigh` 的 fan-out/verify/sweep 结构完全相同，差别仅在模型 reasoning effort（CC v2.1.226 注释实证 `max → same structure as xhigh (the API reasoning effort differs, not the fan-out)`）；运行时不支持调节 reasoning effort 时 max 在结构上退化为 xhigh。
- `review_report` 工具声明 `renderResult`，对话内报告改走 pi 的 `Markdown` 渲染器（带边框、宽度自适应的汇总表），不再被工具结果的纯文本回退当作裸 `|`/`|---|` 硬换行。结构化 JSON 落盘（`<cwd>/.pi/review/`）不变；仅影响交互 TUI 渲染，`pi -p` 不变。新增 `@earendil-works/pi-tui` peer 依赖。
- 抽取共享 dispatch 核心到新包 `@fyeeme/pi-subagent-core`：删除本地 `src/agent/dispatch.ts`（`spawnAgent`/`mapWithConcurrencyLimit`/`createSpawnRegistry`/`abortAgent`/`getPiInvocation` + 类型），`subagent` 工具改从共享包导入。行为不变（`abortSubagent` 语义、maxTurns/转录均保持），dispatch 成为单一真相源（与 `pi-dynamic-workflows` 共用）。新增 `@fyeeme/pi-subagent-core` 依赖（`^0.1.0`，从 npm registry 解析）。

### Fixed

- `subagent` 工具 `parallelism` 整数防御（review）：小数/非正值经 `Math.floor(Math.max(1, …))` 收敛——此前 `parallelism: 3.5` 直达 `mapWithConcurrencyLimit` 抛 `RangeError: Invalid array length`；schema 描述注明 integer ≥ 1。`maxTurns` 描述修正（不再声称「Omit for unlimited」——默认预算 25，显式 `0` 为首条消息后 abort）。
- `review_report` 表头 `target` 反引号转义（target 含反引号会提前闭合 inline code 撑破表头）；verdict 注释弱化「mirror CC verbatim / binary-verified」为「follow the CC shape」，并注明 REFUTED 在 skill 流程中被 drop、罕见上报。
- `/code-simplify` 快照/回滚补齐（review M4 残留）：Step 1 快照改为 `mkdir -p /tmp/pi-simplify-baseline/$(dirname <file>)` 再 `cp`——子目录文件（如 `src/a.ts`）不再因目标父目录缺失而 ENOENT；Step 3a 回滚新增「删除修复新建的文件」步骤（新建文件无基线条目，此前会残留）。

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
