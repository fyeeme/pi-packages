# @fyeeme/pi-subagents

**2.1.0** (omp-parity release), following the 2.0 major that headed the extensions family wave (pi-review and pi-dynamic-workflows compose this package as their fan-out engine):

- **Composition architecture** — consumers call `piSubagents(pi)` inside their own factories; tool + UI light up from the version-pinned dependency copy, and the `subagent` tool registers exactly once per process (globalThis guard) so a standalone install coexists with any consumer.
- **Reload-safe registration** — `session_shutdown(reload)` releases the tool-registration guard, so the `subagent` tool survives `/reload` (previously it silently vanished until restart).
- **Whitelist-by-default recursion guard** — spawned children load without the fan-out tool unless the agent definition explicitly opts in; env-capped depth.

General-purpose subagent fan-out for [pi](https://github.com/earendil-works/pi-mono): a `subagent` tool (single / parallel) spawning real `pi --mode json -p --no-session` subprocesses, three-source agent discovery, the shared dispatch core, and the live agent UI. Successor of `@fyeeme/pi-subagent-core` (absorbed; the old package is retired once pi-review and pi-dynamic-workflows switch their imports here).

## What ships

| Layer | Where | What |
|---|---|---|
| Tool | `src/tools/subagent.ts` | `subagent` — single `{agent, task}`, parallel `{tasks[]}` (max 16 per call, shared concurrency ceiling), shared `context`, `<result>` contract extraction, structured output via `outputSchema` (+ `schemaMode`) and agent frontmatter `output:` |
| Agents | `agents.ts` + `agents/` | Discovery: project `.pi/agents` > user `~/.pi/agent/agents` > bundled `agents/` (scout / planner / reviewer / worker). Drop-in registration, re-discovered per call |
| Dispatch core | `src/dispatch.ts` | `spawnAgent` (stable ids, stall watchdog + wall-clock ceiling, failure classification, full-output artifacts), `mapWithConcurrencyLimit`, `createSpawnRegistry`, `abortAgent`, per-callId abort, maxTurns budget, whitelist-by-default recursion guard |
| Settings | `src/concurrency.ts` | `pi-subagent.json` (global `<agentDir>` + project `.pi/`): `fleet`, `maxConcurrency` (any positive integer, default 5), `confirmProjectAgents`, `stallMs` (default 60000), `wallClockMs` (default 0 = disabled). No environment-variable configuration channel |
| UI | `index.ts` + `src/ui/` | Single below-editor fleet surface (`main` + every agent, full stat rows) with Enter-to-open conversation viewer — event-driven rendering on monitor notifications; ↓/← at an empty editor activates it |

## Install

```
pi install npm:@fyeeme/pi-subagents
```

**Consumers compose this extension from their dependency copy** ([`pi-review`](../pi-review), [`pi-dynamic-workflows`](../pi-dynamic-workflows) call `piSubagents(pi)` in their own factories), so their install alone lights the tool and UI — version-pinned, no manifest path wiring. Installing this package standalone is for direct use of the general-purpose agents (scout/planner/reviewer/worker) and composes idempotently alongside consumers.

Dev: symlink `index.ts` (plus `src/`, `agents/`, `agents.ts`) into `~/.pi/agent/extensions/pi-subagents/`, or point a project `.pi/extensions` config at this checkout.

## Usage

```
Use scout to find all authentication code                          # single
Run 2 scouts in parallel: one for models, one for providers        # parallel
```

Multi-step sequencing is orchestration: model it as successive `subagent`
calls, or use a workflow engine (e.g. `pi-dynamic-workflows`). The former
built-in chain mode and the `/implement`-family prompt presets were removed.

Agents are markdown frontmatter files:

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls    # optional whitelist
model: claude-haiku-4-5        # optional; bundled agents omit it (session default)
---
System prompt for the agent goes here.
```

Locations (later wins on name collision): bundled `<pkg>/agents/`, user `~/.pi/agent/agents/`, project `.pi/agents/` (repo-controlled — interactive sessions ask for confirmation before running project agents unless `confirmProjectAgents: false`; headless runs cannot prompt and proceed without asking).

## Security model

- **Recursion**: the `subagent` tool registers only when `isFanoutToolAllowed()` holds — top-level sessions, or children the spawner explicitly opted in below `PI_SUBAGENT_MAX_SPAWN_DEPTH`. Default-spawned children get no `subagent` tool: recursion is physically impossible, not policy-prevented.
- **Project agents** are repo-controlled prompts; interactive sessions confirm before running them.

## Wiring

pi's extension loader runs every extension entry through a fresh jiti with `moduleCache: false`, so ordinary module singletons are **per extension copy**. The monitor, the shared UI controller, and the extension-registered agent-dir registry therefore live on `globalThis` under `Symbol.for`-registered keys (`@fyeeme/pi-subagents/monitor`, `/ui`, `/agent-dirs`): every copy of this package loaded in one process converges on the same objects, and a consumer's `spawnAgent` notifications reach the UI regardless of which copy registered the widgets.

Two mechanisms make the widgets (and the cross-package agent registry) work:

1. **Composition (preferred for consumers).** A consumer's extension factory imports this package's default export and calls it: `import piSubagents from "@fyeeme/pi-subagents"; piSubagents(pi);`. The tool and UI register from the SAME dependency copy the consumer's imports resolve to — version-pinned, one install, no manifest path. The `subagent` tool registers exactly once per process (globalThis guard — pi fatal-exits if the same tool name lands in two extensions' maps), so multiple consumers composing it, plus a standalone install of this package, coexist safely.

2. **Cross-copy convergence via globalThis.** pi loads every extension entry with `moduleCache: false`, so a consumer's library copy and this package's installed copy are separate jiti module graphs. The `Symbol.for`-registered registries connect them: `addAgentDir` calls from any copy are seen by the tool from any copy, and every `spawnAgent`'s monitor notifications reach the UI regardless of which copy spawned. (Which is also why the tool-registration guard itself lives on globalThis.)

For local development with a symlinked checkout, sync the package files into the consumer's `node_modules` copy (or reinstall) after editing — jiti does not follow edits across stale copies.

## Library surface (compatibility with pi-subagent-core)

```ts
import {
  spawnAgent, mapWithConcurrencyLimit, createSpawnRegistry,
  abortAgent, getPiInvocation, getMaxConcurrency,
} from "@fyeeme/pi-subagents";
```

Same names and signatures as the old `@fyeeme/pi-subagent-core` — consumers switch by changing the import source.

## Settings

`~/.pi/agent/pi-subagent.json` (defaults) overridden by `<cwd>/.pi/pi-subagent.json`.
The settings file is the single configuration channel — there is no
environment-variable override.

```json
{
  "fleet": true,                  // below-editor fleet surface on/off
  "maxConcurrency": 5,            // any positive integer; invalid → default
  "confirmProjectAgents": true,   // prompt before running repo-controlled agents
  "stallMs": 60000,               // abort a call with no subprocess event for this long
  "wallClockMs": 0                // hard per-call ceiling; unset/0 = disabled; must be ≥ 2× stallMs
}
```

`maxConcurrency` is read at call time (edits apply on the next fan-out);
`fleet` is read once per process at extension start.

### Migration from 2.0

| 2.0 | 2.1 |
|---|---|
| `widget: "all"/"background"/"off"` | removed (the widget merged into the fleet surface); ignored with a stderr warning |
| `fleetView` | renamed to `fleet`; the old key is ignored with a stderr warning |
| `PI_MAX_CONCURRENT_SUBAGENTS` env var | use `maxConcurrency` in the settings file |
| `agentScope` / `confirmProjectAgents` tool parameters | discovery is always three-source; confirmation is the settings key only — models can no longer weaken it per call |
| `chain[]` + `{previous}` + `/implement` presets | successive `subagent` calls or a workflow engine |

## Output display

Collapsed: status icon (✓/✗/⏳), agent name, last items, usage stats (`3 turns ↑↓ R W $cost ctx model`). Expanded (Ctrl+O): full task, all tool calls, final output as Markdown, per-task usage. Parallel mode streams live per-task status and groups results under Succeeded / Failed headers — failures carry a `failureClass` (transient/hard) and their task's first line so a follow-up call can replay exactly the failed tasks. Per-task model-visible output is capped at 50 KB; the marker points at the full-output artifact written to `<tmpdir>/pi-subagents/<pid>-<n>/<stable-id>.md`.

## Testing

```
npm install --ignore-scripts
npm test        # vitest
npm run typecheck
```
