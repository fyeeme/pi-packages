import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BOOTSTRAP_CONTENT_FOR_TEST, registerBootstrap } from "../src/bootstrap.ts";
import defaultExport from "../index.ts";

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

const userMsg = (text: string): AgentMessage =>
	({ role: "user", content: [{ type: "text", text }], timestamp: 0 }) as AgentMessage;

describe("registerBootstrap", () => {
	it("injects the ask-matt guidance after session_start when no marker present", () => {
		const { pi, emit } = mockBootstrapPi();
		registerBootstrap(pi);
		emit("session_start", { type: "session_start", reason: "startup" });
		const result = emit("context", { type: "context", messages: [] }) as
			| { messages: AgentMessage[] }
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
		const existing = [userMsg(BOOTSTRAP_CONTENT_FOR_TEST)];
		const result = emit("context", { type: "context", messages: existing });
		expect(result).toBeUndefined();
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

describe("index env gate (MATTPOCOCK_ENABLE_BOOTSTRAP)", () => {
	const original = process.env.MATTPOCOCK_ENABLE_BOOTSTRAP;
	beforeEach(() => {
		delete process.env.MATTPOCOCK_ENABLE_BOOTSTRAP;
	});
	afterEach(() => {
		if (original === undefined) delete process.env.MATTPOCOCK_ENABLE_BOOTSTRAP;
		else process.env.MATTPOCOCK_ENABLE_BOOTSTRAP = original;
	});

	it("registers no bootstrap handlers by default (commands only)", () => {
		const events: string[] = [];
		const pi = {
			registerCommand: () => {},
			on(event: string) {
				events.push(event);
			},
		} as unknown as ExtensionAPI;
		defaultExport(pi);
		expect(events).toHaveLength(0);
	});

	it("registers bootstrap handlers when MATTPOCOCK_ENABLE_BOOTSTRAP=1", () => {
		process.env.MATTPOCOCK_ENABLE_BOOTSTRAP = "1";
		const events: string[] = [];
		const pi = {
			registerCommand: () => {},
			on(event: string) {
				events.push(event);
			},
		} as unknown as ExtensionAPI;
		defaultExport(pi);
		expect(events.length).toBeGreaterThan(0);
		expect(events).toContain("context");
	});
});
