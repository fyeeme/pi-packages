/**
 * pi-mermaid-viewer
 *
 * Renders Mermaid diagrams found in the conversation as an HTML page
 * opened in the default browser. Supports dark/light themes, zoom,
 * PNG export, and split source view.
 *
 * Full mermaid@12 diagram coverage (same rendering stack as mermaid.live,
 * which runs v12 with the redux theme family as its default look):
 * - all built-in types render from the CDN ESM build, including the
 *   lazy ELK layout chunks (flowchart-elk) — no registration needed
 * - ZenUML registers at runtime from @mermaid-js/mermaid-zenuml (CDN)
 * - FontAwesome icon nodes (fa:fa-*, icon:*) load the FA webfont in
 *   <head> and wait for it before the first render
 */

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export { quoteBareLabels } from "./src/healer.ts";
export { renderHtml } from "./src/render.ts";
export { extractMermaidBlocks, labelBlocks } from "./src/extract.ts";
export { parseGnomeColorScheme, parseWindowsLightTheme } from "./src/theme.ts";
export type { DiagramData, MermaidBlock } from "./src/types.ts";

import { extractMermaidBlocks, labelBlocks } from "./src/extract.ts";
import { detectSystemTheme } from "./src/theme.ts";
import { renderHtml } from "./src/render.ts";
import { openInBrowser } from "./src/browser.ts";
import type { DiagramData } from "./src/types.ts";

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("mermaid", {
		description: "Render Mermaid diagrams from the conversation in the browser",

		handler: async (_args, ctx: ExtensionCommandContext) => {
			const blocks = extractMermaidBlocks(ctx);

			if (blocks.length === 0) {
				ctx.ui.notify("No Mermaid diagrams found in the conversation.", "error");
				return;
			}

			labelBlocks(blocks);

			const diagrams: DiagramData[] = blocks.map((b) => ({
				code: b.raw,
				label: b.label,
			}));

			const theme = detectSystemTheme();
			const html = renderHtml(diagrams, theme);
			// Per-process fixed name: each run overwrites the previous preview
			// instead of accumulating timestamped files in tmpdir.
			const path = join(tmpdir(), `pi-mermaid-preview-${process.pid}.html`);

			writeFileSync(path, html, "utf-8");
			openInBrowser(path, ctx);
		},
	});
}
