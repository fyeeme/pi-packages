---
description: "/code-review trigger — xhigh/max deep sweep: finder/verifier/gap-hunt fan-out via the code-review skill"
vars: [effort, effort-source, extra-args, skill, finder-max-turns, verifier-max-turns, gap-hunt-max-turns, verify, limit-note, budget-note, review-note]
---
Run a code review now. Effective effort: {{effort}} ({{effort-source}}){{extra-args}}.

First load the code-review skill with the read tool: {{skill}}. Then follow its
XHIGH/MAX FLOW exactly — dispatch the finder / verifier / gap-hunter agents it
calls for through the `subagent` tool (bundled agents: finder-diff-scan,
finder-removed-behavior, finder-cross-file, finder-language-pitfall,
finder-wrapper-proxy, cleaner-reuse, cleaner-simplification,
cleaner-efficiency, cleaner-altitude, finder-conventions, verifier,
gap-hunter) as the skill instructs; the calls carry no turn budget — the
agents run to natural completion.
{{review-note}}
{{budget-note}}
{{limit-note}}
The `subagent` tool is a pi extension tool in your session toolset — judge
its availability from that list, never via `mcp` tool search (which only
indexes MCP-server tools and cannot see extension tools).

Verification guidance (the skill's `--fix` flow consumes it):

{{verify}}
