import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import defaultExport, { parseDecision, remindPayload } from "../index.ts";

// ---------------------------------------------------------------------------
// parseDecision (trust boundary: external CLI stdout)
// ---------------------------------------------------------------------------

describe("parseDecision", () => {
	it("returns undefined for empty stdout", () => {
		expect(parseDecision("")).toBeUndefined();
	});

	it("returns undefined for non-JSON stdout", () => {
		expect(parseDecision("Traceback (most recent call last): ...")).toBeUndefined();
	});

	it("extracts hookSpecificOutput", () => {
		const out = JSON.stringify({
			hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "no", additionalContext: "ctx" },
		});
		expect(parseDecision(out)).toEqual({ permissionDecision: "deny", permissionDecisionReason: "no", additionalContext: "ctx" });
	});

	it("returns undefined when JSON has no hookSpecificOutput", () => {
		expect(parseDecision(JSON.stringify({ foo: 1 }))).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// remindPayload (which tool calls serena can count)
// ---------------------------------------------------------------------------

function toolCallEvent(toolName: string, input: object): ToolCallEvent {
	return { toolName, input } as unknown as ToolCallEvent;
}

describe("remindPayload", () => {
	it("counts bash commands that search or read content", () => {
		const input = { command: "rg -n pattern src/" };
		expect(remindPayload(toolCallEvent("bash", input))).toEqual({ tool_name: "bash", tool_input: input });
		const cat = { command: "cat package.json" };
		expect(remindPayload(toolCallEvent("bash", cat))).toEqual({ tool_name: "bash", tool_input: cat });
	});

	it("skips bash commands neutral to serena's counters (no spawn)", () => {
		expect(remindPayload(toolCallEvent("bash", { command: "ls -la" }))).toBeUndefined();
		expect(remindPayload(toolCallEvent("bash", { command: "npm run build" }))).toBeUndefined();
	});

	it("maps read's path to the file_path serena reads", () => {
		expect(remindPayload(toolCallEvent("read", { path: "src/a.ts" }))).toEqual({
			tool_name: "read",
			tool_input: { path: "src/a.ts", file_path: "src/a.ts" },
		});
	});

	it("passes grep through as-is", () => {
		const input = { pattern: "foo", path: "." };
		expect(remindPayload(toolCallEvent("grep", input))).toEqual({ tool_name: "grep", tool_input: input });
	});

	it("passes serena MCP tool calls through (they reset the drift counters)", () => {
		const input = { name_path: "Foo" };
		expect(remindPayload(toolCallEvent("mcp__serena__find_symbol", input))).toEqual({
			tool_name: "mcp__serena__find_symbol",
			tool_input: input,
		});
	});

	it("returns undefined for tools serena does not count", () => {
		expect(remindPayload(toolCallEvent("write", { path: "a.ts" }))).toBeUndefined();
		expect(remindPayload(toolCallEvent("edit", { path: "a.ts" }))).toBeUndefined();
		expect(remindPayload(toolCallEvent("mcp__other__tool", {}))).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Extension wiring, driven through a fake serena-hooks binary on PATH.
// The module keeps state (sessionHookId, activateContext, hookAvailable) across
// handlers, so the wiring cases below run in one describe, in order; the
// ENOENT case (which permanently disables the hook) runs last.
// ---------------------------------------------------------------------------

function fakeHost() {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	} as unknown as ExtensionAPI;
	return { pi, handlers };
}

const FAKE_HOOK = `#!/usr/bin/env node
// fake serena-hooks: subcommand is argv[2]
let s = "";
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => {
	const cmd = process.argv[2];
	if (cmd === "activate") {
		console.log(JSON.stringify({ hookSpecificOutput: { additionalContext: "ACTIVATE-CONTEXT" } }));
	} else if (cmd === "remind") {
		console.log(JSON.stringify({
			hookSpecificOutput: {
				permissionDecision: "deny",
				permissionDecisionReason: "DENIED-BY-SERENA",
				additionalContext: "USE-SERENA-TOOLS",
			},
		}));
	} else if (cmd === "cleanup") {
		require("node:fs").writeFileSync(process.env.FAKE_CLEANUP_MARKER, s);
		console.log("{}");
	}
});
`;

describe("serena-hooks extension wiring", () => {
	let workDir: string;
	let binDir: string;
	let emptyDir: string;
	let originalPath: string | undefined;
	let cleanupMarker: string;
	let notified: string[];

	beforeEach(async () => {
		workDir = await mkdtemp(join(tmpdir(), "pi-serena-hooks-"));
		binDir = join(workDir, "bin");
		emptyDir = join(workDir, "empty");
		await mkdir(binDir);
		await mkdir(emptyDir);
		await writeFile(join(binDir, "serena-hooks"), FAKE_HOOK, { encoding: "utf8" });
		await chmod(join(binDir, "serena-hooks"), 0o755);
		originalPath = process.env.PATH;
		process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
		cleanupMarker = join(workDir, "cleanup-ran");
		process.env.FAKE_CLEANUP_MARKER = cleanupMarker;
		notified = [];
	});

	afterEach(async () => {
		process.env.PATH = originalPath;
		delete process.env.FAKE_CLEANUP_MARKER;
		await rm(workDir, { recursive: true, force: true });
	});

	function makeCtx() {
		return {
			sessionManager: { getSessionId: () => "test-session-id" },
			hasUI: true,
			ui: { notify: (msg: string) => notified.push(msg) },
		};
	}

	it("session_start + before_agent_start: injects the activate context as a hidden message, once", async () => {
		const { pi, handlers } = fakeHost();
		defaultExport(pi);
		const start = (handlers.get("session_start") ?? [])[0]!;
		const before = (handlers.get("before_agent_start") ?? [])[0]!;

		await start({ type: "session_start", reason: "startup" }, makeCtx());

		const first = await before({ type: "before_agent_start", messageType: "user", prompt: "hi" }, makeCtx());
		expect(first).toEqual({
			message: { customType: "serena-activate", content: "ACTIVATE-CONTEXT", display: false },
		});

		// second run in the same session: already injected, no message
		const second = await before({ type: "before_agent_start", messageType: "user", prompt: "again" }, makeCtx());
		expect(second).toBeUndefined();
	});

	it("session_compact re-arms the activate injection", async () => {
		const { pi, handlers } = fakeHost();
		defaultExport(pi);
		const start = (handlers.get("session_start") ?? [])[0]!;
		const before = (handlers.get("before_agent_start") ?? [])[0]!;
		const compact = (handlers.get("session_compact") ?? [])[0]!;

		await start({ type: "session_start", reason: "startup" }, makeCtx());
		await before({ type: "before_agent_start", messageType: "user", prompt: "hi" }, makeCtx());
		await compact({ type: "session_compact", reason: "manual" }, makeCtx());

		const again = await before({ type: "before_agent_start", messageType: "user", prompt: "post-compact" }, makeCtx());
		expect(again).toEqual({
			message: { customType: "serena-activate", content: "ACTIVATE-CONTEXT", display: false },
		});
	});

	it("tool_call: remind deny blocks with the hook's reason and context", async () => {
		const { pi, handlers } = fakeHost();
		defaultExport(pi);
		await (handlers.get("session_start") ?? [])[0]!({ type: "session_start", reason: "startup" }, makeCtx());

		const toolCall = (handlers.get("tool_call") ?? [])[0]!;
		const result = await toolCall({ type: "tool_call", toolName: "read", input: { path: "a.ts" } }, makeCtx());
		expect(result).toEqual({ block: true, reason: "DENIED-BY-SERENA\n\nUSE-SERENA-TOOLS" });
	});

	it("tool_call: bash without a search/read program skips the hook entirely", async () => {
		const { pi, handlers } = fakeHost();
		defaultExport(pi);
		await (handlers.get("session_start") ?? [])[0]!({ type: "session_start", reason: "startup" }, makeCtx());

		const toolCall = (handlers.get("tool_call") ?? [])[0]!;
		// the fake remind always denies; a miss here means the spawn never happened
		const result = await toolCall({ type: "tool_call", toolName: "bash", input: { command: "ls -la" } }, makeCtx());
		expect(result).toBeUndefined();
	});

	it("session_shutdown: runs cleanup with the session id on stdin", async () => {
		const { pi, handlers } = fakeHost();
		defaultExport(pi);
		await (handlers.get("session_start") ?? [])[0]!({ type: "session_start", reason: "startup" }, makeCtx());

		await (handlers.get("session_shutdown") ?? [])[0]!({ type: "session_shutdown", reason: "quit" }, makeCtx());
		expect(existsSync(cleanupMarker)).toBe(true);
		const stdin = JSON.parse(readFileSync(cleanupMarker, "utf8"));
		expect(stdin).toEqual({ session_id: "test-session-id" });
	});

	// LAST: ENOENT permanently sets hookAvailable=false for this module instance.
	it("missing serena-hooks binary: warns once via the UI and stays silent afterwards", async () => {
		process.env.PATH = emptyDir; // no serena-hooks here
		const { pi, handlers } = fakeHost();
		defaultExport(pi);

		await (handlers.get("session_start") ?? [])[0]!({ type: "session_start", reason: "startup" }, makeCtx());
		expect(notified).toEqual(["serena-hooks not found; Serena reminder hooks disabled"]);

		// later events skip the spawn: no block, no crash
		const toolCall = (handlers.get("tool_call") ?? [])[0]!;
		const result = await toolCall({ type: "tool_call", toolName: "grep", input: { pattern: "x" } }, makeCtx());
		expect(result).toBeUndefined();
	});
});
