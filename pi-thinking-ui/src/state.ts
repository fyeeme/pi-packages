import type { ThinkingUIMode } from "./types.ts";

const STATE_KEY = Symbol.for("pi-extensions.thinking-ui.state");
const DEFAULT_SCOPE_KEY = "__default__";
const LABEL_REFRESH_SUFFIX = "\u2060";

interface ThinkingUIGlobalState {
	currentScopeKey: string;
	modeByScopeKey: Record<string, ThinkingUIMode>;
	refreshToggleByScope: Record<string, boolean>;
}

interface LegacyThinkingUIGlobalState {
	mode?: unknown;
	currentScopeKey?: unknown;
	modeByScopeKey?: unknown;
	refreshToggleByScope?: unknown;
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
	return typeof value === "object" && value !== null;
}

function normalizeThinkingScopeKey(scopeKey?: string): string {
	const trimmed = scopeKey?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_SCOPE_KEY;
}

function normalizeThinkingMode(mode: unknown): ThinkingUIMode {
	return mode === "collapsed" || mode === "summary" || mode === "expanded" ? mode : "collapsed";
}

function normalizeModeByScopeKey(value: unknown, currentScopeKey: string, legacyMode: unknown): Record<string, ThinkingUIMode> {
	const modeByScopeKey: Record<string, ThinkingUIMode> = {};
	if (isRecord(value)) {
		for (const [scopeKey, scopeMode] of Object.entries(value)) {
			modeByScopeKey[normalizeThinkingScopeKey(scopeKey)] = normalizeThinkingMode(scopeMode);
		}
	}
	modeByScopeKey[currentScopeKey] ??= normalizeThinkingMode(legacyMode);
	return modeByScopeKey;
}

function ensureGlobalStateShape(state: ThinkingUIGlobalState & LegacyThinkingUIGlobalState): ThinkingUIGlobalState {
	const currentScopeKey = normalizeThinkingScopeKey(typeof state.currentScopeKey === "string" ? state.currentScopeKey : undefined);
	const modeByScopeKey = normalizeModeByScopeKey(state.modeByScopeKey, currentScopeKey, state.mode);
	const refreshToggleByScope: Record<string, boolean> = isRecord(state.refreshToggleByScope)
		? Object.fromEntries(Object.entries(state.refreshToggleByScope).map(([scopeKey, enabled]) => [normalizeThinkingScopeKey(scopeKey), enabled === true]))
		: {};

	for (const scopeKey of Object.keys(modeByScopeKey)) {
		refreshToggleByScope[scopeKey] ??= false;
	}

	state.currentScopeKey = currentScopeKey;
	state.modeByScopeKey = modeByScopeKey;
	state.refreshToggleByScope = refreshToggleByScope;
	return state;
}

const globalState = (() => {
	const existing = (globalThis as Record<PropertyKey, unknown>)[STATE_KEY];
	if (isRecord(existing)) {
		return ensureGlobalStateShape(existing as unknown as ThinkingUIGlobalState & LegacyThinkingUIGlobalState);
	}
	const created: ThinkingUIGlobalState = {
		currentScopeKey: DEFAULT_SCOPE_KEY,
		modeByScopeKey: { [DEFAULT_SCOPE_KEY]: "collapsed" },
		refreshToggleByScope: {},
	};
	(globalThis as Record<PropertyKey, unknown>)[STATE_KEY] = created;
	return created;
})();

function ensureScopeState(scopeKey: string): void {
	if (!(scopeKey in globalState.modeByScopeKey)) {
		globalState.modeByScopeKey[scopeKey] = "collapsed";
	}
	if (!(scopeKey in globalState.refreshToggleByScope)) {
		globalState.refreshToggleByScope[scopeKey] = false;
	}
}

export function getCurrentThinkingScopeKey(): string {
	return globalState.currentScopeKey;
}

export function setCurrentThinkingScopeKey(scopeKey: string): void {
	const normalizedScopeKey = normalizeThinkingScopeKey(scopeKey);
	ensureScopeState(normalizedScopeKey);
	globalState.currentScopeKey = normalizedScopeKey;
}

export function getThinkingUIMode(scopeKey?: string): ThinkingUIMode {
	const normalizedScopeKey = normalizeThinkingScopeKey(scopeKey ?? globalState.currentScopeKey);
	ensureScopeState(normalizedScopeKey);
	return globalState.modeByScopeKey[normalizedScopeKey] ?? "collapsed";
}

export function setThinkingUIMode(mode: ThinkingUIMode, scopeKey?: string): void {
	const normalizedScopeKey = normalizeThinkingScopeKey(scopeKey ?? globalState.currentScopeKey);
	ensureScopeState(normalizedScopeKey);
	globalState.modeByScopeKey[normalizedScopeKey] = mode;
	globalState.currentScopeKey = normalizedScopeKey;
}

export function nextThinkingRefreshLabel(label: string, scopeKey?: string): string {
	const normalizedScopeKey = normalizeThinkingScopeKey(scopeKey ?? globalState.currentScopeKey);
	ensureScopeState(normalizedScopeKey);
	const useInvisibleSuffix = globalState.refreshToggleByScope[normalizedScopeKey] ?? false;
	globalState.refreshToggleByScope[normalizedScopeKey] = !useInvisibleSuffix;
	return useInvisibleSuffix ? `${label}${LABEL_REFRESH_SUFFIX}` : label;
}

export function resetThinkingUIViewState(scopeKey?: string): void {
	if (scopeKey !== undefined) {
		const normalizedScopeKey = normalizeThinkingScopeKey(scopeKey);
		globalState.currentScopeKey = normalizedScopeKey;
		globalState.modeByScopeKey[normalizedScopeKey] = "collapsed";
		globalState.refreshToggleByScope[normalizedScopeKey] = false;
		return;
	}

	globalState.currentScopeKey = DEFAULT_SCOPE_KEY;
	globalState.modeByScopeKey = { [DEFAULT_SCOPE_KEY]: "collapsed" };
	globalState.refreshToggleByScope = {};
}
