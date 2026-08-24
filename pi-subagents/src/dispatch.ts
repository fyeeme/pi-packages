/**
 * pi-subagents — shared agent dispatch for pi subprocesses.
 *
 * The common core for spawning `pi --mode json -p --no-session` subprocesses,
 * one per agent call, stdout parsed for {message_end, tool_result_end} events,
 * AbortSignal → SIGTERM with a 5s SIGKILL escalation.
 *
 * Each call owns a per-call AbortController registered in an AgentAbortMap,
 * paired with Map<callId, ChildProcess>. This is the shared底层 for the
 * `subagent` tool, the workflow `agent()` primitive, and per-agent abort: a
 * single callId can be aborted (retry/skip) without disturbing its batch
 * siblings, because abort is translated to a SIGTERM on exactly one process.
 *
 * Workflows-specific machinery (skipAgent/retryAgent/AbortReason/lifecycle
 * notifications) stays in pi-dynamic-workflows on top of this core.
 *
 * UI observability: every spawn notifies the module-level `monitor` singleton
 * (monitor.ts) - call start/end, assistant message ends, tool execution
 * start/end, compactions, streamed text. Purely observational: the dispatch
 * path never reads monitor state back, and every notification is wrapped in
 * try/catch so the UI layer cannot break a spawn. The optional pi extension
 * (index.ts + ui/) renders that state as the above-editor agent widget,
 * the below-editor FleetView, and the /agents command.
 *
 * When pi promotes spawnAgent to a public @earendil-works/pi-coding-agent
 * export, this dispatch layer should be deleted in favor of that import.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { monitor } from "./monitor.ts";
import { loadCoreSettings } from "./concurrency.ts";

export { AgentMonitor, monitor } from "./monitor.ts";
export type {
	AgentCallEndInfo,
	AgentCallStartMeta,
	AgentCallState,
	AgentCallStatus,
} from "./monitor.ts";
export { loadCoreSettings, MAX_CONCURRENCY_OPTIONS } from "./concurrency.ts";
export type { MaxConcurrencyOption, SubagentCoreSettings, WidgetMode } from "./concurrency.ts";
export { contentText, contentTextBlocks, lastAssistantText } from "./text.ts";

/** Fire a monitor notification. UI observability must never break dispatch. */
function notifyMonitor(fn: () => void): void {
	try {
		fn();
	} catch {
		/* ignore monitor errors */
	}
}

/** Stable id for one agent call; the registry key for per-call abort. */
export type AgentCallId = string;

/** callId → per-call AbortController (Claude Code per-agent abort map). */
export type AgentAbortMap = Map<AgentCallId, AbortController>;

// ---------------------------------------------------------------------------
// Recursion guard (harden-code-simplify, Decision A3)
// ---------------------------------------------------------------------------
//
// pi's subagent spawns fresh subprocesses whose depth is always 0 at spawn
// time, so Claude Code's `depth >= MAX_SUBAGENT_SPAWN_DEPTH` guard (tracked
// in-process) is semantically inert here. Instead we propagate three env vars
// to each child and let the fan-out tool decide at load time whether to even
// register itself:
//
//   PI_SUBAGENT_DEPTH             — this process's depth in the tree (0=top)
//   PI_SUBAGENT_RECURSION_ALLOWED — "1" iff the spawner explicitly opted this
//                                   child into recursion (passed the fan-out
//                                   tool in its tool whitelist)
//   PI_SUBAGENT_MAX_SPAWN_DEPTH   — optional hard cap; a child at/above it runs
//                                   without the fan-out tool even if opted in
//
// Default (no opt-in): children cannot recurse — physically, the tool is not
// registered. Opt-in (caller lists the fan-out tool) re-enables it, bounded by
// the max cap. This is the faithful pi-analog of CC's spawn-depth guard,
// simplified because no shipped command needs nested fan-out.

