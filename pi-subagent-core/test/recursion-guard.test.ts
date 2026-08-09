import { describe, expect, it, vi } from "vitest";

// Mock `spawn` so spawnAgent never starts a real process; we capture the env
// it would pass to the child to assert the recursion-guard propagation.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import {
	type AgentSpawnOptions,
	type AgentSpawnRegistry,
	createSpawnRegistry,
	currentSpawnDepth,
	isFanoutToolAllowed,
	parsePositiveInt,
	spawnAgent,
} from "../index.ts";

/** Minimal fake ChildProcess whose stdout emits a clean close. */
function fakeProc(): { proc: unknown; emitClose: (code: number | null) => void } {
	const { EventEmitter } = require("node:events");
	const stdout = new EventEmitter();
	const stderr = new EventEmitter();
	const bus = new EventEmitter();
	const proc = Object.assign(bus, {
		stdout,
		stderr,
		exitCode: null as number | null,
		signalCode: null as string | null,
		kill: vi.fn(),
	});
	return {
		proc,
		emitClose: (code) => bus.emit("close", code),
	};
}

describe("parsePositiveInt", () => {
	it("parses a positive integer string", () => {
		expect(parsePositiveInt("3")).toBe(3);
		expect(parsePositiveInt("42")).toBe(42);
	});
	it("returns null for missing / empty / non-integer / non-positive", () => {
		expect(parsePositiveInt(undefined)).toBeNull();
		expect(parsePositiveInt("")).toBeNull();
		expect(parsePositiveInt("0")).toBeNull();
		expect(parsePositiveInt("-2")).toBeNull();
		expect(parsePositiveInt("2.5")).toBeNull();
		expect(parsePositiveInt("abc")).toBeNull();
	});
});

describe("currentSpawnDepth", () => {
	it("is 0 at top-level (env unset)", () => {
		expect(currentSpawnDepth({})).toBe(0);
	});
	it("reads the inherited depth", () => {
		expect(currentSpawnDepth({ PI_SUBAGENT_DEPTH: "1" })).toBe(1);
		expect(currentSpawnDepth({ PI_SUBAGENT_DEPTH: "3" })).toBe(3);
	});
	it("falls back to 0 on an invalid value", () => {
		expect(currentSpawnDepth({ PI_SUBAGENT_DEPTH: "0" })).toBe(0);
		expect(currentSpawnDepth({ PI_SUBAGENT_DEPTH: "x" })).toBe(0);
	});
});

describe("isFanoutToolAllowed (whitelist-by-default + depth cap)", () => {
	it("always allows at top-level (depth 0)", () => {
		expect(isFanoutToolAllowed({})).toBe(true);
	});
	it("denies a default child (no recursion opt-in)", () => {
		expect(isFanoutToolAllowed({ PI_SUBAGENT_DEPTH: "1" })).toBe(false);
	});
	it("allows an opted-in child below the cap", () => {
		expect(
			isFanoutToolAllowed({
				PI_SUBAGENT_DEPTH: "1",
				PI_SUBAGENT_RECURSION_ALLOWED: "1",
				PI_SUBAGENT_MAX_SPAWN_DEPTH: "3",
			}),
		).toBe(true);
	});
	it("denies an opted-in child at/above the cap", () => {
		expect(
			isFanoutToolAllowed({
				PI_SUBAGENT_DEPTH: "3",
				PI_SUBAGENT_RECURSION_ALLOWED: "1",
				PI_SUBAGENT_MAX_SPAWN_DEPTH: "3",
			}),
		).toBe(false);
		expect(
			isFanoutToolAllowed({
				PI_SUBAGENT_DEPTH: "4",
				PI_SUBAGENT_RECURSION_ALLOWED: "1",
				PI_SUBAGENT_MAX_SPAWN_DEPTH: "3",
			}),
		).toBe(false);
	});
	it("allows an opted-in child when no cap is set", () => {
		expect(
			isFanoutToolAllowed({ PI_SUBAGENT_DEPTH: "2", PI_SUBAGENT_RECURSION_ALLOWED: "1" }),
		).toBe(true);
	});
});

