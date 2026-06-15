import { beforeEach, describe, expect, it, vi } from "vitest";
import { DeepSeekUsageProvider } from "../providers/deepseek.ts";
import type { ProviderUsageResult, DeepSeekResult } from "../types.ts";

// ---------------------------------------------------------------------------
// Mock session-scanner
// ---------------------------------------------------------------------------
vi.mock("../session-scanner.ts", () => ({
	scanWeeklyTokens: vi.fn(() => 42_000),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockModelRegistry(apiKey: string | null) {
	return {
		getApiKeyForProvider: vi.fn(async () => apiKey),
	} as any;
}

function mockModel(provider: string, baseUrl?: string) {
	return { provider, baseUrl, id: "test-model" } as any;
}

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

describe("DeepSeekUsageProvider", () => {
	let provider: DeepSeekUsageProvider;

	beforeEach(() => {
		provider = new DeepSeekUsageProvider();
		vi.restoreAllMocks();
	});

	// ---- fetchUsage ----

	describe("fetchUsage", () => {
		it("returns null for non-deepseek provider", async () => {
			const result = await provider.fetchUsage(
				mockModelRegistry("key"),
				mockModel("zai"),
			);
			expect(result).toBeNull();
		});

		it("returns null when no API key", async () => {
			const result = await provider.fetchUsage(
				mockModelRegistry(""),
				mockModel("deepseek"),
			);
			expect(result).toBeNull();
		});

		it("returns null when null API key", async () => {
			const result = await provider.fetchUsage(
				mockModelRegistry(null),
				mockModel("deepseek"),
			);
			expect(result).toBeNull();
		});

		it("returns null when balance API returns non-200", async () => {
			vi.stubGlobal("fetch", mockFetch(new Map([
				["balance", { ok: false, status: 401, json: {} }],
			])));

			const result = await provider.fetchUsage(
				mockModelRegistry("key"),
				mockModel("deepseek"),
			);
			expect(result).toBeNull();
		});

		it("returns null when balance_infos is empty", async () => {
			vi.stubGlobal("fetch", mockFetch(new Map([
				["balance", {
					ok: true,
					status: 200,
					json: {
						is_available: true,
						balance_infos: [],
					},
				}],
			])));

			const result = await provider.fetchUsage(
				mockModelRegistry("key"),
				mockModel("deepseek"),
			);
			expect(result).toBeNull();
		});

		it("returns balance and weekly tokens on success", async () => {
			vi.stubGlobal("fetch", mockFetch(new Map([
				["balance", {
					ok: true,
					status: 200,
					json: {
						is_available: true,
						balance_infos: [{
							currency: "CNY",
							total_balance: "100.00",
						}],
					},
				}],
			])));

			const result = await provider.fetchUsage(
				mockModelRegistry("key"),
				mockModel("deepseek"),
			);

			expect(result).not.toBeNull();
			expect(result!.provider).toBe("deepseek");
			const ds = result as DeepSeekResult;
			expect(ds.totalBalance).toBe("100.00");
			expect(ds.currency).toBe("CNY");
			expect(ds.weeklyTokens).toBe(42_000); // from mocked scanWeeklyTokens
		});

		it("returns '?' for missing balance with USD default", async () => {
			vi.stubGlobal("fetch", mockFetch(new Map([
				["balance", {
					ok: true,
					status: 200,
					json: {
						is_available: true,
						balance_infos: [{}],
					},
				}],
			])));

			const result = await provider.fetchUsage(
				mockModelRegistry("key"),
				mockModel("deepseek"),
			);

			expect(result).not.toBeNull();
			const ds = result as DeepSeekResult;
			expect(ds.totalBalance).toBe("?");
			expect(ds.currency).toBe("CNY");
		});

		it("uses custom baseUrl origin", async () => {
			const fetchFn = mockFetch(new Map([
				["custom.api", {
					ok: true,
					status: 200,
					json: {
						is_available: true,
						balance_infos: [{
							currency: "USD",
							total_balance: "50.00",
						}],
					},
				}],
			]));
			vi.stubGlobal("fetch", fetchFn);

			await provider.fetchUsage(
				mockModelRegistry("key"),
				mockModel("deepseek", "https://custom.api/v1"),
			);

			expect(fetchFn).toHaveBeenCalledWith(
				expect.stringContaining("custom.api"),
				expect.anything(),
			);
		});

		it("handles fetch throwing", async () => {
			vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network error"); }));

			const result = await provider.fetchUsage(
				mockModelRegistry("key"),
				mockModel("deepseek"),
			);
			expect(result).toBeNull();
		});

		it("handles invalid baseUrl gracefully", async () => {
			const fetchFn = mockFetch(new Map([
				["api.deepseek.com", {  // should fall back to default origin
					ok: true,
					status: 200,
					json: {
						is_available: true,
						balance_infos: [{
							currency: "CNY",
							total_balance: "200.00",
						}],
					},
				}],
			]));
			vi.stubGlobal("fetch", fetchFn);

			const result = await provider.fetchUsage(
				mockModelRegistry("key"),
				mockModel("deepseek", "not-a-valid-url"),
			);

			expect(result).not.toBeNull();
			expect(fetchFn).toHaveBeenCalledWith(
				expect.stringContaining("api.deepseek.com"),
				expect.anything(),
			);
		});
	});

	// ---- formatForFooter ----

	describe("formatForFooter", () => {
		it("returns empty for non-deepseek result", () => {
			const result: NonNullable<ProviderUsageResult> = {
				provider: "zai",
				tokensLimitPct: 0,
				tokensResetAt: 0,
				level: "",
				weeklyTokens: 0,
				weeklyResetAt: 0,
				weeklyPct: 0,
				isNaturalWeek: false,
			};
			expect(provider.formatForFooter(result, 0, "$")).toBe("");
		});

		it("shows balance only when no session cost and no weekly tokens", () => {
			const result: NonNullable<ProviderUsageResult> = {
				provider: "deepseek",
				totalBalance: "100.00",
				currency: "CNY",
				weeklyTokens: 0,
			};

			const out = provider.formatForFooter(result, 0, "$");
			expect(out).toBe("¥100.00");
		});

		it("shows session cost over balance", () => {
			const result: NonNullable<ProviderUsageResult> = {
				provider: "deepseek",
				totalBalance: "100.00",
				currency: "CNY",
				weeklyTokens: 0,
			};

			const out = provider.formatForFooter(result, 0.05, "$");
			expect(out).toBe("$0.05/¥100.00");
		});

		it("shows weekly tokens when present", () => {
			const result: NonNullable<ProviderUsageResult> = {
				provider: "deepseek",
				totalBalance: "100.00",
				currency: "CNY",
				weeklyTokens: 42_000,
			};

			const out = provider.formatForFooter(result, 0, "$");
			expect(out).toBe("¥100.00 · 7d:42k");
		});

		it("shows session cost, balance, and weekly tokens together", () => {
			const result: NonNullable<ProviderUsageResult> = {
				provider: "deepseek",
				totalBalance: "100.00",
				currency: "CNY",
				weeklyTokens: 42_000,
			};

			const out = provider.formatForFooter(result, 0.05, "¥");
			expect(out).toBe("¥0.05/¥100.00 · 7d:42k");
		});

		it("uses $ for non-CNY currency", () => {
			const result: NonNullable<ProviderUsageResult> = {
				provider: "deepseek",
				totalBalance: "50.00",
				currency: "USD",
				weeklyTokens: 0,
			};

			const out = provider.formatForFooter(result, 0, "$");
			expect(out).toBe("$50.00");
		});
	});

	// ---- debugDump ----

	describe("debugDump", () => {
		it("writes deepseek-specific fields", () => {
			const lines: string[] = [];
			const w = (s: string) => lines.push(s);

			const result: NonNullable<ProviderUsageResult> = {
				provider: "deepseek",
				totalBalance: "100.00",
				currency: "CNY",
				weeklyTokens: 42_000,
			};

			provider.debugDump(result, w);

			expect(lines).toContain("  balance: CNY 100.00");
			expect(lines).toContain("  weeklyTokens: 42000");
		});

		it("no-ops for non-deepseek result", () => {
			const lines: string[] = [];
			const w = (s: string) => lines.push(s);

			const result: NonNullable<ProviderUsageResult> = {
				provider: "zai",
				tokensLimitPct: 0,
				tokensResetAt: 0,
				level: "",
				weeklyTokens: 0,
				weeklyResetAt: 0,
				weeklyPct: 0,
				isNaturalWeek: false,
			};

			provider.debugDump(result, w);
			expect(lines).toEqual([]);
		});
	});
});
