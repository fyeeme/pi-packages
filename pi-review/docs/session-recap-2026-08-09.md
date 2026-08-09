# pi-review 扩展修复记录：review_report 渲染 + 发布阻断依赖

> 覆盖 2026-08-09 会话。一次对 pi-review 变动的 xhigh code-review 衍生出两个独立问题，分别走完「诊断 → 选型 → 修复 → 验证」。本文抓住主线逻辑与修复方案，供后续接手或回顾。

---

## 0. 主线

```
code-review (xhigh) 审 pi-review 变动
        │
        ├─ 问题 A（UX）：review_report 的 Markdown 表格在终端渲染成裸 │/│---│
        │       └─ 深挖根因 → 选型 A/C1/C2 → C2 → OpenSpec change → 实现 → 验证
        │
        └─ 问题 B（发布阻断）：@fyeeme/pi-subagent-core 用 file:../ 做 dependency
                └─ 1.0.1 发到 npm 会让所有消费方安装失败 → 最终 ^0.3.0（0.1.0 缺导出 / 0.2.0 缺 onUpdate，见 §2.3）

（附带）grill-with-docs 命令失败 → matt skills 软链缺失 → 补 13 个软链
```

两个主问题都集中在 **`packages/extensions/pi-review`**，互不依赖，可独立理解。

---

## 1. 问题 A：review_report 渲染崩坏 → 方案 C2

### 1.1 现象
`review_report` 工具返回 GFM Markdown 报告（汇总表 + 详情块），但在 pi 交互终端里渲染成裸的 `|`、`|---|` 字符按宽度硬换行——无边框、列错位、长中文无空格单元格把表格彻底撕碎。

### 1.2 根因（关键）
pi 对**工具结果文本**和**助手文本**走两条不同的渲染路径：

```
助手文本    → assistant-message.ts:111  new Markdown(...)  → renderTable 画 ┌─┬─┐ ✓
工具结果    → tool-execution.ts:144     new Text(...)       → 纯文本，不解析 ✗
             （render-utils.ts getTextOutput 只 stripAnsi + join，不进 Markdown）
```

`review_report` 是**没声明 `renderResult` 的扩展工具**，命中纯 `Text` 兜底 → Markdown 表格语法从不被解析。pi 其实有完整的宽度感知表格渲染器（`renderTable`），但它只对助手文本生效。**工具产出了对的 Markdown 内容，却缺一个渲染器声明。**

### 1.3 方案选型

| 方案 | 做法 | 裁决 | 理由 |
|------|------|------|------|
| **A** 工具内自渲染 box 表 | execute() 里预算列宽画 `┌─┬─┐` | ✗ | execute() 跑在渲染前，**不知道终端宽**，预格式化必然在真实宽度下破版——和布局系统对着干 |
| **C1** 全局翻转 Text→Markdown | 改 tool-execution.ts:144 | ✗ | 砸到 bash/read/grep 的**原始文本**（shell `#`、`ls` 的 `|`、grep 命中行会被误解析） |
| **C2** 每工具 renderResult→Markdown（采用） | review_report 声明 renderResult 返回 `new Markdown(...)` | ✅ | 宽度正确 + 零波及 + 只用公开 API |

**决定性论点**：只有组件层（renderResult 返回的 Component）在 TUI 布局时拿到**真实宽度** `render(width)`，并能在 resize 时重排。execute() 无法做到。→ C2 是唯一既宽度正确又零波及的选项。

### 1.4 实现（单文件改动）
`packages/extensions/pi-review/src/tools/review_report.ts`：
- 加导入：`getMarkdownTheme`（from `@earendil-works/pi-coding-agent`，公开导出，注释明写 "for custom tools and extensions"）、`Markdown`（from `@earendil-works/pi-tui`）。
- tool def 加 `renderResult(result,_o,_t,_c)`：从 `result.content` 取文本块 → `return new Markdown(text, 0, 0, getMarkdownTheme())`。
- `execute()` 字节级未动 → 结构化 JSON 落盘（`.pi/review/<id>.json`）完全不变。
- `renderShell` 保持默认 `"default"` → pi 的工具边框（⏺ review_report + 成功/失败底色）保留。

配套：`package.json` 加 `@earendil-works/pi-tui` peer/dev 依赖（与兄弟扩展一致）；CHANGELOG `[Unreleased] ### Changed`。

### 1.5 验证
- `tsc --noEmit` 干净，`renderResult` 对上公开 `ToolDefinition` 形状，无 `any`。
- `review_report.test.ts` 4/4 通过（execute 未动）。
- **机制验证**：用 pi 真实的 `Markdown` 组件喂代表性报告输出——产出带 `┌─┬─┐` 边框的对齐表；宽 90 vs 60 列宽自适应、单元格列内换行、边框不破。
- 非回归：execute 未动（JSON 不变）、tool-execution.ts 与其他工具未动（零波及）、`renderResult` 仅存于 `modes/interactive/`（`pi -p` 不受影响）、`tool-execution.ts:305` try/catch 兜底（renderResult 抛错退回纯 Text）。

> 结构化产物见 OpenSpec change `review-report-markdown-render`（proposal/specs/design/tasks，已 14/14 完成、校验通过）。

---

## 2. 问题 B：依赖发布阻断（file: → ^0.1.0）

