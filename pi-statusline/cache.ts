import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ProviderUsageResult } from "./types.ts";
import type { UsageProvider } from "./providers/types.ts";

export type ProviderRegistry = Record<string, UsageProvider>;

interface CacheEntry {
	result: ProviderUsageResult;
	fetchedAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let usageCache: CacheEntry | null = null;

export function resetUsageCache(): void {
	usageCache = null;
}

export function getUsageCache(): CacheEntry | null {
	return usageCache;
}

export async function refreshUsage(
	providers: ProviderRegistry,
	modelRegistry: ExtensionContext["modelRegistry"],
	model: ExtensionContext["model"],
): Promise<ProviderUsageResult> {
	const providerName = model?.provider ?? "";
	const provider = providers[providerName];
	if (!provider) {
		usageCache = null;
		return null;
	}

	const result = await provider.fetchUsage(modelRegistry, model);
	if (result) {
		usageCache = { result, fetchedAt: Date.now() };
	} else {
		usageCache = null;
	}
	return result;
}

export function getUsageCacheAge(): number | null {
	if (!usageCache) return null;
	return Date.now() - usageCache.fetchedAt;
}

export function getCachedUsage(
	providers: ProviderRegistry,
	lastCtx: ExtensionContext | null,
	lastModel: ExtensionContext["model"] | undefined,
): ProviderUsageResult {
	if (!usageCache) return null;
	if (Date.now() - usageCache.fetchedAt > CACHE_TTL_MS) {
		// TTL expired: return stale data but trigger background refresh
		if (lastCtx && lastModel) {
			void refreshUsage(providers, lastCtx.modelRegistry, lastModel);
		}
	}
	return usageCache.result;
}
