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

	it("chat view renders the main path and collapses sibling branches", () => {
		const ts = "2026-10-29T10:00:00.000Z";
		const tree: any[] = [
			{
				entry: { id: "e1", type: "message", timestamp: ts, message: { role: "user", content: "root question" } },
				children: [
					{
						entry: { id: "e2", type: "message", timestamp: ts, message: { role: "assistant", content: "branch answer A" } },
						children: [],
					},
					{
						entry: { id: "e3", type: "message", timestamp: ts, message: { role: "assistant", content: "branch answer B" } },
						children: [],
					},
				],
			},
		];
		const manager = {
			getHeader: () => ({ id: "sess-2", timestamp: 0, cwd: "/repo" }),
			getEntries: () => tree.map((n) => n.entry),
			getLeafId: () => "e2",
			getTree: () => tree,
		};
		const fragment = renderSessionFragment(manager as any, "chat");
		const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
		expect(fragment).toContain("root question");
		// Assistant text travels as a base64 data-md payload (client-side markdown).
		expect(fragment).toContain(`data-md="${b64("branch answer A")}"`);
		expect(fragment).toContain(`data-md="${b64("branch answer B")}"`);
		// Off-path siblings render as collapsed branch blocks.
		expect(fragment).toContain('details class="branch"');
	});

	it("chat view folds assistant thinking into collapsed strips", () => {
		const entries: any[] = [
			{ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "long reasoning" }, { type: "text", text: "visible answer" }] } },
		];
		const manager = {
			getHeader: () => ({ id: "s", timestamp: 0 }),
			getEntries: () => entries,
			getLeafId: () => "e",
			getTree: () => entries.map((entry, i) => ({ entry: { ...entry, id: `e${i}` }, children: [] })),
		};
		const fragment = renderSessionFragment(manager as any, "chat");
		expect(fragment).toContain("思考过程");
		expect(fragment).toContain("long reasoning");
		expect(fragment).toContain(`data-md="${Buffer.from("visible answer", "utf8").toString("base64")}"`);
	});

	it("loadStaticScript resolves the vendored renderer sources from the pi package", () => {
		expect(loadStaticScript("marked")).toContain("marked");
		expect(loadStaticScript("highlight").length).toBeGreaterThan(1000);
	});
});
