/**
 * pi-tui compatibility layer for the migrated oh-my-pi ask UI.
 *
 * oh-my-pi forked the pi tui package and added helpers/symbols the ask dialog
 * depends on. pi's published `@earendil-works/pi-tui` does not export them, so
 * this module re-implements the small surface the migration needs, mirroring
 * omp semantics:
 *
 * - Ellipsis/padding/replaceTabs: omp utils.ts helpers.
 * - SYMBOLS: omp theme symbol defaults (modes/theme/symbols.ts) — pi's Theme
 *   has no symbol table, so the glyphs are fixed constants here and colored
 *   through pi's theme.fg.
 * - renderInlineMarkdown: omp's version is backed by a full marked lexer
 *   pi-tui does not export; labels render as plain text with the base color.
 * - windowLines: omp's ScrollView(lines, {height}).setScrollOffset(n) string
 *   window — pi's ScrollView is a layout container over a Component and cannot
 *   window a plain string[] in a custom component's render().
 *
 * Markdown rendering itself uses pi's own Markdown component + getMarkdownTheme
 * (both exported by @earendil-works/pi-coding-agent), which match omp 1:1.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export { truncateToWidth, visibleWidth, matchesKey, Key } from "@earendil-works/pi-tui";

/** omp Ellipsis.Unicode ("…"). pi's truncateToWidth takes the glyph directly. */
export const ELLIPSIS = "…";

export function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(value, max));
}

/** omp utils.ts replaceTabs: tabs render inconsistently — replace with spaces. */
export function replaceTabs(text: string): string {
	return text.replaceAll("\t", "    ");
}

/** omp utils.ts padding: n spaces (n clamped at 0). */
export function padding(n: number): string {
	return n > 0 ? " ".repeat(n) : "";
}

/** omp theme symbol defaults (modes/theme/symbols.ts). */
export const SYMBOLS = {
	nav: { cursor: "❯", selected: "➤" },
	radio: { selected: "◉", unselected: "○" },
	checkbox: { checked: "☑", unchecked: "☐" },
	boxRound: {
		topLeft: "╭",
		topRight: "╮",
		bottomLeft: "╰",
		bottomRight: "╯",
		horizontal: "─",
		vertical: "│",
		teeRight: "├",
		teeLeft: "┤",
	},
	status: { success: "+", warning: "~" },
	format: { bullet: "•" },
} as const;

/** omp renderInlineMarkdown is backed by a full marked lexer pi-tui does not
 *  export; labels render as plain (ANSI-passthrough) text with the base color. */
export function renderInlineMarkdown(text: string, baseColor?: (t: string) => string): string {
	if (typeof text !== "string") return (baseColor ?? (t => t))(text != null ? String(text) : "");
	return (baseColor ?? (t => t))(text);
}

/**
 * Window `lines` to `rows` starting at `offset`, padding short content with
 * blank rows (omp ScrollView semantics: the body area never shrinks). A
 * trailing column is NOT reserved for a scrollbar; callers render the omp
 * ↑/↓/↕ clip indicator in the footer instead.
 */
export function windowLines(lines: readonly string[], offset: number, rows: number): string[] {
	const out: string[] = [];
	for (let i = 0; i < rows; i++) {
		out.push(lines[offset + i] ?? "");
	}
	return out;
}

/** omp ask-dialog #clipIndicator: which scroll directions have hidden content. */
export function clipIndicator(offset: number, rows: number, totalRows: number): string {
	const above = offset > 0;
	const below = offset + rows < totalRows;
	if (above && below) return "↕";
	if (above) return "↑";
	if (below) return "↓";
	return "";
}

/** Format a KeybindingsManager key list the way omp's formatKeyHints does. */
export function formatKeyHints(keys: readonly string[]): string {
	return keys.join("/");
}

/** Normalize a key label for footer hints (omp editorKey/cancelKeyLabel). */
export function keyLabel(keys: readonly string[], fallback: string): string {
	const [first = ""] = formatKeyHints(keys).split("/");
	if (!first) return fallback;
	return first === "escape" ? "Esc" : first === "pageup" ? "PgUp" : first === "pagedown" ? "PgDn" : first;
}
