/**
 * pi-hooks
 *
 * Claude Code-compatible hooks runner for pi.
 *
 * Reads `.pi/hooks.json` (or `PI_HOOKS_CONFIG` env) and maps:
 *   SessionStart  → session_start        (source = mapped reason)
 *   PreToolUse    → tool_call            (can block via {block:true})
 *   Stop          → session_shutdown     (cleanup only; cannot block exit)
 *
 * All additionalContext — from both SessionStart and PreToolUse — is injected
 * into the last user message via the context event, so the LLM sees and acts on
 * it without extra turns, fake user messages, or system-prompt passivity.
 *
 * Compatibility notes (vs Claude Code hooks protocol):
 *   - matchers are **regex** (CC semantics): "" / "*" match all; `Edit|Write`
 *     alternation and `Notebook.*` work. Invalid regex falls back to literal.
 *   - PreToolUse `permissionDecision: "deny"` and exit code 2 block the tool
 *     via pi's `{ block: true, reason, terminate: true }`. The tool is always
 *     blocked; `terminate` additionally tries to skip the automatic follow-up
 *     model call, but only takes effect when this is the only/last call in an
 *     all-terminating batch (pi >= 0.84.1, #7715). In a multi-tool batch the
 *     block still applies but the agent may continue. ("allow"/"ask" are
 *     no-ops; pi applies its own permission flow.)
 *   - Stop `decision: "block"` is NOT honored — pi's session_shutdown is
 *     notification-only and cannot prevent exit.
 *   - per-hook `timeout` (seconds) is honored; default 60s.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { CONFIG_DIR_NAME, formatSize } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ============================================================================
// Config schema + validation
// ============================================================================

interface HookEntry {
	type: "command";
	command: string;
	/** Per-hook timeout in seconds (Claude Code compatible). Default 60. */
	timeout?: number;
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

const HOOK_EVENTS = ["SessionStart", "PreToolUse", "Stop"] as const;
type HookEventName = (typeof HOOK_EVENTS)[number];

/**
 * Validate and normalize a parsed config. Returns a safe HooksConfig (missing
 * events treated as empty) or null if the top-level shape is wrong. Never
 * throws — a malformed file degrades to "no hooks" rather than crashing the
 * awaited handler that dereferences `config.hooks.*`.
 */
export function normalizeConfig(raw: unknown): HooksConfig | null {
	if (typeof raw !== "object" || raw === null) return null;
	const root = raw as Record<string, unknown>;
	const hooksField = root.hooks;
	// `{}` or `{"hooks": null}` → no hooks configured (not an error).
	if (hooksField === undefined || hooksField === null) return { hooks: {} };
	if (typeof hooksField !== "object" || Array.isArray(hooksField)) return null;

	const out: HooksConfig = { hooks: {} };
	const hooks = hooksField as Record<string, unknown>;
	for (const evt of HOOK_EVENTS) {
		const v = hooks[evt];
		if (!Array.isArray(v)) continue; // missing or non-array event → ignored
		const groups: HookGroup[] = [];
		for (const g of v) {
			if (!g || typeof g !== "object") continue;
			const gr = g as Record<string, unknown>;
			// Validate inner shape so a malformed group/entry can't reach matchTool
			// (e.g. a missing matcher must not silently match the literal
			// "undefined") or produce a NaN timeout.
			if (typeof gr.matcher !== "string") continue;
			const ghooks = gr.hooks;
			if (!Array.isArray(ghooks)) continue;
			const entries: HookEntry[] = [];
			for (const h of ghooks) {
				if (!h || typeof h !== "object") continue;
				const he = h as Record<string, unknown>;
				if (he.type !== "command" || typeof he.command !== "string") continue;
				const timeout =
					typeof he.timeout === "number" && he.timeout > 0 ? he.timeout : undefined;
				entries.push({ type: "command", command: he.command, ...(timeout === undefined ? {} : { timeout }) });
			}
			if (entries.length > 0) groups.push({ matcher: gr.matcher, hooks: entries });
		}
		if (groups.length > 0) out.hooks[evt] = groups;
	}
	return out;
}

// ============================================================================
// Matcher (Claude Code regex semantics)
// ============================================================================

/**
 * Claude Code matcher: "" or "*" match all; otherwise the pattern is a regex
 * tested against the full value (anchored). Invalid regex falls back to a
 * literal exact match so a bad pattern never throws inside an event handler.
 */
/** Compiled matcher cache (avoid recompiling per event); null = invalid regex. */
const matcherCache = new Map<string, RegExp | null>();

