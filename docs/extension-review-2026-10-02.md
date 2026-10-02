# packages/extensions 13 包深度评审（2026-10-02）

范围：全部 13 个扩展包。阶段 1（逐包通读源码/测试/README/CHANGELOG）→ 阶段 2（对标差距）→ 阶段 3（瘦身清理，已执行，13 个独立提交，1422 测试全绿）→ 阶段 4（按价值立项，待确认）。

依赖拓扑：`pi-subagents`（核心，无依赖）← `pi-review` / `pi-dynamic-workflows`（npm 精确锁 2.1.3）；`pi-todo` →(`todo_updated` 事件 + `todo-phases` 会话条目)→ `pi-goal`；其余 8 包完全独立（grep 验证零交叉引用）。

---

## 一、每包评审摘要 + 对标差距

### 1. pi-subagents @2.1.3（4373 src LOC / 3773 test）

**职责**：通用子代理 fan-out 引擎——`subagent` 工具（single/parallel ≤16）、三源 agent 发现（project>user>bundled，frontmatter md）、共享 dispatch 核心（spawnAgent 子进程派发、看门狗、SIGTERM→SIGKILL、maxTurns）、below-editor 实时 fleet UI；作为库被两个下游经 npm 组合。
**对外 API**：subagent 工具（outputSchema/structuredContent envelope）；库导出 dispatch 原语 + monitor + addAgentDir + isFanoutToolAllowed（下游实际消费面已 grep 验证）；无命令、无事件。
**内部结构**：index(barrel+工厂+globalThis 收敛) / agents(三源发现) / dispatch(971 行核心) / concurrency(设置) / monitor(可观测单例) / text(结果契约) / tools/subagent(1208 行工具全量) / ui(fleet-list+viewer+shared)。
**已知问题**：headless 下 project agents 无 gate 直接加载（README pitfall #5，安全）；stallMs:0 无法禁用、wallClock<2×stall 静默忽略（pitfall #1/2）；信任门先于参数校验弹窗（自查）；monitor/subagent 注释陈旧。
**测试**：183 例，dispatch 原语/工具 wire/生命周期/设置/parity 全覆盖；conversation-viewer 无独立测试。
**对标差距**（vs Claude Code Task/subagents、opencode agents）：
- 复杂度：高于 CC——多出 watchdog、artifact 落盘、stderr 保留、<result> 契约、schema strict/permissive；这是可靠性卖点而非负担。
- API 设计：agent frontmatter 同构 CC；独有 outputSchema 强校验 + transient/hard 失败分组重放契约（CC/opencode 无）。
- 功能：递归防护用 env 三元组 + 物理不注册工具，强于 CC 的策略检查；fleet UI 信息密度高于 CC 后台任务行。
- 测试：parity-conformance 套件与 pi 仓参考 example 逐项锁死，超出同类。

### 2. pi-review @2.1.2（1501 src / 1494 test）

**职责**：`/code-review`（五档 effort，xhigh/max 子代理 fan-out）+ `/code-simplify`（四角度清理）+ `review_report` 工具（中文 Markdown 报告 + CI 可消费 JSON）。三明治架构：skills(方法论)+prompts(策略数据)+agents(12 角色)+薄插件入口。
**对外 API**：2 命令、1 工具、组合继承 subagent 工具/fleet UI；无自定义事件。
**内部结构**：dispatch(命令层+effort 粘滞) / diff(四级候选梯子+可复现命令) / loop(--loop 修复循环) / strategy(声明式 guard) / config / skills / tools/review_report。
**已知问题**：JSON 大小写混排（camelCase 顶层 vs snake_case 入参，session-recap §5.3 遗留）；writeLastEffort 静默吞错；命令 handler/loop 驱动器无测试。
**测试**：111 例，diff 梯子/strategy/模板资产锚定/angle 双向同步/review_report 双出口一致性全覆盖。
**对标差距**（vs CC 官方 code-review skill、Review Coder、codex review）：
- 功能：即 CC /review 的显式逆向移植（SKILL 头注逐版本二进制实证）；超出 CC：report_id 归并再上报、fanned_out 诚实字段、--loop 结构化 blocking 决策（CC 无对等物）。
- 设计：parallel-when 阈值声明在 frontmatter（策略即数据，CC 是硬编码）；(file,line) 分组 verifier 比 CC 每候选一 verifier 减约 40%。
- 测试：angle-sync 双向锚定把"评审角度"物化为可漂移检测资产，同类罕见。

### 3. pi-dynamic-workflows @2.0.3（3701 src / 2789 test）