/**
 * Parse a strictly-positive integer from an env string. Returns null for
 * missing, non-numeric, non-integer, or non-positive values so callers can
 * fall back to a default. Used for depth, max-depth, and concurrency ceilings.
 */
export function parsePositiveInt(value: string | undefined): number | null {
	if (value == null || value === "") return null;
	const n = Number(value);
	if (!Number.isInteger(n) || n <= 0) return null;
	return n;
}

/**
 * Depth of THIS process in the sub-agent tree. 0 (top-level) when unset; a
 * child inherits `parent + 1` via the env var spawnAgent sets.
 */
export function currentSpawnDepth(env: NodeJS.ProcessEnv = process.env): number {
	return parsePositiveInt(env.PI_SUBAGENT_DEPTH) ?? 0;
}

/**
 * Whether the fan-out tool SHOULD be registered in THIS process. Pure — the
 * policy core, unit-testable without spawning. Top-level always exposes it; a
 * child exposes it only when its spawner opted in AND it is below the cap.
 */
export function isFanoutToolAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
	const depth = currentSpawnDepth(env);
	if (depth === 0) return true;
	if (env.PI_SUBAGENT_RECURSION_ALLOWED !== "1") return false;
	const max = parsePositiveInt(env.PI_SUBAGENT_MAX_SPAWN_DEPTH);
	return max == null ? true : depth < max;
}

/**
 * Build the env block a spawned child receives. Increments depth, records
 * whether this child may recurse, and propagates the inherited cap (if any).
 */
function childSpawnEnv(options: AgentSpawnOptions): NodeJS.ProcessEnv {
	const childDepth = currentSpawnDepth() + 1;
	// Parse the option through parsePositiveInt so 0/negative/non-numeric values
	// fall back to the inherited env (or unset) instead of propagating a "0" that
	// the child would read as "no cap" — the directionally-dangerous reading.
	const max = parsePositiveInt(options.maxSpawnDepth != null ? String(options.maxSpawnDepth) : process.env.PI_SUBAGENT_MAX_SPAWN_DEPTH);
	return {
		...process.env,
		PI_SUBAGENT_DEPTH: String(childDepth),
		PI_SUBAGENT_RECURSION_ALLOWED: options.allowChildRecursion ? "1" : "0",
		...(max != null ? { PI_SUBAGENT_MAX_SPAWN_DEPTH: String(max) } : {}),
	};
}

// ---------------------------------------------------------------------------
// Concurrency limiter (ported from examples/extensions/subagent)
// ---------------------------------------------------------------------------

/** Hardcoded fallback concurrency ceiling for sub-agent fan-out: 5. The
 *  effective default is configurable via the package settings file
 *  (`maxConcurrency` in pi-subagent.json, options 3/5/8/10 — see concurrency.ts); this constant
 *  applies when no valid setting is present. Callers needing a different
 *  ceiling pass `concurrency` explicitly. */
export const DEFAULT_MAX_CONCURRENCY = 5;

/**
 * Effective default concurrency ceiling for fan-out (the "concurrent agents"
 * setting): `maxConcurrency` from the package settings files (project
 * layer overriding global; options 3/5/8/10), falling back to the hardcoded
 * {@link DEFAULT_MAX_CONCURRENCY}. Read at call time so an edited file takes
 * effect on the next fan-out without a restart. A consumer-level env override
 * (e.g. pi-review's PI_MAX_CONCURRENT_SUBAGENTS) is resolved by the consumer
 * and takes precedence over this value.
 */
export function getEffectiveMaxConcurrency(): number {
	// loadCoreSettings is total by contract (malformed files are warned and
	// dropped inside concurrency.ts — "never fatal"), so no guard is needed here.
	return loadCoreSettings().maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
}