export function matchTool(pattern: string, value: string): boolean {
	if (pattern === "" || pattern === "*") return true;
	let regex = matcherCache.get(pattern);
	if (regex === undefined) {
		try {
			regex = new RegExp(`^(?:${pattern})$`);
		} catch {
			regex = null; // invalid regex matches nothing (CC has no literal fallback)
			console.warn(`[hooks] invalid matcher regex "${pattern}" — will never match`);
		}
		matcherCache.set(pattern, regex);
	}
	return regex !== null && regex.test(value);
}

// ============================================================================
// Config loader (failure is cached, not re-read every event)
// ============================================================================

export function loadConfig(cwd: string): HooksConfig | null {
	const envPath = process.env.PI_HOOKS_CONFIG;
	// os.homedir() is cross-platform (HOME on POSIX, USERPROFILE on Windows).
	const candidates = envPath
		? [envPath]
		: [join(cwd, CONFIG_DIR_NAME, "hooks.json"), join(homedir(), CONFIG_DIR_NAME, "hooks.json")];

	for (const p of candidates) {
		if (!existsSync(p)) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(p, "utf-8"));
		} catch (err) {
			console.error(`[hooks] failed to parse ${p}: ${err}`);
			continue;
		}
		const cfg = normalizeConfig(parsed);
		if (cfg) return cfg;
		// Valid JSON but wrong shape (e.g. copied from CC with events as objects):
		// warn and fall through to the next candidate instead of silently
		// returning null while a usable home config exists.
		console.error(`[hooks] invalid hooks shape in ${p} (expected { "hooks": { ... } })`);
	}
	return null;
}

// ============================================================================
// Session id / transcript path (CC-compatible field semantics)
// ============================================================================

function getSessionId(ctx: ExtensionContext): string {
	// Platform-stable UUID (session-manager.getSessionId()). Never falls back to
	// a time-based value, so session_id is stable across events in one session.
	return ctx.sessionManager.getSessionId();
}

function getTranscriptPath(ctx: ExtensionContext): string {
	// The conversation JSONL file path (CC transcript_path semantics).
	return ctx.sessionManager.getSessionFile() ?? "";
}

function buildStdin(
	hookEventName: HookEventName,
	ctx: ExtensionContext,
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		session_id: getSessionId(ctx),
		transcript_path: getTranscriptPath(ctx),
		cwd: ctx.cwd,
		permission_mode: "default",
		hook_event_name: hookEventName,
		...extra,
	};
}

// ============================================================================
// Hook output parsing (control flow + context)
// ============================================================================

interface HookOutput {
	hookSpecificOutput?: {
		additionalContext?: string;
		permissionDecision?: "allow" | "deny" | "ask";
		permissionDecisionReason?: string;
	};
	reason?: string;
}

export interface HookResult {
	/** additionalContext to inject, if any. */
	context: string | null;
	/** Block reason (shown to the LLM), or null when not blocking. */
	block: string | null;
}

function emptyResult(): HookResult {
	return { context: null, block: null };
}

/**
 * Parse a hook's stdout + exit code into a normalized result. Handles the two
 * Claude Code blocking signals: exit code 2 and `permissionDecision: "deny"`.
 */
export function parseHookOutput(command: string, stdout: string, exitCode: number | null): HookResult {
	let output: HookOutput | null = null;
	if (stdout) {
		try {
			output = JSON.parse(stdout) as HookOutput;
		} catch {
			// Non-JSON stdout (e.g. a stray `echo`/`console.log`) is a common
			// misconfiguration — surface it instead of failing silently.
			console.error(`[hooks] non-JSON stdout from ${command}: ${stdout.slice(0, 200)}`);
		}
	}

	const context = output?.hookSpecificOutput?.additionalContext ?? null;
	const deny = exitCode === 2 || output?.hookSpecificOutput?.permissionDecision === "deny";
	const reason =
		output?.hookSpecificOutput?.permissionDecisionReason ?? output?.reason ?? "blocked by hook";
	return { context, block: deny ? reason : null };
}

// ============================================================================
// Command runner
// ============================================================================

const DEFAULT_TIMEOUT_SECONDS = 60;
const MAX_STDOUT_BYTES = 10 * 1024 * 1024;
const KILL_GRACE_MS = 5_000;

