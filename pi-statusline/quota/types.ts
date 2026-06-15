import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Rolling quota window (e.g. ZAI 5-hour token quota) */
export interface RollingQuota {
	/** Usage percentage 0–100 */
	usedPct: number;
	/** Epoch ms when the window resets */
	resetAt: number;
}

/** Weekly subscription quota */
export interface WeeklyQuota {
	/** Total tokens used in the subscription week */
	usedTokens: number;
	/** Epoch ms when the subscription week resets */
	resetAt: number;
	/** Whether resetAt crosses a natural week boundary */
	crossesNaturalWeek: boolean;
	/** Usage percentage from unit:6 TOKENS_LIMIT (0 if natural week) */
	weeklyPct?: number;
}

/** Provider-specific quota. Fields are null when the provider doesn't support them. */
export interface QuotaInfo {
	rolling: RollingQuota | null;
	weekly: WeeklyQuota | null;
}

export interface QuotaCalculator {
	calculate(
		modelRegistry: ExtensionContext["modelRegistry"],
		model: ExtensionContext["model"],
	): Promise<QuotaInfo>;
}
