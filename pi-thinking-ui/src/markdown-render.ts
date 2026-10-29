/**
 * thinking-ui markdown emitter.
 *
 * Converts raw thinking text into the markdown string the registered
 * transformer returns, per the current ThinkingUIMode. Reuses the pure
 * heuristic engine in parse.ts (summarize / split / role) — no LLM, no async.
 *
 * Trade-off vs the removed ThinkingUIComponent (ANSI tree): the native
 * Markdown renderer draws whatever markdown we return, styled as thinking
 * text (dim/italic). The bespoke connector tree (├─└─) and live activity
 * pulse are gone; the summary text + per-step role icons survive.
 */
import type { ThinkingUIMode } from "./types.ts";
import { deriveStepCore, splitThinkingIntoStepTexts } from "./parse.ts";

/** Cap the summary-mode list so a long thinking run stays readable. */
const SUMMARY_LIST_LIMIT = 8;
/** Max chars of the first line shown for collapsed mode while streaming. */
const STREAMING_LINE_MAX = 80;

/**
 * LRU result cache for the finalize-path derivation. The transformer re-runs
 * on every re-render where the cached width changed (e.g. terminal resize) —
 * the thinking text is unchanged, so the result is fully reusable. Keyed by
 * (mode, text) since thinkingToMarkdown output does not depend on width.
 * Bounded to keep memory in check (each key holds a copy of the thinking text).
 */
const RESULT_CACHE_LIMIT = 50;
const resultCache = new Map<string, string>();

/** One blockquote line: role icon + summary. Derived via the fused parse.ts core. */
function collapseLine(text: string): string {
	const core = deriveStepCore(text);
	return `> ${core.icon} ${core.summary}`;
}

/**
 * Cheap view while the assistant message is still streaming, before the full
 * heuristic derivation runs on finalize. collapsed → first line (keeps the
 * "hide the bulk" intent without the O(n²) MMR cost); summary/expanded → pass
 * through so the user can read the live stream. The transformer must stay
 * "synchronous and inexpensive" (pi docs) and runs on every streaming chunk.
 */
export function streamingThinkingMarkdown(markdown: string, mode: ThinkingUIMode): string {
	if (mode !== "collapsed") return markdown;
	const line = markdown.split("\n").map((l) => l.trim()).find(Boolean);
	if (!line) return markdown;
	return `> ${line.length > STREAMING_LINE_MAX ? `${line.slice(0, STREAMING_LINE_MAX - 1)}…` : line}`;
}

/**
 * Transform a run of thinking markdown for the given mode (finalize/restore).
 *
 * - expanded: pass through verbatim (native renderer handles full text).
 * - collapsed: one blockquote line — role icon + the single best summary.
 * - summary: a markdown bullet list of derived step summaries (icon + summary),
 *   capped at SUMMARY_LIST_LIMIT with a `… (+N more)` tail.
 *
 * Result is memoized per (mode, text) — the expensive MMR derivation is not
 * re-run for unchanged text across re-renders (resize, restore, …).
 */
export function thinkingToMarkdown(markdown: string, mode: ThinkingUIMode): string {
	const cacheKey = `${mode}\u0000${markdown}`;
	const cached = resultCache.get(cacheKey);
	if (cached !== undefined) {
		// LRU refresh: move to the newest slot.
		resultCache.delete(cacheKey);
		resultCache.set(cacheKey, cached);
		return cached;
	}

	const result = computeThinkingToMarkdown(markdown, mode);

	resultCache.set(cacheKey, result);
	if (resultCache.size > RESULT_CACHE_LIMIT) {
		const oldestKey = resultCache.keys().next().value;
		if (oldestKey !== undefined) {
			resultCache.delete(oldestKey);
		}
	}
	return result;
}

function computeThinkingToMarkdown(markdown: string, mode: ThinkingUIMode): string {
	if (mode === "expanded") return markdown;

	const text = markdown.trim();
	if (!text) return markdown;

	if (mode === "collapsed") return collapseLine(text);

	const steps = splitThinkingIntoStepTexts(text);
	if (steps.length === 0) return collapseLine(text);

	const visible = steps.slice(0, SUMMARY_LIST_LIMIT);
	const lines = visible.map((step) => {
		const core = deriveStepCore(step);
		return `- ${core.icon} ${core.summary}`;
	});
	if (steps.length > visible.length) {
		lines.push(`- … (+${steps.length - visible.length} more)`);
	}
	return lines.join("\n");
}
