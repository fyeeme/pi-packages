# @fyeeme/pi-dynamic-workflows

**为 [pi](https://github.com/earendil-works/pi-mono) 打造的确定性 TypeScript 工作流编排。**

把工作流定义成一份类型化的声明式步骤列表，运行后即可获得**可恢复、受预算约束、可中止**的执行。融合 pi-dynamic-workflows 设计（7 个步骤原语 + 启发式 planner + outcome 收集器）与 Claude Code 工作流引擎的协调机制（确定性沙箱、缓存键恢复、按 agent 中止、动态预算、失控上限）。

语言：[English](README.md) | **中文**

---

## 为什么需要它

一次运行 = 一份步骤列表（`agent` / `code` / `fan_out` / `loop_until` / `adversarial` / `tournament` / `classify_route`）。引擎保证：

- **确定性** —— workflow `.ts` 文件经 AST 守卫，禁止 `Date.now()` / `Math.random()` / `new Date()`；run id 是 `(timestamp, sequence)` 的纯函数。
- **恢复即不重派** —— 每个 agent 调用以 `sha256(workflow + prompt + signature)` 为键写入 journal；重跑同一 workflow 会回放缓存的 agent（零子进程派发）。
- **按 agent 中止** —— 每个在途 agent 持有自己的 `AbortController`；`skipAgent`/`retryAgent` 只针对一个调用，不打扰兄弟调用。
- **预算 + 失控上限** —— `maxAgents` / `maxTokens` 由实时池强制；`MAX_BATCH=4096`、`MAX_LIFETIME_AGENTS=1000` 超限抛 `BudgetExceededError`（绝不静默截断）。
- **无需 `pi` 即可测试** —— agent 派发可注入；测试传一个 fake dispatch，无需二进制、无需 provider API、无需 token。

---

## 安装

这是一个 pi 扩展包（workspace / 本地），尚未发布到 npm。在 pi workspace 中：

```bash
npm install --ignore-scripts   # 水合（本包是 workspace 依赖）
```

随后从包根模块导入公共 API（TypeScript barrel，包直接以 `.ts` 源码分发）：

```ts
import { defineWorkflow, runWorkflow } from "@fyeeme/pi-dynamic-workflows/src/index.ts";
```

> 包的 `pi.extensions` 入口（`./index.ts`）目前仍是脚手架——把 `run_workflow` 工具接进 pi 是后续工作。引擎本身已可经上述导入直接使用。

---

## 快速上手

```ts
import { defineWorkflow, runWorkflow } from "@fyeeme/pi-dynamic-workflows/src/index.ts";

const wf = defineWorkflow({
	name: "draft-and-refine",
	steps: [
		{ id: "draft", type: "agent", prompt: "起草一段发布说明。" },
		{ id: "refine", type: "agent", prompt: (ctx) => `把下面改写得更精炼：\n\n${ctx.step("draft").results}` },
	],
});

const result = await runWorkflow({ workflow: wf, cwd: process.cwd(), now: Date.now() });
console.log(result.status, result.steps[1].results);
```

`runWorkflow` 默认每次 agent 调用派生一个 `pi --mode json -p --no-session` 子进程（默认 dispatch），因此需要 `pi` 在 `PATH` 上并配置好 provider。测试或离线运行时注入一个 fake dispatch 即可（见教程）。

---

## 使用教程

### 1. 定义工作流

`defineWorkflow` 是一个类型化恒等助手——让你对 `steps` 判别联合获得完整类型检查。

```ts
const wf = defineWorkflow({
	name: "research",
	budget: { maxAgents: 10, maxTokens: 50_000 },
	steps: [
		{ id: "gather", type: "agent", prompt: "列出关于主题 X 的 3 个来源。" },
		{ id: "summarize", type: "agent", prompt: (ctx) => `总结：\n${ctx.step("gather").results}` },
	],
});
```

`ctx.input` 是本次运行的初始输入；`ctx.step(id)` 返回某个已执行步骤的 `{ results, stats }`（若该 id 尚未执行则抛错）。

### 2. 运行

```ts
const result = await runWorkflow({
	workflow: wf,
	cwd: process.cwd(),
	now: 1700000000000,   // 确定性起始时间（ms），同时是 journal/run-id 的种子
	input: "主题 X",
});
// result.status: "completed" | "failed" | "aborted"
// result.steps:  StepResult[]（按顺序，每个已执行步骤一条）
// result.stats:  汇总 { tokens, cost, durationMs, agents, failures }
// result.journalFile: 该 workflow 的 JSONL journal 路径
```

`now` **必填且确定性**——传入本次运行的起始时间；引擎绝不读时钟来生成身份。相同的 `(workflow, prompts)` 永远生成相同的缓存键。

### 3. fan_out —— 并行 agent + 合并

```ts
const wf = defineWorkflow({
	name: "parallel-research",
	steps: [
		{
			id: "fan",
			type: "fan_out",
			over: () => ["alpha", "beta", "gamma"],
			agent: (topic) => ({ prompt: `研究 ${topic}。` }),
			parallelism: 3,
			merge: (results) => results.join("\n---\n"),
		},
	],
});
```

`fan_out` 会先预检整批是否在预算内（`MAX_BATCH=4096`）；每个 item 独立缓存键、独立可中止。

### 4. loop_until —— 迭代到条件 / 预算

```ts
const wf = defineWorkflow({
	name: "refine-loop",
	steps: [
		{
			id: "loop",
			type: "loop_until",
			prompt: (ctx, i) => `第 ${i + 1} 稿。当前：\n${ctx.step("loop")?.results ?? ctx.input}`,
			until: (ctx, i) => i >= 3,
			maxIterations: 5,
		},
	],
});
```

每次迭代都是独立的缓存键 agent 调用；`maxIterations` 与预算共同约束循环。

### 5. 组合模式 —— adversarial / tournament / classify_route

它们构建在同一个 `dispatchAgentCall` 之上，因此天然享有缓存恢复、预算与中止。

```ts
// 生成候选，再由 N 个评判者按 rubric 打分并汇总。
defineWorkflow({
	name: "review",
	steps: [
		{
			id: "adv",
			type: "adversarial",
			produce: { prompt: "写这个函数。" },
			rubric: ["正确性", "处理空输入", "无 off-by-one"],
			judges: 3,             // 默认；minPass 默认为过半数
		},
	],
});
// results: { candidate, passed, passCount, minPass, judges: [{pass, reason}] }

// N 个不同候选，M 个评判者排名，选出多数赢家。
defineWorkflow({
	name: "pick",
	steps: [{ id: "tmt", type: "tournament", candidates: 3, judges: 2, produce: { prompt: "解决 X。" } }],
});
// results: { candidates, winner, judges: [{winner, reason}] }

// 分类输入，再运行匹配路由的子步骤。
defineWorkflow({
	name: "route",
	steps: [
		{
			id: "cr",
			type: "classify_route",
			classifier: { prompt: (ctx) => `分类意图：${ctx.input}` },
			routes: {
				bug: [{ id: "file", type: "agent", prompt: "提一个 bug 报告。" }],
				faq: [{ id: "answer", type: "agent", prompt: "回答这个 FAQ。" }],
			},
			fallback: [{ id: "escalate", type: "agent", prompt: "转给人工。" }],
		},
	],
});
// results: { category, matched, route: StepResult[], routeStatus }
```

评判/分类的 JSON 采用宽松解析（LLM 常把 `"true"`/`"0"` 当字符串返回）；路由嵌套有深度上限以防循环。

### 6. 恢复 —— 重跑零派发

journal 位于 `<cwd>/.pi/workflows/<workflow.name>/journal.jsonl`（按 workflow 而非按 run，因此**同一 workflow 重跑可跨 run 命中缓存**；run id 不计入键）：

```ts
const first  = await runWorkflow({ workflow: wf, cwd, now: T0 }); // 每个 agent 都派发
const second = await runWorkflow({ workflow: wf, cwd, now: T1 }); // 零派发——全部缓存命中
```

prompt 变了 → 该 agent 的缓存键变 → 重新派发；没变的则回放。

### 7. 按 agent 中止与跳过

runner 持有一个 `AgentSpawnRegistry`。拿到它即可针对单个在途调用：

```ts
import { createSpawnRegistry, skipAgent } from "@fyeeme/pi-dynamic-workflows/sessions/spawn.ts";

const registry = createSpawnRegistry();
const runP = runWorkflow({ workflow: fanOutWf, cwd, now, registry });
// ...等 `fan#2` 进入在途状态后：
skipAgent(registry, "fan#2");   // 只中止这一个；兄弟调用继续
const result = await runP;       // status "completed"——这批除第 2 项外都跑完了
```

`abortAgent(registry, callId)` 中止一个调用；`retryAgent(registry, callId)` 中止以便 runner 重新派发。调用 id 形如 `${step.id}#${n}`（从 1 起）。

### 8. 预算强制

```ts
const wf = defineWorkflow({
	name: "capped",
	budget: { maxAgents: 2 },
	steps: [{ id: "fan", type: "fan_out", over: () => [1, 2, 3], agent: (i) => ({ prompt: `${i}` }) }],
});
const result = await runWorkflow({ workflow: wf, cwd, now });
// result.status === "failed"，result.error 匹配 /budget|exhausted/i
```

`maxAgents` 在派发整批/单个 agent 前检查；`maxTokens` 在 agent 落定后由 `BudgetPool.isExhausted` 强制。二者都抛 `BudgetExceededError`——绝不静默截断。

### 9. Outcome 收集器

从 agent 的文本输出里抽取结构化值：

```ts
import { collect } from "@fyeeme/pi-dynamic-workflows/src/index.ts";

const urls  = collect<string[]>({ kind: "url" }, result.steps[0].results as string);
const json  = collect({ kind: "json" }, agentText);     // 第一个平衡的 JSON 值
const paths = collect<string[]>({ kind: "file_path" }, agentText);
```

`url` / `file_path` / `json` 都是文本的纯函数——可对任意 `StepResult.results` 使用。

### 10. 启发式 planner

按关键词把目标草拟成单步工作流脚手架（compare → tournament、review → adversarial、classify → classify_route，其余 → agent）。这是一个待你打磨的起点，不是真正的 NL 规划器：

```ts
import { heuristicallyPlan } from "@fyeeme/pi-dynamic-workflows/src/index.ts";

const wf = heuristicallyPlan("比较三种排序方案", { judges: 3 });
// wf.steps[0].type === "tournament"
```

### 11. 加载 `.ts` 工作流文件

```ts
import { loadWorkflowModule } from "@fyeeme/pi-dynamic-workflows/src/index.ts";

const mod = await loadWorkflowModule<{ workflow: ReturnType<typeof defineWorkflow> }>({
	filePath: "./my-workflow.ts",
});
const wf = mod.workflow;
```

loader 在 jiti 加载**之前**跑确定性 AST 守卫——workflow 体内若调用 `Date.now()` / `Math.random()` / `new Date()` 会在加载时被拒（这些会让缓存键失稳）。注意：守卫只扫描入口文件；请让 workflow 单文件，或单独守卫被引入的 helper。

### 12. 无需 `pi` 即可测试

注入一个 fake dispatch——无二进制、无 provider、无 token。本包自带的 108 个测试就是这样跑的：

```ts
import { runWorkflow, type AgentDispatch } from "@fyeeme/pi-dynamic-workflows/src/index.ts";

const fake: AgentDispatch = async (_registry, opts) => ({
	callId: opts.callId,
	exitCode: 0,
	messages: [{ role: "assistant", content: [{ type: "text", text: `out:${opts.task}` }], /* ...其余字段 */ } as never],
	stderr: "",
	usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 15, turns: 1 },
	model: "fake",
	stopReason: "stop",
	aborted: false,
});

const result = await runWorkflow({ workflow: wf, cwd: tempDir, now: 1000, dispatch: fake });
```

---

## 步骤类型速查

| type | payload 要点 | 结果 |
|---|---|---|
| `agent` | `prompt: string \| (ctx)=>string`、`model?`、`tools?`、`systemPrompt?` | 最后一条 assistant 文本 |
| `code` | `transform: (ctx) => unknown`（纯函数、不派发、不缓存） | transform 的返回值 |
| `fan_out` | `over()`、`agent(item,i)`、`parallelism?`、`merge?` | 合并后的数组（或 `merge` 的输出） |
| `loop_until` | `prompt(ctx,i)`、`until(ctx,i)`、`maxIterations?` | 每轮输出的数组 |
| `adversarial` | `produce`、`rubric[]`、`judges?`、`minPass?` | `{ candidate, passed, passCount, judges }` |
| `tournament` | `candidates`、`judges`、`produce` | `{ candidates, winner, judges }` |
| `classify_route` | `classifier`、`routes: Record<cat, Step[]>`、`fallback?` | `{ category, matched, route, routeStatus }` |

每个步骤都接受 `id`、`retry?: { maxRetries }`。

---

## API 参考

### `runWorkflow(opts)` → `Promise<RunResult>`

| 选项 | | |
|---|---|---|
| `workflow` | `WorkflowDefinition` | 必填 |
| `cwd` | `string` | 必填（journal 基目录） |
| `now` | `number` | 必填——确定性起始 ms |
| `input?` | `unknown` | `ctx.input` |
| `budget?` | `Budget` | 覆盖 `workflow.budget` |
| `signal?` | `AbortSignal` | 整运行中止信号 |
| `listeners?` | `AgentLifecycleListeners` | `onAgentStart/End/Skip/Retry` |
| `dispatch?` | `AgentDispatch` | 默认 = 真实 `spawnAgent` |
| `registry?` | `AgentSpawnRegistry` | 供外部 `skipAgent`/`abortAgent` |
| `journalDir?` | `string` | 默认 `<cwd>/.pi/workflows/<name>` |
| `sequence?` | `number` | run-id 消歧 |

`RunResult = { runId, status, steps: StepResult[], stats: StepStats, journalFile?, error? }`。

### 同时导出
`defineWorkflow`、`loadWorkflowModule`、`collect`（含 `urlCollector`/`filePathCollector`/`jsonCollector`/`parseFirstJson`）、`heuristicallyPlan`、`createSpawnRegistry`/`abortAgent`/`skipAgent`/`retryAgent`（来自 `sessions/spawn.ts`），以及全部步骤/结果/上下文类型。

---

## 设计 —— Claude Code 融合

| 机制 | 模块 | 作用 |
|---|---|---|
| 确定性沙箱 | `src/determinism/ast-guard.ts` | AST 级禁止 workflow 源码中的非确定性 API |
| 确定性 run id | `src/state/names.ts` | `generateRunId({timestamp, sequence})` 为纯函数 |
| 缓存键恢复 | `src/cache/{key,journal}.ts` | `sha256(workflow+prompt+signature)` + 每运行 JSONL journal |
| 按 agent 中止 | `sessions/spawn.ts` | `Map<callId, ChildProcess>` + 每调用 `AbortController`；中止 → 对单个进程 SIGTERM |
| 预算 + 上限 | `src/budget/{pool,caps}.ts` | 实时 `BudgetPool` + `MAX_BATCH`/`MAX_LIFETIME_AGENTS` |

三处范式冲突（CC 命令式 ↔ 声明式图）已化解：预算循环变成 fan_out 读取的预检值；进程内 AbortController 变成子进程表；vm 沙箱变成对 jiti 加载源码的加载期 AST 守卫。

---

## 测试

```bash
node_modules/.bin/tsc -p packages/extensions/pi-dynamic-workflows/tsconfig.json --noEmit   # 类型检查
node_modules/.bin/vitest --run packages/extensions/pi-dynamic-workflows                    # 108 个测试
```

真实 `pi` 子进程冒烟（默认 dispatch）位于 `examples/smoke-real-pi.ts`——在 `pi` 与 provider 配置妥当后手动运行。

License：MIT。