async function runCommand(
	command: string,
	cwd: string,
	stdinText: string,
	timeoutMs: number,
): Promise<HookResult> {
	return new Promise((resolve) => {
		const isWin = process.platform === "win32";
		const proc = spawn(command, [], {
			shell: true,
			cwd,
			// detached (non-Windows) → own process group so we can kill the tree.
			detached: !isWin,
			stdio: ["pipe", "pipe", "inherit"],
		});

		const chunks: Buffer[] = [];
		let bytes = 0;
		let killed = false;
		let settled = false;
		let sigkillTimer: NodeJS.Timeout | undefined;

		const finish = (result: HookResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(sigtermTimer);
			clearTimeout(sigkillTimer);
			resolve(result);
		};

		const killTree = (sig: "SIGTERM" | "SIGKILL") => {
			try {
				if (!isWin && proc.pid) process.kill(-proc.pid, sig);
				else proc.kill(sig);
			} catch {
				/* already dead */
			}
		};

		// Swallow stream errors (e.g. EPIPE when a hook ignores stdin) so they
		// never become an uncaughtException that crashes the whole pi process.
		const swallow = () => {};
		proc.stdin?.on("error", swallow);
		proc.stdout?.on("error", swallow);

		// Escalating kill shared by the stdout-over-limit and timeout paths:
		// SIGTERM, then SIGKILL after a grace window, then force-resolve. The
		// force-resolve is essential — `close` may never fire if a grandchild
		// inherited the stdout pipe and outlives the killed shell, which would
		// otherwise leave this promise (and the awaiting handler) pending
		// forever. Sets `killed` so any buffered output is discarded rather than
		// parsed and applied.
		const killAndFinish = () => {
			if (settled) return;
			killed = true;
			clearTimeout(sigtermTimer);
			killTree("SIGTERM");
			sigkillTimer = setTimeout(() => {
				killTree("SIGKILL");
				finish(emptyResult());
			}, KILL_GRACE_MS);
		};

		// Accumulate raw buffers; decode once at the end to avoid splitting
		// multi-byte UTF-8 characters across chunks (silent mojibake).
		proc.stdout?.on("data", (chunk: Buffer) => {
			if (killed) return;
			bytes += chunk.length;
			if (bytes > MAX_STDOUT_BYTES) {
				console.error(`[hooks] stdout exceeded ${formatSize(MAX_STDOUT_BYTES)}, killing: ${command}`);
				killAndFinish();
				return;
			}
			chunks.push(chunk);
		});

		const sigtermTimer = setTimeout(killAndFinish, timeoutMs);

		proc.on("close", (code) => {
			if (killed) {
				finish(emptyResult());
				return;
			}
			// Exit code 2 is the documented PreToolUse "deny" signal, not an error —
			// parseHookOutput honors it as a block, so don't log it as a failure.
			if (code !== 0 && code !== 2 && code !== null) console.error(`[hooks] exited ${code}: ${command}`);
			const stdout = Buffer.concat(chunks).toString("utf8").trim();
			finish(parseHookOutput(command, stdout, code));
		});

		proc.on("error", (err) => {
			console.error(`[hooks] spawn error: ${command}: ${err}`);
			finish(emptyResult());
		});

		try {
			proc.stdin?.write(stdinText);
			proc.stdin?.end();
		} catch {
			/* sync throw only; async stream errors handled by 'error' listeners */
		}
	});
}

// ============================================================================
// Run matching hook groups (parallel), collecting context + block decision
// ============================================================================

