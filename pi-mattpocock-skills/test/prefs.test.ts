import { readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getAgentDir,
	isBootstrapEnabled,
	readPrefs,
	writePrefs,
	type MattpocockPrefs,
} from "../src/prefs.ts";
import { withPrefsIsolation } from "./helpers.ts";

describe("getAgentDir", () => {
	const original = process.env.PI_CODING_AGENT_DIR;

	afterEach(() => {
		if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = original;
	});

	it("falls back to ~/.pi/agent when the env is unset", () => {
		delete process.env.PI_CODING_AGENT_DIR;
		expect(getAgentDir()).toBe(join(homedir(), ".pi", "agent"));
	});

	it("honors PI_CODING_AGENT_DIR as-is", () => {
		process.env.PI_CODING_AGENT_DIR = "/custom/agent";
		expect(getAgentDir()).toBe("/custom/agent");
	});

	it("expands a leading ~ in PI_CODING_AGENT_DIR", () => {
		process.env.PI_CODING_AGENT_DIR = "~/custom";
		expect(getAgentDir()).toBe(join(homedir(), "custom"));
	});
});

describe("readPrefs", () => {
	it("returns bootstrap:false when the file does not exist", () => {
		expect(readPrefs(join(tmpdir(), "nope-mattpocock.json"))).toEqual<MattpocockPrefs>({
			bootstrap: false,
		});
	});

	it("returns bootstrap:false for corrupt JSON", () => {
		const path = join(tmpdir(), "corrupt-mattpocock.json");
		writeFileSync(path, "{ not json", "utf-8");
		expect(readPrefs(path)).toEqual<MattpocockPrefs>({ bootstrap: false });
	});

	it("only honors a boolean true bootstrap (not truthy strings)", () => {
		const path = join(tmpdir(), "truthy-mattpocock.json");
		writeFileSync(path, JSON.stringify({ bootstrap: "true" }), "utf-8");
		expect(readPrefs(path).bootstrap).toBe(false);
	});

	it("reads a persisted bootstrap:true", () => {
		const path = join(tmpdir(), "on-mattpocock.json");
		writePrefs({ bootstrap: true }, path);
		expect(readPrefs(path)).toEqual<MattpocockPrefs>({ bootstrap: true });
	});
});

describe("writePrefs", () => {
	it("writes pretty-printed JSON with a trailing newline", () => {
		const path = join(tmpdir(), "write-mattpocock.json");
		writePrefs({ bootstrap: true }, path);
		expect(readFileSync(path, "utf-8")).toBe(`${JSON.stringify({ bootstrap: true }, null, 2)}\n`);
	});
});

describe("isBootstrapEnabled", () => {
	let iso: { prefsPath: string; restore: () => void };

	beforeEach(() => {
		iso = withPrefsIsolation();
	});
	afterEach(() => iso.restore());

	it("is false by default (no env, no prefs file)", () => {
		expect(isBootstrapEnabled()).toBe(false);
	});

	it("is true when MATTPOCOCK_ENABLE_BOOTSTRAP=1 (one-shot override)", () => {
		process.env.MATTPOCOCK_ENABLE_BOOTSTRAP = "1";
		expect(isBootstrapEnabled()).toBe(true);
	});

	it("is true when prefs.bootstrap is true (no env)", () => {
		writePrefs({ bootstrap: true }, iso.prefsPath);
		expect(isBootstrapEnabled()).toBe(true);
	});

	it("env=1 wins over prefs.bootstrap false", () => {
		writePrefs({ bootstrap: false }, iso.prefsPath);
		process.env.MATTPOCOCK_ENABLE_BOOTSTRAP = "1";
		expect(isBootstrapEnabled()).toBe(true);
	});
});
