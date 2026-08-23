/**
 * monitor.ts — in-process live state for spawned sub-agents (UI observability).
 *
 * `spawnAgent` (index.ts) notifies the module-level `monitor` singleton at
 * every lifecycle seam — call start/end, assistant message end, tool
 * execution start/end, compaction, streamed text deltas. The UI layer
 * (`ui/agent-widget.ts`, `ui/fleet-list.ts`, `ui/conversation-viewer.ts`)
 * renders from this state; nothing in the dispatch path reads it back, so a
 * UI-side bug can never affect a spawn. index.ts additionally wraps every
 * notification in try/catch (belt and braces): monitor methods are written to
 * be total (Map/arithmetic operations, defensive typeof checks — no throws).
 *
 * Because the singleton lives in this module, any code loaded from the same
 * package copy shares it: a consumer's `spawnAgent` and the UI extension
 * (`sub-agent.ts`) observe the same agents when loaded from one package
 * instance (e.g. via a manifest entry pointing into a dependency's
 * node_modules copy — see README "Wiring").
 *
 * State is bounded: finished calls linger FINISHED_RETENTION_MS (capped at
 * MAX_FINISHED_ENTRIES) for late viewers, then are evicted lazily on read so
 * long sessions do not accumulate transcript references.
 */
import type { Message } from "@earendil-works/pi-ai";

/** Lifecycle status of one spawned call. */
export type AgentCallStatus = "running" | "completed" | "aborted" | "error";

/** Live per-call state — the source of truth for the UI layer. */
export interface AgentCallState {
	readonly callId: string;
	/** Display name for widget/fleet rows. Derived: options.displayName ?? "Agent". */
	readonly displayName: string;
	/** Row description: first non-empty line of the task prompt. */
	readonly description: string;
	/** Spawn time (Date.now()). */
	readonly startedAt: number;
	/** Effective maxTurns for this call (undefined = unlimited). */
	readonly maxTurns?: number;
	/**
	 * Whether the spawner declared this call background. `undefined` =
	 * undeclared — stays visible in the widget's default "background" mode;
	 * only an explicit foreground declaration (`background === false`, agents
	 * already rendering inline as the tool result) drops out of that mode.
	 */
	readonly background?: boolean;
	/** Per-call controller — monitor.abort(callId) reaches the live process. */
	readonly controller: AbortController;
	/** Live message array (same reference spawnAgent appends to). */
	readonly messages: Message[];
	/** Model id; set from spawn options, refined on first assistant message. */
	model?: string;
	status: AgentCallStatus;
	/** Assistant turns completed. */
	turns: number;
	/** Completed tool executions (tool_execution_end count). */
	toolUses: number;
	/** Lifetime token total = input + output + cacheWrite, accumulated. */
	lifetimeTokens: number;
	/** Current context fill (usage.totalTokens of the last assistant message). */
	contextTokens: number;
	/** Compactions observed in the subprocess stream. */
	compactions: number;
	/** toolCallId → toolName for in-flight tools. */
	readonly activeTools: Map<string, string>;
	/** Rolling tail of streamed assistant text (activity fallback). */
	responseTail: string;
	/** Settlement time, set by callEnded. */
	completedAt?: number;
	exitCode?: number;
	/** True when the maxTurns budget stopped the call (rendered as a note). */
	maxTurnsReached?: boolean;
	errorMessage?: string;
}

/** Metadata for callStarted — everything known at spawn time. */
export interface AgentCallStartMeta {
	callId: string;
	/** Raw task prompt (first line becomes the row description). */
	task: string;
	/** UI display name; omit for "Agent". */
	displayName?: string;
	/** Declared background flag; omit for undeclared (visible everywhere). */
	background?: boolean;
	/** Model override, when the caller passed --model. */
	model?: string;
	maxTurns?: number;
	controller: AbortController;
	/** Live messages array; spawnAgent passes result.messages by reference. */
	messages: Message[];
}

/** Settlement info handed to callEnded from spawnAgent's finally block. */
export interface AgentCallEndInfo {
	exitCode: number;
	aborted: boolean;
	maxTurnsReached: boolean;
	errorMessage?: string;
}

