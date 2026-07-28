/**
 * Real-pi subprocess smoke — runs one agent step through the DEFAULT dispatch
 * (real spawnAgent → `pi --mode json -p --no-session`), proving the full spawn
 * path end-to-end: pi binary resolution, JSON event parsing, usage tracking,
 * journal record, budget/lifecycle wiring.
 *
 * NOT an automated test: it needs `pi` on PATH + a configured provider/key, so
 * it is excluded from vitest (lives under examples/, not test/).
 *
 * Run (from the package dir):
 *   ../../node_modules/.bin/tsx examples/smoke-real-pi.ts
 *
 * Exit code 0 = the agent replied cleanly; non-zero = spawn/agent failure
 * (check `pi` is installed, a provider is configured, and the network is up).
 */
import { runWorkflow } from "../src/runner/index.ts";
import { defineWorkflow } from "../src/types.ts";

// spawnAgent's getPiInvocation re-enters process.argv[1] when it is an existing
// script — correct inside pi, but this standalone smoke would recurse into
// itself. Blank it so resolution falls through to the `pi` binary on PATH.
process.argv[1] = "";

const wf = defineWorkflow({
	name: "smoke-real-pi",
	steps: [{ id: "s1", type: "agent", prompt: "Reply with exactly: ok" }],
});

const res = await runWorkflow({
	workflow: wf,
	cwd: process.cwd(),
	now: Date.now(),
	// dispatch defaults to the real spawnAgent (spawns `pi --mode json`).
});

console.log("status:      ", res.status);
console.log("steps run:   ", res.steps.length);
console.log("agent output:", JSON.stringify(res.steps[0]?.results));
console.log("stats:       ", JSON.stringify(res.stats));
console.log("journal:     ", res.journalFile);
if (res.error) console.error("error:", res.error);
process.exit(res.status === "completed" ? 0 : 1);
