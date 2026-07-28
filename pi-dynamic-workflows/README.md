# @fyeeme/pi-dynamic-workflows

**Deterministic TypeScript workflow orchestration for [pi](https://github.com/earendil-works/pi-mono).**

Define a workflow as a declarative list of typed steps, run it, and get resumable, budget-bounded, abortable execution. Fuses the pi-dynamic-workflows design (7 step primitives + heuristic planner + outcome collectors) with Claude Code's workflow-engine coordination mechanisms (deterministic sandbox, cache-key resume, per-agent abort, dynamic budget, runaway caps).

Languages: **English** | [中文](README.zh-CN.md)

---

## Why

A workflow run is a list of steps (`agent` / `code` / `fan_out` / `loop_until` / `adversarial` / `tournament` / `classify_route`). The engine guarantees:

- **Determinism** — workflow `.ts` files are AST-guarded against `Date.now()` / `Math.random()` / `new Date()`; run ids are a pure function of `(timestamp, sequence)`.
- **Resume without re-dispatch** — every agent call is keyed by `sha256(workflow + prompt + signature)` and journaled; re-running the same workflow replays cached agents (zero subprocess spawns).
- **Per-agent abort** — each in-flight agent owns an `AbortController`; `skipAgent`/`retryAgent` targets one call without disturbing siblings.
- **Budget + runaway caps** — `maxAgents` / `maxTokens` enforced via a live pool; `MAX_BATCH=4096`, `MAX_LIFETIME_AGENTS=1000` throw `BudgetExceededError` on exceed (no silent truncation).
- **Testable without `pi`** — the agent dispatch is injectable; tests pass a fake and run with no binary, no provider API, no tokens.

---

## Install

This is a pi extension package (workspace / local), not yet published to npm. From a pi workspace:

```bash
npm install --ignore-scripts   # hydrate (the package is a workspace dep)
```

Then import the public API from the package root module (a TypeScript barrel; the package ships `.ts` source):

```ts
import { defineWorkflow, runWorkflow } from "@fyeeme/pi-dynamic-workflows/src/index.ts";
```

> The package's `pi.extensions` entry (`./index.ts`) is currently scaffolding — wiring the `run_workflow` tool into pi is forthcoming. The engine itself is fully usable via the imports shown here.

---

## Quick start

```ts
import { defineWorkflow, runWorkflow } from "@fyeeme/pi-dynamic-workflows/src/index.ts";

const wf = defineWorkflow({
	name: "draft-and-refine",
	steps: [
		{ id: "draft", type: "agent", prompt: "Draft a one-paragraph release note." },
		{ id: "refine", type: "agent", prompt: (ctx) => `Refine this into crisp prose:\n\n${ctx.step("draft").results}` },
	],
});

const result = await runWorkflow({ workflow: wf, cwd: process.cwd(), now: Date.now() });
console.log(result.status, result.steps[1].results);
```

`runWorkflow` spawns one `pi --mode json -p --no-session` subprocess per agent call (the default dispatch), so you need `pi` on `PATH` with a configured provider. For tests or offline runs, inject a fake dispatch (see the tutorial).

---

## Tutorial

### 1. Define a workflow

`defineWorkflow` is a typed identity helper — it gives you full checking on the `steps` discriminated union.

```ts
const wf = defineWorkflow({
	name: "research",
	budget: { maxAgents: 10, maxTokens: 50_000 },
	steps: [
		{ id: "gather", type: "agent", prompt: "List 3 sources on topic X." },
		{ id: "summarize", type: "agent", prompt: (ctx) => `Summarize:\n${ctx.step("gather").results}` },
	],
});
```

`ctx.input` is the run's initial input; `ctx.step(id)` returns a prior step's `{ results, stats }` (throws if that id hasn't executed yet).

### 2. Run it

```ts
const result = await runWorkflow({
	workflow: wf,
	cwd: process.cwd(),
	now: 1700000000000,   // deterministic inception time (ms); also the journal/run-id seed
	input: "topic X",
});
// result.status: "completed" | "failed" | "aborted"
// result.steps:  StepResult[] (one per executed step, in order)
// result.stats:  aggregated { tokens, cost, durationMs, agents, failures }
// result.journalFile: path to the per-workflow JSONL journal
```

`now` is **required and deterministic** — pass the run's inception time; the engine never reads the clock for identity. The same `(workflow, prompts)` always produces the same cache keys.

### 3. fan_out — parallel agents + merge

```ts
const wf = defineWorkflow({
	name: "parallel-research",
	steps: [
		{
			id: "fan",
			type: "fan_out",
			over: () => ["alpha", "beta", "gamma"],
			agent: (topic) => ({ prompt: `Research ${topic}.` }),
			parallelism: 3,
			merge: (results) => results.join("\n---\n"),
		},
	],
});
```

`fan_out` pre-checks the whole batch fits the budget (`MAX_BATCH=4096`); each item is cache-keyed and abortable independently.

### 4. loop_until — iterate until a condition / budget

```ts
const wf = defineWorkflow({
	name: "refine-loop",
	steps: [
		{
			id: "loop",
			type: "loop_until",
			prompt: (ctx, i) => `Draft ${i + 1}. Current:\n${ctx.step("loop")?.results ?? ctx.input}`,
			until: (ctx, i) => i >= 3,
			maxIterations: 5,
		},
	],
});
```

Each iteration is its own cache-keyed agent call; `maxIterations` + the budget bound the loop.

### 5. Composites — adversarial / tournament / classify_route

Built on the same `dispatchAgentCall`, so they get cache-resume, budget, and abort for free.

```ts
// Produce a candidate, then N judges grade it against a rubric and tally.
defineWorkflow({
	name: "review",
	steps: [
		{
			id: "adv",
			type: "adversarial",
			produce: { prompt: "Write the function." },
			rubric: ["correctness", "handles empty input", "no off-by-one"],
			judges: 3,             // default; minPass defaults to majority
		},
	],
});
// results: { candidate, passed, passCount, minPass, judges: [{pass, reason}] }

// N distinct candidates, M judges rank them, pick the majority winner.
defineWorkflow({
	name: "pick",
	steps: [{ id: "tmt", type: "tournament", candidates: 3, judges: 2, produce: { prompt: "Solve X." } }],
});
// results: { candidates, winner, judges: [{winner, reason}] }

// Classify input, then run the matching route's sub-steps.
defineWorkflow({
	name: "route",
	steps: [
		{
			id: "cr",
			type: "classify_route",
			classifier: { prompt: (ctx) => `Classify intent: ${ctx.input}` },
			routes: {
				bug: [{ id: "file", type: "agent", prompt: "File a bug report." }],
				faq: [{ id: "answer", type: "agent", prompt: "Answer the FAQ." }],
			},
			fallback: [{ id: "escalate", type: "agent", prompt: "Escalate to a human." }],
		},
	],
});
// results: { category, matched, route: StepResult[], routeStatus }
```

Judge/classifier JSON is parsed leniently (LLMs return `"true"`/`"0"` as strings); route nesting is depth-capped to catch cycles.

### 6. Resume — re-run dispatches nothing

The journal lives at `<cwd>/.pi/workflows/<workflow.name>/journal.jsonl` (per-workflow, so the **same workflow re-run hits the cache across runs**; run id is excluded from the key):

```ts
const first = await runWorkflow({ workflow: wf, cwd, now: T0 });  // dispatches every agent
const second = await runWorkflow({ workflow: wf, cwd, now: T1 }); // dispatches ZERO agents — all cached
```

A changed prompt changes its cache key → that agent re-dispatches; unchanged ones replay.

### 7. Per-agent abort & skip

The runner owns an `AgentSpawnRegistry`. Grab it and target one in-flight call:

```ts
import { createSpawnRegistry, skipAgent } from "@fyeeme/pi-dynamic-workflows/sessions/spawn.ts";

const registry = createSpawnRegistry();
const runP = runWorkflow({ workflow: fanOutWf, cwd, now, registry });
// ...once `fan#2` is in flight:
skipAgent(registry, "fan#2");   // aborts only that call; siblings keep running
const result = await runP;       // status "completed" — the batch finished without item 2
```

`abortAgent(registry, callId)` aborts one call; `retryAgent(registry, callId)` aborts so the runner can re-dispatch. Call ids are `${step.id}#${n}` (1-based).

### 8. Budget enforcement

```ts
const wf = defineWorkflow({
	name: "capped",
	budget: { maxAgents: 2 },
	steps: [{ id: "fan", type: "fan_out", over: () => [1, 2, 3], agent: (i) => ({ prompt: `${i}` }) }],
});
const result = await runWorkflow({ workflow: wf, cwd, now });
// result.status === "failed", result.error matches /budget|exhausted/i
```

`maxAgents` is checked before a batch/agent spawns; `maxTokens` is enforced as agents settle (`BudgetPool.isExhausted`). Both throw `BudgetExceededError` — never silently truncate.

### 9. Outcome collectors

Extract a structured value from an agent's text output:

```ts
import { collect } from "@fyeeme/pi-dynamic-workflows/src/index.ts";

const urls = collect<string[]>({ kind: "url" }, result.steps[0].results as string);
const json = collect({ kind: "json" }, agentText);     // first balanced JSON value
const paths = collect<string[]>({ kind: "file_path" }, agentText);
```

`url` / `file_path` / `json` are pure functions of text — apply them on any `StepResult.results`.

### 10. Heuristic planner

A keyword sketch that turns a goal into a single-step workflow scaffold (compare → tournament, review → adversarial, classify → classify_route, else agent). A starting point to edit, not a real NL planner:

```ts
import { heuristicallyPlan } from "@fyeeme/pi-dynamic-workflows/src/index.ts";

const wf = heuristicallyPlan("compare three sorting approaches", { judges: 3 });
// wf.steps[0].type === "tournament"
```

### 11. Load a `.ts` workflow file

```ts
import { loadWorkflowModule } from "@fyeeme/pi-dynamic-workflows/src/index.ts";

const mod = await loadWorkflowModule<{ workflow: ReturnType<typeof defineWorkflow> }>({
	filePath: "./my-workflow.ts",
});
const wf = mod.workflow;
```

The loader runs the deterministic AST guard **before** jiti-imports the file — a workflow body that calls `Date.now()` / `Math.random()` / `new Date()` is rejected at load time (those would destabilize cache keys). Note: the guard scans the entry file only; keep workflows single-file or guard imported helpers separately.

### 12. Test without `pi`

Inject a fake dispatch — no binary, no provider, no tokens. This is exactly how the package's own 108 tests work:

```ts
import { runWorkflow } from "@fyeeme/pi-dynamic-workflows/src/index.ts";
import type { AgentDispatch } from "@fyeeme/pi-dynamic-workflows/src/index.ts";

const fake: AgentDispatch = async (_registry, opts) => ({
	callId: opts.callId,
	exitCode: 0,
	messages: [{ role: "assistant", content: [{ type: "text", text: `out:${opts.task}` }], /* ...rest */ } as never],
	stderr: "",
	usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 15, turns: 1 },
	model: "fake",
	stopReason: "stop",
	aborted: false,
});

const result = await runWorkflow({ workflow: wf, cwd: tempDir, now: 1000, dispatch: fake });
```

---

## Step types reference

| type | payload highlights | result |
|---|---|---|
| `agent` | `prompt: string \| (ctx)=>string`, `model?`, `tools?`, `systemPrompt?` | final assistant text |
| `code` | `transform: (ctx) => unknown` (pure, no dispatch, not cached) | the transform's return value |
| `fan_out` | `over()`, `agent(item,i)`, `parallelism?`, `merge?` | merged array (or `merge` output) |
| `loop_until` | `prompt(ctx,i)`, `until(ctx,i)`, `maxIterations?` | array of per-iteration outputs |
| `adversarial` | `produce`, `rubric[]`, `judges?`, `minPass?` | `{ candidate, passed, passCount, judges }` |
| `tournament` | `candidates`, `judges`, `produce` | `{ candidates, winner, judges }` |
| `classify_route` | `classifier`, `routes: Record<cat, Step[]>`, `fallback?` | `{ category, matched, route, routeStatus }` |

Every step accepts `id`, `retry?: { maxRetries }`.

---

## API reference

### `runWorkflow(opts)` → `Promise<RunResult>`

| option | | |
|---|---|---|
| `workflow` | `WorkflowDefinition` | required |
| `cwd` | `string` | required (journal base) |
| `now` | `number` | required — deterministic inception ms |
| `input?` | `unknown` | `ctx.input` |
| `budget?` | `Budget` | overrides `workflow.budget` |
| `signal?` | `AbortSignal` | run-wide abort |
| `listeners?` | `AgentLifecycleListeners` | `onAgentStart/End/Skip/Retry` |
| `dispatch?` | `AgentDispatch` | default = real `spawnAgent` |
| `registry?` | `AgentSpawnRegistry` | for external `skipAgent`/`abortAgent` |
| `journalDir?` | `string` | default `<cwd>/.pi/workflows/<name>` |
| `sequence?` | `number` | run-id disambiguator |

`RunResult = { runId, status, steps: StepResult[], stats: StepStats, journalFile?, error? }`.

### Also exported
`defineWorkflow`, `loadWorkflowModule`, `collect` (+ `urlCollector`/`filePathCollector`/`jsonCollector`/`parseFirstJson`), `heuristicallyPlan`, `createSpawnRegistry`/`abortAgent`/`skipAgent`/`retryAgent` (from `sessions/spawn.ts`), and all step/result/context types.

---

## Design — Claude Code fusion

| mechanism | module | what it does |
|---|---|---|
| deterministic sandbox | `src/determinism/ast-guard.ts` | AST-bans non-deterministic APIs in workflow source |
| deterministic run id | `src/state/names.ts` | `generateRunId({timestamp, sequence})` is pure |
| cache-key resume | `src/cache/{key,journal}.ts` | `sha256(workflow+prompt+signature)` + per-run JSONL journal |
| per-agent abort | `sessions/spawn.ts` | `Map<callId, ChildProcess>` + per-call `AbortController`; abort → SIGTERM on one process |
| budget + caps | `src/budget/{pool,caps}.ts` | live `BudgetPool` + `MAX_BATCH`/`MAX_LIFETIME_AGENTS` |

The three paradigm conflicts (imperative CC ↔ declarative graph) are resolved: the budget loop becomes a pre-check value fan_out reads; in-process AbortControllers become a subprocess map; the vm sandbox becomes a load-time AST guard over jiti-loaded source.

---

## Testing

```bash
node_modules/.bin/tsc -p packages/extensions/pi-dynamic-workflows/tsconfig.json --noEmit   # typecheck
node_modules/.bin/vitest --run packages/extensions/pi-dynamic-workflows                    # 108 tests
```

A real-`pi` subprocess smoke (default dispatch) lives at `examples/smoke-real-pi.ts` — run it manually when `pi` + a provider are configured.

License: MIT.
