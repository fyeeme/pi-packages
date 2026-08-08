import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchTool, normalizeConfig, parseHookOutput, loadConfig } from "../index.ts";

// ---------------------------------------------------------------------------
// matchTool (Claude Code regex semantics)
// ---------------------------------------------------------------------------

describe("matchTool", () => {
	it("empty string and '*' match anything (the match-all patterns)", () => {
		expect(matchTool("", "")).toBe(true);
		expect(matchTool("", "bash")).toBe(true);
		expect(matchTool("*", "bash")).toBe(true);
		expect(matchTool("*", "plugin_serena_serena_read")).toBe(true);
	});

	it("matches literal strings exactly", () => {
		expect(matchTool("bash", "bash")).toBe(true);
		expect(matchTool("bash", "read")).toBe(false);
		expect(matchTool("bash", "bashx")).toBe(false);
	});

	it("supports regex alternation (Claude Code semantics)", () => {
		// The case glob matching silently broke: `Edit|Write` must match either.
		expect(matchTool("Edit|Write", "Edit")).toBe(true);
		expect(matchTool("Edit|Write", "Write")).toBe(true);
		expect(matchTool("Edit|Write", "Bash")).toBe(false);
		// Alternation, not literal: the string "Edit|Write" itself does not match.
		expect(matchTool("Edit|Write", "Edit|Write")).toBe(false);
	});

	it("supports regex wildcards", () => {
		expect(matchTool("Notebook.*", "NotebookEdit")).toBe(true);
		// .* allows zero trailing chars, so bare "Notebook" matches.
		expect(matchTool("Notebook.*", "Notebook")).toBe(true);
		// + requires at least one trailing char.
		expect(matchTool("Notebook.+", "Notebook")).toBe(false);
		expect(matchTool("mcp__memory__.*", "mcp__memory__create_entities")).toBe(true);
	});

	it("anchors the whole string (no partial matches)", () => {
		expect(matchTool("edit", "editor")).toBe(false);
		expect(matchTool("edit", "preedit")).toBe(false);
	});

	it("matches nothing on invalid regex (never throws)", () => {
		// `(unclosed` is invalid regex → must not throw; matches nothing (CC has
		// no literal fallback), and a load-time warn surfaces the misconfiguration.
		expect(matchTool("(unclosed", "(unclosed")).toBe(false);
		expect(matchTool("(unclosed", "x")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// normalizeConfig (schema validation — must never throw on bad shapes)
// ---------------------------------------------------------------------------

describe("normalizeConfig", () => {
	it("returns null for non-object input", () => {
		expect(normalizeConfig(null)).toBeNull();
		expect(normalizeConfig("oops")).toBeNull();
		expect(normalizeConfig(42)).toBeNull();
	});

	it("treats missing/null hooks as empty config (no crash downstream)", () => {
		expect(normalizeConfig({})).toEqual({ hooks: {} });
		expect(normalizeConfig({ hooks: null })).toEqual({ hooks: {} });
	});

	it("returns null when hooks is the wrong type", () => {
		expect(normalizeConfig({ hooks: "not-an-object" })).toBeNull();
		expect(normalizeConfig({ hooks: [] })).toBeNull();
	});

	it("keeps valid event arrays and drops malformed ones", () => {
		const cfg = normalizeConfig({
			hooks: {
				PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo" }] }],
				Stop: "should-be-array", // wrong type → dropped, not stored
			},
		});
		expect(cfg).not.toBeNull();
		expect(cfg?.hooks.PreToolUse).toHaveLength(1);
		expect(cfg?.hooks.Stop).toBeUndefined();
	});

	it("drops groups with a missing/non-string matcher (would otherwise match literal 'undefined')", () => {
		const cfg = normalizeConfig({
			hooks: {
				PreToolUse: [
					{ hooks: [{ type: "command", command: "echo" }] }, // matcher missing
					{ matcher: 42, hooks: [{ type: "command", command: "echo" }] }, // non-string
					{ matcher: "Bash", hooks: [{ type: "command", command: "echo" }] }, // valid
				],
			},
		});
		expect(cfg?.hooks.PreToolUse).toHaveLength(1);
		expect(cfg?.hooks.PreToolUse?.[0].matcher).toBe("Bash");
	});

	it("drops malformed hook entries and bad timeouts", () => {
		const cfg = normalizeConfig({
			hooks: {
				Stop: [
					{
						matcher: "",
						hooks: [
							{ type: "command", command: "valid" },
							{ type: "command" }, // missing command
							{ type: "sql", command: "x" }, // wrong type
							{ type: "command", command: "t", timeout: "30" }, // non-number timeout
							{ type: "command", command: "t2", timeout: 30 }, // valid timeout
						],
					},
				],
			},
		});
		const entries = cfg?.hooks.Stop?.[0].hooks;
		expect(entries).toHaveLength(3);
		expect(entries?.[0]).toEqual({ type: "command", command: "valid" });
		expect(entries?.[2]).toEqual({ type: "command", command: "t2", timeout: 30 });
	});
});

// ---------------------------------------------------------------------------
// parseHookOutput (control flow + context)
// ---------------------------------------------------------------------------

describe("parseHookOutput", () => {
	it("extracts additionalContext", () => {
		const out = parseHookOutput("c", JSON.stringify({ hookSpecificOutput: { additionalContext: "hi" } }), 0);
		expect(out.context).toBe("hi");
		expect(out.block).toBeNull();
	});

	it("blocks on exit code 2", () => {
		const out = parseHookOutput("c", "", 2);
		expect(out.block).toBe("blocked by hook");
	});

	it("blocks on permissionDecision deny and uses the reason", () => {
		const stdout = JSON.stringify({
			hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "dangerous" },
		});
		const out = parseHookOutput("c", stdout, 0);
		expect(out.block).toBe("dangerous");
	});

	it("does not block on allow / ask", () => {
		const allow = parseHookOutput("c", JSON.stringify({ hookSpecificOutput: { permissionDecision: "allow" } }), 0);
		expect(allow.block).toBeNull();
		const ask = parseHookOutput("c", JSON.stringify({ hookSpecificOutput: { permissionDecision: "ask" } }), 0);
		expect(ask.block).toBeNull();
	});

	it("returns empty result on non-JSON stdout (no throw)", () => {
		const out = parseHookOutput("c", "running...", 0);
		expect(out.context).toBeNull();
		expect(out.block).toBeNull();
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
			JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo pre" }] }] } }),
			"utf8",
		);

		const config = loadConfig(workDir);
		expect(config).not.toBeNull();
		expect(config?.hooks.PreToolUse?.[0]?.matcher).toBe("Bash");
	});

	it("returns a usable (empty) config instead of crashing on a malformed shape", async () => {
		// `{}` used to cause `config.hooks.SessionStart` TypeError downstream;
		// now it normalizes to an empty hooks config.
		const cfgPath = join(workDir, "bad.json");
		await writeFile(cfgPath, JSON.stringify({}), "utf8");
		process.env.PI_HOOKS_CONFIG = cfgPath;

		const config = loadConfig(workDir);
		expect(config).not.toBeNull();
		expect(config?.hooks).toEqual({});
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
