/**
 * DeepSeek 定价修正（跟随结算币种）。
 *
 * 背景：pi 内置的 deepseek 定价数据（pi-ai 的 providers/data/deepseek.json）用的是官方 USD 价
 * （flash $0.14/0.28/0.0028、pro $0.435/0.87/0.003625 每百万 tokens）。DeepSeek 账户分 CNY 与 USD
 * 两种结算：CNY 账户按 ¥1/¥2/¥0.02、¥3/¥6/¥0.025 计费，此时 pi 记录的成本低估约 7 倍；USD 账户
 * 按 USD 计费，pi 内置价本来就是对的。
 *
 * 因此所有"修正"都必须跟随结算币种：
 *   1. `deepSeekBilledInCny()`：判定 DeepSeek 是否按 CNY 计价 —— 用户显式 `/currency` 优先；
 *      否则按 balance API 探测到的账户币种（探测失败/未知时按 CNY，保持原行为）。
 *   2. `deepseekMessageCostCny`：按官方 CNY 单价重算单条消息成本（仅 CNY 计价时用于兜底存量消息，
 *      会话文件里已记录的 cost 无法追溯修正）。
 *   3. `applyDeepSeekPricingPatch`：运行时把注册表中 deepseek 模型定价覆盖为官方 CNY 价（仅 CNY
 *      计价时；USD 计价时还原为 pi 内置 USD 价）。内存补丁，不修改数据文件、pi 升级不丢。
 */
import type { Model, Api } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export interface DeepSeekPricedUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** DeepSeek 官方 CNY 单价（元 / 百万 tokens）：缓存命中输入 / 未命中输入 / 输出（见官方定价页）。 */
export const DEEPSEEK_CNY_PRICES: Record<string, DeepSeekPricedUsage> = {
	"deepseek-v4-flash": { input: 1, output: 2, cacheRead: 0.02, cacheWrite: 0 },
	"deepseek-v4-pro": { input: 3, output: 6, cacheRead: 0.025, cacheWrite: 0 },
};

const PER_MILLION = 1_000_000;

// ---------------------------------------------------------------------------
// 结算币种状态（DeepSeek）
// ---------------------------------------------------------------------------

/** balance API 探测到的账户结算币种（CNY / USD / 其他）。 */
let detectedDeepSeekCurrency: string | null = null;
/** 用户显式 `/currency` 设置，覆盖自动判定。 */
let costCurrencyOverride: "¥" | "$" | undefined = undefined;
/** 首次 applyDeepSeekPricingPatch 时缓存的原始模型定义（用于 USD 计价时还原）。 */
let originalDeepSeekModels: Model<Api>[] | null = null;

/** 记录 balance API 探测到的 DeepSeek 账户结算币种（fetchUsage 成功后写入；null 表示未知）。 */
export function setDetectedDeepSeekCurrency(currency: string | null): void {
	detectedDeepSeekCurrency = currency;
}

/** 设置用户显式币种偏好（`/currency` 命令）；undefined 恢复自动判定。 */
export function setCostCurrencyOverride(override: "¥" | "$" | undefined): void {
	costCurrencyOverride = override;
}

/** 当前用户显式币种偏好（undefined = 自动）。 */
export function getCostCurrencyOverride(): "¥" | "$" | undefined {
	return costCurrencyOverride;
}

/**
 * DeepSeek 是否按 CNY 计价：用户显式偏好优先；否则仅当探测明确为 USD 时按 USD 计价，
 * 其余情况（CNY 或未知）按 CNY —— 保持原有"deepseek → ¥"的默认行为。
 */
export function deepSeekBilledInCny(): boolean {
	if (costCurrencyOverride === "$") return false;
	if (costCurrencyOverride === "¥") return true;
	return detectedDeepSeekCurrency !== "USD";
}

/** 重置币种状态与补丁缓存（测试用）。 */
export function resetDeepSeekPricingState(): void {
	detectedDeepSeekCurrency = null;
	costCurrencyOverride = undefined;
	originalDeepSeekModels = null;
}

// ---------------------------------------------------------------------------
// 单条消息成本重算
// ---------------------------------------------------------------------------

/**
 * 按官方 CNY 单价重算单条消息成本；模型不在定价表内返回 null（调用方回退 `m.usage.cost`）。
 *
 * @param model 消息模型 id（如 `deepseek-v4-flash`）
 * @param usage 消息的 token 用量分解
 */
export function deepseekMessageCostCny(
	model: string | undefined,
	usage: DeepSeekPricedUsage,
): number | null {
	if (!model) return null;
	const p = DEEPSEEK_CNY_PRICES[model];
	if (!p) return null;
	return (
		(p.input * usage.input +
			p.output * usage.output +
			p.cacheRead * usage.cacheRead +
			p.cacheWrite * usage.cacheWrite) /
		PER_MILLION
	);
}

// ---------------------------------------------------------------------------
// 运行时注册表补丁（根治 pi 内置定价，可逆、跟随结算币种）
// ---------------------------------------------------------------------------

/**
 * 把注册表中 deepseek 模型的定价与结算币种对齐：
 *  - CNY 计价：cost 覆盖为官方 CNY 价；
 *  - USD 计价：还原为 pi 内置 USD 价（首次调用时缓存原始定义，之后不再被 CNY 覆盖）。
 * 未知/未来新增模型原样保留；重复调用幂等；注册表未加载模型时静默跳过（由调用方后续重试）。
 */
export function applyDeepSeekPricingPatch(registry: ModelRegistry): void {
	const dsModels = registry.getAll().filter((m) => m.provider === "deepseek");
	if (dsModels.length === 0) return;
	if (!originalDeepSeekModels) {
		originalDeepSeekModels = dsModels;
	} else {
		// Merge in deepseek models added after the first snapshot, so a later
		// re-patch（币种切换 / model_select / 探测后纠正）不会丢掉它们：registerProvider
		// 是整表替换，用陈旧快照 map 会把新增模型从 registry 里静默删掉。
		const known = new Set(originalDeepSeekModels.map((m) => m.id));
		for (const m of dsModels) if (!known.has(m.id)) originalDeepSeekModels.push(m);
	}

	const billedInCny = deepSeekBilledInCny();
	const models = originalDeepSeekModels.map((m) => {
		if (!billedInCny) return m;
		const cny = DEEPSEEK_CNY_PRICES[m.id];
		if (!cny) return m;
		return { ...m, cost: { ...m.cost, ...cny } };
	});
	registry.registerProvider("deepseek", { models });
}
