/**
 * Loader tests — guard-before-load via jiti.
 *
 * Writes real `.ts` files to a temp dir and loads them through jiti, so this
 * exercises the actual module-loading path (not a mock). A non-deterministic
 * file is rejected before jiti ever sees it.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeterminismError } from "../src/determinism/ast-guard.ts";
import { loadWorkflowModule } from "../src/loader.ts";

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-loader-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

async function write(name: string, source: string): Promise<string> {
	const filePath = path.join(dir, name);
	await fs.promises.writeFile(filePath, source, "utf-8");
	return filePath;
}

describe("loadWorkflowModule — guard before jiti load", () => {
	it("loads a clean workflow file and exposes its export", async () => {
		const filePath = await write(
			"clean.ts",
			`export const workflow = { name: "clean", steps: [] } as const;\n`,
		);
		const mod = await loadWorkflowModule<{ workflow: { name: string } }>({ filePath });
		expect(mod.workflow.name).toBe("clean");
	});

	it("runs a pure transform file with no workflow export", async () => {
		const filePath = await write("pure.ts", `export const add = (a: number, b: number) => a + b;\n`);
		const mod = await loadWorkflowModule<{ add: (a: number, b: number) => number }>({ filePath });
		expect(mod.add(2, 3)).toBe(5);
	});

	it("rejects a file that calls Date.now() before loading", async () => {
		const filePath = await write("bad.ts", `const t = Date.now();\nexport default t;\n`);
		await expect(loadWorkflowModule({ filePath })).rejects.toBeInstanceOf(DeterminismError);
	});

	it("rejects a file that calls Math.random() before loading", async () => {
		const filePath = await write("rand.ts", `const r = Math.random();\nexport default r;\n`);
		await expect(loadWorkflowModule({ filePath })).rejects.toBeInstanceOf(DeterminismError);
	});

	it("allows new Date(number) — deterministic given args", async () => {
		const filePath = await write("dated.ts", `const d = new Date(1_700_000_000_000);\nexport default d.getFullYear();\n`);
		const mod = await loadWorkflowModule<{ default: number }>({ filePath });
		expect(typeof mod.default).toBe("number");
	});
});
