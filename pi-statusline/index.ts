/**
 * Status Line Extension v3
 *
 * Replaces the default footer with a custom status line.
 * Uses a strategy pattern to show provider-aware usage data:
 *   - DeepSeek: balance + weekly tokens (from session files)
 *   - ZAI/GLM:  rolling quota (5h + MCP) + weekly tokens (from API)
 *   - Others:   session-scoped cost only
 *
 * Commands:
 *   /status-debug  - dump session stats to /tmp/pi-status-debug.log
 *   /currency      - toggle ¥ / $ / auto
 */

import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { DeepSeekUsageProvider } from "./providers/deepseek.ts";
import { ZaiUsageProvider } from "./providers/zai.ts";
import type { UsageProvider } from "./providers/types.ts";
import { SessionTokenUsageCalculator } from "./token-usage.ts";
import {
	applyDeepSeekPricingPatch,
	setCostCurrencyOverride,
	getCostCurrencyOverride,
} from "./cost.ts";
import { refreshUsage, getCachedUsage, getUsageCacheAge } from "./cache.ts";
import { formatCwd, buildStatLine, buildInfoLine } from "./footer.ts";

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

const providers: Record<string, UsageProvider> = {
	deepseek: new DeepSeekUsageProvider(),
	zai: new ZaiUsageProvider(),
	"zai-coding-cn": new ZaiUsageProvider(),
};

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

let agentStartMs: number | null = null;
let lastCtx: ExtensionContext | null = null;
let lastModel: ExtensionContext["model"] = undefined;
let agentRunning = false;
let lastElapsedSec = 0;
let lastTps = 0;

