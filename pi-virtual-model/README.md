# pi-virtual-model

Model selection routing for pi. Two cooperating strategies in one extension:

## 1. Virtual model `glm-5.3-auto` (image routing)

Registers `zai-coding-cn/glm-5.3-auto` and routes each request between two physical models by image presence:

- A user message that carries images (attached image blocks or image file paths in the text) goes to `glm-5.3-flash`, which reads images natively.
- Any other user message goes to `glm-5.3` (text only).
- Tool follow-ups and retries stay on the model that handled the turn, so prompt caches and thinking signatures stay valid. Exception: when a new tool result delivers an image while `glm-5.3` is answering, the next request switches to `glm-5.3-flash`.
- Requests outside the agent loop (e.g. compaction summaries) go to flash when the conversation contains images, else to `glm-5.3`.

The extension keeps a cache of resolved `Model` objects so routing still works when the extension ctx is stale (ThinkRail shares one model runtime across chat sessions; see the header comment in `src/virtual-model.ts`).

## 2. Wall-clock switching (timezone rule)

| Beijing time (UTC+8) | Session model |
|---|---|
| before 14:18:00 | `zai-coding-cn/glm-5.3-flash` |
| 14:18:00 and later | `zai-coding-cn/glm-5.3-auto` |

- The rule runs on `session_start` and before every agent run, so a session left open across the cutoff switches on the next message.
- Switching is idempotent: no `model_change` entry is appended when the current model already matches the rule.
- A successful switch (or a missing model) is reported through one `ui.notify` line.
- Manual `/model` picks are overridden on the next prompt — both enabled models are governed by the rule, so this is intentional.
- Beijing time has no daylight saving time, so a plain UTC+8 offset is exact year-round; the host timezone setting is irrelevant.

## Usage

The timezone rule takes effect on load. Select `zai-coding-cn/glm-5.3-auto` in `/model` (or add it to `enabledModels`) for the image routing to be reachable after the cutoff.

## Install for development

Symlink the package directory into the user extensions directory:

```bash
ln -s "$PWD/packages/extensions/pi-virtual-model" ~/.pi/agent/extensions/pi-virtual-model
```

`index.ts` only uses `import type`, so pi loads it through jiti without `npm install`. Run `npm install --ignore-scripts` in this directory before `npm run typecheck`.

This package merges and supersedes `@fyeeme/pi-virtual-models` and `@fyeeme/pi-timezone-model`.