### 2.1 现象与根因
`@fyeeme/pi-review`（npm 已有 1.0.0）与 `@fyeeme/pi-subagent-core`（npm 已有 0.1.0）**都是正式发布的包**，但 pi-review 的 `package.json` 用 `"@fyeeme/pi-subagent-core": "file:../pi-subagent-core"`。
- `npm pack` 不把指向包根之外（`..`）的 `file:` 依赖打进 tarball，字符串原样上架。
- 消费方 `npm install @fyeeme/pi-review@1.0.1` → npm 按 `file:` 解析到不存在的 `node_modules/@fyeeme/pi-review/../pi-subagent-core` → ENOENT/依赖解析失败；即便继续，运行期 `import "@fyeeme/pi-subagent-core"` → `MODULE_NOT_FOUND` → subagent 工具、/code-review、review_report 全失效。
- **这是发布阻断级问题**：1.0.1 按现状推送即坏。

### 2.2 修复
`"file:../pi-subagent-core"` → `"^0.1.0"`（pi-subagent-core 已发布 0.1.0，从 registry 解析）。
- 同步改 `pi-review/CHANGELOG.md` 与 `pi-dynamic-workflows/{package.json,CHANGELOG.md}`（后者依赖同款问题，package.json 已被他处改成 ^0.1.0，CHANGELOG 由本会话补齐）。
- **权衡（已确认接受）**：本地 dev 原先靠 `node_modules/@fyeeme/pi-subagent-core` 指向兄弟包的 symlink 实时反映改动；改 ^0.1.0 后，下次 `npm install` 会用 registry 的 0.1.0 覆盖该 symlink，与兄弟包本地改动的实时链接丢失（除非手动维持软链或升 core 版本）。`file:` 仅适合永不发布的仓库内部联调。

### 2.3 后续修订（2026-08-09 晚）：最终 ^0.3.0
`^0.1.0` 与 `^0.2.0` 均不能满足最终消费方代码：
- **0.1.0 缺导出**：两包顶层导入的 `isFanoutToolAllowed`/`parsePositiveInt` 是 core 0.2.0 才加入（递归护栏，Decision A3）。
- **0.2.0 缺 `onUpdate`**：C3 流式桥接（`stage-executor.ts` 的 `AgentSpawnOptions.onUpdate`）是 0.3.0 特性；切 `^0.2.0` 实测 typecheck 报 5 处 `onUpdate does not exist`。
- **最终**：发布 core **0.3.0**（含 allSettled 收拢 + onUpdate），`pi-review` 与 `pi-dynamic-workflows` 依赖统一 `^0.3.0`（npm registry），README/CHANGELOG 同步。实测：两包 typecheck + 全量测试通过（core 29 / dw 179 / review 45）。

---

## 3. 附带：grill-with-docs 命令失败

- 现象：`/grill-with-docs` 报 ENOENT，找不到 `~/.pi/agent/skills/grill-with-docs/SKILL.md`。
- 根因：matt skills 实际在 `~/.claude/skills/`，但 pi 的 mattpocock-skills 扩展从 `~/.pi/agent/skills/` 读（README 称 "path A"），**13 个 skill 一个都没软链过去**（只有 `herdr` 在）→ 13 个短命令全坏，不只这一个。
- 修复：`ln -s ~/.claude/skills/<name> ~/.pi/agent/skills/<name>` 补齐全部 13 个。handler 在调用时 readFileSync，**无需重启 pi**。
- 遗留：没有任何机制自动做这个软链（`/setup-matt-pocock-skills` 命令本身也会因同样原因失败——鸡生蛋）。可考虑让该命令或扩展 install hook 执行软链。

---

## 4. 当前状态

| 项 | 状态 |
|----|------|
| review_report 渲染（C2） | ✅ 实现完成 + 验证；OpenSpec change `review-report-markdown-render` 14/14、`all_done`、校验通过，可 `/opsx-archive` |
| 依赖 file: → ^0.3.0 | ✅ 发布 core 0.3.0（0.1.0 缺导出 / 0.2.0 缺 onUpdate），两包 package.json + CHANGELOG + README 已同步（见 §2.3） |
| grill-with-docs 软链 | ✅ 13 个软链补齐 |
| code-review 其余 3 条发现 | ⏳ 未处理（见下） |

## 5. 遗留 follow-ups

1. **单元格注入**（review finding #2/#4）：summary/category/verdict 含 `|` 或换行会撑破（解析层）表格；header 的 target 含反引号会闭合 inline code。属内容转义问题，与渲染路径正交，design.md 已明确排除在本变更外，建议另开。
2. **空 catch{} 吞落盘错误**（finding #3）：review_report.ts:177 + code-review.ts 的 writeLastEffort 同款；建议补 stderr 留痕。
3. **JSON 大小写不一致**（finding #5）：落盘 JSON 顶层 camelCase（filesChanged/fannedOut）与入参 schema snake_case（files_changed）及嵌套 failure_scenario 不一致；无现存消费方，固化契约前统一一种风格。
4. **C2 平台级原语**（design.md 记录）：`renderResultAs: "markdown"` 声明式 flag（α）或 content 块 subtype（β）可让扩展免于自管 Markdown 导入；属 pi 平台决策，另开。
5. **grill-with-docs 自愈**：让 `/setup-matt-pocock-skills` 或扩展 install hook 自动建软链。

## 6. 两个仓库的提交提醒
pi-mono 主仓与 `packages/extensions` 是**两个独立 git 仓库**（extensions 是 submodule）。本会话改动跨两者：
- extensions 子模块：`pi-review/{src/tools/review_report.ts, package.json, CHANGELOG.md}`、`pi-dynamic-workflows/CHANGELOG.md`
- 主仓：`openspec/changes/review-report-markdown-render/`（4 个 artifact）
提交是两次独立操作，按需进行（未获明确许可不自动提交）。
