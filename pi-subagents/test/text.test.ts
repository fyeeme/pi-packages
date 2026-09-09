/**
 * text.test.ts — the result-contract extractor (extractResult) and its
 * fallback chain: last complete <result> block → final assistant-run text →
 * explicit "(no output)" placeholder. Anchors spec scenarios
 * result-block-precedence and fallback/empty-output.
 */
import { describe, expect, it } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import { contentTextBlocks, extractResult, lastAssistantText, lastMessageText, NO_OUTPUT_PLACEHOLDER } from "../src/text.ts";

function assistant(content: string | unknown[]): Message {
	return { role: "assistant", content } as unknown as Message;
}

describe("contentTextBlocks", () => {
	it("joins text blocks and ignores other block kinds", () => {
		const blocks = contentTextBlocks([
			{ type: "text", text: "a" },
			{ type: "thinking", thinking: "hmm" },
			{ type: "text", text: "b" },
			{ type: "toolCall", name: "read" },
		]);
		expect(blocks).toEqual(["a", "b"]);
	});

	it("returns [] for garbage shapes", () => {
		expect(contentTextBlocks(undefined)).toEqual([]);
		expect(contentTextBlocks(42)).toEqual([]);
	});
});

describe("lastAssistantText (pre-contract heuristic)", () => {
	it("keeps only the final run of assistant messages", () => {
		const messages: Message[] = [
			assistant("Let me check…"),
			{ role: "user", content: "tool result" } as unknown as Message,
			assistant("Part one."),
			assistant("Part two."),
		];
		expect(lastAssistantText(messages)).toBe("Part one.\nPart two.");
	});

	it("returns '' when a tool result breaks the run and the final turn is toolCall-only", () => {
		const messages: Message[] = [
			assistant("earlier"),
			{ role: "user", content: "tool result" } as unknown as Message,
			assistant([{ type: "toolCall", name: "bash" }]),
		];
		expect(lastAssistantText(messages)).toBe("");
	});
});

describe("lastMessageText (running-partial preview)", () => {
	it("returns the LAST assistant message only, not the joined run", () => {
		const messages: Message[] = [assistant("PARTIAL-ONE"), assistant("PARTIAL-TWO")];
		expect(lastMessageText(messages)).toBe("PARTIAL-TWO");
	});

	it("skips trailing non-assistant messages and joins text blocks within the message", () => {
		const messages: Message[] = [
			assistant("first"),
			assistant([{ type: "text", text: "a" }, { type: "text", text: "b" }]),
			{ role: "user", content: "tool result" } as unknown as Message,
		];
		expect(lastMessageText(messages)).toBe("a\nb");
	});

	it("returns '' when no assistant message exists", () => {
		expect(lastMessageText([{ role: "user", content: "hi" } as unknown as Message])).toBe("");
		expect(lastMessageText([])).toBe("");
	});
});

describe("extractResult (explicit contract)", () => {
	it("a <result> block wins over surrounding narration", () => {
		const r = extractResult([assistant("I investigated.\n<result>The answer is 4.</result>")]);
		expect(r.text).toBe("The answer is 4.");
		expect(r.method).toBe("result-block");
	});

	it("the LAST complete block wins when several appear", () => {
		const r = extractResult([assistant("<result>draft</result>\nrevised:\n<result>final</result>")]);
		expect(r.text).toBe("final");
		expect(r.method).toBe("result-block");
	});

	it("an empty last block counts as absent and falls back to plain text", () => {
		const r = extractResult([assistant("<result></result> plain tail")]);
		expect(r.method).toBe("assistant-text");
		expect(r.text).toContain("plain tail");
	});

	it("no block → falls back to the final assistant run", () => {
		const r = extractResult([assistant("Step 1 done."), { role: "user" } as unknown as Message, assistant("Final report body.")]);
		expect(r.text).toBe("Final report body.");
		expect(r.method).toBe("assistant-text");
	});

	it("toolCall-only final turn → explicit placeholder with method none", () => {
		const r = extractResult([assistant([{ type: "toolCall", name: "bash" }])]);
		expect(r.text).toBe(NO_OUTPUT_PLACEHOLDER);
		expect(r.method).toBe("none");
	});

	it("unclosed <result> tags are not treated as a contract hit", () => {
		const r = extractResult([assistant("<result>half-open answer")]);
		expect(r.method).toBe("assistant-text");
	});
});
