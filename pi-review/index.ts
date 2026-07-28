/**
 * pi-review — extension entry.
 *
 * Registers:
 *   - the `subagent` tool — general-purpose parallel/sequential sub-agent fan-out
 *     via real pi subprocesses. Shared capability used by both skills below;
 *   - the `/code-review` command — effort-level review via the code-review-v3 skill;
 *   - the `/simplify` command — cleanup via the simplify-v2 skill; the handler
 *     decides parallel vs single-pass from ctx.getContextUsage(), mirroring CC's
 *     Jvo guard (a deterministic decision a pure-prompt skill cannot reproduce).
 *
 * Both skills are auto-loaded by pi from ~/.pi/agent/skills/ — this extension only
 * provides the entry commands + the fan-out capability they need.
 *
 * Layout (layered so the tool layer can be split into its own extension later):
 *   src/tools/subagent.ts    — generic capability (subagent tool + dispatch)
 *   src/commands/*.ts        — per-skill entry commands
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCodeReview } from "./src/commands/code-review.ts";
import { registerSimplify } from "./src/commands/simplify.ts";
import { subagentTool } from "./src/tools/subagent.ts";

export default function (pi: ExtensionAPI): void {
	pi.registerTool(subagentTool);
	registerCodeReview(pi);
	registerSimplify(pi);
}
