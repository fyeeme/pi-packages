# pi-review

Review & cleanup extension for [pi](https://github.com/earendil-works/pi).

Registers two commands (`/code-review` and `/code-simplify`) and a general-purpose
`subagent` tool that spawns parallel pi subprocesses — providing the **real
fan-out capability** that the `code-review-v3` and `simplify-v2` skills
(auto-loaded from `~/.pi/agent/skills/`) need for their multi-agent flows.

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

Then point pi at it (e.g. via your extensions config), or symlink into your pi
extensions directory.

## What it registers

### `/code-review` command

```
/code-review [low|medium|high|xhigh|max] [--fix] [--comment] [--share] [<target>]
```

Parses args, then asks the agent to load `~/.pi/agent/skills/code-review-v3/SKILL.md`
and follow it — using the `subagent` tool for any fan-out / verify / gap-hunt.

### `/code-simplify` command

```
/code-simplify [<target>]
```

Cleanup (reuse / simplification / efficiency / altitude) via the `simplify-v2`
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

### `subagent` tool

An LLM-callable tool that spawns one or more real pi subprocesses:

| mode | behavior |
|---|---|
| `single` | run `prompts[0]` once (e.g. an independent verify agent) |
| `parallel` | run all prompts concurrently, capped at 8 (e.g. one finder per angle) |
| `chain` | run sequentially; each later prompt receives prior output |

Each sub-agent is a full `pi --mode json -p --no-session` run. Progress streams
to the TUI via `onUpdate` as each agent completes. ESC aborts the whole batch
(SIGTERM → 5s → SIGKILL per subprocess). Errors are thrown (not returned) so
the agent loop marks the result `isError`.

## Architecture (layered)

```
pi-review/
├── index.ts                     factory: registerTool(subagent) + 2 commands
├── src/
│   ├── agent/dispatch.ts        spawnAgent + mapWithConcurrencyLimit (self-contained copy
│   │                            from pi-dynamic-workflows; no external dep beyond node + pi-ai)
│   ├── tools/subagent.ts        defineTool("subagent") — generic capability layer
│   └── commands/
│       ├── code-review.ts       /code-review handler
│       └── code-simplify.ts     /code-simplify handler + decideSimplifyMode (Jvo guard)
└── test/                        commands unit tests
```

The layout is deliberately layered: `src/tools/` is the **generic capability
layer** (subagent tool + dispatch), `src/commands/` is the **entry layer** (one
file per skill). If a third or fourth skill needs the subagent tool, `src/tools/`
can be split into its own `pi-subagent` extension with zero refactor — the code
is already separated.

`src/agent/dispatch.ts` is a self-contained copy of the spawn pattern from
`examples/extensions/subagent` and `pi-dynamic-workflows/src/agent/dispatch.ts`
(~150 lines). When pi promotes `spawnAgent` to a public `pi-coding-agent`
export, this file should be deleted in favor of that import.

## Relation to the skills

| layer | home | role |
|---|---|---|
| review/cleanup semantics (angles, verdicts, mode bodies) | `~/.pi/agent/skills/code-review-v3/` + `simplify-v2/SKILL.md` | what to look for |
| fan-out dispatch + mode decision | this extension (`subagent` tool + command handlers) | how to run sub-agents / which mode |

Edit a skill to change *what* it hunts; edit this extension to change *how*
sub-agents are spawned and *which mode* is chosen.

## Status

MVP. Phase 2 (not yet built): a `review_verify` tool encapsulating 3-vote
adversarial verify, and a `review_report` tool enforcing the output schema /
`--share` lavish artifact.
