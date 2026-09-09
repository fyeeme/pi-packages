/**
 * subagent-tool.test.ts — wire-level behavior of the `subagent` tool:
 * parameter validation, shared-context prepending, and result shapes that
 * need no real subprocess (dispatch's node:child_process.spawn is mocked).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir as td } from "node:os";
import { join } from "node:path";
import { subagentTool } from "../src/tools/subagent.ts";

const spawnImpl = vi.fn((_command: string, _args: string[], _opts: unknown) => fakeProc());
const spawnMock = vi.mocked(spawnImpl);
vi.mock("node:child_process", () => ({
	spawn: (...args: Parameters<typeof spawnImpl>) => spawnImpl(...args),
}));

function fakeCtx(): Record<string, unknown> {
	return {
		hasUI: false,
		mode: "headless",
		cwd: "/tmp",
		ui: {},
	};
}

/** Minimal fake ChildProcess closing immediately so spawnAgent resolves. */
function fakeProc(): ChildProcess {
	const stdout = new EventEmitter();
	const stderr = new EventEmitter();
	const bus = new EventEmitter();
	// Structurally identical shape; the ChildProcess interface cannot be
	// constructed directly, hence the single named cast.
	const proc = Object.assign(bus, {
		stdout,
		stderr,
		exitCode: null as number | null,
		signalCode: null as string | null,
		kill: vi.fn(),
	}) as unknown as ChildProcess;
	queueMicrotask(() => {
		stdout.emit("end");
		stdout.emit("close");
		bus.emit("close", 0);
	});
	return proc;
}


/** Fake ChildProcess that streams one final assistant message (oversized
 *  outputs drive the artifact-path truncation marker) before closing. */
function procWithFinalText(text: string): ChildProcess {
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
	const line = JSON.stringify({ type: "message_end", message: { role: "assistant", content: text } });
	queueMicrotask(() => {
		stdout.emit("data", Buffer.from(line + String.fromCharCode(10)));
		stdout.emit("end");
		stdout.emit("close");
		bus.emit("close", 0);
	});
	return proc;
}

beforeEach(() => {
	spawnMock.mockReset();
	spawnMock.mockImplementation(() => fakeProc());
});

describe("subagent tool parameter validation", () => {
	it("rejects maxTurns: 0 with a range message (throws: returning never sets isError)", async () => {
		await expect(
			subagentTool.execute!(
				"call-1",
				{ agent: "scout", task: "t", maxTurns: 0 } as never,
				new AbortController().signal,
				undefined,
				fakeCtx() as never,
			),
		).rejects.toThrow("Invalid maxTurns: 0");
	});

	it("rejects negative and non-integer maxTurns (throws)", async () => {
		for (const bad of [-3, 2.5]) {
			await expect(
				subagentTool.execute!(
					"call-1",
					{ agent: "scout", task: "t", maxTurns: bad } as never,
					new AbortController().signal,
					undefined,
					fakeCtx() as never,
				),
			).rejects.toThrow(`Invalid maxTurns: ${bad}`);
		}
	});

	// pi passes args through unvalidated, so a task entry missing required
	// fields used to slip through as a wasted dispatch wave returning N
	// "Unknown agent: undefined" results — it must be rejected up front.
	it("rejects a parallel task entry missing the agent field, with the wire format hint", async () => {
		await expect(
			subagentTool.execute!(
				"call-1",
				{ tasks: [{ task: "Angle A — diff scan" }] } as never,
				new AbortController().signal,
				undefined,
				fakeCtx() as never,
			),
		).rejects.toThrow('Invalid tasks[0]');
	});

	it("rejects empty-string and missing task fields, naming the entry index", async () => {
		await expect(
			subagentTool.execute!(
				"call-1",
				{ tasks: [{ agent: "scout", task: "" }] } as never,
				new AbortController().signal,
				undefined,
				fakeCtx() as never,
			),
		).rejects.toThrow("Invalid tasks[0]");

		// Index naming must point at the offending entry, not the first.
		await expect(
			subagentTool.execute!(
				"call-1",
				{ tasks: [{ agent: "scout", task: "ok" }, { agent: "scout" }] } as never,
				new AbortController().signal,
				undefined,
				fakeCtx() as never,
			),
		).rejects.toThrow("Invalid tasks[1]");
	});
});

