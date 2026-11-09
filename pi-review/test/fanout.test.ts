/**
 * fanout.test.ts — the inlined provider contracts (openspec change
 * fanout-tool-binding): the shared agent-dir registry write (discovery
 * protocol) and the spawn env recursion guard (env protocol). All pure
 * library, no pi, no provider import.
 */
import { afterEach, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { recursionAllowed, registerAgentsDir } from "../src/fanout.ts";

describe("registerAgentsDir (shared discovery symbol contract)", () => {
	const KEY = Symbol.for("@fyeeme/pi-subagents/agent-dirs");
	const store = globalThis as Record<symbol, unknown>;
	let saved: unknown;
	afterEach(() => {
		if (saved === undefined) delete store[KEY];
		else store[KEY] = saved;
	});

	it("creates the registry if absent, appends resolved dirs, is idempotent", () => {
		delete store[KEY];
		registerAgentsDir("/tmp/agents");
		registerAgentsDir("/tmp/agents");
		registerAgentsDir("/tmp/other");
		expect(store[KEY]).toEqual([resolve("/tmp/agents"), resolve("/tmp/other")]);
	});

	it("adopts an existing registry (provider loaded first)", () => {
		saved = store[KEY];
		store[KEY] = ["/already/there"];
		registerAgentsDir("/late/registration");
		expect(store[KEY]).toEqual(["/already/there", "/late/registration"]);
	});
});

describe("recursionAllowed (spawn env protocol, inline)", () => {
	it("depth 0 / unset / garbage is always allowed", () => {
		expect(recursionAllowed({})).toBe(true);
		expect(recursionAllowed({ PI_SUBAGENT_DEPTH: undefined })).toBe(true);
		expect(recursionAllowed({ PI_SUBAGENT_DEPTH: "0" })).toBe(true);
		expect(recursionAllowed({ PI_SUBAGENT_DEPTH: "abc" })).toBe(true);
	});

	it("deeper processes need explicit opt-in", () => {
		expect(recursionAllowed({ PI_SUBAGENT_DEPTH: "1" })).toBe(false);
		expect(recursionAllowed({ PI_SUBAGENT_DEPTH: "2", PI_SUBAGENT_RECURSION_ALLOWED: "1" })).toBe(true);
		expect(recursionAllowed({ PI_SUBAGENT_DEPTH: "2", PI_SUBAGENT_RECURSION_ALLOWED: "0" })).toBe(false);
	});

	it("the opt-in cap bounds the depth (strictly below)", () => {
		expect(
			recursionAllowed({ PI_SUBAGENT_DEPTH: "3", PI_SUBAGENT_RECURSION_ALLOWED: "1", PI_SUBAGENT_MAX_SPAWN_DEPTH: "3" }),
		).toBe(false);
		expect(
			recursionAllowed({ PI_SUBAGENT_DEPTH: "2", PI_SUBAGENT_RECURSION_ALLOWED: "1", PI_SUBAGENT_MAX_SPAWN_DEPTH: "3" }),
		).toBe(true);
	});
});
