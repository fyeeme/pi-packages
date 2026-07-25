import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DeepSeekResult, ProviderUsageResult } from "../types.ts";
import type { UsageProvider } from "./types.ts";
import { scanWeeklyTokens } from "../session-scanner.ts";
import { fmt } from "../footer.ts";

export class DeepSeekUsageProvider implements UsageProvider {

	async fetchUsage(
		modelRegistry: ExtensionContext["modelRegistry"],
		model: ExtensionContext["model"],
	): Promise<ProviderUsageResult> {
		if (!model || model.provider !== "deepseek") return null;

		const apiKey = await modelRegistry.getApiKeyForProvider("deepseek");
		if (!apiKey) return null;

		let origin = "https://api.deepseek.com";
		try {
			const u = new URL(model.baseUrl ?? "https://api.deepseek.com");
			origin = u.origin;
		} catch { /* use default */ }

		try {
			const res = await fetch(`${origin}/user/balance`, {
				headers: { Authorization: `Bearer ${apiKey}` },
				signal: AbortSignal.timeout(5000),
			});
			if (!res.ok) return null;

			const data = (await res.json()) as {
				is_available?: boolean;
				balance_infos?: Array<{
					currency?: string;
					total_balance?: string;
				}>;
			};

			const info = data.balance_infos?.[0];
			if (!info) return null;

			const weeklyTokens = scanWeeklyTokens("deepseek");

			return {
				provider: "deepseek",
				totalBalance: info.total_balance ?? "?",
				currency: info.currency ?? "CNY",
				weeklyTokens,
			};
		} catch {
			return null;
		}
	}

	formatForFooter(result: NonNullable<ProviderUsageResult>, sessionCost: number, currency: string): string {
		if (result.provider !== "deepseek") return "";
		const ds = result as DeepSeekResult;
		const balance = `${ds.currency === "CNY" ? "¥" : "$"}${ds.totalBalance}`;
		const weekly = ds.weeklyTokens > 0 ? `7d:${fmt(ds.weeklyTokens)}` : "";
		const parts: string[] = [];

		if (sessionCost > 0) {
			parts.push(`${currency}${sessionCost.toFixed(2)}/${balance}`);
		} else {
			parts.push(balance);
		}
		if (weekly) parts.push(weekly);

		return parts.join(" · ");
	}

	debugDump(result: NonNullable<ProviderUsageResult>, w: (s: string) => void): void {
		if (result.provider !== "deepseek") return;
		const ds = result as DeepSeekResult;
		w(`  balance: ${ds.currency} ${ds.totalBalance}`);
		w(`  weeklyTokens: ${ds.weeklyTokens}`);
	}
}
