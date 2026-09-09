Manage active goal-mode objective.

Single `op` field:
- `create`: starts goal; enables goal mode. Requires `objective`; optional positive `token_budget`. Only when no goal exists and none is paused.
- `get`: returns current active/paused goal and remaining token budget.
- `resume`: re-activates paused goal for continued work.
- `complete`: marks goal complete. Requires `evidence` — your per-deliverable audit of the CURRENT repo state (files read, checks run, outputs observed). The claim is re-verified by an INDEPENDENT evaluator that inspects the repo itself; a rejected claim keeps the goal active and returns the evaluator's findings — fix the gaps and re-claim with stronger evidence, never the same evidence. NEVER call complete merely because budget is low or the turn is ending. If the evaluator subprocess cannot run, completion falls back to self-audit and the result says so.
- `impossible`: report the goal genuinely CANNOT be achieved in this session. Requires `reason` — self-contradictory condition, unavailable resource/capability, or reasonable approaches exhausted — with evidence. The evaluator independently confirms; your claim is evidence, not proof. Confirmed → the goal pauses and you must tell the user. Refuted → keep working; repeated unconfirmed claims pause the goal for the user.
- `drop`: discards current goal without completing it.

Paused goal from `get` → MUST `resume` before continuing work.
