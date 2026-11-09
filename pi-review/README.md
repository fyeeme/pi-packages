# @fyeeme/pi-review (v2)

**2.0.0 — major release** (from 1.1.1), part of the 2.0 extensions family wave:

- **Sandwich architecture** — skills carry the methodology, `prompts/` carries the orchestration strategy as data (parallel-when guards in frontmatter, phases in the body), `agents/` carries the 12 review roles (finder A–E, cleaner-reuse/simplification/efficiency, altitude, conventions, verifier, gap-hunter), and a thin plugin entry composes the stack.

- **Provider-decoupled fan-out** — the finder/verifier pipeline rides whichever extension registers the bound tool name (`fanout.tool` in the `young.json` `"pi-review"` section, default `subagent`). No provider import, no provider npm dependency; an unregistered binding degrades to a single-pass review with a warning.

- **`review_report` structured findings sink** — Chinese Markdown rendered back to the conversation plus machine-readable JSON under `<cwd>/.pi/review/` for CI, `--fix` re-reports, and `--comment`.

- **Effort split (v2.1)** — `/code-review [low|medium|high|xhigh|max]`: low/medium/high review the diff in ONE pass in the main session (no subagents: rubric-ported flag criteria, P0–P3 priorities, in-session self-verify at medium/high); xhigh/max keep the opt-in deep sweep — quad tuples `{correctnessAngles, perAngle, maxFindings, sweep}`, grouped-by-location independent verification, and the gap-hunt.

- **`/code-simplify` dual-mode** — the dispatcher measures context usage and diff size against the declared strategy, then renders either the PARALLEL template (4 cleaner agents via `subagent`) or the SINGLE-PASS one.

- Commands: `/code-review` and `/code-simplify` — restored v1 names (2.0.0 briefly renamed them `/review` / `/simplify`).

