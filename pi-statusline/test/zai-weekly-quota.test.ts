import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZaiUsageProvider } from "../providers/zai.ts";
import type { ProviderUsageResult, ZaiResult } from "../types.ts";

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
			expect(zai.fiveHourTokens).toBe(500_000);
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
			const zai = result as ZaiResult;
			expect(zai.isNaturalWeek).toBe(true);
			expect(zai.weeklyPct).toBe(0);
			expect(zai.weeklyTokens).toBe(500_000); // from model-usage API
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

		it("shows API weekly quota format: pct(in-window tokens,reset countdown)", () => {
			const result: NonNullable<ProviderUsageResult> = {
				provider: "zai",
				tokensLimitPct: 50,
				tokensResetAt: now + 2 * oneHour,
				fiveHourTokens: 300_000,
				level: "pro",
				weeklyTokens: 500_000,
				weeklyResetAt: now + 3 * 24 * oneHour,
				weeklyPct: 12,
				isNaturalWeek: false,
			};

			const out = provider.formatForFooter(result, 0, "$");
			expect(out).toMatch(/5h 50%\(300k,\d+h\d+m\)/);
			expect(out).toMatch(/wk 12%\(500k,\d+d\d+h\)/);
			expect(out).toContain(" · ");
		});

		it("shows natural week format: wk tokens", () => {
			const result: NonNullable<ProviderUsageResult> = {
				provider: "zai",
				tokensLimitPct: 0,
				tokensResetAt: now + 2 * oneHour,
				fiveHourTokens: 0,
				level: "pro",
				weeklyTokens: 42_000,
				weeklyResetAt: now + 2 * 24 * oneHour,
				weeklyPct: 0,
				isNaturalWeek: true,
			};

			const out = provider.formatForFooter(result, 0, "$");
			expect(out).toMatch(/5h 0%\(0,\d+h\d+m\)/);
			expect(out).toContain("wk 42k");
			expect(out).not.toContain("wk:");
			// natural-week format has no percentage/countdown after wk
			expect(out).not.toMatch(/wk \d+%/);
		});

		it("hides natural week when weeklyTokens is 0", () => {
			const result: NonNullable<ProviderUsageResult> = {
				provider: "zai",
				tokensLimitPct: 0,
				tokensResetAt: now + oneHour,
				fiveHourTokens: 0,
				level: "pro",
				weeklyTokens: 0,
				weeklyResetAt: 0,
				weeklyPct: 0,
				isNaturalWeek: true,
			};

			const out = provider.formatForFooter(result, 0, "$");
			expect(out).not.toContain("wk:");
			expect(out).not.toContain("wk ");
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