**职责**：确定性多 agent 工作流编排——10 种声明式 typed steps、journal 内容寻址缓存恢复、预算池（reserve 原子性 + 硬上限）、逐 agent 中止、AST 确定性守卫、classifier 双路径。
**对外 API**：run_workflow 工具（inline JSON 子集 / library 命名加载）+ 库导出（runWorkflow/loadWorkflowModule/collect 族/sessions-spawn barrel）；组合继承 pi-subagents。
**已知问题**：retryAgent 无自动重派接线（README 已声明）；ast-guard 单文件边界（import 的 helper 不扫）；journal 追加 best-effort；inline 模式 budget 静默忽略；README 测试数过时（已修）。
**测试**：194 例，全量假派发零 token 测试（独有卖点）；library 分支的工具路径无测试。
**对标差距**（vs Temporal/Inngest、GitHub Actions、CC workflow 引擎）：
- 定位：单机进程内轻量方案（JSONL=状态存储），无 durable timer/服务端/重跑按钮；CC workflow 引擎是其明确移植源（代码注释逐处引用）。
- 独有：dispatch 可注入使全部编排语义零 token 全量测试；wf4 前缀 bump 纪律。
- 功能缺口：StepRetry 不支持上游阶段重跑（类型已预留注释）。

### 4. pi-goal @1.0.5（3121 src / 3203 test）

**职责**：omp goal mode 行为级移植 + CC 2.1.261 评估器偏差——单活目标状态机、token/墙钟预算记账（cacheWrite 计入/cacheRead 排除）、一次性 budget-limit 转向、continuation turns、独立评估器子进程门禁 complete/impossible、/goal + /guided-goal、goal_updated 事件。
**已知问题**：goal-budget-limit 残留无 activeGoalId 门控（目标结束后最后一条 steer 留在模型视图）；README 漂移（已修）；goal_updated 事件零消费者（集成面待用）。
**测试**：160 例，omp-alignment 48 例逐字钉移植文案。
**对标差距**（vs omp、CC 计划-执行、agentic milestone）：
- 评估器 grounded（子进程实跑仓库复核）严格于 CC（仅读 transcript）；impossible 争议通道（cap=2 交人裁决）是独有安全阀。
- budget 记账口径（cacheWrite 计入）与 omp 对齐，细于同类。

### 5. pi-todo @1.0.3（1715 src / 1517 test）

**职责**：omp todo 工具移植——九操作、phase/task 两级、五状态、"认知中性行事本"立场（omp 全部行为引导已删：无 nag、无自动推进）。
**对外 API**：todo 工具（prepareArguments 修复缺 op）、/todo 全动词集、todo_updated 事件 + todo-phases 会话条目（与 pi-goal 契约双向测试锚定）。
**已知问题**：block 无 reason 抹旧 note（意图未文档化）；类型 Omit 撒谎（已修）。
**测试**：105 例，契约（emit 时机/branch 恢复）+ 认知中性反向钉。
**对标差距**（vs CC TodoWrite+plan mode、omp）：
- 功能超出 CC：两级结构、五状态、branch 感知恢复、markdown 往返、事件桥。
- 方向差异：CC 靠系统提示引导用 TodoWrite；本包把引导外包给 pi-goal，自身中立。

### 6. pi-ask-user @2.0.4（2663 src / 1201 test）

**职责**：omp ask 工具源码级移植——tabbed 多题对话框（Submit 审查页、markdown/代码预览分栏、IME 编辑器、空闲倒计时），RPC 降级逐题 select/editor，无 UI 剥除工具。
**已知问题**：raceWithSignal/untilAborted 双实现（语义重复）；OTHER_OPTION 等双源真相；externalCancel/invalidate 无测试。
**测试**：59 例，三层宿主降级链 + IME/字素编辑器全覆盖。
**对标差距**（vs CC AskUserQuestion【官方：1-4 题、每题 2-4 选项、无 recommended/timeout/notes】、opencode ask、omp）：
- 功能全面超出 CC：6 题×6 选项、multi、recommended+超时自动选、Other 自由文本、审查页。
- 语义分歧：取消即中止回合（omp 忠实）vs CC 返回 'user canceled'；Other 治理策略与 CC 相反（UI 注入+禁模型自带 vs CC 明令模型勿加）。

### 7. pi-ask-user-lite @2.0.4（1012 src / 687 test）

