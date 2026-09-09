/**
 * parity-conformance.test.ts — locks the SHARED surface between the
 * reference example (coding-agent/examples/extensions/subagent) and this
 * package's `subagent` tool: identical inputs → identical spawn argv,
 * identical delivered output, identical discovery results, and identical
 * renderer text. The example tool is loaded through its default-export
 * factory with a fake ExtensionAPI; both implementations run against the
 * same mocked `spawn` and the same user-agents fixture dir.
 *
 * ALLOWED DELTAS (documented in openspec/pi-subagents-omp-parity and this
 * package's CHANGELOG — asserted only as "pi is a documented superset",
 * never as equal):
 *  - chain mode / {previous} removed; agentScope/confirmProjectAgents are
 *    settings-file policy (discovery is three-source, so "Unknown agent"
 *    available-agents lists also include the bundled scout/planner/reviewer/
 *    worker set — the prefix text stays identical)
 *  - MAX_PARALLEL_TASKS 16 (vs 8); default concurrency 5 (vs 4, configurable)
 *  - mode conflicts / failures / invalid params throw (vs isError returns)
 *  - <result> contract extraction, Succeeded/Failed grouping, aggregate cap
 *  - watchdogs, full-output artifacts, stable ids, failure classification,
 *    context/maxTurns/outputSchema params, usage reporting, stderr tail,
 *    @file large tasks, StringDecoder, orphan-free concurrency
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { spawnImpl } = vi.hoisted(() => ({ spawnImpl: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: (...args: unknown[]) => spawnImpl(...args) }));

import { subagentTool } from "../src/tools/subagent.ts";
import { monitor } from "../src/monitor.ts";
import exampleFactory from "../../../coding-agent/examples/extensions/subagent/index.ts";

// ---------------------------------------------------------------------------
// Tool loading
// ---------------------------------------------------------------------------

interface ToolLike {
	name: string;
	execute: (
		id: string,
		params: unknown,
		signal: AbortSignal,
		onUpdate: ((partial: unknown) => void) | undefined,
		ctx: unknown,
	) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
	renderCall?: (args: unknown, theme: unknown, context: unknown) => { render(width: number): string[] };
	renderResult?: (
		result: unknown,
		opts: { expanded: boolean },
		theme: unknown,
		context: unknown,
	) => { render(width: number): string[] };
}

/** Load the example's tool definition through its default-export factory. */
function loadExampleTool(): ToolLike {
	const captured: ToolLike[] = [];
	const pi = { registerTool: (tool: ToolLike) => captured.push(tool) };
	(exampleFactory as unknown as (pi: unknown) => void)(pi);
	expect(captured).toHaveLength(1);
	expect(captured[0]!.name).toBe("subagent");
	return captured[0]!;
}

const exampleTool = loadExampleTool();

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface ProcSpec {
	stdout?: string;
	stderr?: string;
	exitCode?: number;
}

function procFromSpec(spec: ProcSpec): ChildProcess {
	const stdout = new EventEmitter();
	const stderr = new EventEmitter();
	const bus = new EventEmitter();
	const proc = Object.assign(bus, {
		stdout,
		stderr,
		exitCode: null as number | null,
		signalCode: null as string | null,
		kill: vi.fn(),
	}) as unknown as ChildProcess;
	queueMicrotask(() => {
		if (spec.stdout) stdout.emit("data", Buffer.from(spec.stdout));
		if (spec.stderr) stderr.emit("data", Buffer.from(spec.stderr));
		stdout.emit("end");
		stdout.emit("close");
		bus.emit("close", spec.exitCode ?? 0);
	});
	return proc;
}

/** One final assistant message_end NDJSON line (usage fields exercise the
 *  shared formatUsageStats rendering). */
function finalTextLine(text: string): string {
	return `${JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			usage: { input: 1200, output: 300, cacheRead: 100, cacheWrite: 0, cost: { total: 0.0025 }, totalTokens: 1600 },
			model: "prov/mod-x",
			stopReason: "end",
		},
	})}\n`;
}

