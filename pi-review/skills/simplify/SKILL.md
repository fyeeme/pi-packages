---
name: simplify
description: "Review the changed code for reuse, simplification, efficiency, and altitude cleanups, then apply the fixes. Quality only — it does not hunt for bugs; use /code-review for that. v2 (from Claude Code CLI v2.1.223) — 4 cleanup agents fan out in parallel when context allows, else a single-pass inline cleanup; either way the fixes are applied to the working tree."
---

<!--
  Origin: Claude Code built-in skill `/simplify` (CLI v2.1.223), reverse-
  engineered from bin/claude.exe strings. Pi registers it as /code-simplify.

  Lineage:
    v2.1.220 → the first reconstruction         (v1)
    v2.1.223 → verified 2026-08-06 against bin/claude.exe strings: skill body
               (intro, Phase 0, the 4 cleanup angles, Phase 2 apply) and the
               PARALLEL/SINGLE-PASS split are unchanged vs v2.1.220. The 4
               angle bodies are shared verbatim with code-review's cleanup
               angles (same source variables in the binary).

  Bundled: ships inside the pi-review extension (skills/simplify/SKILL.md).

  Invocation: /code-simplify [<target>]
    target = file path | PR number | branch name

  ════════════════════════════════════════════════════════════════════════
  Pi ADAPTATIONS (differ from the CC runtime)
  ════════════════════════════════════════════════════════════════════════
    1. Fan-out tool — CC uses the Agent tool; Pi uses the `subagent` tool
       (mode: parallel). Where CC says "the Agent tool", read `subagent`.
    2. Mode guard  — CC's _Yo has two clauses: (a) spawn-depth — single-pass when
       agent depth >= CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH (default 3); (b) the
       Agent tool must be in the allowlist. On Pi: (a) is N/A — the `subagent`
       tool spawns a fresh subprocess (always depth 0), so depth never accumulates
       — so decideSimplifyMode substitutes a context-fraction heuristic
       (tokens/contextWindow >= 0.8 → single-pass), a Pi addition NOT a mirror of
       _Yo; (b) is mirrored as "the `subagent` tool must be registered". The
       decision is made DETERMINISTICALLY by the /code-simplify handler — it can
       read ctx.getContextUsage(), which a pure-prompt skill cannot — and announced
       in the trigger message; this skill just provides the two mode bodies.
    3. Command     — CC: /simplify; Pi: /code-simplify.

  Prerequisite: the `subagent` tool (provided by the pi-review extension) for
                PARALLEL MODE. SINGLE-PASS MODE runs standalone.
-->

You are improving the quality of the changed code, not hunting for bugs. Review
it for reuse, simplification, efficiency, and altitude issues, then fix what you
find. Do not look for correctness bugs — that is what `/code-review` is for.

The `/code-simplify` handler has already chosen the mode (PARALLEL or
SINGLE-PASS) from real context usage and announced it in the trigger message.
Follow the body that matches; do not fake the mode you weren't asked to run.

## Phase 0 — Gather the diff

Run `git diff @{upstream}...HEAD` (or `git diff main...HEAD` / `git diff HEAD~1`
if there's no upstream) to get the unified diff under review. If there are
uncommitted changes, or the range diff is empty, also run `git diff HEAD` and
include the working-tree changes in scope — the review often runs before the
commit. If a PR number, branch name, or file path was passed as an argument,
review that target instead. Treat this diff as the review scope.

---

# PARALLEL MODE  (subagent tool available AND context not near-full)

`/code-simplify → 4 cleanup agents in parallel → apply the fixes`

## Phase 1 — Review (4 cleanup agents in parallel)

Launch **4 independent review agents** via the `subagent` tool, all in a single
message so they run concurrently (mode: parallel). Pass each agent the diff and
one of the four angles below. Each returns its findings with `file`, `line`, a
one-line `summary`, and the concrete cost (what is duplicated, wasted, or harder
to maintain).

### Reuse
Flag new code that re-implements something the codebase already has — Grep
shared/utility modules and files adjacent to the change, and name the existing
helper to call instead.

### Simplification
Flag unnecessary complexity the diff adds: redundant or derivable state,
copy-paste with slight variation, deep nesting, dead code left behind. Name the
simpler form that does the same job.

### Efficiency
Flag wasted work the diff introduces: redundant computation or repeated I/O,
independent operations run sequentially, blocking work added to startup or hot
paths. Also flag long-lived objects built from closures or captured environments
— they keep the entire enclosing scope alive for the object's lifetime (a memory
leak when that scope holds large values); prefer a class/struct that copies only
the fields it needs. Name the cheaper alternative.

### Altitude
Check that each change is implemented at the right depth, not as a fragile
bandaid. Special cases layered on shared infrastructure are a sign the fix isn't
deep enough — prefer generalizing the underlying mechanism over adding special
cases.

## Phase 2 — Apply the fixes

Wait for all four agents to complete, dedup findings that point at the same line
or mechanism, and fix each remaining one directly. Skip any finding whose fix
would change intended behavior, require changes well outside the reviewed diff,
or that you judge to be a false positive — note the skip rather than arguing
with it. Finish with a brief summary of what was fixed and what was skipped (or
confirm the code was already clean).

---

# SINGLE-PASS MODE  (subagent tool unavailable OR context near-full)

`/code-simplify → subagent tool unavailable → single-pass inline cleanup → apply the fixes`

The `subagent` tool isn't available in this context (or context is near-full), so
the usual 4-agent fan-out can't run. Work through all four angles below yourself,
in this same context, in one pass — do not skip an angle for lack of fan-out.

## Phase 1 — Review (4 cleanup angles, single pass)

Review the diff against each angle below in turn. For each, note findings with
`file`, `line`, a one-line `summary`, and the concrete cost (what is duplicated,
wasted, or harder to maintain).

### Reuse
Flag new code that re-implements something the codebase already has — Grep
shared/utility modules and files adjacent to the change, and name the existing
helper to call instead.

### Simplification
Flag unnecessary complexity the diff adds: redundant or derivable state,
copy-paste with slight variation, deep nesting, dead code left behind. Name the
simpler form that does the same job.

### Efficiency
Flag wasted work the diff introduces: redundant computation or repeated I/O,
independent operations run sequentially, blocking work added to startup or hot
paths. Also flag long-lived objects built from closures or captured environments
— they keep the entire enclosing scope alive for the object's lifetime (a memory
leak when that scope holds large values); prefer a class/struct that copies only
the fields it needs. Name the cheaper alternative.

### Altitude
Check that each change is implemented at the right depth, not as a fragile
bandaid. Special cases layered on shared infrastructure are a sign the fix isn't
deep enough — prefer generalizing the underlying mechanism over adding special
cases.

## Phase 2 — Apply the fixes

Dedup findings that point at the same line or mechanism, and fix each remaining
one directly. Skip any finding whose fix would change intended behavior, require
changes well outside the reviewed diff, or that you judge to be a false positive
— note the skip rather than arguing with it. Finish with a brief summary of what
was fixed and what was skipped (or confirm the code was already clean). State
clearly in your summary that this was a single-pass review done without the
`subagent` tool, not the full 4-agent fan-out, so whoever reads it isn't misled
about what actually ran.
