import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Key } from "@earendil-works/pi-tui";
import { retainThinkingUIPatch } from "./internal-patch.ts";
import { clearThinkingUIModePreference, readThinkingUIModePreference, writeThinkingUIModePreference } from "./persistence.ts";
import { parseThinkingMode } from "./parse.ts";
import { clearActiveThinkingState, clearThinkingMessageOwnership, getCurrentThinkingScopeKey, getThinkingUIMode, nextThinkingRefreshLabel, recordThinkingMessageScope, registerThinkingPatchRelease, resolveThinkingMessageScope, setActiveThinkingState, setCurrentThinkingScopeKey, setThinkingUIMode, takeThinkingPatchRelease } from "./state.ts";
import type { PersistedThinkingUIPreferenceScope, ThinkingUIMode } from "./types.ts";

type ThinkingUICommandScope = "session" | PersistedThinkingUIPreferenceScope;
type ThinkingUICommandAction =
	| { type: "set"; scope: ThinkingUICommandScope; mode?: ThinkingUIMode }
	| { type: "clear"; scope: PersistedThinkingUIPreferenceScope };

const CUSTOM_ENTRY_TYPE = "thinking-ui.mode";
const DEFAULT_HIDDEN_LABEL = "Thinking...";
const MODE_OPTIONS: ThinkingUIMode[] = ["collapsed", "summary", "expanded"];
const SCOPE_OPTIONS: PersistedThinkingUIPreferenceScope[] = ["project", "global"];

function modeChangeMessage(mode: ThinkingUIMode, scope: ThinkingUICommandScope): string {
	if (scope === "session") {
		return `Thinking view: ${mode}`;
	}

	return `Thinking view: ${mode} (saved for ${scope})`;
}

function notifyUser(ctx: ExtensionContext, message: string, level: "info" | "warning"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, level);
		return;
	}

	if (level === "warning") {
		console.warn(message);
		return;
	}

	console.info(message);
}

async function readRestoredModePreference(
	ctx: ExtensionContext,
	scope: PersistedThinkingUIPreferenceScope,
): Promise<ThinkingUIMode | undefined> {
	try {
		return await readThinkingUIModePreference(scope, ctx.cwd);
	} catch (error) {
		reportPersistenceError(ctx, error);
		return undefined;
	}
}

async function restoreMode(ctx: ExtensionContext): Promise<ThinkingUIMode> {
	const entries = ctx.sessionManager.getEntries() as Array<{ type?: string; customType?: string; data?: { mode?: string } }>;
	const savedEntries = entries.filter((entry) => entry.type === "custom" && entry.customType === CUSTOM_ENTRY_TYPE);
	for (let index = savedEntries.length - 1; index >= 0; index -= 1) {
		const sessionMode = parseThinkingMode(savedEntries[index]?.data?.mode ?? "");
		if (sessionMode) return sessionMode;
	}

	const projectMode = await readRestoredModePreference(ctx, "project");
	if (projectMode) return projectMode;

	const globalMode = await readRestoredModePreference(ctx, "global");
	return globalMode ?? "collapsed";
}

function refreshThinkingUI(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	setCurrentThinkingScopeKey(ctx.cwd);
	ctx.ui.setHiddenThinkingLabel(nextThinkingRefreshLabel(DEFAULT_HIDDEN_LABEL, ctx.cwd));
	ctx.ui.setStatus("thinking-ui", `${ctx.ui.theme.fg("muted", "thinking:")} ${ctx.ui.theme.fg("accent", getThinkingUIMode(ctx.cwd))}`);
}

function applyMode(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	mode: ThinkingUIMode,
	options?: { persistSession?: boolean; announceScope?: ThinkingUICommandScope },
): void {
	setCurrentThinkingScopeKey(ctx.cwd);
	setThinkingUIMode(mode, ctx.cwd);
	if (options?.persistSession !== false) {
		pi.appendEntry(CUSTOM_ENTRY_TYPE, { mode });
	}
	refreshThinkingUI(ctx);
	if (options?.announceScope) {
		notifyUser(ctx, modeChangeMessage(mode, options.announceScope), "info");
	}
}

function cycleMode(current: ThinkingUIMode): ThinkingUIMode {
	if (current === "collapsed") return "summary";
	if (current === "summary") return "expanded";
	return "collapsed";
}

function parsePreferenceScope(input: string): PersistedThinkingUIPreferenceScope | undefined {
	const normalized = input.trim().toLowerCase();
	if (["project", "proj", "p"].includes(normalized)) return "project";
	if (["global", "user", "g"].includes(normalized)) return "global";
	return undefined;
}

