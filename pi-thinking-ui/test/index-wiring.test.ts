import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import thinkingUIExtension from "../index.ts";

// Loads the extension factory against a minimal mock `pi` and captures the
// registered markdown transformer, so we can assert the new wiring:
//  - exactly one transformer is registered
//  - it transforms `assistant-thinking` content
//  - it passes other message types through untouched
function loadWithMockPi(): { transformer: (markdown: string, ctx: { messageType: string }) => string } {
	const transformers: Array<(markdown: string, ctx: { messageType: string }) => string> = [];
	const pi = {
		registerMarkdownTransformer: (t: (markdown: string, ctx: { messageType: string }) => string) => transformers.push(t),
		registerCommand: vi.fn(),
		registerShortcut: vi.fn(),
		on: vi.fn(),
	} as unknown as ExtensionAPI;

	thinkingUIExtension(pi);

	expect(transformers).toHaveLength(1);
	return { transformer: transformers[0]! };
}

describe("thinking-ui extension wiring", () => {
	it("registers exactly one markdown transformer", () => {
		const { transformer } = loadWithMockPi();
		expect(typeof transformer).toBe("function");
	});

	it("transforms assistant-thinking content (default collapsed mode → blockquote)", () => {
		const { transformer } = loadWithMockPi();
		const out = transformer("I need to inspect src/index.ts to fix the bug.", { messageType: "assistant-thinking" });
		expect(out.startsWith("> ")).toBe(true);
	});

	it("passes non-thinking message types through untouched", () => {
		const { transformer } = loadWithMockPi();
		const original = "hello **world**";
		expect(transformer(original, { messageType: "user" })).toBe(original);
		expect(transformer(original, { messageType: "assistant" })).toBe(original);
	});
});
