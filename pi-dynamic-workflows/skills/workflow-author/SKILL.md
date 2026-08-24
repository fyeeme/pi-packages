---
name: workflow-author
description: "Author and tune deterministic workflow definitions for run_workflow: step-type selection, rubric writing, the single-file determinism constraint, budget/parallelism as declared data, and resume semantics."
---

# Authoring workflow-library definitions

A library workflow is a single `.ts` file under `.pi/workflows/lib/`
(project) or the package's bundled `workflows/` (reference examples:
`review-local-diff`, `review-extension`). It exports a workflow and becomes
runnable by name (`run_workflow` with `source: "library"`) on the next call —
dropping the file in IS the registration; no code change, no restart.

## The hard constraint: single-file determinism

The loader runs the ast determinism guard on the entry source and REJECTS
`Date.now()`, `Math.random()`, and `new Date()` **before** executing. This is
not a style rule — cache-key resume is only sound when the same workflow
source produces the same cache keys. The guard scans **only the entry file**:
a helper imported from another file could smuggle in non-determinism and
silently break resume. Therefore: **library workflows must stay
single-file.** Inline everything; if you need `now`, the engine passes it
(the `now` run parameter / `ctx` plumbing) — never read the clock yourself.

## Choosing step types

| Need | Step | Notes |
|---|---|---|
| One LLM call | `agent` | prompt may be a function of `ctx.input` / `ctx.step(id)` |
| N parallel calls over a list | `fan_out` | `over` may be dynamic (`ctx => …`); declare `parallelism`; `merge` folds results |
| Produce + judge | `adversarial` | rubric criteria become judge prompts; `judges`/`minPass` (majority default) |
| Best-of-N | `tournament` | candidates × judges |
| Route by classification | `classify_route` | classifier replies `{category}`; routes + fallback |
| Iterate to convergence | `loop_until` | `until` condition + `maxIterations` (TS-only — library files only, not inline JSON) |
| Zero-token narrative | `log` | journal annotation only |

## Writing rubrics (adversarial / tournament)

A rubric entry is a judge prompt, not a checkbox. Write each criterion as a
falsifiable, self-contained sentence: `"finding is concretely actionable
(file:line present)"` — not `"quality"`. 2–4 criteria; a judge that cannot
verify a criterion from the material in front of it will guess, and guessing
flattens the verdict distribution.

## Budget and parallelism are data

`budget: { maxAgents, maxTokens, maxDurationMs }` at the workflow level and
`parallelism` on fan-out steps are declared fields the engine enforces
(fan-out pre-checks the batch fits; a step exceeding budget follows its
`onBudgetExhaust` policy — throw, or degrade to null). Tune them by editing
the file; orchestration prompts may also pass tighter values per call.

## Resume semantics

Every dispatched call is cache-keyed (workflow source + prompts + inputs).
Re-running with unchanged definition and inputs skips completed steps from
the journal — do not "help" by re-dispatching; change an input only when you
want a step actually re-run. Editing the workflow source changes the keys:
that is the intended way to invalidate stale cache.

## Checklist before shipping a library workflow

1. Single file, and imports type-only: `import type { WorkflowDefinition } from ...` (erased at load — nothing outside the file executes, so the entry-only guard scan covers everything). NEVER value-import the engine by relative path: from `.pi/workflows/lib/` it does not resolve (bricking the whole library), and any value import puts un-scanned code on the load path. Plain `export const workflow = { name, steps }` with no import at all works too (the loader validates shape, not `defineWorkflow`).
2. No `Date.now` / `Math.random` / `new Date` anywhere in the source.
3. `name` is unique and descriptive (it is the invocation key); `description`
   one line — it appears in the unknown-name listing.
4. Budget and parallelism declared, sized to the worst expected input.
5. Verified locally: `run_workflow` with `source: "library"`, then re-run to
   see journal hits skip completed steps.
