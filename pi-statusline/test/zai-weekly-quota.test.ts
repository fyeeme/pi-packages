import { beforeEach, describe, expect, it, vi } from "vitest";
import { fmt, formatCountdown } from "../footer.ts";
import { ZaiUsageProvider } from "../providers/zai.ts";
import type { ProviderUsageResult, ZaiResult } from "../types.ts";

// ---------------------------------------------------------------------------
// Mock session-scanner
// ---------------------------------------------------------------------------
vi.mock("../session-scanner.ts", () => ({
	scanWeeklyTokens: vi.fn(() => 42_000),
}));

// ---------------------------------------------------------------------------
// Helpers to build mock context
// ---------------------------------------------------------------------------

function mockModelRegistry(apiKey: string) {
	return {
		getApiKeyForProvider: vi.fn(async () => apiKey),
	} as any;
}

function mockModel(provider: string, baseUrl?: string) {
	return { provider, baseUrl, id: "test-model" } as any;
}

/** Build a QuotaLimit entry. */
function tokenLimit(unit: number, overrides: Record<string, any> = {}) {
	return { type: "TOKENS_LIMIT", unit, number: 1, percentage: 0, ...overrides };
}

/** Build a full quota API response body. */
function quotaResponse(limits: any[]) {
	return {
		code: 200,
		msg: "Operation successful",
		data: { limits, level: "pro" },
		success: true,
	};
}

/** Build a model-usage API response body. */
function usageResponse(totalTokens: number) {
	return {
		data: {
			modelSummaryList: [
				{ modelName: "glm-4", totalTokens },
			],
		},
	};
}

/**
 * Mock global fetch with a map of url-substring → response.
 * Each value is { ok, status, json }.
 */
