# pi-review

Review & cleanup extension for [pi](https://github.com/earendil-works/pi).

Registers two commands (`/code-review` and `/code-simplify`) and a general-purpose
`subagent` tool that spawns parallel pi subprocesses — providing the **real
fan-out capability** that the `code-review` and `simplify` skills
(bundled in this package under `skills/`) need for their multi-agent flows.

## Why

Both skills instruct the agent to fan out sub-agents (finders / verify /
cleanup angles), but `pi-subagents` does not exist in pi — so the agent
silently degraded to a sequential self-sweep. This extension ships the actual
fan-out primitive: an LLM-callable `subagent` tool that spawns real
`pi --mode json` subprocesses.

This is the "tool + prompt" architecture: the **tool** provides deterministic
dispatch (how many agents, parallelism, abort), the **skill** provides the
review/cleanup semantics. CC's own `/code-review` and `/code-simplify` work the same
way — one general Agent tool, prompt decides how to use it.

## Install

This package peers on `@earendil-works/pi-coding-agent` / `pi-ai` + `typebox`.
From the package dir:

```sh
npm install
```

This resolves [`@fyeeme/pi-subagent-core`](https://www.npmjs.com/package/@fyeeme/pi-subagent-core)
(`^0.3.0`, from the npm registry — no sibling-repo layout requirement).

Then point pi at it (e.g. via your extensions config), or symlink into your pi
extensions directory.

## What it registers

### `/code-review` command

```
/code-review [low|medium|high|xhigh|max] [--fix] [--comment] [--share] [<target>]
```

Parses args, then asks the agent to load the bundled `skills/code-review/SKILL.md`
and follow it — using the `subagent` tool for any fan-out / verify / gap-hunt.

### `/code-simplify` command

```
/code-simplify [<target>]
```

Cleanup (reuse / simplification / efficiency / altitude) via the `simplify`
skill. **The handler decides parallel vs single-pass mode deterministically**
from `ctx.getContextUsage()` (real token count) + whether the `subagent` tool is
registered — mirroring CC's `Jvo` guard:

- context < 80% full AND `subagent` tool available → **parallel** (4 cleanup
  agents via `subagent` mode: parallel)
- otherwise → **single-pass** (inline 4 angles)

This is the deterministic mode selection a pure-prompt skill cannot reproduce
(the skill has no access to context-token count; only extension code can call
`ctx.getContextUsage()`). The decision is announced in the trigger message so
it is observable.

**Apply → verify → revert safety net** (harden-code-simplify): after Phase 2
applies the cleanups, the handler also injects a verification command detected
from `package.json` scripts (`check` → `test` → `lint` → `typecheck`). The
skill snapshots the touched files, applies the fixes, runs that command, and
on failure auto-reverts per-file (a clean apply runs verify exactly once; only
a failure escalates to one verify per touched file). The result is reported as
structured outcomes via `review_report` (`level: "simplify"`), not a free-text
summary. If no verification command is detectable, fixes are kept but the
report states no verification was run (verification is opportunistic, never
blocking).

### `subagent` tool

An LLM-callable tool that spawns one or more real pi subprocesses:

| mode | behavior |
|---|---|
| `single` | run `prompts[0]` once (e.g. an independent verify agent) |
| `parallel` | run all prompts concurrently, capped at the ceiling (e.g. one finder per angle) |
| `chain` | run sequentially; each later prompt receives prior output |

**Fan-out guards** (harden-code-simplify, shared with `/code-review`):

- **Recursion cap (whitelist-by-default)** — a spawned sub-agent does not
  receive the `subagent` tool in its default toolset, so it cannot recurse. A
  caller opts in by listing `subagent` in the child's `tools` whitelist; set
  `PI_SUBAGENT_MAX_SPAWN_DEPTH` to allow multi-level fan-out up to a hard cap.
- **Default turn budget** — fan-out agents get a finite default `maxTurns` (50,
  aligned to CC's `FORKED_AGENT_DEFAULT_MAX_TURNS` in 2.1.227)
  when the caller omits it; an explicit `0` is honored.
- **Configurable concurrency** — `PI_MAX_CONCURRENT_SUBAGENTS` (default 20,
  aligned to CC's `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS ?? 20` in 2.1.227;
  invalid values fall back to the default).

Each sub-agent is a full `pi --mode json -p --no-session` run. Progress streams
to the TUI via `onUpdate` as each agent completes. ESC aborts the whole batch
(SIGTERM → 5s → SIGKILL per subprocess). Errors are thrown (not returned) so
the agent loop marks the result `isError`.

## Architecture (layered)

```
pi-review/
├── index.ts                     factory: registerTool(subagent) + 2 commands
├── skills/                      bundled SKILL.md files (code-review, simplify)
├── src/
│   ├── skills.ts                bundledSkillPath — resolve this extension's own skills/ dir
│   ├── tools/subagent.ts        defineTool("subagent") — generic capability layer
│   └── commands/
│       ├── code-review.ts       /code-review handler + sticky last-used effort (CC 2.1.223)
│       └── code-simplify.ts     /code-simplify handler + decideSimplifyMode (Jvo guard)
└── test/                        commands unit tests
```

The layout is deliberately layered: `src/tools/` is the **generic capability
layer** (subagent tool), `src/commands/` is the **entry layer** (one
file per skill). If a third or fourth skill needs the subagent tool, `src/tools/`
can be split into its own `pi-subagent` extension with zero refactor — the code
is already separated.

The dispatch primitive (`spawnAgent`, `mapWithConcurrencyLimit`,
`createSpawnRegistry`, `abortAgent`, `getPiInvocation` + types) lives in
[`pi-subagent-core`](../pi-subagent-core) (npm `@fyeeme/pi-subagent-core`), a
shared library extracted from the duplicated copies that used to live here and
in `pi-dynamic-workflows`. When pi promotes `spawnAgent` to a public
`pi-coding-agent` export, `pi-subagent-core` should be deleted in favor of that
import.

## Relation to the skills

| layer | home | role |
|---|---|---|
| review/cleanup semantics (angles, verdicts, mode bodies) | `skills/code-review/` + `skills/simplify/` (bundled in this package) | what to look for |
| fan-out dispatch + mode decision | this extension (`subagent` tool + command handlers) | how to run sub-agents / which mode |

Edit a skill to change *what* it hunts; edit this extension to change *how*
sub-agents are spawned and *which mode* is chosen.

## Status

`review_report` is built — schema aligned to CC `ReportFindings` (2.1.227
empirical): 3-state `outcome` (`fixed`/`skipped`/`no_change_needed`), 2-value
`verdict` (`CONFIRMED`/`PLAUSIBLE`), `short_summary` (≤60, table overview),
`report_id` for fixed-later re-reports; renders the Chinese Markdown report
and writes JSON to `<cwd>/.pi/review/` for CI / `--fix` / `--comment`.

Remaining Phase 2 item (not yet built): a `review_verify` tool encapsulating
3-vote adversarial verify. `--share` already routes through lavish-axi (see
the code-review skill).
