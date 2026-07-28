/**
 * Hard runaway caps — the pi port of CC's workflow backstops.
 *
 * CC caps: `min(16, cpu-2)` concurrent per workflow, 1000 agents per workflow
 * lifetime (runaway backstop), 4096 items per `parallel()`/`pipeline()` call
 * (explicit error on exceed — never silent truncation). Pi ports the lifetime
 * and batch caps here; the concurrency cap is enforced by
 * `mapWithConcurrencyLimit` in src/agent/dispatch.ts.
 */

export const MAX_LIFETIME_AGENTS = 1000;
export const MAX_BATCH = 4096;

export class BudgetExceededError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BudgetExceededError";
	}
}

/** Assert a fan-out batch fits the hard cap. Throws — no silent truncation. */
export function assertBatchSize(n: number): void {
	if (n > MAX_BATCH) {
		throw new BudgetExceededError(
			`fan-out batch ${n} exceeds MAX_BATCH (${MAX_BATCH}); pass fewer items or split the input`,
		);
	}
}

/** Assert cumulative agent count hasn't hit the runaway backstop. */
export function assertLifetimeAgents(spawned: number): void {
	if (spawned >= MAX_LIFETIME_AGENTS) {
		throw new BudgetExceededError(
			`workflow spawned ${spawned} agents — MAX_LIFETIME_AGENTS (${MAX_LIFETIME_AGENTS}) runaway backstop reached`,
		);
	}
}
