/**
 * concurrency.ts — the package-level fan-out ceiling policy.
 *
 * Lives at src root (not under tools/) so both layers use it without the
 * commands layer reaching into the tool layer — the tool layer is meant to be
 * splittable into its own extension later (see index.ts layout notes).
 */
import { getEffectiveMaxConcurrency, parsePositiveInt } from "@fyeeme/pi-subagent-core";

/**
 * Effective concurrency ceiling for parallel fan-out — shared by the
 * `subagent` tool and /code-simplify's fan-out so every fan-out path in this
 * package honors the same override. Precedence:
 *   1. PI_MAX_CONCURRENT_SUBAGENTS env var (power-user escape hatch, parity
 *      with CC's CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS; unset/invalid ignored);
 *   2. the shared package setting `maxConcurrency` from
 *      <agentDir>/pi-subagent.json (project layer overriding) — options
 *      3/5/8/10, default 5 (see @fyeeme/pi-subagent-core settings).
 * Read at call time so a changed env/file takes effect without a reload.
 */
export function getMaxConcurrency(): number {
	return parsePositiveInt(process.env.PI_MAX_CONCURRENT_SUBAGENTS) ?? getEffectiveMaxConcurrency();
}
