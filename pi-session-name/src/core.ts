import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";

// ---------------------------------------------------------------------------
// Normalize layer — terminal-safe & spoof-safe text normalization with UTF-8
// byte budgets. Adapted 1:1 from deepseek-harness session-title/normalize.ts:
// escape/control stripping before acceptance, code-point-safe truncation, and
// a deterministic first-words fallback. `maxBytes` budgets are UTF-8 bytes.
// ---------------------------------------------------------------------------

/** Operating-system-command escape sequences, including unterminated tails. */
const OSC_SEQUENCE = /(?:\u001B\]|\u009D)(?:(?!\u0007|\u001B\\)[\s\S])*(?:\u0007|\u001B\\|$)/gu;
/** Control-sequence-introducer escapes such as SGR color codes. */
const CSI_SEQUENCE = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu;
/** Remaining two-byte ESC control sequences. */
const ESC_SEQUENCE = /\u001B[@-_]/gu;
/** Non-whitespace C0/C1 control characters. */
const CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;
/** Directional and invisible controls that can make a displayed title deceptive. */
const DIRECTIONAL_CONTROL = /[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/gu;

const utf8Bytes = (s: string): number => Buffer.byteLength(s, "utf8");

/** Remove controls and produce one trimmed, whitespace-normalized line. */
function cleanTitleText(input: string): string {
	return input
		.replace(OSC_SEQUENCE, "")
		.replace(CSI_SEQUENCE, "")
		.replace(ESC_SEQUENCE, "")
		.replace(CONTROL_CHARACTER, "")
		.replace(DIRECTIONAL_CONTROL, "")
		.replace(/\s+/gu, " ")
		.trim();
}

/** Truncate to a UTF-8 byte budget without splitting a Unicode code point.
 *  1:1 from deepseek-harness `truncateTitleUtf8`. */
export function truncateTitleUtf8(input: string, maxBytes: number): string {
	if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new Error("maxBytes must be a positive integer");
	if (utf8Bytes(input) <= maxBytes) return input;
	let used = 0;
	let output = "";
	for (const character of input) {
		const bytes = utf8Bytes(character);
		if (used + bytes > maxBytes) break;
		output += character;
		used += bytes;
	}
	return output;
}

/**
 * Normalize one accepted title and enforce its UTF-8 byte budget.
 * deepseek-harness `normalizeSessionTitle` plus pi's quote/bracket/trailing-
 * punctuation stripping (a strict superset — harmless when the model obeys
 * the prompt, valuable when it does not).
 * @returns the terminal-safe one-line title, or null when nothing survives.
 */
export function normalizeSessionTitle(raw: string, maxBytes: number): string | null {
	if (!raw) return null;
	let t = cleanTitleText(raw);
	t = t.replace(/^["'`\u300C\u300E\uFF08(\[]+|["'`\u300D\u300F\uFF09)\].]+$/g, "").trim();
	t = t.replace(/\s+/g, " ");
	t = t.replace(/[.\u3002!\uFF01?\uFF1F]+$/g, "");
	if (!t) return null;
	t = truncateTitleUtf8(t, maxBytes).trimEnd();
	return t.length > 0 ? t : null;
}

/**
 * Derive the deterministic first-prompt fallback title.
 * 1:1 from deepseek-harness `fallbackSessionTitle`: leading whitespace-
 * delimited words within both limits. Zero LLM involvement.
 */
export function fallbackSessionTitle(input: string, maxWords: number, maxBytes: number): string | null {
	if (!Number.isInteger(maxWords) || maxWords <= 0) throw new Error("maxWords must be a positive integer");
	const words = cleanTitleText(input).split(" ").filter(Boolean).slice(0, maxWords);
	if (words.length === 0) return null;
	const t = truncateTitleUtf8(words.join(" "), maxBytes).trimEnd();
	return t.length > 0 ? t : null;
}

// ---------------------------------------------------------------------------
// Message selection — human messages only (deepseek-harness contract:
// `sessionTitleUserMessageOf` extracts user-sourced text blocks and drops
// messages that normalize to empty). system/tool messages never enter a
// title request.
// ---------------------------------------------------------------------------

export type SessionEntry = { type: string; message?: { role?: string; content?: unknown } };

const extractText = (content: unknown): string[] => {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	const parts: string[] = [];
	for (const part of content) {
		if (part && typeof part === "object") {
			const b = part as { type?: string; text?: string };
			if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
		}
	}
	return parts;
};

/** Code-point-safe per-message truncation with an ellipsis marker. */
const truncate = (s: string, max: number): string => (Array.from(s).length <= max ? s : `${Array.from(s).slice(0, max).join("")}\u2026`);

/** Default input policy: window + per-message cap + total UTF-8 budget. */
export const TITLE_INPUT_DEFAULTS = { maxMessages: 8, maxCharsPerMessage: 600, maxInputBytes: 16384 } as const;

/**
 * Eligible human messages for a title request, in order: first message plus
 * the most recent tail (pi's window; deepseek-harness feeds either the first
 * message or all of them, with a deployment-level byte budget — pi is a
 * terminal extension, so oversize inputs narrow the window from the oldest
 * non-first message instead of failing the request).
 */
export function buildTitleMessages(
	entries: SessionEntry[],
	opts: { maxMessages?: number; maxCharsPerMessage?: number; maxInputBytes?: number } = {},
): string[] {
	const maxMessages = opts.maxMessages ?? TITLE_INPUT_DEFAULTS.maxMessages;
	const maxCharsPerMessage = opts.maxCharsPerMessage ?? TITLE_INPUT_DEFAULTS.maxCharsPerMessage;
	const maxInputBytes = opts.maxInputBytes ?? TITLE_INPUT_DEFAULTS.maxInputBytes;
	const msgs = entries
		.filter((e) => e.type === "message" && e.message?.role === "user")
		.map((e) => truncate(extractText(e.message!.content).join("\n").trim(), maxCharsPerMessage))
		.filter((t) => cleanTitleText(t).length > 0);
	if (msgs.length === 0) return [];
	const selected = msgs.length > maxMessages ? [msgs[0], ...msgs.slice(-(maxMessages - 1))] : msgs;
	// Enforce the framed-input byte budget by dropping the oldest non-first
	// messages (deepseek-harness throws on overflow; a terminal extension
	// narrows instead).
	while (selected.length > 1 && utf8Bytes(frameTitleMessages(selected)) > maxInputBytes) {
		selected.splice(1, 1);
	}
	return selected;
}

// ---------------------------------------------------------------------------
// Prompt layer — 1:1 deepseek-harness session-title-llm texts: a stable
// language-aware system instruction and a JSON-framed user payload, so
// untrusted text cannot forge structural delimiters. Target counts are pi's
// defaults (deepseek-harness leaves them to deployment configuration).
// ---------------------------------------------------------------------------

export const TITLE_TARGET_WORDS = 6;
export const TITLE_TARGET_CJK_CHARACTERS = 18;

/** Prompt style: "concise" = deepseek-harness wording (default); "editorial" =
 *  the same architecture plus pi's distinctiveness/concrete-detail rules.
 *  A/B on 50 local sessions (glm-5.3-flash): concise yields 96% titles at
 *  512 output tokens; editorial rules induce longer chain-of-thought on
 *  reasoning models, so its output budget is raised to 1024 tokens. */
export type PromptStyle = "concise" | "editorial";

export const TITLE_MAX_OUTPUT_TOKENS: Record<PromptStyle, number> = { concise: 512, editorial: 1024 };

/** Stable language-aware system instruction. "concise" is deepseek-harness
 *  wording; "editorial" keeps the same format discipline and adds pi's
 *  distinctiveness rules (higher information density, higher token cost). */
export function titleSystemPrompt(style: PromptStyle = "concise"): string {
	const base = [
		"Create a concise title for an AI coding-assistant session from the supplied human messages.",
		"Return only the title on one line, **in plain text of natural language**, with no quotes, prefix, explanation, Markdown, XML, or terminal control codes. No code is allowed.",
		"Use the language of the messages.",
	];
	if (style === "editorial") {
		return [
			...base,
			'Distinctiveness first: the title must tell this session apart from other sessions in the list. Generic labels ("bug fix", "problem analysis", "code review") could describe any session — never use them as the headline.',
			"Carry the concrete detail: name the specific module, error, symptom, or business object involved, and include the single most identifying identifier (ticket, order, class, or file name) when there is one.",
			"Aim for roughly 15-40 characters in CJK languages, or 5-12 words in other languages.",
		].join("\n");
	}
	return [...base, `Aim for about ${TITLE_TARGET_WORDS} words in non-CJK languages or ${TITLE_TARGET_CJK_CHARACTERS} CJK characters.`].join("\n");
}

/** Frame exact messages as JSON so user text cannot break structural delimiters. */
export function frameTitleMessages(messages: readonly string[]): string {
	return `Generate the session title from this JSON array of human messages:\n${JSON.stringify(messages)}`;
}

/** One model-visible title request: system instruction + JSON-framed payload. */
export interface TitleRequest {
	readonly system: string;
	readonly user: string;
	/** Style-dependent output budget (concise 512 / editorial 1024 tokens). */
	readonly maxOutputTokens: number;
}

/**
 * Build a title request from the eligible human messages.
 * - "first": only the first message (deepseek-harness first-prompt cadence — pi's `first` mode)
 * - "all": every message in the window (deepseek-harness all-prompts cadence — pi's `follow` mode)
 */
export function buildTitleRequest(mode: "first" | "all", messages: readonly string[], style: PromptStyle = "concise"): TitleRequest {
	if (messages.length === 0) throw new Error("title request requires at least one human message");
	const selected = mode === "first" ? [messages[0]!] : messages;
	return { system: titleSystemPrompt(style), user: frameTitleMessages(selected), maxOutputTokens: TITLE_MAX_OUTPUT_TOKENS[style] };
}

/** pi-only: single-verdict KEEP/NEW fallback request for `auto` mode when no
 *  classifier model is available (deepseek-harness has no equivalent). */
export function buildVerdictRequest(currentName: string, messages: readonly string[], style: PromptStyle = "concise"): TitleRequest {
	const system = [
		"You decide whether the session title still matches the conversation.",
		`Current title: ${currentName}`,
		"If the title is still accurate, reply with exactly: KEEP",
		"If it is inaccurate, outdated, or hard to tell apart from other sessions, reply with a NEW title instead:",
		"- The new title is one line of plain text: no quotes, no Markdown, no code, no explanation.",
		"- Use the language of the first human message.",
		...(style === "editorial"
			? [
				'- Distinctiveness first: never use generic labels ("bug fix", "code review") as the headline; carry the concrete module, error, or identifier.',
				"- Aim for roughly 15-40 characters in CJK languages, or 5-12 words in other languages.",
			]
			: [`- Aim for about ${TITLE_TARGET_WORDS} words in non-CJK languages or ${TITLE_TARGET_CJK_CHARACTERS} CJK characters.`]),
	].join("\n");
	return { system, user: frameTitleMessages(messages), maxOutputTokens: TITLE_MAX_OUTPUT_TOKENS[style] };
}

// ---------------------------------------------------------------------------
// Creation-time prefix — pi's session list sorts by last-modified, so an
// edited old session resurfaces at the top and its age becomes invisible.
// Prefixing the creation time (parsed from the session file name) keeps it
// discoverable: "yyyy-mm-dd hh:mm - <title>".
// ---------------------------------------------------------------------------

/** Parse the session's creation timestamp from its file name
 *  (`2026-10-01T10-06-10-085Z_<uuid>.jsonl`). Best effort: null when the name
 *  does not carry a parseable stamp. */
export function sessionCreationTime(sessionFile?: string): Date | null {
	if (!sessionFile) return null;
	const m = basename(sessionFile).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-\d{3}Z_/);
	if (!m) return null;
	const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!));
	return Number.isNaN(d.getTime()) ? null : d;
}

