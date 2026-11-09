# pi extensions

[English](README.md) | [简体中文](README.zh-CN.md)

This directory contains official extensions for [pi](https://github.com/earendil-works/pi-coding-agent). Each extension is a standalone package that hooks into pi's `ExtensionAPI` to add functionality.

## 2.0.0 family release (2026-08-25)

A coordinated **major-version wave** across the sub-agent ecosystem:

- **[@fyeeme/pi-subagents 2.0.0](./pi-subagents)** — first npm release of the fan-out engine (subagent tool, dispatch core, live agent UI, workflow prompt presets); consumers compose its extension factory from a version-pinned npm dependency.
- **[@fyeeme/pi-review 2.0.0](./pi-review)** — sandwich refactor: methodology skills + orchestration prompts as data + 12 bundled finder/cleaner/verifier agents, composing pi-subagents for fan-out.
- **[@fyeeme/pi-ask-user 2.0.0](./pi-ask-user)** — first npm release: oh-my-pi's tabbed `ask` dialog ported to pi's extension API.

pi-review holds no npm dependency on pi-subagents — install pi-subagents separately alongside it when you need fan-out; without it, the fan-out levels degrade to a single-pass review.

## Extensions

| Package | Description |
|---------|-------------|
| [pi-ask-user](./pi-ask-user) | oh-my-pi's `ask` tool migrated to a pi extension — source port of the tabbed ask dialog (review tab, notes, markdown/code previews, inactivity countdown), legacy per-question selector path, and omp result semantics |
| [pi-goal](./pi-goal) | goal mode rewritten from mitsuhiko/agent-stuff goal.ts — session-log-backed long-running objective with `get_goal`/`create_goal`/`update_goal` tools, `/goal` command, 2M-default token budget accounting, automatic continuation turns, and strict completion/blocked audits |
| [pi-mermaid-viewer](./pi-mermaid-viewer) | Renders Mermaid diagrams from conversations as an HTML page in the default browser |
| [pi-notify](./pi-notify) | desktop notifications rewritten from mitsuhiko/agent-stuff `notify.ts` — OSC 777 notification on `agent_end` with the last assistant message (plain-markdown-flattened, terminal-sequence-stripped, 200-char truncated) as the body |
| [pi-subagents](./pi-subagents) | General-purpose `subagent` tool (single/parallel/chain) with three-source agent discovery, the shared dispatch core, and the live agent UI |
| [pi-review](./pi-review) | Review & cleanup assets — `/review` + `/simplify` dispatcher over declarative prompt templates, methodology skills, and finder/cleaner agent definitions |
| [pi-serena-hooks](./pi-serena-hooks) | Serena bridge — wires pi extension events to the `serena-hooks` CLI (`activate` / `remind` / `cleanup`); nudges the agent toward Serena's symbolic tools and blocks raw read/grep drift streaks |
| [pi-session-name](./pi-session-name) | Auto-names pi sessions with LLM-generated titles for easy `pi --resume` scanning |
| [pi-statusline](./pi-statusline) | Rich custom status bar that replaces the default footer |
| [pi-todo](./pi-todo) | file-based todos rewritten from mitsuhiko/agent-stuff `todos.ts` — `todo` tool (`list`/`list-all`/`get`/`create`/`update`/`append`/`delete`/`claim`/`release`) over markdown files in `.pi/todos` with per-todo locks, GC via `settings.json`, and a `/todos` interactive manager |
| [pi-virtual-model](./pi-virtual-model) | Virtual model router — `glm-5.3-auto` routes requests between `glm-5.3` and `glm-5.3-flash` by image presence; wall-clock switching picks `glm-5.3-flash` during weekday 14:00–18:00 Beijing time and `glm-5.3-auto` otherwise |
| [sessions-web](./sessions-web) | Read-only web viewer for local session history — `/session-web` serves `~/.pi/agent/sessions/` from `127.0.0.1` |

## Install

From npm (recommended):

```bash
# Global (user) install — available in every project
pi install npm:@fyeeme/<name>

# Project-local — written to .pi/settings.json
pi install -l npm:@fyeeme/<name>

# Try once without saving
pi -e npm:@fyeeme/<name>
```

Other package commands: `pi list` shows configured packages, `pi remove <source>` removes one, `pi update --extensions` reconciles installations.

Manual install: copy the package into `~/.pi/agent/extensions/` (global) or `.pi/extensions/` (per-project). Refer to each extension's README for specific instructions.