describe("spawnAgent recursion-guard env propagation", () => {
	// Host-env isolation: this test file may run inside a pi sub-agent session,
	// whose process.env already carries PI_SUBAGENT_DEPTH / _RECURSION_ALLOWED /
	// _MAX_SPAWN_DEPTH. childSpawnEnv computes the child depth as ambient + 1, so
	// a leaked ambient depth would turn the "depth 1" assertion into "2" and fail
	// the suite. Snapshot the three vars, clear them for the spawn, restore after.
	// The ambient-inheritance case opts out (it sets the env itself).
	const AMBIENT_KEYS = ["PI_SUBAGENT_DEPTH", "PI_SUBAGENT_RECURSION_ALLOWED", "PI_SUBAGENT_MAX_SPAWN_DEPTH"] as const;
	function withCleanAmbientEnv(fn: () => void): void {
		const saved: Partial<Record<(typeof AMBIENT_KEYS)[number], string | undefined>> = {};
		for (const k of AMBIENT_KEYS) saved[k] = process.env[k];
		for (const k of AMBIENT_KEYS) delete process.env[k];
		try {
			fn();
		} finally {
			for (const k of AMBIENT_KEYS) {
				if (saved[k] === undefined) delete process.env[k];
				else process.env[k] = saved[k];
			}
		}
	}

	function capturedEnv(opts: Partial<AgentSpawnOptions>, clearAmbient = true): NodeJS.ProcessEnv | undefined {
		let env: NodeJS.ProcessEnv | undefined;
		const capture = (): void => {
			spawnMock.mockReset();
			const { proc, emitClose } = fakeProc();
			spawnMock.mockImplementation(() => {
				// resolve asynchronously like a real proc close
				queueMicrotask(() => emitClose(0));
				return proc;
			});
			const registry: AgentSpawnRegistry = createSpawnRegistry();
			void spawnAgent(registry, {
				callId: "test",
				task: "noop",
				maxTurns: 1,
				...opts,
			});
			expect(spawnMock).toHaveBeenCalledTimes(1);
			env = spawnMock.mock.calls[0]![2]?.env as NodeJS.ProcessEnv | undefined;
		};
		if (clearAmbient) withCleanAmbientEnv(capture);
		else capture();
		return env;
	}

	it("marks a default child as recursion-disallowed and depth 1", () => {
		const env = capturedEnv({});
		expect(env?.PI_SUBAGENT_DEPTH).toBe("1");
		expect(env?.PI_SUBAGENT_RECURSION_ALLOWED).toBe("0");
	});

	it("marks an opted-in child as recursion-allowed", () => {
		const env = capturedEnv({ allowChildRecursion: true });
		expect(env?.PI_SUBAGENT_RECURSION_ALLOWED).toBe("1");
	});

	it("propagates an explicit maxSpawnDepth", () => {
		const env = capturedEnv({ allowChildRecursion: true, maxSpawnDepth: 3 });
		expect(env?.PI_SUBAGENT_MAX_SPAWN_DEPTH).toBe("3");
	});

	it("inherits an ambient maxSpawnDepth when the option is omitted", () => {
		const prev = process.env.PI_SUBAGENT_MAX_SPAWN_DEPTH;
		process.env.PI_SUBAGENT_MAX_SPAWN_DEPTH = "5";
		try {
			const env = capturedEnv({ allowChildRecursion: true }, false); // keep ambient — this case sets it itself
			expect(env?.PI_SUBAGENT_MAX_SPAWN_DEPTH).toBe("5");
		} finally {
			if (prev === undefined) delete process.env.PI_SUBAGENT_MAX_SPAWN_DEPTH;
			else process.env.PI_SUBAGENT_MAX_SPAWN_DEPTH = prev;
		}
	});
});
