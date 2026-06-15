import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { QuotaCalculator, QuotaInfo, WeeklyQuota } from "./types.ts";
import { scanWeeklyTokens } from "../session-scanner.ts";

export class ZaiQuotaCalculator implements QuotaCalculator {
	async calculate(
		modelRegistry: ExtensionContext["modelRegistry"],
		model: ExtensionContext["model"],
	): Promise<QuotaInfo> {
		if (!model || (model.provider !== "zai" && model.provider !== "zai-coding-cn")) {
			return { rolling: null, weekly: null };
		}

		const apiKey = await modelRegistry.getApiKeyForProvider(model.provider);
		if (!apiKey) return { rolling: null, weekly: null };

		const defaultOrigin = model.provider === "zai-coding-cn"
			? "https://open.bigmodel.cn"
			: "https://api.z.ai";
		let origin = defaultOrigin;
		try { origin = new URL(model.baseUrl ?? defaultOrigin).origin; } catch { /* use default */ }

		const headers: Record<string, string> = {
			Authorization: apiKey,
			"Accept-Language": "en-US,en",
			"Content-Type": "application/json",
		};

		let rolling: QuotaInfo["rolling"] = null;
		let weekly: QuotaInfo["weekly"] = null;

		try {
			const quotaRes = await fetch(`${origin}/api/monitor/usage/quota/limit`, {
				headers,
				signal: AbortSignal.timeout(5000),
			});
			if (quotaRes.ok) {
				const quotaData = (await quotaRes.json()) as {
					data?: {
						limits?: Array<{
							type: string;
							unit?: number;
							percentage?: number;
							nextResetTime?: number;
						}>;
					};
				};

				const limits = quotaData.data?.limits ?? [];
				const fiveHourLimit = limits.find((l) => l.type === "TOKENS_LIMIT" && l.unit === 3);
				const weeklyLimit = limits.find((l) => l.type === "TOKENS_LIMIT" && l.unit === 6);

				if (fiveHourLimit) {
					rolling = {
						usedPct: fiveHourLimit.percentage ?? 0,
						resetAt: fiveHourLimit.nextResetTime ?? 0,
					};
				}

				if (weeklyLimit && weeklyLimit.nextResetTime && weeklyLimit.nextResetTime > 0) {
					// unit:6 — weekly quota from API
					weekly = {
						usedTokens: 0, // actual token count fetched separately by provider
						resetAt: weeklyLimit.nextResetTime ?? 0,
						crossesNaturalWeek: true,
						weeklyPct: weeklyLimit.percentage ?? 0,
					};
				} else {
					// No unit:6 — natural week fallback
					const weeklyTokens = scanWeeklyTokens(model.provider);
					const now = new Date();
					const dayOfWeek = now.getUTCDay();
					const daysUntilMonday = dayOfWeek === 0 ? 1 : 8 - dayOfWeek;
					const nextMonday = new Date(
						Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntilMonday, 0, 0, 0, 0),
					);
					weekly = {
						usedTokens: weeklyTokens,
						resetAt: nextMonday.getTime(),
						crossesNaturalWeek: false,
					};
				}
			}
		} catch {
			// quota unavailable
		}

		return { rolling, weekly };
	}
}
