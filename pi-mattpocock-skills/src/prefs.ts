import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Env var pi honors to override the agent directory (see pi's getAgentDir). */
const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";
/** Optional override for where this extension stores its prefs file. */
const ENV_PREFS_FILE = "MATTPOCOCK_PREFS_FILE";
const PREFS_FILENAME = "mattpocock.json";

/**
 * Resolve the pi agent directory, mirroring pi's `getAgentDir()` without
 * value-importing it — a value import would pull the coding-agent agent-session
 * graph into tests and the extension runtime. Honors `PI_CODING_AGENT_DIR`
 * (expanding a leading `~`) and falls back to `~/.pi/agent`.
 */
export function getAgentDir(): string {
	const envDir = process.env[ENV_AGENT_DIR];
	if (envDir) return expandTilde(envDir);
	return join(homedir(), ".pi", "agent");
}

function expandTilde(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	if (p.startsWith("~\\")) return join(homedir(), p.slice(2));
	return p;
}

/** Path to the persisted prefs file. Honors `MATTPOCOCK_PREFS_FILE` override. */
export function getPrefsPath(): string {
	const override = process.env[ENV_PREFS_FILE];
	if (override) return override;
	return join(getAgentDir(), PREFS_FILENAME);
}

export interface MattpocockPrefs {
	/** Whether the opt-in ask-matt bootstrap guidance is enabled. Default: false. */
	bootstrap: boolean;
}

/** Read persisted prefs; a missing or corrupt file yields the defaults (off). */
export function readPrefs(path: string = getPrefsPath()): MattpocockPrefs {
	try {
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw) as Partial<MattpocockPrefs>;
		return { bootstrap: parsed.bootstrap === true };
	} catch {
		return { bootstrap: false };
	}
}

/**
 * Persist prefs, creating or overwriting the file (parent dir created on
 * demand, so a fresh agent dir or a custom `MATTPOCOCK_PREFS_FILE` target
 * cannot fail with ENOENT). Returns the prefs written.
 */
export function writePrefs(prefs: MattpocockPrefs, path: string = getPrefsPath()): MattpocockPrefs {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(prefs, null, 2)}\n`, "utf-8");
	return prefs;
}

/**
 * Whether bootstrap handlers should register at startup. `MATTPOCOCK_ENABLE_BOOTSTRAP=1`
 * is a one-shot enable override (forces on for this process); otherwise the
 * persisted pref decides. The enable-only env cannot force off — use the
 * `/matt-bootstrap off` command (which persists) instead.
 */
export function isBootstrapEnabled(path: string = getPrefsPath()): boolean {
	if (process.env.MATTPOCOCK_ENABLE_BOOTSTRAP === "1") return true;
	return readPrefs(path).bootstrap;
}