/** Local-timezone "yyyy-mm-dd hh:mm" (24h). */
export function formatCreationPrefix(d: Date): string {
	const p = (n: number): string => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Prefix the creation time: "yyyy-mm-dd hh:mm - title". Best effort: the
 *  title is returned unchanged when the stamp is unavailable or disabled. */
export function withCreationTime(title: string, sessionFile: string | undefined, enabled: boolean): string {
	if (!enabled) return title;
	const d = sessionCreationTime(sessionFile);
	if (!d) return title;
	return `${formatCreationPrefix(d)} - ${title}`;
}

// ---------------------------------------------------------------------------
// SessionNameConfig + loadConfig
// ---------------------------------------------------------------------------

export interface SessionNameConfig {
	mode: "first" | "auto" | "follow";
	/** System-prompt style: "concise" (deepseek-harness wording, default) or
	 *  "editorial" (adds pi's distinctiveness rules; higher output budget). */
	prompt: PromptStyle;
	enabled: boolean;
	/** Prefix the session's creation time onto every set title
	 *  ("yyyy-mm-dd hh:mm - title"), because the resume list sorts by
	 *  last-modified. Default true. */
	appendCreationTime: boolean;
	/** Maximum UTF-8 bytes in an accepted title (byte budget, deepseek-harness
	 *  semantics: 200 bytes ≈ 200 ASCII chars or ~66 CJK characters). */
	maxLength: number;
}

const DEFAULT_CONFIG: SessionNameConfig = { mode: "follow", prompt: "concise", enabled: true, appendCreationTime: true, maxLength: 200 };

export function loadConfig(cwd: string, env: Record<string, string | undefined> = process.env): SessionNameConfig {
	let fileCfg: Partial<SessionNameConfig> = {};
	const file = join(cwd, CONFIG_DIR_NAME, "agent", "session-name.json");
	try {
		fileCfg = JSON.parse(readFileSync(file, "utf8")) as Partial<SessionNameConfig>;
	} catch {
		// missing or malformed config — ignore, fall back to defaults
	}
	const cfg: SessionNameConfig = { ...DEFAULT_CONFIG, ...fileCfg };
	if (env.PI_SESSION_NAME_MODE === "first" || env.PI_SESSION_NAME_MODE === "auto" || env.PI_SESSION_NAME_MODE === "follow") {
		cfg.mode = env.PI_SESSION_NAME_MODE;
	}
	if (env.PI_SESSION_NAME_PROMPT === "concise" || env.PI_SESSION_NAME_PROMPT === "editorial") cfg.prompt = env.PI_SESSION_NAME_PROMPT;
	if (env.PI_SESSION_NAME_ENABLED === "false") cfg.enabled = false;
	if (env.PI_SESSION_NAME_TIMESTAMP === "false") cfg.appendCreationTime = false;
	if (env.PI_SESSION_NAME_MAX_LENGTH) {
		const n = Number(env.PI_SESSION_NAME_MAX_LENGTH);
		if (Number.isFinite(n) && n > 0) cfg.maxLength = n;
	}
	return cfg;
}

// ---------------------------------------------------------------------------
// generateTitle — model call via ctx.modelRegistry (auth resolved at request
// time). deepseek-harness discipline: system/user split, output-token cap,
// end-to-end deadline composed with the caller's signal, and finish-reason
// checking (anything but "stop" is a failure, not a title).
// ---------------------------------------------------------------------------

const TITLE_TIMEOUT_MS = 20_000;

/** Compose optional signals (caller abort + timeout) into one abort signal. */
function composeSignals(signals: Array<AbortSignal | undefined>): AbortSignal {
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	for (const s of signals) {
		if (!s) continue;
		if (s.aborted) {
			controller.abort();
			return controller.signal;
		}
		s.addEventListener("abort", onAbort, { once: true });
	}
	return controller.signal;
}

export async function generateTitle(
	request: TitleRequest,
	model: Model<any>,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<string> {
	const now = Date.now();
	const response = await ctx.modelRegistry.complete(
		model,
		{
			messages: [
				{ role: "system", content: [{ type: "text", text: request.system }], timestamp: now },
				{ role: "user", content: [{ type: "text", text: request.user }], timestamp: now },
			],
		},
		{
			// ctx.signal (undefined while idle) lets Esc/abort cancel the nested
			// call; the deadline keeps a hung provider from blocking the next turn.
			signal: composeSignals([signal, AbortSignal.timeout(TITLE_TIMEOUT_MS)]),
			maxTokens: request.maxOutputTokens,
		},
	);
	if (response.stopReason !== "stop") return "";
	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim();
}

// ---------------------------------------------------------------------------
// Classifier path — auto mode's KEEP/NEW verdict as a bool classify
// ---------------------------------------------------------------------------

type ClassifierLike = Parameters<ExtensionContext["modelRegistry"]["classify"]>[0];

/** First available classifier model, or null when the host has none. */
export async function resolveClassifierModel(ctx: ExtensionContext): Promise<ClassifierLike | null> {
	const registry = ctx.modelRegistry as ExtensionContext["modelRegistry"] & {
		getAvailableOfType?: (type: "classifier", provider?: string) => Promise<readonly unknown[]>;
	};
	if (typeof registry.getAvailableOfType !== "function") return null;
	try {
		const available = await registry.getAvailableOfType("classifier");
		return (available[0] as ClassifierLike | undefined) ?? null;
	} catch {
		return null;
	}
}

/** Auto-mode KEEP/NEW verdict via a bool classifier. Returns null when the
 *  classifier is unusable — the caller falls back to the verdict request. */
export async function classifyKeep(
	ctx: ExtensionContext,
	classifier: ClassifierLike,
	currentName: string,
	messages: readonly string[],
): Promise<boolean | null> {
	try {
		const result = await ctx.modelRegistry.classify(classifier, {
			state: { currentTitle: currentName },
			questions: {
				keep: {
					type: "bool",
					instructions:
						`Decide whether the session title still matches the conversation. Current title: "${currentName}". ` +
						"It is KEEP (true) only if the title still accurately describes the conversation's current main task.\n\n" +
						frameTitleMessages(messages),
					criteria: {
						true: "The title still accurately describes the conversation's current main task",
						false: "The title is inaccurate or outdated for the conversation's current main task",
					},
				},
			},
		});
		if (result.stopReason !== "stop") return null;
		const answer = result.answers.keep;
		if (answer?.type !== "bool") return null;
		return answer.probability >= 0.5;
	} catch {
		return null; // caller falls back to the verdict request
	}
}

// ---------------------------------------------------------------------------
// Pi extension entry point
// ---------------------------------------------------------------------------

export function sessionNameExtension(pi: ExtensionAPI): void {
	let manuallyLocked = false; // user pinned: /rename or an external session_info_changed
	let inheritedTitle = false; // session_start found an existing title (resume)
	let inFlight = false;
	let lastAutoName: string | undefined;
	let cfg: SessionNameConfig | null = null;

	pi.on("session_start", () => {
		inFlight = false;
		lastAutoName = undefined;
		cfg = null;
		manuallyLocked = false;
		inheritedTitle = !!pi.getSessionName();
	});

	pi.on("session_info_changed", (event) => {
		if (event.name === lastAutoName) return;
		manuallyLocked = true;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (cfg === null) cfg = loadConfig(ctx.cwd);
		if (!cfg.enabled || manuallyLocked || inFlight) return;
		// first/auto never touch a resumed session's inherited title (pi's API
		// carries no title source, so any existing name is treated as pinned);
		// follow treats it as the last revision and keeps tracking
		// (deepseek-harness all-prompts cadence). /rename still pins either way.
		if (inheritedTitle && cfg.mode !== "follow") return;
		inheritedTitle = false;

		const currentName = pi.getSessionName();
		if (cfg.mode === "first" && (lastAutoName !== undefined || currentName)) return;

		inFlight = true;
		try {
			// Title generation always uses the current session model; auto mode's
			// KEEP/NEW verdict still prefers a classifier model when present.
			const model = ctx.model ?? null;
			if (!model) return;

			const messages = buildTitleMessages(ctx.sessionManager.getBranch());
			if (messages.length === 0) return;
			const first = messages[0]!;

			// Generated text, then normalize; on ANY failure — provider error, abort,
			// timeout, empty or malformed output — the deterministic first-message
			// fallback (deepseek-harness discipline) still names the session instead
			// of leaving it untitled.
			const attempt = async (request: TitleRequest): Promise<string> => {
				try {
					return await generateTitle(request, model, ctx, ctx.signal);
				} catch {
					return "";
			}
			};
			const finalize = (generated: string): string | null =>
				normalizeSessionTitle(generated, cfg!.maxLength) ?? fallbackSessionTitle(first, 8, cfg!.maxLength);

			let title: string | null;
			if (cfg.mode === "first" || !currentName) {
				title = finalize(await attempt(buildTitleRequest("first", messages, cfg.prompt)));
			} else if (cfg.mode === "follow") {
				title = finalize(await attempt(buildTitleRequest("all", messages, cfg.prompt)));
			} else {
				// auto: classifier KEEP/NEW when available; otherwise the single
				// complete() verdict (KEEP text or a new title).
				const classifier = await resolveClassifierModel(ctx);
				const keep = classifier ? await classifyKeep(ctx, classifier, currentName, messages) : null;
				if (keep === true) {
					return; // title still matches — no generation call
				} else if (keep === false) {
					title = finalize(await attempt(buildTitleRequest("all", messages, cfg.prompt)));
				} else {
					const verdict = await attempt(buildVerdictRequest(currentName, messages, cfg.prompt));
					title = /^keep$/i.test(verdict.trim()) ? null : finalize(verdict);
				}
			}
			if (!title) return;

			// Re-check after async gap: manual rename or external setSessionName
			// may have fired while generateTitle was in flight.
			if (manuallyLocked || pi.getSessionName() !== currentName) return;

			const named = withCreationTime(title, safeSessionFile(ctx), cfg.appendCreationTime);
			lastAutoName = named;
			pi.setSessionName(named);
		} catch {
			// silent: failure does not block the session; the fallback above
			// already covered naming, so simply skip this round
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
				const cleaned = normalizeSessionTitle(name, cfg.maxLength);
				if (!cleaned) {
					ctx.ui.notify("Invalid name", "warning");
					return;
				}
				const named = withCreationTime(cleaned, safeSessionFile(ctx), cfg.appendCreationTime);
				lastAutoName = named;
				pi.setSessionName(named);
				ctx.ui.notify(`Renamed to: ${cleaned}`, "info");
				return;
			}

			// no argument → generate a name from the conversation
			const model = ctx.model ?? null;
			if (!model) {
				ctx.ui.notify("Cannot generate a name: model unavailable", "warning");
				return;
			}
			const messages = buildTitleMessages(ctx.sessionManager.getBranch());
			if (messages.length === 0) {
				ctx.ui.notify("No conversation to generate a name from yet", "warning");
				return;
			}
			const request = buildTitleRequest("first", messages, cfg.prompt);
			let generated = "";
			try {
				generated = await generateTitle(request, model, ctx, ctx.signal);
			} catch {
				// deterministic fallback below still names the session
			}
			const title = normalizeSessionTitle(generated, cfg.maxLength) ?? fallbackSessionTitle(messages[0]!, 8, cfg.maxLength);
			if (!title) {
				ctx.ui.notify("Could not generate a name from the model response", "warning");
				return;
			}
			const named = withCreationTime(title, safeSessionFile(ctx), cfg.appendCreationTime);
			lastAutoName = named;
			pi.setSessionName(named);
			ctx.ui.notify(`Renamed to: ${named}`, "info");
		},
	});
}

/** Best-effort session file path (mock hosts may not implement it). */
function safeSessionFile(ctx: ExtensionContext): string | undefined {
	try {
		return ctx.sessionManager.getSessionFile();
	} catch {
		return undefined;
	}
}