const tokenCalculator = new SessionTokenUsageCalculator(() => getCostCurrencyOverride());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getElapsedSec(): number {
	if (agentRunning && agentStartMs !== null) return (Date.now() - agentStartMs) / 1000;
	return lastElapsedSec;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.on("agent_start", () => {
		agentStartMs = Date.now();
		agentRunning = true;
	});

	pi.on("agent_end", (event) => {
		agentRunning = false;
		if (agentStartMs === null) return;
		const elapsedMs = Date.now() - agentStartMs;
		if (elapsedMs <= 0) return;
		lastElapsedSec += elapsedMs / 1000;

		// Compute cumulative output tokens from all assistant messages in the session
		let cumulativeOutput = 0;
		if (lastCtx) {
			for (const entry of lastCtx.sessionManager.getEntries()) {
				if (entry.type === "message" && entry.message.role === "assistant") {
					cumulativeOutput += (entry.message as AssistantMessage).usage.output;
				}
			}
		} else {
			// fallback: use current turn's messages when no session context
			for (const m of event.messages) {
				if (m.role === "assistant") cumulativeOutput += (m as AssistantMessage).usage.output;
			}
		}
		lastTps = cumulativeOutput > 0 ? cumulativeOutput / lastElapsedSec : 0;

		// Schedule background refresh to pick up new usage data
		if (lastCtx && lastModel) {
			void refreshUsage(providers, lastCtx.modelRegistry, lastModel);
		}
	});

	// ---- /status-debug ----
	pi.registerCommand("status-debug", {
		description: "Dump session stats to /tmp/pi-status-debug.log + console.error",
		handler: async (_args, ctx) => {
			const logPath = `${tmpdir()}/pi-status-debug.log`;
			const w = (s: string) => {
				console.error(s);
				try { appendFileSync(logPath, s + "\n"); } catch { /* ok */ }
			};

			w("=== STATUS-LINE DEBUG ===");
			w(`cwd: ${ctx.cwd}`);
			w(`model: ${ctx.model?.provider}/${ctx.model?.id}`);
			w(`thinking: ${pi.getThinkingLevel()}`);

			const cu = ctx.getContextUsage();
			w(`contextUsage: tokens=${cu?.tokens ?? "?"} window=${cu?.contextWindow ?? "?"} percent=${cu?.percent ?? "?"}`);

			// Usage cache dump
			w(`--- provider usage ---`);
			const cached = getCachedUsage(providers, lastCtx, lastModel);
			if (cached) {
				w(`  provider: ${cached.provider}`);
				const dbgProvider = providers[cached.provider];
				if (dbgProvider) dbgProvider.debugDump(cached, w);
			} else {
				w(`  (no cached usage data)`);
			}
			const cacheAge = getUsageCacheAge();
			w(`  cacheAge: ${cacheAge !== null ? `${Math.round(cacheAge / 1000)}s` : "N/A"}`);

			let idx = 0;
			for (const entry of ctx.sessionManager.getEntries()) {
				if (entry.type === "message" && entry.message.role === "assistant") {
					const m = entry.message as AssistantMessage;
					w(`--- msg[${idx}] ---`);
					w(`  usage: ${JSON.stringify(m.usage)}`);
					w(`  model: ${m.model}`);
					w(`  cost: ${JSON.stringify(m.usage.cost)}`);
					idx++;
				}
			}

			const stats = tokenCalculator.compute(ctx);
			w(`--- computed ---`);
			w(`  input=${stats.input} output=${stats.output}`);
			w(`  cacheRead=${stats.cacheRead} cacheWrite=${stats.cacheWrite}`);
			w(`  total=${stats.total} cost=${stats.cost} currency=${stats.currency}`);
			w(`  hitRate=${(stats.hitRate * 100).toFixed(1)}%`);
			w("=========================");

			ctx.ui.notify(`Debug written to ${logPath} (${idx} msgs)`, "info");
		},
	});

	// ---- /currency ----
	pi.registerCommand("currency", {
		description: "Toggle cost currency (auto / ¥ / $)",
		handler: async (args, ctx) => {
			const a = args.trim().toLowerCase();
			if (a === "auto" || a === "") {
				setCostCurrencyOverride(undefined);
				ctx.ui.notify("Currency: auto (deepseek→¥ or balance currency)", "info");
			} else if (a === "¥" || a === "rmb" || a === "cny") {
				setCostCurrencyOverride("¥");
				ctx.ui.notify("Currency: ¥", "info");
			} else if (a === "$" || a === "usd") {
				setCostCurrencyOverride("$");
				ctx.ui.notify("Currency: $", "info");
			} else {
				ctx.ui.notify("Usage: /currency [auto|¥|$]", "warning");
				return;
			}
			// 币种变更后立即对齐注册表定价（CNY→覆盖为官方价；USD→还原 pi 内置价）
			applyDeepSeekPricingPatch(ctx.modelRegistry);
		},
	});

	// ---- Model switch: refresh usage when provider changes ----
	pi.on("model_select", (event) => {
		if (lastCtx) {
			lastModel = event.model;
			applyDeepSeekPricingPatch(lastCtx.modelRegistry);
			void refreshUsage(providers, lastCtx.modelRegistry, event.model);
		}
	});

	// ---- Footer ----
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;

		// Reset cumulative timing for new session
		lastElapsedSec = 0;
		lastTps = 0;

		// 根治：运行时修正 deepseek 定价（pi 内置定价低估约 7 倍），使后续 usage.cost 记录全局正确
		applyDeepSeekPricingPatch(ctx.modelRegistry);

		// Prime usage cache on startup (non-blocking)
		lastCtx = ctx;
		lastModel = ctx.model;
		void refreshUsage(providers, ctx.modelRegistry, ctx.model);

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					const stats = tokenCalculator.compute(ctx);
					const cu = ctx.getContextUsage();
					const model = ctx.model;
					const level = pi.getThinkingLevel();
					const providerResult = getCachedUsage(providers, lastCtx, lastModel);
					const dim = (s: string) => theme.fg("dim", s);
					const lines: string[] = [];

					// Line 0: cwd + git branch (left)  |  model · thinking (right)
					let pwd = formatCwd(ctx.cwd);
					const branch = footerData.getGitBranch();
					if (branch) pwd = `${pwd} (${branch})`;
					const left = dim(pwd);
					const right = dim(buildInfoLine(model?.id, level));
					const leftW = visibleWidth(left);
					const rightW = visibleWidth(right);
					if (leftW + rightW + 2 <= width) {
						const pad = " ".repeat(width - leftW - rightW);
						lines.push(left + pad + right);
					} else {
						lines.push(truncateToWidth(left + "  " + right, width, dim("...")));
					}

					// Line 1: tokens + cost + provider usage + context + elapsed + tps + mcp
					lines.push(truncateToWidth(
						dim(buildStatLine(stats, cu, providerResult, providers, getElapsedSec, lastTps)),
						width,
						dim("..."),
					));

					// Line 2: extension statuses
					const extStatuses = footerData.getExtensionStatuses();
					if (extStatuses.size > 0) {
						const text = Array.from(extStatuses.entries())
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, t]) => t.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim())
							.join(" ");
						lines.push(truncateToWidth(text, width, dim("...")));
					}

					return lines;
				},
			};
		});
	});
}
