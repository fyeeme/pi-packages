/**
 * DeepSeek 定价策略（跟随结算币种 + 峰谷时段）。
 *
 * 背景：pi 内置的 deepseek 定价数据（pi-ai 的 providers/data/deepseek.json）用的是旧版官方 USD 价
 * （flash $0.14/0.28、pro $0.435/0.87 每百万 tokens）。DeepSeek 账户分 CNY 与 USD 两种结算：
 *   - CNY 账户按官方 ¥ 价计费，且自 2026-08-17 起实施峰谷计价：高峰时段（北京时间 9:00-12:00、
 *     14:00-18:00）为官价，空闲时段为高峰的一半（见官方定价页备注）；
 *   - USD 账户按 USD 计费，pi 内置价负责（本策略不覆盖）。
 *
 * 因此所有「修正」都必须跟随结算币种与峰谷时段：
 *   1. `billedInCny()`：判定是否按 CNY 计价 —— 用户显式 `/currency` 优先；否则按 balance API
 *      探测到的账户币种（探测失败/未知时按 CNY，保持原有「deepseek → ¥」默认行为）。
 *   2. `isDeepSeekPeakTime()`：按北京时间（UTC+8，无夏令时）判定指定时刻是否高峰时段
 *      （2026-08-23 00:00 起周末周六、周日全天不再区分峰谷，统一按低谷价）。
 *   3. `messageCost()`：按消息时刻对应的峰谷单价重算单条消息成本（仅 CNY 计价时接管；USD 计价
 *      返回 null 回退 pi 记录的 cost —— 会话文件里已记录的 cost 无法追溯修正）。
 *   4. `applyPricingPatch()`：运行时把注册表中 deepseek 模型定价覆盖为当前时段的官方 CNY 价
 *      （仅 CNY 计价时；USD 计价时还原为 pi 内置 USD 价）。内存补丁，不修改数据文件、pi 升级不丢。
 */
import type { Model, Api } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { PricedUsage, PricingStrategy } from "./types.ts";

export interface DeepSeekPricedUsage extends PricedUsage {}

export interface DeepSeekCnyPrice {
	/** 高峰时段单价（元 / 百万 tokens） */
	peak: DeepSeekPricedUsage;
	/** 空闲时段单价（元 / 百万 tokens）= 高峰的一半（官方规则） */
	offPeak: DeepSeekPricedUsage;
}

/**
 * DeepSeek 官方 CNY 单价（元 / 百万 tokens），2026-08-17 峰谷计价起生效（见官方定价页）：
 * 缓存命中输入 / 未命中输入 / 输出；cacheWrite 官方未单列（按 0 计）。
 */
export const DEEPSEEK_CNY_PRICES: Record<string, DeepSeekCnyPrice> = {
	"deepseek-v4-flash": {
		peak: { input: 3.0, output: 9.0, cacheRead: 0.1, cacheWrite: 0 },
		offPeak: { input: 1.5, output: 4.5, cacheRead: 0.05, cacheWrite: 0 },
	},
	// 视觉变体：官方定价与 V4-Flash 完全相同（图片按 token 计费，单张最高 384 tokens，无视觉专项费用）
	"deepseek-v4-flash-vision-exp": {
		peak: { input: 3.0, output: 9.0, cacheRead: 0.1, cacheWrite: 0 },
		offPeak: { input: 1.5, output: 4.5, cacheRead: 0.05, cacheWrite: 0 },
	},
	"deepseek-v4-pro": {
		peak: { input: 9.0, output: 27.0, cacheRead: 0.3, cacheWrite: 0 },
		offPeak: { input: 4.5, output: 13.5, cacheRead: 0.15, cacheWrite: 0 },
	},
};

const PER_MILLION = 1_000_000;

const BJ_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 周末全天低谷价生效起点：2026-08-23 00:00 北京时间 = 2026-08-22T16:00Z。 */
const WEEKEND_OFFPEAK_SINCE_MS = Date.parse("2026-08-22T16:00:00Z");

/**
 * DeepSeek 高峰时段判定：北京时间（UTC+8，无夏令时）9:00-12:00、14:00-18:00 为高峰，
 * 其余为空闲时段（官方定价页备注）。`at` 可指定时刻，默认当前时间。
 *
 * 2026-08-23（周日）00:00 北京时间起，官方调整：周末（周六、周日）全天不再区分峰谷，
 * 统一按低谷价收取 —— 即生效后的周六/周日任何时刻均判为空闲时段。生效前（如 2026-08-22
 * 周六）的历史消息仍按旧规则计价，保证跨生效日的长会话逐条重算正确。
 */
export function isDeepSeekPeakTime(at: Date = new Date()): boolean {
	const beijing = new Date(at.getTime() + BJ_OFFSET_MS);
	if (at.getTime() >= WEEKEND_OFFPEAK_SINCE_MS) {
		const bjDay = beijing.getUTCDay(); // 0=周日 6=周六（按北京日期，非 UTC 日期）
		if (bjDay === 0 || bjDay === 6) return false;
	}
	const beijingHour = beijing.getUTCHours();
	return (beijingHour >= 9 && beijingHour < 12) || (beijingHour >= 14 && beijingHour < 18);
}