Review & cleanup assets for [pi](https://github.com/earendil-works/pi-mono), in the sandwich shape (skills + prompts + agents on top of a thin plugin entry):

```
skills/    methodology (code-review, code-simplify) — registered natively via the `pi` manifest
prompts/   orchestration strategy as data — parallel-when guards in frontmatter,
           CC-parity phase structure in the body; rendered by the generic dispatcher
agents/    the review roles as subagent definitions (finder-*, cleaner-*, verifier,
           gap-hunter) invoked via the bound fan-out tool (default
           `subagent`; see fanout.tool in Configuration)
index.ts   plugin entry: the review_report structured findings sink + the
           /code-review and /code-simplify dispatcher commands
src/       dispatch.ts (variable gathering, guard evaluation, rendering),
           diff.ts (deterministic diff ladder — unchanged v1 semantics),
           strategy.ts (guard evaluator), tools/review_report.ts
```

**Provider-decoupled**: this package neither registers a fan-out tool nor
depends on any provider package. Install a provider (canonically
[`@fyeeme/pi-subagents`](../pi-subagents)) alongside it and bind the tool
name via `fanout.tool` when it differs from `subagent`; the agent
definitions ship with this package and register into the provider's shared
discovery registry via the documented symbol contract (no import). Without
a provider, every fan-out path degrades to single-pass with an install-hint
warning — never a silently weaker review.

## Commands

- `/code-review [low|medium|high|xhigh|max] [--fix] [--loop] [--comment] [--share] [--max-findings <n>|all|default] [<pr#>|<branch>|<path>|<instructions>]` — effort-level code review via the code-review skill. low/medium/high run as a single pass in this session (fast path, default); xhigh/max fan out finder/verifier/gap-hunt agents through `subagent` (CC re-sync 2026-10: finder paths are canonFile-normalized against the changed-file list before verify grouping; free-form instruction targets ride the scope block with CC's anti-injection framing; medium/high use CC's 8-angle set; xhigh/max reports carry `refuted` + `stats`). Effort is sticky: an explicit level is remembered; the next bare `/code-review` reuses it, and a near-miss token ("meduim") is warned about, not mistaken for a target. `--loop` (single-pass levels only) drives extension-orchestrated fix→re-review rounds (≤ `maxTurns.loop`, default 3) until no P0/P1 findings remain. `--max-findings` (CC 2.1.291) caps the report at n findings (sticky until `default`; `all` lifts the numeric cap but a single report is hard-capped at 32 — `review_report` truncates and stamps past it; invalid values warn and are ignored). At xhigh/max the dispatcher measures the committed range with `git diff --numstat` and the trigger carries a "Finder budget:" note (`ceil(lines/150)` clamped to 2–8 finder agents); after the report, a gated chain (`/code-simplify` not yet run this session + runtime-surface diff + no further user instruction) auto-invokes `/code-simplify`, else suggests it in one line. If the repo has a `REVIEW.md` at its root (CC cloud Code Review feature, ported), the dispatcher injects the BASE version (`@{upstream}`, then `main`, then the worktree — a branch that edits REVIEW.md is reviewed under the rules it is merging INTO) as "Repository review instructions": freeform markdown calibrating what to flag, at what severity, and what to skip; the Phase 0.5 scope block carries it verbatim to every finder/verifier.
- `/code-simplify [<target>]` — cleanup of the changed code (reuse/simplification/efficiency/altitude). The dispatcher resolves the diff (upstream merge-base → HEAD worktree → staged → unstaged; submodule-aware), evaluates the strategy declared in `prompts/simplify.parallel.md` frontmatter (context usage < 80%, diff < 400k chars, fan-out available), and renders either the PARALLEL template (Phase 0 visible diff read → `subagent` parallel dispatch of the 4 cleaner agents, no turn budget → Phase 2 apply/verify/report) or the SINGLE-PASS template (angles worked inline).

Reports land via the `review_report` tool: Chinese Markdown back to the conversation plus machine-readable JSON under `<cwd>/.pi/review/`.

## Strategy is data

```
# prompts/simplify.parallel.md
---
parallel-when:
  context-below: 0.8
  diff-chars-below: 400000
---
```

Edit the file, the strategy changes. The dispatcher only executes what the templates declare (the unmeasurable-context and recursion-guard fallbacks stay as code invariants). See `test/dispatch.test.ts` for the anchored semantics.

## Configuration

Turn budgets and the fan-out binding are configurable via the shared
`young.json` convention (project overrides global):

- Global: `<agentDir>/young.json` → the `"pi-review"` section (top-level
  keys isolate extensions — the same file pi-subagents' `"subagents"`
  section lives in)
- Project: `<cwd>/.pi/pi-review.json` (whole file)

```jsonc
// <agentDir>/young.json → "pi-review" section, or <cwd>/.pi/pi-review.json — all keys optional
// (same shape at both layers; at the global layer this is the CONTENTS of the section)
{
  "pi-review": {
    "maxTurns": {
      "loop": 3 // --loop fix→re-review round cap (single-pass levels)
    },
    "fanout": {
      "tool": "subagent-parallel" // which registered tool carries the finder/verifier/cleaner dispatch
    }
  }
}
```

Note: sticky runtime STATE (`codeReviewLastEffort`, `--max-findings` memory)
stays in `<agentDir>/pi-review.json` — that file is state, not config; the
extension writes it and it is never read as configuration.

**Fan-out tool binding**: `fanout.tool` names the registered tool that runs
the fan-out paths (`/code-review xhigh|max`, the parallel cleanup variant).
Default `subagent`; set it when your provider extension registers its tool
under a different name. Project overrides global. At command time the bound
name is resolved against the registry: registered → activated and used
(the parallel triggers address it as `{{fanout-tool}}`); unregistered →
the fan-out levels fall back to a single-pass review with a warning naming
the configured tool (`--loop` still works on the degraded review).

(The former `subagent` / `verifier` / `gapHunt` / `simplify` entries are read
and dropped — agent tasks carry no turn budget and run to natural
completion.) Values must be positive integers; anything else (or an absent
file) falls back to the built-in default (`3`). Files are read at
command time: an edit takes effect on the next `/code-review` or `/code-simplify`
without a restart. When a budget is configured, the trigger message states it
and the skills defer to it over their built-in defaults.

## Requirements

None for single-pass use. The fan-out paths (xhigh/max reviews, the
parallel cleanup variant) need an extension that registers the bound tool —
canonically a standalone [`@fyeeme/pi-subagents`](../pi-subagents) install;
bind a non-default name via `fanout.tool`. There is **no** npm dependency
on any provider. The review agents ship with this package, registered into
the provider's shared discovery registry at extension load.

## Development

```
npm install --ignore-scripts   # dev deps only — no runtime provider dependency
npm test                       # vitest
npm run typecheck
```

To test local pi-subagents changes alongside this package, temporarily point the
dependency back at the sibling checkout (`file:../pi-subagents`) and reinstall;
restore the pinned registry version before publishing.
