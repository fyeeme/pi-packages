import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_PORT, default as sessionsWebExtension } from "../index.ts";
import {
	renderErrorPage,
	renderListPage,
	renderSessionPage,
	renderSessionFragment,
	loadStaticScript,
} from "../src/views.ts";
import { startSessionWebServer } from "../src/server.ts";

vi.mock("../src/server.ts", () => ({
	startSessionWebServer: vi.fn().mockResolvedValue("http://127.0.0.1:8123"),
	stopSessionWebServer: vi.fn().mockReturnValue(false),
}));

function captureCommand(): { def: any; pi: any } {
	const registered: Record<string, any> = {};
	const pi = {
		registerCommand: (name: string, def: any) => (registered[name] = def),
		on: vi.fn(),
	};
	sessionsWebExtension(pi as any);
	return { def: registered["session-web"], pi };
}

describe("extension registration", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("registers the session-web command and shuts the server down on session_shutdown", () => {
		const { def, pi } = captureCommand();
		expect(def).toBeDefined();
		expect(pi.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
	});

	it("stop reports when no server is running", async () => {
		const { def } = captureCommand();
		const notify = vi.fn();
		await def.handler("stop", { ui: { notify } } as any);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("not running"), "info");
	});

	it("starts on a valid port and reports the bound URL", async () => {
		const { def } = captureCommand();
		const notify = vi.fn();
		await def.handler("8080", { ui: { notify } } as any);
		expect(startSessionWebServer).toHaveBeenCalledWith(8080);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("http://127.0.0.1:8123"), "info");
	});

	it("defaults to the default port with no argument", async () => {
		const { def } = captureCommand();
		await def.handler("  ", { ui: { notify: vi.fn() } } as any);
		expect(startSessionWebServer).toHaveBeenCalledWith(DEFAULT_PORT);
	});

	it("rejects non-integer and out-of-range ports", async () => {
		const { def } = captureCommand();
		for (const arg of ["abc", "-1", "99999"]) {
			const notify = vi.fn();
			await def.handler(arg, { ui: { notify } } as any);
			expect(notify).toHaveBeenCalledWith(expect.stringContaining("invalid port"), "error");
		}
		expect(startSessionWebServer).not.toHaveBeenCalled();
	});
});

/** Minimal SessionManager stand-in: header + entries, no getTree (trace body path). */
function mkManager(entries: any[], header: any = { id: "sess-1", timestamp: 0, cwd: "/repo" }) {
	return {
		getHeader: () => header,
		getEntries: () => entries,
		getLeafId: () => "leaf-1",
	};
}

const ENTRIES = [
	{ type: "session_info", name: "我的调试会话" },
	{ type: "message", message: { role: "user", content: "hello <script>" } },
	{ type: "model_change", provider: "zai", modelId: "glm-5.3" },
];

describe("views", () => {
	it("renderErrorPage escapes title and message", () => {
		const html = renderErrorPage("<boom>", "a & b");
		expect(html).toContain("&lt;boom&gt;");
		expect(html).toContain("a &amp; b");
	});

	it("renderListPage shows the session count and filters by query", () => {
		const sessions: any[] = [
			{ id: "1", firstMessage: "alpha task", name: "", cwd: "/a", allMessagesText: "alpha task", modified: new Date() },
			{ id: "2", firstMessage: "beta task", name: "", cwd: "/a", allMessagesText: "beta task", modified: new Date() },
		];
		const now = new Date();
		const all = renderListPage(sessions, "", now);
		expect(all).toContain("共 2 个会话");
		const filtered = renderListPage(sessions, "alpha", now);
		expect(filtered).toContain("1 个项目 · 1 个会话");
	});

	it("renderSessionPage uses the session_info name, escapes content, and inlines scripts", () => {
		const page = renderSessionPage(mkManager(ENTRIES) as any, "trace", { marked: "/*m*/", highlight: "/*h*/" }, [], new Date());
		expect(page).toContain("pi session — 我的调试会话");
		expect(page).toContain("hello");
		// Trace rows carry the raw entry types.
		expect(page).toContain(">message<");
		expect(page).toContain(">model_change<");
		expect(page).toContain("<script>/*m*/</script>");
		// The chat client is inlined from src/chat-client.js next to views.ts.
		expect(page.length).toBeGreaterThan(5000);
	});

	it("renderSessionFragment returns the standalone view body", () => {
		const fragment = renderSessionFragment(mkManager(ENTRIES) as any, "trace");
		expect(fragment).toContain("hello");
		expect(fragment).not.toContain("<html");
	});

	it("loadStaticScript resolves the vendored renderer sources from the pi package", () => {
		expect(loadStaticScript("marked")).toContain("marked");
		expect(loadStaticScript("highlight").length).toBeGreaterThan(1000);
	});
});
