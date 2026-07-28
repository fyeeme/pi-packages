import { describe, expect, it } from "vitest";
import {
	assertBatchSize,
	assertLifetimeAgents,
	BudgetExceededError,
	BudgetPool,
	MAX_BATCH,
	MAX_LIFETIME_AGENTS,
	scaleBatchByBudget,
} from "../src/budget/index.ts";

describe("BudgetPool — remaining", () => {
	it("uncapped dimensions return Infinity", () => {
		const p = new BudgetPool({}, 0);
		const r = p.remaining(100);
		expect(r.tokens).toBe(Number.POSITIVE_INFINITY);
		expect(r.agents).toBe(Number.POSITIVE_INFINITY);
		expect(r.durationMs).toBe(Number.POSITIVE_INFINITY);
	});

	it("track reduces token remaining", () => {
		const p = new BudgetPool({ maxTokens: 1000, maxAgents: 10 }, 0);
		p.track({ tokens: 300 });
		expect(p.remaining(0).tokens).toBe(700);
		// agents unaffected by track — reserved via reserve()
		expect(p.remaining(0).agents).toBe(10);
	});

	it("remaining floors at 0 (never negative)", () => {
		const p = new BudgetPool({ maxTokens: 100 }, 0);
		p.track({ tokens: 150 });
		expect(p.remaining(0).tokens).toBe(0);
	});

	it("duration remaining = maxDurationMs - (now - origin)", () => {
		const p = new BudgetPool({ maxDurationMs: 1000 }, 5000);
		expect(p.remaining(5500).durationMs).toBe(500);
		expect(p.remaining(6000).durationMs).toBe(0);
	});
});

describe("BudgetPool — reserve (P1-1 atomic check+commit)", () => {
	it("reserve reduces remaining.agents synchronously", () => {
		const p = new BudgetPool({ maxAgents: 3 }, 0);
		const release = p.reserve(2);
		expect(p.remaining(0).agents).toBe(1);
		expect(p.canSpawn(1, 0)).toBe(true);
		expect(p.canSpawn(2, 0)).toBe(false);
		release();
	});

	it("reserve throws when it would exceed maxAgents", () => {
		const p = new BudgetPool({ maxAgents: 2 }, 0);
		p.reserve(2);
		expect(() => p.reserve(1)).toThrow(BudgetExceededError);
	});

	it("release returns the slot", () => {
		const p = new BudgetPool({ maxAgents: 2 }, 0);
		const release = p.reserve(2);
		release();
		expect(p.remaining(0).agents).toBe(2);
	});

	it("release is idempotent (no double-decrement)", () => {
		const p = new BudgetPool({ maxAgents: 2 }, 0);
		const release = p.reserve(1);
		release();
		release();
		expect(p.remaining(0).agents).toBe(2);
	});

	it("reserve(n<=0) is a no-op", () => {
		const p = new BudgetPool({ maxAgents: 1 }, 0);
		const release = p.reserve(0);
		expect(p.remaining(0).agents).toBe(1);
		release();
	});

	it("uncapped agents never throw on reserve", () => {
		const p = new BudgetPool({}, 0);
		expect(() => p.reserve(10_000)).not.toThrow();
	});
});

describe("BudgetPool — exhaustion + canSpawn", () => {
	it("isExhausted true when tokens hit 0", () => {
		const p = new BudgetPool({ maxTokens: 100 }, 0);
		p.track({ tokens: 100 });
		expect(p.isExhausted(0)).toBe(true);
	});

	it("isExhausted true when duration elapses", () => {
		const p = new BudgetPool({ maxDurationMs: 1000 }, 0);
		expect(p.isExhausted(500)).toBe(false);
		expect(p.isExhausted(1001)).toBe(true);
	});

	it("isExhausted false when no cap is set", () => {
		const p = new BudgetPool({}, 0);
		expect(p.isExhausted(1_000_000)).toBe(false);
	});

	it("canSpawn checks the agents dimension", () => {
		const p = new BudgetPool({ maxAgents: 3 }, 0);
		expect(p.canSpawn(3, 0)).toBe(true);
		expect(p.canSpawn(4, 0)).toBe(false);
	});
});

describe("scaleBatchByBudget", () => {
	it("caps at MAX_BATCH", () => {
		const p = new BudgetPool({}, 0);
		expect(scaleBatchByBudget(10_000, p, 100, 0)).toBe(MAX_BATCH);
	});

	it("scales down by token budget", () => {
		const p = new BudgetPool({ maxTokens: 1000 }, 0);
		p.track({ tokens: 200 }); // 800 left, 100/agent → 8
		expect(scaleBatchByBudget(20, p, 100, 0)).toBe(8);
	});

	it("scales down by agents budget", () => {
		const p = new BudgetPool({ maxAgents: 5 }, 0);
		expect(scaleBatchByBudget(20, p, 10, 0)).toBe(5);
	});

	it("returns the min of token and agent limits", () => {
		const p = new BudgetPool({ maxTokens: 300, maxAgents: 10 }, 0);
		// tokens: 300/100 = 3; agents: 10 → min = 3
		expect(scaleBatchByBudget(20, p, 100, 0)).toBe(3);
	});

	it("returns 0 when budget exhausted", () => {
		const p = new BudgetPool({ maxTokens: 100 }, 0);
		p.track({ tokens: 100 });
		expect(scaleBatchByBudget(5, p, 10, 0)).toBe(0);
	});

	it("returns 0 for non-positive desired", () => {
		const p = new BudgetPool({}, 0);
		expect(scaleBatchByBudget(0, p, 100, 0)).toBe(0);
	});

	it("ignores token cost when perAgentTokens <= 0", () => {
		const p = new BudgetPool({ maxTokens: 1 }, 0); // tiny budget, but cost 0
		expect(scaleBatchByBudget(50, p, 0, 0)).toBe(50);
	});
});

describe("caps — explicit errors, no silent truncation", () => {
	it("assertBatchSize throws over MAX_BATCH", () => {
		expect(() => assertBatchSize(MAX_BATCH + 1)).toThrow(BudgetExceededError);
	});

	it("assertBatchSize passes at exactly MAX_BATCH", () => {
		expect(() => assertBatchSize(MAX_BATCH)).not.toThrow();
	});

	it("assertLifetimeAgents throws at backstop", () => {
		expect(() => assertLifetimeAgents(MAX_LIFETIME_AGENTS)).toThrow(BudgetExceededError);
	});

	it("assertLifetimeAgents passes just under backstop", () => {
		expect(() => assertLifetimeAgents(MAX_LIFETIME_AGENTS - 1)).not.toThrow();
	});
});
