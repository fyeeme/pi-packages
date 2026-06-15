/**
 * pi-hooks
 *
 * Claude Code-compatible hooks runner for pi.
 *
 * Reads `.pi/hooks.json` (or `PI_HOOKS_CONFIG` env) and maps:
 *   SessionStart  → before_agent_start (first turn)
 *   PreToolUse    → tool_call
 *   Stop          → session_shutdown
 *
 * All additionalContext—from both SessionStart and PreToolUse—is injected
 * into the last user message via the context event. This guarantees the LLM
 * sees and acts on the context without extra turns, fake user messages, or
 * system prompt passivity.
 *
 * Sequence guarantee:
 *   emitBeforeAgentStart() is awaited by agent-session.ts before
 *   _runAgentPrompt() starts, so before_agent_start always completes
 *   before the first context event fires. No race condition.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ============================================================================
// Config schema
// ============================================================================

interface HookEntry {
	type: "command";
	command: string;
}

interface HookGroup {
	matcher: string;
	hooks: HookEntry[];
}

interface HooksConfig {
	hooks: {
		SessionStart?: HookGroup[];
		PreToolUse?: HookGroup[];
		Stop?: HookGroup[];
	};
}

interface HookOutput {
	hookSpecificOutput?: {
		additionalContext?: string;
	};
}

// ============================================================================
// Glob matching
// ============================================================================

export function globMatch(pattern: string, value: string): boolean {
	if (pattern === "") return true;
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	const regexStr = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
	return new RegExp(`^${regexStr}$`).test(value);
}

// ============================================================================
// Config loader - cached per session via ??=
// ============================================================================

export function loadConfig(cwd: string): HooksConfig | null {
	const envPath = process.env.PI_HOOKS_CONFIG;
	const candidates = envPath
		? [envPath]
		: [join(cwd, ".pi", "hooks.json"), join(process.env.HOME ?? "", ".pi", "hooks.json")];

	for (const p of candidates) {
		if (!existsSync(p)) continue;
		try {
			return JSON.parse(readFileSync(p, "utf-8")) as HooksConfig;
		} catch (err) {
			console.error(`[hooks] failed to parse ${p}: ${err}`);
		}
	}
	return null;
}

// ============================================================================
// Session ID
// ============================================================================

function getSessionId(ctx: ExtensionContext): string {
	try {
		const sm = ctx.sessionManager as { getSessionFile?: () => string | undefined };
		const file = sm.getSessionFile?.();
		if (file) return file;
	} catch { /* ignore */ }
	return `${ctx.cwd}:${Date.now()}`;
}

// ============================================================================
// Command runner - pipes JSON to stdin, captures stdout JSON
// ============================================================================

async function runCommand(command: string, cwd: string, stdinJson: unknown): Promise<HookOutput | null> {
	return new Promise((resolve) => {
		const proc = spawn(command, [], {
			shell: true,
			cwd,
			stdio: ["pipe", "pipe", "inherit"],
		});

		let stdout = "";
		proc.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});

		const timer = setTimeout(() => proc.kill("SIGTERM"), 10_000);

		proc.on("close", (code) => {
			clearTimeout(timer);
			if (code !== 0) console.error(`[hooks] exited ${code}: ${command}`);
			try {
				const trimmed = stdout.trim();
				resolve(trimmed ? (JSON.parse(trimmed) as HookOutput) : null);
			} catch {
				resolve(null);
			}
		});

		proc.on("error", (err) => {
			clearTimeout(timer);
			console.error(`[hooks] spawn error: ${command}: ${err}`);
			resolve(null);
		});

		try {
			proc.stdin?.write(JSON.stringify(stdinJson));
			proc.stdin?.end();
		} catch { /* already exited */ }
	});
}

// ============================================================================
// Run matching hook groups, return collected additionalContext strings
// ============================================================================

async function runGroups(
	groups: HookGroup[] | undefined,
	toolName: string,
	cwd: string,
	stdinJson: unknown,
): Promise<string[]> {
	const contexts: string[] = [];
	if (!groups) return contexts;
	for (const group of groups) {
		if (!globMatch(group.matcher, toolName)) continue;
		for (const hook of group.hooks) {
			if (hook.type !== "command") continue;
			const out = await runCommand(hook.command, cwd, stdinJson);
			const ctx = out?.hookSpecificOutput?.additionalContext;
			if (ctx) contexts.push(ctx);
		}
	}
	return contexts;
}

// ============================================================================
// Extension
// ============================================================================

