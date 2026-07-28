/**
 * loop_until_dry step scenarios — keep discovering until K dry rounds.
 * Tests the CC "loop-until-dry" pattern with critic support.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineWorkflow } from "../../src/types.ts";
import { runWorkflow } from "../../src/runner/index.ts";
import { makeFakeDispatch } from "./helpers.ts";

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-lud-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("loop_until_dry — keep discovering until K dry rounds", () => {
	it("discovers items across rounds and stops when dry", async () => {
		const wf = defineWorkflow({
			name: "discover",
			steps: [{
				id: "lud",
				type: "loop_until_dry",
				prompt: (ctx, known) => `find more; already have: ${JSON.stringify(known)}`,
				keyOf: (item: unknown) => String((item as { id: number }).id),
				dryThreshold: 2,
				maxRounds: 5,
			}],
		});
		let round = 0;
		const responses = [
			'[{"id":1,"val":"a"},{"id":2,"val":"b"}]',
			'[{"id":3,"val":"c"}]',
			'[]',
			'[]',
		];
		const dispatch = makeFakeDispatch({
			value: () => responses[round++] ?? '[]',
		});
		const res = await runWorkflow({ workflow: wf, cwd: dir, now: 1000, dispatch });
		expect(res.status).toBe("completed");
		const items = res.steps[0].results as { id: number }[];
		expect(items).toHaveLength(3);
		expect(items.map((i) => i.id).sort()).toEqual([1, 2, 3]);
	});

	it("critic restarts loop when it finds missing items", async () => {
		const wf = defineWorkflow({
			name: "discover-critic",
			steps: [{
				id: "lud",
				type: "loop_until_dry",
				prompt: (ctx, known) => `find new items; have: ${known.length}`,
				keyOf: (item: unknown) => String((item as { id: number }).id),
				dryThreshold: 1,
				maxRounds: 5,
				critic: {
					prompt: (ctx, known) => `what's missing? have: ${known.length}`,
				},
			}],
		});
		let round = 0;
		const responses = [
			'[{"id":1}]',
			'[]',
			'[{"id":2}]',
			'[]',
			'[]',
		];
		const dispatch = makeFakeDispatch({
			value: () => responses[round++] ?? '[]',
		});
		const res = await runWorkflow({ workflow: wf, cwd: dir, now: 1000, dispatch });
		expect(res.status).toBe("completed");
		const items = res.steps[0].results as { id: number }[];
		expect(items).toHaveLength(2);
	});
});
