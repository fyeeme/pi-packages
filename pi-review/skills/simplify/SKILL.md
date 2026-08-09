---
name: simplify
description: "Review the changed code for reuse, simplification, efficiency, and altitude cleanups, then apply the fixes. Quality only — it does not hunt for bugs; use /code-review for that. v2 (from Claude Code CLI v2.1.223) — 4 cleanup agents fan out in parallel when context allows, else a single-pass inline cleanup; either way the fixes are applied, verified against the project's check command, and auto-reverted on failure, then reported as structured outcomes via review_report."
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
                PARALLEL MODE, and the `review_report` tool (same extension) for
                the Phase 2 structured outcome report. SINGLE-PASS MODE runs
                standalone apart from `review_report`.
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

## Phase 2 — Apply, verify, and report

Follow the shared **Phase 2** procedure at the end of this skill (snapshot → apply → verify → auto-revert on failure → report via `review_report`). The parallel fan-out only changes how findings are gathered (Phase 1); applying, verifying, and reporting are identical across modes. Set `fanned_out: true` in the report since the 4-agent fan-out actually ran.

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

## Phase 2 — Apply, verify, and report

Follow the shared **Phase 2** procedure at the end of this skill (snapshot → apply → verify → auto-revert on failure → report via `review_report`). Single-pass vs parallel only changes how findings are gathered (Phase 1); applying, verifying, and reporting are identical across modes. Set `fanned_out: false` in the report so a reader is not misled into thinking the 4-agent fan-out ran.

---

# Phase 2 — Apply, verify, and report (shared by both modes)

Dedup findings that point at the same line or mechanism first. Then apply,
verify, and report. This safety net is what distinguishes `/code-simplify` from
a blind cleanup: a finding is only "done" once it is applied AND the project
still verifies — otherwise it is reverted.

## Step 1 — Snapshot the baseline

Before applying any fix, snapshot every file you are about to edit so a failed
verification can be reverted cleanly. For each touched file, copy its current
content into a temp dir:

```
mkdir -p /tmp/pi-simplify-baseline/$(dirname <file>)
cp <file> /tmp/pi-simplify-baseline/<file>
```

`$(dirname <file>)` keeps the target's parent dir (e.g. `src/`) inside the
baseline — a bare `cp <file> /tmp/pi-simplify-baseline/<file>` fails with ENOENT
for any file in a subdirectory. If a fix CREATES a new file, record its path so
Step 3a can remove it on rollback (it has no baseline entry).

This baseline captures the working-tree state **including** the user's
uncommitted changes — reverting to it undoes only `/code-simplify`'s fixes,
never the user's diff. Do **not** use `git checkout` / `git restore` to revert:
that would discard the user's intended changes too.

## Step 2 — Apply the fixes

Apply each surviving finding directly. Skip any finding whose fix would change
intended behavior, require changes well outside the reviewed diff, or that you
judge to be a false positive — note the skip (it will be reported as
`not_achieved`).

## Step 3 — Verify, branching on the result

Run the verification command the handler injected in the trigger message (e.g.
`npm run check`), then branch:

- **No verification command was detected** → keep the applied changes, mark each
  applied finding `fully_achieved`, and say in the report that NO verification
  was run. Verification is opportunistic — never block on its absence.
- **Verification passes** → keep the changes; applied findings are
  `fully_achieved` (or `mostly_achieved` / `partially_achieved` if a fix only
  partly addressed the issue).
- **Verification fails** → the working tree is verified-broken; go to Step 3a.

### Step 3a — Auto-revert (hybrid granularity, only on failure)

1. Revert ALL touched files from the Step 1 baseline (working-tree parent dirs
already exist, so copying back is safe):
   ```
   cp /tmp/pi-simplify-baseline/<file> <file>
   ```
2. Remove any files the fixes CREATED (they have no baseline entry and would
otherwise survive the rollback).
3. Re-apply ONE file's findings at a time, running the verification command
   after each file. Keep only files whose verification passes; revert any file
   whose verification fails back to its baseline.
4. If NO file passes on its own, leave everything reverted and mark every
   finding `not_achieved` — a clean tree is the safe outcome, not a broken one.

This caps the cost: the common case (clean apply) runs verification exactly
once; only a failure escalates to one verification per touched file.

## Step 4 — Report via `review_report`

Call the `review_report` tool **once** with `level: "simplify"` and one finding
entry per cleanup, ranked most-severe first. Each entry carries `file`, `line`
(optional), `category` (`reuse` / `simplification` / `efficiency` /
`altitude`), `summary` (one line, Chinese), `failure_scenario` (the concrete
cost — Chinese), and `outcome`:

- `fully_achieved` — applied and verification passed (or no verification command
  existed and the change was kept).
- `mostly_achieved` / `partially_achieved` — applied but only partly addresses
  the issue.
- `not_achieved` — skipped, or reverted by the auto-revert in Step 3a.
- `unclear_from_transcript` — could not determine.

Do **not** write a free-text summary as the primary record — the structured
`review_report` call IS the summary (it renders the report AND writes JSON to
`<cwd>/.pi/review/` for CI). If `review_report` is unavailable, fall back to a
brief text summary listing each finding's outcome.

Set `fanned_out` honestly in the call: `true` only if the 4-agent fan-out
(subagent) actually ran; `false` for single-pass. The report header shows this
so a reader is not misled about what ran.

## Step 5 — Clean up

```
rm -rf /tmp/pi-simplify-baseline
```

Remove the baseline snapshots once the report is delivered.
