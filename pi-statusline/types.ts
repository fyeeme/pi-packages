import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Token usage
// ---------------------------------------------------------------------------

export interface TokenUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	/** cache hit ratio: cacheRead / (input + cacheRead), 0 when denominator is 0 */
	hitRate: number;
}

export interface TokenUsageCalculator {
	compute(ctx: ExtensionContext): TokenUsage & { cost: number; currency: "¥" | "$" };
}

// ---------------------------------------------------------------------------
// Provider result types
// ---------------------------------------------------------------------------

export type DeepSeekResult = {
	provider: "deepseek";
	totalBalance: string;
	currency: string;
	weeklyTokens: number;
};

export type ZaiResult = {
	provider: "zai";
	tokensLimitPct: number;
	tokensResetAt: number;
	level: string;
	weeklyTokens: number;
	weeklyResetAt: number;
	weeklyPct: number;
	isNaturalWeek: boolean;
};

export type ProviderUsageResult = DeepSeekResult | ZaiResult | null;
