/**
 * extension.test.ts — lifecycle unit tests for the UI extension entry,
 * driven through a fake ExtensionAPI + fake ui context (no real TUI).
 *
 * Covers the registration contract and the session-lifecycle teardown the
 * extension promises: session_shutdown unregisters both widgets promptly,
 * and /new clears stale monitor state so nothing resurrects.
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

const WIDGET_KEY = "pi-subagents:agents";
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
	it("session_start registers the above widget and the below-editor fleet", () => {
		const pi = fakePi();
		const { setWidget, ui } = fakeUi();
		extensionFactory(pi as never);

		seedAgent();
		pi.emit("session_start", { type: "session_start", reason: "startup" }, fakeCtx(ui, projDir));

		const keys = registeredKeys(setWidget);
		expect(keys).toContain(WIDGET_KEY);
		expect(keys).toContain(FLEET_KEY);
		const fleetCall = setWidget.mock.calls.find((c) => c[0] === FLEET_KEY && typeof c[1] === "function");
		expect(fleetCall?.[2]).toEqual({ placement: "belowEditor" });
		const widgetCall = setWidget.mock.calls.find((c) => c[0] === WIDGET_KEY && typeof c[1] === "function");
		expect(widgetCall?.[2]).toEqual({ placement: "aboveEditor" });
	});

	it("registers the /agents command", () => {
		const pi = fakePi();
		extensionFactory(pi as never);
		expect(pi.registerCommand).toHaveBeenCalledWith("agents", expect.objectContaining({ handler: expect.any(Function) }));
	});

	it("session_shutdown (quit) unregisters both surfaces promptly", () => {
		const pi = fakePi();
		const { setWidget, ui } = fakeUi();
		extensionFactory(pi as never);

		seedAgent();
		pi.emit("session_start", { type: "session_start", reason: "startup" }, fakeCtx(ui, projDir));
		setWidget.mockClear();

		pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, fakeCtx(ui, projDir));

		const cleared = setWidget.mock.calls.filter((c) => c[1] === undefined).map((c) => c[0] as string);
		expect(cleared).toEqual(expect.arrayContaining([WIDGET_KEY, FLEET_KEY]));
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

	it("widget: off — the above widget never registers, the fleet still does", () => {
		writeProject({ widget: "off" });
		const pi = fakePi();
		const { setWidget, ui } = fakeUi();
		extensionFactory(pi as never);

		seedAgent();
		pi.emit("session_start", { type: "session_start", reason: "startup" }, fakeCtx(ui, projDir));

		const keys = registeredKeys(setWidget);
		expect(keys).not.toContain(WIDGET_KEY);
		expect(keys).toContain(FLEET_KEY);
	});

	it("fleetView: false — the fleet never registers and never captures input", () => {
		writeProject({ fleetView: false });
		const pi = fakePi();
		const { setWidget, ui, inputHandlers } = fakeUi();
		extensionFactory(pi as never);

		seedAgent();
		pi.emit("session_start", { type: "session_start", reason: "startup" }, fakeCtx(ui, projDir));

		const keys = registeredKeys(setWidget);
		expect(keys).toContain(WIDGET_KEY);
		expect(keys).not.toContain(FLEET_KEY);

		// The inert input hook lets the down arrow (↓) flow through to the editor.
		expect(inputHandlers.length).toBeGreaterThan(0);
		for (const handler of inputHandlers) {
			expect(handler("\x1b[B")).toBeUndefined(); // press, empty editor — still not consumed
		}
	});

	it("fleetView: false still exposes the viewer through /agents", async () => {
		writeProject({ fleetView: false });
		const pi = fakePi();
		const { setWidget, ui } = fakeUi();
		extensionFactory(pi as never);

		seedAgent();
		pi.emit("session_start", { type: "session_start", reason: "startup" }, fakeCtx(ui, projDir));

		const command = pi.registerCommand.mock.calls.find((c) => c[0] === "agents")?.[1] as {
			handler: (args: string, ctx: any) => Promise<void>;
		};
		expect(command).toBeDefined();
		// openAgent goes through the ui captured at session_start (fakeUi's),
		// not the command ctx — route the ctx's custom to the same spy.
		const select = vi.fn(async () => "● Agent — Do work");
		const notify = vi.fn();
		await command.handler("", {
			hasUI: true,
			mode: "tui",
			ui: { select, notify, custom: ui.custom, setWidget },
		});
		expect(ui.custom).toHaveBeenCalledTimes(1); // viewer overlay opened despite fleet being off
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
			for (const key of [WIDGET_KEY, FLEET_KEY]) {
				const call = setWidget.mock.calls.find((c) => c[0] === key && typeof c[1] === "function");
				const factory = call?.[1] as (tui: unknown, theme: unknown) => { invalidate(): void };
				factory(undefined, undefined).invalidate();
			}
		};
		invalidateAll();
		setWidget.mockClear();

		pi.emit("tool_execution_start", { type: "tool_execution_start", toolCallId: "t1" }, fakeCtx(ui, projDir));

		const keys = registeredKeys(setWidget);
		expect(keys).toContain(WIDGET_KEY);
		expect(keys).toContain(FLEET_KEY);
	});

	it("tool_execution_start re-captures a rebound ctx.ui (fresh object)", () => {
		const pi = fakePi();
		const { setWidget: setWidget1, ui: ui1 } = fakeUi();
		const { setWidget: setWidget2, ui: ui2 } = fakeUi(); // rebind → new uiContext identity
		extensionFactory(pi as never);

		seedAgent();
		pi.emit("session_start", { type: "session_start", reason: "startup" }, fakeCtx(ui1, projDir));
		expect(registeredKeys(setWidget1)).toContain(WIDGET_KEY);

		// The rebind surfaces here first — no session_start for us afterwards.
		pi.emit("tool_execution_start", { type: "tool_execution_start", toolCallId: "t1" }, fakeCtx(ui2, projDir));

		// Re-registered against the NEW context (its setWidget), not the stale one.
		const keys2 = registeredKeys(setWidget2);
		expect(keys2).toContain(WIDGET_KEY);
		expect(keys2).toContain(FLEET_KEY);
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

	it("tool_execution_start alone wakes the surfaces when session_start never bound a UI", () => {
		const pi = fakePi();
		const { setWidget, ui } = fakeUi();
		extensionFactory(pi as never);

		seedAgent();
		// session_start filtered out (e.g. hasUI false at that moment)…
		const filteredCtx = fakeCtx(ui, projDir) as { hasUI: boolean };
		filteredCtx.hasUI = false;
		pi.emit("session_start", { type: "session_start", reason: "startup" }, filteredCtx);
		expect(registeredKeys(setWidget)).toHaveLength(0);

		// …but the first tool execution re-captures and registers.
		pi.emit("tool_execution_start", { type: "tool_execution_start", toolCallId: "t1" }, fakeCtx(ui, projDir));
		const keys = registeredKeys(setWidget);
		expect(keys).toContain(WIDGET_KEY);
		expect(keys).toContain(FLEET_KEY);
	});

	it("after shutdown, a resume re-registers the surfaces (monitor state kept)", () => {
		const pi = fakePi();
		const { setWidget, ui } = fakeUi();
		extensionFactory(pi as never);

		seedAgent();
		pi.emit("session_start", { type: "session_start", reason: "startup" }, fakeCtx(ui, projDir));
		pi.emit("session_shutdown", { type: "session_shutdown", reason: "resume" }, fakeCtx(ui, projDir));
		setWidget.mockClear();

		pi.emit("session_start", { type: "session_start", reason: "resume" }, fakeCtx(ui, projDir));
		// The running agent is still in the monitor → surfaces re-register.
		expect(monitor.list().length).toBe(1);
		const keys = registeredKeys(setWidget);
		expect(keys).toContain(WIDGET_KEY);
		expect(keys).toContain(FLEET_KEY);
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
		// /agents and lifecycle handlers may repeat per entry — idempotent.
		expect(a.registerCommand).toHaveBeenCalledTimes(1);
		expect(b.registerCommand).toHaveBeenCalledTimes(1);
	});

	it("a fresh process (flag unset) registers normally", () => {
		delete (globalThis as Record<symbol, unknown>)[TOOL_FLAG];
		const pi = fakePi();
		const factory = extensionFactory as unknown as (pi: unknown) => void;
		factory(pi);
		expect(pi.registerTool).toHaveBeenCalledTimes(1);
	});
});
