import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildTitleMessages,
	buildTitleRequest,
	buildVerdictRequest,
	classifyKeep,
	loadConfig,
	normalizeSessionTitle,
	sessionNameExtension,
	type SessionEntry,
} from "../src/core.ts";

// Never consult the user's real personal config, even through extension handlers.
const paths = vi.hoisted(() => ({ agentDir: "" }));
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
	...await importOriginal<typeof import("@earendil-works/pi-coding-agent")>(),
	getAgentDir: () => paths.agentDir,
}));
let cwd: string;
beforeEach(() => {
	for (const name of [
		"PI_SESSION_NAME_MODE", "PI_SESSION_NAME_PROMPT", "PI_SESSION_NAME_ENABLED",
		"PI_SESSION_NAME_TIMESTAMP", "PI_SESSION_NAME_MAX_LENGTH", "PI_SESSION_NAME_MAX_WORDS",
		"PI_SESSION_NAME_INCLUDE_ASSISTANT_CONTEXT",
	]) vi.stubEnv(name, undefined);
	paths.agentDir = mkdtempSync(join(tmpdir(), "pisn-options-"));
	cwd = join(paths.agentDir, "project");
	mkdirSync(join(cwd, ".pi", "agent"), { recursive: true });
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(paths.agentDir, { recursive: true, force: true });
});
const personal = (value: unknown): void => writeFileSync(join(paths.agentDir, "session-name.json"), JSON.stringify(value));
const project = (value: unknown): void => writeFileSync(join(cwd, ".pi", "agent", "session-name.json"), JSON.stringify(value));
const user = (text: string): SessionEntry => ({ type: "message", message: { role: "user", content: text } });
const assistant = (text: string): SessionEntry => ({ type: "message", message: { role: "assistant", content: text } });
const response = (text = "Generated Title") => ({ stopReason: "stop", content: [{ type: "text", text }] });
const deferred = () => {
	let resolve!: (value: ReturnType<typeof response>) => void;
	const promise = new Promise<ReturnType<typeof response>>((done) => { resolve = done; });
	return { promise, resolve };
};

function harness(initialName?: string, entries: SessionEntry[] = [user("help me"), assistant("Fixed token refresh expiry")]) {
	let name = initialName;
	let sessionFile: string | undefined;
	const handlers: Record<string, (event: any, ctx: any) => any> = {};
	const commands: Record<string, { handler: (args: string, ctx: any) => Promise<void> }> = {};
	const pi = {
		on: (event: string, handler: (event: any, ctx: any) => any) => { handlers[event] = handler; },
		registerCommand: (command: string, options: any) => { commands[command] = options; },
		getSessionName: () => name,
		setSessionName: vi.fn((title: string) => { name = title; }),
	};
	const complete = vi.fn(async (_model: any, _context: any, _options: any) => response());
	const ctx = {
		cwd,
		model: { id: "selected-model" },
		modelRegistry: { complete },
		sessionManager: { getBranch: () => entries, getSessionFile: () => sessionFile },
		ui: { notify: vi.fn() },
	};
	sessionNameExtension(pi as any);
	const fire = (event: string, payload: any = {}) => handlers[event]!(payload, ctx);
	const rename = (args = "") => commands.rename!.handler(args, ctx);
	const input = (call = 0) => complete.mock.calls[call]![1];
	fire("session_start");
	return {
		pi, ctx, complete, fire, rename, input,
		name: () => name,
		externalRename: (title: string | undefined) => { name = title; },
		switchFile: (file: string) => { sessionFile = file; },
	};
}
const payload = (context: any): any => JSON.parse(context.messages[0].content[0].text.split("\n").slice(1).join("\n"));

