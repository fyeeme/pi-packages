import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ContextEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BOOTSTRAP_CONTENT, registerBootstrap } from "../src/bootstrap.ts";
import defaultExport from "../index.ts";
import { withPrefsIsolation } from "./helpers.ts";

type Handler = (event: unknown) => unknown;

function mockBootstrapPi() {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on(event: string, handler: Handler) {
			const arr = handlers.get(event) ?? [];
			arr.push(handler);
			handlers.set(event, arr);
		},
	} as unknown as ExtensionAPI;
	const emit = (event: string, payload?: unknown): unknown => {
		let result: unknown;
		for (const h of handlers.get(event) ?? []) result = h(payload ?? {});
		return result;
	};
	return { pi, emit, count: (e: string) => handlers.get(e)?.length ?? 0 };
}

const userMsg = (text: string): ContextEvent["messages"][number] =>
	({ role: "user", content: [{ type: "text", text }], timestamp: 0 }) as ContextEvent["messages"][number];

describe("registerBootstrap", () => {
	it("injects the ask-matt guidance after session_start when no marker present", () => {
		const { pi, emit } = mockBootstrapPi();
		registerBootstrap(pi);
		emit("session_start", { type: "session_start", reason: "startup" });
		const result = emit("context", { type: "context", messages: [] }) as
			| { messages: ContextEvent["messages"] }
			| undefined;
		expect(result?.messages).toHaveLength(1);
		const injected = (result!.messages[0] as { content: { text: string }[] }).content[0].text;
		expect(injected).toContain("ask-matt");
		expect(injected).toContain("mattpocock-skills-bootstrap-v1");
	});

	it("does not inject after agent_end (flag cleared)", () => {
		const { pi, emit } = mockBootstrapPi();
		registerBootstrap(pi);
		emit("session_start");
		emit("agent_end", { type: "agent_end", messages: [] });
		const result = emit("context", { type: "context", messages: [] });
		expect(result).toBeUndefined();
	});

	it("re-injects after session_compact", () => {
		const { pi, emit } = mockBootstrapPi();
		registerBootstrap(pi);
		emit("session_start");
		emit("context", { type: "context", messages: [] });
		emit("agent_end");
		emit("session_compact", { type: "session_compact" });
		const result = emit("context", { type: "context", messages: [] });
		expect(result).toBeDefined();
	});

	it("skips injection when messages already contain the marker", () => {
		const { pi, emit } = mockBootstrapPi();
		registerBootstrap(pi);
		emit("session_start");
		const existing = [userMsg(BOOTSTRAP_CONTENT)];
		const result = emit("context", { type: "context", messages: existing });
		expect(result).toBeUndefined();
	});

	it("re-injects after session_compact even when the compaction summary echoes the marker", () => {
		const { pi, emit } = mockBootstrapPi();
		registerBootstrap(pi);
		emit("session_start");
		emit("context", { type: "context", messages: [] });
		emit("agent_end");
		emit("session_compact", { type: "session_compact" });
		const summary = {
			role: "compactionSummary",
			content: `earlier messages summarized... ${BOOTSTRAP_CONTENT}`,
			summary: `earlier messages summarized... ${BOOTSTRAP_CONTENT}`,
			tokensBefore: 1000,
			timestamp: 0,
		} as ContextEvent["messages"][number];
		const result = emit("context", { type: "context", messages: [summary] }) as
			| { messages: ContextEvent["messages"] }
			| undefined;
		expect(result?.messages).toHaveLength(2);
	});

	it("registers exactly one handler each for session_start, session_compact, agent_end, context", () => {
		const { pi, count } = mockBootstrapPi();
		registerBootstrap(pi);
		expect(count("session_start")).toBe(1);
		expect(count("session_compact")).toBe(1);
		expect(count("agent_end")).toBe(1);
		expect(count("context")).toBe(1);
	});
});

/**
 * The index gate now reads prefs + env (next-session semantics). Tests pin
 * MATTPOCOCK_PREFS_FILE to a tmpdir so the "default off" case is hermetic and
 * does not depend on a real ~/.pi/agent/mattpocock.json.
 */
describe("index bootstrap gate (prefs + env)", () => {
	let iso: { prefsPath: string; restore: () => void };

	beforeEach(() => {
		iso = withPrefsIsolation();
	});
	afterEach(() => iso.restore());

	function gatePi() {
		const events: string[] = [];
		const pi = {
			registerCommand: () => {},
			on(event: string) {
				events.push(event);
			},
		} as unknown as ExtensionAPI;
		return { pi, events };
	}

	it("registers no bootstrap handlers by default (no env, no prefs)", () => {
		const { pi, events } = gatePi();
		defaultExport(pi);
		expect(events).toHaveLength(0);
	});

	it("registers bootstrap handlers when MATTPOCOCK_ENABLE_BOOTSTRAP=1", () => {
		process.env.MATTPOCOCK_ENABLE_BOOTSTRAP = "1";
		const { pi, events } = gatePi();
		defaultExport(pi);
		expect(events).toContain("context");
	});

	it("registers bootstrap handlers when prefs.bootstrap is true (no env)", () => {
		writeFileSync(iso.prefsPath, JSON.stringify({ bootstrap: true }));
		const { pi, events } = gatePi();
		defaultExport(pi);
		expect(events).toContain("context");
	});
});

describe("/matt-bootstrap command", () => {
	let iso: { prefsPath: string; restore: () => void };

	beforeEach(() => {
		iso = withPrefsIsolation();
	});
	afterEach(() => iso.restore());

	function loadCommand() {
		const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
		const notified: { msg: string; level: string }[] = [];
		const ctx = {
			ui: {
				notify(msg: string, level: string) {
					notified.push({ msg, level });
				},
			},
		};
		const pi = {
			registerCommand(name: string, opts: { handler: (args: string, ctx: unknown) => Promise<void> }) {
				commands.set(name, opts);
			},
			on() {},
		} as unknown as ExtensionAPI;
		defaultExport(pi);
		return { commands, notified, ctx };
	}

	it("is always registered", () => {
		const { commands } = loadCommand();
		expect(commands.has("matt-bootstrap")).toBe(true);
	});

	it("on -> persists bootstrap:true and notifies", async () => {
		const { commands, notified, ctx } = loadCommand();
		await commands.get("matt-bootstrap")?.handler("on", ctx);
		expect(JSON.parse(readFileSync(iso.prefsPath, "utf-8"))).toEqual({ bootstrap: true });
		expect(notified[0].msg).toContain("on");
	});

	it("off -> persists bootstrap:false and notifies", async () => {
		const { commands, ctx } = loadCommand();
		await commands.get("matt-bootstrap")?.handler("on", ctx);
		await commands.get("matt-bootstrap")?.handler("off", ctx);
		expect(JSON.parse(readFileSync(iso.prefsPath, "utf-8"))).toEqual({ bootstrap: false });
	});

	it("no arg -> toggles the current persisted value", async () => {
		const { commands, ctx } = loadCommand();
		await commands.get("matt-bootstrap")?.handler("", ctx);
		expect(JSON.parse(readFileSync(iso.prefsPath, "utf-8")).bootstrap).toBe(true);
		await commands.get("matt-bootstrap")?.handler("", ctx);
		expect(JSON.parse(readFileSync(iso.prefsPath, "utf-8")).bootstrap).toBe(false);
	});

	it("notify mentions next-session semantics", async () => {
		const { commands, notified, ctx } = loadCommand();
		await commands.get("matt-bootstrap")?.handler("on", ctx);
		expect(notified[0].msg).toContain("next session");
	});
});
