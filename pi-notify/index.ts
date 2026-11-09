/**
 * pi-notify — desktop notifications for pi, packaged from mitsuhiko/agent-stuff
 * `extensions/notify.ts` (Apache-2.0). Behavior questions are answered by that
 * source, except for the deliberate divergence noted below.
 *
 * Desktop Notification Extension
 *
 * Sends a native desktop notification when the agent has fully settled and
 * is waiting for input. Uses OSC 777 escape sequence - no external
 * dependencies.
 *
 * Deliberate divergence from upstream: upstream notifies on `agent_end`, but
 * pi can still run an automatic retry, compaction, or queued continuation
 * after `agent_end`; only `agent_settled` guarantees the agent will not
 * continue on its own (pi event contract). `AgentSettledEvent` carries no
 * message list, so the last assistant text is tracked via `message_end` and
 * sent as the notification body when the agent settles.
 *
 * Supported terminals: Ghostty, iTerm2, WezTerm, rxvt-unicode
 * Not supported: Kitty (uses OSC 99), Terminal.app, Windows Terminal, Alacritty
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown, type MarkdownTheme, stripTerminalSequences } from "@earendil-works/pi-tui";

/**
 * Send a desktop notification via OSC 777 escape sequence.
 */
const notify = (title: string, body: string): void => {
	// OSC 777 format: ESC ] 777 ; notify ; title ; body BEL
	process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
};

const isTextPart = (part: unknown): part is { type: "text"; text: string } =>
	Boolean(part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part);

/** Extract the text of an assistant message; null when it has none; undefined when the message is not from the assistant. */
const assistantText = (message: { role?: string; content?: unknown }): string | null | undefined => {
	if (message?.role !== "assistant") {
		return undefined;
	}

	const content = message.content;
	if (typeof content === "string") {
		return content.trim() || null;
	}

	if (Array.isArray(content)) {
		const text = content.filter(isTextPart).map((part) => part.text).join("\n").trim();
		return text || null;
	}

	return null;
};

const plainMarkdownTheme: MarkdownTheme = {
	heading: (text) => text,
	link: (text) => text,
	linkUrl: () => "",
	code: (text) => text,
	codeBlock: (text) => text,
	codeBlockBorder: () => "",
	quote: (text) => text,
	quoteBorder: () => "",
	hr: () => "",
	listBullet: () => "",
	bold: (text) => text,
	italic: (text) => text,
	strikethrough: (text) => text,
	underline: (text) => text,
};

const simpleMarkdown = (text: string, width = 80): string => {
	const markdown = new Markdown(text, 0, 0, plainMarkdownTheme);
	return markdown.render(width).join("\n");
};

const formatNotification = (text: string | null): { title: string; body: string } => {
	const simplified = text ? simpleMarkdown(text) : "";
	// Markdown emits OSC 8 hyperlinks. Embedding one OSC sequence inside the OSC
	// 777 notification terminates the notification early and prints its visible
	// text at the terminal cursor. Remove terminal sequences and remaining control
	// characters before constructing the outer OSC sequence.
	const normalized = stripTerminalSequences(simplified)
		.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!normalized) {
		return { title: "Ready for input", body: "" };
	}

	const maxBody = 200;
	const body = normalized.length > maxBody ? `${normalized.slice(0, maxBody - 1)}…` : normalized;
	return { title: "π", body };
};

export default function notifyExtension(pi: ExtensionAPI) {
	let lastAssistantText: string | null = null;

	pi.on("message_end", (event) => {
		const text = assistantText(event.message);
		if (text !== undefined) {
			lastAssistantText = text;
		}
	});

	pi.on("agent_settled", () => {
		// Also notify on abort: the user may still be away from the terminal,
		// and the tracked text is the best available body.
		const { title, body } = formatNotification(lastAssistantText);
		notify(title, body);
	});
}
