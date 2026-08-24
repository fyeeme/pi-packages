# pi-ask-user

**2.0.0 — first npm release**, part of the 2.0 extensions family wave. Release highlights:

- **Review page** — multi-question dialogs summarize every answer (custom inputs, notes, unanswered warnings) before submitting; `enter` confirms, `left` revises.
- **Inline free-text editor** — `Other` answers and notes type directly inside the dialog (option list stays visible, `esc` returns, empty submit declines).
- **Numbered options** — rows render `1. label` and answers echo the number back (`auth: 1. JWT`), plus a per-question status strip and `tab`/`shift+tab` navigation.
- Selection semantics hardened: single-select no longer stacks markers, multi-select `enter` with nothing checked is a no-op, custom `Other` answers clear stale checkboxes.

Structured `ask_user` tool for [pi](https://github.com/earendil-works/pi-coding-agent). It lets the LLM surface clarifying questions with selectable options while it works, instead of guessing when choices have materially different tradeoffs.

Ported from the interactive ask flow of [oh-my-pi](https://github.com/can1357/oh-my-pi), adapted to pi's public extension API.

## Features

- **Multiple questions in one dialog** — all questions presented through a single dialog with a `[1/3]` progress counter and a per-question status strip (`● Framework  ○ Style`); `←` revisits earlier questions to revise answers (cursor and selections preserved), `→` moves forward once the current question is answered.
- **Review before submit** — after the last question, multi-question dialogs show a summary page listing every answer (custom inputs, notes, unanswered warnings); `enter` confirms, `←` goes back to revise. Single-question dialogs still submit immediately.
- **Smart advance** — answering jumps to the next unanswered question, or straight to the review page once everything is answered; revising an earlier answer never forces a re-walk of already-answered ones.
- **Single or multi select** — `multi: true` renders checkboxes (`space` toggles, `enter` records the set and is a no-op while nothing is checked); single-select renders radio markers with the recommended option pre-cursored and suffixed `(Recommended)`.
- **Timeout auto-selection** — optional `timeoutSeconds` budget for the whole dialog; on expiry unanswered questions auto-select the recommended option (or the first) and are flagged `timedOut` so the LLM knows no human chose them.
- **Option descriptions & previews** — short tradeoff text under each label; an option's `preview` lines render while the cursor rests on it. Options render and echo back numbered (`1. label`), so answers read `auth: 1. JWT`.
- **Free-form "Other"** — every question gets an automatic `Other (type your own)` row that opens an editor embedded in the dialog: the option list stays visible while typing, `esc` returns to the rows, and an empty submit declines. Re-selecting an option clears a previous custom input.
- **Answer notes** — press `n` to attach a note through the same inline editor (prefilled when revising); notes are echoed back to the LLM.
- **"Chat about this" redirect** — a reserved row that ends the call with a `chatRedirect` result, telling the LLM the user prefers discussing over answering.
- **Abort-safe** — if the agent turn is aborted while a question is open, the dialog closes and the tool settles as cancelled instead of hanging.
- **Branch-safe state** — answers live in the tool result `details`, so `/tree` branching and session replay see exactly what was asked and answered.
- **Headless-safe** — throws a proper tool error in `-p`/JSON modes instead of hanging.

## Tool schema

```text
ask_user(
  questions: [
    {
      id: string              // stable identifier, echoed in the answer
      question: string        // shown to the user
      header?: string         // short chip rendered next to the progress counter
      options: [{             // 2-6 options
        label,
        description?,         // tradeoff text under the label
        preview?              // lines shown while the cursor rests on the option
      }]
      multi?: boolean         // allow multiple selections
      recommended?: number    // 0-based index of the recommended option
    }
  ],
  timeoutSeconds?: number     // overall budget; expiry auto-selects recommended
)
```

## Keys

| Key | Action |
|-----|--------|
| `up` / `down` | Move cursor across rows |
| `space` | Toggle checkbox (multi-select only) |
| `enter` | Select / record answer / advance to the next unanswered question (no-op in multi-select with nothing checked); on the review page, submit |
| `←` / `→` | Previous / next question (`→` requires an answer first) |
| `tab` / `shift+tab` | Aliases for `→` / `←` |
| `n` | Attach a note to the current answer |
| `esc` | Cancel the whole call (inside the inline editor: back to the rows) |

## Trying it out: `/ask-demo`

The extension registers an interactive battery that exercises every feature end-to-end:

1. **All question types** — single-select with `(Recommended)` + cursor-rest `preview`, multi-select checkboxes, and an `Other (type your own)` free-form answer (add a note with `n` on the last question), then confirm on the review page.
2. **Timeout** — a dialog with a 6-second budget; do nothing and watch it auto-select the recommended option.
3. **Chat redirect** — pick the `Chat about this` row.
4. **Cancel** — press `Esc` on the first of two questions and confirm the second is never asked.

Each phase reports the collected answers back through a notification so you can verify what the LLM would receive.

## Install

```bash
# per-project
mkdir -p .pi/extensions && cp -r packages/extensions/pi-ask-user .pi/extensions/

# or globally
cp -r packages/extensions/pi-ask-user ~/.pi/agent/extensions/
```

Or load ad hoc:

```bash
pi -e ./packages/extensions/pi-ask-user/index.ts
```

## Usage

Just ask the agent something ambiguous; with the tool active the LLM can call:

```json
{
  "questions": [
    {
      "id": "storage",
      "question": "Which storage backend should this feature use?",
      "options": [
        { "label": "SQLite", "description": "Zero-config, file-based" },
        { "label": "PostgreSQL", "description": "Full server, richer types" }
      ],
      "recommended": 0
    },
    {
      "id": "flags",
      "question": "Which extras should be enabled?",
      "multi": true,
      "options": [{ "label": "Telemetry" }, { "label": "Auto-update" }]
    }
  ]
}
```

The user picks with arrow keys (`space` toggles in multi mode, `enter` submits, `←` revises earlier answers, `esc` cancels). Cancelling marks the call cancelled and tells the LLM to proceed conservatively.

## Boundaries

- Requires an interactive session (TUI or RPC); in print/JSON mode the tool errors out.
- No per-question timers: `timeoutSeconds` budgets the whole dialog, not each question.
- No TTS, system-level notifications, or `/tree` re-answer branching — pi's extension API does not expose those surfaces; answers remain inspectable via persisted `details`.

## Development

```bash
npm install --ignore-scripts
npm run typecheck
npm test
```

## License

MIT
