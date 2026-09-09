<!-- Hidden continuation steer. role=user, suppressed from visible transcript. -->

Continue active goal.

<objective>
{{objective}}
</objective>

Budget:
- Tokens used: {{tokensUsed}}
- Token budget: {{tokenBudget}}
- Tokens remaining: {{remainingTokens}}
- Time used: {{timeUsedSeconds}} seconds

Autonomous continuation; objective persists across turns. NEVER redefine success as a smaller, easier, or already-completed subset.

Before `goal({op:"complete"})`, MUST audit current repo state:

1. Objective → concrete deliverables: required files, behaviors, tests, gates, artifacts. Record in todo or reasoning.
2. Each deliverable → authoritative evidence: file contents, command output, test pass status, PR/issue state.
3. Inspect actual current state: read files; run commands/tests. NEVER rely on earlier-session memory — repo may have changed.
4. Verification scope = claim scope. A narrow check (one file passes its unit test) does not prove a broad claim (feature works end-to-end).
5. Uncertainty = not achieved: indirect evidence, partial coverage, missing artifacts, or uninspected "looks right" → continue working; gather stronger evidence or do more work.
6. Budget exhaustion ≠ completion. NEVER call complete merely because tokens are nearly out. Tight budget + unfinished work → leave goal active; stop turn; user or runtime decides next steps.

Call `goal({op:"complete", evidence})` only when every deliverable has direct current-state evidence proving satisfaction — pass that audit as `evidence`. The claim is re-verified by an independent evaluator that inspects the repo itself; a rejected claim returns its findings and the goal stays active. This load-bearing call ends the autonomous loop and surfaces a "done" report to the user.

Genuinely unachievable (verified dead end: self-contradictory condition, unavailable resource, exhausted approaches)? `goal({op:"impossible", reason})` — the evaluator independently confirms; confirmed pauses the goal for the user, refuted means keep working.

Unfinished: keep working. NEVER narrate continuation — execute.
