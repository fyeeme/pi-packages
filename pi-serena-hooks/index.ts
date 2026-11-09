// Bridges pi extension events to serena-hooks, Serena's Claude Code-compatible hook CLI.
// activate: prompt the agent once per session to activate the project in Serena.
// remind: block a grep/read tool call when serena-hooks detects a drift streak.
// cleanup: delete Serena's per-session hook state when the session ends.
// Requires the Serena MCP server (name "serena") for the reminders to be actionable.

import { spawn } from "node:child_process";
import { isToolCallEventType, type ExtensionAPI, type ToolCallEvent } from "@earendil-works/pi-coding-agent";

// pi's tool names (bash, read, grep, mcp__serena__*) match what serena-hooks expects
// in its claude-code client mode; no other client value fits pi.
const CLIENT_ARGS = ["--client=claude-code"];
const HOOK_TIMEOUT_MS = 5000;
const SERENA_TOOL_PREFIX = "mcp__serena__";

// Programs serena counts as shell content search or shell file reads. Other bash
// commands are neutral to its counters, so calls without these tokens skip the spawn.
const SHELL_SEARCH_OR_READ =
	/\b(grep|egrep|fgrep|rg|ag|ack|ugrep|ug|cat|head|tail|sed|awk|less|more|bat|get-content|gc)\b/;

interface HookDecision {
	permissionDecision?: string;
	permissionDecisionReason?: string;
	additionalContext?: string;
}

let hookAvailable = true; // false once serena-hooks is found missing; the extension then stays silent
let sessionHookId: string | null = null;
let activateContext: string | null = null;
let activateInjected = false;

/** Run one serena-hooks command with a JSON stdin payload. Resolves to "" on any failure (hooks fail open). */
function runHook(command: string, payload: object): Promise<string> {
	return new Promise((resolve) => {
		if (!hookAvailable) return resolve("");
		const child = spawn("serena-hooks", [command, ...CLIENT_ARGS], { stdio: ["pipe", "pipe", "ignore"] });
		let out = "";
		let done = false;
		const finish = (value: string) => {
			if (!done) {
				done = true;
				clearTimeout(timer);
				resolve(value);
			}
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish("");
		}, HOOK_TIMEOUT_MS);
		child.stdout.on("data", (chunk: Buffer) => (out += chunk));
		child.on("close", () => finish(out.trim()));
		child.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") hookAvailable = false;
			finish("");
		});
		child.stdin.on("error", () => {}); // EPIPE when the hook exits before reading stdin; close settles the promise
		child.stdin.end(JSON.stringify(payload));
	});
}

/** Parse serena-hooks stdout. Trust boundary: output of an external CLI, parsed defensively. */
export function parseDecision(out: string): HookDecision | undefined {
	if (!out) return undefined;
	try {
		return (JSON.parse(out) as { hookSpecificOutput?: HookDecision }).hookSpecificOutput;
	} catch {
		return undefined;
	}
}

/** Build the remind payload fields for a tool call, or undefined when serena cannot count this call. */
export function remindPayload(event: ToolCallEvent): Record<string, unknown> | undefined {
	if (isToolCallEventType("bash", event)) {
		if (!SHELL_SEARCH_OR_READ.test(event.input.command)) return undefined;
		return { tool_name: event.toolName, tool_input: event.input };
	}
	if (isToolCallEventType("read", event)) {
		// serena reads tool_input.file_path (not path) to decide whether the target is a code file
		return { tool_name: "read", tool_input: { ...event.input, file_path: event.input.path } };
	}
	if (isToolCallEventType("grep", event)) {
		return { tool_name: "grep", tool_input: event.input };
	}
	if (event.toolName.startsWith(SERENA_TOOL_PREFIX)) {
		// a Serena symbolic tool call resets the drift counters inside serena-hooks
		return { tool_name: event.toolName, tool_input: event.input };
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		activateInjected = false;
		sessionHookId = ctx.sessionManager.getSessionId();
		const decision = parseDecision(await runHook("activate", { session_id: sessionHookId }));
		activateContext = decision?.additionalContext ?? null;
		if (!hookAvailable && ctx.hasUI) {
			ctx.ui.notify("serena-hooks not found; Serena reminder hooks disabled", "warning");
		}
	});

	// compaction folds the injected activate message away; re-arm so the next run carries it again
	pi.on("session_compact", async () => {
		activateInjected = false;
	});

	pi.on("before_agent_start", async () => {
		if (activateInjected || !activateContext) return;
		activateInjected = true;
		return { message: { customType: "serena-activate", content: activateContext, display: false } };
	});

	pi.on("tool_call", async (event) => {
		if (!sessionHookId || !hookAvailable) return;
		const payload = remindPayload(event);
		if (!payload) return;
		const decision = parseDecision(
			await runHook("remind", { session_id: sessionHookId, ...payload }),
		);
		if (decision?.permissionDecision !== "deny") return;
		const reason = [decision.permissionDecisionReason, decision.additionalContext].filter(Boolean).join("\n\n");
		return { block: true, reason: reason || "Serena reminder hook blocked this call" };
	});

	pi.on("session_shutdown", async () => {
		if (sessionHookId) await runHook("cleanup", { session_id: sessionHookId });
	});
}
