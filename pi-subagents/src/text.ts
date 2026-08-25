/**
 * text.ts — defensive Message.content text extraction.
 *
 * One extractor for the text carried by a pi-ai `Message.content` (string or
 * content-block array), plus the assistant-report helper shared by every
 * fan-out consumer (the `subagent` tool, /code-simplify's handler fan-out,
 * the conversation viewer). These were previously hand-rolled per consumer —
 * and the copies drifted: one joined ALL assistant turns, leaking interim
 * "Let me check…" chatter into the parent context while another took only
 * the final report.
 */
import type { Message } from "@earendil-works/pi-ai";

/** Text blocks of one message content. Defensive: unknown shapes → []. */
export function contentTextBlocks(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	const out: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "text") continue;
		const text = (block as { text?: unknown }).text;
		if (typeof text === "string") out.push(text);
	}
	return out;
}

/** Concatenated text of one message content (text blocks joined with "\n"). */
export function contentText(content: unknown): string {
	return contentTextBlocks(content).join("\n");
}

/**
 * The text of the FINAL run of consecutive assistant messages — the agent's
 * report. Interim progress chatter ("Let me check …") from earlier turns is
 * excluded: a tool result (or any non-assistant message) breaks the run, so
 * only the trailing assistant block(s) survive. A final turn that carries no
 * text (a toolCall-only closing message — common when maxTurns/ESC cut the
 * agent mid-tool) yields "", never a fallback into the earlier chatter.
 */
export function lastAssistantText(messages: Message[]): string {
	const parts: string[] = [];
	for (let i = messages.length - 1; i >= 0; i--) {
		if ((messages[i] as { role?: unknown }).role !== "assistant") break;
		parts.unshift(contentText((messages[i] as { content?: unknown }).content).trim());
	}
	return parts.join("\n").trim();
}

// ---------------------------------------------------------------------------
// Explicit result contract (omp parity)
// ---------------------------------------------------------------------------

/** How the final result text handed to the caller was obtained. */
export type ResultExtractMethod = "result-block" | "assistant-text" | "none";

export interface ExtractedResult {
	/** The extracted final output; never an empty string. */
	text: string;
	method: ResultExtractMethod;
}

/** Explicit placeholder returned when a call produced no usable output. */
export const NO_OUTPUT_PLACEHOLDER = "(no output)";

/** Complete `<result>…</result>` pairs in one text blob. Unclosed tags are
 *  deliberately not matched — half a contract must not swallow the answer. */
const RESULT_BLOCK_RE = /<result>([\s\S]*?)<\/result>/g;

/**
 * Result extraction for a finished agent, in spec order:
 * 1. the LAST complete `<result>` block inside the final assistant run;
 * 2. otherwise the same run's plain text (the pre-contract heuristic);
 * 3. otherwise the explicit `(no output)` placeholder — never `""`.
 * An empty last block counts as absent so the fallback still applies.
 */
export function extractResult(messages: Message[]): ExtractedResult {
	const finalText = lastAssistantText(messages);
	if (!finalText) return { text: NO_OUTPUT_PLACEHOLDER, method: "none" };

	let lastBlock: string | undefined;
	for (const match of finalText.matchAll(RESULT_BLOCK_RE)) {
		lastBlock = match[1]?.trim();
	}
	if (lastBlock) return { text: lastBlock, method: "result-block" };
	return { text: finalText, method: "assistant-text" };
}
