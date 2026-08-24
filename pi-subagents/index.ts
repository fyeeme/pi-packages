/**
 * pi-subagents — single entry: library barrel + pi extension factory.
 *
 * Library role (this file, the package `main`): the shared dispatch core for
 * spawning pi subprocess agents — spawnAgent, mapWithConcurrencyLimit,
 * createSpawnRegistry, abortAgent, getPiInvocation — plus the settings/
 * monitor/text helpers and the three-source agent discovery. This is the
 * successor of `@fyeeme/pi-subagent-core`'s export surface: consumers
 * (pi-review, pi-dynamic-workflows) switch by changing the import source only.
 *
 * Extension role (also this file, registered via the `pi.extensions` manifest):
 * registers the `subagent` tool (src/tools/subagent.ts) — general-purpose
 * single/parallel/chain delegation to named agents (user/project/bundled
 * discovery). Registered ONLY when recursion is allowed for THIS process
 * (top-level, or an opted-in child below the max-depth cap) — the
 * whitelist-by-default recursion guard. A default-spawned child loads
 * without the tool, so it physically cannot recurse. Plus the agent UI:
 * the above-editor agent widget (src/ui/agent-widget.ts) — live per-agent
 * stats with spinner, activity lines, and token annotations; the
 * below-editor FleetView (src/ui/fleet-list.ts) — navigable main+agents
 * list with a conversation-viewer overlay; and the `/agents` command —
 * list the session's agents, Enter opens the conversation viewer.
 *
 * Configuration is file-based only (src/concurrency.ts), read from
 * `<agentDir>/pi-subagent.json` (global defaults) with
 * `<cwd>/.pi/pi-subagent.json` (project) overriding — there is no interactive
 * settings UI. Keys: `widget` (all/background/off, read once at startup),
 * `fleetView` (boolean, default true, read once at startup), and
 * `maxConcurrency` (3/5/8/10, default 5 — consumed by the dispatch core at
 * call time).
 *
 * Session lifecycle: on session_shutdown (quit, /new, /resume, /fork, reload)
 * both surfaces are torn down immediately — widgets unregistered, spinner and
 * refresh timers stopped, the fleet input hook released, any open viewer
 * closed. The next session_start re-registers. /new additionally clears the
 * monitor's stale entries so finished agents from the previous session never
 * resurrect in the fresh one.
 *
 * The dispatch core (src/dispatch.ts) stays a plain library: the extension
 * factory below only READS the process-global `monitor` that spawnAgent
 * notifies (pi loads every extension with moduleCache:false, so the monitor
 * lives on globalThis under a registered symbol — see README "Wiring").
 *
 * Robustness: every handler is wrapped so a UI failure degrades to a notify
 * (or silence) instead of an unhandled rejection. Non-TUI modes (rpc/json/
 * print) register nothing beyond the no-op monitor bookkeeping.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { monitor } from "./src/monitor.ts";
import { isFanoutToolAllowed } from "./src/dispatch.ts";
import { subagentTool } from "./src/tools/subagent.ts";
import { loadCoreSettings, type SubagentCoreSettings, type WidgetMode } from "./src/concurrency.ts";
import { AgentWidget } from "./src/ui/agent-widget.ts";
import { FleetList, type FleetUICtx } from "./src/ui/fleet-list.ts";
import type { WidgetUICtx } from "./src/ui/agent-widget.ts";
import { setModelCatalog } from "./src/ui/shared.ts";

export {
	// dispatch core
	abortAgent,
	createSpawnRegistry,
	getEffectiveMaxConcurrency,
	getMaxConcurrency,
	getPiInvocation,
	isFanoutToolAllowed,
	mapWithConcurrencyLimit,
	parsePositiveInt,
	spawnAgent,
	currentSpawnDepth,
	DEFAULT_MAX_CONCURRENCY,
} from "./src/dispatch.ts";
export type {
	AgentAbortMap,
	AgentCallId,
	AgentSpawnOptions,
	AgentSpawnRegistry,
	AgentSpawnResult,
	AgentUsage,
} from "./src/dispatch.ts";

// monitor (observability singleton + types)
export { AgentMonitor, monitor } from "./src/monitor.ts";
export type {
	AgentCallEndInfo,
	AgentCallStartMeta,
	AgentCallState,
	AgentCallStatus,
} from "./src/monitor.ts";

// settings + ceiling policy
export { loadCoreSettings, MAX_CONCURRENCY_OPTIONS } from "./src/concurrency.ts";
export type { MaxConcurrencyOption, SubagentCoreSettings, WidgetMode } from "./src/concurrency.ts";

// text extraction
export { contentText, contentTextBlocks, lastAssistantText } from "./src/text.ts";

// three-source agent discovery (+ extension-registered extra dirs)
export { addAgentDir, discoverAgents } from "./agents.ts";
export type { AgentConfig, AgentDiscoveryResult, AgentScope, AgentSource } from "./agents.ts";

/** How long a finished agent is offered by /agents (mirrors the fleet linger). */
const FLEET_LINGER_MS = 4_000;

