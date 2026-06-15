import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TokenUsage, TokenUsageCalculator } from "./types.ts";

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

		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				const m = entry.message as AssistantMessage;
				input += m.usage.input;
				output += m.usage.output;
				cacheRead += m.usage.cacheRead;
				cacheWrite += m.usage.cacheWrite;
				total += m.usage.totalTokens;
				cost += m.usage.cost.total;
			}
		}

		const hitRate = input + cacheRead > 0 ? cacheRead / (input + cacheRead) : 0;

		let currency: "\u00a5" | "$" = "$";
		const override = this.getCurrencyOverride();
		if (override) {
			currency = override;
		} else {
			const p = ctx.model?.provider ?? "";
			if (p.toLowerCase().includes("deepseek")) currency = "\u00a5";
		}

		return { input, output, cacheRead, cacheWrite, total, hitRate, cost, currency };
	}
}
