import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock getAgentDir so scanWeeklyTokens reads from a throwaway session tree.
const mockAgentDir = vi.fn();
vi.mock("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: () => mockAgentDir(),
}));

// Import after the mock is registered.
const { scanWeeklyTokens } = await import("../session-scanner.ts");

function todayUTC(): string {
	return new Date().toISOString().slice(0, 10);
}

function assistantLine(provider: string, totalTokens: number): string {
	return JSON.stringify({
		type: "message",
		message: { role: "assistant", provider, usage: { totalTokens } },
	});
}

describe("scanWeeklyTokens", () => {
	let root: string;
	let sessionsDir: string;
	let sessionDayDir: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-statusline-sessions-"));
		sessionsDir = join(root, "sessions");
		// A daily subdirectory, named with today's date like pi's session layout.
		sessionDayDir = join(sessionsDir, todayUTC());
		await mkdir(sessionDayDir, { recursive: true });
		mockAgentDir.mockReturnValue(root);
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("returns 0 when the sessions directory does not exist", () => {
		mockAgentDir.mockReturnValue(join(root, "does-not-exist"));
		expect(scanWeeklyTokens("deepseek")).toBe(0);
	});

	it("sums totalTokens for assistant messages matching the provider", async () => {
		await writeFile(join(sessionDayDir, "2025.jsonl"), `${assistantLine("deepseek", 100)}\n${assistantLine("deepseek", 250)}\n`, "utf8");
		expect(scanWeeklyTokens("deepseek")).toBe(350);
	});

	it("ignores messages from other providers", async () => {
		await writeFile(join(sessionDayDir, "2025.jsonl"), `${assistantLine("deepseek", 100)}\n${assistantLine("openai", 999)}\n`, "utf8");
		expect(scanWeeklyTokens("deepseek")).toBe(100);
	});

	it("skips non-assistant and malformed lines", async () => {
		const content = [
			JSON.stringify({ type: "message", message: { role: "user", provider: "deepseek", usage: { totalTokens: 50 } } }),
			assistantLine("deepseek", 200),
			"not json at all",
			"",
		].join("\n");
		await writeFile(join(sessionDayDir, "2025.jsonl"), content, "utf8");
		expect(scanWeeklyTokens("deepseek")).toBe(200);
	});

	it("skips session files dated before the current natural week", async () => {
		// A file named 20 years ago.
		const oldDir = join(sessionsDir, "2000-01-01");
		await mkdir(oldDir, { recursive: true });
		await writeFile(join(oldDir, "2000-01-01T00-00-00.jsonl"), `${assistantLine("deepseek", 9999)}\n`, "utf8");
		await writeFile(join(sessionDayDir, "2025.jsonl"), `${assistantLine("deepseek", 10)}\n`, "utf8");
		expect(scanWeeklyTokens("deepseek")).toBe(10);
	});

	it("ignores non-jsonl files", async () => {
		await writeFile(join(sessionDayDir, "notes.txt"), assistantLine("deepseek", 9999), "utf8");
		await writeFile(join(sessionDayDir, "2025.jsonl"), `${assistantLine("deepseek", 7)}\n`, "utf8");
		expect(scanWeeklyTokens("deepseek")).toBe(7);
	});

	it("skips unreadable subdirectories without throwing", async () => {
		// A "directory" entry that is actually a file — readdir withFileTypes
		// reports it as a dir-name but it has no readable contents.
		await writeFile(join(sessionsDir, "not-a-dir"), "whatever", "utf8");
		await writeFile(join(sessionDayDir, "2025.jsonl"), `${assistantLine("deepseek", 5)}\n`, "utf8");
		expect(scanWeeklyTokens("deepseek")).toBe(5);
	});
});
