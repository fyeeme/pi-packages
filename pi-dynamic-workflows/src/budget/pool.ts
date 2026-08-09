/**
 * Budget pool — CC's `budget.{total, spent(), remaining()}` re-expressed for pi.
 *
 * A static `Budget` (types.ts) describes caps; a `BudgetPool` is the live,
 * queryable tracker the runtime mutates as agents settle. Caps are enforced
 * as SPAWN-GATE SOFT LIMITS: the runtime checks `isExhausted()` before
 * committing each new spawn (guardSpawn/guardBatch) and stops spawning when
 * exhausted — an in-flight agent is allowed to complete and may push spend
 * past the cap. fan_out concurrency is the step's static `parallelism`; the
 * budget does not dynamically resize it.
 *
 * Determinism: identity (runId, journal timestamps, cache keys) never reads
 * Date.now() — `now` is the run inception timestamp. The DURATION dimension,
 * however, is wall-clock and the engine reads Date.now() at the guard points
 * (guardSpawn/guardBatch) to enforce maxDurationMs; engine code is not
 * AST-guarded. Token/agent dimensions are passed `now` but don't depend on
 * it (elapsed only matters for duration).
 *
 * Scope: per-run (one pool per workflow execution), not global.
 *
 * P1-1 fix — reservation model: the agents dimension is committed synchronously
 * via `reserve(n)` (check + increment in one step, no `await` gap), closing the
 * TOCTOU where N concurrent fan_out workers all read `remaining.agents >= 1`
 * before any settles. `reserve` returns a release handle; a failed dispatch
 * (spawn rejected) calls it to return the slot. Tokens can't be reserved
 * (cost is unknown until the agent settles), so maxTokens stays an
 * after-the-fact track + isExhausted check on the next guard.
 */
import type { Budget } from "../types.ts";
import { BudgetExceededError } from "./caps.ts";

export interface BudgetRemaining {
	/** Tokens left before maxTokens is hit. Infinity if uncapped. */
	readonly tokens: number;
	/** Milliseconds left before maxDurationMs. Infinity if uncapped. */
	readonly durationMs: number;
	/** Agent slots left before maxAgents. Infinity if uncapped. */
	readonly agents: number;
}

export class BudgetPool {
	private spentTokens = 0;
	/** Agents reserved via reserve() — synchronously committed, so concurrent
	 * callers can't all pass the check before any settles (TOCTOU). */
	private reservedAgents = 0;
	private readonly originMs: number;
	private readonly config: Budget;

	// Note: no parameter properties (e.g. `private readonly config` in the param
	// list) — erasableSyntaxOnly forbids them. Declare the field, assign in body.
	constructor(config: Budget, originMs: number) {
		this.config = config;
		this.originMs = originMs;
	}

	/**
	 * Atomically reserve `n` agent slots against maxAgents. Throws
	 * BudgetExceededError if the reservation would exceed the cap. Returns a
	 * release handle — call it ONLY if the dispatch fails (the slot was never
	 * used); a settled agent keeps its slot (it consumed budget).
	 */
	reserve(n: number): () => void {
		if (n <= 0) return () => {};
		const cap = this.config.maxAgents;
		if (cap !== undefined && this.reservedAgents + n > cap) {
			throw new BudgetExceededError(
				`budget exhausted: ${this.reservedAgents + n} agent(s) would exceed maxAgents ${cap}`,
			);
		}
		this.reservedAgents += n;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.reservedAgents -= n;
		};
	}

	/** Record token spend by a settled agent. (Agents are counted via reserve.) */
	track(input: { tokens?: number }): void {
		if (input.tokens) this.spentTokens += input.tokens;
	}

	/** The configured cap set (CC's budget.total surface). */
	get total(): Budget {
		return this.config;
	}

	/** Remaining headroom per dimension at time `now`. */
	remaining(now: number): BudgetRemaining {
		return {
			tokens:
				this.config.maxTokens !== undefined
					? Math.max(0, this.config.maxTokens - this.spentTokens)
					: Number.POSITIVE_INFINITY,
			durationMs:
				this.config.maxDurationMs !== undefined
					? Math.max(0, this.config.maxDurationMs - (now - this.originMs))
					: Number.POSITIVE_INFINITY,
			agents:
				this.config.maxAgents !== undefined
					? Math.max(0, this.config.maxAgents - this.reservedAgents)
					: Number.POSITIVE_INFINITY,
		};
	}

	/** True once any capped dimension hits zero. */
	isExhausted(now: number): boolean {
		const r = this.remaining(now);
		return r.tokens === 0 || r.durationMs === 0 || r.agents === 0;
	}

	/** Can n more agents be spawned under the agents cap? (Pre-check; actual
	 * commit is via reserve().) */
	canSpawn(n: number, now: number): boolean {
		return this.remaining(now).agents >= n;
	}
}