describe("renderCall malformed-args fallback", () => {
	const identityTheme = { fg: (_color: unknown, text: string) => text, bold: (text: string) => text };

	it("renders a missing task agent as ? instead of undefined", () => {
		const component = subagentTool.renderCall!(
			{ tasks: [{ task: "Angle A — diff scan" }] } as never,
			identityTheme as never,
			{} as never,
		);
		const text = component.render(500).join("\n");
		expect(text).toContain("? Angle A — diff scan");
		expect(text).not.toContain("undefined");
	});

	it("a missing task text renders as ... instead of crashing", () => {
		const component = subagentTool.renderCall!(
			{ tasks: [{ agent: "scout" }] } as never,
			identityTheme as never,
			{} as never,
		);
		const text = component.render(500).join("\n");
		expect(text).toContain("scout ...");
	});
});

describe("shared context parameter", () => {
	it("prepends context to every task in parallel mode", async () => {
		await subagentTool.execute!(
			"call-1",
			{
				context: "SHARED-BACKGROUND",
				tasks: [
					{ agent: "scout", task: "first-task" },
					{ agent: "scout", task: "second-task" },
				],
			} as never,
			new AbortController().signal,
			undefined,
			fakeCtx() as never,
		);
		expect(spawnMock).toHaveBeenCalledTimes(2);
		const argvs = spawnMock.mock.calls.map(([, args]) => JSON.stringify(args));
		const first = argvs.find((a) => a.includes("first-task"));
		const second = argvs.find((a) => a.includes("second-task"));
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		for (const argvJson of [first, second]) {
			const parsed: string[] = JSON.parse(argvJson!);
			const prompt = parsed.join(" ");
			expect(prompt.indexOf("SHARED-BACKGROUND")).toBeGreaterThanOrEqual(0);
		}
	});
});

/** Fake ChildProcess that fails like a provider outage: stderr tail with a
 *  transient-class pattern, non-zero exit. */
function transientFailProc(): ChildProcess {
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
		stderr.emit("data", Buffer.from("ProviderError: connect ECONNRESET"));
		bus.emit("close", 1);
	});
	return proc;
}

describe("parallel output truncation and artifacts", () => {
	it("a truncated output points at the full-output artifact; details carry outputPath", async () => {
		spawnMock.mockImplementation(() => procWithFinalText("Y".repeat(60 * 1024)));
		const result = await subagentTool.execute!(
			"call-1",
			{ tasks: [{ agent: "scout", task: "big-task" }] } as never,
			new AbortController().signal,
			undefined,
			fakeCtx() as never,
		);
		const text = result.content[0];
		expect(text.type === "text" && text.text).toContain("Output truncated:");
		// The aggregate cap keeps the artifact pointer visible.
		expect(text.type === "text" && /pi-subagents\//.test(text.text)).toBe(true);
		const details = result.details as { results: Array<{ outputPath?: string }> };
		expect(details.results[0]?.outputPath).toBeTruthy();
	});

	it("a truncated SINGLE-agent delivery carries the per-task artifact pointer", async () => {
		// The single-agent path has no aggregate cap around it, so the
		// per-task suffix (`Full output: <path>`) must survive verbatim — this
		// is the coverage the old parallel assertion used to provide before
		// the aggregate cap started cutting the suffix out of that scenario.
		spawnMock.mockImplementation(() => procWithFinalText("Y".repeat(60 * 1024)));
		const result = await subagentTool.execute!(
			"call-1",
			{ agent: "scout", task: "big-single" } as never,
			new AbortController().signal,
			undefined,
			fakeCtx() as never,
		);
		const text = result.content[0];
		expect(text.type === "text" && text.text).toContain("Output truncated:");
		expect(text.type === "text" && text.text).toContain("Full output: ");
		expect(text.type === "text" && /pi-subagents\//.test(text.text)).toBe(true);
		const details = result.details as { results: Array<{ outputPath?: string }> };
		expect(details.results[0]?.outputPath).toBeTruthy();
	});

	it("running partials keep the -1 running sentinel (parallel progress stays truthful)", async () => {
		// The subprocess emits one assistant message, then stays open until we
		// release it. While it runs, the tool's streaming updates must report
		// the task as RUNNING (-1) — not done (0) — so "X/N done, Y running"
		// stays truthful for tasks that have output but no exit yet.
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		spawnMock.mockImplementation(((_command: string) => {
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
				stdout.emit(
					"data",
					Buffer.from(
						`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "PARTIAL" }] } })}\n`,
					),
				);
			});
			void gate.then(() => {
				stdout.emit(
					"data",
					Buffer.from(
						`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "FINAL" }] } })}\n`,
					),
				);
				bus.emit("close", 0);
			});
			return proc;
		}) as never);
		const exitCodes: number[] = [];
		const p = subagentTool.execute!(
			"call-1",
			{ agent: "scout", task: "sentinel" } as never,
			new AbortController().signal,
			(partial: unknown) => {
				const details = (partial as { details?: { results?: Array<{ exitCode?: number }> } }).details;
				const first = details?.results?.[0];
				if (first) exitCodes.push(first.exitCode ?? -999);
			},
			fakeCtx() as never,
		);
		// Wait for the partial to land while the subprocess is "open". Polling
		// instead of a fixed sleep: reaching this point involves real async
		// temp-file writes, and a fixed 10ms is not reliable under load.
		for (let i = 0; i < 200 && exitCodes.length === 0; i++) {
			await new Promise((r) => setTimeout(r, 5));
		}
		expect(exitCodes.length).toBeGreaterThan(0);
		expect(exitCodes.every((code) => code === -1)).toBe(true); // running, never miscounted as done
		release();
		const result = await p;
		expect(exitCodes.at(-1)).toBe(0); // the final update carries the real exit code
		const details = result.details as { results: Array<{ exitCode?: number }> };
		expect(details.results[0]?.exitCode).toBe(0);
	});

	it("an under-cap output passes through without a truncation marker", async () => {
		spawnMock.mockImplementation(() => procWithFinalText("short and sweet"));
		const result = await subagentTool.execute!(
			"call-1",
			{ tasks: [{ agent: "scout", task: "small-task" }] } as never,
			new AbortController().signal,
			undefined,
			fakeCtx() as never,
		);
		const text = result.content[0];
		expect(text.type === "text" && text.text.includes("short and sweet")).toBe(true);
		expect(text.type === "text" && text.text.includes("Output truncated")).toBe(false);
	});
});