function mockFetch(responses: Map<string, { ok: boolean; status: number; json: any }>) {
	return vi.fn(async (url: string) => {
		for (const [key, resp] of responses) {
			if (url.includes(key)) {
				return {
					ok: resp.ok,
					status: resp.status,
					json: async () => resp.json,
				};
			}
		}
		return { ok: false, status: 500, json: async () => ({}) };
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ZaiUsageProvider", () => {
	let provider: ZaiUsageProvider;

	beforeEach(() => {
		provider = new ZaiUsageProvider();
		vi.restoreAllMocks();
	});

	// ---- fetchUsage ----

	describe("fetchUsage", () => {
		it("returns null for non-zai provider", async () => {
			const result = await provider.fetchUsage(
				mockModelRegistry("key"),
				mockModel("deepseek"),
			);
			expect(result).toBeNull();
		});

		it("returns null when no API key", async () => {
			const result = await provider.fetchUsage(
				mockModelRegistry(""),
				mockModel("zai"),
			);
			expect(result).toBeNull();
		});

		it("returns null when quota API returns non-200", async () => {
			vi.stubGlobal("fetch", mockFetch(new Map([
				["quota/limit", { ok: false, status: 401, json: {} }],
			])));

			const result = await provider.fetchUsage(
				mockModelRegistry("key"),
				mockModel("zai"),
			);
			expect(result).toBeNull();
		});

		it("uses unit:6 when present (API weekly quota)", async () => {
			const now = Date.now();
			const fiveHourReset = now + 5 * 60 * 60 * 1000;
			const weeklyReset = now + 3 * 24 * 60 * 60 * 1000;

			vi.stubGlobal("fetch", mockFetch(new Map([
				["quota/limit", {
					ok: true,
					status: 200,
					json: quotaResponse([
						tokenLimit(3, { percentage: 50, nextResetTime: fiveHourReset }),
						tokenLimit(6, { percentage: 12, nextResetTime: weeklyReset }),
					]),
				}],
				["model-usage", {
					ok: true,
					status: 200,
					json: usageResponse(500_000),
				}],
			])));

			const result = await provider.fetchUsage(
				mockModelRegistry("key"),
				mockModel("zai"),
			);

			expect(result).not.toBeNull();
			expect(result!.provider).toBe("zai");
			const zai = result as ZaiResult;
			expect(zai.tokensLimitPct).toBe(50);
			expect(zai.tokensResetAt).toBe(fiveHourReset);
			expect(zai.weeklyPct).toBe(12);
			expect(zai.weeklyResetAt).toBe(weeklyReset);
			expect(zai.weeklyTokens).toBe(500_000);
			expect(zai.isNaturalWeek).toBe(false);
		});

		it("falls back to natural week when unit:6 is absent", async () => {
			const now = Date.now();
			const fiveHourReset = now + 5 * 60 * 60 * 1000;

			vi.stubGlobal("fetch", mockFetch(new Map([
				["quota/limit", {
					ok: true,
					status: 200,
					json: quotaResponse([
						tokenLimit(3, { percentage: 0, nextResetTime: fiveHourReset }),
						// No unit:6 entry
					]),
				}],
			])));

			const result = await provider.fetchUsage(
				mockModelRegistry("key"),
				mockModel("zai"),
			);

			expect(result).not.toBeNull();
			const zai = result as ZaiResult;
			expect(zai.isNaturalWeek).toBe(true);
			expect(zai.weeklyPct).toBe(0);
			expect(zai.weeklyTokens).toBe(42_000); // from mocked scanWeeklyTokens
			// weeklyResetAt should be next Monday 00:00 UTC
			expect(zai.weeklyResetAt).toBeGreaterThan(now);
		});

		it("falls back to natural week when unit:6 has no nextResetTime", async () => {
			const now = Date.now();
			const fiveHourReset = now + 5 * 60 * 60 * 1000;

			vi.stubGlobal("fetch", mockFetch(new Map([
				["quota/limit", {
					ok: true,
					status: 200,
					json: quotaResponse([
						tokenLimit(3, { percentage: 0, nextResetTime: fiveHourReset }),
						tokenLimit(6, { percentage: 5, nextResetTime: 0 }),
					]),
				}],
			])));

			const result = await provider.fetchUsage(
				mockModelRegistry("key"),
				mockModel("zai"),
			);

			expect(result).not.toBeNull();
			const zai = result as ZaiResult;
			expect(zai.isNaturalWeek).toBe(true);
		});

		it("uses bigmodel.cn origin for zai-coding-cn provider", async () => {
			const fiveHourReset = Date.now() + 5 * 60 * 60 * 1000;
			const fetchFn = mockFetch(new Map([
				["quota/limit", {
					ok: true,
					status: 200,
					json: quotaResponse([
						tokenLimit(3, { percentage: 10, nextResetTime: fiveHourReset }),
					]),
				}],
			]));
			vi.stubGlobal("fetch", fetchFn);

			await provider.fetchUsage(
				mockModelRegistry("key"),
				mockModel("zai-coding-cn"),
			);

			expect(fetchFn).toHaveBeenCalledWith(
				expect.stringContaining("bigmodel.cn"),
				expect.anything(),
			);
		});
	});

	// ---- formatForFooter ----

	describe("formatForFooter", () => {
		const now = Date.now();
		const oneHour = 60 * 60 * 1000;

		it("shows API weekly quota format: percentage + tokens + countdown", () => {
			const result: NonNullable<ProviderUsageResult> = {
				provider: "zai",
				tokensLimitPct: 50,
				tokensResetAt: now + 2 * oneHour,
				level: "pro",
				weeklyTokens: 500_000,
				weeklyResetAt: now + 3 * 24 * oneHour,
				weeklyPct: 12,
				isNaturalWeek: false,
			};

			const out = provider.formatForFooter(result, 0, "$");
			expect(out).toMatch(/Usage 50%\(\d+h\d+m\)/);
			expect(out).toMatch(/W:12%\(/);
			expect(out).toMatch(/500k/);
			expect(out).toContain(" · ");
		});

		it("shows natural week format: 7d:tokens", () => {
			const result: NonNullable<ProviderUsageResult> = {
				provider: "zai",
				tokensLimitPct: 0,
				tokensResetAt: now + 2 * oneHour,
				level: "pro",
				weeklyTokens: 42_000,
				weeklyResetAt: now + 2 * 24 * oneHour,
				weeklyPct: 0,
				isNaturalWeek: true,
			};

			const out = provider.formatForFooter(result, 0, "$");
			expect(out).toMatch(/Usage 0%\(\d+h\d+m\)/);
			expect(out).toContain("7d:42k");
			expect(out).not.toContain("W:");
		});

		it("hides natural week when weeklyTokens is 0", () => {
			const result: NonNullable<ProviderUsageResult> = {
				provider: "zai",
				tokensLimitPct: 0,
				tokensResetAt: now + oneHour,
				level: "pro",
				weeklyTokens: 0,
				weeklyResetAt: 0,
				weeklyPct: 0,
				isNaturalWeek: true,
			};

			const out = provider.formatForFooter(result, 0, "$");
			expect(out).not.toContain("7d:");
			expect(out).not.toContain("W:");
		});

		it("returns empty for non-zai provider", () => {
			const result: NonNullable<ProviderUsageResult> = {
				provider: "deepseek",
				totalBalance: "10",
				currency: "CNY",
				weeklyTokens: 0,
			};
			expect(provider.formatForFooter(result, 0, "$")).toBe("");
		});
	});
});

// ---------------------------------------------------------------------------
// Pure function tests
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

describe("fmt", () => {
	it("formats small numbers as-is", () => {
		expect(fmt(0)).toBe("0");
		expect(fmt(999)).toBe("999");
	});

	it("formats 1k–10k with one decimal", () => {
		expect(fmt(1500)).toBe("1.5k");
		expect(fmt(9999)).toBe("10.0k");
	});

	it("formats 10k–1M as rounded k", () => {
		expect(fmt(42000)).toBe("42k");
		expect(fmt(500000)).toBe("500k");
	});

	it("formats 1M–10M with one decimal", () => {
		expect(fmt(1500000)).toBe("1.5M");
	});

	it("formats >= 10M as rounded M", () => {
		expect(fmt(15000000)).toBe("15M");
	});
});
