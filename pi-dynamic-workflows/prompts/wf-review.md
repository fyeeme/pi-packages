---
description: Heavy review pipeline via deterministic workflow (budget + resume + adversarial verify)
---
Run the heavy review pipeline now. Target: $@

First resolve the diff yourself (run `git diff` against the appropriate
range — upstream merge-base if configured, else HEAD; pass the diff text as
the workflow `input`).

Then call `run_workflow` with `source: "library"`:

- For a plain local diff → name `review-local-diff` (5 finders at
  parallelism 4, adversarial verify judges 3 / minPass 2, budget 12 agents /
  2M tokens).
- For changed packages under an extensions submodule → name
  `review-extension` (one reviewer per changed package at parallelism 3).

Budget guidance: pass a per-call `budget` override on the run_workflow call —
halve `maxAgents` when the diff exceeds ~150 files; without an override the
workflow's own declared budget applies.

Resume behavior: on journal keys already present from a prior partial run
the engine skips completed steps — do not re-dispatch them yourself.

When the run completes, report the merged, verified findings via
`review_report` (if available) or as a markdown list ranked most-severe
first.

For tuning the pipeline itself (steps, rubric, determinism constraints),
load the workflow-author skill.
