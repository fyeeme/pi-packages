import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Key } from "@earendil-works/pi-tui";
import { clearThinkingUIModePreference, readThinkingUIModePreference, writeThinkingUIModePreference } from "./persistence.ts";
import { parseThinkingMode } from "./parse.ts";
import { streamingThinkingMarkdown, thinkingToMarkdown } from "./markdown-render.ts";
import {
	getThinkingUIMode,
	nextThinkingRefreshLabel,
	setCurrentThinkingScopeKey,
	setThinkingUIMode,
} from "./state.ts";
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

/**
 * Force every AssistantMessageComponent to re-run updateContent (and thus the
 * markdown transformer) by toggling the hidden-thinking label through pi's
 * ctx.ui proxy. `nextThinkingRefreshLabel` appends/toggles an invisible suffix
 * so the label string changes on every call — without it, setHiddenThinkingLabel
 * would no-op when the visible label is unchanged and the new mode would not
 * take effect until the next natural re-render.
 */
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

export default function thinkingUIExtension(pi: ExtensionAPI): void {
	// Render thinking via the provided markdown-transformer hook (no monkeypatch).
	// The native Markdown renderer draws whatever we return, styled as thinking
	// text. Re-runs on streaming, finalize, restore, resize, and whenever
	// refreshThinkingUI toggles the hidden-thinking label (mode switch).
	//
	// Scope caveat: MarkdownTransformContext carries no message/scope identity, so
	// the transformer resolves mode from the process-global currentScopeKey. The
	// per-scope mode map still serves the command/shortcut handlers (which have
	// ctx.cwd); only rendering is process-global. Fine while pi is single-session
	// interactive; a host-side scope id would be needed to fix (out of scope here).
	pi.registerMarkdownTransformer((markdown, context) => {
		if (context.messageType !== "assistant-thinking") return markdown;
		const mode = getThinkingUIMode();
		// Heavy heuristic derivation only on finalize/restore/resize; during
		// streaming (every chunk) stay cheap per pi's transformer contract.
		if (context.isStreaming) return streamingThinkingMarkdown(markdown, mode);
		return thinkingToMarkdown(markdown, mode);
	});

	pi.registerCommand("thinking-ui", {
		description: "Switch thinking view or set/clear project/global defaults",
		getArgumentCompletions: thinkingModeCompletions,
		handler: async (args, ctx) => {
			const action = parseCommandAction(args);
			if (!action) {
				notifyUser(ctx, "Usage: /thinking-ui [collapsed|summary|expanded] | [project|global] [collapsed|summary|expanded|clear]", "warning");
				return;
			}

			if (action.type === "clear") {
				try {
					await clearThinkingUIModePreference(action.scope, ctx.cwd);
				} catch (error) {
					reportPersistenceError(ctx, error);
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

			applyMode(pi, ctx, selectedMode, { announceScope: action.scope });
		},
	});

	pi.registerShortcut(Key.alt("t"), {
		description: "Cycle thinking view (collapsed, summary, expanded)",
		handler: async (ctx) => {
			const nextMode = cycleMode(getThinkingUIMode(ctx.cwd));
			applyMode(pi, ctx, nextMode, { announceScope: "session" });
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		setCurrentThinkingScopeKey(ctx.cwd);
		const restoredMode = await restoreMode(ctx);
		applyMode(pi, ctx, restoredMode, { persistSession: false });
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		setCurrentThinkingScopeKey(ctx.cwd);
		if (ctx.hasUI) {
			ctx.ui.setStatus("thinking-ui", undefined);
		}
	});
}