describe("portable config layering", () => {
	it("defaults to no word cap and human-only input", () => {
		const cfg = loadConfig(cwd, {}, paths.agentDir);
		expect(cfg.maxWords).toBeUndefined();
		expect(cfg.includeAssistantContext).toBe(false);
	});

	it("reads personal then project then environment, retaining unoverridden settings", () => {
		personal({ mode: "auto", prompt: "editorial", maxWords: 7, includeAssistantContext: true, enabled: false, appendCreationTime: false });
		project({ mode: "first", maxWords: 5, includeAssistantContext: false });
		expect(loadConfig(cwd, {}, paths.agentDir)).toMatchObject({
			mode: "first", prompt: "editorial", maxWords: 5, includeAssistantContext: false, enabled: false, appendCreationTime: false,
		});
		expect(loadConfig(cwd, {
			PI_SESSION_NAME_MODE: "follow",
			PI_SESSION_NAME_MAX_WORDS: "3",
			PI_SESSION_NAME_INCLUDE_ASSISTANT_CONTEXT: "true",
			PI_SESSION_NAME_ENABLED: "true",
			PI_SESSION_NAME_TIMESTAMP: "true",
		}, paths.agentDir)).toMatchObject({ mode: "follow", maxWords: 3, includeAssistantContext: true, enabled: true, appendCreationTime: true });
	});

	it("uses the optional isolated agentDir instead of getAgentDir", () => {
		personal({ maxWords: 99 });
		const other = join(paths.agentDir, "other");
		mkdirSync(other);
		writeFileSync(join(other, "session-name.json"), JSON.stringify({ maxWords: 4 }));
		expect(loadConfig(cwd, {}, other).maxWords).toBe(4);
	});

	it.each([null, [], [{ maxWords: 1 }], "not options", 5])("ignores invalid config root %j", (value) => {
		personal({ maxWords: 4, includeAssistantContext: true });
		project(value);
		expect(loadConfig(cwd, {}, paths.agentDir)).toMatchObject({ maxWords: 4, includeAssistantContext: true });
	});

	it.each([null, [], {}, "3", true, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("ignores invalid config word count %j", (value) => {
		personal({ maxWords: 4 });
		project({ maxWords: value });
		expect(loadConfig(cwd, {}, paths.agentDir).maxWords).toBe(4);
	});

	it.each(["", " ", "abc", "true", "0", "-3", "1.5", "Infinity", "9007199254740992"])("ignores invalid environment word count %j", (value) => {
		project({ maxWords: 4 });
		expect(loadConfig(cwd, { PI_SESSION_NAME_MAX_WORDS: value }, paths.agentDir).maxWords).toBe(4);
	});

	it.each([null, [], {}, "true", 1])("ignores non-boolean assistant option %j", (value) => {
		personal({ includeAssistantContext: true });
		project({ includeAssistantContext: value });
		expect(loadConfig(cwd, { PI_SESSION_NAME_INCLUDE_ASSISTANT_CONTEXT: "yes" }, paths.agentDir).includeAssistantContext).toBe(true);
		expect(loadConfig(cwd, { PI_SESSION_NAME_INCLUDE_ASSISTANT_CONTEXT: "false" }, paths.agentDir).includeAssistantContext).toBe(false);
	});

	it("ignores invalid existing options rather than spreading arbitrary JSON", () => {
		project({ mode: [], prompt: null, enabled: "false", appendCreationTime: 0, maxLength: 1.5, unexpected: "x" });
		expect(loadConfig(cwd, {}, paths.agentDir)).toEqual({ mode: "follow", prompt: "concise", enabled: true, appendCreationTime: true, maxLength: 200, includeAssistantContext: false });
	});

	it("accepts the largest positive safe integer and ignores malformed personal JSON", () => {
		writeFileSync(join(paths.agentDir, "session-name.json"), "{broken");
		project({ maxWords: Number.MAX_SAFE_INTEGER });
		expect(loadConfig(cwd, {}, paths.agentDir).maxWords).toBe(Number.MAX_SAFE_INTEGER);
	});
});

describe("generated-title word limits", () => {
	it.each(["concise", "editorial"] as const)("overrides %s title and KEEP/NEW targets only when configured", (style) => {
		for (const request of [buildTitleRequest("all", ["task"], style, 3), buildVerdictRequest("Old", ["task"], style, 3)]) {
			expect(request.system).toContain("at most 3 whitespace-delimited words");
			expect(request.system).toContain("concrete main task");
			expect(request.system).not.toContain("5-12 words");
			expect(request.system).not.toContain("6 words in non-CJK");
		}
		expect(buildTitleRequest("all", ["task"], style).system).toContain(style === "concise" ? "6 words in non-CJK" : "5-12 words");
	});

	it("counts after sanitizing and rejects before byte truncation instead of cutting to three words", () => {
		expect(normalizeSessionTitle('"\u001b[31mFix\u001b[0m\t token\nexpiry."', 200, 3)).toBe("Fix token expiry");
		expect(normalizeSessionTitle("Fix token expiry !", 200, 3)).toBe("Fix token expiry");
		expect(normalizeSessionTitle("One two three four", 7, 3)).toBeNull();
		expect(normalizeSessionTitle("One two three four", 200)).toBe("One two three four");
		expect(normalizeSessionTitle("修复令牌过期", 200, 1)).toBe("修复令牌过期");
	});

	it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid public word cap %j", (value) => {
		expect(() => normalizeSessionTitle("Title", 200, value)).toThrow("positive safe integer");
		expect(() => buildTitleRequest("all", ["task"], "concise", value)).toThrow("positive safe integer");
	});

	it("caps initial fallback at configured maxWords, not eight", async () => {
		project({ maxWords: 3 });
		const h = harness(undefined, [user("fix the login bug with expired tokens")]);
		h.complete.mockResolvedValue(response("A title with too many words"));
		await h.fire("agent_settled");
		expect(h.name()).toBe("fix the login");
	});

	it("explicit rename bypasses maxWords but still sanitizes and byte-caps", async () => {
		project({ maxWords: 1, maxLength: 15 });
		const h = harness();
		await h.rename('"Fix the login bug"');
		expect(h.name()).toBe("Fix the login b");
		expect(h.complete).not.toHaveBeenCalled();
	});

	it.each(["follow", "auto"])("%s preserves a previous auto title on overlong output", async (mode) => {
		project({ mode, maxWords: 3 });
		const h = harness();
		h.complete.mockResolvedValueOnce(response("Token expiry fix")).mockResolvedValueOnce(response("This title is much too long"));
		await h.fire("agent_settled");
		await h.fire("agent_settled");
		expect(h.name()).toBe("Token expiry fix");
		expect(h.pi.setSessionName).toHaveBeenCalledTimes(1);
		expect(h.input(1).systemPrompt).toContain("at most 3 whitespace-delimited words");
	});
});

