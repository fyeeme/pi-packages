import { describe, expect, it, vi } from "vitest";
import { SessionTokenUsageCalculator } from "../token-usage.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(overrides: Partial<AssistantMessage["usage"]> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "hello" }],
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			...overrides,
		},
	} as unknown as AssistantMessage;
}

function makeCtx(
	messages: Array<AssistantMessage>,
	provider?: string,
): ExtensionContext {
	return {
		sessionManager: {
			getEntries: () => messages.map((m) => ({ type: "message" as const, message: m })),
		},
		model: { provider } as any,
	} as unknown as ExtensionContext;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SessionTokenUsageCalculator", () => {
	it("returns zeros for empty session", () => {
		const calc = new SessionTokenUsageCalculator(() => undefined);
		const ctx = makeCtx([]);

		const stats = calc.compute(ctx);
		expect(stats.input).toBe(0);
		expect(stats.output).toBe(0);
		expect(stats.cacheRead).toBe(0);
		expect(stats.cacheWrite).toBe(0);
		expect(stats.total).toBe(0);
		expect(stats.cost).toBe(0);
		expect(stats.hitRate).toBe(0);
	});

	it("sums token usage across messages", () => {
		const calc = new SessionTokenUsageCalculator(() => undefined);
		const ctx = makeCtx([
			makeMessage({ input: 100, output: 50, cacheRead: 20, cacheWrite: 10, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } }),
			makeMessage({ input: 200, output: 100, cacheRead: 30, cacheWrite: 15, totalTokens: 300, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.02 } }),
		]);

		const stats = calc.compute(ctx);
		expect(stats.input).toBe(300);
		expect(stats.output).toBe(150);
		expect(stats.cacheRead).toBe(50);
		expect(stats.cacheWrite).toBe(25);
		expect(stats.total).toBe(450);
		expect(stats.cost).toBe(0.03);
	});

	it("computes cache hit rate", () => {
		const calc = new SessionTokenUsageCalculator(() => undefined);
		const ctx = makeCtx([
			makeMessage({ input: 100, cacheRead: 100, totalTokens: 200, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }),
		]);

		const stats = calc.compute(ctx);
		expect(stats.hitRate).toBe(0.5); // 100 / (100 + 100)
	});

	it("returns 0 hit rate when no input or cacheRead", () => {
		const calc = new SessionTokenUsageCalculator(() => undefined);
		const ctx = makeCtx([
			makeMessage({ output: 50, totalTokens: 50, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }),
		]);

		const stats = calc.compute(ctx);
		expect(stats.hitRate).toBe(0);
	});

	it("defaults to $ currency", () => {
		const calc = new SessionTokenUsageCalculator(() => undefined);
		const ctx = makeCtx([], "openai");

		const stats = calc.compute(ctx);
		expect(stats.currency).toBe("$");
	});

	it("uses ¥ for deepseek provider", () => {
		const calc = new SessionTokenUsageCalculator(() => undefined);
		const ctx = makeCtx([], "deepseek");

		const stats = calc.compute(ctx);
		expect(stats.currency).toBe("¥");
	});

	it("uses ¥ for case-insensitive deepseek match", () => {
		const calc = new SessionTokenUsageCalculator(() => undefined);
		const ctx = makeCtx([], "DeepSeek");

		const stats = calc.compute(ctx);
		expect(stats.currency).toBe("¥");
	});

	it("respects currency override", () => {
		const calc = new SessionTokenUsageCalculator(() => "¥");
		const ctx = makeCtx([], "openai");

		const stats = calc.compute(ctx);
		expect(stats.currency).toBe("¥");
	});

	it("currency override takes precedence over provider detection", () => {
		const calc = new SessionTokenUsageCalculator(() => "$");
		const ctx = makeCtx([], "deepseek");

		const stats = calc.compute(ctx);
		expect(stats.currency).toBe("$");
	});
});
