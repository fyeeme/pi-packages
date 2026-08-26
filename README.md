# pi extensions

This directory contains official extensions for [pi](https://github.com/earendil-works/pi-coding-agent). Each extension is a standalone package that hooks into pi's `ExtensionAPI` to add functionality.

## 2.0.0 family release (2026-08-25)

A coordinated **major-version wave** across the sub-agent ecosystem:

- **[@fyeeme/pi-subagents 2.0.0](./pi-subagents)** — first npm release of the fan-out engine (subagent tool, dispatch core, live agent UI, workflow prompt presets); consumers compose its extension factory from a version-pinned npm dependency.
- **[@fyeeme/pi-review 2.0.0](./pi-review)** — sandwich refactor: methodology skills + orchestration prompts as data + 12 bundled finder/cleaner/verifier agents, composing pi-subagents for fan-out.
- **[@fyeeme/pi-dynamic-workflows 2.0.0](./pi-dynamic-workflows)** — composed sub-agent stack, journaled resumable runs, per-call budget override.
- **[@fyeeme/pi-ask-user-lite 2.0.0](./pi-ask-user-lite)** — first npm release: structured `ask_user` dialogs with review page, inline editor, numbered options.
- **[@fyeeme/pi-ask-user 2.0.0](./pi-ask-user)** — first npm release: oh-my-pi's tabbed `ask` dialog ported to pi's extension API.

All five install with `pi install npm:@fyeeme/<name>`; pi-review and pi-dynamic-workflows pull pi-subagents from npm automatically (no manual wiring).

## Extensions

## Extensions

| Package | Description |
|---------|-------------|
| [pi-ask-user-lite](./pi-ask-user-lite) | Structured `ask_user` tool — multi-question clarifying prompts with options, multi-select, recommended defaults, and free-form Other input |
| [pi-ask-user](./pi-ask-user) | oh-my-pi's `ask` tool migrated to a pi extension — source port of the tabbed ask dialog (review tab, notes, markdown/code previews, inactivity countdown), legacy per-question selector path, and omp result semantics |
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
