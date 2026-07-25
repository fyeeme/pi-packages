import { describe, expect, it } from "vitest";
import {
	fmt,
	formatDuration,
	formatCountdown,
	formatWeeklyCountdown,
	formatCwd,
	buildInfoLine,
	buildStatLine,
} from "../footer.ts";
import type { ProviderUsageResult, TokenUsage } from "../types.ts";
import type { UsageProvider } from "../providers/types.ts";

// ---------------------------------------------------------------------------
// fmt
// ---------------------------------------------------------------------------

describe("fmt", () => {
	it("returns string for small numbers", () => {
		expect(fmt(0)).toBe("0");
		expect(fmt(1)).toBe("1");
		expect(fmt(999)).toBe("999");
	});

	it("formats 1000–9999 with one decimal k", () => {
		expect(fmt(1000)).toBe("1.0k");
		expect(fmt(1500)).toBe("1.5k");
		expect(fmt(9999)).toBe("10.0k");
	});

	it("formats 10000–999999 as rounded k", () => {
		expect(fmt(10000)).toBe("10k");
		expect(fmt(42000)).toBe("42k");
		expect(fmt(500000)).toBe("500k");
		expect(fmt(999999)).toBe("1000k");
	});

	it("formats 1000000–9999999 with one decimal M", () => {
		expect(fmt(1000000)).toBe("1.0M");
		expect(fmt(1500000)).toBe("1.5M");
		expect(fmt(9999999)).toBe("10.0M");
	});

	it("formats >= 10M as rounded M", () => {
		expect(fmt(10000000)).toBe("10M");
		expect(fmt(15000000)).toBe("15M");
	});
});

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------

describe("formatDuration", () => {
	it("formats seconds only", () => {
		expect(formatDuration(0)).toBe("0s");
		expect(formatDuration(30)).toBe("30s");
		expect(formatDuration(59)).toBe("59s");
	});

	it("formats minutes and seconds", () => {
		expect(formatDuration(60)).toBe("1m0s");
		expect(formatDuration(90)).toBe("1m30s");
		expect(formatDuration(150)).toBe("2m30s");
	});
});

// ---------------------------------------------------------------------------
// formatCountdown
// ---------------------------------------------------------------------------

describe("formatCountdown", () => {
	it("returns '?' for zero resetAt", () => {
		expect(formatCountdown(0)).toBe("?");
	});

	it("returns '0m' for past resetAt", () => {
		expect(formatCountdown(Date.now() - 1000)).toBe("0m");
	});

	it("returns minutes only for < 1 hour", () => {
		const resetAt = Date.now() + 30 * 60 * 1000;
		expect(formatCountdown(resetAt)).toBe("30m");
	});

	it("returns hours and minutes for >= 1 hour", () => {
		const resetAt = Date.now() + 150 * 60 * 1000;
		expect(formatCountdown(resetAt)).toBe("2h30m");
	});
});

// ---------------------------------------------------------------------------
// formatWeeklyCountdown
// ---------------------------------------------------------------------------

describe("formatWeeklyCountdown", () => {
	it("returns '?' for zero resetAt", () => {
		expect(formatWeeklyCountdown(0)).toBe("?");
	});

	it("returns '0h' for past resetAt", () => {
		expect(formatWeeklyCountdown(Date.now() - 1000)).toBe("0h");
	});

	it("returns minutes only when < 1 hour", () => {
		const resetAt = Date.now() + 30 * 60 * 1000;
		expect(formatWeeklyCountdown(resetAt)).toBe("30m");
	});

	it("returns hours and minutes when >= 1 hour but < 1 day", () => {
		const resetAt = Date.now() + 150 * 60 * 1000;
		expect(formatWeeklyCountdown(resetAt)).toBe("2h30m");
	});

	it("returns days and hours when >= 1 day", () => {
		const resetAt = Date.now() + 3 * 24 * 60 * 60 * 1000 + 5 * 60 * 60 * 1000;
		expect(formatWeeklyCountdown(resetAt)).toBe("3d5h");
	});
});

// ---------------------------------------------------------------------------
// formatCwd
// ---------------------------------------------------------------------------

describe("formatCwd", () => {
	const home = process.env.HOME || "/home/user";

	it("replaces home with ~", () => {
		expect(formatCwd(home)).toBe("~");
		expect(formatCwd(`${home}/projects/pi`)).toBe("~/projects/pi");
	});

	it("returns path unchanged when outside home", () => {
		expect(formatCwd("/tmp")).toBe("/tmp");
		expect(formatCwd("/etc")).toBe("/etc");
	});
});