/**
 * Process-global shared UI controller (widget + fleet).
 *
 * Because pi loads every extension entry with `moduleCache: false`, two copies
 * of this package loaded in one process (e.g. a consumer's node_modules copy
 * plus a `-e` dev copy) would otherwise each construct their own AgentWidget /
 * FleetList and fight over the same setWidget keys at 12.5 Hz. Parking the
 * controller on globalThis under a registered symbol makes every copy share
 * one instance: setUICtx is idempotent for the same ctx.ui, and /agents from
 * any copy drives the same widgets.
 */
interface SharedUiController {
	readonly widget: AgentWidget;
	readonly fleet: FleetList;
}

const UI_KEY = Symbol.for("@fyeeme/pi-subagents/ui");

function getSharedUi(): SharedUiController {
	const store = globalThis as Record<symbol, unknown>;
	const existing = store[UI_KEY] as SharedUiController | undefined;
	if (existing) return existing;

	let settings: SubagentCoreSettings = {};
	try {
		settings = loadCoreSettings();
	} catch {
		/* unreadable settings → defaults below */
	}
	const widgetMode: WidgetMode = settings.widget ?? "background";

	const controller: SharedUiController = {
		widget: new AgentWidget(monitor, () => widgetMode),
		fleet: new FleetList(monitor),
	};
	if (settings.fleetView === false) controller.fleet.setEnabled(false);
	store[UI_KEY] = controller;

	// Wake the render timers on any monitor change (any package copy's
	// spawnAgent starts/ends calls). Registered exactly once per process,
	// together with the shared controller — not per session_start, which would
	// leak a listener on every /new.
	monitor.subscribe(() => {
		controller.widget.ensureTimer();
		controller.fleet.ensureTimer();
	});

	return controller;
}

/**
 * Tool-registration guard — the `subagent` tool registers ONCE per process,
 * owned by whichever extension entry composed this factory first.
 *
 * Why process-global: consumers compose this extension inside their own
 * factories (`import piSubagents from "@fyeeme/pi-subagents";
 * piSubagents(pi)`), and each pi extension load receives a DIFFERENT api
 * object, so a per-instance guard cannot dedupe across them. And it MUST
 * dedupe: pi's registerTool writes each extension's own tool map without
 * checking names, and a same-name tool in two extensions' maps is a FATAL
 * load conflict (resource-loader detectExtensionConflicts → exit(1)) — not
 * something a try/catch around registerTool can absorb.
 *
 * Everything else this factory registers is safe to repeat per extension
 * entry: the UI controller converges via globalThis, setWidget/`on` handlers
 * are idempotent for the same session (proven by the dual-entry wiring this
 * package shipped previously), and duplicate commands resolve by load order.
 */
const TOOL_REGISTERED_KEY = Symbol.for("@fyeeme/pi-subagents/tool-registered");

function markToolRegistered(): boolean {
	const store = globalThis as Record<symbol, unknown>;
	if (store[TOOL_REGISTERED_KEY] === true) return false;
	store[TOOL_REGISTERED_KEY] = true;
	return true;
}

/**
 * Release the tool-registration guard. EVERY `session_shutdown` fires
 * BEFORE pi rebuilds the extension set (shutdown → clearExtensionCache →
 * factories re-run), so the guard must be unclaimed by then — otherwise
 * every rebuilt factory sees it claimed, skips registerTool, and the
 * `subagent` tool silently disappears until restart. Releasing
 * unconditionally is safe: paths that re-run factories all fire this event
 * first, and paths that keep the Extension objects alive never run a
 * factory again (a released-but-unused guard is inert).
 */
function clearToolRegistered(): void {
	delete (globalThis as Record<symbol, unknown>)[TOOL_REGISTERED_KEY];
}

/**
 * The extension factory, also the library default export: consumers compose
 * it inside their own pi extension factories —
 *   import piSubagents from "@fyeeme/pi-subagents";
 *   export default (pi) => { piSubagents(pi); …own registrations… };
 * — which lights the `subagent` tool and the agent UI from the SAME
 * dependency copy their imports resolve to (version-pinned, no manifest
 * path wiring). The `subagent` tool registers exactly once per process
 * (markToolRegistered above).
 */