/** How long a finished call stays readable (viewer) after settlement. */
const FINISHED_RETENTION_MS = 60_000;
/** Hard cap on retained finished calls (bounded memory for transcript refs). */
const MAX_FINISHED_ENTRIES = 20;
/** Rolling size of the streamed-text tail kept for the activity line. */
const RESPONSE_TAIL_CHARS = 240;

/** Structural usage shape the monitor reads (input/output/cacheWrite/totalTokens). */
type UsageLike = { input?: number; output?: number; cacheWrite?: number; totalTokens?: number };

/**
 * Lines that are not real task content — models often prepend repo context
 * boilerplate ("Repo cwd: <path> (description). Repo信息") to sub-agent
 * prompts; such lines must not become the agent's row description or clutter
 * the transcript view. Case-insensitive prefix match.
 */
const BOILERPLATE_LINE_PREFIXES = ["repo cwd:", "repo root:", "repo info:", "repo:", "repo信息", "仓库信息"];

/** True when `line` looks like injected repo-context boilerplate. */
export function isBoilerplateLine(line: string): boolean {
	const lower = line.trim().toLowerCase();
	return BOILERPLATE_LINE_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** Derive the row description: first non-boilerplate line of the task, trimmed.
 *  Falls back to the first non-empty line when everything is boilerplate.
 *  Scans incrementally (indexOf + slice per line) instead of split+map+filter:
 *  task prompts embed full diffs (up to hundreds of KB), and only the first
 *  content line is needed — no reason to materialize the whole line array. */
function describeTask(task: string): string {
	let start = 0;
	let firstNonEmpty = "";
	for (;;) {
		const nl = task.indexOf("\n", start);
		const line = (nl === -1 ? task.slice(start) : task.slice(start, nl)).trim();
		if (line) {
			if (!isBoilerplateLine(line)) return line;
			if (!firstNonEmpty) firstNonEmpty = line;
		}
		if (nl === -1) return firstNonEmpty;
		start = nl + 1;
	}
}

/**
 * In-process agent state store. Not a pi extension — a plain singleton the
 * dispatch core notifies and the UI layer reads. All methods are safe to call
 * with unknown/garbage inputs (they ignore rather than throw).
 */
export class AgentMonitor {
	private readonly calls = new Map<string, AgentCallState>();
	private readonly listeners = new Set<() => void>();

	/** Register a call at spawn time. Re-registering a callId replaces it. */
	callStarted(meta: AgentCallStartMeta): void {
		if (!meta || typeof meta.callId !== "string" || !meta.callId) return;
		this.calls.set(meta.callId, {
			callId: meta.callId,
			displayName: typeof meta.displayName === "string" && meta.displayName.trim() ? meta.displayName.trim() : "Agent",
			description: describeTask(typeof meta.task === "string" ? meta.task : ""),
			startedAt: Date.now(),
			maxTurns: typeof meta.maxTurns === "number" && meta.maxTurns >= 0 ? meta.maxTurns : undefined,
			background: meta.background,
			controller: meta.controller,
			messages: Array.isArray(meta.messages) ? meta.messages : [],
			model: typeof meta.model === "string" && meta.model ? meta.model : undefined,
			status: "running",
			turns: 0,
			toolUses: 0,
			lifetimeTokens: 0,
			contextTokens: 0,
			compactions: 0,
			activeTools: new Map(),
			responseTail: "",
		});
		this.emitChange();
	}

	/** Fold an assistant message_end into the live counters. */
	messageEnd(callId: string, message: Message): void {
		const state = this.calls.get(callId);
		if (!state || !message || message.role !== "assistant") return;
		state.turns++;
		const usage = (message as { usage?: UsageLike }).usage;
		if (usage && typeof usage === "object") {
			const input = Number(usage.input) || 0;
			const output = Number(usage.output) || 0;
			const cacheWrite = Number(usage.cacheWrite) || 0;
			state.lifetimeTokens += input + output + cacheWrite;
			const totalTokens = Number(usage.totalTokens) || 0;
			if (totalTokens > 0) state.contextTokens = totalTokens;
		}
		const model = (message as { model?: unknown }).model;
		if (!state.model && typeof model === "string" && model) state.model = model;
		this.emitChange();
	}

	/** A tool started executing in the subprocess. */
	toolStart(callId: string, toolCallId: string, toolName: string): void {
		const state = this.calls.get(callId);
		if (!state || !toolCallId) return;
		state.activeTools.set(toolCallId, toolName || "tool");
	}

	/** A tool finished executing in the subprocess. */
	toolEnd(callId: string, toolCallId: string, _toolName: string): void {
		const state = this.calls.get(callId);
		if (!state) return;
		if (toolCallId) state.activeTools.delete(toolCallId);
		state.toolUses++;
		this.emitChange();
	}

	/** The subprocess session compacted (⇊N annotation). */
	compacted(callId: string): void {
		const state = this.calls.get(callId);
		if (!state) return;
		state.compactions++;
		this.emitChange();
	}

	/** Streamed assistant text delta — kept as a rolling tail for activity. */
	textDelta(callId: string, delta: string): void {
		const state = this.calls.get(callId);
		if (!state || typeof delta !== "string" || !delta) return;
		state.responseTail = (state.responseTail + delta).slice(-RESPONSE_TAIL_CHARS);
	}

	/** Settle a call. Status: aborted > error > completed (maxTurns = completed, flagged). */
	callEnded(callId: string, info: AgentCallEndInfo): void {
		const state = this.calls.get(callId);
		if (!state) return;
		if (info && info.aborted) state.status = "aborted";
		else if (info && (info.errorMessage || info.exitCode !== 0)) state.status = "error";
		else state.status = "completed";
		state.completedAt = Date.now();
		state.exitCode = info ? info.exitCode : undefined;
		state.maxTurnsReached = Boolean(info && info.maxTurnsReached);
		state.errorMessage = info && info.errorMessage ? info.errorMessage : undefined;
		state.activeTools.clear();
		this.emitChange();
		this.sweep();
	}

	/** Abort one in-flight call via its per-call controller. */
	abort(callId: string): boolean {
		const state = this.calls.get(callId);
		if (!state || state.status !== "running") return false;
		try {
			state.controller.abort();
		} catch {
			/* unreachable, but abort must never throw into UI code */
		}
		return true;
	}

	/** Live + recently finished calls, earliest-launched first. */
	list(): AgentCallState[] {
		this.sweep();
		return [...this.calls.values()];
	}

	get(callId: string): AgentCallState | undefined {
		this.sweep();
		return this.calls.get(callId);
	}

	/** Change listener (UI re-render trigger). Errors are isolated per listener. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Drop all state (tests). */
	clear(): void {
		this.calls.clear();
		this.emitChange();
	}

	private emitChange(): void {
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				/* a broken listener must not break the others */
			}
		}
	}

	/**
	 * Lazy eviction: finished calls older than FINISHED_RETENTION_MS, plus the
	 * oldest finished calls beyond MAX_FINISHED_ENTRIES. Running calls are
	 * never swept.
	 */
	private sweep(): void {
		const now = Date.now();
		for (const [id, state] of this.calls) {
			if (state.status !== "running" && state.completedAt != null && now - state.completedAt > FINISHED_RETENTION_MS) {
				this.calls.delete(id);
			}
		}
		const finished = [...this.calls.values()].filter((s) => s.status !== "running");
		if (finished.length > MAX_FINISHED_ENTRIES) {
			finished.sort((a, b) => (a.completedAt ?? a.startedAt) - (b.completedAt ?? b.startedAt));
			for (const state of finished.slice(0, finished.length - MAX_FINISHED_ENTRIES)) {
				this.calls.delete(state.callId);
			}
		}
	}
}

/**
 * Process-global singleton — the shared seam between dispatch core and UI.
 *
 * pi's extension loader runs every extension entry through a fresh jiti with
 * `moduleCache: false`, so a plain module-level const would be one instance
 * PER extension copy (consumer's spawnAgent graph, UI extension, driver…).
 * Parking the singleton on globalThis under a registered symbol makes every
 * copy in the process converge on the same object — no cross-extension RPC
 * needed for read-only observability.
 */
const MONITOR_KEY = Symbol.for("@fyeeme/pi-subagent-core/monitor");

export const monitor: AgentMonitor =
	((globalThis as Record<symbol, unknown>)[MONITOR_KEY] as AgentMonitor | undefined) ??
	((globalThis as Record<symbol, unknown>)[MONITOR_KEY] = new AgentMonitor());
