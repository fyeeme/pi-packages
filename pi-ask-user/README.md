# pi-ask-user

- **Faithful omp port** — the tabbed ask dialog (Submit review tab, radio/checkbox markers, markdown/code previews with fence splitting and render caching), the inactivity countdown, and the legacy per-question selector path carried over file-by-file.
- **Compact transcript** — the pending call renders only an `Ask · N questions` summary; the result renders one compact `question → answer` line per question (multi-question lines prefixed `[id]`) — no framed block, no re-listed options.
- **Robustness fixes over the omp source** — countdown expiry mid-typing keeps the user's answer, live frame-width measurement replaces the hardcoded 80 columns, and dialog failures propagate instead of degrading to a phantom "user cancelled".
- **Headless-safe** — print/JSON hosts cannot prompt, so the tool is stripped from the active set; a stray call throws a "question was never shown" error instead of hanging.

oh-my-pi's `ask` tool, migrated to a [pi](https://github.com/earendil-works/pi-coding-agent) extension.

This is a source migration of the interactive ask feature from
[oh-my-pi](https://github.com/can1357/oh-my-pi) (a fork of badlogic/pi-mono), not a reimplementation: the tool flow,
the tabbed ask dialog, the legacy per-question selector path, and the result wording are carried over from
`packages/coding-agent/src/tools/ask.ts` and `src/modes/components/ask-dialog.ts`, then adapted file-by-file to pi's
public extension API. Sister extension of [pi-ask-user-lite](../pi-ask-user-lite); the two expose different tools
(`ask` vs `ask_user`) and should not be enabled together — see
[pi-ask-user or pi-ask-user-lite?](#pi-ask-user-or-pi-ask-user-lite) below.

## Features

- **Tabbed multi-question dialog** — one question per tab with `header` chips in the tab bar, radio markers for single-select, checkboxes for `multi`; select keys resolve through the injected `KeybindingsManager`, so rebound keys keep working.
- **Submit review gate** — calls with 3+ questions or any `multi` question get a Submit review tab before the answers go out; 1–2 single-select questions advance Enter-to-submit without a review page.
- **Markdown/code previews** — an option's `preview` (markdown, fenced code) renders fence-split with render caching. On wide terminals (inner width ≥ 80) the dialog splits into an options pane and a cursor-following preview pane (fzf-style); narrow terminals keep the preview inline under the cursored row.
- **Inline `Other` input with real editor semantics** — the dialog implements pi's `Focusable` contract and embeds a pi-tui `Input` that renders the input line itself: the hardware cursor and IME candidate window sit at the input point, with multi-char CJK IME commits, grapheme-aware cursor/delete (emoji as one unit), bracketed paste, kitty CSI-u decoding, undo, and kill ring. A countdown expiring mid-typing keeps the typed answer.
- **Inactivity countdown** — `timeoutSeconds` is an idle budget: dialog keypresses reset it (not while typing); expiry auto-picks the recommended option (or the first) and marks it `auto-selected after timeout`.
- **Compact transcript** — the pending call renders a single `Ask · N questions` line; the result renders one compact `question → answer` line per question (`[id]`-prefixed on multi-question calls) without re-listing unselected options.
- **omp semantics kept** — cancelling aborts the agent turn; headless hosts (print/JSON) strip the tool at `session_start` with an execute backstop that errors "question was never shown"; a terminal bell rings on ask (opt out with `PI_OMK_ASK_NOTIFY=0`); answers persist in the tool result `details`.

## What migrated

| oh-my-pi source | Here | Notes |
|---|---|---|
| `tools/ask.ts` — `AskTool.execute` | `index.ts` | result-count validation, empty-single-select cancellation (#8265), multi-question loop with navigation state, cancel-aborts-turn semantics |
| `tools/ask.ts` — `askSingleQuestion` + custom-input title windowing | `src/ask-legacy.ts` | multi-select toggle loop with `+ Done selecting`, recommended suffixes, `Other` via editor, timeout tolerance heuristic (`TIMEOUT_DETECTION_TOLERANCE_MS`), `(i/n)` progress titles |
| `modes/components/ask-dialog.ts` — `AskDialogComponent` | `src/ask-dialog.ts` | tabbed dialog, Submit review tab, radio/checkbox markers, markdown/code previews with fence splitting and render caching, fixed-height panel sizing, cursor-following scroll, inactivity countdown, malformed-args normalization |
| `modes/components/countdown-timer.ts` | `src/countdown-timer.ts` | verbatim |
| `modes/components/overlay-box.ts` (subset) | `src/overlay-box.ts` | `topBorder`/`divider`/`row`/`bottomBorder`/`fit` |
| `prompts/tools/ask.md` | `index.ts` | tool description, verbatim |
| theme symbol defaults (`modes/theme/symbols.ts`) | `src/compat.ts` | `❯ ◉ ○ ☑ ☐ ╭╮╰╯` |

## Adaptation notes (omp surface → pi extension API)

Each omp-internal surface maps onto the closest public pi extension boundary:

- **`AgentTool` + `createIf` gate** → `pi.registerTool` + `session_start` strip: print/JSON hosts cannot prompt, so the
  tool is removed from the active set; if it is still called, `execute` throws with a "question was never shown" error
  so the model stops retrying instead of misreading a cancel.
- **ArkType schema + reserved-label narrow** → typebox schema; the narrow runs at the top of `execute`.
- **`concurrency: "exclusive"`** → `executionMode: "sequential"` (pi tool batches).
- **`ExtensionUIContext.askDialog`** → `ctx.ui.custom()` mounting `AskDialogComponent`.
- **`#presentDialog` serial queue** → not needed: `ui.custom()` is a single editor slot and the sequential execution
  mode already serializes ask calls.
- **Nested `HookEditorComponent` prompts** (Other) → an embedded prompt mode inside the dialog: pi extensions own
  one custom component slot, so the dialog renders the input row itself (`#promptActive`) with Enter confirm / Esc back.
- **Keybindings** — omp's global `matchesSelectUp/…` matchers resolve through the `KeybindingsManager` pi injects into
  `ui.custom()`, so rebound select keys keep working; footer hints use the configured keys.
- **`ui.select` dialog options** — pi's select accepts only `{signal, timeout}`. The legacy path keeps the full omp
  `UIContext` logic (initial index, navigation, markers, timeout callbacks) and degrades on pi: no radio/checkbox
  markers, no initial cursor, no ←/→ question navigation, and option descriptions are dropped from the visible list.
- **`ui.editor` prompt style** → pi's `ui.editor` (multi-line) with a signal race; falls back to `ui.input`.
- **settings `ask.timeout` / `ask.notify`** → `timeoutSeconds` tool parameter + terminal bell, opt-out with
  `PI_OMK_ASK_NOTIFY=0` (pi extensions cannot read pi settings or send desktop notifications).
- **`ToolAbortError` + `context.abort()`** → `ctx.abort()` + thrown error (cancel aborts the agent turn, omp semantics).
- **Transcript renderer** — omp merges call+result in one framed block that updates in place when the user answers;
  pi's tool rows append the result render below the call render, so the call slot renders only a `Ask · N questions`
  summary line while pending, and the result slot renders one compact `question → answer` line per question
  (multi-question lines prefixed `[id]`, with the `auto-selected after timeout — not a user choice` marker).

**Dropped (no pi extension surface):** TTS vocalizer, plan-mode timeout suppression, collab guest racing, ACP
elicitation forms, `/tree` re-answer, `loadMode: "discoverable"`, the draft-editor input guard, and
`renderInlineMarkdown` for labels (labels render as plain text; block markdown in questions/previews still uses pi's
Markdown component + `getMarkdownTheme`). Post-2.0 the per-answer note subsystem and the dead chat-redirect surface
were also removed (see [Unreleased](./CHANGELOG.md)).

## Tool schema

```text
ask(
  questions: [
    {
      id: string              // stable identifier, echoed in the answer
      question: string        // shown to the user
      header?: string         // short chip in the tab bar
      options: [{
        label,
        description?,         // tradeoff text under the label
        preview?              // markdown / fenced code shown under the cursored option
      }]
      multi?: boolean         // allow multiple selections
      recommended?: number    // 0-based index; "(Recommended)" added automatically
    }
  ],
  timeoutSeconds?: number     // omp settings ask.timeout, parameterized; idle budget,
                             // dialog keypresses reset it (not while typing Other),
                             // expiry auto-picks the recommended option (or the first)
)
```

## Result semantics (omp wording, verbatim)

```text
User selected: JWT
User provided custom input: mTLS everywhere
User answers:
auth: JWT
deploy: [staging, prod]
deploy: staging (auto-selected after timeout)
```

Cancelling (Escape) aborts the agent turn — omp's "cancel the whole call" semantics, via `ctx.abort()` plus a tool
error. An unreachable host (print/JSON) raises a different error stating the question was never displayed.

## pi-ask-user or pi-ask-user-lite?

Sister packages with intentionally different scopes — pick one, do not enable both:

| | pi-ask-user (this one, tool `ask`) | pi-ask-user-lite (tool `ask_user`) |
|---|---|---|
| Lineage | File-by-file source port of oh-my-pi's `ask` tool | Pi-native reimplementation of the ask flow |
| Dialog | Tabbed dialog; Submit review tab for 3+ questions or any `multi`; fzf-style side-by-side preview pane on wide terminals | Single question-page dialog with `[n/m]` counter and per-question status strip; review page after the last question |
| Option rows | omp radio/checkbox markers | Numbered (`1. label`); answers echo the number back |
| Previews | Markdown/code, fence-split with render caching | Plain `preview` lines under the cursored option |
| Timeout | Inactivity countdown reset by keypresses (paused while typing); expiry auto-picks the recommended option | Whole-dialog budget; expiry auto-selects recommended and flags `timedOut` |
| Notes | Not available (removed post-2.0) | Per-answer notes via `n`, echoed to the LLM |
| Chat redirect | Removed (dead omp surface) | Reserved `Chat about this` row |
| Cancel | Aborts the agent turn (omp semantics) | Tool settles cancelled; the LLM is told to proceed conservatively |
| Extras | Terminal bell (opt out with `PI_OMK_ASK_NOTIFY=0`) | `/ask-demo` interactive battery |

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

## Development

```bash
npm install
npm run typecheck
npm test
```

## License

MIT — the migrated oh-my-pi sources retain their upstream origin (can1357/oh-my-pi, fork of badlogic/pi-mono).
