import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	clearThinkingUIModePreference,
	readThinkingUIModePreference,
	writeThinkingUIModePreference,
} from "../persistence.ts";

// persistence.ts resolves the "global" scope under $HOME/.pi/agent/state.
// We point HOME at a throwaway dir so tests never touch the real user state.
describe("thinking-ui persistence", () => {
	let homeDir: string;
	let projectDir: string;
	let originalHome: string | undefined;

	beforeEach(async () => {
		originalHome = process.env.HOME;
		homeDir = await mkdtemp(join(tmpdir(), "pi-thinking-home-"));
		projectDir = await mkdtemp(join(tmpdir(), "pi-thinking-proj-"));
		process.env.HOME = homeDir;
	});

	afterEach(async () => {
		process.env.HOME = originalHome;
		await rm(homeDir, { recursive: true, force: true });
		await rm(projectDir, { recursive: true, force: true });
	});

	it("returns undefined when no preference exists", async () => {
		expect(await readThinkingUIModePreference("project", projectDir)).toBeUndefined();
		expect(await readThinkingUIModePreference("global", projectDir)).toBeUndefined();
	});

	it("writes and reads a project-scoped preference", async () => {
		await writeThinkingUIModePreference("project", projectDir, "expanded");
		expect(await readThinkingUIModePreference("project", projectDir)).toBe("expanded");
	});

	it("writes and reads a global-scoped preference", async () => {
		await writeThinkingUIModePreference("global", projectDir, "collapsed");
		expect(await readThinkingUIModePreference("global", projectDir)).toBe("collapsed");
	});

	it("keeps project and global scopes independent", async () => {
		await writeThinkingUIModePreference("project", projectDir, "expanded");
		await writeThinkingUIModePreference("global", projectDir, "collapsed");
		expect(await readThinkingUIModePreference("project", projectDir)).toBe("expanded");
		expect(await readThinkingUIModePreference("global", projectDir)).toBe("collapsed");
	});

	it("clears a project-scoped preference", async () => {
		await writeThinkingUIModePreference("project", projectDir, "summary");
		await clearThinkingUIModePreference("project", projectDir);
		expect(await readThinkingUIModePreference("project", projectDir)).toBeUndefined();
	});

	it("clears a global-scoped preference", async () => {
		await writeThinkingUIModePreference("global", projectDir, "summary");
		await clearThinkingUIModePreference("global", projectDir);
		expect(await readThinkingUIModePreference("global", projectDir)).toBeUndefined();
	});

	it("rejects an invalid persisted mode by throwing", async () => {
		const { writeFile, mkdir } = await import("node:fs/promises");
		const projectPrefPath = join(projectDir, ".pi", "thinking-ui.json");
		await mkdir(join(projectDir, ".pi"), { recursive: true });
		await writeFile(projectPrefPath, JSON.stringify({ mode: "explode" }), "utf8");
		await expect(readThinkingUIModePreference("project", projectDir)).rejects.toThrow();
	});

	it("rejects malformed JSON by throwing", async () => {
		const { writeFile, mkdir } = await import("node:fs/promises");
		const projectPrefPath = join(projectDir, ".pi", "thinking-ui.json");
		await mkdir(join(projectDir, ".pi"), { recursive: true });
		await writeFile(projectPrefPath, "{ not json", "utf8");
		await expect(readThinkingUIModePreference("project", projectDir)).rejects.toThrow();
	});
});