function parseCommandAction(args: string): ThinkingUICommandAction | undefined {
	const trimmed = args.trim();
	if (!trimmed) {
		return { type: "set", scope: "session" };
	}

	const scope = parsePreferenceScope(trimmed.split(/\s+/, 1)[0] ?? "");
	if (!scope) {
		const mode = parseThinkingMode(trimmed);
		return mode ? { type: "set", scope: "session", mode } : undefined;
	}

	const tail = trimmed.replace(/^\S+\s*/, "");
	if (!tail) {
		return { type: "set", scope };
	}

	if (["clear", "reset"].includes(tail.trim().toLowerCase())) {
		return { type: "clear", scope };
	}

	const mode = parseThinkingMode(tail);
	return mode ? { type: "set", scope, mode } : undefined;
}

function buildCompletionItems(values: string[], prefix: string, prefixText = ""): AutocompleteItem[] | null {
	const normalizedPrefix = prefix.trim().toLowerCase();
	const items = values
		.filter((value) => value.startsWith(normalizedPrefix))
		.map((value) => ({ value: `${prefixText}${value}`, label: value }));
	return items.length > 0 ? items : null;
}

function thinkingModeCompletions(prefix: string): AutocompleteItem[] | null {
	const trimmed = prefix.trim();
	const endsWithWhitespace = /\s$/.test(prefix);

	if (!trimmed) {
		return [
			...MODE_OPTIONS.map((value) => ({ value, label: value })),
			...SCOPE_OPTIONS.map((value) => ({ value, label: value })),
		];
	}

	const parts = trimmed.split(/\s+/);
	if (parts.length === 1 && !endsWithWhitespace) {
		return buildCompletionItems([...MODE_OPTIONS, ...SCOPE_OPTIONS], parts[0] ?? "");
	}

	const scope = parsePreferenceScope(parts[0] ?? "");
	if (!scope) {
		return null;
	}

	const valuePrefix = `${scope} `;
	const nestedPrefix = endsWithWhitespace ? "" : parts.slice(1).join(" " );
	return buildCompletionItems([...MODE_OPTIONS, "clear"], nestedPrefix, valuePrefix);
}

async function selectMode(ctx: ExtensionContext): Promise<ThinkingUIMode | undefined> {
	if (!ctx.hasUI) {
		return undefined;
	}

	const choice = await ctx.ui.select("Thinking view", MODE_OPTIONS);
	return choice ? parseThinkingMode(choice) : undefined;
}

function reportPersistenceError(ctx: ExtensionContext, error: unknown): void {
	notifyUser(ctx, `Thinking UI persistence error: ${error instanceof Error ? error.message : String(error)}`, "warning");
}

function reportPatchError(ctx: ExtensionContext, error: unknown): void {
	notifyUser(ctx, `Thinking UI patch error: ${error instanceof Error ? error.message : String(error)}`, "warning");
}