/**
 * Effective concurrency ceiling for parallel fan-out — the package-level
 * ceiling policy shared by every fan-out path. Precedence:
 *   1. PI_MAX_CONCURRENT_SUBAGENTS env var (power-user escape hatch, parity
 *      with CC's CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS; unset/invalid ignored);
 *   2. the shared package setting `maxConcurrency` from
 *      <agentDir>/pi-subagent.json (project layer overriding) — options
 *      3/5/8/10, default 5 (see concurrency.ts).
 * Read at call time so a changed env/file takes effect without a reload.
 * (Converged from pi-review/src/concurrency.ts — one resolver for every
 * consumer instead of a per-package re-export.)
 */
export function getMaxConcurrency(): number {
	return parsePositiveInt(process.env.PI_MAX_CONCURRENT_SUBAGENTS) ?? getEffectiveMaxConcurrency();
}

/**
 * Run `fn` over `items` with at most `concurrency` in flight, preserving
 * input order in the output array. parallel mode builds on this.
 *
 * The `concurrency` argument is optional (the "max concurrency" option):
 * when omitted, the ceiling is `getEffectiveMaxConcurrency()` — the
 * `maxConcurrency` setting (options 3/5/8/10, default 5). An explicit
 * value is clamped to `[1, items.length]` as before; existing callers that
 * pass it explicitly are unaffected.
 */
export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]>;
export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]>;
export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrencyOrFn: number | ((item: TIn, index: number) => Promise<TOut>),
	maybeFn?: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	const fn = typeof concurrencyOrFn === "function" ? concurrencyOrFn : maybeFn!;
	const concurrency =
		typeof concurrencyOrFn === "number" ? concurrencyOrFn : getEffectiveMaxConcurrency();
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	// Stop dispatching NEW items once any worker has errored, so a rejection
	// doesn't leave sibling workers pulling more items and spawning unawaited
	// subprocesses. In-flight calls are AWAITED before rethrowing — a failure
	// never leaves spawned subprocesses running in the background after the
	// caller observes the rejection (the `failed` flag only blocks new dispatch).
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
	// Await every worker (including in-flight ones) before rethrowing, so an
	// error from one item cannot orphan already-spawned subprocesses that keep
	// running after the caller sees the rejection. The rejection of the
	// lowest-index WORKER wins (Promise.allSettled preserves worker array order)
	// — deterministic, though neither the lowest item index nor the earliest
	// failure in time.
	const settled = await Promise.allSettled(workers);
	const firstRejection = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
	if (firstRejection) throw firstRejection.reason;
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
	/** `--thinking` level for the spawned process (off|minimal|low|medium|high|xhigh|max). Omit to use the model default. */
	readonly thinking?: string;
	/** `--tools` whitelist (comma-joined). */
	readonly tools?: string[];
	/** System prompt appended via a temp file (`--append-system-prompt`). */
	readonly systemPrompt?: string;
	/** Caller-level abort signal; linked to this call's per-call controller. */
	readonly signal?: AbortSignal;
	/** Max assistant turns. When reached, the subprocess is aborted (SIGTERM). Omit for unlimited. */
	readonly maxTurns?: number;
	/** When true, the spawned child is allowed to register the fan-out tool
	 *  (explicit recursion opt-in — the caller listed it in the tool whitelist).
	 *  When false/omitted, the child loads without the fan-out tool. */
	readonly allowChildRecursion?: boolean;
	/** Hard cap on the agent-tree depth. A child at or above this depth loads
	 *  without the fan-out tool even if {@link allowChildRecursion} is set.
	 *  Omit to inherit any cap from the PI_SUBAGENT_MAX_SPAWN_DEPTH env var. */
	readonly maxSpawnDepth?: number;
	/** Optional callback for streamed assistant text. Invoked once per
	 *  `message_update` event with the delta chunk (partial text since the last
	 *  event). Omit to keep the current behavior of discarding intermediate
	 *  events; final `message_end` results are always collected regardless. */
	readonly onUpdate?: (delta: string) => void;
	/** UI display name for this call (widget / FleetView rows). Purely
	 *  observational metadata consumed by the monitor + UI layer; defaults to
	 *  "Agent". No effect on the spawned process or the returned result. */
	readonly displayName?: string;
	/** Whether this call is declared background (widget mode filter). Purely
	 *  observational metadata: `true` = background, `false` = foreground (already
	 *  rendered inline as the tool result - hidden from the widget's default
	 *  "background" mode), omitted = undeclared (visible in every widget mode).
	 *  No effect on the spawned process or the returned result. */
	readonly background?: boolean;
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
	/** True if aborted (external cancel, per-call abort, or maxTurns budget hit —
	 *  the maxTurns path sets `aborted` too via the per-call controller; use
	 *  {@link maxTurnsReached} to distinguish the two). exitCode may be null/non-zero. */
	aborted: boolean;
	/** True if killed because the caller's maxTurns budget was reached. NOT
	 *  mutually exclusive with `aborted` — the maxTurns path aborts the call, so
	 *  both flags are true for a budget-stopped agent. */
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

