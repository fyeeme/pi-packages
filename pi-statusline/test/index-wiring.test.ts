/**
 * index-wiring.test.ts — the extension entry (index.ts) event wiring:
 * agent_start/end timing + tok/s accumulation, the ui_prompt freeze span
 * ("waiting for user"), /currency command semantics, usage-cache triggers
 * (session_start / model_select / session_shutdown), and the no-UI guard.
 *
 * Providers and the usage cache are module-mocked so no network or local
 * session scanning ever runs; footer builders and pricing stay real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../providers/deepseek.ts", () => ({
	DeepSeekUsageProvider: class {
		fetchUsage = async () => null;
		formatForFooter = () => "";
		debugDump = () => {};
	},
}));
vi.mock("../providers/zai.ts", () => ({
	ZaiUsageProvider: class {
		fetchUsage = async () => null;
		formatForFooter = () => "";
		debugDump = () => {};
	},
}));
vi.mock("../cache.ts", () => ({
	refreshUsage: vi.fn(async () => null),
	getCachedUsage: vi.fn(() => null),
	getUsageCacheAge: vi.fn((): number | null => null),
	resetUsageCache: vi.fn(),
}));

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import defaultExport from "../index.ts";
import { refreshUsage, resetUsageCache } from "../cache.ts";
import { deepSeekPricing } from "../pricing/deepseek.ts";

interface FooterHandle {
	render(width: number): string[];
	dispose(): void;
	invalidate(): void;
}
type FooterFactory = (
	tui: unknown,
	theme: unknown,
	footerData: unknown,
) => FooterHandle;

function makeHarness(hasUI = true) {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const pi = {
		on: (evt: string, h: (event: unknown, ctx: unknown) => unknown) => {
			const list = handlers.get(evt) ?? [];
			list.push(h);
			handlers.set(evt, list);
		},
		registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
			commands.set(name, def);
		},
		getThinkingLevel: () => "think",
	} as unknown as ExtensionAPI;

	let footer: FooterFactory | null = null;
	const registry = { getAll: () => [], registerProvider: vi.fn() };
	const ui = {
		setFooter: (f: FooterFactory) => {
			footer = f;
		},
		notify: vi.fn(),
	};
	const ctx = {
		hasUI,
		cwd: "/tmp/pi-statusline-proj",
		model: { provider: "anthropic", id: "claude-x" },
		modelRegistry: registry,
		getContextUsage: () => undefined,
		sessionManager: { getBranch: () => [] },
		ui,
	} as never;

	defaultExport(pi);

	const fire = (evt: string, event: unknown) => {
		for (const h of handlers.get(evt) ?? []) void h(event, ctx);
	};
	const render = (width = 160): string[] => {
		if (!footer) throw new Error("footer not registered");
		const handle = footer(
			{ requestRender: () => {} } as never,
			{ fg: (_c: string, s: string) => s } as never,
			{
				onBranchChange: () => () => {},
				getGitBranch: () => "main",
				getExtensionStatuses: () => new Map(),
			} as never,
		);
		return handle.render(width);
	};
	return { fire, render, commands, registry, ctx, notify: ui.notify, hasFooter: () => footer !== null };
}

const assistantMsg = (output: number) => ({
	role: "assistant",
	usage: {
		input: 0,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
});

describe("statusline extension wiring", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		deepSeekPricing.reset();
	});

	it("accumulates elapsed time across runs and computes run-scoped tok/s", () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(0);
			const h = makeHarness();
			h.fire("session_start", { type: "session_start" });

			h.fire("agent_start", { type: "agent_start" });
			vi.setSystemTime(2_000);
			h.fire("agent_end", { type: "agent_end", messages: [assistantMsg(200)] });

			h.fire("agent_start", { type: "agent_start" });
			vi.setSystemTime(5_000); // +3s run with 150 output → 50.0 tok/s
			h.fire("agent_end", { type: "agent_end", messages: [assistantMsg(150)] });

			const lines = h.render();
			expect(lines[1]).toContain("5s"); // 2s + 3s cumulative
			expect(lines[1]).toContain("50.0tok/s"); // 150 out / 3s, last run wins
		} finally {
			vi.useRealTimers();
		}
	});

	it("freezes the timer and shows waiting for user while a blocking dialog is open", () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(0);
			const h = makeHarness();
			h.fire("session_start", { type: "session_start" });
			h.fire("agent_start", { type: "agent_start" });
			vi.setSystemTime(1_000);
			h.fire("ui_prompt_start", { type: "ui_prompt_start" });

			const frozen = h.render();
			expect(frozen[1]).toContain("waiting for user");
			expect(frozen[1]).toContain("1s");

			// User think-time must not tick the timer.
			vi.setSystemTime(60_000);
			expect(h.render()[1]).toContain("1s");

			h.fire("ui_prompt_end", { type: "ui_prompt_end" });
			const resumed = h.render();
			expect(resumed[1]).not.toContain("waiting for user");
		} finally {
			vi.useRealTimers();
		}
	});

	it("/currency toggles the pricing override and validates args", async () => {
		const h = makeHarness();
		h.fire("session_start", { type: "session_start" });
		const currency = h.commands.get("currency")!;

		await currency.handler("$", h.ctx);
		expect(deepSeekPricing.getCurrencyOverride()).toBe("$");
		expect(h.notify).toHaveBeenCalledWith("Currency: $", "info");

		await currency.handler("auto", h.ctx);
		expect(deepSeekPricing.getCurrencyOverride()).toBeUndefined();

		await currency.handler("yen", h.ctx);
		expect(h.notify).toHaveBeenCalledWith("Usage: /currency [auto|¥|$]", "warning");
	});

	it("usage cache: primed on session_start, refreshed on model_select, reset on shutdown", () => {
		const h = makeHarness();
		h.fire("session_start", { type: "session_start" });
		expect(refreshUsage).toHaveBeenCalledTimes(1);

		h.fire("model_select", { type: "model_select", model: { provider: "anthropic", id: "claude-y" } });
		expect(refreshUsage).toHaveBeenCalledTimes(2);

		h.fire("session_shutdown", { type: "session_shutdown" });
		expect(resetUsageCache).toHaveBeenCalledTimes(1);
	});

	it("registers no footer without a UI host", () => {
		const h = makeHarness(false);
		h.fire("session_start", { type: "session_start" });
		expect(h.hasFooter()).toBe(false);
	});
});
