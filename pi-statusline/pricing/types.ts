import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

/** 消息 token 用量分解（会话统计所需的子集）。 */
export interface PricedUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/**
 * Provider 定价策略：把「该 provider 当前生效的价格体系」收敛到一个实现里。
 * 价格调整（如 DeepSeek 2026-08 峰谷计价、未来 GLM/ZAI 调价）只改对应策略，
 * 会话统计（token-usage）与渲染（index/footer）只依赖本接口，不感知具体 provider。
 */
export interface PricingStrategy {
	/** 适用 provider id（小写，如 `deepseek`）。 */
	readonly providerId: string;

	/**
	 * 按消息时刻重算单条消息成本；返回 null 表示不接管（会话统计回退 pi 记录的
	 * `usage.cost`，如 USD 结算的 DeepSeek 或未实现定价策略的 provider）。
	 *
	 * @param at 消息产生时刻；按时段计价的策略（如峰谷）据此选单价
	 */
	messageCost(model: string | undefined, usage: PricedUsage, at: Date): number | null;

	/** 该 provider 的成本显示币种偏好；null 表示不接管（通用逻辑按 `$`）。 */
	defaultCurrency(): "¥" | "$" | null;

	/** 把注册表中该 provider 模型的定价对齐当前价格体系；幂等可逆，无覆盖需求时 no-op。 */
	applyPricingPatch(registry: ModelRegistry): void;

	/** 注册表定价是否需要按当前状态重新对齐（如峰谷时段翻转）；无则 false。 */
	shouldRefreshPatch(): boolean;

	/** footer 附加标注（如当前峰谷时段 `峰`/`闲`）；无则 null。 */
	footerTag(): string | null;
}
