/**
 * pi-notify — extension wiring tests (fake host, pi-goal test style).
 *
 * Drives the default export through a fake ExtensionAPI with a spied
 * process.stdout to pin the notify.ts behavior: the OSC 777 payload
 * shape on agent_settled, last-assistant-message tracking via
 * message_end (string, part-array, non-text, user messages never
 * overwrite the tracked text), markdown flattening, terminal-sequence
 * and control-character stripping, whitespace collapsing, 200-character
 * truncation, the Ready-for-input fallback, and notifying on abort.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import defaultExport from "../index.ts";

interface FakeMessage {
	role?: string;
	content?: unknown;
}

type Handler = (event: Record<string, unknown>) => unknown | Promise<unknown>;

function fakeHost() {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on: (event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	};
	defaultExport(pi as unknown as ExtensionAPI);
	return {
		handlers,
		fireMessageEnd: async (message: FakeMessage) => {
			for (const handler of handlers.get("message_end") ?? []) {
				await handler({ message });
			}
		},
		fireAgentSettled: async (aborted = false) => {
			for (const handler of handlers.get("agent_settled") ?? []) {
				await handler({ aborted });
			}
		},
	};
}

interface Notification {
	raw: string;
	title: string;
	body: string;
}

function parseNotification(raw: string | undefined): Notification | null {
	if (!raw) return null;
	const match = /^\x1b\]777;notify;([^;]*);(.*)\x07$/s.exec(raw);
	if (!match) return null;
	return { raw, title: match[1] as string, body: match[2] as string };
}

function spyStdout() {
	return vi.spyOn(process.stdout, "write").mockImplementation(() => true);
}

describe("pi-notify (notify.ts port)", () => {
	let host: ReturnType<typeof fakeHost>;
	let write: ReturnType<typeof spyStdout>;

	beforeEach(() => {
		host = fakeHost();
		write = spyStdout();
	});

	afterEach(() => {
		write.mockRestore();
	});

	it("sends exactly one OSC 777 notification on agent_settled", async () => {
		await host.fireMessageEnd({ role: "assistant", content: "Done." });
		await host.fireAgentSettled();
		expect(write).toHaveBeenCalledTimes(1);
		const note = parseNotification(write.mock.calls[0]?.[0] as string);
		expect(note).toMatchObject({ title: "π", body: "Done." });
		expect(note?.raw).toBe("\x1b]777;notify;π;Done.\x07");
	});

	it("uses the last assistant message; later user messages do not overwrite it", async () => {
		await host.fireMessageEnd({ role: "assistant", content: "first answer" });
		await host.fireMessageEnd({ role: "user", content: "again?" });
		await host.fireMessageEnd({ role: "assistant", content: "second answer" });
		await host.fireAgentSettled();
		expect(parseNotification(write.mock.calls[0]?.[0] as string)?.body).toBe("second answer");
	});

	it("still notifies with the tracked text when the run was aborted", async () => {
		await host.fireMessageEnd({ role: "assistant", content: "partial answer" });
		await host.fireAgentSettled(true);
		expect(write).toHaveBeenCalledTimes(1);
		expect(parseNotification(write.mock.calls[0]?.[0] as string)).toMatchObject({
			title: "π",
			body: "partial answer",
		});
	});

	it("joins text parts of an array content and skips non-text parts", async () => {
		await host.fireMessageEnd({
			role: "assistant",
			content: [{ type: "text", text: "part one" }, { type: "thinking", text: "hidden" }, { type: "text", text: "part two" }],
		});
		await host.fireAgentSettled();
		const note = parseNotification(write.mock.calls[0]?.[0] as string);
		expect(note?.body).toBe("part one part two");
	});

	it("flattens markdown to plain text", async () => {
		await host.fireMessageEnd({
			role: "assistant",
			content: "# Summary\n\n**Done** with `code` and [the docs](https://example.com).",
		});
		await host.fireAgentSettled();
		const note = parseNotification(write.mock.calls[0]?.[0] as string);
		expect(note?.body).toContain("Summary");
		expect(note?.body).toContain("Done");
		expect(note?.body).not.toContain("**");
		expect(note?.body).not.toContain("[the docs]");
		expect(note?.body).not.toContain("https://example.com");
	});

	it("the payload carries no escape or control characters", async () => {
		await host.fireMessageEnd({
			role: "assistant",
			content: "line one\nline\ttwo",
		});
		await host.fireAgentSettled();
		const note = parseNotification(write.mock.calls[0]?.[0] as string);
		expect(note).not.toBeNull();
		expect(note?.body).toBe("line one line two");
	});

	it("truncates bodies to 200 characters with an ellipsis", async () => {
		// 25 groups of "aaaaaaaaa " (10 chars each) = 250 chars; spaces survive
		// word wrapping unchanged, so the truncation point is deterministic.
		const text = "aaaaaaaaa ".repeat(25).trim();
		await host.fireMessageEnd({ role: "assistant", content: text });
		await host.fireAgentSettled();
		const note = parseNotification(write.mock.calls[0]?.[0] as string);
		expect(note?.body).toHaveLength(200);
		expect(note?.body?.endsWith("…")).toBe(true);
		expect(note?.body?.slice(0, 199)).toBe(text.slice(0, 199));
	});

	it("wrap newlines from long unwrappable words become spaces in the body", async () => {
		await host.fireMessageEnd({ role: "assistant", content: "a".repeat(500) });
		await host.fireAgentSettled();
		const note = parseNotification(write.mock.calls[0]?.[0] as string);
		expect(note?.body).toHaveLength(200);
		expect(note?.body).toMatch(/^[a ]{199}…$/);
		expect(note?.body).toContain(" ");
	});

	it("falls back to Ready for input when there is no assistant message", async () => {
		await host.fireMessageEnd({ role: "user", content: "hello?" });
		await host.fireAgentSettled();
		expect(parseNotification(write.mock.calls[0]?.[0] as string)).toMatchObject({
			title: "Ready for input",
			body: "",
		});
	});

	it("falls back to Ready for input when no message_end fired at all", async () => {
		await host.fireAgentSettled();
		expect(parseNotification(write.mock.calls[0]?.[0] as string)?.title).toBe("Ready for input");
	});

	it("falls back to Ready for input for empty or whitespace-only text", async () => {
		await host.fireMessageEnd({ role: "assistant", content: "   " });
		await host.fireAgentSettled();
		expect(parseNotification(write.mock.calls[0]?.[0] as string)?.title).toBe("Ready for input");

		write.mockClear();
		await host.fireMessageEnd({ role: "assistant", content: "" });
		await host.fireAgentSettled();
		expect(parseNotification(write.mock.calls[0]?.[0] as string)?.title).toBe("Ready for input");
	});

	it("falls back to Ready for input for a non-text content shape", async () => {
		await host.fireMessageEnd({ role: "assistant", content: 42 });
		await host.fireAgentSettled();
		expect(parseNotification(write.mock.calls[0]?.[0] as string)?.title).toBe("Ready for input");

		write.mockClear();
		await host.fireMessageEnd({ role: "assistant", content: [{ type: "image", text: "nope" }] });
		await host.fireAgentSettled();
		expect(parseNotification(write.mock.calls[0]?.[0] as string)?.title).toBe("Ready for input");
	});
});