**职责**：ask_user 工具的 pi 原生重实现（非移植）——单对话框逐题 + 复审页、per-answer 笔记、Chat 重定向、整体超时预算、/ask-demo。
**已知问题**：超时丢编辑草稿（pi-ask-user 已修同问题）；RPC 无笔记未声明；multi+recommended 展示层不标但行为层依赖。
**测试**：36 例，契约级 fake 按键流。
**对标差距**：存在价值成立——取消不中断回合（LLM 收保守指示）、笔记/chat 重定向为三者独有、单文件维护成本低。与 full 版 schema ~90% 相同但零代码共享是有意分工（README 互斥警告）。

### 8. pi-hooks @1.0.7（633 src / 510 test）

**职责**：CC 兼容 hooks 运行器——hook.json 四级优先级链，SessionStart/PreToolUse/Stop → pi 事件映射，stdin CC JSON，deny 阻塞，防御完整（进程组击杀/10MB 上限/Esc）。
**已知问题**：permission_mode 硬编码 "default"（serena auto-approve 失效）；裸 exit 2 放行（防误配置取舍）；Stop 带 matcher 静默失效。
**测试**：36 例，matcher CC 语义对标 + 四级链全分支。
**对标差距**（vs CC hooks 官方【9+ 事件】、opencode hooks）：
- **功能缺口（本仓可证）**：CC 9 事件 vs 本包 3 个。peon-ping 包已证明宿主事件存在：tool_result→PostToolUse、before_agent_start→UserPromptSubmit、session_before_compact→PreCompact、session_shutdown→SessionEnd——缺口不是宿主限制，是未接线。PostToolUse（格式化器）是 CC 最常用 hook 之一。
- 已覆盖部分语义匹配度高（matcher 正则、stdin 字段、60s 默认超时、并行执行）。

### 9. pi-mermaid-viewer @1.0.2（749 src / 1005 test）

**职责**：/mermaid 命令——抽取会话 mermaid 块，生成自包含 HTML（CDN mermaid@11）开浏览器；try-first 裸标签修复器。
**已知问题**：主题检测仅 macOS；CDN 版本浮动；tmp 文件不清理；script 标签逃逸（低概率）；Windows start 疑似缺陷。
**测试**：111 例，healer 全形状 + toString 注入不变量（node --check + eval 等价）。
**对标差距**（vs GitHub/IDE 内置、mmdc、同类 CC 扩展）：差异化在工程细节（修复器/注入测试锁死）；短板：非 macOS 主题、CDN 不锁版本。

### 10. pi-peon-ping @1.1.4（434 src / 851 test）

**职责**：peon.sh 薄路由——7 个 pi 事件 → peon hook_event_name，客户端分类抑制（spawn 前拦截），tab 标题，best-effort 全程静默。
**已知问题**：README 事件表漂移（已修）；brew 模板恒 false 浪费 stat；命令 handler 无测试。
**测试**：69 例，发现层/payload/分类抑制/延迟发现语义全覆盖。
**对标差距**（vs CC Stop-hook 通知、ccnotify/ntfy）：复用 peon 生态（160+ 音效/多通道推送）零成本；ui_prompt_start 比 CC Notification 覆盖面广；spawn 前抑制省一次进程创建，优于 CC 先 exec 再静音。

### 11. pi-session-name @1.0.6（566 src / 671 test）

**职责**：agent_settled 后 LLM 生成短标题——三模式（follow/first/auto+分类器）、三层手动命名保护、创建时间前缀、确定性 fallback。
**已知问题**：README 漂移（已修）；导出面 20+ 但 README 宣传 7（npm 外部消费者未知）。
**测试**：70 例，归一化/防欺骗/三模式全分支。
**对标差距**（vs deepseek-harness 上游、CC 一次性小模型命名、cc-seq）：follow/auto 逐轮追踪激进于 CC；创建时间前缀对冲 resume 列表排序缺陷是独有。

### 12. pi-statusline @1.2.7（1255 src / 1985 test）

**职责**：footer 替换——cwd/分支、token/成本（DeepSeek 峰谷 CNY 计价 + 注册表补丁）、上下文占用、耗时 tok/s；DeepSeek 余额/ZAI 5h+周配额轮询。
**已知问题**：footer `7d:` 标签 vs 自然周实现不符；index.ts 事件接线零测试；scanner 按文件名日期漏计跨周会话。
**测试**：127 例，峰谷边界精确到分钟、全假 fetch。
**对标差距**（vs ccstatusline、CCometixLine、ccusage --statusline）：
- 独有：进程内扩展（无 stdin JSON IPC）、注册表定价补丁使显示成本=宿主记录成本、ZAI 配额 API 真值口径。
- 短板：段布局/provider 硬编码（牺牲可配置性换开箱即用）；scanner 全量 readFileSync 弱于 CCometixLine 流式 tail（1min TTL 缓解，本地会话量下无可度量收益）。