describe("result contract", () => {
	it("the <result> block is delivered and details record the extraction method", async () => {
		const body = "narration first\n<result>CONTRACT-ANSWER</result>";
		spawnMock.mockImplementation(() => procWithFinalText(body));
		// The contract prompt must ride --append-system-prompt.
		const result = await subagentTool.execute!(
			"call-1",
			{ tasks: [{ agent: "scout", task: "contract-task" }] } as never,
			new AbortController().signal,
			undefined,
			fakeCtx() as never,
		);
		const text = result.content[0];
		expect(text.type === "text" && text.text.includes("CONTRACT-ANSWER")).toBe(true);
		expect(text.type === "text" && text.text.includes("narration first")).toBe(false);
		expect(text.type === "text" && /extracted:/.test(text.text)).toBe(false); // silent on contract hit
		const details = result.details as { results: Array<{ extractMethod?: string }> };
		expect(details.results[0]?.extractMethod).toBe("result-block");
	});

	it("every spawn's appended system prompt carries the result-contract instruction", async () => {
		// The system prompt rides a temp file passed to --append-system-prompt,
		// unlinked again in spawnAgent's finally — so capture its content AT
		// spawn time from inside the mocked spawn.
		const { readFileSync } = await import("node:fs");
		const captured: string[] = [];
		spawnMock.mockImplementationOnce(((_command: string, args: string[]) => {
			const idx = args.indexOf("--append-system-prompt");
			if (idx >= 0 && args[idx + 1]) captured.push(readFileSync(args[idx + 1], "utf-8"));
			return fakeProc();
		}) as never);
		await subagentTool.execute!(
			"call-1",
			{ agent: "scout", task: "single-task" } as never,
			new AbortController().signal,
			undefined,
			fakeCtx() as never,
		);
		expect(captured.length).toBe(1);
		expect(captured[0]).toContain("<result>");
	});
});

