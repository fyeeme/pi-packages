import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildTitleMessages,
	truncateTitleUtf8,
	normalizeSessionTitle,
	fallbackSessionTitle,
	titleSystemPrompt,
	frameTitleMessages,
	buildTitleRequest,
	buildVerdictRequest,
	sessionCreationTime,
	formatCreationPrefix,
	withCreationTime,
	loadConfig,
	resolveClassifierModel,
	classifyKeep,
	generateTitle,
	type SessionEntry,
} from "../src/core.ts";

// ---------------------------------------------------------------------------
// buildTitleMessages — human-only selection with window + budgets
// ---------------------------------------------------------------------------

describe("buildTitleMessages", () => {
	it("extracts only user messages in order", () => {
		const entries = [
			{ type: "message", message: { role: "user", content: "fix the login bug" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "sure" }] } },
			{ type: "message", message: { role: "system", content: "ignored" } },
		];
		expect(buildTitleMessages(entries as SessionEntry[])).toEqual(["fix the login bug"]);
	});

	it("keeps first message and recent tail when exceeding maxMessages", () => {
		const entries = Array.from({ length: 10 }, (_, i) => ({
			type: "message",
			message: { role: i % 2 === 0 ? "user" : "assistant", content: `m${i}` },
		}));
		const out = buildTitleMessages(entries as SessionEntry[], { maxMessages: 4 });
		// first (m0 user) + last 3 users (m4, m6, m8)
		expect(out).toEqual(["m0", "m4", "m6", "m8"]);
	});

	it("returns empty when no user text", () => {
		expect(buildTitleMessages([{ type: "message", message: { role: "system", content: "x" } }] as SessionEntry[])).toEqual([]);
		expect(buildTitleMessages([] as SessionEntry[])).toEqual([]);
	});

	it("long single message is truncated code-point-safely with an ellipsis", () => {
		const long = "x".repeat(700);
		const entries = [{ type: "message", message: { role: "user", content: long } }];
		const out = buildTitleMessages(entries as SessionEntry[], { maxCharsPerMessage: 600 });
		expect(out[0]!.startsWith("x".repeat(600))).toBe(true);
		expect(out[0]!.length).toBeLessThan(700);
	});

	it("extracts only text parts from mixed content array", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "user",
					content: [
						{ type: "text", text: "hello" },
						{ type: "tool_result", name: "bash" },
						{ type: "text", text: "world" },
					],
				},
			},
		];
		expect(buildTitleMessages(entries as SessionEntry[])).toEqual(["hello\nworld"]);
	});

	it("drops messages that normalize to empty (control characters only)", () => {
		const entries = [
			{ type: "message", message: { role: "user", content: "\u0007\u001B[31m" } },
			{ type: "message", message: { role: "user", content: "real" } },
		];
		expect(buildTitleMessages(entries as SessionEntry[])).toEqual(["real"]);
	});

	it("narrows the window from the oldest non-first message when over the byte budget", () => {
		const big = "x".repeat(8192); // 8 KiB each
		const entries = Array.from({ length: 4 }, (_, i) => ({
			type: "message",
			message: { role: "user", content: i === 0 ? "first" : `${i}${big}` },
		}));
		const out = buildTitleMessages(entries as SessionEntry[], { maxInputBytes: 16384, maxCharsPerMessage: 8192 });
		// first survives; only the newest of the big tail fits the budget
		expect(out[0]).toBe("first");
		expect(out.length).toBe(2);
		expect(out[1]!.startsWith("3")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// truncateTitleUtf8 / normalizeSessionTitle / fallbackSessionTitle
// ---------------------------------------------------------------------------

describe("truncateTitleUtf8 (deepseek-harness 1:1)", () => {
	it("returns input within budget unchanged", () => {
		expect(truncateTitleUtf8("hello", 100)).toBe("hello");
	});
	it("truncates by UTF-8 bytes without splitting a code point", () => {
		expect(truncateTitleUtf8("ab\u{1F680}cd", 3)).toBe("ab"); // emoji needs 4 bytes
		expect(truncateTitleUtf8("\u4f60\u597d\u4e16\u754c", 6)).toBe("\u4f60\u597d"); // 3 bytes/CJK char
	});
	it("throws on non-positive budget", () => {
		expect(() => truncateTitleUtf8("x", 0)).toThrow();
	});
});

describe("normalizeSessionTitle — terminal & spoof-safe normalization", () => {
	it("strips ANSI SGR color codes", () => {
		expect(normalizeSessionTitle("\u001B[31mFix login bug\u001B[0m", 200)).toBe("Fix login bug");
	});
	it("strips OSC sequences; an unterminated OSC swallows the tail (conservative drop)", () => {
		expect(normalizeSessionTitle("\u001B]0;window title\u0007Fix login", 200)).toBe("Fix login");
		expect(normalizeSessionTitle("\u001B]8;;http://evilFix login", 200)).toBeNull();
	});
	it("strips C0 control characters", () => {
		expect(normalizeSessionTitle("Fix\u0007log\u0001in", 200)).toBe("Fixlogin");
	});
	it("strips zero-width and bidi directional controls", () => {
		expect(normalizeSessionTitle("Fix\u200Blog", 200)).toBe("Fixlog");
		expect(normalizeSessionTitle("Fix\u202Elogin", 200)).toBe("Fixlogin");
		expect(normalizeSessionTitle("Fix\uFEFFlog", 200)).toBe("Fixlog");
	});
	it("strips wrapping quotes/brackets and trailing punctuation", () => {
		expect(normalizeSessionTitle('"Fix login."', 200)).toBe("Fix login");
		expect(normalizeSessionTitle("\u300C\u4fee\u590d\u767b\u5f55\u3002", 200)).toBe("\u4fee\u590d\u767b\u5f55");
	});
	it("enforces a UTF-8 byte budget (200 bytes ≈ 66 CJK chars)", () => {
		const t = "\u4f60".repeat(100); // 300 bytes
		const out = normalizeSessionTitle(t, 200)!;
		expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(200);
		expect(Array.from(out).length).toBe(66);
	});
	it("returns null when nothing survives", () => {
		expect(normalizeSessionTitle("", 200)).toBeNull();
		expect(normalizeSessionTitle("   ", 200)).toBeNull();
	});
});

describe("fallbackSessionTitle — deterministic first-words fallback", () => {
	it("takes the leading words within the byte budget", () => {
		expect(fallbackSessionTitle("fix the login bug on the order page", 8, 200)).toBe("fix the login bug on the order page");
	});
	it("caps CJK output by bytes (no whitespace to split on)", () => {
		const out = fallbackSessionTitle("\u4fee\u590d\u767b\u5f55\u9875\u7684\u7a7a\u6307\u9488\u9519\u8bef", 8, 9)!;
		expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(9);
	});
	it("returns null for empty input", () => {
		expect(fallbackSessionTitle("   ", 8, 200)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Prompt layer — deepseek-harness texts
// ---------------------------------------------------------------------------

describe("prompt layer", () => {
	it("system prompt carries the deepseek-harness discipline verbatim", () => {
		const s = titleSystemPrompt();
		expect(s).toContain("Create a concise title for an AI coding-assistant session from the supplied human messages.");
		expect(s).toContain("plain text of natural language");
		expect(s).toContain("no quotes, prefix, explanation, Markdown, XML, or terminal control codes");
		expect(s).toContain("No code is allowed");
		expect(s).toContain("Use the language of the messages");
		expect(s).toContain("6 words in non-CJK languages or 18 CJK characters");
	});
	it("frameTitleMessages JSON-frames the payload", () => {
		expect(frameTitleMessages(["a", "b"])).toBe('Generate the session title from this JSON array of human messages:\n["a","b"]');
	});
	it("buildTitleRequest('first') frames only the first message", () => {
		const r = buildTitleRequest("first", ["m1", "m2", "m3"]);
		expect(r.system).toBe(titleSystemPrompt());
		expect(r.user).toContain('["m1"]');
		expect(r.user).not.toContain("m2");
	});
	it("buildTitleRequest('all') frames the whole window", () => {
		const r = buildTitleRequest("all", ["m1", "m2"]);
		expect(r.user).toContain('["m1","m2"]');
	});
	it("buildTitleRequest rejects an empty message list", () => {
		expect(() => buildTitleRequest("first", [])).toThrow("at least one");
	});
	it("concise style is the deepseek-harness wording with a 512-token budget", () => {
		const r = buildTitleRequest("all", ["m1"], "concise");
		expect(r.system).not.toContain("Distinctiveness");
		expect(r.maxOutputTokens).toBe(512);
	});

	it("editorial style adds pi's distinctiveness rules and a 1024-token budget", () => {
		const r = buildTitleRequest("all", ["m1"], "editorial");
		expect(r.system).toContain("plain text of natural language"); // shared discipline
		expect(r.system).toContain("Distinctiveness first");
		expect(r.system).toContain("single most identifying identifier");
		expect(r.system).toContain("15-40 characters in CJK languages, or 5-12 words");
		expect(r.maxOutputTokens).toBe(1024);
	});

	it("editorial verdict request carries the editorial length target", () => {
		const r = buildVerdictRequest("Old", ["m1"], "editorial");
		expect(r.system).toContain("Distinctiveness first");
		expect(r.maxOutputTokens).toBe(1024);
	});

	it("buildVerdictRequest keeps the current title out of the payload and in the system", () => {
		const r = buildVerdictRequest("Old", ["m1"]);
		expect(r.system).toContain("Current title: Old");
		expect(r.system).toContain("KEEP");
		expect(r.user).not.toContain("Old");
	});
});

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

describe("loadConfig", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pisn-cfg-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns defaults when no file and no env", () => {
		const cfg = loadConfig(dir, {});
		expect(cfg).toEqual({ mode: "follow", prompt: "concise", enabled: true, appendCreationTime: true, maxLength: 200 });
	});
	it("reads .pi/agent/session-name.json", () => {
		mkdirSync(join(dir, ".pi", "agent"), { recursive: true });
		writeFileSync(join(dir, ".pi", "agent", "session-name.json"), JSON.stringify({ mode: "auto", maxLength: 20 }));
		const cfg = loadConfig(dir, {});
		expect(cfg.mode).toBe("auto");
		expect(cfg.maxLength).toBe(20);
	});
	it("env overrides file", () => {
		const cfg = loadConfig(dir, { PI_SESSION_NAME_MODE: "auto", PI_SESSION_NAME_MAX_LENGTH: "12" });
		expect(cfg.mode).toBe("auto");
		expect(cfg.maxLength).toBe(12);
	});
	it("env mode accepts follow", () => {
		expect(loadConfig(dir, { PI_SESSION_NAME_MODE: "follow" }).mode).toBe("follow");
	});
	it("illegal env mode value is ignored", () => {
		expect(loadConfig(dir, { PI_SESSION_NAME_MODE: "always" }).mode).toBe("follow");
	});
	it("prompt style defaults to concise and switches via env/file", () => {
		expect(loadConfig(dir, {}).prompt).toBe("concise");
		expect(loadConfig(dir, { PI_SESSION_NAME_PROMPT: "editorial" }).prompt).toBe("editorial");
		expect(loadConfig(dir, { PI_SESSION_NAME_PROMPT: "bogus" }).prompt).toBe("concise");
	});
	it("non-numeric env maxLength is ignored", () => {
		expect(loadConfig(dir, { PI_SESSION_NAME_MAX_LENGTH: "abc" }).maxLength).toBe(200);
	});
	it("PI_SESSION_NAME_ENABLED=false disables", () => {
		expect(loadConfig(dir, { PI_SESSION_NAME_ENABLED: "false" }).enabled).toBe(false);
	});
	it("appendCreationTime defaults true, env TIMESTAMP=false disables", () => {
		expect(loadConfig(dir, {}).appendCreationTime).toBe(true);
		expect(loadConfig(dir, { PI_SESSION_NAME_TIMESTAMP: "false" }).appendCreationTime).toBe(false);
	});
	it("malformed JSON falls back to defaults silently", () => {
		mkdirSync(join(dir, ".pi", "agent"), { recursive: true });
		writeFileSync(join(dir, ".pi", "agent", "session-name.json"), "{ not valid json", "utf8");
		expect(loadConfig(dir, {})).toEqual({ mode: "follow", prompt: "concise", enabled: true, appendCreationTime: true, maxLength: 200 });
	});
});

// ---------------------------------------------------------------------------
// generateTitle
// ---------------------------------------------------------------------------

describe("generateTitle", () => {
	const mkGenCtx = (impl: (model: any, context: any, options: any) => Promise<any>) =>
		({ modelRegistry: { complete: vi.fn(impl) } }) as any;

	it("sends the system/user split with the framed payload and caps output tokens", async () => {
		let seenCtx: any;
		let seenOpts: any;
		const ctx = mkGenCtx(async (_m: any, c: any, o: any) => {
			seenCtx = c;
			seenOpts = o;
			return { stopReason: "stop", content: [{ type: "text", text: "T" }] } as any;
		});
		const out = await generateTitle({ system: "SYS", user: "USR", maxOutputTokens: 512 }, { id: "m" } as any, ctx);
		expect(out).toBe("T");
		expect(seenCtx.messages[0]).toMatchObject({ role: "system" });
		expect(seenCtx.messages[0].content[0].text).toBe("SYS");
		expect(seenCtx.messages[1]).toMatchObject({ role: "user" });
		expect(seenCtx.messages[1].content[0].text).toBe("USR");
		expect(seenOpts.maxTokens).toBe(512);
		expect(seenOpts.signal).toBeInstanceOf(AbortSignal);
	});
	it("composes the caller signal so abort cancels the nested call", async () => {
		let seenOpts: any;
		const ctx = mkGenCtx(async (_m: any, _c: any, o: any) => {
			seenOpts = o;
			return { stopReason: "stop", content: [] } as any;
		});
		const controller = new AbortController();
		controller.abort();
		await generateTitle({ system: "s", user: "u", maxOutputTokens: 512 }, { id: "m" } as any, ctx, controller.signal);
		expect(seenOpts.signal.aborted).toBe(true);
	});
	it("returns empty string on a non-stop finish (failure, not a title)", async () => {
		const ctx = mkGenCtx(async () => ({ stopReason: "length", content: [{ type: "text", text: "trunc" }] }) as any);
		expect(await generateTitle({ system: "s", user: "u", maxOutputTokens: 512 }, { id: "m" } as any, ctx)).toBe("");
	});
	it("joins multiple text parts in order", async () => {
		const ctx = mkGenCtx(async () => ({
			stopReason: "stop",
			content: [
				{ type: "text", text: "a" },
				{ type: "text", text: "b" },
			],
		}) as any);
		expect(await generateTitle({ system: "s", user: "u", maxOutputTokens: 512 }, { id: "m" } as any, ctx)).toBe("a\nb");
	});
});

// ---------------------------------------------------------------------------
// Classifier path
// ---------------------------------------------------------------------------

const KEEP_TRUE = { stopReason: "stop", answers: { keep: { type: "bool", probability: 0.95 } } };
const mkClassifierCtx = (classifyImpl: () => unknown, available: unknown[] = [{ id: "c" }]) =>
	({
		modelRegistry: {
			classify: vi.fn(async () => classifyImpl()),
			getAvailableOfType: vi.fn(async () => available),
		},
	}) as any;

describe("resolveClassifierModel", () => {
	it("returns the first available classifier", async () => {
		expect(await resolveClassifierModel(mkClassifierCtx(() => KEEP_TRUE))).toEqual({ id: "c" });
	});
	it("returns null when none is available", async () => {
		const ctx = mkClassifierCtx(() => KEEP_TRUE, []);
		expect(await resolveClassifierModel(ctx)).toBeNull();
	});
	it("returns null when the host lacks the capability", async () => {
		expect(await resolveClassifierModel({ modelRegistry: {} } as any)).toBeNull();
	});
	it("returns null when discovery throws", async () => {
		const ctx = {
			modelRegistry: {
				getAvailableOfType: async () => {
					throw new Error("auth");
				},
			},
		} as any;
		expect(await resolveClassifierModel(ctx)).toBeNull();
	});
});

describe("classifyKeep", () => {
	it("returns the bool verdict and frames the human messages", async () => {
		let seen: any;
		const ctx = mkClassifierCtx(() => KEEP_TRUE);
		ctx.modelRegistry.classify = vi.fn(async (_m: unknown, c: unknown) => {
			seen = c;
			return KEEP_TRUE;
		});
		const classifier = await resolveClassifierModel(ctx);
		const keep = await classifyKeep(ctx, classifier!, "Old title", ["fix login"]);
		expect(keep).toBe(true);
		expect(seen.state).toEqual({ currentTitle: "Old title" });
		expect(seen.questions.keep.type).toBe("bool");
		expect(seen.questions.keep.instructions).toContain("Old title");
		expect(seen.questions.keep.instructions).toContain('["fix login"]');
	});
	it("returns null on non-stop results and throws (fallback signal)", async () => {
		const errCtx = mkClassifierCtx(() => ({ stopReason: "error", answers: {} }));
		expect(await classifyKeep(errCtx, { id: "jev" } as any, "t", ["m"])).toBeNull();
		const throwCtx = mkClassifierCtx(() => {
			throw new Error("provider 500");
		});
		expect(await classifyKeep(throwCtx, { id: "jev" } as any, "t", ["m"])).toBeNull();
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
		on: (event: string, h: (e: unknown, ctx: unknown) => Promise<void> | void) => {
			handlers[event] = h;
		},
		registerCommand: (n: string, opts: any) => {
			commands[n] = opts;
		},
		getSessionName: () => name,
		setSessionName: (n: string) => {
			name = n;
			setCalls.push(n);
		},
	} as any;
	return { pi, handlers, setCalls, commands, getName: () => name, renameExternally: (n: string) => (name = n) };
};

const mkCtxOrch = (
	branch: Array<{ type: string; message: { role: string; content: string } }>,
	completeImpl?: () => Promise<{ stopReason?: string; content: Array<{ type: string; text: string }> }>,
) => ({
	cwd: "/tmp/nonexistent-cwd-for-pisn",
	model: { id: "m" },
	sessionManager: { getBranch: () => branch, getSessionFile: () => "/x/2026-10-01T10-06-10-085Z_u.jsonl" },
	modelRegistry: {
		complete: completeImpl ?? (async () => ({ stopReason: "stop", content: [{ type: "text", text: "Auto Title" }] })),
	},
	ui: { notify: vi.fn() },
}) as any;

const completeSequence = (...texts: string[]) => {
	let i = 0;
	return async () => ({ stopReason: "stop", content: [{ type: "text", text: texts[i++] ?? "" }] });
};

const branch = (texts: string[]) =>
	texts.map((t, i) => ({ type: "message", message: { role: i % 2 === 0 ? "user" : "assistant", content: t } })) as any;

import { sessionNameExtension as setup } from "../src/core.ts";

const CREATION_PREFIX = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} - /;
const stripPrefix = (s: string): string => s.replace(CREATION_PREFIX, "");

describe("creation-time prefix", () => {
	it("parses the creation stamp from a session file name", () => {
		const d = sessionCreationTime("/x/2026-10-01T10-06-10-085Z_u.jsonl")!;
		expect(d).toBeInstanceOf(Date);
		expect(d.toISOString()).toBe("2026-10-01T10:06:10.000Z"); // ms dropped — minute-level prefix
		expect(sessionCreationTime("nope.jsonl")).toBeNull();
		expect(sessionCreationTime(undefined)).toBeNull();
	});
	it("formats local-timezone yyyy-mm-dd hh:mm", () => {
		expect(formatCreationPrefix(new Date(2026, 9, 1, 9, 5))).toBe("2026-10-01 09:05");
		expect(formatCreationPrefix(new Date(2026, 0, 31, 23, 59))).toBe("2026-01-31 23:59");
	});
	it("prefixes when enabled and the stamp is available; passes through otherwise", () => {
		const f = "/x/2026-10-01T10-06-10-085Z_u.jsonl";
		expect(withCreationTime("t", f, true)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} - t$/);
		expect(withCreationTime("t", f, false)).toBe("t");
		expect(withCreationTime("t", undefined, true)).toBe("t");
		expect(withCreationTime("t", "plain.jsonl", true)).toBe("t");
	});
});

describe("extension orchestration", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("first mode: names once on first agent_settled, not again", async () => {
		vi.stubEnv("PI_SESSION_NAME_MODE", "first");
		const { pi, handlers, setCalls } = mkPi();
		setup(pi);
		handlers.session_start?.({ type: "session_start", reason: "new" }, mkCtxOrch([]));
		const ctx = mkCtxOrch(branch(["help me debug", "ok"]));
		await handlers.agent_settled?.({ type: "agent_settled" }, ctx);
		await handlers.agent_settled?.({ type: "agent_settled" }, ctx);
		expect(setCalls.map(stripPrefix)).toEqual(["Auto Title"]);
		expect(setCalls[0]!).toMatch(CREATION_PREFIX);
	});

	it("does not overwrite an existing name (first mode)", async () => {
		vi.stubEnv("PI_SESSION_NAME_MODE", "first");
		const { pi, handlers, setCalls } = mkPi("Manual");
		setup(pi);
		handlers.session_start?.({ type: "session_start", reason: "new" }, mkCtxOrch([]));
		await handlers.agent_settled?.({ type: "agent_settled" }, mkCtxOrch(branch(["q", "a"])));
		expect(setCalls).toEqual([]);
	});

	it("locks after an external session_info_changed (manual /name)", async () => {
		vi.stubEnv("PI_SESSION_NAME_MODE", "first");
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

	it("default mode is follow (regenerates every turn without any config)", async () => {
		vi.unstubAllEnvs(); // earlier cases stubbed PI_SESSION_NAME_MODE
		const { pi, handlers, setCalls } = mkPi();
		setup(pi);
		handlers.session_start?.({ type: "session_start", reason: "new" }, mkCtxOrch([]));
		const ctx = mkCtxOrch(branch(["q", "a", "more", "done"]), completeSequence("T1", "T2"));
		await handlers.agent_settled?.({ type: "agent_settled" }, ctx);
		await handlers.agent_settled?.({ type: "agent_settled" }, ctx);
		expect(setCalls.map(stripPrefix)).toEqual(["T1", "T2"]);
	});

	it("follow mode: regenerates every settled turn (no KEEP/NEW verdict)", async () => {
		vi.stubEnv("PI_SESSION_NAME_MODE", "follow");
		const { pi, handlers, setCalls } = mkPi();
		setup(pi);
		handlers.session_start?.({ type: "session_start", reason: "new" }, mkCtxOrch([]));
		const ctx = mkCtxOrch(branch(["look at config.ts", "ok", "actually fix the login bug", "done"]), completeSequence("Early Title", "Evolved Title"));
		await handlers.agent_settled?.({ type: "agent_settled" }, ctx);
		await handlers.agent_settled?.({ type: "agent_settled" }, ctx);
		// Turn 2 regenerates instead of KEEPing the early-turn snapshot — the
		// title tracks the conversation (deepseek-harness all-prompts cadence).
		expect(setCalls.map(stripPrefix)).toEqual(["Early Title", "Evolved Title"]);
	});

	it("follow mode: keeps tracking a resumed session's inherited title", async () => {
		vi.stubEnv("PI_SESSION_NAME_MODE", "follow");
		const { pi, handlers, setCalls } = mkPi("Old Inherited");
		setup(pi);
		handlers.session_start?.({ type: "session_start", reason: "resume" }, mkCtxOrch([]));
		await handlers.agent_settled?.({ type: "agent_settled" }, mkCtxOrch(branch(["q", "a"]), completeSequence("Refreshed Title")));
		// The inherited title is treated as the last revision, not a pin.
		expect(setCalls.map(stripPrefix)).toEqual(["Refreshed Title"]);
	});

	it("auto mode: does not touch a resumed session's inherited title (regression)", async () => {
		vi.stubEnv("PI_SESSION_NAME_MODE", "auto");
		const { pi, handlers, setCalls } = mkPi("Old Inherited");
		setup(pi);
		handlers.session_start?.({ type: "session_start", reason: "resume" }, mkCtxOrch([]));
		await handlers.agent_settled?.({ type: "agent_settled" }, mkCtxOrch(branch(["q", "a"])));
		expect(setCalls).toEqual([]);
	});

	it("follow mode: /rename still pins", async () => {
		vi.stubEnv("PI_SESSION_NAME_MODE", "follow");
		const { pi, handlers, setCalls, renameExternally } = mkPi();
		setup(pi);
		handlers.session_start?.({ type: "session_start", reason: "new" }, mkCtxOrch([]));
		const ctx = mkCtxOrch(branch(["q", "a"]), completeSequence("First Title", "Second Title"));
		await handlers.agent_settled?.({ type: "agent_settled" }, ctx);
		renameExternally("User Named");
		handlers.session_info_changed?.({ type: "session_info_changed", name: "User Named" }, ctx);
		await handlers.agent_settled?.({ type: "agent_settled" }, ctx);
		expect(setCalls.map(stripPrefix)).toEqual(["First Title"]);
	});

	it("auto mode: re-evaluates after auto-naming; KEEP keeps current name", async () => {
		vi.stubEnv("PI_SESSION_NAME_MODE", "auto");
		const { pi, handlers, setCalls } = mkPi();
		setup(pi);
		handlers.session_start?.({ type: "session_start", reason: "new" }, mkCtxOrch([]));
		const ctx = mkCtxOrch(branch(["about topic A", "ok"]), completeSequence("Topic A", "KEEP"));
		await handlers.agent_settled?.({ type: "agent_settled" }, ctx);
		await handlers.agent_settled?.({ type: "agent_settled" }, ctx);
		expect(setCalls.map(stripPrefix)).toEqual(["Topic A"]);
	});

	it("auto mode: topic change renames", async () => {
		vi.stubEnv("PI_SESSION_NAME_MODE", "auto");
		const { pi, handlers, setCalls } = mkPi();
		setup(pi);
		handlers.session_start?.({ type: "session_start", reason: "new" }, mkCtxOrch([]));
		const ctx = mkCtxOrch(branch(["topic A", "ok", "now topic B", "ok"]), completeSequence("Topic A", "Topic B Now"));
		await handlers.agent_settled?.({ type: "agent_settled" }, ctx);
		await handlers.agent_settled?.({ type: "agent_settled" }, ctx);
		expect(setCalls.map(stripPrefix)).toEqual(["Topic A", "Topic B Now"]);
	});

	it("auto mode: self-generated session_info_changed does not self-lock", async () => {
		vi.stubEnv("PI_SESSION_NAME_MODE", "auto");
		const { pi, handlers, setCalls } = mkPi();
		setup(pi);
		handlers.session_start?.({ type: "session_start", reason: "new" }, mkCtxOrch([]));
		const ctx = mkCtxOrch(branch(["q", "a"]), completeSequence("T1", "KEEP"));
		await handlers.agent_settled?.({ type: "agent_settled" }, ctx);
		handlers.session_info_changed?.({ type: "session_info_changed", name: "T1" }, ctx);
		await handlers.agent_settled?.({ type: "agent_settled" }, ctx);
		expect(setCalls.map(stripPrefix)).toEqual(["T1"]);
	});

	it("enabled=false skips naming", async () => {
		vi.stubEnv("PI_SESSION_NAME_ENABLED", "false");
		const { pi, handlers, setCalls } = mkPi();
		setup(pi);
		handlers.session_start?.({ type: "session_start", reason: "new" }, mkCtxOrch([]));
		await handlers.agent_settled?.({ type: "agent_settled" }, mkCtxOrch(branch(["q", "a"])));
		expect(setCalls).toEqual([]);
	});

	it("falls back to the deterministic first-words title when the model call fails", async () => {
		vi.unstubAllEnvs();
		vi.stubEnv("PI_SESSION_NAME_MODE", "first");
		const { pi, handlers, setCalls } = mkPi();
		setup(pi);
		handlers.session_start?.({ type: "session_start", reason: "new" }, mkCtxOrch([]));
		const ctx = mkCtxOrch(branch(["fix the login bug please", "a"]), async () => {
			throw new Error("provider down");
		});
		await handlers.agent_settled?.({ type: "agent_settled" }, ctx);
		expect(setCalls.map(stripPrefix)).toEqual(["fix the login bug please"]); // fallback = first 8 words, byte-capped
	});

	it("falls back when the model returns an empty/stopReason-failed response", async () => {
		vi.unstubAllEnvs();
		vi.stubEnv("PI_SESSION_NAME_MODE", "first");
		const { pi, handlers, setCalls } = mkPi();
		setup(pi);
		handlers.session_start?.({ type: "session_start", reason: "new" }, mkCtxOrch([]));
		const ctx = mkCtxOrch(branch(["debug oauth token refresh", "a"]), async () => ({ stopReason: "error", content: [] }));
		await handlers.agent_settled?.({ type: "agent_settled" }, ctx);
		expect(setCalls.map(stripPrefix)).toEqual(["debug oauth token refresh"]);
	});
});

describe("rename command", () => {
	it("/rename <name> sets the cleaned name and locks the background auto-namer", async () => {
		const { pi, handlers, setCalls, commands } = mkPi();
		setup(pi);
		handlers.session_start?.({ type: "session_start", reason: "new" }, mkCtxOrch([]));
		await commands.rename!.handler('  "Fix Login"  ', mkCtxOrch([]));
		expect(setCalls.map(stripPrefix)).toEqual(["Fix Login"]);
		await handlers.agent_settled?.({ type: "agent_settled" }, mkCtxOrch(branch(["q", "a"])));
		expect(setCalls.map(stripPrefix)).toEqual(["Fix Login"]);
	});

	it("/rename with empty arg auto-generates from the conversation", async () => {
		const { pi, handlers, setCalls, commands } = mkPi();
		setup(pi);
		handlers.session_start?.({ type: "session_start", reason: "new" }, mkCtxOrch([]));
		await commands.rename!.handler("", mkCtxOrch(branch(["fix login", "ok"])));
		expect(setCalls.map(stripPrefix)).toEqual(["Auto Title"]);
		expect(setCalls[0]!).toMatch(CREATION_PREFIX);
	});

	it("/rename with empty arg and no conversation notifies and does not rename", async () => {
		const { pi, handlers, setCalls, commands } = mkPi();
		setup(pi);
		handlers.session_start?.({ type: "session_start", reason: "new" }, mkCtxOrch([]));
		const ctx = mkCtxOrch([]);
		await commands.rename!.handler("", ctx);
		expect(setCalls).toEqual([]);
		expect(ctx.ui.notify).toHaveBeenCalled();
	});

	it("/rename with empty arg notifies when the model call fails", async () => {
		const { pi, handlers, setCalls, commands } = mkPi();
		setup(pi);
		handlers.session_start?.({ type: "session_start", reason: "new" }, mkCtxOrch([]));
		const ctx = mkCtxOrch(branch(["fix login", "ok"]), async () => {
			throw new Error("down");
		});
		await commands.rename!.handler("", ctx);
		// deterministic fallback still names it
		expect(setCalls.map(stripPrefix)).toEqual(["fix login"]);
	});
});
