---
description: Implement → review → fix loop via successive subagent calls
argument-hint: <what to implement>
---
Execute this three-stage loop with the `subagent` tool — one call per stage.
You are the coordinator: pass each stage's complete output text into the next
stage's `task` yourself (chain mode no longer exists).

1. **Implement** — call `subagent` with agent `worker`, task: $@ plus any repo
   context it needs. Ask for the final implementation summary in the result.

2. **Review** — call `subagent` with agent `reviewer`. Its task must begin:
   "Review the following implementation." followed by the worker's COMPLETE
   result verbatim, plus the files/areas touched.

3. **Fix** — if and only if the reviewer reported issues, one more `worker`
   call: "Apply this feedback to your earlier implementation." followed by the
   reviewer's findings verbatim.

Rules:

- Forward results between stages verbatim — never paraphrase or summarize;
  each subagent has zero memory of its predecessor.
- Run stages strictly sequentially; a later stage always needs the earlier
  stage's full output as input.
- Skip stages 2–3 only for trivial changes (< ~20 lines, no behavior change);
  state explicitly that you did so and why.
- Finish by reporting: what was implemented, the review verdict, and anything
  still open.
