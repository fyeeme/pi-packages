# pi-subagent-core

Shared dispatch core for spawning pi subprocess agents. Not a pi extension (no
`pi` manifest, registers no tools/commands) — a plain TS library used by
[`pi-review`](../pi-review) and
[`pi-dynamic-workflows`](../pi-dynamic-workflows).

## What it provides

- `spawnAgent(registry, options)` — spawn one `pi --mode json -p --no-session`
  subprocess, parse `{message_end, tool_result_end}` NDJSON events, AbortSignal →
  SIGTERM with a 5s SIGKILL escalation.
- `DEFAULT_MAX_CONCURRENCY` — hardcoded max-concurrency ceiling for fan-out:
  **5**. `mapWithConcurrencyLimit(items, fn)` (concurrency omitted) runs at this
  ceiling; pass `concurrency` explicitly for a different one. No env var, no
  config file — by design.
- `mapWithConcurrencyLimit(items, concurrency, fn)` — bounded-parallel map
  preserving input order; stops dispatching after a rejection (no orphan workers).
- `createSpawnRegistry()` / `abortAgent(registry, callId)` — per-call abort
  table (`Map<callId, ChildProcess>` + per-call `AbortController`).
- `getPiInvocation(args)` — resolve the `pi` invocation (re-enter current
  script, or `pi` on PATH).
- Types: `AgentSpawnRegistry` / `AgentSpawnOptions` / `AgentSpawnResult` /
  `AgentUsage` / `AgentCallId` / `AgentAbortMap`.

## Layout

```
pi-subagent-core/
├── index.ts          # the whole core (single file)
└── test/
    └── dispatch.test.ts
```

## Why it exists

`pi-review` and `pi-dynamic-workflows` both implemented the same spawn
primitive (their headers pointed at each other, and both READMEs said "delete
when pi promotes `spawnAgent` to a public export"). This package is the single
source of truth for that core. Workflows-specific machinery
(`skipAgent`/`retryAgent`/`AbortReason`/lifecycle notifications) stays in
`pi-dynamic-workflows` on top of this core.

When pi promotes `spawnAgent` to a public `@earendil-works/pi-coding-agent`
export, this package should be deleted in favor of that import.
