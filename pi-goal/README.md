# pi-goal

oh-my-pi's **goal mode** migrated to a [pi](https://github.com/earendil-works/pi-coding-agent) extension: one persistent autonomous objective looped until the agent can *prove* the success criteria — not until it runs out of things to say.

Source: [oh-my-pi](https://github.com/can1357/oh-my-pi) (a fork of badlogic/pi-mono), `packages/coding-agent/src/goals` + the goal wiring in its agent session and interactive mode. The runtime semantics are ported behavior-for-behavior; host-internal surfaces are mapped to pi's extension API (see the adaptation table in `index.ts`). One deliberate deviation, absorbed from Claude Code 2.1.261's goal design (binary-verified 2026-09-07): **completion is gated by an independent evaluator** instead of self-graded — see below.

## What it does

- **`goal` tool** — `create` / `get` / `complete` / `resume` / `impossible` / `drop`. Creating a goal enables goal mode; completing it requires verified evidence of every deliverable (see the evaluator gate below); the runtime refuses double-completes.
- **Independent evaluator gate (CC 2.1.261 absorption)** — `goal({op:"complete", evidence})` passes the agent's per-deliverable audit to a fresh `pi -p` subprocess that re-verifies the repository itself (it can run the tests — grounded, unlike CC's transcript-only evaluator). Its JSON contract defaults to *insufficient evidence = not met*. A refuted claim keeps the goal active and returns the evaluator's findings; the tool result tells the model to fix the gaps and re-claim with stronger evidence. If the evaluator subprocess cannot run (spawn failure, timeout ≈ 5 min, unparseable output), completion falls back to the omp self-audit behavior, honestly labeled in the result.
- **`impossible` channel (CC 2.1.261 absorption)** — when the agent believes the goal genuinely cannot be achieved this session, `goal({op:"impossible", reason})` sends the claim to the evaluator, which independently confirms or refutes it ("the claim is evidence, not proof"). Confirmed → the goal pauses (`reason: impossible-confirmed`) and the model must report honestly to the user. Refuted → keep working; after 2 unconfirmed disputes the goal pauses for a human decision (`reason: impossible-disputed`). An unadjudicated claim (evaluator unavailable) changes nothing.
- **Autonomous continuation** — when the agent yields while the goal is still active, pi-goal re-submits a hidden continuation prompt that restates the objective and the verification checklist, so work continues across turns without user nudges. A continuation turn that produced no tool calls suppresses the next one (no infinite idle loops); a real user message re-arms the loop. While a blocking dialog is open (`/goal` menus, confirmations, or any extension's `ask_user`), continuations are withheld via `ui_prompt_start`/`ui_prompt_end` and resume when the dialog closes.
- **Budget accounting** — optional `token_budget` per goal. pi-goal counts input + output + cache writes (cache reads are reused prefix, not new work) plus wall-clock seconds. Crossing the budget flips the goal to `budget-limited` and steers the agent once with a wrap-up instruction. Budget exhaustion is explicitly *not* completion.
- **Interrupt safety** — Esc interrupts pause the goal (never complete it); usage accumulated so far is kept. Resuming a session auto-pauses a still-active goal, since the run that owned it is gone.
- **`/goal` command** — `set <objective>`, `show`, `pause`, `resume`, `drop`, `budget <N|off>`, or an interactive menu when called without arguments. Typing an objective while a goal is active (or paused) is rejected with omp's status/warning; `/goal drop` and the menu's Drop confirm before discarding.
- **`/guided-goal [rough objective]`** — the agent interviews you in normal chat (success criteria, verification method, attempt cap, scope boundaries, stop conditions) and then creates the goal itself via `goal create`.
- **Footer status** — a `<icon> Goal <used/budget>` segment (omp `renderGoalMode` unicode icon set: 🎯 active, ⏸ paused, ⚠ budget-limited) while the goal is enabled or paused. Completed goals stay visible in the transcript after reloads via a persistent `goal-completed` entry renderer.
- **pi-todo integration** — when [pi-todo](../pi-todo) is installed, the goal context message includes a live `<todo_context>` block so continuations treat todos as current state, not stale transcript decoration.

## Install

```bash
pi install npm:@fyeeme/pi-goal
```

or copy/link this directory into `~/.pi/agent/extensions/` (global) or `.pi/extensions/` (project).

## Usage

```
/goal Ship the parser rewrite with all tests passing    # start working
/goal show                                              # objective, status, tokens, time
/goal budget 200000                                     # cap the spend
/goal pause            # ... later ...  /goal resume
/goal drop
```

Status line: a `<icon> Goal <used/budget>` segment appears in the footer while a goal is enabled or paused (omp footer segment semantics).

## Session persistence

Every transition writes a full snapshot entry (`goal-state`, `goal-cleared`, `goal-completed`) to the session. Restore scans the current branch backward, so forks and tree navigation restore branch-local state. Usage totals are derived from the session's own message entries — they survive compaction.

## Integration contract for other extensions

- Emits `goal_updated` on the shared extension event bus (`pi.events`) after every runtime transition: `{ goal: Goal | null, state: GoalModeState | undefined }`.
- Reads `todo_updated` events and `todo-phases` entries from pi-todo (works without pi-todo installed).

## Development

```bash
npm install --ignore-scripts
npm test        # vitest, 118 tests
npm run typecheck
```

## License

MIT
