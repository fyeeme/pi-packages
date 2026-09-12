**Tasks: verbatim content strings, NEVER auto-generated IDs; no "task-1"/"task-N". Pass content in `task`.**

## Operations

|`op`|Fields|Effect|
|---|---|---|
|`init`|`list: [{phase, items: string[]}]`|Initialize full list; replaces existing|
|`init`|`items: string[]`|Flattened single-phase init|
|`start`|`task`|Mark in progress|
|`done`|`task` or `phase`|Mark completed|
|`drop`|`task` or `phase`|Mark abandoned|
|`block`|`task` or `phase`; optional `reason`|Mark blocked: open, awaiting external input|
|`unblock`|`task` or `phase`|Blocked task → `pending`|
|`rm`|optional `task` or `phase`|Remove task/phase; omit both → clear|
|`append`|`phase`; `items: string[]`|Append tasks to phase; lazily creates phase|
|`view`|—|Read-only; echo list|

## Anatomy

- Task content: 5–10 words; what, not how; unique identifier.
- Phase name: short noun phrase (e.g. `Foundation`, `Auth`, `Verification`); unique identifier. NEVER prefix `1.`, `A)`, `Phase 1:`.

## Rules

- Keep introduced `task`/`phase` strings stable: they are the lookup keys for every later op.
- Lost exact task text: `view` echoes list; NEVER guess from memory.
