import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Context-full fraction at which we fall back to single-pass (mirrors CC's Jvo guard). */
const CONTEXT_NEAR_FULL_THRESHOLD = 0.8;

export type SimplifyMode = "parallel" | "single-pass";

/**
 * Decide simplify mode deterministically from real context usage + tool availability.
 * Mirrors CC's Jvo guard: parallel only when context isn't near-full AND the Agent
 * tool is available. Pure function — unit-testable.
 *
 * (CC's Jvo: aN(agentContext) >= Uue() → single-pass; tools allowlist → must contain
 * Agent. Here: tokens/contextWindow >= 0.8 → single-pass; subagent tool must be registered.)
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
			"Clean up the changed code (reuse/simplification/efficiency/altitude) using the simplify-v2 skill. Mode (parallel 4-agent vs single-pass) is decided by the handler from real context usage. Usage: /code-simplify [<target>]",
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
					`Load ~/.pi/agent/skills/simplify-v2/SKILL.md via the read tool and follow the ${bodyLabel} body. ` +
					(mode === "parallel"
						? `Use the \`subagent\` tool (mode: parallel) for the 4-agent fan-out.`
						: `Work the four angles inline — do not fake fan-out.`),
			);
		},
	});
}
