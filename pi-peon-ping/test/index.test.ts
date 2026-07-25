/**
 * Tests for pi-peon-ping extension.
 *
 * Covers:
 * - Path resolution and peon.sh discovery (env, brew, static paths)
 * - Shell detection for .sh vs .ps1
 * - Tab title formatting
 * - Session ID extraction from context
 * - peon.sh invocation (spawn)
 * - Event handler registration and behavior
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Import under test
import peonPingExtension, {
	resolvePeonShPaths,
	tryBrewPrefix,
	findPeonSh,
	resolveShellAndScript,
	setTabTitle,
	getSessionId,
	firePeon,
	findPeonCli,
	execPeonCli,
	EVENT_CATEGORY,
	resolveConfigPath,
	readPeonConfig,
	isCategoryEnabled,
	PEON_SH_TEMPLATES,
} from "../index.ts";

// ============================================================================
// Mocks
// ============================================================================

vi.mock("node:fs", async () => {
	const actual = await vi.importActual("node:fs");
	return {
		...(actual as object),
		existsSync: vi.fn(),
		readFileSync: vi.fn(),
	};
});

vi.mock("node:child_process", async () => {
	const actual = await vi.importActual("node:child_process");
	return {
		...(actual as object),
		spawn: vi.fn(),
		execFileSync: vi.fn(),
	};
});

// ============================================================================
// resolvePeonShPaths
// ============================================================================

describe("resolvePeonShPaths", () => {
	it("replaces $HOME with homedir() in each template path", () => {
		const paths = resolvePeonShPaths();
		expect(paths).toHaveLength(PEON_SH_TEMPLATES.length);
		for (const p of paths) {
			expect(p).not.toContain("$HOME");
		}
	});

	it("returns the same number of paths as templates", () => {
		// brew template has $() which is NOT resolved by resolvePeonShPaths
		const paths = resolvePeonShPaths();
		expect(paths).toHaveLength(PEON_SH_TEMPLATES.length);
	});

	it("last path ends with .ps1 (Windows fallback)", () => {
		const paths = resolvePeonShPaths();
		expect(paths[paths.length - 1].endsWith(".ps1")).toBe(true);
	});
});

// ============================================================================
// tryBrewPrefix
// ============================================================================

describe("tryBrewPrefix", () => {
	beforeEach(() => {
		vi.mocked(execFileSync).mockReset();
		vi.mocked(existsSync).mockReset();
	});

	it("returns undefined on non-darwin platforms", () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("linux");
		expect(tryBrewPrefix()).toBeUndefined();
	});

	it("returns the peon.sh path when brew --prefix succeeds and file exists", () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
		vi.mocked(execFileSync).mockReturnValue("/opt/homebrew/opt/peon-ping\n");
		vi.mocked(existsSync).mockReturnValue(true);
		expect(tryBrewPrefix()).toBe("/opt/homebrew/opt/peon-ping/libexec/peon.sh");
	});

	it("returns undefined when existsSync fails for the brew path", () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
		vi.mocked(execFileSync).mockReturnValue("/opt/homebrew/opt/peon-ping\n");
		vi.mocked(existsSync).mockReturnValue(false);
		expect(tryBrewPrefix()).toBeUndefined();
	});

	it("returns undefined when brew --prefix throws", () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
		vi.mocked(execFileSync).mockImplementation(() => {
			throw new Error("brew not found");
		});
		expect(tryBrewPrefix()).toBeUndefined();
	});
});

// ============================================================================
// findPeonSh
// ============================================================================

describe("findPeonSh", () => {
	beforeEach(() => {
		vi.mocked(existsSync).mockReset();
		vi.mocked(execFileSync).mockReset();
		delete process.env.PEON_SH;
		vi.spyOn(process, "platform", "get").mockReturnValue("linux");
	});

	it("returns PEON_SH env var path when it exists", () => {
		process.env.PEON_SH = "/custom/peon.sh";
		vi.mocked(existsSync).mockReturnValueOnce(true); // env check
		vi.mocked(existsSync).mockReturnValue(false);    // brew won't run on linux
		expect(findPeonSh()).toBe("/custom/peon.sh");
	});

	it("skips PEON_SH env var when file does not exist", () => {
		process.env.PEON_SH = "/custom/peon.sh";
		vi.mocked(existsSync).mockReturnValue(false); // env fails
		// All static paths also fail
		vi.mocked(existsSync).mockReturnValue(false);
		expect(findPeonSh()).toBeNull();
	});

	it("returns the first static path where existsSync returns true", () => {
		// env not set, brew won't run on linux
		vi.mocked(existsSync).mockReturnValueOnce(false)  // .claude
			.mockReturnValueOnce(true);                     // .openpeon
		const paths = resolvePeonShPaths();
		expect(findPeonSh()).toBe(paths[1]); // .openpeon (index 1 after brew template)
	});

	it("returns null when no path exists", () => {
		vi.mocked(existsSync).mockReturnValue(false);
		expect(findPeonSh()).toBeNull();
	});

	it("handles existsSync throwing (permission denied)", () => {
		vi.mocked(existsSync).mockImplementation(() => {
			throw new Error("EACCES");
		});
		expect(findPeonSh()).toBeNull();
	});
});

// ============================================================================
// resolveShellAndScript
// ============================================================================

describe("resolveShellAndScript", () => {
	it("returns bash for .sh paths", () => {
		expect(resolveShellAndScript("/path/to/peon.sh")).toEqual({
			shell: "bash",
			script: "/path/to/peon.sh",
		});
	});

	it("returns powershell for .ps1 paths", () => {
		expect(resolveShellAndScript("/path/to/peon.ps1")).toEqual({
			shell: "powershell",
			script: "/path/to/peon.ps1",
		});
	});
});

// ============================================================================
// setTabTitle
// ============================================================================

describe("setTabTitle", () => {
	let writeSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		writeSpy.mockRestore();
	});

	it("writes OSC 0 escape sequence with the given title", () => {
		setTabTitle("● my-project: ready");
		expect(writeSpy).toHaveBeenCalledWith("\x1b]0;● my-project: ready\x07");
	});

	it("writes working status title", () => {
		setTabTitle("● my-project: working...");
		expect(writeSpy).toHaveBeenCalledWith("\x1b]0;● my-project: working...\x07");
	});

	it("writes done status title", () => {
		setTabTitle("✓ my-project: done");
		expect(writeSpy).toHaveBeenCalledWith("\x1b]0;✓ my-project: done\x07");
	});

	it("writes error status title", () => {
		setTabTitle("✗ my-project: error");
		expect(writeSpy).toHaveBeenCalledWith("\x1b]0;✗ my-project: error\x07");
	});
});

// ============================================================================
// getSessionId
// ============================================================================

describe("getSessionId", () => {
	it("returns session file path when sessionManager provides one", () => {
		const ctx = {
			sessionManager: {
				getSessionFile: () => "/path/to/session.jsonl",
			},
		} as unknown as ExtensionContext;
		expect(getSessionId(ctx)).toBe("/path/to/session.jsonl");
	});

	it("returns pi-<timestamp> when sessionManager has no file", () => {
		const ctx = {
			sessionManager: {
				getSessionFile: () => undefined,
			},
		} as unknown as ExtensionContext;
		const id = getSessionId(ctx);
		expect(id).toMatch(/^pi-\d+$/);
	});

	it("returns pi-<timestamp> when sessionManager.getSessionFile is missing", () => {
		const ctx = {
			sessionManager: {},
		} as unknown as ExtensionContext;
		const id = getSessionId(ctx);
		expect(id).toMatch(/^pi-\d+$/);
	});

	it("returns pi-<timestamp> when sessionManager throws", () => {
		const ctx = {
			sessionManager: {
				getSessionFile: vi.fn().mockImplementation(() => {
					throw new Error("boom");
				}),
			},
		} as unknown as ExtensionContext;
		const id = getSessionId(ctx);
		expect(id).toMatch(/^pi-\d+$/);
	});
});

// ============================================================================
// firePeon
// ============================================================================

describe("firePeon", () => {
	beforeEach(() => {
		vi.mocked(spawn).mockReset();
	});

	it("spawns bash with peon.sh path for .sh scripts", () => {
		const mockProc = {
			stdin: { write: vi.fn(), end: vi.fn() },
			unref: vi.fn(),
		};
		vi.mocked(spawn).mockReturnValue(mockProc as unknown as ReturnType<typeof spawn>);

		firePeon("/path/to/peon.sh", "SessionStart", "/cwd", "sess-1");

		expect(spawn).toHaveBeenCalledWith("bash", ["/path/to/peon.sh"], {
			stdio: ["pipe", "ignore", "ignore"],
		});
	});

	it("spawns powershell for .ps1 scripts", () => {
		const mockProc = {
			stdin: { write: vi.fn(), end: vi.fn() },
			unref: vi.fn(),
		};
		vi.mocked(spawn).mockReturnValue(mockProc as unknown as ReturnType<typeof spawn>);

		firePeon("/path/to/peon.ps1", "SessionStart", "/cwd", "sess-1");

		expect(spawn).toHaveBeenCalledWith("powershell", ["/path/to/peon.ps1"], {
			stdio: ["pipe", "ignore", "ignore"],
		});
	});

	it("writes JSON payload to stdin", () => {
		const mockProc = {
			stdin: { write: vi.fn(), end: vi.fn() },
			unref: vi.fn(),
		};
		vi.mocked(spawn).mockReturnValue(mockProc as unknown as ReturnType<typeof spawn>);

		firePeon("/peon.sh", "Stop", "/project", "sess-42");

		const expectedPayload = JSON.stringify({
			hook_event_name: "Stop",
			notification_type: "",
			cwd: "/project",
			session_id: "sess-42",
			permission_mode: "",
			source: "pi",
		});
		expect(mockProc.stdin.write).toHaveBeenCalledWith(expectedPayload);
		expect(mockProc.stdin.end).toHaveBeenCalled();
	});

	it("calls unref on the spawned process", () => {
		const mockProc = {
			stdin: { write: vi.fn(), end: vi.fn() },
			unref: vi.fn(),
		};
		vi.mocked(spawn).mockReturnValue(mockProc as unknown as ReturnType<typeof spawn>);

		firePeon("/peon.sh", "SessionStart", "/cwd", "sess-1");
		expect(mockProc.unref).toHaveBeenCalled();
	});

	it("handles spawn throwing silently", () => {
		vi.mocked(spawn).mockImplementation(() => {
			throw new Error("ENOENT");
		});
		expect(() => firePeon("/peon.sh", "SessionStart", "/cwd", "sess-1")).not.toThrow();
	});

	describe("category suppression", () => {
		it("skips spawn when category is disabled in config", () => {
			const config = {
				categories: { "session.start": false },
			};

			firePeon("/peon.sh", "SessionStart", "/cwd", "sess-1", config);

			expect(spawn).not.toHaveBeenCalled();
		});

		it("spawns when category is enabled in config", () => {
			const mockProc = {
				stdin: { write: vi.fn(), end: vi.fn() },
				unref: vi.fn(),
			};
			vi.mocked(spawn).mockReturnValue(mockProc as unknown as ReturnType<typeof spawn>);

			firePeon("/peon.sh", "Stop", "/cwd", "sess-1", {
				categories: { "task.complete": true },
			});

			expect(spawn).toHaveBeenCalled();
		});

		it("allows events with no category mapping (e.g. SessionEnd)", () => {
			const mockProc = {
				stdin: { write: vi.fn(), end: vi.fn() },
				unref: vi.fn(),
			};
			vi.mocked(spawn).mockReturnValue(mockProc as unknown as ReturnType<typeof spawn>);

			firePeon("/peon.sh", "SessionEnd", "/cwd", "sess-1", null);

			expect(spawn).toHaveBeenCalled();
		});

		it("defaults to true when config has no categories", () => {
			const mockProc = {
				stdin: { write: vi.fn(), end: vi.fn() },
				unref: vi.fn(),
			};
			vi.mocked(spawn).mockReturnValue(mockProc as unknown as ReturnType<typeof spawn>);

			firePeon("/peon.sh", "SessionStart", "/cwd", "sess-1", {});

			expect(spawn).toHaveBeenCalled();
		});
	});
});

// ============================================================================
// EVENT_CATEGORY
// ============================================================================

describe("EVENT_CATEGORY", () => {
	it("maps SessionStart to session.start", () => {
		expect(EVENT_CATEGORY.SessionStart).toBe("session.start");
	});

	it("maps UserPromptSubmit to task.acknowledge", () => {
		expect(EVENT_CATEGORY.UserPromptSubmit).toBe("task.acknowledge");
	});

	it("maps Stop to task.complete", () => {
		expect(EVENT_CATEGORY.Stop).toBe("task.complete");
	});

	it("maps PostToolUseFailure to task.error", () => {
		expect(EVENT_CATEGORY.PostToolUseFailure).toBe("task.error");
	});

	it("SessionEnd has no category (always fires)", () => {
		expect(EVENT_CATEGORY.SessionEnd).toBeUndefined();
	});
});

// ============================================================================
// resolveConfigPath
// ============================================================================

describe("resolveConfigPath", () => {
	beforeEach(() => {
		vi.mocked(existsSync).mockReset();
		vi.mocked(readFileSync).mockReset();
	});

	it("returns project-local config when it exists", () => {
		// existsSync called for local config path → true
		vi.mocked(existsSync).mockReturnValueOnce(true);

		const result = resolveConfigPath("/opt/peon.sh");

		expect(result).toContain(".claude/hooks/peon-ping/config.json");
	});

	it("returns ~/.openpeon/config.json when project-local config does not exist", () => {
		// local config → false, ~/.openpeon → true
		vi.mocked(existsSync).mockReturnValueOnce(false).mockReturnValueOnce(true);

		const result = resolveConfigPath("/opt/peon.sh");

		expect(result).toContain(".openpeon/config.json");
	});

	it("returns install-level config when project-local and openpeon do not exist", () => {
		// local → false, openpeon → false, install → true
		vi.mocked(existsSync)
			.mockReturnValueOnce(false)
			.mockReturnValueOnce(false)
			.mockReturnValueOnce(true);

		const result = resolveConfigPath("/opt/peon.sh");

		expect(result).toContain("/opt/config.json");
	});

	it("returns null when no config file exists", () => {
		vi.mocked(existsSync).mockReturnValue(false);

		expect(resolveConfigPath("/opt/peon.sh")).toBeNull();
	});
});

// ============================================================================
// readPeonConfig
// ============================================================================

describe("readPeonConfig", () => {
	beforeEach(() => {
		vi.mocked(existsSync).mockReset();
		vi.mocked(readFileSync).mockReset();
	});

	it("returns parsed config from the resolved path", () => {
		vi.mocked(existsSync).mockReturnValueOnce(true);
		vi.mocked(readFileSync).mockReturnValue(
			JSON.stringify({ categories: { "session.start": false } }),
		);

		const config = readPeonConfig("/opt/peon.sh");

		expect(config).toEqual({ categories: { "session.start": false } });
	});

	it("returns null when no config file is found", () => {
		vi.mocked(existsSync).mockReturnValue(false);

		expect(readPeonConfig("/opt/peon.sh")).toBeNull();
	});

	it("returns null when config file contains invalid JSON", () => {
		vi.mocked(existsSync).mockReturnValueOnce(true);
		vi.mocked(readFileSync).mockReturnValue("not json");

		expect(readPeonConfig("/opt/peon.sh")).toBeNull();
	});

	it("returns null when readFileSync throws", () => {
		vi.mocked(existsSync).mockReturnValueOnce(true);
		vi.mocked(readFileSync).mockImplementation(() => {
			throw new Error("EACCES");
		});

		expect(readPeonConfig("/opt/peon.sh")).toBeNull();
	});
});

// ============================================================================
// isCategoryEnabled
// ============================================================================

describe("isCategoryEnabled", () => {
	it("returns true when config is null", () => {
		expect(isCategoryEnabled(null, "session.start")).toBe(true);
	});

	it("returns true when config has no categories", () => {
		expect(isCategoryEnabled({}, "session.start")).toBe(true);
	});

	it("returns true when category is explicitly enabled", () => {
		expect(isCategoryEnabled(
			{ categories: { "session.start": true } },
			"session.start",
		)).toBe(true);
	});

	it("returns false when category is explicitly disabled", () => {
		expect(isCategoryEnabled(
			{ categories: { "session.start": false } },
			"session.start",
		)).toBe(false);
	});

	it("defaults task.acknowledge to false (matches peon.sh)", () => {
		expect(isCategoryEnabled(
			{ categories: {} },
			"task.acknowledge",
		)).toBe(false);
	});

	it("defaults other categories to true when missing from config", () => {
		expect(isCategoryEnabled(
			{ categories: {} },
			"session.start",
		)).toBe(true);
	});
});

// ============================================================================
// peonPingExtension (integration)
// ============================================================================

describe("peonPingExtension", () => {
	beforeEach(() => {
		vi.mocked(existsSync).mockReset();
		vi.mocked(spawn).mockReset();
		vi.mocked(execFileSync).mockReset();
	});

	it("logs a warning and returns early when peon.sh is not found", () => {
		vi.mocked(existsSync).mockReturnValue(false);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const pi = { on: vi.fn(), registerCommand: vi.fn() } as unknown as ExtensionAPI;

		peonPingExtension(pi);

		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("[pi-peon-ping] peon.sh not found"),
		);
		expect(pi.on).not.toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	describe("when peon.sh is found", () => {
		let pi: { on: ReturnType<typeof vi.fn> };
		let writeSpy: ReturnType<typeof vi.spyOn>;
		let mockProc: {
			stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
			unref: ReturnType<typeof vi.fn>;
		};

		beforeEach(() => {
			vi.mocked(existsSync).mockReturnValue(true);
			pi = { on: vi.fn(), registerCommand: vi.fn() };
			writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
			mockProc = {
				stdin: { write: vi.fn(), end: vi.fn() },
				unref: vi.fn(),
			};
			vi.mocked(spawn).mockReturnValue(mockProc as unknown as ReturnType<typeof spawn>);

			peonPingExtension(pi as unknown as ExtensionAPI);
		});

		afterEach(() => {
			writeSpy.mockRestore();
		});

		it("registers all 5 event handlers and 2 commands", () => {
			expect(pi.on).toHaveBeenCalledTimes(5);
			expect(pi.registerCommand).toHaveBeenCalledTimes(2);
		});

		it("registers session_start handler", () => {
			expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
		});

		it("registers turn_start handler", () => {
			expect(pi.on).toHaveBeenCalledWith("turn_start", expect.any(Function));
		});

		it("registers turn_end handler", () => {
			expect(pi.on).toHaveBeenCalledWith("turn_end", expect.any(Function));
		});

		it("registers tool_result handler", () => {
			expect(pi.on).toHaveBeenCalledWith("tool_result", expect.any(Function));
		});

		it("registers session_shutdown handler", () => {
			expect(pi.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
		});

		describe("session_start handler", () => {
			it("sets tab title to ready state and fires SessionStart", async () => {
				const handler = pi.on.mock.calls.find(
					(c: unknown[]) => c[0] === "session_start",
				)![1] as Function;
				const ctx = { hasUI: true, sessionManager: { getSessionFile: () => "sess-1" } };

				await handler({}, ctx);

				expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("ready"));
				expect(mockProc.stdin.write).toHaveBeenCalledWith(
					expect.stringContaining("SessionStart"),
				);
			});

			it("does not set tab title when ctx.hasUI is false", async () => {
				const handler = pi.on.mock.calls.find(
					(c: unknown[]) => c[0] === "session_start",
				)![1] as Function;
				const ctx = { hasUI: false, sessionManager: { getSessionFile: () => "sess-1" } };
				writeSpy.mockClear();

				await handler({}, ctx);

				expect(writeSpy).not.toHaveBeenCalled();
			});
		});

		describe("turn_start handler", () => {
			it("sets tab title to working state and fires UserPromptSubmit", async () => {
				const handler = pi.on.mock.calls.find(
					(c: unknown[]) => c[0] === "turn_start",
				)![1] as Function;
				const ctx = { hasUI: true, sessionManager: { getSessionFile: () => "sess-2" } };

				await handler({}, ctx);

				expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("working..."));
				expect(mockProc.stdin.write).toHaveBeenCalledWith(
					expect.stringContaining("UserPromptSubmit"),
				);
			});
		});

		describe("turn_end handler", () => {
			it("sets tab title to done state and fires Stop", async () => {
				const handler = pi.on.mock.calls.find(
					(c: unknown[]) => c[0] === "turn_end",
				)![1] as Function;
				const ctx = { hasUI: true, sessionManager: { getSessionFile: () => "sess-3" } };

				await handler({}, ctx);

				expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("done"));
				expect(mockProc.stdin.write).toHaveBeenCalledWith(
					expect.stringContaining("Stop"),
				);
			});
		});

		describe("tool_result handler", () => {
			it("sets tab title to error state and fires PostToolUseFailure when isError is true", async () => {
				const handler = pi.on.mock.calls.find(
					(c: unknown[]) => c[0] === "tool_result",
				)![1] as Function;
				const ctx = { hasUI: true, sessionManager: { getSessionFile: () => "sess-4" } };

				await handler({ isError: true }, ctx);

				expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("error"));
				expect(mockProc.stdin.write).toHaveBeenCalledWith(
					expect.stringContaining("PostToolUseFailure"),
				);
			});

			it("does nothing when isError is false", async () => {
				const handler = pi.on.mock.calls.find(
					(c: unknown[]) => c[0] === "tool_result",
				)![1] as Function;
				const ctx = { hasUI: true, sessionManager: { getSessionFile: () => "sess-5" } };
				writeSpy.mockClear();
				mockProc.stdin.write.mockClear();

				await handler({ isError: false }, ctx);

				expect(writeSpy).not.toHaveBeenCalled();
				expect(mockProc.stdin.write).not.toHaveBeenCalled();
			});
		});

		describe("session_shutdown handler", () => {
			it("fires SessionEnd", async () => {
				const handler = pi.on.mock.calls.find(
					(c: unknown[]) => c[0] === "session_shutdown",
				)![1] as Function;
				const ctx = { sessionManager: { getSessionFile: () => "sess-6" } };

				await handler({}, ctx);

				expect(mockProc.stdin.write).toHaveBeenCalledWith(
					expect.stringContaining("SessionEnd"),
				);
			});

			it("does not set tab title", async () => {
				const handler = pi.on.mock.calls.find(
					(c: unknown[]) => c[0] === "session_shutdown",
				)![1] as Function;
				const ctx = { sessionManager: { getSessionFile: () => "sess-7" } };
				writeSpy.mockClear();

				await handler({}, ctx);

				expect(writeSpy).not.toHaveBeenCalled();
			});
		});
	});
});

// ============================================================================
// findPeonCli
// ============================================================================

describe("findPeonCli", () => {
	beforeEach(() => {
		vi.mocked(existsSync).mockReset();
		vi.mocked(execFileSync).mockReset();
		delete process.env.PEON_SH;
	});

	it("returns peonPath when peon.sh is found", () => {
		vi.mocked(existsSync).mockReturnValue(true);
		const cli = findPeonCli();
		expect(cli).toBeTruthy();
	});

	it("returns null when peon.sh is not found", () => {
		vi.mocked(existsSync).mockReturnValue(false);
		expect(findPeonCli()).toBeNull();
	});
});

// ============================================================================
// execPeonCli
// ============================================================================

describe("execPeonCli", () => {
	let closeHandler: ((code: number | null) => void) | undefined;
	let errorHandler: (() => void) | undefined;

	beforeEach(() => {
		vi.mocked(spawn).mockReset();
		closeHandler = undefined;
		errorHandler = undefined;
	});

	function makeMockProc(stdoutText: string) {
		return {
			stdout: {
				on: vi.fn((_event: string, cb: Function) => {
					setTimeout(() => cb(Buffer.from(stdoutText)), 0);
				}),
			},
			stderr: { on: vi.fn() },
			on: vi.fn((_event: string, cb: Function) => {
				if (_event === "close") closeHandler = cb as typeof closeHandler;
				if (_event === "error") errorHandler = cb as typeof errorHandler;
			}),
		};
	}

	it("spawns the CLI with the given args", async () => {
		const mockProc = makeMockProc("ok");
		vi.mocked(spawn).mockReturnValue(mockProc as unknown as ReturnType<typeof spawn>);

		const promise = execPeonCli("/path/to/peon.sh", ["toggle"]);
		setTimeout(() => closeHandler?.(0), 1);
		const result = await promise;

		expect(spawn).toHaveBeenCalledWith("bash", ["/path/to/peon.sh", "toggle"], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		expect(result.stdout).toBe("ok");
		expect(result.exitCode).toBe(0);
	});

	it("resolves on error event", async () => {
		const mockProc = makeMockProc("");
		vi.mocked(spawn).mockReturnValue(mockProc as unknown as ReturnType<typeof spawn>);

		const promise = execPeonCli("/path/to/peon.sh", ["toggle"]);
		setTimeout(() => errorHandler?.(), 1);
		const result = await promise;

		expect(result.stdout).toBe("");
		expect(result.exitCode).toBe(-1);
	});
});