describe("bounded opt-in conversation context", () => {
	it.each([false, true])("initial first-mode generation includes assistant text only when enabled=%s", async (enabled) => {
		project({ mode: "first", includeAssistantContext: enabled });
		const h = harness(undefined, [user("can you help"), assistant("Resolved token refresh race"), user("add regression coverage"), assistant("Added expiry tests")]);
		await h.fire("agent_settled");
		const input = h.input();
		expect(input.messages).toHaveLength(1);
		expect(input.messages[0].role).toBe("user");
		expect(input.messages[0].content[0].text.includes("Resolved token refresh race")).toBe(enabled);
		expect(input.systemPrompt).toContain("Human messages are authoritative");
		expect(h.complete.mock.calls[0]![0]).toBe(h.ctx.model);
		expect(h.ctx.model).toEqual({ id: "selected-model" });
		expect(Object.keys(h.complete.mock.calls[0]![2]).sort()).toEqual(["maxTokens", "signal"]);
		if (enabled) expect(payload(input).messages.map((turn: any) => turn.role)).toEqual(["user", "assistant", "user", "assistant"]);
		else expect(payload(input)).toEqual(["can you help"]);
	});

	it.each([false, true])("no-arg rename selects the whole conversation window when enabled=%s", async (enabled) => {
		project({ mode: "first", includeAssistantContext: enabled });
		const h = harness("Existing", [user("hello"), assistant("Greeting response"), user("repair expired refresh tokens"), assistant("Added expiry regression tests")]);
		await h.rename();
		const input = h.input().messages[0].content[0].text;
		expect(input).toContain("repair expired refresh tokens");
		expect(input.includes("Added expiry regression tests")).toBe(enabled);
		if (!enabled) expect(payload(h.input())).toEqual(["hello", "repair expired refresh tokens"]);
		await h.fire("agent_settled");
		expect(h.complete).toHaveBeenCalledTimes(1); // command still pins the result
	});

	it("includes only user and assistant TEXT plus the latest compaction summary", async () => {
		project({ includeAssistantContext: true });
		const entries: SessionEntry[] = [
			assistant("orphan-before-human"),
			user("fix refresh"),
			{ type: "compaction", summary: "old-summary" },
			{ type: "message", message: { role: "system", content: "system-secret" } },
			{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "tool-secret" }] } },
			{ type: "custom_message", message: { role: "user", content: "custom-secret" } },
			{ type: "message", message: { role: "assistant", content: [
				{ type: "thinking", thinking: "thinking-secret", text: "thinking-secret" },
				{ type: "toolCall", arguments: { text: "call-secret" } },
				{ type: "image", data: "image-secret" },
				{ type: "text", text: "Implemented refresh expiry" },
			] } },
			{ type: "compaction", summary: "latest-summary" },
			user('test "token" expiry\nnow'),
		];
		const h = harness(undefined, entries);
		await h.fire("agent_settled");
		const input = h.input().messages[0].content[0].text;
		for (const excluded of ["orphan-before-human", "old-summary", "system-secret", "tool-secret", "custom-secret", "thinking-secret", "call-secret", "image-secret"]) expect(input).not.toContain(excluded);
		expect(payload(h.input())).toEqual({
			messages: [{ role: "user", text: "fix refresh" }, { role: "assistant", text: "Implemented refresh expiry" }, { role: "user", text: 'test "token" expiry\nnow' }],
			compactionSummary: "latest-summary",
		});
		expect(buildTitleMessages(entries)).toEqual(["fix refresh", 'test "token" expiry\nnow']);
	});

	it("does not leak assistant text or compaction summaries by default", async () => {
		const h = harness(undefined, [user("task"), assistant("assistant-secret"), { type: "compaction", summary: "summary-secret" }]);
		await h.rename();
		expect(payload(h.input())).toEqual(["task"]);
	});

	it.each(["🚀", "\u0001", "界"])("shares one 16 KiB UTF-8 budget, including framing, summary and system for %j", async (character) => {
		project({ includeAssistantContext: true, prompt: "editorial" });
		const entries = [user("first-human-task"), ...Array.from({ length: 24 }, (_, i) => (i % 2 ? user : assistant)(`turn-${i}-${character.repeat(1000)}`)), assistant(`recent-tail-${character.repeat(1000)}`), { type: "compaction", summary: `summary-${character.repeat(1000)}` }];
		const h = harness(undefined, entries);
		await h.rename();
		const input = h.input();
		const text = input.messages[0].content[0].text;
		expect(Buffer.byteLength(input.systemPrompt + text, "utf8")).toBeLessThanOrEqual(16384);
		const json = payload(input);
		expect(json.messages[0]).toEqual({ role: "user", text: "first-human-task" });
		expect(json.messages.at(-1).text).toContain("recent-tail-");
		expect(json.messages.length).toBeLessThanOrEqual(8);
		expect(json.compactionSummary).toContain("summary-");
		expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
	});

	it.each(["🚀", "界"])("skips classifier requests whose final framing exceeds 16 KiB for %j", async (character) => {
		const classify = vi.fn();
		const ctx = { modelRegistry: { classify } } as any;
		const oversized = await classifyKeep(ctx, { id: "classifier" } as any, character.repeat(3000), ["repair token expiry"]);
		expect(oversized).toBeNull();
		expect(classify).not.toHaveBeenCalled();
		classify.mockResolvedValue({ stopReason: "stop", answers: { keep: { type: "bool", probability: 0.9 } } });
		expect(await classifyKeep(ctx, { id: "classifier" } as any, "Token Expiry", ["repair token expiry"])).toBe(true);
		expect(Buffer.byteLength(JSON.stringify(classify.mock.calls[0]![1]), "utf8")).toBeLessThanOrEqual(16384);
	});

	it("human-only helper budgets a huge single Unicode message and maxMessages=1", () => {
		const messages = buildTitleMessages([user("🚀".repeat(10000))], { maxCharsPerMessage: 10000 });
		const input = buildTitleRequest("all", messages).user;
		expect(Buffer.byteLength(input, "utf8")).toBeLessThanOrEqual(16384);
		expect(buildTitleMessages([user("first"), user("middle"), user("last")], { maxMessages: 1 })).toEqual(["first"]);
	});

	it("auto KEEP/NEW and classifier paths receive the same labelled context and word limit", async () => {
		project({ mode: "auto", includeAssistantContext: true, maxWords: 3 });
		const h = harness();
		h.complete.mockResolvedValueOnce(response("Refresh expiry fix")).mockResolvedValueOnce(response("KEEP"));
		await h.fire("agent_settled");
		await h.fire("agent_settled");
		expect(payload(h.input(1)).messages[1].text).toBe("Fixed token refresh expiry");
		expect(h.input(1).systemPrompt).toContain("at most 3 whitespace-delimited words");
		const classify = vi.fn(async () => ({ stopReason: "stop", answers: { keep: { type: "bool", probability: 0.9 } } }));
		Object.assign(h.ctx.modelRegistry, { getAvailableOfType: async () => [{ id: "classifier" }], classify });
		await h.fire("agent_settled");
		const instructions = (classify.mock.calls as any)[0][1].questions.keep.instructions;
		expect(instructions).toContain('"role":"assistant"');
		expect(instructions).toContain("Fixed token refresh expiry");
		expect(instructions).toContain("at most 3 whitespace-delimited words");
		expect(h.complete).toHaveBeenCalledTimes(2);
	});
});

