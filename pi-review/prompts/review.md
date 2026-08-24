---
description: "/review trigger — effort-level code review via the code-review skill"
vars: [effort, effort-source, extra-args, skill]
---
Run a code review now. Effective effort: {{effort}} ({{effort-source}}){{extra-args}}.

First load the review skill with the read tool: {{skill}}. Then follow it
exactly — dispatch the finder / verifier / gap-hunter agents it calls for
through the `subagent` tool (bundled agents: finder-diff-scan,
finder-removed-behavior, finder-cross-file, finder-language-pitfall,
finder-wrapper-proxy, cleaner-reuse, cleaner-simplification,
cleaner-efficiency, cleaner-altitude, finder-conventions, verifier,
gap-hunter), with `maxTurns: 20` per finder batch and `maxTurns: 15` for the
gap-hunt as the skill instructs.
