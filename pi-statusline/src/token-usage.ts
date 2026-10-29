import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TokenUsage, TokenUsageCalculator } from "./types.ts";
import { getPricingStrategy } from "./pricing/index.ts";

export class SessionTokenUsageCalculator implements TokenUsageCalculator {
	private getCurrencyOverride: () => "\u00a5" | "$" | undefined;

	constructor(getCurrencyOverride: () => "\u00a5" | "$" | undefined) {
		this.getCurrencyOverride = getCurrencyOverride;
	}

	compute(ctx: ExtensionContext): TokenUsage & { cost: number; currency: "\u00a5" | "$" } {
		let input = 0;
		let output = 0;
		let cacheRead = 0;
		let cacheWrite = 0;
		let total = 0;
		let cost = 0;

		// 定价策略按当前 provider 接管成本重算；未注册（或策略不接管）时回退 pi 记录的 cost。
		const strategy = getPricingStrategy(ctx.model?.provider);

		// Use getBranch() (current branch only) so token/cost stats exclude abandoned
		// sibling branches after /fork or /tree navigation. getEntries() would sum
		// the whole tree and overcount in forked sessions.
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				const m = entry.message as AssistantMessage;
				input += m.usage.input;
				output += m.usage.output;
				cacheRead += m.usage.cacheRead;
				cacheWrite += m.usage.cacheWrite;
				total += m.usage.totalTokens;
				// 策略接管时按消息时刻重算（如 DeepSeek CNY 峰谷价：跨 9:00/12:00/14:00/18:00
				// 边界的长会话各条消息各算各的）；否则沿用 pi 记录的 cost。
				const priced = strategy
					? strategy.messageCost(m.model, m.usage, m.timestamp ? new Date(m.timestamp) : new Date())
					: null;
				cost += priced !== null ? priced : (m.usage.cost?.total ?? 0);
			}
		}

		const hitRate = input + cacheRead > 0 ? cacheRead / (input + cacheRead) : 0;

		let currency: "\u00a5" | "$" = "$";
		const override = this.getCurrencyOverride();
		if (override) {
			currency = override;
		} else {
			currency = strategy?.defaultCurrency() ?? "$";
		}

		return { input, output, cacheRead, cacheWrite, total, hitRate, cost, currency };
	}
}
