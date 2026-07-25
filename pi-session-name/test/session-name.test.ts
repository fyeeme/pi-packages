import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@earendil-works/pi-ai/compat", () => ({
	complete: vi.fn(async () => ({ content: [{ type: "text", text: "Auto Title" }] })),
}));

import { buildConversationText, cleanTitle, buildFirstPrompt, buildAutoPrompt, loadConfig, resolveModelAndAuth, generateTitle, type SessionEntry } from "../index.ts";
import setup from "../index.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("buildConversationText", () => {
	it("extracts user/assistant text in order", () => {
		const entries = [
			{ type: "message", message: { role: "user", content: "fix the login bug" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "sure" }] } },
			{ type: "message", message: { role: "system", content: "ignored" } },
		];
		expect(buildConversationText(entries as SessionEntry[])).toBe("User: fix the login bug\n\nAssistant: sure");
	});

	it("keeps first message and recent tail when exceeding maxMessages", () => {
		const entries = Array.from({ length: 10 }, (_, i) => ({
			type: "message",
			message: { role: i % 2 === 0 ? "user" : "assistant", content: `m${i}` },
		}));
		const out = buildConversationText(entries as SessionEntry[], { maxMessages: 4 });
		// first (m0 user) + last 3 (m7,m8,m9)
		expect(out).toContain("User: m0");
		expect(out).toContain("Assistant: m9");
		expect(out.split("\n\n").length).toBe(4);
	});

	it("returns empty string when no user/assistant text", () => {
		expect(buildConversationText([{ type: "message", message: { role: "system", content: "x" } }] as SessionEntry[])).toBe("");
		expect(buildConversationText([] as SessionEntry[])).toBe("");
	});

	// --- supplementary boundary tests ---

	it("long single message is truncated with ellipsis", () => {
		const long = "x".repeat(700);
		const entries = [{ type: "message", message: { role: "user", content: long } }];
		const out = buildConversationText(entries as SessionEntry[], { maxCharsPerMessage: 600 });
		expect(out).toBe(`User: ${"x".repeat(600)}\u2026`);
		expect(out.length).toBeLessThan(700);
	});

	it("extracts only text parts from mixed content array", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "hello" },
						{ type: "tool_use", name: "bash", input: { cmd: "ls" } },
						{ type: "text", text: "world" },
					],
				},
			},
		];
		expect(buildConversationText(entries as SessionEntry[])).toBe("Assistant: hello\nworld");
	});

	it("handles content as plain string", () => {
		const entries = [{ type: "message", message: { role: "user", content: "hello" } }];
		expect(buildConversationText(entries as SessionEntry[])).toBe("User: hello");
	});

	it("only assistant messages produces output", () => {
		const entries = [{ type: "message", message: { role: "assistant", content: "here is help" } }];
		const out = buildConversationText(entries as SessionEntry[]);
		expect(out).toBe("Assistant: here is help");
	});
});

describe("cleanTitle", () => {
	it("trims quotes, whitespace, trailing punctuation", () => {
		expect(cleanTitle('"  Fix login bug.  "')).toBe("Fix login bug");
		expect(cleanTitle("「修复登录」")).toBe("修复登录");
	});
	it("collapses internal newlines into spaces", () => {
		expect(cleanTitle("line one\nline two")).toBe("line one line two");
	});
	it("truncates to maxLength", () => {
		expect(cleanTitle("abcdefghijklmnopqrstuvwxyz", 10)).toBe("abcdefghij");
	});
	it("returns null for empty / whitespace-only", () => {
		expect(cleanTitle("   ")).toBeNull();
		expect(cleanTitle('""')).toBeNull();
	});

	// --- supplementary boundary tests ---
	it("strips code-fence backticks", () => {
		expect(cleanTitle("```Fix login bug```")).toBe("Fix login bug");
	});
	it("strips mixed wrapping quotes", () => {
		expect(cleanTitle('「"修复登录"」')).toBe("修复登录");
	});
	it("respects maxLength for Chinese text", () => {
		const chinese45 = "一二三四五六七八九十" .repeat(4).trim() + "一二三四五"; // 45 chars
		const result = cleanTitle(chinese45, 40);
		expect(result).not.toBeNull();
		expect(result!.length).toBe(40);
	});
	it("returns null for pure punctuation", () => {
		expect(cleanTitle("。。。！？")).toBeNull();
	});
});