/** Single argv entries are capped by the kernel (Linux MAX_ARG_STRLEN =
 *  128 KiB); a longer task would fail the spawn with E2BIG. Tasks over this
 *  budget ride a temp file passed as the `@file` positional arg, which pi
 *  expands into the prompt content (see spawnAgent). */
const TASK_ARG_MAX_BYTES = 100 * 1024;

/** Retained-tail size for child stderr (~64 KB chars). Diagnostics only need
 *  the lines around the failure, and an uncapped buffer lets a chatty or
 *  crash-looping child grow the parent's heap without bound. */
const STDERR_RETAIN_CHARS = 64_000;

export async function spawnAgent(
	registry: AgentSpawnRegistry,
	options: AgentSpawnOptions,
): Promise<AgentSpawnResult> {
	const { callId, task, cwd, model, thinking, tools, systemPrompt, signal } = options;

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
	if (thinking) args.push("--thinking", thinking);
	if (tools && tools.length > 0) args.push("--tools", tools.join(","));

	/** Temp files holding prompt text that must not ride an argv entry (the
	 *  system prompt always; the task when over TASK_ARG_MAX_BYTES) — cleaned
	 *  up in the finally block. */
	const tmpPromptFiles: { dir: string; filePath: string }[] = [];

	const result: AgentSpawnResult = {
		callId,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		aborted: false,
		maxTurnsReached: false,
	};

	// Observability: register the call with the live-state monitor (UI layer).
	// Defensive by contract - a UI-side failure is swallowed by notifyMonitor.
	notifyMonitor(() =>
		monitor.callStarted({
			callId,
			task,
			displayName: options.displayName,
			background: options.background,
			model,
			maxTurns: options.maxTurns,
			controller,
			messages: result.messages,
		}),
	);

	try {
		// Pre-aborted caller signal (e.g. ESC fired while earlier siblings were
		// still in flight): don't spawn a subprocess just to SIGTERM it a moment
		// later. callStarted was already notified above, so the finally's
		// callEnded settles this call visibly as aborted instead of leaving a
		// phantom running row.
		if (controller.signal.aborted) {
			result.aborted = true;
			result.exitCode = 1;
			return result;
		}

		if (systemPrompt && systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(callId, systemPrompt);
			tmpPromptFiles.push(tmp);
			args.push("--append-system-prompt", tmp.filePath);
		}

		// The prompt is the final positional arg consumed by `-p`. An oversized
		// task would exceed the kernel's per-argument limit (Linux
		// MAX_ARG_STRLEN = 128 KiB → E2BIG at spawn), so it rides a temp file
		// instead: the `@file` positional arg makes pi expand the file's
		// contents into the prompt text.
		if (Buffer.byteLength(task, "utf8") > TASK_ARG_MAX_BYTES) {
			const tmp = await writePromptToTempFile(callId, task);
			tmpPromptFiles.push(tmp);
			args.push(`@${tmp.filePath}`);
		} else {
			args.push(task);
		}

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? process.cwd(),
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: childSpawnEnv(options),
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
						// Observability: fold the assistant turn into the live state.
						notifyMonitor(() => monitor.messageEnd(callId, msg));
					}
				}

				if (event.type === "tool_result_end" && event.message) {
					result.messages.push(event.message);
				}

				// Observability: in-flight tool activity and compaction count from
				// the subprocess stream (activity lines + the annotation).
				if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
					const e = event as { toolCallId?: unknown; toolName?: unknown };
					const toolCallId = typeof e.toolCallId === "string" ? e.toolCallId : "";
					const toolName = typeof e.toolName === "string" ? e.toolName : "";
					if (toolCallId) {
						notifyMonitor(() =>
							event.type === "tool_execution_start"
								? monitor.toolStart(callId, toolCallId, toolName)
								: monitor.toolEnd(callId, toolCallId, toolName),
						);
					}
				}
				if (event.type === "compaction_start") {
					notifyMonitor(() => monitor.compacted(callId));
				}

				if (event.type === "message_update") {
					// The JSON stream emits message_update as
					// { type: "message_update", assistantMessageEvent: { type: "text_delta", delta } }
					// (the cumulative `partial` is stripped by toJsonEvent). Forward only the
					// visible assistant text delta; thinking_delta is internal reasoning.
					const e = (event as { assistantMessageEvent?: { type?: string; delta?: unknown } }).assistantMessageEvent;
					if (e && e.type === "text_delta" && typeof e.delta === "string" && e.delta) {
						const delta = e.delta;
						// Observability: rolling text tail for the activity line.
						notifyMonitor(() => monitor.textDelta(callId, delta));
						if (options.onUpdate) {
							// The consumer callback must not be able to break event parsing: a
							// throwing onUpdate inside the stdout data handler would crash the
							// host process, and one thrown from the close-path processLine call
							// would skip resolve() and leave the spawnAgent promise unsettled
							// (plus a leaked registry entry). Swallow callback errors.
							try {
								options.onUpdate(delta);
							} catch {
								/* ignore consumer callback errors */
							}
						}
					}
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
				// Keep only the retained tail: diagnostics need the lines around the
				// failure, not the full stream. The ×2 headroom avoids slicing on
				// every chunk once the cap is reached.
				if (result.stderr.length > STDERR_RETAIN_CHARS * 2) {
					result.stderr = result.stderr.slice(-STDERR_RETAIN_CHARS);
				}
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
	} catch (err) {
		// A failure before/during spawn (temp-file write, E2BIG, ENOENT on pi)
		// rejects the promise — record it so the finally's monitor callEnded
		// marks the call `error` (red) instead of a green `completed`.
		result.errorMessage = err instanceof Error ? err.message : String(err);
		throw err;
	} finally {
		// Observability: settle the call FIRST so the UI sees final state while
		// registry slots / listeners / temp files are still being released.
		notifyMonitor(() =>
			monitor.callEnded(callId, {
				exitCode: result.exitCode,
				aborted: result.aborted,
				maxTurnsReached: result.maxTurnsReached,
				errorMessage: result.errorMessage,
			}),
		);
		// Always release registry slots, the parent-signal listener, and temp files.
		registry.processes.delete(callId);
		registry.controllers.delete(callId);
		if (signal) signal.removeEventListener("abort", onParentAbort);
		for (const tmp of tmpPromptFiles) {
			try {
				fs.unlinkSync(tmp.filePath);
			} catch {
				/* ignore */
			}
			try {
				fs.rmdirSync(tmp.dir);
			} catch {
				/* ignore */
			}
		}
	}
}

async function writePromptToTempFile(callId: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-sa-agent-"));
	const safeName = callId.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	try {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	} catch (err) {
		// writeFile may have created/partially-written the file (ENOSPC/EIO mid-write),
		// so rmdir would ENOTEMPTY on the non-empty dir. Use recursive rm to clean both
		// the dir and any partial file (which may carry sensitive systemPrompt content).
		try {
			await fs.promises.rm(tmpDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
		throw err;
	}
	return { dir: tmpDir, filePath };
}
