/**
 * pi-review — extension entry.
 *
 * Registers:
 *   - the `subagent` tool — general-purpose parallel/sequential sub-agent fan-out
 *     via real pi subprocesses. Shared capability used by both skills below;
 *   - the `simplify_fanout` tool — /code-simplify PARALLEL mode's dispatch
 *     gate: the model calls it after its visible Phase 0 (read the diff, write
 *     the change-intent summary); the tool re-resolves the diff and spawns the
 *     4 cleanup agents (same recursion guard as `subagent`);
 *   - the `review_report` tool — structured findings sink for the code-review
 *     skill (Pi's counterpart to CC's ReportFindings): renders the Markdown
 *     report + writes JSON to <cwd>/.pi/review/ for CI;
 *   - the `/code-review` command — effort-level review via the code-review skill;
 *   - the `/code-simplify` command — cleanup via the simplify skill; the handler
 *     resolves the widened diff scope first (upstream merge-base → HEAD →
 *     staged/unstaged), then decides parallel vs single-pass from
 *     ctx.getContextUsage(), diff size, and fan-out availability. Both modes
 *     open with a visible, model-run Phase 0 (CC parity) — only PARALLEL
 *     dispatches agents, via the tool above.
 *
 * Both skills ship bundled in this package under `skills/` — this extension
 * provides the entry commands + the fan-out capability they need.
 *
 * Layout (layered so the tool layer can be split into its own extension later):
 *   src/tools/subagent.ts      — generic capability (subagent tool; dispatch from pi-subagent-core)
 *   src/tools/review_report.ts — structured findings sink (review_report tool; CC ReportFindings counterpart)
 *   src/commands/*.ts          — per-skill entry commands (code-simplify.ts also owns the simplify_fanout tool)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isFanoutToolAllowed } from "@fyeeme/pi-subagent-core";
import { registerCodeReview } from "./src/commands/code-review.ts";
import { registerSimplify, simplifyFanoutTool } from "./src/commands/code-simplify.ts";
import { subagentTool } from "./src/tools/subagent.ts";
import { reviewReportTool } from "./src/tools/review_report.ts";

export default function (pi: ExtensionAPI): void {
	// The fan-out tools register only when recursion is allowed for THIS
	// process (top-level, or a child the spawner explicitly opted in AND that is
	// below the max-depth cap). A default child — spawned without the fan-out
	// tool in its whitelist — loads without them, so it physically cannot recurse.
	// This is the whitelist-by-default recursion guard (harden-code-simplify).
	if (isFanoutToolAllowed()) {
		pi.registerTool(subagentTool);
		pi.registerTool(simplifyFanoutTool);
	}
	pi.registerTool(reviewReportTool);
	registerCodeReview(pi);
	registerSimplify(pi);
}
