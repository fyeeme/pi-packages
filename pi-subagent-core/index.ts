/**
 * pi-subagent-core — shared agent dispatch for pi subprocesses.
 *
 * The common core extracted from pi-review/src/agent/dispatch.ts and
 * pi-dynamic-workflows/src/agent/dispatch.ts: one `pi --mode json -p
 * --no-session` subprocess per agent call, stdout parsed for
 * {message_end, tool_result_end} events, AbortSignal → SIGTERM with a
 * 5s SIGKILL escalation.
 *
 * Each call owns a per-call AbortController registered in an AgentAbortMap,
 * paired with Map<callId, ChildProcess>. This is the shared底层 for the
 * workflow `agent()` primitive and for per-agent abort: a single callId can
 * be aborted (retry/skip) without disturbing its batch siblings, because
 * abort is translated to a SIGTERM on exactly one process.
 *
 * Workflows-specific machinery (skipAgent/retryAgent/AbortReason/lifecycle
 * notifications) stays in pi-dynamic-workflows on top of this core.
 *
 * When pi promotes spawnAgent to a public @earendil-works/pi-coding-agent
 * export, this package should be deleted in favor of that import.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";

/** Stable id for one agent call; the registry key for per-call abort. */
export type AgentCallId = string;

/** callId → per-call AbortController (Claude Code per-agent abort map). */
export type AgentAbortMap = Map<AgentCallId, AbortController>;

// ---------------------------------------------------------------------------
// Concurrency limiter (ported from examples/extensions/subagent)
// ---------------------------------------------------------------------------

/**
 * Run `fn` over `items` with at most `concurrency` in flight, preserving
 * input order in the output array. parallel mode builds on this.
 */
export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	// Stop dispatching NEW items once any worker has errored, so a rejection
	// doesn't leave sibling workers pulling more items and spawning unawaited
	// subprocesses. In-flight calls finish; the failing worker rethrows.
	let failed = false;
	const workers = new Array(limit).fill(null).map(async () => {
		while (!failed) {
			const current = nextIndex++;
			if (current >= items.length) return;
			try {
				results[current] = await fn(items[current], current);
			} catch (err) {
				failed = true;
				throw err;
			}
		}
	});
	await Promise.all(workers);
	return results;
}

// ---------------------------------------------------------------------------
// pi binary resolution (ported from examples/extensions/subagent)
// ---------------------------------------------------------------------------

/**
 * Resolve the `pi` invocation for the subprocess. Prefers re-entering the
 * current script (node <script> / bun <script>); falls back to the `pi`
 * binary on PATH when run under a generic runtime.
 */
export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

// ---------------------------------------------------------------------------
// Usage + result
// ---------------------------------------------------------------------------

export interface AgentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface AgentSpawnOptions {
	/** Stable id for this call; the registry key for per-call abort. */
	readonly callId: AgentCallId;
	/** Prompt passed as the final positional arg to `pi -p`. */
	readonly task: string;
	/** Working directory for the spawned pi process. Defaults to process.cwd(). */
	readonly cwd?: string;
	/** `--model` override. */
	readonly model?: string;
	/** `--tools` whitelist (comma-joined). */
	readonly tools?: string[];
	/** System prompt appended via a temp file (`--append-system-prompt`). */
	readonly systemPrompt?: string;
	/** Caller-level abort signal; linked to this call's per-call controller. */
	readonly signal?: AbortSignal;
	/** Max assistant turns. When reached, the subprocess is aborted (SIGTERM). Omit for unlimited. */
	readonly maxTurns?: number;
}

export interface AgentSpawnResult {
	callId: AgentCallId;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: AgentUsage;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	/** True if aborted (external cancel or per-call abort). exitCode may be null/non-zero. */
	aborted: boolean;
	/** True if killed because the caller's maxTurns budget was reached. Distinct
	 *  from `aborted` (external cancel): the agent did useful bounded work. */
	maxTurnsReached: boolean;
}

// ---------------------------------------------------------------------------
// Registry — Map<callId, ChildProcess> + per-call AbortController
// ---------------------------------------------------------------------------

export interface AgentSpawnRegistry {
	/** callId → child process. The callId→proc table that translates abort → SIGTERM on one process. */
	readonly processes: Map<AgentCallId, ChildProcess>;
	/** callId → per-call controller (Claude Code per-agent abort map). */
	readonly controllers: AgentAbortMap;
}

export function createSpawnRegistry(): AgentSpawnRegistry {
	return {
		processes: new Map(),
		controllers: new Map(),
	};
}

/**
 * Abort exactly one in-flight call by id.
 *
 * Aborts the call's per-call controller; spawnAgent's race-safe listener
 * (sync check of `controller.signal.aborted` + addEventListener) translates
 * that into SIGTERM→SIGKILL on exactly the one subprocess. Returns false if
 * the callId is not in flight.
 */
export function abortAgent(registry: AgentSpawnRegistry, callId: AgentCallId): boolean {
	const controller = registry.controllers.get(callId);
	if (!controller) return false;
	controller.abort();
	return true;
}

// ---------------------------------------------------------------------------
// Spawn — the dispatch primitive
// ---------------------------------------------------------------------------

