# pi-session-name

Auto-name your [pi](https://pi.dev) sessions with a short, LLM-generated title so
`pi --resume` lists are easy to scan — instead of the raw first message.

## Install

```bash
# Global (user) install
pi install npm:@fyeeme/pi-session-name

# Project-local (.pi/settings.json)
pi install -l npm:@fyeeme/pi-session-name

# Try once without saving
pi -e npm:@fyeeme/pi-session-name
```

Requires pi `>= 0.80.0` (uses the `agent_settled` / `session_info_changed` events).

## Behavior

- When the first agent run of a session **settles**, the extension asks the model
  for a descriptive title (same language as your first message) — key entity +
  action + goal, not a terse label — and writes it via `setSessionName`. It then
  shows up in the resume picker immediately.
- **Never overwrites a name you set manually** (`/name`, `--name`, the picker's
  rename, or any other extension). Once it detects an external rename it locks
  itself for the rest of the session.
- Two modes (config `mode`):
  - `first` (default) — name once, then leave it alone.
  - `auto` — re-evaluate each turn; the model replies `KEEP` or a new title, so
    the name tracks the current topic.
- **`/rename [name]`** — manually rename the current session on demand. With a
  name argument it sets that name; with no argument it generates one from the
  conversation (same descriptive prompt as auto-naming). Invoking `/rename` is a
  manual action, so it locks out background auto-naming for the rest of the
  session — you've taken control.

## Configuration

Create `.pi/session-name.json` in your project root:

```json
{ "mode": "auto", "maxLength": 200, "model": { "provider": "openai", "id": "gpt-4o-mini" } }
```

| Option | Default | Env override | Notes |
|---|---|---|---|
| `mode` | `"first"` | `PI_SESSION_NAME_MODE` | `first` \| `auto` |
| `maxLength` | `200` | `PI_SESSION_NAME_MAX_LENGTH` | Title character cap |
| `enabled` | `true` | `PI_SESSION_NAME_ENABLED=false` | Master switch |
| `model` | current session model | `PI_SESSION_NAME_MODEL_PROVIDER` + `PI_SESSION_NAME_MODEL_ID` | Override the model used to generate titles |

By default the extension uses the model you're already chatting with (`ctx.model`),
so no extra API key is needed.

## Failure handling

If the model is unavailable, has no API key, or returns garbage, the extension
stays silent — your session is never blocked. It retries on the next turn while
the session is still unnamed.

## Manual smoke test

1. `pi -e ./packages/extensions/pi-session-name/index.ts`, ask a question in a
   fresh session, wait for the reply → the resume picker shows a generated title.
2. `/name foo`, chat a few turns → name stays `foo` (locked).
3. `mode: "auto"`: shift topic across turns → name updates; same topic → stays.
4. `/rename foo` → name becomes `foo` and stays (locked). `/rename` with no
   argument → generates a fresh name from the conversation.
5. Unset the model's API key → no errors, session runs normally.
