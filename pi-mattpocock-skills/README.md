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

The `ask-matt` router summary can be injected at session start (and after each compact) so the model discovers the router without you remembering to invoke it. Off by default: the reliable `/ask-matt` short command is enough for most users, and the bootstrap stays resident in context (~300 tokens/turn until compact). Mirrors superpowers' `context`-event injection pattern.

**Toggle (persisted):**

```
/matt-bootstrap          # toggle on/off (persisted)
/matt-bootstrap on       # enable
/matt-bootstrap off      # disable
```

The preference is stored at `~/.pi/agent/mattpocock.json` (`{ "bootstrap": <bool> }`) and **applies on the next session startup** (bootstrap handlers register once at load). This is the recommended way to persist the setting.

**One-shot enable for the current process:**

```bash
MATTPOCOCK_ENABLE_BOOTSTRAP=1 pi
```

Forces bootstrap on for that one session regardless of the persisted pref (enable-only; use `/matt-bootstrap off` to disable from the next session on — the env override keeps it active for the current session). Both honor `PI_CODING_AGENT_DIR` / `MATTPOCOCK_PREFS_FILE` for non-default agent dirs.

## Maintenance

When mattpocock adds/renames a user-invoked promoted skill, sync `COMMAND_TO_SKILL` in `src/commands.ts`. The command names and skill dirs currently match 1:1; the map is kept explicit so aliases and self-checks are one-place edits.
