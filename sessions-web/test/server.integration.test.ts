import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSessionWebServer, stopSessionWebServer } from "../src/server.ts";

// Real HTTP integration tests: the server binds 127.0.0.1 on an ephemeral
// port and serves a fixture agent dir (stubbed through PI_CODING_AGENT_DIR,
// which pi's getAgentDir() reads on every call). No mocks on server.ts.

const SESSION_ID = "11111111-2222-3333-4444-555555555555";
let agentDir: string;
let baseUrl: string;

beforeAll(async () => {
	agentDir = mkdtempSync(join(tmpdir(), "sessweb-"));
	const sessionsDir = join(agentDir, "sessions", "2026-10");
	mkdirSync(sessionsDir, { recursive: true });
	// File names are {timestamp}_{sessionId}.jsonl under any sessions subdir.
	writeFileSync(
		join(sessionsDir, `1760000000000_${SESSION_ID}.jsonl`),
		[
			JSON.stringify({ type: "session", id: SESSION_ID, timestamp: "2026-10-29T10:00:00.000Z", cwd: "/tmp/proj", provider: "p", model: "m" }),
			JSON.stringify({ type: "message", timestamp: "2026-10-29T10:00:01.000Z", message: { role: "user", content: "fixture alpha question", timestamp: 1760000001000 } }),
			JSON.stringify({ type: "message", timestamp: "2026-10-29T10:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "fixture answer" }], timestamp: 1760000002000 } }),
			JSON.stringify({ type: "session_info", name: "fixture 会话名" }),
		].join("\n"),
	);
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	stopSessionWebServer(); // clean any server left over from another file
	baseUrl = await startSessionWebServer(0);
});

afterAll(() => {
	stopSessionWebServer();
	vi.unstubAllEnvs();
	rmSync(agentDir, { recursive: true, force: true });
});

describe("session-web server (real HTTP)", () => {
	it("binds 127.0.0.1 on an ephemeral port and is idempotent", async () => {
		expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
		expect(await startSessionWebServer(0)).toBe(baseUrl);
	});

	it("GET / lists the fixture session and filters by query", async () => {
		const all = await (await fetch(baseUrl)).text();
		// The sidebar item title prefers the session_info name over firstMessage.
		expect(all).toContain("fixture 会话名");
		expect(all).toContain("共 1 个会话");

		const none = await (await fetch(`${baseUrl}?q=nosuchkeyword`)).text();
		expect(none).toContain("没有匹配的会话");
	});

	it("GET /session/:id renders the session page with the session_info name", async () => {
		const html = await (await fetch(`${baseUrl}session/${SESSION_ID}?view=trace`)).text();
		expect(html).toContain("fixture 会话名");
		expect(html).toContain("fixture alpha question");
	});

	it("GET /session/:id?fragment=1 returns a shell-free fragment", async () => {
		const fragment = await (await fetch(`${baseUrl}session/${SESSION_ID}?view=trace&fragment=1`)).text();
		expect(fragment).not.toContain("<html");
	});

	it("rejects traversal-shaped ids before touching the filesystem", async () => {
		const res = await fetch(`${baseUrl}session/..%2F..%2Fetc%2Fpasswd`);
		expect(res.status).toBe(404);
		expect(await res.text()).toContain("Invalid session id");
	});

	it("rejects too-short ids with 404", async () => {
		const res = await fetch(`${baseUrl}session/short`);
		expect(res.status).toBe(404);
		expect(await res.text()).toContain("Invalid session id");
	});

	it("returns 404 for a well-formed but unknown id", async () => {
		const res = await fetch(`${baseUrl}session/99999999-9999-9999-9999-999999999999`);
		expect(res.status).toBe(404);
		expect(await res.text()).toContain("No session file matches id");
	});

	it("serves favicon as 204 and unknown routes as 404", async () => {
		expect((await fetch(`${baseUrl}favicon.ico`)).status).toBe(204);
		const missing = await fetch(`${baseUrl}nope`);
		expect(missing.status).toBe(404);
		expect(await missing.text()).toContain("Not found");
	});

	it("answers 405 to non-GET methods", async () => {
		const res = await fetch(baseUrl, { method: "POST" });
		expect(res.status).toBe(405);
	});

	it("stop returns true once and false afterwards", () => {
		expect(stopSessionWebServer()).toBe(true);
		expect(stopSessionWebServer()).toBe(false);
	});
});
