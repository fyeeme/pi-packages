import { describe, expect, it } from "vitest";
import { computeCacheKey, normalizeSignature, type AgentCacheSignature } from "../src/cache/key.ts";

describe("normalizeSignature (stable)", () => {
	it("returns {} for undefined", () => {
		expect(normalizeSignature(undefined)).toBe("{}");
	});

	it("same signature → same string regardless of field declaration order", () => {
		const a: AgentCacheSignature = { model: "haiku", systemPrompt: "x", tools: ["read"] };
		const b = { tools: ["read"], model: "haiku", systemPrompt: "x" } as AgentCacheSignature;
		expect(normalizeSignature(a)).toBe(normalizeSignature(b));
	});

	it("picks only signature fields — ignores extra/prompt closures (CC tA_ pattern)", () => {
		const sig = { model: "haiku", extra: () => 1, prompt: () => "x" } as unknown as AgentCacheSignature;
		const cleaned = normalizeSignature(sig);
		expect(cleaned).not.toContain("extra");
		expect(cleaned).not.toContain("prompt");
		expect(JSON.parse(cleaned)).toEqual({ model: "haiku" });
	});

	it("throws if a signature field VALUE is a function (defensive)", () => {
		const sig = { model: (() => "x") as unknown as string } as AgentCacheSignature;
		expect(() => normalizeSignature(sig)).toThrow(/function/);
	});

	it("same arrays in order are stable", () => {
		const a: AgentCacheSignature = { tools: ["read", "bash"] };
		const b: AgentCacheSignature = { tools: ["read", "bash"] };
		expect(normalizeSignature(a)).toBe(normalizeSignature(b));
	});

	it("different array order produces different strings", () => {
		const a: AgentCacheSignature = { tools: ["read", "bash"] };
		const b: AgentCacheSignature = { tools: ["bash", "read"] };
		expect(normalizeSignature(a)).not.toBe(normalizeSignature(b));
	});
});

describe("computeCacheKey (deterministic)", () => {
	it("same inputs → identical key", () => {
		const input = { workflowName: "wf", prompt: "do X", signature: { model: "haiku" } };
		expect(computeCacheKey(input)).toBe(computeCacheKey(input));
	});

	it("different prompt → different key", () => {
		const base = { workflowName: "wf", signature: { model: "haiku" } };
		expect(computeCacheKey({ ...base, prompt: "A" })).not.toBe(computeCacheKey({ ...base, prompt: "B" }));
	});

	it("different model → different key", () => {
		const base = { workflowName: "wf", prompt: "A" };
		expect(computeCacheKey({ ...base, signature: { model: "haiku" } }))
			.not.toBe(computeCacheKey({ ...base, signature: { model: "sonnet" } }));
	});

	it("different workflow name → different key (scope isolation)", () => {
		const sig = { model: "haiku" };
		expect(computeCacheKey({ workflowName: "wf-a", prompt: "A", signature: sig }))
			.not.toBe(computeCacheKey({ workflowName: "wf-b", prompt: "A", signature: sig }));
	});

	it("signature field order does not change the key", () => {
		const base = { workflowName: "wf", prompt: "A" };
		const a = computeCacheKey({ ...base, signature: { model: "haiku", tools: ["t"] } });
		const b = computeCacheKey({ ...base, signature: { tools: ["t"], model: "haiku" } });
		expect(a).toBe(b);
	});

	it("produces wf4: prefixed 64-hex", () => {
		expect(computeCacheKey({ workflowName: "wf", prompt: "x" })).toMatch(/^wf4:[0-9a-f]{64}$/);
	});

	it("delimiter injection cannot force a key collision (B5)", () => {
		// JSON-tuple derivation: a NUL (or any char) inside a field cannot shift the
		// parse the way the old `field + "\x00" + field` scheme allowed.
		const a = computeCacheKey({ workflowName: "a\u0000b", prompt: "c" });
		const b = computeCacheKey({ workflowName: "a", prompt: "b\u0000c" });
		expect(a).not.toBe(b);
	});
});
