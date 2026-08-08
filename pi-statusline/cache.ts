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
let refreshInFlight: Promise<ProviderUsageResult> | null = null;
let refreshGeneration = 0;

export function resetUsageCache(): void {
	usageCache = null;
	refreshInFlight = null;
	refreshGeneration += 1;
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

	const gen = ++refreshGeneration;
	try {
		const result = await provider.fetchUsage(modelRegistry, model);
		// Drop stale responses from older generations
		if (gen !== refreshGeneration) return usageCache?.result ?? null;
		if (result) {
			usageCache = { result, fetchedAt: Date.now() };
		} else {
			usageCache = null;
		}
		return result;
	} catch {
		// Total catch: fire-and-forget callers must never see an unhandled rejection
		if (gen === refreshGeneration) usageCache = null;
		return null;
	}
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
	// Capture local snapshot before triggering background refresh: refreshUsage
	// may synchronously set usageCache = null when the provider is not found,
	// which would make the eventual `return cache.result` throw on null.
	const cache = usageCache;
	// Drop stale cache if the active provider changed since it was populated
	// (e.g. deepseek -> zai via /model). model_select already kicked off a
	// refresh; returning null avoids briefly showing the previous provider's
	// segment until the new fetch lands.
	if (lastModel && cache.result && cache.result.provider !== lastModel.provider) {
		return null;
	}
	if (Date.now() - cache.fetchedAt > CACHE_TTL_MS) {
		// TTL expired: return stale data but trigger background refresh.
		// Memoize inflight promise so concurrent callers share one fetch.
		if (lastCtx && lastModel) {
			if (!refreshInFlight) {
				const promise = refreshUsage(providers, lastCtx.modelRegistry, lastModel);
				refreshInFlight = promise;
				promise.finally(() => {
					if (refreshInFlight === promise) refreshInFlight = null;
				});
			}
		}
	}
	return cache.result;
}