export async function spawnAgent(
	registry: AgentSpawnRegistry,
	options: AgentSpawnOptions,
): Promise<AgentSpawnResult> {
	const { callId, task, cwd, model, tools, systemPrompt, signal } = options;

	// Per-call controller — the per-agent abort entry point.
	const controller = new AbortController();
	registry.controllers.set(callId, controller);

	// Link the caller-level signal to this call's controller so a run-wide
	// abort reaches every in-flight call. Named + removed in finally — otherwise
	// a normally-completing call leaks a listener on the parent signal (and a
	// late parent abort would flip result.aborted on an already-consumed result).
	const onParentAbort = (): void => controller.abort();
	if (signal) {
		if (signal.aborted) controller.abort();
		else signal.addEventListener("abort", onParentAbort);
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (model) args.push("--model", model);
	if (tools && tools.length > 0) args.push("--tools", tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const result: AgentSpawnResult = {
		callId,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		aborted: false,
		maxTurnsReached: false,
	};

	try {
		if (systemPrompt && systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(callId, systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		// The prompt is the final positional arg consumed by `-p`.
		args.push(task);

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? process.cwd(),
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			registry.processes.set(callId, proc);

			let buffer = "";
			const decoder = new StringDecoder("utf8");

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: { type: string; message?: Message };
				try {
					event = JSON.parse(line) as { type: string; message?: Message };
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message;
					result.messages.push(msg);
					if (msg.role === "assistant") {
						result.usage.turns++;
						// Enforce maxTurns: abort the subprocess when the limit is reached.
						// killProc handles the SIGTERM→SIGKILL escalation. Use `!= null` so an
						// explicit maxTurns: 0 is honored (and marked) rather than treated as "unset".
						if (options.maxTurns != null && result.usage.turns >= options.maxTurns) {
							result.maxTurnsReached = true;
							controller.abort();
						}
						const usage = msg.usage;
						if (usage) {
							result.usage.input += usage.input || 0;
							result.usage.output += usage.output || 0;
							result.usage.cacheRead += usage.cacheRead || 0;
							result.usage.cacheWrite += usage.cacheWrite || 0;
							result.usage.cost += Number(usage.cost?.total) || 0;
							result.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!result.model && msg.model) result.model = msg.model;
						if (msg.stopReason) result.stopReason = msg.stopReason;
						if (msg.errorMessage) result.errorMessage = msg.errorMessage;
					}
				}

				if (event.type === "tool_result_end" && event.message) {
					result.messages.push(event.message);
				}
			};

			proc.stdout.on("data", (data) => {
				// StringDecoder buffers incomplete multi-byte UTF-8 sequences across chunk
				// boundaries so a CJK char split between two `data` events isn't replaced
				// with U+FFFD (which would corrupt the line and silently drop the event).
				buffer += decoder.write(data);
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				result.stderr += data.toString();
			});

			proc.on("close", (code) => {
				const tail = decoder.end();
				if (tail) buffer += tail;
				if (buffer.trim()) processLine(buffer);
				// code === null means the process was terminated by a signal (SIGTERM/SIGKILL
				// from the OS, OOM killer, or our own abort path). Treat that as failure (1)
				// rather than success (0): otherwise an externally-killed subprocess with no
				// assistant output reports exitCode 0 and is misclassified as a successful
				// empty-output run. Our own abort path already sets result.aborted = true, so
				// the runner's `ok` check (`!res.aborted && exitCode === 0`) still classifies
				// aborts correctly.
				resolve(code ?? 1);
			});

			proc.on("error", (err) => {
				// Surface the spawn error (e.g. ENOENT when `pi` is not on PATH) instead
				// of swallowing it — diagnoseFailure reads errorMessage/stderr.
				result.errorMessage = err.message;
				result.stderr += err.message;
				resolve(1);
			});

			// Per-call abort → SIGTERM (SIGKILL after 5s). Mirrors subagent.
			// Race-safe: if the controller was already aborted (e.g. the
			// workflow signal fired before this listener registered), kill now.
			const killProc = () => {
				// Late-abort guard: if the proc already exited (close fired before this
				// abort), don't flip a successful result's `aborted` flag — downstream
				// would see exitCode 0 + populated messages + aborted===true.
				if (proc.exitCode !== null || proc.signalCode !== null) return;
				result.aborted = true;
				proc.kill("SIGTERM");
				const timer = setTimeout(() => {
					// Node: subprocess.killed means kill() was CALLED, not that the
					// process EXITED. SIGTERM may be ignored (proc busy in I/O) — force
					// SIGKILL after the grace period. On an already-exited proc, kill()
					// returns false (harmless).
					proc.kill("SIGKILL");
				}, 5000);
				// Clear the timer once the proc exits so we don't leak a libuv handle
				// (which pins the event loop open + retains a strong ref to ChildProcess).
				proc.once("close", () => clearTimeout(timer));
			};
			if (controller.signal.aborted) killProc();
			else controller.signal.addEventListener("abort", killProc, { once: true });
		});

		result.exitCode = exitCode;
		return result;
	} finally {
		// Always release registry slots, the parent-signal listener, and temp files.
		registry.processes.delete(callId);
		registry.controllers.delete(callId);
		if (signal) signal.removeEventListener("abort", onParentAbort);
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

async function writePromptToTempFile(callId: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-sa-agent-"));
	const safeName = callId.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	return { dir: tmpDir, filePath };
}