function makeCtx(
	cwd: string,
	opts: { model?: { provider: string; id: string }; thinkingLevel?: string } = {},
): unknown {
	return {
		hasUI: false,
		mode: "headless",
		cwd,
		ui: {},
		model: opts.model,
		thinkingLevel: opts.thinkingLevel,
	};
}

interface RunOk {
	ok: true;
	text: string;
	isError: boolean;
	argvs: string[][];
}
interface RunErr {
	ok: false;
	message: string;
	argvs: string[][];
}
type RunResult = RunOk | RunErr;

async function runTool(
	tool: ToolLike,
	params: unknown,
	ctx: unknown,
	onUpdate?: (partial: unknown) => void,
): Promise<RunResult> {
	// Snapshot only the spawns THIS execute produced — both implementations
	// share the same spawn mock, so calls accumulate across the pair.
	const callStart = spawnImpl.mock.calls.length;
	const collectArgvs = () => spawnImpl.mock.calls.slice(callStart).map((call) => call[1] as string[]);
	try {
		const result = await tool.execute("call-1", params, new AbortController().signal, onUpdate, ctx);
		const first = result.content[0];
		return {
			ok: true,
			text: first && first.type === "text" ? (first.text ?? "") : "",
			isError: result.isError === true,
			argvs: collectArgvs(),
		};
	} catch (err) {
		return {
			ok: false,
			message: err instanceof Error ? err.message : String(err),
			argvs: collectArgvs(),
		};
	}
}

/**
 * Normalize a spawn argv into { flags, positional } so semantically identical
 * invocations compare equal across implementations (flag ORDER differs —
 * example pushes --thinking before --model, dispatch pushes --model first —
 * without changing CLI semantics; the @file temp path differs by design).
 */
function normalizeArgv(args: string[]): { flags: string[]; positional: string[] } {
	const flags: string[] = [];
	const positional: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--mode" || arg === "-p" || arg === "--no-session") {
			flags.push(arg);
		} else if (arg === "--model" || arg === "--thinking" || arg === "--tools") {
			flags.push(`${arg}=${args[i + 1]}`);
			i += 1; // consume the value; the loop's i++ moves past it
		} else if (arg === "--append-system-prompt") {
			flags.push(arg);
			i += 1; // temp path is an implementation detail
		} else {
			positional.push(arg);
		}
	}
	return { flags: [...new Set(flags)].sort(), positional };
}

// System prompts captured AT SPAWN TIME (the temp files are unlinked in each
// implementation's finally — after execute resolves they are gone). Indexed
// by spawn order across both implementations; cleared per test.
const capturedPrompts: string[] = [];

/** Install the shared spawn mock: reads the --append-system-prompt temp file
 *  synchronously, then drains `factory(args)` as a fake child process. */
function mockSpawn(factory: (argv: string[]) => ProcSpec): void {
	spawnImpl.mockImplementation((_command: unknown, args: string[]) => {
		const idx = args.indexOf("--append-system-prompt");
		if (idx >= 0 && args[idx + 1]) capturedPrompts.push(readFileSync(args[idx + 1]!, "utf-8"));
		return procFromSpec(factory(args));
	});
}

const piTool = subagentTool as unknown as ToolLike;

/** Type-guard assertions: RunResult is a union, and expect()-only checks do
 *  not narrow it for the property accesses that follow. */
function expectOk(run: RunResult): asserts run is RunOk {
	if (!run.ok) throw new Error(`expected success, got: ${JSON.stringify(run)}`);
}
function expectErr(run: RunResult): asserts run is RunErr {
	if (run.ok) throw new Error(`expected a throw, got: ${JSON.stringify(run)}`);
}

