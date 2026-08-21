import { describe, expect, it, vi } from "vitest";
import { SessionTokenUsageCalculator } from "../token-usage.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(
	overrides: Partial<AssistantMessage["usage"]> & { model?: string; timestamp?: number } = {},
): AssistantMessage {
	const { model, timestamp, ...usageOverrides } = overrides;
	return {
		role: "assistant",
		content: [{ type: "text", text: "hello" }],
		model: model ?? "test-model",
		timestamp: timestamp ?? Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			...usageOverrides,
		},
	} as unknown as AssistantMessage;
}

function makeCtx(
	messages: Array<AssistantMessage>,
	provider?: string,
	branchMessages?: Array<AssistantMessage>,
): ExtensionContext {
	return {
		sessionManager: {
			getEntries: () => messages.map((m) => ({ type: "message" as const, message: m })),
			getBranch: () =>
				(branchMessages ?? messages).map((m) => ({ type: "message" as const, message: m })),
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

	it("counts only the current branch (getBranch), excluding abandoned siblings", () => {
		const calc = new SessionTokenUsageCalculator(() => undefined);
		// Full tree holds two assistant messages, but the current branch keeps only one.
		const ctx = makeCtx(
			[
				makeMessage({ input: 100, output: 50, totalTokens: 150 }),
				makeMessage({ input: 200, output: 100, totalTokens: 300 }),
			],
			"openai",
			[makeMessage({ input: 100, output: 50, totalTokens: 150 })],
		);

		const stats = calc.compute(ctx);
		expect(stats.input).toBe(100);
		expect(stats.output).toBe(50);
		expect(stats.total).toBe(150);
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

	// ---- DeepSeek 峰谷计价（按消息时刻选单价） ----

	it("recomputes deepseek CNY cost with peak rates for peak-time messages", () => {
		const calc = new SessionTokenUsageCalculator(() => undefined);
		const msg = makeMessage({
			model: "deepseek-v4-flash",
			input: 1_000_000,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1_000_000,
			timestamp: new Date("2026-08-21T10:00:00+08:00").getTime(), // 北京时间 10:00（高峰）
		});
		const ctx = makeCtx([msg], "deepseek");

		const stats = calc.compute(ctx);
		// 1M 未命中输入 × ¥3/1M（高峰）
		expect(stats.cost).toBeCloseTo(3.0, 9);
	});

	it("uses off-peak rates for off-peak-time deepseek messages (半价)", () => {
		const calc = new SessionTokenUsageCalculator(() => undefined);
		const msg = makeMessage({
			model: "deepseek-v4-flash",
			input: 1_000_000,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1_000_000,
			timestamp: new Date("2026-08-21T02:00:00+08:00").getTime(), // 北京时间 02:00（空闲）
		});
		const ctx = makeCtx([msg], "deepseek");

		const stats = calc.compute(ctx);
		// 1M 未命中输入 × ¥1.5/1M（空闲）
		expect(stats.cost).toBeCloseTo(1.5, 9);
	});

	it("sums deepseek messages across peak/off-peak boundary with per-message rates", () => {
		const calc = new SessionTokenUsageCalculator(() => undefined);
		const peak = makeMessage({
			model: "deepseek-v4-pro",
			input: 1_000_000,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1_000_000,
			timestamp: new Date("2026-08-21T10:00:00+08:00").getTime(), // 高峰 ¥9/1M
		});
		const off = makeMessage({
			model: "deepseek-v4-pro",
			input: 1_000_000,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1_000_000,
			timestamp: new Date("2026-08-21T02:00:00+08:00").getTime(), // 空闲 ¥4.5/1M
		});
		const ctx = makeCtx([peak, off], "deepseek");

		const stats = calc.compute(ctx);
		expect(stats.cost).toBeCloseTo(9.0 + 4.5, 9);
	});
});
