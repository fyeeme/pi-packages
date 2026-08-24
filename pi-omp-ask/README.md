# pi-omp-ask

**2.0.0 — first npm release as `@fyeeme/pi-omp-ask`** (renamed from the local `pi-omk-ask` working name), part of the 2.0 extensions family wave. Release highlights:

- **Faithful omp port** — the tabbed ask dialog (Submit review tab, radio/checkbox markers, per-answer notes, markdown/code previews with fence splitting and render caching), the inactivity countdown, and the legacy per-question selector path carried over file-by-file.
- **Single-render transcript** — the pending call renders only an `Ask · N questions` summary; the full framed question/options/answer block renders once after the user answers (no duplicate framing).
- **Robustness fixes over the omp source** — countdown expiry mid-typing keeps the user's answer, live frame-width measurement replaces the hardcoded 80 columns, and dialog failures propagate instead of degrading to a phantom "user cancelled".
- **Headless-safe** — print/JSON hosts cannot prompt, so the tool is stripped from the active set; a stray call throws a "question was never shown" error instead of hanging.

oh-my-pi's `ask` tool, migrated to a [pi](https://github.com/earendil-works/pi-coding-agent) extension.

This is a source migration of the interactive ask feature from
[oh-my-pi](https://github.com/can1357/oh-my-pi) (a fork of badlogic/pi-mono), not a reimplementation: the tool flow,
the tabbed ask dialog, the legacy per-question selector path, and the result wording are carried over from
`packages/coding-agent/src/tools/ask.ts` and `src/modes/components/ask-dialog.ts`, then adapted file-by-file to pi's
public extension API. Sister extension of [pi-ask-user](../pi-ask-user); the two expose different tools
(`ask` vs `ask_user`) but should not be enabled together.

## What migrated

| oh-my-pi source | Here | Notes |
|---|---|---|
| `tools/ask.ts` — `AskTool.execute` | `index.ts` | chat redirect, result-count validation, empty-single-select cancellation (#8265), multi-question loop with navigation state, cancel-aborts-turn semantics |
| `tools/ask.ts` — `askSingleQuestion` + custom-input title windowing | `src/ask-legacy.ts` | multi-select toggle loop with `+ Done selecting`, recommended suffixes, `Other` via editor, timeout tolerance heuristic (`TIMEOUT_DETECTION_TOLERANCE_MS`), `(i/n)` progress titles |
| `modes/components/ask-dialog.ts` — `AskDialogComponent` | `src/ask-dialog.ts` | tabbed dialog, Submit review tab, radio/checkbox markers, per-answer notes with `noteForSubmittedAnswer` semantics, markdown/code previews with fence splitting and render caching, fixed-height panel sizing, cursor-following scroll, inactivity countdown, malformed-args normalization |
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
- **Nested `HookEditorComponent` prompts** (Other/note) → an embedded prompt mode inside the dialog: pi extensions own
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
  summary line while pending, and the result slot renders the full framed question/options/answer block once (same
  frame, markers, notes, custom-input lines, and the `auto-selected after timeout — not a user choice` marker).

**Dropped (no pi extension surface):** TTS vocalizer, plan-mode timeout suppression, collab guest racing, ACP
elicitation forms, `/tree` re-answer, `loadMode: "discoverable"`, the draft-editor input guard, and
`renderInlineMarkdown` for labels (labels render as plain text; block markdown in questions/previews still uses pi's
Markdown component + `getMarkdownTheme`).

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
                             // dialog keypresses reset it (not while typing Other/note),
                             // expiry auto-picks the noted or recommended option
)
```

## Result semantics (omp wording, verbatim)

```text
User selected: JWT
User provided custom input: mTLS everywhere
User added note: prod only
User answers:
auth: JWT
deploy: [staging, prod] (note: prod only)
deploy: staging (auto-selected after timeout)
```

Cancelling (Escape) aborts the agent turn — omp's "cancel the whole call" semantics, via `ctx.abort()` plus a tool
error. An unreachable host (print/JSON) raises a different error stating the question was never displayed.

## Install

```bash
# per-project
mkdir -p .pi/extensions && cp -r packages/extensions/pi-omp-ask .pi/extensions/

# or globally
cp -r packages/extensions/pi-omp-ask ~/.pi/agent/extensions/
```

Or load ad hoc:

```bash
pi -e ./packages/extensions/pi-omp-ask/index.ts
```

## Development

```bash
npm install
npm run typecheck
npm test
```

## License

MIT — the migrated oh-my-pi sources retain their upstream origin (can1357/oh-my-pi, fork of badlogic/pi-mono).