describe("structured output (outputSchema / schemaMode)", () => {
	it("strict mode rejects a payload that violates the schema, with error details", async () => {
		spawnMock.mockImplementation(() => procWithFinalText("<result>{\"name\": 123}</result>"));
		// Strict rejection is a tool error: it throws (pi sets isError on the
		// thrown message; a returned value never sets the error flag). The
		// child's success stopReason ("stop") must NOT label the failure — the
		// message reads "Agent failed: ..." instead.
		await expect(
			subagentTool.execute!(
				"call-1",
				{
					agent: "scout",
					task: "strict-task",
					outputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
					schemaMode: "strict",
				} as never,
				new AbortController().signal,
				undefined,
				fakeCtx() as never,
			),
		).rejects.toThrow(/^Agent failed: output failed JSON Schema validation/);
	});

	it("permissive mode (default) passes the original text through with a warning", async () => {
		spawnMock.mockImplementation(() => procWithFinalText("<result>not json at all</result>"));
		const result = await subagentTool.execute!(
			"call-1",
			{
				tasks: [
					{
						agent: "scout",
						task: "lenient-task",
						outputSchema: { type: "object", properties: { name: { type: "string" } } },
					},
				],
			} as never,
			new AbortController().signal,
			undefined,
			fakeCtx() as never,
		);
		const text = result.content[0];
		expect(text.type === "text" && text.text).toContain("not json at all"); // original preserved
		// The warning rides the delivered text AND the details.
		expect(text.type === "text" && text.text).toContain("schema ignored");
		const details = result.details as { results: Array<{ schemaWarning?: string }> };
		expect(details.results[0]?.schemaWarning).toContain("schema ignored");
	});

	it("a valid JSON payload passes strict validation cleanly and the prompt carries the schema", async () => {
		let capturedPrompt = "";
		spawnMock.mockImplementation(((_command: string, args: string[]) => {
			const idx = args.indexOf("--append-system-prompt");
			if (idx >= 0 && args[idx + 1]) capturedPrompt = readFileSync(args[idx + 1], "utf-8");
			return procWithFinalText('<result>{"name": "ok"}</result>');
		}) as never);
		const result = await subagentTool.execute!(
			"call-1",
			{
				agent: "scout",
				task: "valid-task",
				outputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
				schemaMode: "strict",
			} as never,
			new AbortController().signal,
			undefined,
			fakeCtx() as never,
		);
		const details = result.details as { results: Array<{ schemaValid?: boolean }> };
		expect(details.results[0]?.schemaValid).toBe(true);
		expect(capturedPrompt).toContain("Structured output");
		expect(capturedPrompt).toContain("\"required\"");
	});
});

describe("failure classification and replay grouping", () => {
	it("mixed batches group by outcome; failures carry class and task summary", async () => {
		spawnMock.mockImplementation(((_command: string, args: string[]) => {
			const argv = JSON.stringify(args);
			return argv.includes("doomed-task") ? transientFailProc() : procWithFinalText("all good");
		}) as never);
		const result = await subagentTool.execute!(
			"call-1",
			{
				tasks: [
					{ agent: "scout", task: "healthy-task one" },
					{ agent: "scout", task: "doomed-task two" },
				],
			} as never,
			new AbortController().signal,
			undefined,
			fakeCtx() as never,
		);
		const text = result.content[0];
		expect(text.type === "text" && text.text).toContain("Parallel: 1/2 succeeded");
		expect(text.type === "text" && text.text).toContain("## Succeeded (1)");
		expect(text.type === "text" && text.text).toContain("## Failed (1) — replay these");
		expect(text.type === "text" && text.text).toContain("class: transient");
		expect(text.type === "text" && text.text).toContain("Task: doomed-task two"); // replay targeting
		const details = result.details as { results: Array<{ failureClass?: string; taskSummary?: string }> };
		expect(details.results[0]?.failureClass).toBeUndefined();
		expect(details.results[0]?.taskSummary).toBe("healthy-task one"); // context-free first line
		expect(details.results[1]?.failureClass).toBe("transient");
	});
});

