import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ZaiResult, ProviderUsageResult } from "../types.ts";
import type { UsageProvider } from "./types.ts";
import { fmt, formatCountdown, formatWeeklyCountdown } from "../footer.ts";
import { startOfCurrentWeekLocal, startOfNextWeekLocal } from "../week.ts";

/** Check if the provider name is a ZAI/GLM variant. */
function isZaiProvider(provider: string): provider is "zai" | "zai-coding-cn" {
	return provider === "zai" || provider === "zai-coding-cn";
}

export class ZaiUsageProvider implements UsageProvider {

	async fetchUsage(
		modelRegistry: ExtensionContext["modelRegistry"],
		model: ExtensionContext["model"],
	): Promise<ProviderUsageResult> {
		if (!model || !isZaiProvider(model.provider)) return null;

		const apiKey = await modelRegistry.getApiKeyForProvider(model.provider);
		if (!apiKey) return null;

		const defaultOrigin = model.provider === "zai-coding-cn"
			? "https://open.bigmodel.cn"
			: "https://api.z.ai";
		let origin = defaultOrigin;
		try {
			origin = new URL(model.baseUrl ?? defaultOrigin).origin;
		} catch { /* use default */ }

		const headers: Record<string, string> = {
			Authorization: apiKey,
			"Accept-Language": "en-US,en",
			"Content-Type": "application/json",
		};

		try {
			// Fetch quota limits
			const quotaRes = await fetch(`${origin}/api/monitor/usage/quota/limit`, {
				headers,
				signal: AbortSignal.timeout(5000),
			});
			if (!quotaRes.ok) return null;

			const quotaData = (await quotaRes.json()) as {
				data?: {
					limits?: Array<{
						type: string;
						unit?: number;
						percentage?: number;
						nextResetTime?: number;
					}>;
					level?: string;
				};
			};

			const limits = quotaData.data?.limits ?? [];
			const fiveHourLimit = limits.find((l) => l.type === "TOKENS_LIMIT" && l.unit === 3);
			const weeklyLimit = limits.find((l) => l.type === "TOKENS_LIMIT" && l.unit === 6);
			const level = quotaData.data?.level ?? "";

			const now = Date.now();
			let weeklyTokens = 0;
			let weeklyResetAt = 0;
			let weeklyPct = 0;
			let isNaturalWeek = false;

			if (weeklyLimit && weeklyLimit.nextResetTime && weeklyLimit.nextResetTime > 0) {
				// unit:6 TOKENS_LIMIT exists — use API percentage + model-usage tokens
				weeklyPct = weeklyLimit.percentage ?? 0;
				weeklyResetAt = weeklyLimit.nextResetTime;
				const cycleStart = weeklyResetAt - 7 * 24 * 60 * 60 * 1000;
				weeklyTokens = await this.fetchCycleUsage(origin, headers, cycleStart, now);
			} else {
				// No unit:6 — natural week fallback. Fetch real usage from the
				// model-usage API for the current natural week (Mon 00:00 local → now)
				// so the figure matches the backend's per-week tally instead of
				// only counting tokens from local session files.
				isNaturalWeek = true;
				const d = new Date(now);
				const cycleStart = startOfCurrentWeekLocal(d);
				weeklyResetAt = startOfNextWeekLocal(d);
				weeklyTokens = await this.fetchCycleUsage(origin, headers, cycleStart, now);
			}

			return {
				provider: model.provider,
				tokensLimitPct: fiveHourLimit?.percentage ?? 0,
				tokensResetAt: fiveHourLimit?.nextResetTime ?? 0,
				level,
				weeklyTokens,
				weeklyResetAt,
				weeklyPct,
				isNaturalWeek,
			};
		} catch {
			return null;
		}
	}

	formatForFooter(result: NonNullable<ProviderUsageResult>, _sessionCost: number, _currency: string): string {
		if (!isZaiProvider(result.provider)) return "";
		const zai = result as ZaiResult;
		const parts: string[] = [];

		// 5-hour rolling quota
		const countdown = formatCountdown(zai.tokensResetAt);
		parts.push(`Usage ${zai.tokensLimitPct}%(${countdown})`);

		// Weekly quota
		if (zai.isNaturalWeek) {
			if (zai.weeklyTokens > 0) {
				parts.push(`W:${fmt(zai.weeklyTokens)}`);
			}
		} else if (zai.weeklyTokens > 0 || zai.weeklyPct > 0) {
			const weeklyCountdown = formatWeeklyCountdown(zai.weeklyResetAt);
			parts.push(`W:${zai.weeklyPct}%(${fmt(zai.weeklyTokens)},${weeklyCountdown})`);
		}

		return parts.join(" · ");
	}

	debugDump(result: NonNullable<ProviderUsageResult>, w: (s: string) => void): void {
		if (!isZaiProvider(result.provider)) return;
		const zai = result as ZaiResult;
		w(`  tokensLimitPct: ${zai.tokensLimitPct}%`);
		w(`  tokensResetAt: ${new Date(zai.tokensResetAt).toISOString()}`);
		w(`  level: ${zai.level}`);
		w(`  weeklyTokens: ${zai.weeklyTokens}`);
		w(`  weeklyPct: ${zai.weeklyPct}%`);
		w(`  isNaturalWeek: ${zai.isNaturalWeek}`);
		w(`  weeklyResetAt: ${zai.weeklyResetAt ? new Date(zai.weeklyResetAt).toISOString() : "?"}`);
	}

	/** Fetch model-usage for a time range. Returns total tokens. */
	private async fetchCycleUsage(
		origin: string,
		headers: Record<string, string>,
		cycleStartMs: number,
		nowMs: number,
	): Promise<number> {
		try {
			const fmtDate = (d: Date) =>
				`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
			const start = fmtDate(new Date(cycleStartMs));
			const end = fmtDate(new Date(nowMs));
			const url = `${origin}/api/monitor/usage/model-usage?startTime=${encodeURIComponent(start)}&endTime=${encodeURIComponent(end)}`;
			const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
			if (!res.ok) return 0;

			const usageData = (await res.json()) as {
				data?: {
					totalUsage?: { totalTokensUsage?: number };
					modelSummaryList?: Array<{ modelName: string; totalTokens: number }>;
				} | Array<{ totalTokens?: number }>;
			};

			const data = usageData.data;
			if (!data) return 0;
			if (Array.isArray(data)) {
				return data.reduce((sum, e) => sum + (e.totalTokens ?? 0), 0);
			}
			if (data.totalUsage?.totalTokensUsage != null) {
				return data.totalUsage.totalTokensUsage;
			}
			if (Array.isArray(data.modelSummaryList)) {
				return data.modelSummaryList.reduce((sum, e) => sum + (e.totalTokens ?? 0), 0);
			}
			return 0;
		} catch {
			return 0;
		}
	}
}
