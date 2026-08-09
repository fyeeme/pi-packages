import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type JournalEntry, Journal } from "../src/cache/journal.ts";
import { computeCacheKey } from "../src/cache/key.ts";

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-journal-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("Journal — load / append / lookup", () => {
	it("load on a fresh dir (no file) is a no-op", async () => {
		const j = new Journal({ dir });
		await j.load();
		expect(j.isLoaded).toBe(true);
		expect(j.size).toBe(0);
		expect(j.lookup("wf:missing")).toBeUndefined();
	});

	it("append result → lookup hits", async () => {
		const j = new Journal({ dir });
		await j.load();
		const key = computeCacheKey({ workflowName: "wf", prompt: "A" });
		const entry: JournalEntry<string> = { type: "result", key, at: 1, ok: true, value: "done" };
		await j.append(entry);
		expect(j.lookup(key)?.type).toBe("result");
	});

	it("result supersedes an earlier started entry with the same key", async () => {
		const key = computeCacheKey({ workflowName: "wf", prompt: "A" });
		const j = new Journal({ dir });
		await j.load();
		await j.append({ type: "started", key, at: 1 });
		await j.append({ type: "result", key, at: 2, ok: true, value: "ok" });
		const hit = j.lookup(key);
		expect(hit?.type).toBe("result");
	});
});

describe("Journal — resume (the core CC cache-hit scenario)", () => {
	it("a reloaded journal replays cached results without re-dispatch", async () => {
		const key = computeCacheKey({ workflowName: "wf", prompt: "A" });
		const entry: JournalEntry<string> = { type: "result", key, at: 1, ok: true, value: "done" };
		// First run: dispatch + record.
		{
			const j = new Journal({ dir });
			await j.load();
			await j.append(entry);
		}
		// Resumed run: same key must hit from disk, skipping dispatch.
		{
			const resumed = new Journal({ dir });
			await resumed.load();
			const hit = resumed.lookup(key);
			expect(hit?.type).toBe("result");
			expect((hit as { value?: string })?.value).toBe("done");
			expect(resumed.size).toBe(1);
		}
	});

	it("a cache-miss key returns undefined so the runner knows to dispatch", async () => {
		const j = new Journal({ dir });
		await j.load();
		await j.append({
			type: "result",
			key: computeCacheKey({ workflowName: "wf", prompt: "known" }),
			at: 1,
			ok: true,
			value: "v",
		});
		expect(j.lookup(computeCacheKey({ workflowName: "wf", prompt: "unknown" }))).toBeUndefined();
	});
});

describe("Journal — robustness", () => {
	it("skips malformed lines, keeps the valid ones", async () => {
		const keyGood = computeCacheKey({ workflowName: "wf", prompt: "good" });
		const keyTwo = computeCacheKey({ workflowName: "wf", prompt: "two" });
		const lines = [
			JSON.stringify({ type: "result", key: keyGood, at: 1, ok: true, value: "v" }),
			"this is not json",
			JSON.stringify({ type: "result", key: keyTwo, at: 2, ok: true, value: "v2" }),
		];
		fs.writeFileSync(path.join(dir, "journal.jsonl"), `${lines.join("\n")}\n`);
		const j = new Journal({ dir });
		await j.load();
		expect(j.size).toBe(2);
		expect(j.lookup(keyGood)?.type).toBe("result");
		expect(j.lookup(keyTwo)?.type).toBe("result");
	});

	it("file path is <dir>/journal.jsonl", () => {
		const j = new Journal({ dir });
		expect(j.file).toBe(path.join(dir, "journal.jsonl"));
	});

	it("a failed append does not poison the chain (writes stay best-effort, error recorded) [D8]", async () => {
		// Source-tagged P0: without the `.catch` on the append chain, a single disk
		// failure (ENOSPC/EACCES/EIO) rejects the chain forever and every later
		// append becomes a permanent silent no-op.
		const j = new Journal({ dir });
		await j.append({ type: "result", key: "k1", at: 1, ok: true, value: "v1" });
		expect(j.writeError).toBeUndefined();

		// Make the journal file read-only so subsequent appends fail with EACCES.
		const file = path.join(dir, "journal.jsonl");
		fs.chmodSync(file, 0o444);
		try {
			// These resolve (caught on the chain) rather than throwing...
			await j.append({ type: "result", key: "k2", at: 2, ok: true, value: "v2" });
			await j.append({ type: "result", key: "k3", at: 3, ok: true, value: "v3" });
			expect(j.writeError).toBeTruthy(); // ...and the failure is recorded.
		} finally {
			fs.chmodSync(file, 0o644); // restore so afterEach can rmSync the dir
		}
	});
});