async function runGroups(
	groups: HookGroup[] | undefined,
	toolName: string,
	cwd: string,
	stdinText: string,
): Promise<{ contexts: string[]; block: string | null }> {
	if (!groups) return { contexts: [], block: null };

	const commands: Array<{ command: string; timeoutMs: number }> = [];
	for (const group of groups) {
		if (!matchTool(group.matcher, toolName)) continue;
		for (const hook of group.hooks) {
			commands.push({
				command: hook.command,
				timeoutMs: (hook.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
			});
		}
	}
	if (commands.length === 0) return { contexts: [], block: null };

	// Run concurrently (Claude Code runs matching hooks in parallel) but cap
	// simultaneous subprocesses; preserve submission order of context.
	const MAX_CONCURRENT = 8;
	const results: HookResult[] = [];
	for (let i = 0; i < commands.length; i += MAX_CONCURRENT) {
		const batch = commands.slice(i, i + MAX_CONCURRENT);
		results.push(...(await Promise.all(batch.map((c) => runCommand(c.command, cwd, stdinText, c.timeoutMs)))));
	}

	const contexts: string[] = [];
	let block: string | null = null;
	for (const r of results) {
		if (r.context) contexts.push(r.context);
		if (r.block && block === null) block = r.block;
	}
	return { contexts, block };
}

// ============================================================================
// SessionStart reason → Claude Code source mapping
// ============================================================================

function mapSessionSource(reason: string | undefined): string {
	switch (reason) {
		case "new":
			return "clear"; // CC SessionStart "clear" matcher
		case "resume":
			return "resume";
		case "fork":
			return "resume"; // fork continues history — closer to CC "resume" than "startup"
		case "reload":
		case "startup":
		default:
			return "startup";
	}
}

// ============================================================================
// Extension
// ============================================================================

export default function (pi: ExtensionAPI): void {
	// undefined = not loaded yet; null = loaded but no config. The single
	// variable distinguishes both, so a missing/unreadable file is not
	// re-read on every event.
	let config: HooksConfig | null | undefined;
	const getConfig = (cwd: string): HooksConfig | null => {
		if (config === undefined) {
			config = loadConfig(cwd);
		}
		return config;
	};

	// SessionStart additionalContext waiting to be injected on the first LLM
	// call. session_start fires before the first context event, so this is set
	// in time for injection. Consumed once by the context handler.
	let activateContext: string | null = null;

	// PreToolUse additionalContext queued by tool_call, injected before each
	// LLM call.
	const pendingContexts: string[] = [];

	// -------------------------------------------------------------------------
	// session_start: SessionStart hooks.
	//
	// Bound to session_start (not before_agent_start) so the matcher can match
	// the session source (startup/resume/clear/...). session_start fires before
	// the first context event, so activateContext is ready in time.
	// -------------------------------------------------------------------------
	pi.on("session_start", async (event, ctx) => {
		// "reload" is a runtime rebind, not a session-source event — SessionStart
		// hooks must not re-run mid-session.
		if (event.reason === "reload") return;
		const cfg = getConfig(ctx.cwd);
		if (!cfg?.hooks.SessionStart) return;
		const source = mapSessionSource(event.reason);
		const stdin = buildStdin("SessionStart", ctx, { source });
		const { contexts } = await runGroups(cfg.hooks.SessionStart, source, ctx.cwd, JSON.stringify(stdin));
		if (contexts.length > 0) activateContext = contexts.join("\n\n");
	});

	// -------------------------------------------------------------------------
	// context: inject all pending contexts before each LLM call.
	//
	// Appends to the last user message's content array — never adds a new
	// message — so there are no consecutive-user-message issues and no extra
	// turns. Handles both array and (defensively) string content shapes.
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
			const last = messages[lastUserIdx] as unknown as { role: string; content: unknown };
			const c = last.content;
			if (typeof c === "string") {
				messages[lastUserIdx] = {
					...last,
					content: [
						{ type: "text" as const, text: c },
						{ type: "text" as const, text },
					],
				} as unknown as (typeof messages)[number];
			} else if (Array.isArray(c)) {
				messages[lastUserIdx] = {
					...last,
					content: [...c, { type: "text" as const, text }],
				} as unknown as (typeof messages)[number];
			}
			// non-string/non-array content: leave untouched (nothing to append to).
		} else {
			(messages as unknown[]).push({ role: "user", content: [{ type: "text" as const, text }] });
		}

		return { messages: messages as typeof event.messages };
	});

	// -------------------------------------------------------------------------
	// tool_call: PreToolUse hooks. Honors deny (permissionDecision/exit 2) by
	// returning { block: true, reason, terminate: true } (terminate skips the
	// automatic follow-up LLM call; requires pi >= 0.84.1). additionalContext is
	// queued for the next context event. All matching groups run, regardless of matcher.
	// -------------------------------------------------------------------------
	pi.on("tool_call", async (event, ctx) => {
		const cfg = getConfig(ctx.cwd);
		if (!cfg?.hooks.PreToolUse) return;

		const stdin = buildStdin("PreToolUse", ctx, {
			tool_name: event.toolName,
			tool_input: event.input ?? {},
		});

		const { contexts, block } = await runGroups(cfg.hooks.PreToolUse, event.toolName, ctx.cwd, JSON.stringify(stdin));
		// A block + terminate skips this round's follow-up LLM call, so queued
		// context would leak into the next user prompt — drop it on block.
		if (block) return { block: true, reason: block, terminate: true };
		if (contexts.length > 0) pendingContexts.push(...contexts);
	});

	// -------------------------------------------------------------------------
	// session_shutdown: Stop hooks (cleanup only). CC's Stop `decision: "block"`
	// is intentionally not honored — pi cannot prevent exit from here.
	// -------------------------------------------------------------------------
	pi.on("session_shutdown", async (_event, ctx) => {
		const cfg = getConfig(ctx.cwd);
		if (!cfg) return;
		const stdin = buildStdin("Stop", ctx);
		await runGroups(cfg.hooks.Stop, "", ctx.cwd, JSON.stringify(stdin));
	});
}
