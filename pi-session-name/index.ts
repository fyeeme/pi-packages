import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";

// ---------------------------------------------------------------------------
// Types & helpers for buildConversationText
// ---------------------------------------------------------------------------

type ContentBlock = { type?: string; text?: string };
export type SessionEntry = { type: string; message?: { role?: string; content?: unknown } };

const extractText = (content: unknown): string[] => {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	const parts: string[] = [];
	for (const part of content) {
		if (part && typeof part === "object") {
			const b = part as ContentBlock;
			if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
		}
	}
	return parts;
};

const truncate = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max)}\u2026`);

export function buildConversationText(
	entries: SessionEntry[],
	opts: { maxMessages?: number; maxCharsPerMessage?: number } = {},
): string {
	const maxMessages = opts.maxMessages ?? 8;
	const maxCharsPerMessage = opts.maxCharsPerMessage ?? 600;
	const msgs = entries
		.filter((e) => e.type === "message" && (e.message?.role === "user" || e.message?.role === "assistant"))
		.map((e) => ({
			role: e.message!.role as "user" | "assistant",
			text: extractText(e.message!.content).join("\n").trim(),
		}))
		.filter((m) => m.text.length > 0);
	if (msgs.length === 0) return "";
	const selected = msgs.length > maxMessages ? [msgs[0], ...msgs.slice(-(maxMessages - 1))] : msgs;
	return selected
		.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${truncate(m.text, maxCharsPerMessage)}`)
		.join("\n\n");
}

// ---------------------------------------------------------------------------
// cleanTitle — strip wrapping quotes/brackets, collapse whitespace, truncate
// ---------------------------------------------------------------------------

