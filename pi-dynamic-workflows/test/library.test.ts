/**
 * library.test.ts — the named workflow library: discovery (bundled seeds +
 * project override), drop-in registration, the determinism guard on library
 * source, and unknown-name resolution.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	discoverWorkflowLibrary,
	findProjectLibDir,
	loadLibraryWorkflow,
} from "../src/library.ts";

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dw-lib-"));
});

afterEach(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("bundled seed workflows", () => {
	it("ships the two review seeds, loadable through the determinism guard", async () => {
		const lib = await discoverWorkflowLibrary(tmpRoot);
		expect(lib.has("review-local-diff")).toBe(true);
		expect(lib.has("review-extension")).toBe(true);
		const seed = lib.get("review-local-diff")!;
		expect(seed.description).toBeTruthy();
		expect(seed.workflow.steps.length).toBeGreaterThan(0);
	});

	it("the seeds declare budget and parallelism as data", async () => {
		const { workflow } = (await loadLibraryWorkflow("review-local-diff", tmpRoot))!;
		expect(workflow.budget?.maxAgents).toBe(12);
		const fan = workflow.steps.find((s) => s.type === "fan_out");
		expect(fan && "parallelism" in fan ? fan.parallelism : undefined).toBe(4);
	});
});

describe("project library", () => {
	it("finds .pi/workflows/lib walking up from cwd", () => {
		const libDir = path.join(tmpRoot, "proj", ".pi", "workflows", "lib");
		fs.mkdirSync(libDir, { recursive: true });
		expect(findProjectLibDir(path.join(tmpRoot, "proj", "a", "b"))).toBe(libDir);
		expect(findProjectLibDir(tmpRoot)).toBeNull();
	});

	it("a dropped-in file is runnable by name without any code change", async () => {
		const libDir = path.join(tmpRoot, ".pi", "workflows", "lib");
		fs.mkdirSync(libDir, { recursive: true });
		fs.writeFileSync(
			path.join(libDir, "hello.ts"),
			`export const workflow = { name: "hello", steps: [{ id: "s", type: "log", message: "hi" }] };\n`,
		);
		const entry = await loadLibraryWorkflow("hello", tmpRoot);
		expect(entry?.workflow.steps[0]?.type).toBe("log");
	});

	it("a project entry overrides the bundled seed of the same name", async () => {
		const libDir = path.join(tmpRoot, ".pi", "workflows", "lib");
		fs.mkdirSync(libDir, { recursive: true });
		fs.writeFileSync(
			path.join(libDir, "override.ts"),
			`export const workflow = { name: "review-local-diff", description: "project override", steps: [{ id: "s", type: "log", message: "x" }] };\n`,
		);
		const entry = await loadLibraryWorkflow("review-local-diff", tmpRoot);
		expect(entry?.description).toBe("project override");
		expect(entry?.filePath.startsWith(libDir)).toBe(true);
	});

	it("an unknown name resolves to null (caller lists the library)", async () => {
		expect(await loadLibraryWorkflow("no-such", tmpRoot)).toBeNull();
	});
});

describe("determinism guard on library source", () => {
	it("rejects a workflow file that reads the clock, naming the violation", async () => {
		const libDir = path.join(tmpRoot, ".pi", "workflows", "lib");
		fs.mkdirSync(libDir, { recursive: true });
		fs.writeFileSync(
			path.join(libDir, "nondet.ts"),
			`const t = Date.now();\nexport const workflow = { name: "nondet", steps: [] };\nif (t < 0) console.log(t);\n`,
		);
		await expect(discoverWorkflowLibrary(tmpRoot)).rejects.toThrow(/determin/i);
	});
});
