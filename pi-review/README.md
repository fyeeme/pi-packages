# @fyeeme/pi-review (v2)

Review & cleanup assets for [pi](https://github.com/earendil-works/pi-mono), in the sandwich shape (skills + prompts + agents on top of a thin plugin entry):

```
skills/    methodology (code-review, simplify) — registered natively via the `pi` manifest
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

- `/review [low|medium|high|xhigh|max] [--fix] [--comment] [--share] [<pr#>|<branch>|<path>]` — effort-level code review via the code-review skill. Effort is sticky: an explicit level is remembered; the next bare `/review` reuses it.
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

## Requirements

None beyond this package. `@fyeeme/pi-subagents` is a regular npm dependency whose extension factory this entry composes (tool + UI, version-pinned to this package's `node_modules` copy). The four cleaner agents and the finder/verifier/gap-hunter definitions ship with this package, registered via `addAgentDir` at extension load.

## Development

```
npm install --ignore-scripts   # links ../pi-subagents via file: dependency
npm test                       # vitest
npm run typecheck
```

Dev smoke-testing needs only this package's extension dir linked — the
composed subagent stack loads from the `file:` dependency in `node_modules`.
Before publishing: replace the `file:../pi-subagents` dependency with the
published version range.