// Identity theme — rendering parity compares the RAW text both tools hand to
// the TUI, exactly the surface a user reads.
const identityTheme = { fg: (_color: unknown, text: string) => text, bold: (text: string) => text };

function componentText(component: { render(width: number): string[] }): string {
	return component
		.render(500)
		.map((line) => line.replace(/\s+$/, ""))
		.join("\n");
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let agentDir: string;
let prevAgentDir: string | undefined;

beforeEach(() => {
	spawnImpl.mockReset();
	capturedPrompts.length = 0;
	monitor.clear();
	agentDir = mkdtempSync(join(tmpdir(), "pi-sa-parity-"));
	prevAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	writeFileSync(
		join(agentDir, "agents", "conf-worker.md"),
		"---\nname: conf-worker\ndescription: parity fixture agent\ntools: read, bash\n---\nCONF-WORKER SYSTEM PROMPT\n",
	);
	// Valid-but-tools-less placeholder; the array-tools test rewrites it.
	// IMPORTANT: fixtures must be VALID YAML — the example's discovery has no
	// skip-on-malformed tolerance (it lets the parse error propagate), while
	// pi's skip+warn is a documented reliability addition covered elsewhere.
	writeFileSync(
		join(agentDir, "agents", "conf-arr.md"),
		"---\nname: conf-arr\ndescription: array tools fixture\n---\nARR PROMPT\n",
	);
	writeFileSync(
		join(agentDir, "agents", "conf-num.md"),
		"---\nname: 123\ndescription: numeric name fixture\n---\nbody\n",
	);
});

afterEach(() => {
	if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
	monitor.clear();
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Shared-surface conformance
// ---------------------------------------------------------------------------

describe("single mode conformance", () => {
	it("delivers the same output and spawns the same normalized argv", async () => {
		mockSpawn(() => ({ stdout: finalTextLine("HELLO-FROM-AGENT"), exitCode: 0 }));
		const ctx = makeCtx(agentDir);
		const ex = await runTool(exampleTool, { agent: "conf-worker", task: "do-thing" }, ctx);
		const pi = await runTool(piTool, { agent: "conf-worker", task: "do-thing" }, ctx);

		expectOk(ex);
		expectOk(pi);
		expect(ex.text).toBe("HELLO-FROM-AGENT");
		expect(pi.text).toBe("HELLO-FROM-AGENT");
		expect(ex.argvs).toHaveLength(1);
		expect(pi.argvs).toHaveLength(1);

		// Identical spawn shape: base flags + prompt positional.
		expect(normalizeArgv(pi.argvs[0]!)).toEqual(normalizeArgv(ex.argvs[0]!));
		expect(ex.argvs[0]!.at(-1)).toBe("Task: do-thing");
		expect(pi.argvs[0]!.at(-1)).toBe("Task: do-thing");

		// Both append the agent's system prompt; pi's documented superset adds
		// the <result> contract on top (allowed delta). Prompts were captured
		// at spawn time: [0] = example's spawn, [1] = pi's spawn.
		expect(capturedPrompts).toHaveLength(2);
		expect(capturedPrompts[0]).toContain("CONF-WORKER SYSTEM PROMPT");
		expect(capturedPrompts[1]).toContain("CONF-WORKER SYSTEM PROMPT");
		expect(capturedPrompts[1]).toContain("<result>");
	});

	it("inherits the session model + thinking level when the agent has no frontmatter model", async () => {
		mockSpawn(() => ({ stdout: finalTextLine("out"), exitCode: 0 }));
		const ctx = makeCtx(agentDir, { model: { provider: "prov", id: "mod-x" }, thinkingLevel: "high" });
		const ex = await runTool(exampleTool, { agent: "conf-worker", task: "t" }, ctx);
		const pi = await runTool(piTool, { agent: "conf-worker", task: "t" }, ctx);

		expectOk(ex);
		expectOk(pi);
		for (const run of [ex, pi]) {
			const norm = normalizeArgv(run.argvs[0]!);
			expect(norm.flags).toContain("--model=prov/mod-x");
			expect(norm.flags).toContain("--thinking=high");
			// Both normalize the frontmatter string "read, bash" to the joined
			// whitelist "read,bash".
			expect(norm.flags).toContain("--tools=read,bash");
		}
	});

	it("a frontmatter model pins the subprocess and suppresses thinking inheritance (both sides)", async () => {
		writeFileSync(
			join(agentDir, "agents", "conf-pinned.md"),
			"---\nname: conf-pinned\ndescription: pinned model fixture\nmodel: pinned-mod\n---\nPROMPT\n",
		);
		mockSpawn(() => ({ stdout: finalTextLine("out"), exitCode: 0 }));
		const ctx = makeCtx(agentDir, { model: { provider: "prov", id: "mod-x" }, thinkingLevel: "high" });
		const params = { agent: "conf-pinned", task: "t" };
		const ex = await runTool(exampleTool, params, ctx);
		const pi = await runTool(piTool, params, ctx);

		expect(ex.ok && pi.ok).toBe(true);
		for (const run of [ex, pi]) {
			const norm = normalizeArgv(run.argvs[0]!);
			expect(norm.flags).toContain("--model=pinned-mod");
			expect(norm.flags).not.toContain("--thinking=high");
		}
	});

	it("an unknown agent fails with the same message prefix on both sides", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const ctx = makeCtx(agentDir);
		const ex = await runTool(exampleTool, { agent: "ghost", task: "t" }, ctx);
		const pi = await runTool(piTool, { agent: "ghost", task: "t" }, ctx);
		warn.mockRestore();

		// Documented delta: example returns isError, pi throws — the text is
		// the shared contract.
		expectOk(ex);
		expect(ex.isError).toBe(true);
		expect(ex.text).toContain('Unknown agent: "ghost". Available agents: ');
		expect(ex.text).toContain('"conf-worker"');
		expectErr(pi);
		expect(pi.message).toContain('Unknown agent: "ghost". Available agents: ');
		// pi's three-source discovery lists the bundled set too (allowed delta).
		expect(pi.message).toContain('"scout"');
	});

	it("a failing subprocess reports the stderr-first output on both sides", async () => {
		const spec = { stderr: "SUBPROCESS-BOOM\n", exitCode: 1 };
		mockSpawn(() => spec);
		const ctx = makeCtx(agentDir);
		const ex = await runTool(exampleTool, { agent: "conf-worker", task: "t" }, ctx);
		const pi = await runTool(piTool, { agent: "conf-worker", task: "t" }, ctx);

		// Documented delta: return-isError vs throw. Shared: stderr surfaces.
		expectOk(ex);
		expect(ex.isError).toBe(true);
		expect(ex.text).toContain("SUBPROCESS-BOOM");
		expectErr(pi);
		expect(pi.message).toContain("SUBPROCESS-BOOM");
	});
});

describe("parallel mode conformance", () => {
	it("reports the same success header and delivers every task's output", async () => {
		mockSpawn((args) => {
			const argv = JSON.stringify(args);
			const out = argv.includes("first-task") ? "OUT-ONE" : "OUT-TWO";
			return { stdout: finalTextLine(out), exitCode: 0 };
		});
		const ctx = makeCtx(agentDir);
		const params = {
			tasks: [
				{ agent: "conf-worker", task: "first-task" },
				{ agent: "conf-worker", task: "second-task" },
			],
		};
		const ex = await runTool(exampleTool, params, ctx);
		const pi = await runTool(piTool, params, ctx);

		expectOk(ex);
		expectOk(pi);
		for (const run of [ex, pi]) {
			expect(run.text.startsWith("Parallel: 2/2 succeeded")).toBe(true);
			expect(run.text).toContain("OUT-ONE");
			expect(run.text).toContain("OUT-TWO");
			expect(run.argvs).toHaveLength(2);
		}
		// Identical normalized argv for BOTH spawns, in both implementations.
		const exNorm = ex.argvs.map((a) => JSON.stringify(normalizeArgv(a))).sort();
		const piNorm = pi.argvs.map((a) => JSON.stringify(normalizeArgv(a))).sort();
		expect(piNorm).toEqual(exNorm);
		for (const argv of [...ex.argvs, ...pi.argvs]) {
			expect(argv.at(-1)).toMatch(/^Task: (first|second)-task$/);
		}
	});
});

describe("agent discovery conformance", () => {
	it("array-form tools frontmatter parses identically on both sides", async () => {
		writeFileSync(
			join(agentDir, "agents", "conf-arr.md"),
			"---\nname: conf-arr\ndescription: array tools fixture\ntools:\n  - read\n  - bash\n---\nARR PROMPT\n",
		);
		mockSpawn(() => ({ stdout: finalTextLine("out"), exitCode: 0 }));
		const ctx = makeCtx(agentDir);
		const ex = await runTool(exampleTool, { agent: "conf-arr", task: "t" }, ctx);
		const pi = await runTool(piTool, { agent: "conf-arr", task: "t" }, ctx);

		expectOk(ex);
		expectOk(pi);
		for (const run of [ex, pi]) {
			expect(normalizeArgv(run.argvs[0]!).flags).toContain("--tools=read,bash");
		}
	});

	it("a numeric frontmatter name is skipped by both sides (not coerced to a string agent)", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const ctx = makeCtx(agentDir);
		const ex = await runTool(exampleTool, { agent: "123", task: "t" }, ctx);
		const pi = await runTool(piTool, { agent: "123", task: "t" }, ctx);
		warn.mockRestore();

		expectOk(ex);
		expect(ex.isError).toBe(true);
		expect(ex.text).toContain('Unknown agent: "123"');
		expectErr(pi);
		expect(pi.message).toContain('Unknown agent: "123"');
		expect(spawnImpl).not.toHaveBeenCalled();
	});
});

describe("renderer conformance", () => {
	function baseResult(over: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			agent: "conf-worker",
			agentSource: "user",
			task: "do-thing",
			exitCode: 0,
			messages: [{ role: "assistant", content: [{ type: "text", text: "FINAL OUTPUT" }] }],
			stderr: "",
			usage: { input: 1200, output: 300, cacheRead: 100, cacheWrite: 0, cost: 0.0025, contextTokens: 1600, turns: 2 },
			model: "prov/mod-x",
			...over,
		};
	}

	it("renderCall — single and parallel — is identical modulo the scope tag", () => {
		// Allowed delta: pi removed the agentScope wire parameter (policy moved
		// to the settings file), so its renderCall drops the example's
		// ` [scope]` tag — three-source discovery makes the tag meaningless.
		// Strip it from the example's output; everything else must match
		// verbatim.
		const ctx = {};
		const stripScope = (text: string): string => text.replace(/ \[user\]/g, "");
		for (const args of [
			{ agent: "conf-worker", task: "short task" },
			{ agent: "conf-worker", task: "a".repeat(80) },
			{ tasks: [{ agent: "conf-worker", task: "one" }, { agent: "conf-worker", task: "two" }] },
			{ tasks: Array.from({ length: 5 }, (_, i) => ({ agent: "conf-worker", task: `t${i}` })) },
		]) {
			const ex = stripScope(componentText(exampleTool.renderCall!(args, identityTheme, ctx)));
			const pi = componentText(piTool.renderCall!(args, identityTheme, ctx));
			expect(pi, `renderCall mismatch for ${JSON.stringify(args).slice(0, 60)}`).toBe(ex);
		}
	});

	it("renderResult — single collapsed and expanded — is identical", () => {
		const details = { mode: "single", results: [baseResult()] };
		const result = { content: [{ type: "text", text: "FINAL OUTPUT" }], details };
		for (const expanded of [false, true]) {
			const ex = componentText(exampleTool.renderResult!(result, { expanded }, identityTheme, {}));
			const pi = componentText(piTool.renderResult!(result, { expanded }, identityTheme, {}));
			expect(pi, `single renderResult mismatch (expanded=${expanded})`).toBe(ex);
		}
	});

	it("renderResult — single failure — is identical", () => {
		const details = {
			mode: "single",
			results: [baseResult({ exitCode: 1, stopReason: "error", errorMessage: "BOOM-MESSAGE", messages: [] })],
		};
		const result = { content: [{ type: "text", text: "Agent error: BOOM" }], details };
		for (const expanded of [false, true]) {
			const ex = componentText(exampleTool.renderResult!(result, { expanded }, identityTheme, {}));
			const pi = componentText(piTool.renderResult!(result, { expanded }, identityTheme, {}));
			expect(pi, `failure renderResult mismatch (expanded=${expanded})`).toBe(ex);
		}
	});

	it("renderResult — parallel collapsed and expanded — is identical", () => {
		const details = {
			mode: "parallel",
			results: [
				baseResult(),
				baseResult({ exitCode: 1, stopReason: "error", errorMessage: "OTHER BOOM", task: "second-task" }),
			],
		};
		const result = { content: [{ type: "text", text: "Parallel: 1/2 succeeded" }], details };
		for (const expanded of [false, true]) {
			const ex = componentText(exampleTool.renderResult!(result, { expanded }, identityTheme, {}));
			const pi = componentText(piTool.renderResult!(result, { expanded }, identityTheme, {}));
			expect(pi, `parallel renderResult mismatch (expanded=${expanded})`).toBe(ex);
		}
	});

	it("renderResult — parallel running placeholders — is identical", () => {
		const running = baseResult({ exitCode: -1, messages: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 } });
		const details = { mode: "parallel", results: [running, baseResult()] };
		const result = { content: [{ type: "text", text: "Parallel: 1/2 done, 1 running..." }], details };
		const ex = componentText(exampleTool.renderResult!(result, { expanded: false }, identityTheme, {}));
		const pi = componentText(piTool.renderResult!(result, { expanded: false }, identityTheme, {}));
		expect(pi).toBe(ex);
	});
});

