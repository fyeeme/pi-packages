/**
 * extension.test.ts — lifecycle unit tests for the UI extension entry,
 * driven through a fake ExtensionAPI + fake ui context (no real TUI).
 *
 * Covers the registration contract and the session-lifecycle teardown the
 * extension promises: session_shutdown unregisters the fleet surface
 * promptly, and /new clears stale monitor state so nothing resurrects.
 *
 * The shared controller is cached on globalThis (Symbol.for); each test drops
 * it (plus the monitor state) so per-test settings files take effect.
 * Project-layer settings are read via process.cwd() — hence the chdir.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extensionFactory from "../index.ts";
import { monitor } from "../src/monitor.ts";

const FLEET_KEY = "pi-subagents:fleet";
const UI_KEY = Symbol.for("@fyeeme/pi-subagents/ui");

type Handler = (event: any, ctx: any) => unknown;

/** Minimal fake ExtensionAPI: collects `on` handlers, records commands. */
function fakePi() {
	const handlers = new Map<string, Handler[]>();
	return {
		registerCommand: vi.fn(),
		registerTool: vi.fn(),
		on(event: string, handler: Handler): void {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		emit(event: string, arg: unknown, ctx: unknown): void {
			for (const handler of handlers.get(event) ?? []) handler(arg, ctx);
		},
		handlers,
	};
}

/** Fake ui context: records setWidget calls + captured input handlers. */
function fakeUi() {
	const setWidget = vi.fn();
	const inputHandlers: Array<(data: string) => unknown> = [];
	return {
		setWidget,
		inputHandlers,
		ui: {
			setWidget,
			onTerminalInput: (handler: (data: string) => unknown) => {
				inputHandlers.push(handler);
				return () => {};
			},
			getEditorText: () => "",
			notify: vi.fn(),
			custom: vi.fn(async () => undefined),
		},
	};
}

function fakeCtx(ui: unknown, cwd: string): unknown {
	return {
		hasUI: true,
		mode: "tui",
		ui,
		cwd,
		modelRegistry: { getAll: () => [{ id: "m-1", contextWindow: 10_000 }] },
	};
}

/** Seed one agent; settle it when status === "completed". */
function seedAgent(callId = "a1", status: "running" | "completed" = "running"): void {
	const messages: unknown[] = [];
	monitor.callStarted({ callId, task: "Do work", controller: new AbortController(), messages: messages as never });
	if (status === "completed") {
		monitor.callEnded(callId, { exitCode: 0, aborted: false, maxTurnsReached: false });
	}
}

let globalDir: string;
let projDir: string;
let prevCwd: string;

beforeEach(() => {
	globalDir = mkdtempSync(join(tmpdir(), "pi-sa-eg-"));
	projDir = mkdtempSync(join(tmpdir(), "pi-sa-ep-"));
	process.env.PI_CODING_AGENT_DIR = globalDir;
	prevCwd = process.cwd();
	process.chdir(projDir);
	delete (globalThis as Record<symbol, unknown>)[UI_KEY];
	delete (globalThis as Record<symbol, unknown>)[Symbol.for("@fyeeme/pi-subagents/tool-registered")];
	monitor.clear();
});

afterEach(() => {
	process.chdir(prevCwd);
	delete process.env.PI_CODING_AGENT_DIR;
	rmSync(globalDir, { recursive: true, force: true });
	rmSync(projDir, { recursive: true, force: true });
	monitor.clear();
});

function writeProject(obj: unknown): void {
	mkdirSync(join(projDir, ".pi"), { recursive: true });
	writeFileSync(join(projDir, ".pi", "pi-subagent.json"), JSON.stringify(obj));
}

/** The setWidget keys registered so far (factories only, not teardown calls). */
function registeredKeys(setWidget: ReturnType<typeof vi.fn>): string[] {
	return setWidget.mock.calls
		.filter((call) => typeof call[1] === "function")
		.map((call) => call[0] as string);
}

describe("extension lifecycle", () => {
	it("session_start registers the below-editor fleet surface (the single UI)", () => {
		const pi = fakePi();
		const { setWidget, ui } = fakeUi();
		extensionFactory(pi as never);

		seedAgent();
		pi.emit("session_start", { type: "session_start", reason: "startup" }, fakeCtx(ui, projDir));

		const keys = registeredKeys(setWidget);
		expect(keys).toEqual([FLEET_KEY]);
		const fleetCall = setWidget.mock.calls.find((c) => c[0] === FLEET_KEY && typeof c[1] === "function");
		expect(fleetCall?.[2]).toEqual({ placement: "belowEditor" });
	});

	it("session_shutdown (quit) unregisters the fleet surface promptly", () => {
		const pi = fakePi();
		const { setWidget, ui } = fakeUi();
		extensionFactory(pi as never);

		seedAgent();
		pi.emit("session_start", { type: "session_start", reason: "startup" }, fakeCtx(ui, projDir));
		setWidget.mockClear();

		pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, fakeCtx(ui, projDir));

		const cleared = setWidget.mock.calls.filter((c) => c[1] === undefined).map((c) => c[0] as string);
		expect(cleared).toContain(FLEET_KEY);
		expect(setWidget.mock.calls.filter((c) => typeof c[1] === "function")).toHaveLength(0);
	});

	it("/new clears stale monitor state and nothing resurrects on the fresh session", () => {
		const pi = fakePi();
		const { setWidget, ui } = fakeUi();
		extensionFactory(pi as never);

		seedAgent("a1", "completed"); // stale finished agent from the old session
		pi.emit("session_start", { type: "session_start", reason: "startup" }, fakeCtx(ui, projDir));

		pi.emit("session_shutdown", { type: "session_shutdown", reason: "new" }, fakeCtx(ui, projDir));
		setWidget.mockClear();
		pi.emit("session_start", { type: "session_start", reason: "new" }, fakeCtx(ui, projDir));

		expect(monitor.list()).toEqual([]);
		expect(setWidget).not.toHaveBeenCalled(); // nothing to show → no registration
	});

	it("fleet: false — the fleet never registers and never captures input", () => {
		writeProject({ fleet: false });
		const pi = fakePi();
		const { setWidget, ui, inputHandlers } = fakeUi();
		extensionFactory(pi as never);

		seedAgent();
		pi.emit("session_start", { type: "session_start", reason: "startup" }, fakeCtx(ui, projDir));

		expect(registeredKeys(setWidget)).toEqual([]);

		// The inert input hook lets the down arrow (↓) flow through to the editor.
		expect(inputHandlers.length).toBeGreaterThan(0);
		for (const handler of inputHandlers) {
			expect(handler("\x1b[B")).toBeUndefined(); // press, empty editor — still not consumed
		}
	});

	it("legacy widget/fleetView settings are ignored — the fleet stays on by default", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		writeProject({ widget: "background", fleetView: false });
		const pi = fakePi();
		const { setWidget, ui, inputHandlers } = fakeUi();
		extensionFactory(pi as never);

		seedAgent();
		pi.emit("session_start", { type: "session_start", reason: "startup" }, fakeCtx(ui, projDir));

		// fleetView/widget warned + ignored → the merged default (on) applies.
		expect(registeredKeys(setWidget)).toEqual([FLEET_KEY]);
		// And the surface is live: ↓ at an empty editor activates it.
		const handler = inputHandlers[inputHandlers.length - 1]!;
		expect(handler("\x1b[B")).toEqual({ consume: true });
		warn.mockRestore();
	});

	it("tool_execution_start re-registers after the registration was lost (component invalidate)", () => {
		const pi = fakePi();
		const { setWidget, ui } = fakeUi();
		extensionFactory(pi as never);

		seedAgent();
		pi.emit("session_start", { type: "session_start", reason: "startup" }, fakeCtx(ui, projDir));

		// pi signals "re-render from scratch" via each component's invalidate()
		// (e.g. theme switch): our flags reset while agents keep running. The
		// registered values are FACTORIES — pi invokes them to build components.
		const invalidateAll = () => {
			const call = setWidget.mock.calls.find((c) => c[0] === FLEET_KEY && typeof c[1] === "function");
			const factory = call?.[1] as (tui: unknown, theme: unknown) => { invalidate(): void };
			factory(undefined, undefined).invalidate();
		};
		invalidateAll();
		setWidget.mockClear();

		pi.emit("tool_execution_start", { type: "tool_execution_start", toolCallId: "t1" }, fakeCtx(ui, projDir));

		expect(registeredKeys(setWidget)).toEqual([FLEET_KEY]);
	});

	it("tool_execution_start re-captures a rebound ctx.ui (fresh object)", () => {
		const pi = fakePi();
		const { setWidget: setWidget1, ui: ui1 } = fakeUi();
		const { setWidget: setWidget2, ui: ui2 } = fakeUi(); // rebind → new uiContext identity
		extensionFactory(pi as never);

		seedAgent();
		pi.emit("session_start", { type: "session_start", reason: "startup" }, fakeCtx(ui1, projDir));
		expect(registeredKeys(setWidget1)).toEqual([FLEET_KEY]);

		// The rebind surfaces here first — no session_start for us afterwards.
		pi.emit("tool_execution_start", { type: "tool_execution_start", toolCallId: "t1" }, fakeCtx(ui2, projDir));

		// Re-registered against the NEW context (its setWidget), not the stale one.
		expect(registeredKeys(setWidget2)).toEqual([FLEET_KEY]);
	});

	it("tool_execution_start is a no-op in the steady state (same ctx.ui → no re-registration)", () => {
		const pi = fakePi();
		const { setWidget, ui } = fakeUi();
		extensionFactory(pi as never);

		seedAgent();
		pi.emit("session_start", { type: "session_start", reason: "startup" }, fakeCtx(ui, projDir));
		const registeredAfterStart = setWidget.mock.calls.filter((c) => typeof c[1] === "function").length;
		expect(registeredAfterStart).toBeGreaterThan(0);

		for (let i = 0; i < 3; i++) {
			pi.emit("tool_execution_start", { type: "tool_execution_start", toolCallId: `t${i}` }, fakeCtx(ui, projDir));
		}
		// Identity unchanged → setUICtx early-returned; no factory re-registration.
		expect(setWidget.mock.calls.filter((c) => typeof c[1] === "function")).toHaveLength(registeredAfterStart);
	});

	it("tool_execution_start alone wakes the surface when session_start never bound a UI", () => {
		const pi = fakePi();
		const { setWidget, ui } = fakeUi();
		extensionFactory(pi as never);

		seedAgent();
		// session_start filtered out (e.g. hasUI false at that moment)…
		const filteredCtx = fakeCtx(ui, projDir) as { hasUI: boolean };
		filteredCtx.hasUI = false;
		pi.emit("session_start", { type: "session_start", reason: "startup" }, filteredCtx);
		expect(registeredKeys(setWidget)).toEqual([]);

		// …but the first tool execution re-captures and registers.
		pi.emit("tool_execution_start", { type: "tool_execution_start", toolCallId: "t1" }, fakeCtx(ui, projDir));
		expect(registeredKeys(setWidget)).toEqual([FLEET_KEY]);
	});

	it("after shutdown, a resume re-registers the surface (monitor state kept)", () => {
		const pi = fakePi();
		const { setWidget, ui } = fakeUi();
		extensionFactory(pi as never);

		seedAgent();
		pi.emit("session_start", { type: "session_start", reason: "startup" }, fakeCtx(ui, projDir));
		pi.emit("session_shutdown", { type: "session_shutdown", reason: "resume" }, fakeCtx(ui, projDir));
		setWidget.mockClear();

		pi.emit("session_start", { type: "session_start", reason: "resume" }, fakeCtx(ui, projDir));
		// The running agent is still in the monitor → the surface re-registers.
		expect(monitor.list().length).toBe(1);
		expect(registeredKeys(setWidget)).toEqual([FLEET_KEY]);
	});
});