export class DeepSeekPricingStrategy implements PricingStrategy {
	readonly providerId = "deepseek";

	/** balance API 探测到的账户结算币种（CNY / USD / 其他）。 */
	private detectedCurrency: string | null = null;
	/** 用户显式 `/currency` 设置，覆盖自动判定。 */
	private currencyOverride: "¥" | "$" | undefined = undefined;
	/** 首次 applyPricingPatch 时缓存的原始模型定义（用于 USD 计价时还原）。 */
	private originalModels: Model<Api>[] | null = null;
	/** 上次注册表补丁写入时的时段（用于峰谷翻转后廉价重新对齐）。 */
	private lastPatchedPeriod: "peak" | "offPeak" | null = null;

	/** 记录 balance API 探测到的账户结算币种（fetchUsage 成功后写入；null 表示未知）。 */
	setDetectedCurrency(currency: string | null): void {
		this.detectedCurrency = currency;
	}

	/** 设置用户显式币种偏好（`/currency` 命令）；undefined 恢复自动判定。 */
	setCurrencyOverride(override: "¥" | "$" | undefined): void {
		this.currencyOverride = override;
	}

	/** 当前用户显式币种偏好（undefined = 自动）。 */
	getCurrencyOverride(): "¥" | "$" | undefined {
		return this.currencyOverride;
	}

	/**
	 * 是否按 CNY 计价：用户显式偏好优先；否则仅当探测明确为 USD 时按 USD 计价，
	 * 其余情况（CNY 或未知）按 CNY —— 保持原有「deepseek → ¥」的默认行为。
	 */
	billedInCny(): boolean {
		if (this.currencyOverride === "$") return false;
		if (this.currencyOverride === "¥") return true;
		return this.detectedCurrency !== "USD";
	}

	/** 重置策略状态与补丁缓存（测试用）。 */
	reset(): void {
		this.detectedCurrency = null;
		this.currencyOverride = undefined;
		this.originalModels = null;
		this.lastPatchedPeriod = null;
	}

	messageCost(model: string | undefined, usage: PricedUsage, at: Date): number | null {
		// 仅 CNY 计价时接管重算；USD 结算用户沿用 pi 记录的 cost
		if (!this.billedInCny()) return null;
		if (!model) return null;
		const p = DEEPSEEK_CNY_PRICES[model];
		if (!p) return null;
		const rates = isDeepSeekPeakTime(at) ? p.peak : p.offPeak;
		return (
			(rates.input * usage.input +
				rates.output * usage.output +
				rates.cacheRead * usage.cacheRead +
				rates.cacheWrite * usage.cacheWrite) /
			PER_MILLION
		);
	}

	defaultCurrency(): "¥" | "$" | null {
		return this.billedInCny() ? "¥" : null;
	}

	applyPricingPatch(registry: ModelRegistry): void {
		const dsModels = registry.getAll().filter((m) => m.provider === this.providerId);
		if (dsModels.length === 0) return;
		if (!this.originalModels) {
			this.originalModels = dsModels;
		} else {
			// Merge in deepseek models added after the first snapshot, so a later
			// re-patch（时段翻转 / 币种切换 / model_select / 探测后纠正）不会丢掉它们：
			// registerProvider 是整表替换，用陈旧快照 map 会把新增模型从 registry 里静默删掉。
			const known = new Set(this.originalModels.map((m) => m.id));
			for (const m of dsModels) if (!known.has(m.id)) this.originalModels.push(m);
		}

		const billedInCny = this.billedInCny();
		const peak = isDeepSeekPeakTime();
		this.lastPatchedPeriod = peak ? "peak" : "offPeak";
		const models = this.originalModels.map((m) => {
			if (!billedInCny) return m;
			const cny = DEEPSEEK_CNY_PRICES[m.id];
			if (!cny) return m;
			const rates = peak ? cny.peak : cny.offPeak;
			return { ...m, cost: { ...m.cost, ...rates } };
		});
		registry.registerProvider("deepseek", { models });
	}

	shouldRefreshPatch(): boolean {
		if (this.lastPatchedPeriod === null) return false;
		return isDeepSeekPeakTime() !== (this.lastPatchedPeriod === "peak");
	}

	footerTag(): string | null {
		// 峰谷计价（2026-08-17 起）生效后，标注当前时段：CNY 计价按官方峰谷价重算，直接可见；
		// USD 计价走 pi 内置价（无峰谷概念），不标注避免误导。
		return this.billedInCny() ? (isDeepSeekPeakTime() ? "peak" : "off-peak") : null;
	}
}

/** DeepSeek 定价策略单例（注册表与消费方共用同一份状态）。 */
export const deepSeekPricing = new DeepSeekPricingStrategy();
