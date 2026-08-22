import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEEPSEEK_CNY_PRICES,
	DeepSeekPricingStrategy,
	deepSeekPricing,
	isDeepSeekPeakTime,
} from "../pricing/deepseek.ts";
import { getPricingStrategy, pricingStrategies } from "../pricing/index.ts";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

/** 北京时间（UTC+8）构造测试时刻。 */
function bjTime(iso: string): Date {
	return new Date(`${iso}+08:00`);
}

/** 每个用例使用独立策略实例，避免单例状态跨用例泄漏。 */
function newStrategy(): DeepSeekPricingStrategy {
	return new DeepSeekPricingStrategy();
}

describe("billedInCny (结算币种判定)", () => {
	it("无任何状态时默认按 CNY（保持原 deepseek→¥ 行为）", () => {
		expect(newStrategy().billedInCny()).toBe(true);
	});

	it("balance 探测为 USD → 按 USD 计价（不覆盖、不重算）", () => {
		const s = newStrategy();
		s.setDetectedCurrency("USD");
		expect(s.billedInCny()).toBe(false);
	});

	it("balance 探测为 CNY → 按 CNY 计价", () => {
		const s = newStrategy();
		s.setDetectedCurrency("CNY");
		expect(s.billedInCny()).toBe(true);
	});

	it("用户显式 /currency 覆盖探测结果", () => {
		const s = newStrategy();
		s.setDetectedCurrency("USD");
		s.setCurrencyOverride("¥");
		expect(s.billedInCny()).toBe(true);

		s.setDetectedCurrency("CNY");
		s.setCurrencyOverride("$");
		expect(s.billedInCny()).toBe(false);
	});
});

describe("isDeepSeekPeakTime (北京时间峰谷时段判定)", () => {
	it("高峰时段：9:00-12:00、14:00-18:00（北京时间为准，与机器时区无关）", () => {
		// 边界：09:00 起峰，12:00 前为峰
		expect(isDeepSeekPeakTime(bjTime("2026-08-21T08:59"))).toBe(false);
		expect(isDeepSeekPeakTime(bjTime("2026-08-21T09:00"))).toBe(true);
		expect(isDeepSeekPeakTime(bjTime("2026-08-21T11:59"))).toBe(true);
		// 12:00-13:59 空闲
		expect(isDeepSeekPeakTime(bjTime("2026-08-21T12:00"))).toBe(false);
		expect(isDeepSeekPeakTime(bjTime("2026-08-21T13:59"))).toBe(false);
		// 14:00 起峰，18:00 前为峰
		expect(isDeepSeekPeakTime(bjTime("2026-08-21T14:00"))).toBe(true);
		expect(isDeepSeekPeakTime(bjTime("2026-08-21T17:59"))).toBe(true);
		// 18:00 起空闲
		expect(isDeepSeekPeakTime(bjTime("2026-08-21T18:00"))).toBe(false);
	});

	it("非高峰时段：凌晨与深夜（含 0 点边界）", () => {
		expect(isDeepSeekPeakTime(bjTime("2026-08-21T00:00"))).toBe(false);
		expect(isDeepSeekPeakTime(bjTime("2026-08-21T02:00"))).toBe(false);
		expect(isDeepSeekPeakTime(bjTime("2026-08-21T23:59"))).toBe(false);
	});

	it("2026-08-23 起周末全天为低谷：周六/周日任何时刻均非高峰（含跨 UTC 日期边界）", () => {
		// 生效后首个周六 2026-08-29：原高峰时段 → 低谷
		expect(isDeepSeekPeakTime(bjTime("2026-08-29T09:00"))).toBe(false);
		expect(isDeepSeekPeakTime(bjTime("2026-08-29T10:00"))).toBe(false);
		expect(isDeepSeekPeakTime(bjTime("2026-08-29T15:00"))).toBe(false);
		// 生效后周日 2026-08-30：北京时间周日 09:00 = UTC 周六 01:00，按北京日期判周末
		expect(isDeepSeekPeakTime(new Date("2026-08-30T01:00:00Z"))).toBe(false);
		// 周末深夜/凌晨仍为低谷（与小时规则一致）
		expect(isDeepSeekPeakTime(bjTime("2026-08-30T23:59"))).toBe(false);
	});

	it("生效前（2026-08-22 周六）仍按旧规则：高峰时段照常计峰", () => {
		// 2026-08-22 周六 10:00，早于 2026-08-23 00:00 北京时间生效点
		expect(isDeepSeekPeakTime(bjTime("2026-08-22T10:00"))).toBe(true);
		expect(isDeepSeekPeakTime(bjTime("2026-08-22T15:00"))).toBe(true);
		expect(isDeepSeekPeakTime(bjTime("2026-08-22T02:00"))).toBe(false);
		// 生效边界：2026-08-22T16:00Z = 北京时间 2026-08-23 00:00 起，周六已过、周日开始
		expect(isDeepSeekPeakTime(new Date("2026-08-22T16:00:00Z"))).toBe(false);
	});

	it("工作日不受周末规则影响", () => {
		expect(isDeepSeekPeakTime(bjTime("2026-09-04T10:00"))).toBe(true); // 周五
		expect(isDeepSeekPeakTime(bjTime("2026-08-31T10:00"))).toBe(true); // 周一
	});

	it("按北京时间判定：UTC 与北京时区之外传入的时刻也正确换算", () => {
		// 2026-08-21 01:00 UTC = 北京时间 09:00 → 高峰
		expect(isDeepSeekPeakTime(new Date("2026-08-21T01:00:00Z"))).toBe(true);
		// 2026-08-21 10:00 UTC = 北京时间 18:00 → 空闲
		expect(isDeepSeekPeakTime(new Date("2026-08-21T10:00:00Z"))).toBe(false);
	});
});