// ---------------------------------------------------------------------------
// buildInfoLine
// ---------------------------------------------------------------------------

describe("buildInfoLine", () => {
	it("returns empty string for no model and off thinking", () => {
		expect(buildInfoLine(undefined, "off")).toBe("");
	});

	it("returns model only", () => {
		expect(buildInfoLine("claude-sonnet-4", "off")).toBe("claude-sonnet-4");
	});

	it("returns model and thinking level", () => {
		expect(buildInfoLine("claude-sonnet-4", "high")).toBe("claude-sonnet-4 · high");
	});
});

// ---------------------------------------------------------------------------
// buildStatLine
// ---------------------------------------------------------------------------

function makeStats(overrides: Partial<TokenUsage & { cost: number; currency: "¥" | "$" }> = {}): TokenUsage & { cost: number; currency: "¥" | "$" } {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
		hitRate: 0,
		cost: 0,
		currency: "$",
		...overrides,
	};
}

function makeProvider(formatResult: string): UsageProvider {
	return {
		fetchUsage: async () => null,
		formatForFooter: () => formatResult,
		debugDump: () => {},
	};
}

describe("buildStatLine", () => {
	const noopElapsed = () => 0;

	it("returns empty string when no data", () => {
		const result = buildStatLine(
			makeStats(),
			undefined,
			null,
			{},
			noopElapsed,
			0,
		);
		expect(result).toBe("");
	});

	it("shows token stats", () => {
		const result = buildStatLine(
			makeStats({ input: 5000, output: 2000, total: 7000 }),
			undefined,
			null,
			{},
			noopElapsed,
			0,
		);
		expect(result).toContain("tokens 7.0k(in 5.0k, out 2.0k)");
	});

	it("shows cache stats", () => {
		const result = buildStatLine(
			makeStats({ cacheRead: 1000, cacheWrite: 500, total: 1500, hitRate: 0 }),
			undefined,
			null,
			{},
			noopElapsed,
			0,
		);
		expect(result).toContain("cache 1.5k");
	});

	it("shows cache hit rate when > 0", () => {
		const result = buildStatLine(
			makeStats({ cacheRead: 1000, cacheWrite: 500, total: 1500, input: 3000, hitRate: 0.33 }),
			undefined,
			null,
			{},
			noopElapsed,
			0,
		);
		expect(result).toContain("cache 1.5k,33.0%");
	});

	it("shows cost when no provider result", () => {
		const result = buildStatLine(
			makeStats({ cost: 0.05, currency: "$" }),
			undefined,
			null,
			{},
			noopElapsed,
			0,
		);
		expect(result).toContain("$0.05");
	});

	it("delegates to provider for provider result", () => {
		const providers = { deepseek: makeProvider("DS: ¥100.00") };
		const result = buildStatLine(
			makeStats({ total: 1000 }),
			undefined,
			{ provider: "deepseek", totalBalance: "100", currency: "CNY", weeklyTokens: 0 },
			providers,
			noopElapsed,
			0,
		);
		expect(result).toContain("DS: ¥100.00");
	});

	it("shows context usage with percent", () => {
		const result = buildStatLine(
			makeStats({ total: 1000 }),
			{ tokens: 7000, contextWindow: 16000, percent: 43.75 },
			null,
			{},
			noopElapsed,
			0,
		);
		expect(result).toContain("43.8%/16k");
	});

	it("shows context usage without percent", () => {
		const result = buildStatLine(
			makeStats({ total: 1000 }),
			{ tokens: 0, contextWindow: 16000, percent: null },
			null,
			{},
			noopElapsed,
			0,
		);
		expect(result).toContain("?/16k");
	});

	it("shows elapsed time and TPS", () => {
		const result = buildStatLine(
			makeStats(),
			undefined,
			null,
			{},
			() => 150,
			39.5,
		);
		expect(result).toContain("2m30s");
		expect(result).toContain("39.5tok/s");
	});

	it("MCP segment is absent (no pi version emits mcp:status/mcp:disconnect)", () => {
		const result = buildStatLine(
			makeStats(),
			undefined,
			null,
			{},
			noopElapsed,
			0,
		);
		expect(result).not.toContain("MCP");
	});

	it("joins sections with separator", () => {
		const result = buildStatLine(
			makeStats({ input: 5000, total: 1000 }),
			{ tokens: 500, contextWindow: 16000, percent: 3.125 },
			null,
			{},
			noopElapsed,
			0,
		);
		expect(result).toContain(" · ");
	});
});