describe("spec anchors: ids, wire schema, trust gate, frontmatter schema", () => {
	it("duplicate same-name tasks in one call get distinct stable ids (spec: uniquified)", async () => {
		const result = await subagentTool.execute!(
			"call-1",
			{
				tasks: [
					{ agent: "scout", task: "dup-a" },
					{ agent: "scout", task: "dup-b" },
				],
			} as never,
			new AbortController().signal,
			undefined,
			fakeCtx() as never,
		);
		const details = result.details as { results: Array<{ id?: string }> };
		const [a, b] = details.results;
		expect(a?.id).toMatch(/^[A-Z][a-z]+[A-Z][a-z]+$/);
		expect(b?.id).toMatch(/^[A-Z][a-z]+[A-Z][a-z]+$/);
		expect(a?.id).not.toBe(b?.id);
	});

	it("the wire schema exposes no discovery/trust policy parameters (spec: no policy params)", () => {
		const props = Object.keys((subagentTool.parameters as unknown as { properties: Record<string, unknown> }).properties);
		expect(props).not.toContain("agentScope");
		expect(props).not.toContain("confirmProjectAgents");
		expect(props).toEqual(expect.arrayContaining(["agent", "task", "tasks", "context"]));
	});

	it("trust gate: interactive sessions prompt before project agents; refusal cancels before any spawn", async () => {
		const dir = mkdtempSync(join(td(), "pi-sa-gate-"));
		mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
		writeFileSync(
			join(dir, ".pi", "agents", "pa.md"),
			"---\nname: pa\ndescription: project agent\n---\nbody\n",
		);
		try {
			const confirm = vi.fn(async () => false);
			const ctx = { hasUI: true, mode: "tui", cwd: dir, ui: { confirm } } as never;
			const refused = await subagentTool.execute!(
				"call-1",
				{ agent: "pa", task: "gated-task" } as never,
				new AbortController().signal,
				undefined,
				ctx,
			);
			const text = refused.content[0];
			expect(text.type === "text" && text.text).toContain("Canceled");
			expect(confirm).toHaveBeenCalledTimes(1);
			expect(spawnMock).not.toHaveBeenCalled(); // nothing spawned on refusal

			spawnMock.mockImplementation(() => procWithFinalText("<result>ok</result>"));
			const approved = await subagentTool.execute!(
				"call-2",
				{ agent: "pa", task: "gated-task" } as never,
				new AbortController().signal,
				undefined,
				{ hasUI: true, mode: "tui", cwd: dir, ui: { confirm: async () => true } } as never,
			);
			expect(spawnMock).toHaveBeenCalled();
			const d = approved.details as { results: Array<{ id?: string }> };
			expect(d.results[0]?.id).toBeTruthy();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("confirmation can be disabled only via the settings file, never the wire", async () => {
		const dir = mkdtempSync(join(td(), "pi-sa-nogate-"));
		mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
		writeFileSync(join(dir, ".pi", "agents", "pa.md"), "---\nname: pa\ndescription: project agent\n---\nbody\n");
		writeFileSync(join(dir, ".pi", "pi-subagent.json"), JSON.stringify({ confirmProjectAgents: false }));
		try {
			const confirm = vi.fn(async () => true);
			await subagentTool.execute!(
				"call-1",
				{ agent: "pa", task: "ungated" } as never,
				new AbortController().signal,
				undefined,
				{ hasUI: true, mode: "tui", cwd: dir, ui: { confirm } } as never,
			);
			expect(confirm).not.toHaveBeenCalled(); // settings off → no prompt at all
			expect(spawnMock).toHaveBeenCalled();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("frontmatter output: validates when the caller passes no outputSchema (permissive warns)", async () => {
		const dir = mkdtempSync(join(td(), "pi-sa-fm-"));
		mkdirSync(join(dir, ".pi"), { recursive: true });
		writeFileSync(join(dir, ".pi", "pi-subagent.json"), JSON.stringify({ confirmProjectAgents: false }));
		const agentsDir = join(dir, ".pi", "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(
			join(agentsDir, "structured.md"),
			[
				"---",
				"name: fm-structured",
				"description: frontmatter schema agent",
				"output:",
				"  type: object",
				"  properties:",
				"    summary:",
				"      type: string",
				"---",
				"body",
			].join("\n"),
		);
		spawnMock.mockImplementation(() => procWithFinalText("<result>plain text, not json</result>"));
		try {
			const result = await subagentTool.execute!(
				"call-1",
				{ agent: "fm-structured", task: "fm-task" } as never,
				new AbortController().signal,
				undefined,
				{ hasUI: false, mode: "headless", cwd: dir, ui: {} } as never,
			);
			const text = result.content[0];
			expect(text.type === "text" && text.text).toContain("plain text, not json"); // original preserved
			const details = result.details as { results: Array<{ schemaWarning?: string }> };
			expect(details.results[0]?.schemaWarning).toContain("schema ignored");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