describe("prompts", () => {
	const conv = "User: hi";

	it("buildFirstPrompt instructs same-language, length cap, no quotes", () => {
		const p = buildFirstPrompt(conv, { maxLength: 200 });
		expect(p).toContain("SAME language");
		expect(p).toContain("200 characters");
		expect(p).toContain("<conversation>");
		expect(p.endsWith("</conversation>")).toBe(true);
	});

	it("buildAutoPrompt includes current name and KEEP rule", () => {
		const p = buildAutoPrompt("Old title", conv, { maxLength: 200 });
		expect(p).toContain("Current title: Old title");
		expect(p).toContain("KEEP");
		expect(p).toContain("200 characters");
	});

	it("buildFirstPrompt passes maxLength", () => {
		const p = buildFirstPrompt(conv, { maxLength: 25 });
		expect(p).toContain("25 characters");
		expect(p).not.toContain("200 characters");
	});

	it("buildAutoPrompt passes maxLength", () => {
		const p = buildAutoPrompt("Old title", conv, { maxLength: 12 });
		expect(p).toContain("12 characters");
		expect(p).not.toContain("200 characters");
	});

	it("buildAutoPrompt embeds currentName verbatim (newlines, etc.)", () => {
		const p = buildAutoPrompt("line1\nline2", conv, {});
		expect(p).toContain("Current title: line1\nline2");
	});

	it("buildFirstPrompt favors descriptive over terse titles", () => {
		const p = buildFirstPrompt(conv, { maxLength: 200 });
		expect(p).toContain("descriptive");
		expect(p).toContain("15-40 characters");
		expect(p).not.toMatch(/\bshort\b/);
		expect(p).not.toContain("concise");
	});

	it("buildAutoPrompt favors descriptive over terse titles", () => {
		const p = buildAutoPrompt("Old", conv, { maxLength: 200 });
		expect(p).toContain("descriptive");
		expect(p).toContain("15-40 characters");
		expect(p).not.toMatch(/\bshort\b/);
		expect(p).not.toContain("concise");
	});
});

describe("loadConfig", () => {
	let dir: string;
	beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "pisn-")); });
	afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

	it("returns defaults when no file and no env", () => {
		const cfg = loadConfig(dir, {});
		expect(cfg).toEqual({ mode: "first", enabled: true, maxLength: 200 });
	});
	it("reads .pi/session-name.json", () => {
		mkdirSync(join(dir, ".pi"), { recursive: true });
		writeFileSync(join(dir, ".pi", "session-name.json"), JSON.stringify({ mode: "auto", maxLength: 20 }));
		const cfg = loadConfig(dir, {});
		expect(cfg.mode).toBe("auto");
		expect(cfg.maxLength).toBe(20);
	});
	it("env overrides file", () => {
		const cfg = loadConfig(dir, { PI_SESSION_NAME_MODE: "auto", PI_SESSION_NAME_MAX_LENGTH: "12" });
		expect(cfg.mode).toBe("auto");
		expect(cfg.maxLength).toBe(12);
	});
	it("PI_SESSION_NAME_ENABLED=false disables", () => {
		expect(loadConfig(dir, { PI_SESSION_NAME_ENABLED: "false" }).enabled).toBe(false);
	});

	// --- supplementary error-path tests ---

	it("malformed JSON falls back to defaults silently", () => {
		mkdirSync(join(dir, ".pi"), { recursive: true });
		writeFileSync(join(dir, ".pi", "session-name.json"), "{ not valid json", "utf8");
		const cfg = loadConfig(dir, {});
		expect(cfg).toEqual({ mode: "first", enabled: true, maxLength: 200 });
	});
	it("illegal env mode value is ignored", () => {
		const cfg = loadConfig(dir, { PI_SESSION_NAME_MODE: "always" });
		expect(cfg.mode).toBe("first");
	});
	it("non-numeric env maxLength is ignored", () => {
		const cfg = loadConfig(dir, { PI_SESSION_NAME_MAX_LENGTH: "abc" });
		expect(cfg.maxLength).toBe(200);
	});
	it("partial model env (provider without id) does not set model", () => {
		const cfg = loadConfig(dir, { PI_SESSION_NAME_MODEL_PROVIDER: "openai" });
		expect(cfg.model).toBeUndefined();
	});
});

