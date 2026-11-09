/**
 * pi-review v2 — extension entry.
 *
 * Sandwich architecture (see openspec change subagent-sandwich-refactor):
 *
 *   Skills  skills/code-review, skills/code-simplify — review methodology,
 *           registered natively via the pi manifest (`pi.skills`); they
 *           reference capabilities by stable tool/agent names only.
 *   Prompts prompts/ — the orchestration strategy as data: parallel-when
 *           guards in frontmatter, phases/agents in the body. Rendered by
 *           the generic dispatcher (src/dispatch.ts) which gathers the
 *           deterministic runtime variables (diff, context usage, sticky
 *           effort) and picks the template variant.
 *   Agents  agents/ — the review angles materialized as subagent definitions
 *           (finder-*, cleaner-*, verifier, gap-hunter) invoked via the
 *           bound fan-out tool (fanout.tool config, default `subagent`).
 *   Plugin  this entry registers this package's agents directory into the
 *           provider's shared discovery registry, and adds the
 *           `review_report` structured findings sink plus the
 *           /code-review and /code-simplify dispatcher commands.
 *
 * Provider-decoupled (openspec change fanout-tool-binding): this package
 * holds NO import and NO npm dependency on @fyeeme/pi-subagents or any
 * other fan-out provider. The fan-out tool comes from whichever extension
 * registers the bound name (young.json "pi-review" → fanout.tool, default
 * `subagent`); an unregistered binding degrades fan-out to single-pass
 * with a warning (see src/dispatch.ts). The agents/ dir is registered
 * into the provider's shared discovery registry via the documented
 * symbol contract (src/fanout.ts) — no import.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { registerDispatcher } from "./src/dispatch.ts";
import { registerAgentsDir } from "./src/fanout.ts";
import { reviewReportTool } from "./src/tools/review_report.ts";

export default function (pi: ExtensionAPI): void {
	// <pkg>/index.ts → sibling agents/ dir into the shared discovery
	// registry (documented symbol contract), so whichever provider owns
	// the bound tool discovers the review roles. Inert when none does.
	registerAgentsDir(path.join(path.dirname(fileURLToPath(import.meta.url)), "agents"));

	pi.registerTool(reviewReportTool);
	registerDispatcher(pi);
}
