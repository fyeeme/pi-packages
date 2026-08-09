/**
 * Staged resume tests (cluster B of harden-workflow-edges):
 *  - crash-resilient manifest (B1/B2): corrupt/empty/missing → run proceeds +
 *    overwrites; atomic write.
 *  - truthful per-run hit accounting (B3): RunResult.resume reflects the
 *    CURRENT run's real cache hits, not a manifest-vs-its-own-journal
 *    prediction (which always read 100%).
 */
import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineWorkflow, runWorkflow } from "../src/index.ts";
import { makeFakeDispatch } from "./e2e/helpers.ts";

const tmp = (): string => mkdtempSync(join(tmpdir(), "wf-res-"));

/** journalDir the runner derives for a given (cwd, workflowName). */
const journalDirOf = (cwd: string, name: string): string => join(cwd, ".pi", "workflows", name);

const wf = (name: string, prompt: string) =>
	defineWorkflow({ name, steps: [{ id: "a", type: "agent", prompt }] });

describe("staged resume — crash-resilient manifest (B1/B2)", () => {
	it("proceeds and overwrites a corrupt (truncated JSON) manifest, with a warning", async () => {
		const dir = tmp();
		const jdir = journalDirOf(dir, "res-corrupt");
		mkdirSync(jdir, { recursive: true });
		writeFileSync(join(jdir, "manifest.json"), "{truncated");
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const r = await runWorkflow({ workflow: wf("res-corrupt", "p"), cwd: dir, now: 1, dispatch: makeFakeDispatch() });

			expect(r.status).toBe("completed");
			expect(warnSpy).toHaveBeenCalled();
			expect(String(warnSpy.mock.calls[0]?.[0] ?? "")).toMatch(/corrupt/i);
			const raw = readFileSync(join(jdir, "manifest.json"), "utf-8");
			expect(() => JSON.parse(raw)).not.toThrow(); // overwritten with valid JSON
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("proceeds with an empty manifest file", async () => {
		const dir = tmp();
		const jdir = journalDirOf(dir, "res-empty");
		mkdirSync(jdir, { recursive: true });
		writeFileSync(join(jdir, "manifest.json"), "");
		const r = await runWorkflow({ workflow: wf("res-empty", "p"), cwd: dir, now: 1, dispatch: makeFakeDispatch() });
		expect(r.status).toBe("completed");
	});

	it("creates no manifest on first run, then a valid one", async () => {
		const dir = tmp();
		expect(existsSync(journalDirOf(dir, "res-first") + "/manifest.json")).toBe(false);
		await runWorkflow({ workflow: wf("res-first", "p"), cwd: dir, now: 1, dispatch: makeFakeDispatch() });
		const raw = readFileSync(join(journalDirOf(dir, "res-first"), "manifest.json"), "utf-8");
		const m = JSON.parse(raw) as Record<string, unknown>;
		// The manifest only carries runId/at — the key list was removed once
		// cache-hit accounting moved to observed counts (no consumer read it).
		expect(typeof m.runId).toBe("string");
		expect(typeof m.at).toBe("number");
	});
});

describe("staged resume — truthful per-run hit accounting (B3)", () => {
	it("first run: resume present, 0 hits, no previousRunId", async () => {
		const dir = tmp();
		const r = await runWorkflow({ workflow: wf("res-h1", "p"), cwd: dir, now: 1, dispatch: makeFakeDispatch() });
		expect(r.resume).toBeDefined();
		expect(r.resume?.cachedHits).toBe(0);
		expect(r.resume?.cachedTotal).toBe(1); // one agent dispatched
		expect(r.resume?.previousRunId).toBeUndefined();
	});

	it("unchanged re-run: real hits reported (agent served from cache)", async () => {
		const dir = tmp();
		const w = wf("res-h2", "same-prompt");
		await runWorkflow({ workflow: w, cwd: dir, now: 1, dispatch: makeFakeDispatch() });
		const r2 = await runWorkflow({ workflow: w, cwd: dir, now: 2, dispatch: makeFakeDispatch() });
		expect(r2.resume?.cachedHits).toBe(1);
		expect(r2.resume?.cachedTotal).toBe(1);
		expect(r2.resume?.previousRunId).toBeDefined();
	});

	it("changed prompt: 0 hits, agent re-dispatched", async () => {
		const dir = tmp();
		await runWorkflow({ workflow: wf("res-h3", "prompt-A"), cwd: dir, now: 1, dispatch: makeFakeDispatch() });
		// Same workflow name (same journal dir) but a different prompt → a
		// different cache key → miss → re-dispatch. The old key still sits in the
		// journal, proving the count is real, not a 100% self-reference.
		const r2 = await runWorkflow({ workflow: wf("res-h3", "prompt-B"), cwd: dir, now: 2, dispatch: makeFakeDispatch() });
		expect(r2.resume?.cachedHits).toBe(0);
		expect(r2.resume?.cachedTotal).toBe(1);
	});

	it("fan-out reports per-item hits (total scales with item count)", async () => {
		const dir = tmp();
		const fan = defineWorkflow({
			name: "res-h4",
			steps: [
				{
					id: "fan",
					type: "fan_out",
					over: () => [1, 2, 3],
					agent: (item) => ({ prompt: `item:${item}` }),
				},
			],
		});
		await runWorkflow({ workflow: fan, cwd: dir, now: 1, dispatch: makeFakeDispatch() });
		const r2 = await runWorkflow({ workflow: fan, cwd: dir, now: 2, dispatch: makeFakeDispatch() });
		expect(r2.resume?.cachedHits).toBe(3); // all three items cached
		expect(r2.resume?.cachedTotal).toBe(3);
	});
});
