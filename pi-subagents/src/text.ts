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
