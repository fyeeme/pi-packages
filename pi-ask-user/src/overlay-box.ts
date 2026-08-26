/**
 * Box-drawing chrome — migrated from oh-my-pi
 * (packages/coding-agent/src/modes/components/overlay-box.ts).
 *
 * Adaptation: `theme.boxRound` glyphs come from the local SYMBOLS constant
 * (pi's Theme has no symbol table); colors still route through pi's
 * theme.fg. Only the helpers the ask dialog uses were carried over.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { padding, SYMBOLS, truncateToWidth, visibleWidth } from "./compat.ts";

/** Pad or truncate a (possibly ANSI-styled) string to exactly `width` columns. */
export function fit(text: string, width: number): string {
	if (width <= 0) return "";
	const w = visibleWidth(text);
	if (w === width) return text;
	if (w < width) return text + padding(width - w);
	const cut = truncateToWidth(text, width, "");
	const cw = visibleWidth(cut);
	return cw < width ? cut + padding(width - cw) : cut;
}

/** Top border with an optional accent-colored title inset into the rule. */
export function topBorder(theme: Theme, width: number, title: string): string {
	const box = SYMBOLS.boxRound;
	const inner = Math.max(0, width - 2);
	if (!title) return theme.fg("border", box.topLeft + box.horizontal.repeat(inner) + box.topRight);
	const shown = truncateToWidth(` ${title} `, Math.max(0, inner - 2), "");
	const fillWidth = Math.max(0, inner - 1 - visibleWidth(shown));
	return (
		theme.fg("border", box.topLeft + box.horizontal) +
		theme.bold(theme.fg("accent", shown)) +
		theme.fg("border", box.horizontal.repeat(fillWidth) + box.topRight)
	);
}

/** A horizontal rule with left/right tees, splitting overlay sections. */
export function divider(theme: Theme, width: number): string {
	const box = SYMBOLS.boxRound;
	return theme.fg("border", box.teeRight + box.horizontal.repeat(Math.max(0, width - 2)) + box.teeLeft);
}

export function bottomBorder(theme: Theme, width: number): string {
	const box = SYMBOLS.boxRound;
	return theme.fg("border", box.bottomLeft + box.horizontal.repeat(Math.max(0, width - 2)) + box.bottomRight);
}

/** Wrap pre-styled content in vertical borders with single-column insets. */
export function row(theme: Theme, content: string, width: number): string {
	const box = SYMBOLS.boxRound;
	return `${theme.fg("border", box.vertical)} ${fit(content, Math.max(0, width - 4))} ${theme.fg("border", box.vertical)}`;
}