describe("composition guard (consumer-composed factories)", () => {
	const TOOL_FLAG = Symbol.for("@fyeeme/pi-subagents/tool-registered");

	it("a second composition in the same process does not re-register the tool (fatal cross-extension conflict otherwise)", () => {
		delete (globalThis as Record<symbol, unknown>)[TOOL_FLAG];
		const a = fakePi();
		const b = fakePi(); // each pi extension load receives a different api object
		const factory = extensionFactory as unknown as (pi: unknown) => void;
		factory(a);
		factory(b);

		// Exactly one tool registration process-wide — pi fatal-exits when the
		// same tool name lands in two different extensions' maps.
		expect(a.registerTool).toHaveBeenCalledTimes(1);
		expect(b.registerTool).toHaveBeenCalledTimes(0);
	});

	it("a fresh process (flag unset) registers normally", () => {
		delete (globalThis as Record<symbol, unknown>)[TOOL_FLAG];
		const pi = fakePi();
		const factory = extensionFactory as unknown as (pi: unknown) => void;
		factory(pi);
		expect(pi.registerTool).toHaveBeenCalledTimes(1);
	});

	it("session_shutdown (reload) releases the guard so reloaded factories re-register the tool", () => {
		delete (globalThis as Record<symbol, unknown>)[TOOL_FLAG];
		const first = fakePi();
		extensionFactory(first as never);
		expect(first.registerTool).toHaveBeenCalledTimes(1);

		// /reload: session_shutdown fires before the factories re-run
		// (AgentSession.reload: shutdown → clearExtensionCache → factories).
		first.emit(
			"session_shutdown",
			{ type: "session_shutdown", reason: "reload" },
			fakeCtx(fakeUi().ui, projDir),
		);

		const reloaded = fakePi(); // a factory re-run in the same process
		extensionFactory(reloaded as never);
		expect(reloaded.registerTool).toHaveBeenCalledTimes(1);
	});

	it("session_shutdown (new/resume/fork/quit — non-reload rebuilds) also releases the guard", () => {
		delete (globalThis as Record<symbol, unknown>)[TOOL_FLAG];
		const first = fakePi();
		extensionFactory(first as never);
		expect(first.registerTool).toHaveBeenCalledTimes(1);

		// pi 0.84.x rebuilds the runtime for /new, /resume, /fork and session
		// switches too (not just /reload): factories re-run after shutdown.
		// Every reason must release the guard or the subagent tool silently
		// disappears until process restart (observed on a /new after startup).
		for (const reason of ["new", "resume", "fork", "quit"] as const) {
			first.emit("session_shutdown", { type: "session_shutdown", reason }, fakeCtx(fakeUi().ui, projDir));
			const rebuilt = fakePi(); // a factory re-run in the same process
			extensionFactory(rebuilt as never);
			expect(rebuilt.registerTool).toHaveBeenCalledTimes(1);
		}
	});
});