describe("failure preservation and stale response guards", () => {
	it.each(["", "   ", "\u001b]0;unterminated", "\u0007"])("failed follow output %j preserves an inherited title", async (text) => {
		const h = harness("Useful Existing Title");
		h.complete.mockResolvedValue(response(text));
		await h.fire("agent_settled");
		expect(h.name()).toBe("Useful Existing Title");
		expect(h.pi.setSessionName).not.toHaveBeenCalled();
	});

	it.each(["throw", "empty", "invalid", "overlong", "non-stop"])("no-arg rename %s failure preserves an existing title and warns", async (failure) => {
		project({ maxWords: 3 });
		const h = harness("User Chosen Title");
		if (failure === "throw") h.complete.mockRejectedValue(new Error("offline"));
		else if (failure === "non-stop") h.complete.mockResolvedValue({ stopReason: "error", content: [] });
		else h.complete.mockResolvedValue(response(failure === "empty" ? "" : failure === "invalid" ? "\u0007" : "This is an overlong model title"));
		await h.rename();
		expect(h.name()).toBe("User Chosen Title");
		expect(h.pi.setSessionName).not.toHaveBeenCalled();
		expect(h.ctx.ui.notify).toHaveBeenCalledWith("Could not generate a name from the model response", "warning");
	});

	it("a thrown follow update preserves the last generated title", async () => {
		const h = harness();
		h.complete.mockResolvedValueOnce(response("Useful Title")).mockRejectedValueOnce(new Error("offline"));
		await h.fire("agent_settled");
		await h.fire("agent_settled");
		expect(h.name()).toBe("Useful Title");
		expect(h.pi.setSessionName).toHaveBeenCalledTimes(1);
	});

	it.each(["session_start", "before_agent_start", "session_shutdown"])("%s invalidates pending background results even for an unnamed session", async (event) => {
		const h = harness();
		const old = deferred();
		h.complete.mockReturnValueOnce(old.promise);
		const pending = h.fire("agent_settled");
		h.fire(event);
		old.resolve(response("Obsolete Title"));
		await pending;
		expect(h.pi.setSessionName).not.toHaveBeenCalled();
	});

	it.each(["session_start", "before_agent_start", "session_shutdown"])("%s invalidates pending no-arg rename", async (event) => {
		const h = harness();
		const old = deferred();
		h.complete.mockReturnValueOnce(old.promise);
		const pending = h.rename();
		h.fire(event);
		old.resolve(response("Obsolete Title"));
		await pending;
		expect(h.pi.setSessionName).not.toHaveBeenCalled();
		expect(h.ctx.ui.notify).not.toHaveBeenCalled();
	});

	it.each(["session_start", "before_agent_start"])("stale finally after %s cannot clear a newer inFlight generation", async (event) => {
		const h = harness();
		const old = deferred();
		const latest = deferred();
		h.complete.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
		const pendingOld = h.fire("agent_settled");
		h.fire(event);
		const pendingLatest = h.fire("agent_settled");
		old.resolve(response("Obsolete Title"));
		await pendingOld;
		await h.fire("agent_settled");
		expect(h.complete).toHaveBeenCalledTimes(2);
		latest.resolve(response("Current Title"));
		await pendingLatest;
		expect(h.name()).toBe("Current Title");
	});

	it.each(["background", "rename"])("manual rename supersedes a pending %s result", async (source) => {
		const h = harness();
		const old = deferred();
		h.complete.mockReturnValueOnce(old.promise);
		const pending = source === "background" ? h.fire("agent_settled") : h.rename();
		await h.rename("Human Chosen Title");
		old.resolve(response("Obsolete Title"));
		await pending;
		expect(h.name()).toBe("Human Chosen Title");
		expect(h.pi.setSessionName).toHaveBeenCalledTimes(1);
	});

	it("external manual rename protects a pending background result", async () => {
		const h = harness();
		const old = deferred();
		h.complete.mockReturnValueOnce(old.promise);
		const pending = h.fire("agent_settled");
		h.externalRename("External Title");
		h.fire("session_info_changed", { name: "External Title" });
		old.resolve(response("Obsolete Title"));
		await pending;
		expect(h.name()).toBe("External Title");
		expect(h.pi.setSessionName).not.toHaveBeenCalled();
	});

	it("the latest of two concurrent no-arg renames wins", async () => {
		const h = harness();
		const old = deferred();
		h.complete.mockReturnValueOnce(old.promise).mockResolvedValueOnce(response("Latest Title"));
		const pending = h.rename();
		await h.rename();
		old.resolve(response("Obsolete Title"));
		await pending;
		expect(h.name()).toBe("Latest Title");
		expect(h.pi.setSessionName).toHaveBeenCalledTimes(1);
	});

	it("a changed session file invalidates a response even without a session event", async () => {
		const h = harness();
		const old = deferred();
		h.complete.mockReturnValueOnce(old.promise);
		const pending = h.fire("agent_settled");
		h.switchFile(join(cwd, "replacement.jsonl"));
		old.resolve(response("Obsolete Title"));
		await pending;
		expect(h.pi.setSessionName).not.toHaveBeenCalled();
	});

	it("session_start resets manual locks and reloads project config", async () => {
		project({ mode: "first", maxWords: 1 });
		const h = harness();
		await h.rename("Manual Title");
		h.externalRename(undefined);
		project({ mode: "follow", maxWords: 3 });
		h.fire("session_start");
		await h.fire("agent_settled");
		expect(h.name()).toBe("Generated Title");
		expect(h.input().systemPrompt).toContain("at most 3 whitespace-delimited words");
	});
});
