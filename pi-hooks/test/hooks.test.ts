import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globMatch, loadConfig } from "../index.ts";

// ---------------------------------------------------------------------------
// globMatch
// ---------------------------------------------------------------------------

describe("globMatch", () => {
	it("an empty matcher matches anything (the remind pattern)", () => {
		expect(globMatch("", "")).toBe(true);
		expect(globMatch("", "bash")).toBe(true);
		expect(globMatch("", "plugin_serena_serena_read")).toBe(true);
	});

	it("matches literal strings exactly", () => {
		expect(globMatch("bash", "bash")).toBe(true);
		expect(globMatch("bash", "read")).toBe(false);
		expect(globMatch("bash", "bashx")).toBe(false);
	});

	it("treats '*' as a multi-character wildcard", () => {
		expect(globMatch("plugin_*", "plugin_serena_serena_read")).toBe(true);
		expect(globMatch("plugin_*", "plugin_")).toBe(true);
		expect(globMatch("plugin_*", "bash")).toBe(false);
	});

	it("treats '?' as a single-character wildcard", () => {
		expect(globMatch("bas?", "bash")).toBe(true);
		expect(globMatch("bas?", "bass")).toBe(true);
		expect(globMatch("bas?", "bas")).toBe(false);
		expect(globMatch("bas?", "bashx")).toBe(false);
	});

	it("escapes regex metacharacters so they match literally", () => {
		// '.' is a regex metachar but must match a literal dot.
		expect(globMatch("a.b", "a.b")).toBe(true);
		expect(globMatch("a.b", "aXb")).toBe(false);
		// Other metacharacters are literal too.
		expect(globMatch("mcp(x)", "mcp(x)")).toBe(true);
		expect(globMatch("mcp(x)", "mcpx")).toBe(false);
	});

	it("anchors the whole string (no partial matches)", () => {
		expect(globMatch("edit", "editor")).toBe(false);
		expect(globMatch("edit", "preedit")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

describe("loadConfig", () => {
	let workDir: string;
	let homeDir: string;
	let originalHome: string | undefined;
	let originalHooksConfig: string | undefined;

	beforeEach(async () => {
		workDir = await mkdtemp(join(tmpdir(), "pi-hooks-work-"));
		homeDir = await mkdtemp(join(tmpdir(), "pi-hooks-home-"));
		originalHome = process.env.HOME;
		originalHooksConfig = process.env.PI_HOOKS_CONFIG;
		process.env.HOME = homeDir;
		delete process.env.PI_HOOKS_CONFIG;
	});

	afterEach(async () => {
		process.env.HOME = originalHome;
		if (originalHooksConfig === undefined) {
			delete process.env.PI_HOOKS_CONFIG;
		} else {
			process.env.PI_HOOKS_CONFIG = originalHooksConfig;
		}
		await rm(workDir, { recursive: true, force: true });
		await rm(homeDir, { recursive: true, force: true });
	});

	it("returns null when no config file exists anywhere", () => {
		expect(loadConfig(workDir)).toBeNull();
	});

	it("reads PI_HOOKS_CONFIG with highest priority", async () => {
		const cfgPath = join(workDir, "custom-hooks.json");
		await writeFile(
			cfgPath,
			JSON.stringify({ hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "echo stop" }] }] } }),
			"utf8",
		);
		process.env.PI_HOOKS_CONFIG = cfgPath;

		const config = loadConfig("/some/unrelated/cwd");
		expect(config).not.toBeNull();
		expect(config?.hooks.Stop).toHaveLength(1);
	});

	it("reads .pi/hooks.json from the project cwd", async () => {
		await mkdir(join(workDir, ".pi"), { recursive: true });
		await writeFile(
			join(workDir, ".pi", "hooks.json"),
			JSON.stringify({ hooks: { PreToolUse: [{ matcher: "bash", hooks: [{ type: "command", command: "echo pre" }] }] } }),
			"utf8",
		);

		const config = loadConfig(workDir);
		expect(config).not.toBeNull();
		expect(config?.hooks.PreToolUse?.[0]?.matcher).toBe("bash");
	});

	it("returns null on malformed JSON (logs and continues)", async () => {
		const cfgPath = join(workDir, "bad.json");
		await writeFile(cfgPath, "{ not valid json", "utf8");
		process.env.PI_HOOKS_CONFIG = cfgPath;

		expect(loadConfig(workDir)).toBeNull();
	});

	it("does not throw when the config path is unreadable", async () => {
		// A directory passed as PI_HOOKS_CONFIG cannot be parsed as JSON.
		process.env.PI_HOOKS_CONFIG = workDir;
		expect(loadConfig(workDir)).toBeNull();
	});
});