export function cleanTitle(raw: string, maxLength: number = 200): string | null {
	if (!raw) return null;
	let t = raw.trim();
	t = t.replace(/^["'`\u300C\u300E\uFF08(\[]+|["'`\u300D\u300F\uFF09)\].]+$/g, "").trim();
	t = t.replace(/\s+/g, " ");
	t = t.replace(/[.\u3002!\uFF01?\uFF1F]+$/g, "");
	if (!t) return null;
	if (t.length > maxLength) t = t.slice(0, maxLength).trim();
	return t.length > 0 ? t : null;
}

// ---------------------------------------------------------------------------
// Prompt builders — first-title & auto-rename prompts
// ---------------------------------------------------------------------------

export function buildFirstPrompt(
	conversationText: string,
	opts: { maxLength?: number } = {},
): string {
	const maxLength = opts.maxLength ?? 200;
	return [
		"You generate a descriptive title for this conversation so the user can find it later in a session list.",
		"Rules:",
		'- Output ONLY the title text. No quotes, no trailing punctuation, no explanation.',
		"- Use the SAME language as the user's first message.",
		'- Be descriptive, not terse: include the key entity (class, component, or concept), the action, and the goal — not a vague category.',
		`- Aim for roughly 15-40 characters; never exceed ${maxLength} characters.`,
		"",
		"<conversation>",
		conversationText,
		"</conversation>",
	].join("\n");
}

export function buildAutoPrompt(
	currentName: string,
	conversationText: string,
	opts: { maxLength?: number } = {},
): string {
	const maxLength = opts.maxLength ?? 200;
	return [
		"You decide whether the session title still matches the conversation.",
		`- Current title: ${currentName}`,
		"If the title is still accurate, reply with exactly: KEEP",
		"If it is inaccurate or too vague now, output a NEW descriptive title.",
		"Rules for a new title:",
		'- ONLY the title text. No quotes, no trailing punctuation, no explanation.',
		"- Use the SAME language as the user's first message.",
		'- Be descriptive, not terse: include the key entity (class, component, or concept), the action, and the goal — not a vague category.',
		`- Aim for roughly 15-40 characters; never exceed ${maxLength} characters.`,
		"",
		"<conversation>",
		conversationText,
		"</conversation>",
	].join("\n");
}

// ---------------------------------------------------------------------------
// SessionNameConfig + loadConfig
// ---------------------------------------------------------------------------

export interface SessionNameConfig {
	mode: "first" | "auto";
	enabled: boolean;
	maxLength: number;
	model?: { provider: string; id: string };
}

const DEFAULT_CONFIG: SessionNameConfig = { mode: "first", enabled: true, maxLength: 200 };

export function loadConfig(cwd: string, env: Record<string, string | undefined> = process.env): SessionNameConfig {
	let fileCfg: Partial<SessionNameConfig> = {};
	const file = join(cwd, ".pi", "session-name.json");
	try {
		fileCfg = JSON.parse(readFileSync(file, "utf8")) as Partial<SessionNameConfig>;
	} catch {
		// missing or malformed config — ignore, fall back to defaults
	}
	const cfg: SessionNameConfig = { ...DEFAULT_CONFIG, ...fileCfg };
	if (env.PI_SESSION_NAME_MODE === "first" || env.PI_SESSION_NAME_MODE === "auto") cfg.mode = env.PI_SESSION_NAME_MODE;
	if (env.PI_SESSION_NAME_ENABLED === "false") cfg.enabled = false;
	if (env.PI_SESSION_NAME_MAX_LENGTH) {
		const n = Number(env.PI_SESSION_NAME_MAX_LENGTH);
		if (Number.isFinite(n) && n > 0) cfg.maxLength = n;
	}
	const provider = env.PI_SESSION_NAME_MODEL_PROVIDER;
	const id = env.PI_SESSION_NAME_MODEL_ID;
	if (provider && id) cfg.model = { provider, id };
	return cfg;
}

// ---------------------------------------------------------------------------
// ModelAuth + resolveModelAndAuth
// ---------------------------------------------------------------------------

export type ModelAuth = { model: Model<any>; apiKey: string; headers: Record<string, string> | undefined };

export async function resolveModelAndAuth(
	ctx: ExtensionContext,
	cfg: SessionNameConfig,
	getModelFn?: (provider: string, id: string) => Model<any> | undefined,
): Promise<ModelAuth | null> {
	const find = getModelFn ?? ((p: string, i: string) => ctx.modelRegistry.find(p, i) as Model<any> | undefined);
	const model = cfg.model ? find(cfg.model.provider, cfg.model.id) : ctx.model;
	if (!model) return null;
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth?.ok || !auth.apiKey) return null;
	return { model, apiKey: auth.apiKey, headers: auth.headers };
}

// ---------------------------------------------------------------------------
// generateTitle — call LLM to produce a short title
// ---------------------------------------------------------------------------

export async function generateTitle(
	prompt: string,
	auth: ModelAuth,
	completeFn: typeof complete = complete,
): Promise<string> {
	const response = await completeFn(
		auth.model,
		{
			messages: [
				{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() },
			],
		},
		{ apiKey: auth.apiKey, headers: auth.headers },
	);
	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim();
}

// ---------------------------------------------------------------------------
// Pi extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
	let manuallyLocked = false;
	let inFlight = false;
	let lastAutoName: string | undefined;
	let cfg: SessionNameConfig | null = null;

	pi.on("session_start", () => {
		inFlight = false;
		lastAutoName = undefined;
		cfg = null;
		manuallyLocked = !!pi.getSessionName();
	});

	pi.on("session_info_changed", (event) => {
		if (event.name === lastAutoName) return;
		manuallyLocked = true;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (cfg === null) cfg = loadConfig(ctx.cwd);
		if (!cfg.enabled || manuallyLocked || inFlight) return;

		const currentName = pi.getSessionName();
		if (cfg.mode === "first" && (lastAutoName !== undefined || currentName)) return;

		inFlight = true;
		try {
			const auth = await resolveModelAndAuth(ctx, cfg);
			if (!auth) return;

			const text = buildConversationText(ctx.sessionManager.getBranch());
			if (!text.trim()) return;

			let title: string | null;
			if (cfg.mode === "first" || !currentName) {
				title = cleanTitle(await generateTitle(buildFirstPrompt(text, cfg), auth), cfg.maxLength);
			} else {
				const verdict = await generateTitle(buildAutoPrompt(currentName, text, cfg), auth);
				title = /^keep$/i.test(verdict.trim()) ? null : cleanTitle(verdict, cfg.maxLength);
			}
			if (!title) return;

			lastAutoName = title;
			pi.setSessionName(title);
		} catch {
			// silent: failure does not block the session; first mode retries next round, auto mode skips this round
		} finally {
			inFlight = false;
		}
	});

	pi.registerCommand("rename", {
		description: "Rename this session. Pass a name, or leave empty to auto-generate one from the conversation.",
		handler: async (args, ctx) => {
			// /rename is a manual action: take control and stop background auto-naming
			manuallyLocked = true;
			const cfg = loadConfig(ctx.cwd);
			const name = args.trim();

			if (name) {
				const cleaned = cleanTitle(name, cfg.maxLength);
				if (!cleaned) {
					ctx.ui.notify("Invalid name", "warning");
					return;
				}
				lastAutoName = cleaned;
				pi.setSessionName(cleaned);
				ctx.ui.notify(`Renamed to: ${cleaned}`, "info");
				return;
			}

			// no argument → generate a name from the conversation
			const auth = await resolveModelAndAuth(ctx, cfg);
			if (!auth) {
				ctx.ui.notify("Cannot generate a name: model unavailable or no API key", "warning");
				return;
			}
			const text = buildConversationText(ctx.sessionManager.getBranch());
			if (!text.trim()) {
				ctx.ui.notify("No conversation to generate a name from yet", "warning");
				return;
			}
			try {
				const title = cleanTitle(await generateTitle(buildFirstPrompt(text, cfg), auth), cfg.maxLength);
				if (!title) {
					ctx.ui.notify("Could not generate a name from the model response", "warning");
					return;
				}
				lastAutoName = title;
				pi.setSessionName(title);
				ctx.ui.notify(`Renamed to: ${title}`, "info");
			} catch {
				ctx.ui.notify("Failed to generate a name", "error");
			}
		},
	});
}