describe("streaming partial conformance (per-message onUpdate)", () => {
	it("single mode re-emits partials as assistant messages arrive, then a final update", async () => {
		// Two assistant messages: partials must flow through onUpdate on both
		// implementations (example: per-message emitUpdate; pi: the new
		// onProgress seam in spawnAgent).
		const line1 = `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "PARTIAL-ONE" }], stopReason: "end" } })}\n`;
		const line2 = finalTextLine("PARTIAL-TWO");
		const spec = { stdout: line1 + line2, exitCode: 0 };
		mockSpawn(() => spec);
		const ctx = makeCtx(agentDir);
		const exPartials: string[] = [];
		const piPartials: string[] = [];
		const collect = (sink: string[]) => (partial: unknown) => {
			const p = partial as { content?: Array<{ type: string; text?: string }> };
			const first = p.content?.[0];
			if (first?.type === "text" && first.text) sink.push(first.text);
		};
		const ex = await runTool(exampleTool, { agent: "conf-worker", task: "t" }, ctx, collect(exPartials));
		const piRun = await runTool(
			piTool,
			{ agent: "conf-worker", task: "t" },
			ctx,
			collect(piPartials),
		);

		expect(ex.ok && piRun.ok).toBe(true);
		// Partials stream (not just one final update), and the last partial
		// carries the full output on both sides.
		expect(exPartials.length).toBeGreaterThanOrEqual(2);
		expect(piPartials.length).toBeGreaterThanOrEqual(2);
		expect(exPartials.at(-1)).toBe("PARTIAL-TWO");
		expect(piPartials.at(-1)).toBe("PARTIAL-TWO");
	});
});
