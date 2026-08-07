import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEEPSEEK_CNY_PRICES,
	applyDeepSeekPricingPatch,
	deepSeekBilledInCny,
	deepseekMessageCostCny,
	resetDeepSeekPricingState,
	setCostCurrencyOverride,
	setDetectedDeepSeekCurrency,
} from "../cost.ts";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

beforeEach(() => {
	resetDeepSeekPricingState();
});

describe("deepSeekBilledInCny (结算币种判定)", () => {
	it("无任何状态时默认按 CNY（保持原 deepseek→¥ 行为）", () => {
		expect(deepSeekBilledInCny()).toBe(true);
	});

	it("balance 探测为 USD → 按 USD 计价（不覆盖、不重算）", () => {
		setDetectedDeepSeekCurrency("USD");
		expect(deepSeekBilledInCny()).toBe(false);
	});

	it("balance 探测为 CNY → 按 CNY 计价", () => {
		setDetectedDeepSeekCurrency("CNY");
		expect(deepSeekBilledInCny()).toBe(true);
	});

	it("用户显式 /currency 覆盖探测结果", () => {
		setDetectedDeepSeekCurrency("USD");
		setCostCurrencyOverride("¥");
		expect(deepSeekBilledInCny()).toBe(true);

		setDetectedDeepSeekCurrency("CNY");
		setCostCurrencyOverride("$");
		expect(deepSeekBilledInCny()).toBe(false);
	});
});

describe("deepseek cost recompute (official CNY pricing)", () => {
	it("flash: 官方 ¥1 输入 / ¥2 输出 / ¥0.02 缓存命中（每百万 tokens）", () => {
		const c = deepseekMessageCostCny("deepseek-v4-flash", {
			input: 136,
			output: 235,
			cacheRead: 193_152,
			cacheWrite: 0,
		});
		expect(c).not.toBeNull();
		expect(c).toBeCloseTo((136 * 1 + 235 * 2 + 193_152 * 0.02) / 1e6, 12);
	});

	it("pro: 官方 ¥3 输入 / ¥6 输出 / ¥0.025 缓存命中（每百万 tokens）", () => {
		const c = deepseekMessageCostCny("deepseek-v4-pro", {
			input: 1_000,
			output: 500,
			cacheRead: 1_000_000,
			cacheWrite: 0,
		});
		expect(c).not.toBeNull();
		expect(c).toBeCloseTo((1_000 * 3 + 500 * 6 + 1_000_000 * 0.025) / 1e6, 12);
	});

	it("未知模型 / 缺模型 id → null（调用方回退 m.usage.cost）", () => {
		expect(
			deepseekMessageCostCny("deepseek-chat", { input: 1, output: 1, cacheRead: 1, cacheWrite: 0 }),
		).toBeNull();
		expect(
			deepseekMessageCostCny(undefined, { input: 1, output: 1, cacheRead: 1, cacheWrite: 0 }),
		).toBeNull();
	});

	it("定价表与 DeepSeek 官方 CNY 价一致", () => {
		expect(DEEPSEEK_CNY_PRICES["deepseek-v4-flash"]).toEqual({
			input: 1,
			output: 2,
			cacheRead: 0.02,
			cacheWrite: 0,
		});
		expect(DEEPSEEK_CNY_PRICES["deepseek-v4-pro"]).toEqual({
			input: 3,
			output: 6,
			cacheRead: 0.025,
			cacheWrite: 0,
		});
	});
});

describe("applyDeepSeekPricingPatch (runtime registry patch, 跟随结算币种)", () => {
	/** 构造最小 mock ModelRegistry：getAll 返回模型，registerProvider 记录调用。 */
	function mockRegistry(models: unknown[]) {
		const calls: Array<{ name: string; config: unknown }> = [];
		const registry = {
			getAll: () => models,
			registerProvider: (name: string, config: unknown) => {
				calls.push({ name, config });
			},
		} as unknown as ModelRegistry;
		return { registry, calls };
	}

	function modelsOf(calls: Array<{ name: string; config: unknown }>): Array<Record<string, unknown>> {
		return (calls[0].config as { models: Array<Record<string, unknown>> }).models;
	}

	const flash = {
		id: "deepseek-v4-flash",
		provider: "deepseek",
		name: "DeepSeek V4 Flash",
		reasoning: true,
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 384_000,
		cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
	};
	const futureModel = {
		id: "deepseek-v4-flash-latest",
		provider: "deepseek",
		name: "DeepSeek V4 Flash Latest",
		reasoning: true,
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 384_000,
		cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
	};

	it("默认（CNY 计价）→ deepseek 模型 cost 覆盖为官方 CNY 价，未知 deepseek 模型原样保留", () => {
		const { registry, calls } = mockRegistry([flash, futureModel]);

		applyDeepSeekPricingPatch(registry);

		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe("deepseek");
		const models = modelsOf(calls);
		const patched = models.find((m) => m.id === "deepseek-v4-flash");
		expect(patched?.cost).toEqual({ input: 1, output: 2, cacheRead: 0.02, cacheWrite: 0 });
		expect(models.find((m) => m.id === "deepseek-v4-flash-latest")).toBe(futureModel);
	});

	it("USD 结算（balance 探测 USD）→ 不覆盖，保持 pi 内置 USD 价", () => {
		setDetectedDeepSeekCurrency("USD");
		const { registry, calls } = mockRegistry([flash, futureModel]);

		applyDeepSeekPricingPatch(registry);

		expect(calls).toHaveLength(1);
		const models = modelsOf(calls);
		expect(models.find((m) => m.id === "deepseek-v4-flash")?.cost).toEqual({
			input: 0.14,
			output: 0.28,
			cacheRead: 0.0028,
			cacheWrite: 0,
		});
	});

	it("CNY → USD 切换后可逆：/currency $ 后还原 pi 内置价", () => {
		// 先按 CNY 覆盖
		const { registry: reg1, calls: c1 } = mockRegistry([flash]);
		applyDeepSeekPricingPatch(reg1);
		expect(modelsOf(c1).find((m) => m.id === "deepseek-v4-flash")?.cost).toEqual({
			input: 1,
			output: 2,
			cacheRead: 0.02,
			cacheWrite: 0,
		});

		// 用户切到 USD：再次 apply 应基于首次缓存的原始定义还原
		setCostCurrencyOverride("$");
		const { registry: reg2, calls: c2 } = mockRegistry([flash]);
		applyDeepSeekPricingPatch(reg2);
		expect(c2).toHaveLength(1);
		expect(modelsOf(c2).find((m) => m.id === "deepseek-v4-flash")?.cost).toEqual({
			input: 0.14,
			output: 0.28,
			cacheRead: 0.0028,
			cacheWrite: 0,
		});
	});

	it("无 deepseek 模型时静默跳过，不注册", () => {
		const { registry, calls } = mockRegistry([{ id: "x", provider: "anthropic" }]);
		applyDeepSeekPricingPatch(registry);
		expect(calls).toHaveLength(0);
	});
});
