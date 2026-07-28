/**
 * Cache key for agent invocations — the pi port of Claude Code's `Hid` + `tA_`.
 *
 * A workflow run that is re-executed (resume after a script edit, or a second
 * identical run) should NOT pay to re-dispatch agents whose (prompt,
 * signature) is unchanged. The key captures everything that affects an
 * agent's output: workflow name (scope), prompt (the task), and a normalized
 * signature (model/tools/systemPrompt). runId is deliberately excluded —
 * resume changes the runId but must still hit the cache.
 *
 * Normalization (CC's `tA_`): drop functions, sort object keys, so the same
 * logical signature produces the same JSON regardless of field declaration
 * order or attached closures. sha256 makes the key opaque and fixed-length.
 */
import { createHash } from "node:crypto";
import type { CacheKey } from "../types.ts";

/**
 * The subset of agent options that affect output and therefore belong in the
 * key. Caller constructs this explicitly so callId/signal/cwd (run-time
 * control, not output semantics) never leak into the key by accident.
 */
export interface AgentCacheSignature {
	readonly model?: string;
	readonly tools?: readonly string[];
	readonly systemPrompt?: string;
}

/**
 * Serialize a signature to a stable canonical form: object keys sorted, no
 * functions, arrays in order. Same signature → identical string.
 *
 * Picks only the known data fields (model/tools/systemPrompt) — CC's `tA_`
 * pattern. A caller may pass a wider object (e.g. an AgentCallSpec that also
 * carries a `prompt` function); picking avoids both hashing the prompt
 * (which is a separate cache-key dimension) and tripping the function-guard
 * on the prompt closure.
 */
const SIGNATURE_FIELDS = ["model", "tools", "systemPrompt"] as const;

export function normalizeSignature(signature: AgentCacheSignature | undefined): string {
	if (!signature) return "{}";
	const src = signature as Record<string, unknown>;
	const picked: Record<string, unknown> = {};
	for (const f of SIGNATURE_FIELDS) {
		const v = src[f];
		if (v !== undefined) picked[f] = v;
	}
	return JSON.stringify(stabilize(picked));
}

function stabilize(value: unknown): unknown {
	if (typeof value === "function") {
		// Functions are not stable across runs (closures capture mutable scope),
		// so silently dropping them would let two signatures that differ only in a
		// function field hash identically → resume returns a result computed under
		// function A to a caller that supplied function B. Throw instead — a
		// determinism subsystem must not accept un-hashable inputs.
		throw new Error(
			"workflow signature contains a function — functions are not stable across runs; pass only data (string/number/array/plain object)",
		);
	}
	if (Array.isArray(value)) return value.map(stabilize);
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		const src = value as Record<string, unknown>;
		for (const key of Object.keys(src).sort()) out[key] = stabilize(src[key]);
		return out;
	}
	return value;
}

export interface CacheKeyInput {
	readonly workflowName: string;
	readonly prompt: string;
	readonly signature?: AgentCacheSignature;
}

/** Compute the deterministic cache key for one agent call. */
export function computeCacheKey(input: CacheKeyInput): CacheKey {
	const hash = createHash("sha256");
	hash.update(input.workflowName);
	hash.update("\x00");
	hash.update(input.prompt);
	hash.update("\x00");
	hash.update(normalizeSignature(input.signature));
	return `wf:${hash.digest("hex")}`;
}
