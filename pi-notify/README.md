# pi-notify

Desktop notifications for [pi](https://github.com/earendil-works/pi-coding-agent): when the agent finishes a run and is waiting for your input, a native terminal notification pops with the last thing it said.

Packaged from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) `extensions/notify.ts` (Apache-2.0). The implementation is carried over as-is; single-file `index.ts`, no build step, no dependencies.

## What it does

- **OSC 777 notifications** — writes `ESC ] 777 ; notify ; title ; body BEL` to stdout on every `agent_end`. Supported terminals: **Ghostty, iTerm2, WezTerm, rxvt-unicode**. Not supported: Kitty (uses OSC 99), Terminal.app, Windows Terminal, Alacritty.
- **Body from the last assistant message** — rendered through a plain markdown theme (no styling, links keep only their label), stripped of terminal sequences and control characters (an embedded OSC 8 hyperlink would truncate the notification), whitespace collapsed onto one line, truncated to 200 characters with `…`.
- **Title** — `π` when there is a body; `Ready for input` with an empty body when the last assistant message has no text.

## Install

```bash
pi install npm:@fyeeme/pi-notify
```

or copy/link this directory into `~/.pi/agent/extensions/` (global) or `.pi/extensions/` (project).

## Usage

Nothing to configure — installed means active. Run a task, switch away from the terminal, and the notification tells you when pi is waiting.

## Development

```bash
npm install --ignore-scripts
npm test        # vitest
npm run typecheck
```

## License

MIT. Derived from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) `extensions/notify.ts` (Apache-2.0).