describe("generateTitle", () => {
	it("joins text parts of the response", async () => {
		const auth = { model: { id: "m" }, apiKey: "k", headers: undefined } as any;
		const fakeComplete = async () => ({ content: [{ type: "text", text: "Fix login" }, { type: "text", text: "bug" }] } as any);
		expect(await generateTitle("prompt", auth, fakeComplete as any)).toBe("Fix login\nbug");
	});

	it("returns empty string when no text parts", async () => {
		const auth = { model: { id: "m" }, apiKey: "k", headers: undefined } as any;
		const fakeComplete = async () => ({ content: [{ type: "tool_call" }] } as any);
		expect(await generateTitle("prompt", auth, fakeComplete as any)).toBe("");
	});

	it("returns empty string when content array is empty", async () => {
		const auth = { model: { id: "m" }, apiKey: "k", headers: undefined } as any;
		const fakeComplete = async () => ({ content: [] } as any);
		expect(await generateTitle("prompt", auth, fakeComplete as any)).toBe("");
	});

	it("joins multiple text parts in order", async () => {
		const auth = { model: { id: "m" }, apiKey: "k", headers: undefined } as any;
		const fakeComplete = async () => ({
			content: [
				{ type: "text", text: "a" },
				{ type: "text", text: "b" },
				{ type: "text", text: "c" },
			],
		} as any);
		expect(await generateTitle("prompt", auth, fakeComplete as any)).toBe("a\nb\nc");
	});
});

const mkCtx = (overrides: any = {}) => ({
	model: { id: "current-model" },
	modelRegistry: { getApiKeyAndHeaders: () => ({ ok: true, apiKey: "k", headers: { h: "1" } }) },
	...overrides,
});