export default function (pi: ExtensionAPI): void {
	let config: HooksConfig | null | undefined;

	// SessionStart additionalContext waiting to be injected on the first LLM call.
	// Set by before_agent_start (which is awaited before the agent loop starts),
	// consumed once by the context handler.
	let activateContext: string | null = null;
	let activated = false;

	// PreToolUse additionalContext queued by tool_call, injected before each LLM call.
	const pendingContexts: string[] = [];

	// -------------------------------------------------------------------------
	// before_agent_start: SessionStart hooks (first turn only).
	//
	// Runs the hook and stores additionalContext for injection. Does NOT return
	// a message or modify the system prompt—injection happens in context so all
	// LLM message modification is in one place and the activate context is
	// treated identically to remind context by the LLM.
	//
	// Sequencing: agent-session.ts awaits emitBeforeAgentStart() before calling
	// _runAgentPrompt(), so this handler always completes before context fires.
	// -------------------------------------------------------------------------
	pi.on("before_agent_start", async (_event, ctx) => {
		config ??= loadConfig(ctx.cwd);
		if (!config || activated) return;
		activated = true;

		const stdin = {
			type: "session_start",
			session_id: getSessionId(ctx),
			transcript_path: getSessionId(ctx),
		};
		const contexts = await runGroups(config.hooks.SessionStart, "", ctx.cwd, stdin);
		if (contexts.length > 0) {
			activateContext = contexts.join("\n\n");
		}
	});

	// -------------------------------------------------------------------------
	// context: inject all pending contexts before each LLM call.
	//
	// Combines activate (SessionStart) and remind (PreToolUse) contexts.
	// Appends to the last user message's content array—never adds a new message—
	// so there are no consecutive-user-message issues and no extra turns.
	// The injected text is invisible to the display layer (UI shows original).
	// -------------------------------------------------------------------------
	pi.on("context", (event) => {
		const toInject: string[] = [];

		if (activateContext !== null) {
			toInject.push(activateContext);
			activateContext = null;
		}

		if (pendingContexts.length > 0) {
			toInject.push(...pendingContexts.splice(0));
		}

		if (toInject.length === 0) return;

		const text = toInject.join("\n\n");
		const messages = [...event.messages];
		const lastUserIdx = messages.findLastIndex((m) => (m as { role: string }).role === "user");

		if (lastUserIdx >= 0) {
			// Append to the last user message's content array. pi-hooks operates on
			// messages structurally (any role:"user" message whose content is an
			// array); it does not depend on a specific message variant type, so we
			// bridge through `unknown` rather than asserting an incompatible shape.
			const last = messages[lastUserIdx] as unknown as {
				role: string;
				content: unknown[];
			};
			if (Array.isArray(last.content)) {
				messages[lastUserIdx] = {
					...last,
					content: [...last.content, { type: "text" as const, text }],
				} as unknown as (typeof messages)[number];
			}
		} else {
			(messages as unknown[]).push({ role: "user", content: [{ type: "text" as const, text }] });
		}

		return { messages: messages as typeof event.messages };
	});

	// -------------------------------------------------------------------------
	// tool_call: PreToolUse hooks.
	// Empty-matcher groups (remind) run for every tool with the real tool_name.
	// Non-empty-matcher groups (auto-approve) run only for matching tools.
	// -------------------------------------------------------------------------
	pi.on("tool_call", async (event, ctx) => {
		config ??= loadConfig(ctx.cwd);
		if (!config?.hooks.PreToolUse) return;

		const sessionId = getSessionId(ctx);
		const stdin = {
			type: "pre_tool_use",
			session_id: sessionId,
			tool_name: event.toolName,
			tool_input: event.input ?? {},
		};

		// Empty-matcher groups: remind (runs for every tool).
		const emptyGroups = config.hooks.PreToolUse.filter((g) => g.matcher === "");
		const remindContexts = await runGroups(emptyGroups, event.toolName, ctx.cwd, stdin);
		if (remindContexts.length > 0) pendingContexts.push(...remindContexts);

		// Non-empty-matcher groups: auto-approve etc. (filtered by toolName).
		const specificGroups = config.hooks.PreToolUse.filter((g) => g.matcher !== "");
		await runGroups(specificGroups, event.toolName, ctx.cwd, stdin);
	});

	// -------------------------------------------------------------------------
	// session_shutdown: Stop hooks.
	// -------------------------------------------------------------------------
	pi.on("session_shutdown", async (_event, ctx) => {
		config ??= loadConfig(ctx.cwd);
		if (!config) return;
		const stdin = { type: "stop", session_id: getSessionId(ctx) };
		await runGroups(config.hooks.Stop, "", ctx.cwd, stdin);
	});
}
