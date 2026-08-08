import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENV_BOOTSTRAP = "MATTPOCOCK_ENABLE_BOOTSTRAP";
const ENV_PREFS_FILE = "MATTPOCOCK_PREFS_FILE";

/**
 * Isolate prefs/env for one test block: points `MATTPOCOCK_PREFS_FILE` at a
 * fresh tmpdir file and clears `MATTPOCOCK_ENABLE_BOOTSTRAP`. Call `restore()`
 * in `afterEach` to bring back the caller's environment — saves and restores
 * both env vars so tests never leak into or out of the suite.
 */
export function withPrefsIsolation(): { prefsPath: string; restore: () => void } {
	const savedBootstrap = process.env[ENV_BOOTSTRAP];
	const savedPrefsFile = process.env[ENV_PREFS_FILE];
	const dir = mkdtempSync(join(tmpdir(), "mp-prefs-"));
	const prefsPath = join(dir, "mattpocock.json");
	process.env[ENV_PREFS_FILE] = prefsPath;
	delete process.env[ENV_BOOTSTRAP];
	return {
		prefsPath,
		restore() {
			if (savedBootstrap === undefined) delete process.env[ENV_BOOTSTRAP];
			else process.env[ENV_BOOTSTRAP] = savedBootstrap;
			if (savedPrefsFile === undefined) delete process.env[ENV_PREFS_FILE];
			else process.env[ENV_PREFS_FILE] = savedPrefsFile;
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
