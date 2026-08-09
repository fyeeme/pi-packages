/**
 * Per-run journal of agent call results — the pi port of CC.s LocalFileJournal.
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

/** Staged-resume manifest: identifies the last completed run. Only `runId` is
 *  consumed downstream (resume.previousRunId); cache-hit accounting is observed
 *  live during the run, so no key list is persisted here. */
export interface RunManifest {
	/** Run ID that produced this manifest. */
	readonly runId: string;
	/** Inception timestamp. */
	readonly at: number;
}

export interface JournalOptions {
	/** Directory holding journal.jsonl (typically <cwd>/.pi/workflows/runs/<runId>). */
	readonly dir: string;
}

/** Monotonic counter for unique manifest temp-file names (crash-safe atomic writes). */
let manifestSeq = 0;

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

	/** Iterator over all entries in the in-memory cache. */
	allEntries(): IterableIterator<JournalEntry> {
		return this.results.values();
	}

	/** Write the staged-resume manifest for the next run to consume.
	 *  Call after the run completes successfully. Written atomically
	 *  (write-temp + rename) so a crash between truncate and write can never
	 *  leave a 0-byte / truncated manifest that would crash future runs. */
	async writeManifest(manifest: RunManifest): Promise<void> {
		const dir = path.dirname(this.filePath);
		const manifestPath = path.join(dir, "manifest.json");
		const tmp = path.join(dir, `.manifest.${process.pid}.${manifestSeq++}.tmp`);
		// Sweep stale tmp files from crashed prior writes BEFORE writing ours — a
		// post-write sweep would match (and delete) the file we are about to
		// rename from.
		await this.sweepStaleTmp(dir);
		await fs.promises.writeFile(tmp, JSON.stringify(manifest, null, 2), "utf-8");
		await fs.promises.rename(tmp, manifestPath);
	}

	private async sweepStaleTmp(dir: string): Promise<void> {
		try {
			const entries = await fs.promises.readdir(dir);
			await Promise.all(
				entries
					.filter((e) => e.startsWith(".manifest.") && e.endsWith(".tmp"))
					.map((e) => fs.promises.unlink(path.join(dir, e)).catch(() => {})),
			);
		} catch {
			/* best-effort */
		}
	}

	/** Load the staged-resume manifest from the last completed run, if present.
	 *  Best-effort and crash-resilient: a missing file is the normal
	 *  pre-first-run state; a corrupt/truncated file (e.g. after a crash
	 *  mid-write) is treated as "no manifest" with a warning — it MUST never
	 *  crash the run. The next successful run overwrites it. */
	async loadManifest(): Promise<RunManifest | undefined> {
		const manifestPath = path.join(path.dirname(this.filePath), "manifest.json");
		let raw: string;
		try {
			raw = await fs.promises.readFile(manifestPath, "utf-8");
		} catch (e) {
			if (isENOENT(e)) return undefined; // normal pre-first-run state
			console.warn(`[pi-dynamic-workflows] manifest read failed, ignoring: ${(e as Error).message}`);
			return undefined;
		}
		try {
			return JSON.parse(raw) as RunManifest;
		} catch (e) {
			console.warn(`[pi-dynamic-workflows] manifest is corrupt, ignoring: ${(e as Error).message}`);
			return undefined;
		}
	}
}

function isENOENT(e: unknown): boolean {
	return e !== null && typeof e === "object" && (e as { code?: string }).code === "ENOENT";
}
