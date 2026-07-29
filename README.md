# pi extensions

This directory contains official extensions for [pi](https://github.com/earendil-works/pi-coding-agent). Each extension is a standalone package that hooks into pi's `ExtensionAPI` to add functionality.

## Extensions

| Package | Description |
|---------|-------------|
| [pi-dynamic-workflows](./pi-dynamic-workflows) | Deterministic TypeScript workflow orchestration — declarative typed steps with resumable, budget-bounded, abortable execution |
| [pi-hooks](./pi-hooks) | Claude Code-compatible hooks runner — reads `.pi/hooks.json` and maps lifecycle events to hook scripts |
| [pi-mermaid-viewer](./pi-mermaid-viewer) | Renders Mermaid diagrams from conversations as an HTML page in the default browser |
| [pi-peon-ping](./pi-peon-ping) | Routes pi lifecycle events through `peon.sh` for sound packs, desktop notifications, and trainer reminders |
| [pi-review](./pi-review) | Code review & cleanup — registers `/code-review` and `/code-simplify` commands with parallel subagent fan-out |
| [pi-session-name](./pi-session-name) | Auto-names pi sessions with LLM-generated titles for easy `pi --resume` scanning |
| [pi-statusline](./pi-statusline) | Rich custom status bar that replaces the default footer |
| [pi-thinking-ui](./pi-thinking-ui) | Faithful terminal-native thinking visualization with collapsed/summary/expanded modes |

## Install

Extensions can be installed globally (`~/.pi/agent/extensions/`) or per-project (`.pi/extensions/`). Refer to each extension's README for specific instructions.
