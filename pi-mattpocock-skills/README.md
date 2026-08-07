# @fyeeme/pi-mattpocock-skills

pi extension that maps [mattpocock/skills](https://github.com/mattpocock/skills) user-invoked skills to short slash commands (`/grill-me` instead of `/skill:grill-me`), with an opt-in `ask-matt` router bootstrap.

## How it works

Each short command reads the corresponding `SKILL.md`, strips frontmatter, and injects a pi `<skill>` block via `sendUserMessage` — byte-identical to pi's built-in `/skill:<name>` expansion (see `_expandSkillCommand` in `agent-session.ts`). The content is guaranteed to reach the model and renders with the `[skill]` label.

## Prerequisite

mattpocock skills must be symlinked into `~/.pi/agent/skills/` (path A). This extension does **not** bundle skills — it only maps command names to skill directories. If a symlink is missing, the command's `readFileSync` throws and surfaces naturally.

## Install

```bash
# local development
pi -e packages/extensions/pi-mattpocock-skills

# published
pi install @fyeeme/pi-mattpocock-skills
```

## Commands (13)

`/grill-me` `/ask-matt` `/grill-with-docs` `/implement` `/to-spec` `/to-tickets` `/triage` `/wayfinder` `/improve-codebase-architecture` `/setup-matt-pocock-skills` `/handoff` `/teach` `/writing-great-skills`

Model-invoked skills (`tdd`, `diagnosing-bugs`, `code-review`, `domain-modeling`, `codebase-design`, `prototype`, `research`, `resolving-merge-conflicts`, `grilling`) are already in pi's system prompt and fire automatically — no command needed.

## Bootstrap (opt-in, default off)

Set `MATTPOCOCK_ENABLE_BOOTSTRAP=1` to inject an `ask-matt` router summary at session start (and after each compact). Off by default: the reliable `/ask-matt` short command is enough for most users, and the bootstrap stays resident in context (~300 tokens/turn until compact). Mirrors superpowers' `context`-event injection pattern.

## Maintenance

When mattpocock adds/renames a user-invoked promoted skill, sync `COMMAND_TO_SKILL` in `src/commands.ts`. The command names and skill dirs currently match 1:1; the map is kept explicit so aliases and self-checks are one-place edits.
