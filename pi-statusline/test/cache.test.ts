import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refreshUsage, getCachedUsage, getUsageCacheAge, resetUsageCache } from "../cache.ts";
import type { ProviderUsageResult } from "../types.ts";
import type { UsageProvider } from "../providers/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockModelRegistry(apiKey: string | null) {
	return {
		getApiKeyForProvider: vi.fn(async () => apiKey),
	} as any;
}

function mockModel(provider?: string) {
	return { provider, id: "test-model" } as any;
}

function makeProvider(fetchResult: ProviderUsageResult): UsageProvider {
	return {
		fetchUsage: vi.fn(async () => fetchResult),
		formatForFooter: vi.fn(() => ""),
		debugDump: vi.fn(),
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cache", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		resetUsageCache();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe("refreshUsage", () => {
		it("returns null when model has no matching provider", async () => {
			const providers: Record<string, UsageProvider> = {
				deepseek: makeProvider({ provider: "deepseek", totalBalance: "10", currency: "CNY", weeklyTokens: 0 }),
			};

			const result = await refreshUsage(
				providers,
				mockModelRegistry("key"),
				mockModel("unknown"),
			);
			expect(result).toBeNull();
			expect(getCachedUsage(providers, null, undefined)).toBeNull();
		});

		it("returns null when model is undefined", async () => {
			const providers: Record<string, UsageProvider> = {
				deepseek: makeProvider({ provider: "deepseek", totalBalance: "10", currency: "CNY", weeklyTokens: 0 }),
			};

			const result = await refreshUsage(
				providers,
				mockModelRegistry("key"),
				undefined,
			);
			expect(result).toBeNull();
		});

		it("calls fetchUsage and caches the result", async () => {
			const mockProv = makeProvider({ provider: "deepseek", totalBalance: "10", currency: "CNY", weeklyTokens: 1000 });
			const providers: Record<string, UsageProvider> = { deepseek: mockProv };

			const result = await refreshUsage(
				providers,
				mockModelRegistry("key"),
				mockModel("deepseek"),
			);

			expect(result).toEqual({ provider: "deepseek", totalBalance: "10", currency: "CNY", weeklyTokens: 1000 });
			expect(mockProv.fetchUsage).toHaveBeenCalledTimes(1);

			const cached = getCachedUsage(providers, null, undefined);
			expect(cached).toEqual(result);
		});

		it("clears cache when fetchUsage returns null", async () => {
			// First populate cache
			const mockProv1 = makeProvider({ provider: "deepseek", totalBalance: "10", currency: "CNY", weeklyTokens: 0 });
			const providers1 = { deepseek: mockProv1 };
			await refreshUsage(providers1, mockModelRegistry("key"), mockModel("deepseek"));

			// Then clear with null result
			const nullProv = makeProvider(null);
			const providers2 = { deepseek: nullProv };
			(nullProv.fetchUsage as any).mockResolvedValue(null);

			const result = await refreshUsage(providers2, mockModelRegistry("key"), mockModel("deepseek"));
			expect(result).toBeNull();
			expect(getCachedUsage(providers2, null, undefined)).toBeNull();
		});
	});

	describe("getCachedUsage", () => {
		it("returns null when cache is empty", () => {
			const providers: Record<string, UsageProvider> = {};
			expect(getCachedUsage(providers, null, undefined)).toBeNull();
		});

		it("returns cached result within TTL", async () => {
			const providers: Record<string, UsageProvider> = {
				deepseek: makeProvider({ provider: "deepseek", totalBalance: "10", currency: "CNY", weeklyTokens: 0 }),
			};
			await refreshUsage(providers, mockModelRegistry("key"), mockModel("deepseek"));

			// 4 minutes later — still within 5 min TTL
			vi.advanceTimersByTime(4 * 60 * 1000);

			const cached = getCachedUsage(providers, null, undefined);
			expect(cached).not.toBeNull();
			expect(cached!.provider).toBe("deepseek");
		});

		it("returns stale data when TTL expired but no context for refresh", async () => {
			const providers: Record<string, UsageProvider> = {
				deepseek: makeProvider({ provider: "deepseek", totalBalance: "10", currency: "CNY", weeklyTokens: 0 }),
			};
			await refreshUsage(providers, mockModelRegistry("key"), mockModel("deepseek"));

			// 6 minutes later — beyond 5 min TTL
			vi.advanceTimersByTime(6 * 60 * 1000);

			// No context/model provided → no background refresh, still returns stale
			const cached = getCachedUsage(providers, null, undefined);
			expect(cached).not.toBeNull();
		});
	});

	describe("getUsageCacheAge", () => {
		it("returns null when cache is empty", () => {
			expect(getUsageCacheAge()).toBeNull();
		});

		it("returns elapsed ms since last refresh", async () => {
			const providers: Record<string, UsageProvider> = {
				deepseek: makeProvider({ provider: "deepseek", totalBalance: "10", currency: "CNY", weeklyTokens: 0 }),
			};
			await refreshUsage(providers, mockModelRegistry("key"), mockModel("deepseek"));

			vi.advanceTimersByTime(90_000);

			expect(getUsageCacheAge()).toBe(90_000);
		});
	});
});
