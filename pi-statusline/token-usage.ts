import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TokenUsage, TokenUsageCalculator } from "./types.ts";
import { deepSeekBilledInCny, deepseekMessageCostCny } from "./cost.ts";

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

		const billedInCny = deepSeekBilledInCny();

		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				const m = entry.message as AssistantMessage;
				input += m.usage.input;
				output += m.usage.output;
				cacheRead += m.usage.cacheRead;
				cacheWrite += m.usage.cacheWrite;
				total += m.usage.totalTokens;
				// DeepSeek 仅按 CNY 计价时重算（pi 内置 USD 价低估约 7 倍）；USD 结算用户沿用 pi 记录的 cost
				const dsCost = billedInCny ? deepseekMessageCostCny(m.model, m.usage) : null;
				cost += dsCost !== null ? dsCost : (m.usage.cost?.total ?? 0);
			}
		}

		const hitRate = input + cacheRead > 0 ? cacheRead / (input + cacheRead) : 0;

		let currency: "\u00a5" | "$" = "$";
		const override = this.getCurrencyOverride();
		if (override) {
			currency = override;
		} else {
			const p = ctx.model?.provider ?? "";
			if (p.toLowerCase().includes("deepseek")) currency = deepSeekBilledInCny() ? "\u00a5" : "$";
		}

		return { input, output, cacheRead, cacheWrite, total, hitRate, cost, currency };
	}
}
