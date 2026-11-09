# pi-goal

Goal mode for [pi](https://github.com/earendil-works/pi-coding-agent): one persistent objective that survives across turns — the agent keeps working toward it through automatic continuations until it can prove the objective achieved, or that it is genuinely blocked.

Rewritten from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) `extensions/goal.ts` (Apache-2.0). The implementation is carried over as-is; single-file `index.ts`, no build step. Earlier releases were a port of oh-my-pi's goal mode — see [CHANGELOG](./CHANGELOG.md) for what changed.

## What it does

- **Three tools** — `get_goal` (status, budgets, elapsed time, remaining budget), `create_goal` (explicit user requests only; fails while an unfinished goal exists, replaces a completed one), `update_goal` (marks the goal `complete` or `blocked` — nothing else; status changes like pause/resume stay user-controlled).
- **Strict completion audit** — the continuation and system prompts require per-requirement evidence from current repo state before `complete`; "ran out of things to say" and "budget nearly exhausted" are explicitly not completion.
- **Blocked audit** — `blocked` requires the same blocking condition to repeat for three consecutive goal turns at a true impasse; resuming resets the audit.
- **`/goal` command** — `/goal <objective>` sets a goal (replace confirmation when one is unfinished); bare `/goal` shows the current summary; subcommands `clear`, `edit` (interactive objective editor), `pause`, `resume`.
- **Token budget** — defaults to 2,000,000 tokens; `create_goal` accepts an explicit `token_budget`. Accounting adds `max(0, input - cacheRead) + output` per finished run (falling back to `totalTokens`), plus wall-clock seconds. Crossing the budget flips the goal to `budgetLimited`, posts a summary, and stops queueing continuations — it never silently completes the goal.
- **Automatic continuation** — after a clean run ends with the goal still active, a hidden `goal-continuation` message restates the objective, budget, and audits and triggers the next turn. One continuation is queued at a time; pending messages suppress queueing.
- **Run failure handling** — an errored run stops the loop and records `usageLimited` (usage/rate/quota/limit errors) or `blocked` (anything else); an aborted run pauses the goal (headless) or asks (interactive).
- **Session persistence** — every transition appends a full-snapshot `goal` custom entry (`{ version: 2, action: set|edit|status|clear|account, goal }`). Restore replays the latest entry on the active branch on reload and tree navigation. Objectives are capped at 4,000 characters.
- **Context hygiene** — a `context` handler drops `goal-ui` messages and all but the newest continuation of the active goal from the model view.
- **Footer status** — `Pursuing goal (<tokens> / <budget>)` while active, plus per-status hints (`Goal paused (/goal resume)`, `Goal budget reached`, `Goal complete`, …).

## Install

```bash
pi install npm:@fyeeme/pi-goal
```

or copy/link this directory into `~/.pi/agent/extensions/` (global) or `.pi/extensions/` (project).

## Usage

```
/goal Ship the parser rewrite with all tests passing   # start working
/goal                                                   # current goal summary
/goal pause            # ... later ...  /goal resume
/goal edit             # rewrite the objective (interactive)
/goal clear            # remove the goal
```

The model drives completion itself: when the objective is achieved it calls `update_goal` with `status: "complete"` and reports final budget usage; when truly stuck after three consecutive blocked turns it calls `update_goal` with `status: "blocked"`.

## Development

```bash
npm install --ignore-scripts
npm test        # vitest, 43 tests
npm run typecheck
```

## License

MIT. Derived from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) `extensions/goal.ts` (Apache-2.0).