### 13. pi-thinking-ui @1.1.3（1822 src / 598 test）

**职责**：思考块三模式可视化——registerMarkdownTransformer 接管渲染，纯启发式（IDF+MMR 抽取摘要 + 事件分类 challenger + 13 条仲裁），三层持久化。
**已知问题**：渲染模式进程级全局（多 session 宿主错渲染，作者自知）；challenger 仲裁过拟合自研语料（硬编码回归样例短语）；命令解析/仲裁规则无测试。
**测试**：61 例，模式/缓存/持久化/scope 隔离。
**对标差距**（vs CC 原生 thinking【折叠+时长，无内容摘要】、opencode【token/时长】）：摘要质量最激进（生态内唯一内容级摘要）；代价是 1175 行启发式引擎与过拟合风险。

---

## 二、阶段 3 已执行变更（13 提交，全绿）

| 包 | 提交 | 内容 |
|---|---|---|
| pi-subagents | 5bb310b | dispatch.ts 死转发块（pi-subagent-core 遗留）、subagent.ts 死导入 |
| pi-review | e5769b7 | 4 个死导出；BLOCKING_PRIORITIES 去双源；README 版本漂移 |
| pi-dynamic-workflows | 0658032 | getPiInvocation/AbortReason 等 5 个死重导出；重复 AgentAbortMap；executeStep 等去 export；README 测试数 |
| pi-ask-user | 463782f | matchesKey/Key 死再导出等 4 项；幽灵 note 字段；重复头注释 |
| pi-ask-user-lite | bc37f25 | 2 个测试孤儿导出；不可达 ?? "" |
| pi-goal | bc873ca | 死事件变体/死类型/死方法；README 与 description 漂移 |
| pi-hooks | 45751d9 | 2 处陈旧注释（matcher 语义） |
| pi-mermaid-viewer | 975123d | 2x→3x 文档/测试名漂移 |
| pi-peon-ping | ff9284b | README 事件表同步代码；孤立注释头；头注释事件名 |
| pi-session-name | 194dcf4 | README 三处漂移；测试标题路径 |
| pi-statusline | 2b931ff | getUsageCache 等 3 个死导出；重复测试 describe；7d 语义文档 |
| pi-thinking-ui | 7632733 | README 默认值/monkeypatch 描述漂移 |
| pi-todo | 8d92212 | formatMoreItems 导出；TodoRenderArgsPublic 类型撒谎修正；2 处注释/测试名 |

红线遵守：无功能删除、无对外行为改变（唯一行为面变化是 pi-todo 类型修正使类型与实现一致）；每包独立提交；每包 tsc + vitest 全绿（终态：13 包 1422 测试）。

---

## 三、重构决策表（阶段 4 立项）

### 建议做（需确认后执行，每项先出设计）

| # | 立项 | 包 | 价值门槛证据 | 预期收益 | 工作量 |
|---|---|---|---|---|---|
| A | CC 兼容事件面扩展：PostToolUse/UserPromptSubmit/PreCompact/SessionEnd 接线 + permission_mode 修复 | pi-hooks | 功能缺口：CC 9 事件 vs 3；peon-ping 已证宿主事件存在（tool_result/session_before_compact/before_agent_start 均已他用） | CC 迁移用户零改动；PostToolUse 格式化器可用 | 中（4 事件映射 + stdin 字段 + 测试） |
| B | 超时保留编辑草稿 | pi-ask-user-lite | 功能缺口：pi-ask-user 已修同问题（README 明示），lite 丢草稿且无测试锁定 | 用户输入不丢；两包行为对齐 | 小 |
| C | 信任门顺序修正：参数校验先于弹窗 | pi-subagents | 交互缺陷：17 任务调用先 confirm 再 throw 'Too many parallel tasks'（subagent.ts:818 vs :841） | 免无效弹窗 | 小 |
| D | goal-budget-limit 残留清理 | pi-goal | 正确性：目标结束后最后一条 steer 残留模型视图（无 activeGoalId 门控） | 上下文卫生；微小 token 节约 | 小 |
| E | 移除 @deprecated heuristicallyPlan + planner.ts | pi-dynamic-workflows | 维护成本：运行时零调用、作者已标注、classify 启发产生空 routes 坑；**前提：npm 无外部消费者** | -66 LOC + 测试面收缩 | 小 |

### 不做（理由）

