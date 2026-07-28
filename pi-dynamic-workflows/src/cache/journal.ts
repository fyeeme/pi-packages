/**
 * Per-run journal of agent call results — the pi port of CC's `ews` class.
 *
 * One JSONL file per run (<dir>/journal.jsonl). Each line is either a
 * `started` marker (an agent dispatched) or a `result` (an agent settled with
 * a value). On resume, the journal is loaded into an in-memory map keyed by
 * CacheKey; `result` entries supersede earlier `started` entries for the same
 * key. The runner consults `lookup()` before dispatching: a hit means replay,
 * skipping the subprocess entirely.
 *
 * Append-only within a run; resume reads the existing file, then the resumed
 * run continues appending entries for cache-miss agents.
 *
 * Determinism note: `at` is an opaque counter/timestamp supplied by the caller
 * (from the run's deterministic inception time, never Date.now() inside the
 * workflow body — the Task 3 sandbox forbids that).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { CacheKey } from "../types.ts";

export type JournalEntry<T = unknown> =
	| { readonly type: "started"; readonly key: CacheKey; readonly at: number }
	| { readonly type: "result"; readonly key: CacheKey; readonly at: number; readonly ok: boolean; readonly value: T };

export interface JournalOptions {
	/** Directory holding journal.jsonl (typically <cwd>/.pi/workflows/runs/<runId>). */
	readonly dir: string;
}

export class Journal {
	private readonly filePath: string;
	/** key → latest entry. result entries supersede started entries. */
	private readonly results = new Map<CacheKey, JournalEntry>();
	private loaded = false;

	constructor(opts: JournalOptions) {
		this.filePath = path.join(opts.dir, "journal.jsonl");
	}

	/** Read the JSONL file into the in-memory map. A missing file (fresh run) is a no-op. */
	async load(): Promise<void> {
		let content: string;
		try {
			content = await fs.promises.readFile(this.filePath, "utf-8");
		} catch (e) {
			if (!isENOENT(e)) throw e;
			this.loaded = true;
			return;
		}
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			let entry: JournalEntry;
			try {
				entry = JSON.parse(line) as JournalEntry;
			} catch {
				continue; // skip malformed line, keep the rest
			}
			if (entry.type === "result") this.results.set(entry.key, entry);
		}
		this.loaded = true;
	}

	/** Look up a settled result by cache key. Undefined = cache miss → must dispatch. */
	lookup(key: CacheKey): JournalEntry | undefined {
		return this.results.get(key);
	}

	/** Append an entry to disk and (for result entries) the in-memory map. */
	private appendChain: Promise<void> = Promise.resolve();
	private lastWriteError: unknown;
	async append(entry: JournalEntry): Promise<void> {
		if (entry.type === "result") this.results.set(entry.key, entry);
		// Serialize appends: concurrent appendFile calls interleave bytes for
		// entries larger than PIPE_BUF (4KB on Linux), corrupting JSONL lines that
		// Journal.load then silently drops. Chain each write onto the previous.
		//
		// P0 fix: catch on the chain so a single disk failure (ENOSPC/EACCES/EIO)
		// does NOT poison it forever — without the catch, every later `.then`
		// never runs its callback, so all subsequent writes become permanent
		// silent no-ops while `lookup()` keeps returning the in-memory entries.
		// The failed write is recorded in `lastWriteError` for the caller.
		const line = JSON.stringify(entry) + "\n";
		this.appendChain = this.appendChain
			.then(() => fs.promises.appendFile(this.filePath, line, "utf-8"))
			.catch((e) => {
				this.lastWriteError = e;
			});
		return this.appendChain;
	}

	/** Number of cached results currently in memory. */
	get size(): number {
		return this.results.size;
	}

	get file(): string {
		return this.filePath;
	}

	get isLoaded(): boolean {
		return this.loaded;
	}

	/** The most recent disk-write error, if any. A non-null value means at least
	 * one entry may be in memory but not on disk → resume could lose it. */
	get writeError(): unknown {
		return this.lastWriteError;
	}
}

function isENOENT(e: unknown): boolean {
	return e !== null && typeof e === "object" && (e as { code?: string }).code === "ENOENT";
}
