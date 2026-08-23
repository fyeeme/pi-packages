# @fyeeme/pi-subagent-core

**Shared dispatch core for spawning [pi](https://github.com/earendil-works/pi-mono) subprocess agents — plus an optional pi extension that renders live agent state in the TUI.**

Languages: **English** | [中文](README.zh-CN.md)

Used by [`pi-review`](../pi-review) and [`pi-dynamic-workflows`](../pi-dynamic-workflows) as the single source of truth for the spawn primitive (`spawnAgent`), and by any extension that wants a Claude Code-style agent monitor UI.

---

## What it provides

### Dispatch core (plain library)

- `spawnAgent(registry, options)` — spawn one `pi --mode json -p --no-session` subprocess, parse `{message_end, tool_result_end, tool_execution_start/end, compaction_start, message_update}` NDJSON events, AbortSignal → SIGTERM with a 5s SIGKILL escalation.
- `mapWithConcurrencyLimit(items, concurrency, fn)` — bounded-parallel map preserving input order; stops dispatching new items after a rejection (no orphan workers). The `concurrency` argument is optional: omit it and the ceiling is the effective default — `maxConcurrency` from the config files (options **3 / 5 / 8 / 10**, default **5**; see [Configuration](#configuration-file-based-only)).
- `createSpawnRegistry()` / `abortAgent(registry, callId)` — per-call abort table (`Map<callId, ChildProcess>` + per-call `AbortController`): a single callId can be aborted without disturbing its batch siblings.
- `getPiInvocation(args)` — resolve the `pi` invocation (re-enter the current script, or `pi` on PATH).
- `getEffectiveMaxConcurrency()` — the effective default concurrency ceiling (the "concurrent agents" setting): `maxConcurrency` from the config files, options 3/5/8/10, falling back to `DEFAULT_MAX_CONCURRENCY` (5). Read at call time, so an edited file takes effect on the next fan-out without a restart.
- Types: `AgentSpawnRegistry` / `AgentSpawnOptions` / `AgentSpawnResult` / `AgentUsage` / `AgentCallId` / `AgentAbortMap`.
- `monitor` — an `AgentMonitor` singleton (see below).

Workflows-specific machinery (`skipAgent`/`retryAgent`/`AbortReason`/lifecycle notifications) intentionally stays in `pi-dynamic-workflows` on top of this core.

### Agent UI (optional pi extension)

`sub-agent.ts` + `ui/` render the monitor's live state:

#### Widget (above the editor)

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

A tree of the spawned agents with an animated spinner and live stats:

- `↻5≤30` — assistant turns, bounded by the effective `maxTurns` when one was set.
- `5 tool uses` — completed tool executions.
- `33.8k token (62%)` — lifetime tokens (input + output + cacheWrite, cacheRead excluded) with the context-window utilization as `NN%` inside the parens. Color-coded: <70% dim, 70–85% warning, ≥85% error. Omitted when the model has no declared `contextWindow`.
- `⇊N` — how many times the agent's session has compacted, shown when > 0, always dim.
- `12.3s` — elapsed since spawn (frozen at settlement).
- `⎿ editing 2 files…` — current activity, derived from in-flight tools or the streamed response tail.

Finished agents linger briefly with ✓/✗ (completed 5s, error/aborted 10s), then drop out. Overflow collapses into `+N more (…)` with running agents prioritized.

#### FleetView (below the editor)

While subagents run, a navigable list renders below the editor:

```
  esc to interrupt · ← for agents · ↓ to manage

  ● main
  ○ Agent  Refactor auth module                                     12s · ↓ 33.8k tokens
  ○ Explore  Find auth files                                        11s · ↓ 13.1k tokens
                                                                    ↓ 3 more
```

- Pressing ↓ or ← at an **empty** prompt activates the list; normal typing is untouched.
- ↑/↓ move the selection (● marker), the window scrolls to keep it visible, extras collapse into `↑/↓ N more`.
- Enter opens the selected agent's live conversation overlay; Esc returns to the prompt.
- While any dialog (pi's own menus, extension dialogs) owns the keyboard, the list stays out of its keys.
- Finished agents linger ~4s in the list, then drop out.

#### Conversation viewer (overlay)

A centered overlay over the agent's live message stream — the same array `spawnAgent` collects:

- `[User]` prompt, `[Assistant]` text (thinking rendered dim), `[Tool: name]` calls, `[Result: name]` outputs truncated at 500 chars.
- Auto-scrolls while running; ↑↓/jk scroll, PgUp/PgDn/Shift+↑↓ page, Home/End jump.
- `x x` (double-press) stops the agent through its per-call AbortController → SIGTERM.
- `q`/Esc closes. The viewer stays open (and keeps final output readable) when the agent finishes.

Subprocesses have no stdin, so there is no steering — viewing and stopping only.

#### `/agents` command

Lists the session's agents (running plus recently finished). Enter opens the selected agent's viewer.

## Configuration (file-based only)

There is no interactive settings UI. Three keys, read from two layers with project overriding global:

| Layer | Path |
| --- | --- |
| Global defaults | `<agentDir>/pi-subagent.json` (usually `~/.pi/agent/pi-subagent.json`) |
| Project override | `<cwd>/.pi/pi-subagent.json` |

```json
{
  "widget": "background",
  "fleetView": true,
  "maxConcurrency": 3
}
```

### `widget` — what the above-editor widget shows

| Value | Behavior |
| --- | --- |
| `background` *(default)* | Hide foreground agents — calls spawned with `background: false`, which already render inline as the Agent tool result. Everything else (declared background, and undeclared — the current shape of all consumer calls) stays visible. |
| `all` | Show every agent. |
| `off` | Hide the widget entirely (FleetView and `/agents` keep working). |

Read once at extension startup; changes apply on the next pi session.

### `fleetView` — the below-editor FleetView

| Value | Behavior |
| --- | --- |
| `true` *(default)* | The navigable main+agents list registers while sub-agents run. |
| `false` | The list never registers and its input hook never captures keys. The above-editor widget and `/agents` (including the conversation viewer) keep working. |

Read once at extension startup; changes apply on the next pi session.

### `maxConcurrency` — concurrent agents ceiling

The default concurrency ceiling for sub-agent fan-out (used by `mapWithConcurrencyLimit` when `concurrency` is omitted, and by consumers that resolve their ceiling through `getEffectiveMaxConcurrency()` — e.g. [`pi-review`](../pi-review)'s `subagent` tool in parallel mode).

| Value | Behavior |
| --- | --- |
| `3` / `5` *(default)* / `8` / `10` | At most that many sub-agents in flight at once. Any other value is dropped and the default applies. |

Read at call time, so an edited file takes effect on the next fan-out without a restart. Precedence where a consumer supports its own env override: env (`PI_MAX_CONCURRENT_SUBAGENTS`) → this file → default 5. Consumers that pass `concurrency` explicitly per step (e.g. `pi-dynamic-workflows`) are unaffected.

A malformed file is ignored with a stderr warning; unknown fields are dropped.

### Session lifecycle

On session replacement and quit — `/new`, `/resume`, `/fork`, reload, and quit — both surfaces are torn down immediately: widgets unregistered, spinner and refresh timers stopped, the FleetView input hook released, any open viewer closed. The next `session_start` re-registers. `/new` additionally clears the monitor's stale entries, so finished agents from the previous session never resurrect in the fresh one.

### Fallback re-connection on tool execution

Every `tool_execution_start` re-runs `setUICtx(ctx.ui)` + `update()` on both surfaces (borrowed from tintinweb/pi-subagents). `ctx.ui` is the extension runner's shared uiContext — a lazy getter whose identity only changes on rebind — so in the steady state this is an identity-compare no-op. It recovers:

- pi clearing extension widgets without a session_start we saw (`resetExtensionUI()` on before-session-invalidate / reload disposes widget components and clears the maps without notifying extensions; a theme switch invalidates components similarly), and
- a rebind that changed the `ctx.ui` identity after our `session_start` ran — `setUICtx` detects the new object and re-registers against it.

Timing bonus: the tool call that spawns sub-agents (e.g. pi-review's `subagent`) itself emits this event, so the surfaces are guaranteed registered before the first `callStarted` notification arrives.

## `spawnAgent` options (UI-relevant metadata)

Two `AgentSpawnOptions` fields are purely observational UI metadata — no effect on the spawned process or the returned result:

- `displayName?: string` — widget/FleetView row name. Defaults to `"Agent"`.
- `background?: boolean` — `false` marks the call foreground (hidden in the default `background` widget mode), `true` marks it background, omitted means undeclared (visible in every mode).

## Observability contract

`spawnAgent` notifies the process-global `monitor` singleton at every lifecycle seam (call start/end, assistant message ends, tool execution start/end, compactions, streamed text deltas). The contract:

- **Purely observational** — the dispatch path never reads monitor state back; consumer behavior (`AgentSpawnResult`, transcripts, abort semantics) is unchanged.
- **Total failure isolation** — every notification is wrapped in try/catch; monitor methods are written to be total (defensive typeof checks, Map/arithmetic only). A UI-side bug cannot break a spawn.
- **Bounded state** — finished calls linger 60s (capped at 20 entries) for late viewers, then are evicted lazily.

## Wiring

pi's extension loader runs every extension entry through a fresh jiti with `moduleCache: false`, so ordinary module singletons are **per extension copy**. The monitor and the shared UI controller therefore live on `globalThis` under `Symbol.for`-registered keys: every copy of this package loaded in one process converges on the same objects, and a consumer's `spawnAgent` notifications reach the UI regardless of which copy registered the widgets.

Two requirements make the widgets light up:

1. **Some extension must register the UI.** With [`pi-review`](../pi-review), the manifest entry loads it from the same dependency copy the `subagent` tool imports:

   ```json
   "pi": {
     "extensions": [
       "./index.ts",
       "./node_modules/@fyeeme/pi-subagent-core/sub-agent.ts"
     ]
   }
   ```

   `pi install` runs `npm install` for a package, so the dependency copy (which contains `sub-agent.ts`) is present. Standalone use (`pi install npm:@fyeeme/pi-subagent-core`) registers the UI too.

2. **The consumer must depend on `>= 0.5.0`**, whose `spawnAgent` notifies the process-global monitor. Older copies keep their notifications in a private module instance and are invisible to the UI.

For local development with a symlinked checkout, sync the package files into the consumer's `node_modules` copy (or reinstall) after editing — jiti does not follow edits across stale copies.

## Layout

```
pi-subagent-core/
├── index.ts          # dispatch core (spawnAgent, concurrency, registry, monitor hooks)
├── monitor.ts        # AgentMonitor — process-global live agent state
├── settings.ts       # file-based settings (widget / fleetView / maxConcurrency)
├── sub-agent.ts      # optional pi extension entry (widget + fleet + /agents)
├── ui/
│   ├── agent-widget.ts         # above-editor widget
│   ├── fleet-list.ts           # below-editor FleetView + key handling
│   ├── conversation-viewer.ts  # overlay transcript viewer
│   └── shared.ts               # formatting + theme helpers + model catalog
└── test/
    ├── dispatch.test.ts        # spawnAgent semantics (mocked subprocess)
    ├── recursion-guard.test.ts # fan-out depth policy
    ├── monitor.test.ts         # monitor unit + spawnAgent→monitor integration
    ├── settings.test.ts        # pi-subagent.json parsing/layers/sanitizing
    └── extension.test.ts       # UI lifecycle: register, teardown, /new, toggles
```

## Development

```bash
npm install --ignore-scripts
npm run typecheck   # tsc, strict
npm test            # vitest --run (no real subprocesses; stdout events are mocked)
```

## Why it exists

`pi-review` and `pi-dynamic-workflows` both implemented the same spawn primitive (their headers pointed at each other, and both READMEs said "delete when pi promotes `spawnAgent` to a public export"). This package is the single source of truth for that core.

When pi promotes `spawnAgent` to a public `@earendil-works/pi-coding-agent` export, this package should be deleted in favor of that import.

## Credits

The UI layer is a port of [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents)' agent widget and FleetView, adapted to this package's subprocess-dispatch model (no in-process agent sessions, no steering; viewing + stopping only).