describe("messageCost (official CNY 峰谷定价)", () => {
	it("flash 高峰：¥3 输入 / ¥9 输出 / ¥0.10 缓存命中（每百万 tokens）", () => {
		const s = newStrategy();
		const c = s.messageCost(
			"deepseek-v4-flash",
			{ input: 136, output: 235, cacheRead: 193_152, cacheWrite: 0 },
			bjTime("2026-08-21T10:00"),
		);
		expect(c).not.toBeNull();
		expect(c).toBeCloseTo((136 * 3 + 235 * 9 + 193_152 * 0.1) / 1e6, 12);
	});

	it("flash 空闲（高峰一半）：¥1.5 输入 / ¥4.5 输出 / ¥0.05 缓存命中", () => {
		const s = newStrategy();
		const c = s.messageCost(
			"deepseek-v4-flash",
			{ input: 136, output: 235, cacheRead: 193_152, cacheWrite: 0 },
			bjTime("2026-08-21T02:00"),
		);
		expect(c).not.toBeNull();
		expect(c).toBeCloseTo((136 * 1.5 + 235 * 4.5 + 193_152 * 0.05) / 1e6, 12);
	});

	it("周末全天低谷价（2026-08-23 起）：周六高峰时刻也按空闲单价计费", () => {
		const s = newStrategy();
		const c = s.messageCost(
			"deepseek-v4-flash",
			{ input: 136, output: 235, cacheRead: 193_152, cacheWrite: 0 },
			bjTime("2026-08-29T10:00"), // 周六原高峰时段
		);
		expect(c).not.toBeNull();
		expect(c).toBeCloseTo((136 * 1.5 + 235 * 4.5 + 193_152 * 0.05) / 1e6, 12);
	});

	it("pro 高峰：¥9 输入 / ¥27 输出 / ¥0.30 缓存命中", () => {
		const s = newStrategy();
		const c = s.messageCost(
			"deepseek-v4-pro",
			{ input: 1_000, output: 500, cacheRead: 1_000_000, cacheWrite: 0 },
			bjTime("2026-08-21T15:00"),
		);
		expect(c).not.toBeNull();
		expect(c).toBeCloseTo((1_000 * 9 + 500 * 27 + 1_000_000 * 0.3) / 1e6, 12);
	});

	it("pro 空闲：¥4.5 输入 / ¥13.5 输出 / ¥0.15 缓存命中", () => {
		const s = newStrategy();
		const c = s.messageCost(
			"deepseek-v4-pro",
			{ input: 1_000, output: 500, cacheRead: 1_000_000, cacheWrite: 0 },
			bjTime("2026-08-21T20:00"),
		);
		expect(c).not.toBeNull();
		expect(c).toBeCloseTo((1_000 * 4.5 + 500 * 13.5 + 1_000_000 * 0.15) / 1e6, 12);
	});

	it("USD 结算 → 不接管（null，会话统计回退 pi 记录的 cost）", () => {
		const s = newStrategy();
		s.setDetectedCurrency("USD");
		expect(s.messageCost("deepseek-v4-flash", { input: 1, output: 1, cacheRead: 1, cacheWrite: 0 }, new Date()))
			.toBeNull();
	});

	it("未知模型 / 缺模型 id → null（调用方回退 m.usage.cost）", () => {
		const s = newStrategy();
		expect(
			s.messageCost("deepseek-chat", { input: 1, output: 1, cacheRead: 1, cacheWrite: 0 }, new Date()),
		).toBeNull();
		expect(
			s.messageCost(undefined, { input: 1, output: 1, cacheRead: 1, cacheWrite: 0 }, new Date()),
		).toBeNull();
	});

	it("定价表与 DeepSeek 官方 CNY 价一致（2026-08-17 峰谷计价）", () => {
		expect(DEEPSEEK_CNY_PRICES["deepseek-v4-flash"]).toEqual({
			peak: { input: 3.0, output: 9.0, cacheRead: 0.1, cacheWrite: 0 },
			offPeak: { input: 1.5, output: 4.5, cacheRead: 0.05, cacheWrite: 0 },
		});
		expect(DEEPSEEK_CNY_PRICES["deepseek-v4-pro"]).toEqual({
			peak: { input: 9.0, output: 27.0, cacheRead: 0.3, cacheWrite: 0 },
			offPeak: { input: 4.5, output: 13.5, cacheRead: 0.15, cacheWrite: 0 },
		});
		// 官方规则：空闲时段价格为高峰时段价格的一半
		for (const p of Object.values(DEEPSEEK_CNY_PRICES)) {
			expect(p.offPeak.input).toBeCloseTo(p.peak.input / 2, 9);
			expect(p.offPeak.output).toBeCloseTo(p.peak.output / 2, 9);
			expect(p.offPeak.cacheRead).toBeCloseTo(p.peak.cacheRead / 2, 9);
		}
	});

	it("deepseek-v4-flash-vision-exp 与 flash 同价（官方：图片按 token 计费，无视觉附加费），峰谷价重算生效", () => {
		expect(DEEPSEEK_CNY_PRICES["deepseek-v4-flash-vision-exp"]).toEqual(
			DEEPSEEK_CNY_PRICES["deepseek-v4-flash"],
		);
		const s = newStrategy();
		// 高峰未命中输入：1M × ¥3/1M
		const peak = s.messageCost(
			"deepseek-v4-flash-vision-exp",
			{ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
			bjTime("2026-08-21T10:00"),
		);
		expect(peak).toBeCloseTo(3.0, 9);
		// 空闲未命中输入：1M × ¥1.5/1M
		const off = s.messageCost(
			"deepseek-v4-flash-vision-exp",
			{ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
			bjTime("2026-08-21T02:00"),
		);
		expect(off).toBeCloseTo(1.5, 9);
	});
});

describe("defaultCurrency", () => {
	it("CNY 计价 → ¥；USD 计价 → null（由通用逻辑落 $）", () => {
		expect(newStrategy().defaultCurrency()).toBe("¥");
		const s = newStrategy();
		s.setDetectedCurrency("USD");
		expect(s.defaultCurrency()).toBeNull();
	});
});

describe("applyPricingPatch (runtime registry patch, 跟随结算币种与峰谷时段)", () => {
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
		// 取最后一次 registerProvider 调用 = 当前注册表状态
		return (calls[calls.length - 1].config as { models: Array<Record<string, unknown>> }).models;
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

	it("CNY 计价 + 高峰时段 → deepseek 模型 cost 覆盖为官方 CNY 高峰价，未知 deepseek 模型原样保留", () => {
		vi.useFakeTimers();
		vi.setSystemTime(bjTime("2026-08-21T10:00")); // 高峰
		const { registry, calls } = mockRegistry([flash, futureModel]);

		newStrategy().applyPricingPatch(registry);

		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe("deepseek");
		const models = modelsOf(calls);
		const patched = models.find((m) => m.id === "deepseek-v4-flash");
		expect(patched?.cost).toEqual({ input: 3.0, output: 9.0, cacheRead: 0.1, cacheWrite: 0 });
		expect(models.find((m) => m.id === "deepseek-v4-flash-latest")).toBe(futureModel);
	});

	it("CNY 计价 + 空闲时段 → 覆盖为官方 CNY 空闲价（高峰一半）", () => {
		vi.useFakeTimers();
		vi.setSystemTime(bjTime("2026-08-21T02:00")); // 空闲
		const { registry, calls } = mockRegistry([flash]);

		newStrategy().applyPricingPatch(registry);

		const models = modelsOf(calls);
		expect(models.find((m) => m.id === "deepseek-v4-flash")?.cost).toEqual({
			input: 1.5,
			output: 4.5,
			cacheRead: 0.05,
			cacheWrite: 0,
		});
	});

	it("峰谷翻转后重新补丁：空闲→高峰，注册表定价跟随翻转（shouldRefreshPatch）", () => {
		vi.useFakeTimers();
		vi.setSystemTime(bjTime("2026-08-21T02:00")); // 空闲
		const s = newStrategy();
		const { registry, calls } = mockRegistry([flash]);
		s.applyPricingPatch(registry);
		expect(modelsOf(calls).find((m) => m.id === "deepseek-v4-flash")?.cost).toEqual({
			input: 1.5,
			output: 4.5,
			cacheRead: 0.05,
			cacheWrite: 0,
		});
		expect(s.shouldRefreshPatch()).toBe(false);

		// 会话跨越 09:00 边界：渲染侧检测到翻转 → 重新补丁 → 高峰价
		vi.setSystemTime(bjTime("2026-08-21T09:30"));
		expect(s.shouldRefreshPatch()).toBe(true);
		s.applyPricingPatch(registry);
		expect(calls).toHaveLength(2);
		const models = modelsOf(calls);
		expect(models.find((m) => m.id === "deepseek-v4-flash")?.cost).toEqual({
			input: 3.0,
			output: 9.0,
			cacheRead: 0.1,
			cacheWrite: 0,
		});
		expect(s.shouldRefreshPatch()).toBe(false);
	});

	it("USD 结算（balance 探测 USD）→ 不覆盖，保持 pi 内置 USD 价", () => {
		const s = newStrategy();
		s.setDetectedCurrency("USD");
		const { registry, calls } = mockRegistry([flash, futureModel]);

		s.applyPricingPatch(registry);

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
		vi.useFakeTimers();
		vi.setSystemTime(bjTime("2026-08-21T10:00")); // 高峰
		// 先按 CNY 覆盖
		const s = newStrategy();
		const { registry: reg1, calls: c1 } = mockRegistry([flash]);
		s.applyPricingPatch(reg1);
		expect(modelsOf(c1).find((m) => m.id === "deepseek-v4-flash")?.cost).toEqual({
			input: 3.0,
			output: 9.0,
			cacheRead: 0.1,
			cacheWrite: 0,
		});

		// 用户切到 USD：再次 apply 应基于首次缓存的原始定义还原
		s.setCurrencyOverride("$");
		const { registry: reg2, calls: c2 } = mockRegistry([flash]);
		s.applyPricingPatch(reg2);
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
		newStrategy().applyPricingPatch(registry);
		expect(calls).toHaveLength(0);
	});
});

describe("footerTag (峰谷时段标注)", () => {
	it("CNY 计价：高峰 → peak，空闲 → off-peak", () => {
		vi.useFakeTimers();
		const s = newStrategy();
		vi.setSystemTime(bjTime("2026-08-21T10:00")); // 高峰
		expect(s.footerTag()).toBe("peak");
		vi.setSystemTime(bjTime("2026-08-21T02:00")); // 空闲
		expect(s.footerTag()).toBe("off-peak");
		vi.useRealTimers();
	});

	it("USD 计价 → null（不标注）", () => {
		const s = newStrategy();
		s.setDetectedCurrency("USD");
		expect(s.footerTag()).toBeNull();
	});
});

describe("pricingStrategies 注册表 (pricing/index.ts)", () => {
	it("deepseek 策略已注册，单例与注册表共享状态", () => {
		expect(pricingStrategies["deepseek"]).toBe(deepSeekPricing);
		expect(getPricingStrategy("deepseek")).toBe(deepSeekPricing);
		expect(getPricingStrategy("DeepSeek")).toBe(deepSeekPricing); // 大小写不敏感
		expect(getPricingStrategy("glm")).toBeUndefined(); // 未注册 → undefined
		expect(getPricingStrategy(undefined)).toBeUndefined();
	});

	it("策略单例 reset 后恢复默认状态", () => {
		deepSeekPricing.setDetectedCurrency("USD");
		expect(deepSeekPricing.billedInCny()).toBe(false);
		deepSeekPricing.reset();
		expect(deepSeekPricing.billedInCny()).toBe(true);
	});
});
