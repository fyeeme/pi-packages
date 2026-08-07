import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bundledSkillPath } from "../skills.ts";

/** Context fraction at which we fall back to single-pass — a Pi-specific heuristic (see decideSimplifyMode). */
const CONTEXT_NEAR_FULL_THRESHOLD = 0.8;

export type SimplifyMode = "parallel" | "single-pass";

/**
 * Decide simplify mode deterministically from real context usage + tool availability.
 * Pure function — unit-testable.
 *
 * CC parity note: CC's /simplify guard (_Yo) is a SPAWN-DEPTH recursion limit, NOT a
 * context check — `RO(ctx) >= dne()` where RO returns the agent's depth and dne()
 * returns CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH (default 3). That is N/A on Pi: the
 * `subagent` tool spawns a fresh subprocess (depth 0), so depth never accumulates.
 * The context-fraction heuristic below is a Pi-specific substitute (don't fan out
 * when the parent's context is near-full), NOT a mirror of _Yo. The other _Yo clause
 * — the Agent tool must be in the allowlist — IS mirrored here as `hasSubagent`.
 */
export function decideSimplifyMode(opts: {
	tokens: number | null;
	contextWindow: number;
	hasSubagent: boolean;
}): SimplifyMode {
	const { tokens, contextWindow, hasSubagent } = opts;
	// Conservative: if we can't measure context (tokens unknown / window 0) or the
	// subagent tool isn't registered, don't risk fan-out — go single-pass.
	if (tokens == null || contextWindow <= 0 || !hasSubagent) return "single-pass";
	const nearFull = tokens / contextWindow >= CONTEXT_NEAR_FULL_THRESHOLD;
	return nearFull ? "single-pass" : "parallel";
}

/**
 * Register the /code-simplify command. The handler decides parallel vs single-pass from
 * ctx.getContextUsage() (real token count) + subagent tool availability — this is the
 * deterministic Jvo guard that a pure-prompt skill cannot reproduce.
 */
export function registerSimplify(pi: ExtensionAPI): void {
	pi.registerCommand("code-simplify", {
		description:
			"Clean up the changed code (reuse/simplification/efficiency/altitude) using the simplify skill. Mode (parallel 4-agent vs single-pass) is decided by the handler from real context usage. Usage: /code-simplify [<target>]",
		async handler(args, ctx) {
			const usage = ctx.getContextUsage();
			const hasSubagent = pi.getAllTools().some((t) => t.name === "subagent");
			const mode = decideSimplifyMode({
				tokens: usage?.tokens ?? null,
				contextWindow: usage?.contextWindow ?? 0,
				hasSubagent,
			});
			const pct =
				usage && usage.tokens != null && usage.contextWindow > 0
					? Math.round((usage.tokens / usage.contextWindow) * 100) + "%"
					: "?";
			const bodyLabel = mode === "parallel" ? "PARALLEL MODE" : "SINGLE-PASS MODE";
			pi.sendUserMessage(
				`Clean up the changed code now. Target: ${args || "(whole diff)"}.\n\n` +
					`Handler decided ${mode} mode (context ${pct} full, subagent ${hasSubagent ? "available" : "absent"}). ` +
					`Load ${bundledSkillPath("simplify/SKILL.md")} via the read tool and follow the ${bodyLabel} body. ` +
					(mode === "parallel"
						? `Use the \`subagent\` tool (mode: parallel) for the 4-agent fan-out.`
						: `Work the four angles inline — do not fake fan-out.`),
			);
		},
	});
}