| 提案 | 不做理由 |
|---|---|
| ask 双包抽共享类型包 | 零代码共享是有意分工；schema 相似但语义分歧（取消/超时/笔记）正是产品差异 |
| pi-statusline widget 化配置器（对标 ccstatusline） | 大工程；开箱即用定位成立，无用户诉求证据 |
| session-scanner 流式 tail（对标 CCometixLine） | 1min TTL 已缓解；本地会话量下无可度量收益 |
| pi-mermaid-viewer CDN 锁版本/离线渲染 | 零依赖设计核心取舍；无用户诉求证据 |
| pi-subagents getMaxConcurrency 内联 | README 文档化库面（pi-subagent-core 兼容承诺） |
| pi-thinking-ui challenger 过拟合分支清理 | 思考摘要文本变化=用户可感知行为变化，无明确收益方 |
| pi-todo block 无 reason 保留旧 note | omp 原语义未明（可能是移植本意）；改行为需先定意图 |
| pi-session-name 导出面收缩 | npm 外部消费者未知；收缩是 breaking，收益近零 |
| pi-peon-ping brew 模板清理 | 恒 false 的一个 stat 调用，收益不可度量 |

---

## 四、阶段 4 立项设计（一页/项，确认后实现）

### A. pi-hooks CC 兼容事件面扩展

**问题**：CC hooks 官方 9 事件，本包只映射 3（SessionStart/PreToolUse/Stop）。CC 生态最常用的 PostToolUse（保存后格式化/lint）完全不工作；UserPromptSubmit（提示注入/拦截）与 PreCompact 亦缺。peon-ping 包已证明对应宿主事件全部存在且在实践中使用。
**方案**：加法式扩展——
1. `PostToolUse` → pi `tool_execution_end`（或 tool_result，与 peon-ping 一致）；stdin 增加 `tool_response`；支持 CC 的 `additionalContext` 与 decision `"block"`（新 tool_call 轮反馈）按现有 deny 通道降级实现。
2. `UserPromptSubmit` → `before_agent_start`；stdin 增加字段按 CC 规范。
3. `PreCompact` → `session_before_compact`；`SessionEnd` → `session_shutdown`（与 Stop 分开：一个事件双注册）。
4. `permission_mode`：从 pi 上下文（若可取）或环境推导，不再硬编码 "default"（serena auto-approve 解锁）。
**风险**：stdin 字段形状与 CC 的差异需逐字段核对；`tool_response` 体积截断策略；PostToolUse deny 的宿主语义（事后阻塞只能反馈不能撤销）需 README 明示。
**回滚**：全部为加法，旧 hook.json 行为不变；单提交 revert 即可。

### B. pi-ask-user-lite 超时保留草稿

**问题**：整体超时 settle 不区分 inputMode——用户正在 Other/笔记输入时到期，草稿消失且该题被自动选 recommended。
**方案**：借 pi-ask-user 的延迟过期模式（ask-dialog.ts:1005-1023）：到期时若 `inputMode !== null`，只置 `timeoutExpired` 标志；在编辑器 submit/exit 时补结算。补测试锁定"到期时打字中的答案被保留"。
**风险**：低；行为变化仅限超时瞬间正在输入的场景（当前行为是缺陷）。
**回滚**：单提交 revert。

### C. pi-subagents 信任门顺序

**问题**：project-agent 信任门 confirm（:807-840）先于 mode 冲突（:833）与 MAX_PARALLEL_TASKS=16 上限（:841）校验——注定失败的调用也让用户先确认。
**方案**：把参数校验（mode/任务数）提前到 confirm 之前；信任门语义不变。
**风险**：极低；错误路径顺序变化，测试已有覆盖需同步断言顺序。
**回滚**：单提交 revert。

### D. pi-goal budget-limit 残留清理

**问题**：context 处理器对 goal-budget-limit 仅"保留最新一条"，无 activeGoalId 门控（goal-continuation 有，index.ts:700-703）——目标 complete/drop 后最后一条 steer 留在模型视图。
**方案**：复用 continuation 的 details.goalId 键控模式给 budget-limit steer 补门控 + 测试（现有测试只钉 continuation 清除，index.test.ts:828-841）。
**风险**：极低。
**回滚**：单提交 revert。

### E. pi-dynamic-workflows 移除 heuristicallyPlan

**问题**：@deprecated 双重标注、运行时零调用、classify 关键词启发产生空 routes（按原样运行零路由直接完成）、README §10 与 outcomes-planner.test.ts 是仅存引用。
**方案**：删 planner.ts + barrel 导出 + 对应测试 describe + README §10；CHANGELOG Removed 条目。**前置**：确认 npm 无外部消费者（`npm view @fyeeme/pi-dynamic-workflows` 下载量/依赖方）。
**风险**：对外 API 面 breaking（minor 版本，repo 惯例允许且作者已预告）。
**回滚**：单提交 revert。