export default function thinkingUIExtension(pi: ExtensionAPI): void {
	let sessionScopeKey = getCurrentThinkingScopeKey();
	const degradedSessionScopes = new Set<string>();
	const setSessionScopeKey = (scopeKey: string): string => {
		sessionScopeKey = scopeKey;
		setCurrentThinkingScopeKey(scopeKey);
		return sessionScopeKey;
	};
	const markSessionDegraded = (scopeKey: string, degraded: boolean): void => {
		if (degraded) {
			degradedSessionScopes.add(scopeKey);
			return;
		}
		degradedSessionScopes.delete(scopeKey);
	};
	const isSessionDegraded = (scopeKey: string): boolean => degradedSessionScopes.has(scopeKey);
	const degradedSessionMessage = (): string => "Thinking UI is using Pi's native thinking renderer for this session; live mode switching is disabled.";
	const futureCompatibleSessionMessage = (scope: PersistedThinkingUIPreferenceScope, action: "saved" | "cleared"): string => `${action === "saved" ? "Saved" : "Cleared"} ${scope} thinking view default for future compatible sessions; the current session is using Pi's native thinking renderer.`;

	pi.registerCommand("thinking-ui", {
		description: "Switch thinking view or set/clear project/global defaults",
		getArgumentCompletions: thinkingModeCompletions,
		handler: async (args, ctx) => {
			const action = parseCommandAction(args);
			if (!action) {
				notifyUser(ctx, "Usage: /thinking-ui [collapsed|summary|expanded] | [project|global] [collapsed|summary|expanded|clear]", "warning");
				return;
			}

			const degraded = isSessionDegraded(ctx.cwd);
			if (action.type === "clear") {
				try {
					await clearThinkingUIModePreference(action.scope, ctx.cwd);
				} catch (error) {
					reportPersistenceError(ctx, error);
					return;
				}

				if (degraded) {
					notifyUser(ctx, futureCompatibleSessionMessage(action.scope, "cleared"), "info");
					return;
				}

				refreshThinkingUI(ctx);
				notifyUser(ctx, `Cleared ${action.scope} thinking view default`, "info");
				return;
			}

			const selectedMode = action.mode ?? (await selectMode(ctx));
			if (!selectedMode) {
				return;
			}

			if (action.scope !== "session") {
				try {
					await writeThinkingUIModePreference(action.scope, ctx.cwd, selectedMode);
				} catch (error) {
					reportPersistenceError(ctx, error);
					return;
				}
			}

			if (degraded) {
				if (action.scope === "session") {
					notifyUser(ctx, degradedSessionMessage(), "warning");
					return;
				}
				notifyUser(ctx, futureCompatibleSessionMessage(action.scope, "saved"), "info");
				return;
			}

			applyMode(pi, ctx, selectedMode, { announceScope: action.scope });
		},
	});

	pi.registerShortcut(Key.alt("t"), {
		description: "Cycle thinking view (collapsed, summary, expanded)",
		handler: async (ctx) => {
			if (isSessionDegraded(ctx.cwd)) {
				notifyUser(ctx, degradedSessionMessage(), "warning");
				return;
			}
			const nextMode = cycleMode(getThinkingUIMode(ctx.cwd));
			applyMode(pi, ctx, nextMode, { announceScope: "session" });
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const activeScopeKey = setSessionScopeKey(ctx.cwd);
		clearActiveThinkingState(undefined, activeScopeKey);
		try {
			registerThinkingPatchRelease(activeScopeKey, await retainThinkingUIPatch());
			markSessionDegraded(activeScopeKey, false);
		} catch (error) {
			markSessionDegraded(activeScopeKey, true);
			reportPatchError(ctx, error);
			notifyUser(ctx, degradedSessionMessage(), "warning");
			return;
		}

		const restoredMode = await restoreMode(ctx);
		applyMode(pi, ctx, restoredMode, { persistSession: false });
	});

	pi.on("message_start", async (event) => {
		if (event.message.role === "assistant") {
			recordThinkingMessageScope(event.message, sessionScopeKey);
			const ownerScopeKey = resolveThinkingMessageScope(event.message, sessionScopeKey);
			const timestamp = typeof (event.message as { timestamp?: unknown }).timestamp === "number"
				? (event.message as { timestamp: number }).timestamp
				: undefined;
			clearActiveThinkingState(timestamp, ownerScopeKey);
		}
	});

	pi.on("message_update", async (event) => {
		if (event.message.role !== "assistant") return;
		recordThinkingMessageScope(event.message, sessionScopeKey);
		const ownerScopeKey = resolveThinkingMessageScope(event.message, sessionScopeKey);
		const assistantEvent = event.assistantMessageEvent;
		if (assistantEvent.type === "thinking_start" || assistantEvent.type === "thinking_delta") {
			setActiveThinkingState({
				active: true,
				messageTimestamp: event.message.timestamp,
				contentIndex: assistantEvent.contentIndex,
			}, ownerScopeKey);
			return;
		}

		if (
			assistantEvent.type === "thinking_end" ||
			assistantEvent.type === "text_start" ||
			assistantEvent.type === "text_delta" ||
			assistantEvent.type === "text_end" ||
			assistantEvent.type === "toolcall_start" ||
			assistantEvent.type === "toolcall_delta" ||
			assistantEvent.type === "toolcall_end"
		) {
			clearActiveThinkingState(event.message.timestamp, ownerScopeKey);
		}
	});

	pi.on("message_end", async (event) => {
		if (event.message.role === "assistant") {
			recordThinkingMessageScope(event.message, sessionScopeKey);
			const ownerScopeKey = resolveThinkingMessageScope(event.message, sessionScopeKey);
			const timestamp = typeof (event.message as { timestamp?: unknown }).timestamp === "number"
				? (event.message as { timestamp: number }).timestamp
				: undefined;
			clearActiveThinkingState(timestamp, ownerScopeKey);
		}
	});

	pi.on("agent_end", async () => {
		clearActiveThinkingState(undefined, sessionScopeKey);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const activeScopeKey = setSessionScopeKey(ctx.cwd);
		clearActiveThinkingState(undefined, activeScopeKey);
		clearThinkingMessageOwnership(activeScopeKey);
		markSessionDegraded(activeScopeKey, false);
		if (ctx.hasUI) {
			ctx.ui.setStatus("thinking-ui", undefined);
		}

		const releasePatch = takeThinkingPatchRelease(activeScopeKey);
		if (!releasePatch) {
			return;
		}

		try {
			await releasePatch();
		} catch (error) {
			registerThinkingPatchRelease(activeScopeKey, releasePatch);
			reportPatchError(ctx, error);
		}
	});
}
