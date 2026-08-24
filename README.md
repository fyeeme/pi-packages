# pi extensions

This directory contains official extensions for [pi](https://github.com/earendil-works/pi-coding-agent). Each extension is a standalone package that hooks into pi's `ExtensionAPI` to add functionality.

## Extensions

| Package | Description |
|---------|-------------|
| [pi-ask-user](./pi-ask-user) | Structured `ask_user` tool — multi-question clarifying prompts with options, multi-select, recommended defaults, and free-form Other input |
| [pi-omk-ask](./pi-omk-ask) | oh-my-pi's `ask` tool migrated to a pi extension — source port of the tabbed ask dialog (review tab, notes, markdown/code previews, inactivity countdown), legacy per-question selector path, and omp result semantics |
| [pi-dynamic-workflows](./pi-dynamic-workflows) | Deterministic TypeScript workflow orchestration — declarative typed steps with resumable, budget-bounded, abortable execution |
| [pi-hooks](./pi-hooks) | Claude Code-compatible hooks runner — reads `.pi/hooks.json` and maps lifecycle events to hook scripts |
| [pi-mermaid-viewer](./pi-mermaid-viewer) | Renders Mermaid diagrams from conversations as an HTML page in the default browser |
| [pi-peon-ping](./pi-peon-ping) | Routes pi lifecycle events through `peon.sh` for sound packs, desktop notifications, and trainer reminders |
| [pi-subagents](./pi-subagents) | General-purpose `subagent` tool (single/parallel/chain) with three-source agent discovery, the shared dispatch core, and the live agent UI |
| [pi-review](./pi-review) | Review & cleanup assets — `/review` + `/simplify` dispatcher over declarative prompt templates, methodology skills, and finder/cleaner agent definitions |
| [pi-session-name](./pi-session-name) | Auto-names pi sessions with LLM-generated titles for easy `pi --resume` scanning |
| [pi-statusline](./pi-statusline) | Rich custom status bar that replaces the default footer |
| [pi-thinking-ui](./pi-thinking-ui) | Faithful terminal-native thinking visualization with collapsed/summary/expanded modes |

## Install

Extensions can be installed globally (`~/.pi/agent/extensions/`) or per-project (`.pi/extensions/`). Refer to each extension's README for specific instructions.