describe("resolveModelAndAuth", () => {
	it("uses ctx.model by default and resolves auth", async () => {
		const r = await resolveModelAndAuth(mkCtx() as any, { mode: "first", enabled: true, maxLength: 200 });
		expect(r).toEqual({ model: { id: "current-model" }, apiKey: "k", headers: { h: "1" } });
	});
	it("uses config.model via getModelFn when provided", async () => {
		const fakeGetModel = (_p: string, _i: string) => ({ id: "configured" } as any);
		const r = await resolveModelAndAuth(mkCtx() as any, { mode: "first", enabled: true, maxLength: 200, model: { provider: "openai", id: "gpt-4o-mini" } }, fakeGetModel as any);
		expect(r?.model.id).toBe("configured");
	});
	it("returns null when auth fails", async () => {
		const r = await resolveModelAndAuth(mkCtx({ modelRegistry: { getApiKeyAndHeaders: () => ({ ok: false, error: "no key" }) } }) as any, { mode: "first", enabled: true, maxLength: 200 });
		expect(r).toBeNull();
	});
	it("returns null when no model at all", async () => {
		const r = await resolveModelAndAuth(mkCtx({ model: undefined }) as any, { mode: "first", enabled: true, maxLength: 200 });
		expect(r).toBeNull();
	});
	it("returns null when configured model but getModelFn returns undefined", async () => {
		const r = await resolveModelAndAuth(
			mkCtx({ model: undefined }) as any,
			{ mode: "first", enabled: true, maxLength: 200, model: { provider: "x", id: "y" } },
			() => undefined,
		);
		expect(r).toBeNull();
	});
	it("returns null when ctx.model present but auth fails", async () => {
		const r = await resolveModelAndAuth(mkCtx({ modelRegistry: { getApiKeyAndHeaders: () => ({ ok: false, error: "no key" }) } }) as any, { mode: "first", enabled: true, maxLength: 200 });
		expect(r).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Orchestration tests
// ---------------------------------------------------------------------------

type Handlers = Record<string, (e: unknown, ctx: unknown) => Promise<void> | void>;

const mkPi = (initialName?: string) => {
	let name = initialName;
	const setCalls: string[] = [];
	const handlers: Handlers = {};
	const commands: Record<string, { description?: string; handler: (args: string, ctx: any) => Promise<void> }> = {};
	const pi = {
		on: (event: string, h: (e: unknown, ctx: unknown) => Promise<void> | void) => { handlers[event] = h; },
		registerCommand: (n: string, opts: any) => { commands[n] = opts; },
		getSessionName: () => name,
		setSessionName: (n: string) => { name = n; setCalls.push(n); },
	} as any;
	return { pi, handlers, setCalls, commands, getName: () => name, renameExternally: (n: string) => { name = n; } };
};

const mkCtxOrch = (branch: Array<{ type: string; message: { role: string; content: string } }>) => ({
	cwd: "/tmp/nonexistent-cwd-for-pisn",
	model: { id: "m" },
	sessionManager: { getBranch: () => branch },
	modelRegistry: { getApiKeyAndHeaders: () => ({ ok: true, apiKey: "k", headers: undefined }) },
	ui: { notify: vi.fn() },
}) as any;

const branch = (texts: string[]) =>
	texts.map((t, i) => ({ type: "message", message: { role: i % 2 === 0 ? "user" : "assistant", content: t } })) as any;

describe("extension orchestration", () => {
	beforeEach(() => { vi.clearAllMocks(); });

	it("first mode: names once on first agent_settled, not again", async () => {
		const { pi, handlers, setCalls } = mkPi();
		setup(pi);
		handlers.session_start?.({ type: "session_start", reason: "new" }, mkCtxOrch([]));
		const ctx = mkCtxOrch(branch(["help me debug", "ok"]));
		await handlers.agent_settled?.({ type: "agent_settled" }, ctx);
		await handlers.agent_settled?.({ type: "agent_settled" }, ctx);
		expect(setCalls).toEqual(["Auto Title"]);
	});

	it("does not overwrite an existing name (first mode)", async () => {
		const { pi, handlers, setCalls } = mkPi("Manual");
		setup(pi);
		handlers.session_start?.({ type: "session_start", reason: "new" }, mkCtxOrch([]));
		await handlers.agent_settled?.({ type: "agent_settled" }, mkCtxOrch(branch(["q", "a"])));
		expect(setCalls).toEqual([]);
	});

	it("locks after an external session_info_changed (manual /name)", async () => {
		const { pi, handlers, setCalls, renameExternally } = mkPi();
		setup(pi);
		handlers.session_start?.({ type: "session_start", reason: "new" }, mkCtxOrch([]));
		const ctx = mkCtxOrch(branch(["q", "a"]));
		await handlers.agent_settled?.({ type: "agent_settled" }, ctx);
		expect(setCalls.length).toBe(1);
		renameExternally("User Renamed");
		handlers.session_info_changed?.({ type: "session_info_changed", name: "User Renamed" }, ctx);
		await handlers.agent_settled?.({ type: "agent_settled" }, ctx);
		expect(setCalls.length).toBe(1);
	});

	it("auto mode: re-evaluates after auto-naming; KEEP keeps current name", async () => {
		vi.stubEnv("PI_SESSION_NAME_MODE", "auto");
		const { complete } = await import("@earendil-works/pi-ai/compat");
		vi.mocked(complete).mockResolvedValueOnce({ content: [{ type: "text", text: "Topic A" }] } as any);
		vi.mocked(complete).mockResolvedValueOnce({ content: [{ type: "text", text: "KEEP" }] } as any);
		const { pi, handlers, setCalls } = mkPi();
		setup(pi);
		handlers.session_start?.({ type: "session_start", reason: "new" }, mkCtxOrch([]));
		const ctx = mkCtxOrch(branch(["about topic A", "ok"]));
		await handlers.agent_settled?.({ type: "agent_settled" }, ctx);
		await handlers.agent_settled?.({ type: "agent_settled" }, ctx);
		expect(setCalls).toEqual(["Topic A"]);
		vi.unstubAllEnvs();
	});

	it("enabled=false skips naming", async () => {
		vi.stubEnv("PI_SESSION_NAME_ENABLED", "false");
		const { pi, handlers, setCalls } = mkPi();
		setup(pi);
		handlers.session_start?.({ type: "session_start", reason: "new" }, mkCtxOrch([]));
		await handlers.agent_settled?.({ type: "agent_settled" }, mkCtxOrch(branch(["q", "a"])));
		expect(setCalls).toEqual([]);
		vi.unstubAllEnvs();
	});

	it("auto mode: topic change renames", async () => {
		vi.stubEnv("PI_SESSION_NAME_MODE", "auto");
		const { complete } = await import("@earendil-works/pi-ai/compat");
		vi.mocked(complete).mockResolvedValueOnce({ content: [{ type: "text", text: "Topic A" }] } as any);
		vi.mocked(complete).mockResolvedValueOnce({ content: [{ type: "text", text: "Topic B" }] } as any);
		const { pi, handlers, setCalls } = mkPi();
		setup(pi);
		handlers.session_start?.({ type: "session_start", reason: "new" }, mkCtxOrch([]));
		const ctx = mkCtxOrch(branch(["about topic", "ok"]));
		await handlers.agent_settled?.({ type: "agent_settled" }, ctx);
		await handlers.agent_settled?.({ type: "agent_settled" }, ctx);
		expect(setCalls).toEqual(["Topic A", "Topic B"]);
		vi.unstubAllEnvs();
	});

	it("auto mode: self-generated session_info_changed does not self-lock", async () => {
		vi.stubEnv("PI_SESSION_NAME_MODE", "auto");
		const { complete } = await import("@earendil-works/pi-ai/compat");
		vi.mocked(complete).mockResolvedValueOnce({ content: [{ type: "text", text: "Topic A" }] } as any);
		vi.mocked(complete).mockResolvedValueOnce({ content: [{ type: "text", text: "Topic B" }] } as any);
		const { pi, handlers, setCalls } = mkPi();
		setup(pi);
		handlers.session_start?.({ type: "session_start", reason: "new" }, mkCtxOrch([]));
		const ctx = mkCtxOrch(branch(["about A", "ok"]));
		await handlers.agent_settled?.({ type: "agent_settled" }, ctx);
		// 扩展自动命名会触发 session_info_changed（同名）；不得自锁，否则 auto 模式只能命名一次
		handlers.session_info_changed?.({ type: "session_info_changed", name: "Topic A" }, ctx);
		await handlers.agent_settled?.({ type: "agent_settled" }, ctx);
		expect(setCalls).toEqual(["Topic A", "Topic B"]);
		vi.unstubAllEnvs();
	});
});

// ---------------------------------------------------------------------------
// /rename command
// ---------------------------------------------------------------------------

describe("rename command", () => {
	beforeEach(() => { vi.clearAllMocks(); });

	it("/rename <name> sets the cleaned name and locks the background auto-namer", async () => {
		const { pi, handlers, setCalls, commands } = mkPi();
		setup(pi);
		handlers.session_start?.({ type: "session_start", reason: "new" }, mkCtxOrch([]));
		const ctx = mkCtxOrch(branch(["q", "a"]));
		await commands.rename.handler("  My Cool Session.  ", ctx);
		expect(setCalls).toEqual(["My Cool Session"]);
		// manuallyLocked → background agent_settled must not overwrite
		await handlers.agent_settled?.({ type: "agent_settled" }, ctx);
		expect(setCalls).toEqual(["My Cool Session"]);
	});

	it("/rename with empty arg auto-generates from the conversation", async () => {
		const { pi, handlers, setCalls, commands } = mkPi();
		setup(pi);
		handlers.session_start?.({ type: "session_start", reason: "new" }, mkCtxOrch([]));
		await commands.rename.handler("", mkCtxOrch(branch(["help me debug", "ok"])));
		// default mocked complete returns "Auto Title"
		expect(setCalls).toEqual(["Auto Title"]);
	});

	it("/rename with empty arg and no conversation notifies and does not rename", async () => {
		const { pi, setCalls, commands } = mkPi();
		setup(pi);
		const ctx = mkCtxOrch([]);
		await commands.rename.handler("", ctx);
		expect(setCalls).toEqual([]);
		expect(ctx.ui.notify).toHaveBeenCalledWith("No conversation to generate a name from yet", "warning");
	});

	it("/rename with empty arg notifies on auth failure", async () => {
		const { pi, setCalls, commands } = mkPi();
		setup(pi);
		const ctx = mkCtxOrch(branch(["q", "a"]));
		ctx.modelRegistry.getApiKeyAndHeaders = () => ({ ok: false, error: "no key" });
		await commands.rename.handler("", ctx);
		expect(setCalls).toEqual([]);
		expect(ctx.ui.notify).toHaveBeenCalledWith("Cannot generate a name: model unavailable or no API key", "warning");
	});

	it("/rename with invalid (punctuation-only) name notifies and does not rename", async () => {
		const { pi, setCalls, commands } = mkPi();
		setup(pi);
		const ctx = mkCtxOrch(branch(["q", "a"]));
		await commands.rename.handler("...", ctx);
		expect(setCalls).toEqual([]);
		expect(ctx.ui.notify).toHaveBeenCalledWith("Invalid name", "warning");
	});
});
