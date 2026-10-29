import type { PricingStrategy } from "./types.ts";
import { deepSeekPricing } from "./deepseek.ts";

/**
 * 已注册的定价策略（按 provider id 索引）。新 provider 引入自有价格体系（如未来 GLM/ZAI
 * 跟进峰谷计价）时，实现 `PricingStrategy` 并在此注册，会话统计与渲染无需改动。
 */
export const pricingStrategies: Record<string, PricingStrategy> = {
	[deepSeekPricing.providerId]: deepSeekPricing,
};

/** 按 provider id 取定价策略（大小写不敏感）；未注册返回 undefined（成本走 pi 记录值、币种走 `$`）。 */
export function getPricingStrategy(provider: string | undefined): PricingStrategy | undefined {
	if (!provider) return undefined;
	return pricingStrategies[provider.toLowerCase()];
}
