# @fyeeme/pi-review (v2)

**2.0.0 — major release** (from 1.1.1), part of the 2.0 extensions family wave:

- **Sandwich architecture** — skills carry the methodology, `prompts/` carries the orchestration strategy as data (parallel-when guards in frontmatter, phases in the body), `agents/` carries the 12 review roles (finder A–E, cleaner-reuse/simplification/efficiency, altitude, conventions, verifier, gap-hunter), and a thin plugin entry composes the stack.

- **Batteries-included fan-out** — the entry composes [`@fyeeme/pi-subagents`](https://www.npmjs.com/package/@fyeeme/pi-subagents) 2.1.1 from its npm dependency: the `subagent` tool, real `pi` subprocess spawning, and the live agent UI (widget / FleetView / `/agents`) work out of the box.

- **`review_report` structured findings sink** — Chinese Markdown rendered back to the conversation plus machine-readable JSON under `<cwd>/.pi/review/` for CI, `--fix` re-reports, and `--comment`.

- **Effort levels with CC-parity semantics** — `/review [low|medium|high|xhigh|max]`: quad tuples `{correctnessAngles, perAngle, maxFindings, sweep}`, grouped-by-location independent verification, and the xhigh/max gap-hunt.

- **`/simplify` dual-mode** — the dispatcher measures context usage and diff size against the declared strategy, then renders either the PARALLEL template (4 cleaner agents via `subagent`) or the SINGLE-PASS one.

- Breaking: commands renamed `/code-review` → `/review`, `/code-simplify` → `/simplify`.

Review & cleanup assets for [pi](https://github.com/earendil-works/pi-mono), in the sandwich shape (skills + prompts + agents on top of a thin plugin entry):

```
skills/    methodology (review, simplify) — registered natively via the `pi` manifest
prompts/   orchestration strategy as data — parallel-when guards in frontmatter,
           CC-parity phase structure in the body; rendered by the generic dispatcher
agents/    the review roles as subagent definitions (finder-*, cleaner-*, verifier,
           gap-hunter) invoked via the `subagent` tool of @fyeeme/pi-subagents
index.ts   plugin entry: the review_report structured findings sink + the
           /review and /simplify dispatcher commands
src/       dispatch.ts (variable gathering, guard evaluation, rendering),
           diff.ts (deterministic diff ladder — unchanged v1 semantics),
           strategy.ts (guard evaluator), tools/review_report.ts
```

**Batteries included**: installing this package is enough. Its extension
factory composes [`@fyeeme/pi-subagents`](../pi-subagents) (the `subagent`
tool, spawning, and the live agent UI — widget / FleetView / `/agents`) from
the version-pinned dependency copy, so every fan-out the skills orchestrate
works out of the box. A standalone pi-subagents install is optional
(general-purpose scout/planner/reviewer/worker agents) and coexists —
composition is idempotent.

## Commands

- `/review [low|medium|high|xhigh|max] [--fix] [--comment] [--share] [<pr#>|<branch>|<path>]` — effort-level code review via the review skill. Effort is sticky: an explicit level is remembered; the next bare `/review` reuses it.
- `/simplify [<target>]` — cleanup of the changed code (reuse/simplification/efficiency/altitude). The dispatcher resolves the diff (upstream merge-base → HEAD worktree → staged → unstaged; submodule-aware), evaluates the strategy declared in `prompts/simplify.parallel.md` frontmatter (context usage < 80%, diff < 400k chars, fan-out available), and renders either the PARALLEL template (Phase 0 visible diff read → `subagent` parallel dispatch of the 4 cleaner agents with `maxTurns: 15` → Phase 2 apply/verify/report) or the SINGLE-PASS template (angles worked inline).

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

Turn budgets are configurable via a JSON file, following the same two-layer
pattern as pi-subagents' `pi-subagent.json` (project overrides global):

- Global: `<agentDir>/pi-review.json`
- Project: `<cwd>/.pi/pi-review.json`

```jsonc
// <any layer>/pi-review.json — all keys optional
{
  "maxTurns": {
    "subagent": 20,   // each /review finder-batch subagent call
    "verifier": 15,   // each /review Phase 2 verifier call
    "gapHunt": 15,   // the /review Phase 3 gap-hunter
    "simplify": 15    // each /simplify PARALLEL cleaner agent
  }
}
```

Values must be positive integers; anything else (or an absent file) falls back
to the built-in defaults — `20` / `15` / `15` / `15`, the numbers the bundled
prompts and skills were written with — so with no configuration the rendered
instructions are byte-identical to the pre-config behavior. Files are read at
command time: an edit takes effect on the next `/review` or `/simplify`
without a restart. When a budget is configured, the trigger message states it
and the skills defer to it over their built-in defaults.

## Requirements

None beyond this package. `@fyeeme/pi-subagents` 2.1.1 is a regular npm dependency (exact-pinned) whose extension factory this entry composes (tool + UI). The four cleaner agents and the finder/verifier/gap-hunter definitions ship with this package, registered via `addAgentDir` at extension load.

## Development

```
npm install --ignore-scripts   # @fyeeme/pi-subagents resolves from the npm registry
npm test                       # vitest
npm run typecheck
```

To test local pi-subagents changes alongside this package, temporarily point the
dependency back at the sibling checkout (`file:../pi-subagents`) and reinstall;
restore the pinned registry version before publishing.
