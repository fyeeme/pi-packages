# virtual-models

Pi extension that registers the virtual model `zai-coding-cn/glm-5.3-auto` and routes each request between two physical models by image presence:

- A user message that carries images (attached image blocks or image file paths in the text) goes to `glm-5.3-flash`, which reads images natively.
- Any other user message goes to `glm-5.3` (text only).
- Tool follow-ups and retries stay on the model that handled the turn, so prompt caches and thinking signatures stay valid. Exception: when a new tool result delivers an image while `glm-5.3` is answering, the next request switches to `glm-5.3-flash`.
- Requests outside the agent loop (e.g. compaction summaries) go to flash when the conversation contains images, else to `glm-5.3`.

The extension keeps a cache of resolved `Model` objects so routing still works when the extension ctx is stale (ThinkRail shares one model runtime across chat sessions; see the header comment in `index.ts`).

## Usage

Select `zai-coding-cn/glm-5.3-auto` in `/model` (or add it to `enabledModels`).

## Install for development

Symlink the package directory into the user extensions directory:

```bash
ln -s "$PWD/packages/extensions/pi-virtual-models" ~/.pi/agent/extensions/pi-virtual-models
```

`index.ts` only uses `import type`, so pi loads it through jiti without `npm install`. Run `npm install --ignore-scripts` in this directory before `npm run typecheck`.