export default function subagentsUiExtension(pi: ExtensionAPI): void {
	// The fan-out tool registers only when recursion is allowed for THIS
	// process (whitelist-by-default guard, see src/dispatch.ts) and only in
	// the FIRST composing extension entry (see markToolRegistered).
	if (isFanoutToolAllowed() && markToolRegistered()) {
		try {
			pi.registerTool(subagentTool);
		} catch {
			/* registration clash — the UI surfaces still work */
		}
	}

	const { widget, fleet } = getSharedUi();

	// ---- /agents: list agents, open the selected one ----
	try {
		pi.registerCommand("agents", {
			description: "Sub-agent fleet: view agents and open their transcripts",
			handler: async (_args, ctx) => {
				try {
					const now = Date.now();
					const states = monitor
						.list()
						.filter((a) => a.status === "running" || (a.completedAt != null && now - a.completedAt < FLEET_LINGER_MS));

					if (states.length === 0) {
						ctx.ui.notify("No sub-agents have run in this session.", "info");
						return;
					}

					// Disambiguate identical rows (parallel fan-out with the default
					// displayName produces byte-identical labels): ctx.ui.select returns
					// the row text, so duplicate rows would make the indexOf below
					// resolve every selection to the first agent.
					const seen = new Map<string, number>();
					const rows = states.map((a) => {
						const icon =
							a.status === "running" ? "●" : a.status === "completed" ? "✓" : "✗";
						const label = a.description.length > 40 ? `${a.description.slice(0, 40)}…` : a.description;
						const row = `${icon} ${a.displayName} — ${label}`;
						const n = (seen.get(row) ?? 0) + 1;
						seen.set(row, n);
						return n > 1 ? `${row} (#${n})` : row;
					});
					const choice = await ctx.ui.select("Agents", rows);
					if (choice === undefined) return;

					const index = rows.indexOf(choice);
					if (index >= 0) {
						if (ctx.hasUI && ctx.mode === "tui") {
							fleet.openAgent(states[index].callId);
						} else {
							ctx.ui.notify("Agent view requires the interactive TUI.", "info");
						}
					}
				} catch (err) {
					ctx.ui.notify(`/agents failed: ${err instanceof Error ? err.message : String(err)}`, "error");
				}
			},
		});
	} catch {
		/* command registration failed (name clash etc.) — widget/fleet still work */
	}

	// ---- UI lifecycle ----
	/** Re-attach both surfaces to a UI context and refresh them. Idempotent for
	 *  the same ctx.ui (setUICtx identity early-return); used by session_start
	 *  and the tool_execution_start fallback re-connection so the two cannot
	 *  drift. */
	const rebindUi = (ui: WidgetUICtx & FleetUICtx): void => {
		try {
			widget.setUICtx(ui);
			fleet.setUICtx(ui);
			widget.update();
			fleet.update();
		} catch {
			/* ignore */
		}
	};

	pi.on("session_start", (event, ctx) => {
		// Seed the context-window index from the session catalog (ctx.modelRegistry
		// includes custom providers) so the token annotation can show NN%.
		try {
			setModelCatalog(ctx.modelRegistry.getAll());
		} catch {
			/* no catalog → percent omitted, never fatal */
		}
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		// /new starts a fresh session: drop stale monitor state so agents
		// from the previous session don't resurrect in the new widgets.
		// (Running spawns, if any, are being aborted by the session switch;
		// their late callEnded notifications are no-ops on cleared ids.)
		if (event.reason === "new") monitor.clear();
		rebindUi(ctx.ui);
	});

	// Fallback re-connection (borrowed from tintinweb/pi-subagents, which does
	// the same in its tool_execution_start handler): ctx.ui is the extension
	// runner's shared uiContext — a lazy getter whose identity only changes on
	// rebind — so this is an identity-compare no-op in the steady state. It
	// recovers two real cases:
	//   1. pi cleared extension widgets without a session_start we saw —
	//      resetExtensionUI() (before-session-invalidate, /reload) disposes
	//      widget components and clears the maps without notifying extensions;
	//   2. ctx.ui identity changed on rebind after our session_start ran —
	//      setUICtx resets the registration and update() re-registers against
	//      the fresh context.
	// Timing benefit: this fires for the very tool call that spawns sub-agents
	// (e.g. pi-review's `subagent`), so the surfaces are guaranteed registered
	// before the first callStarted notification arrives.
	pi.on("tool_execution_start", (_event, ctx) => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		rebindUi(ctx.ui);
	});

	pi.on("session_shutdown", () => {
		// Every lifecycle path that rebuilds the runtime (/reload, /new,
		// /resume, /fork, session switch) fires session_shutdown BEFORE the
		// factories re-run — release the process-global tool-registration guard
		// here, unconditionally, or each rebuilt factory sees it claimed, skips
		// registerTool, and the subagent tool vanishes until restart. Paths that
		// keep the Extension objects never re-run a factory, so releasing is
		// harmless there too.
		clearToolRegistered();
		// Prompt teardown on quit, /new, /resume, /fork, and reload: unregister
		// both widgets, stop the spinner/refresh timers, release the fleet
		// input hook, and close any open viewer. The next session_start
		// re-registers everything.
		try {
			widget.dispose();
			fleet.dispose();
		} catch {
			/* ignore */
		}
	});
}
