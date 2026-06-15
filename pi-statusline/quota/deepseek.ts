import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { QuotaCalculator, QuotaInfo, WeeklyQuota } from "./types.ts";
import { scanWeeklyTokens } from "../session-scanner.ts";

export class DeepSeekQuotaCalculator implements QuotaCalculator {
	async calculate(
		_modelRegistry: ExtensionContext["modelRegistry"],
		_model: ExtensionContext["model"],
	): Promise<QuotaInfo> {
		const weeklyTokens = scanWeeklyTokens("deepseek");

		// Next Monday 00:00 UTC
		const now = new Date();
		const dayOfWeek = now.getUTCDay();
		const daysUntilMonday = dayOfWeek === 0 ? 1 : 8 - dayOfWeek;
		const nextMonday = new Date(
			Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntilMonday, 0, 0, 0, 0),
		);

		const weekly: WeeklyQuota = {
			usedTokens: weeklyTokens,
			resetAt: nextMonday.getTime(),
			crossesNaturalWeek: false,
		};

		return {
			rolling: null,
			weekly,
		};
	}
}
