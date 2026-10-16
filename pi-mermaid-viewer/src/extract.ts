import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { MermaidBlock } from "./types.ts";

export function extractMermaidBlocks(ctx: ExtensionCommandContext): MermaidBlock[] {
  const blocks: MermaidBlock[] = [];
  let idx = 0;

  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type !== "text" || !block.text) continue;
      for (const m of block.text.matchAll(/```mermaid\s*\n([\s\S]*?)```/g)) {
        idx += 1;
        blocks.push({ raw: m[1].trim(), label: `Diagram ${idx}` });
      }
    }
  }

  return blocks;
}

export function labelBlocks(blocks: MermaidBlock[]): void {
  blocks.reverse();
  blocks.forEach((b, i) => {
    if (blocks.length === 1) {
      b.label = "Diagram";
    } else {
      b.label = `#${blocks.length - i}${i === 0 ? " (latest)" : ""}`;
    }
  });
}
