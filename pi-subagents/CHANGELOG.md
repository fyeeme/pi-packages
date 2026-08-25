# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.0] - 2026-08-25

**omp-parity release** — deletes the over-engineered surfaces, moves policy out of the tool wire into settings, and ports the reliability mechanisms proven by the omp harness (watchdogs, stable ids, explicit result contract, structured output, failure classification). The dispatch-core export surface and signatures are unchanged; consumers need no code changes.

### Breaking Changes

- **Chain mode removed**: `chain[]` and the `{previous}` placeholder no longer exist on the `subagent` tool. Model sequential work as successive `subagent` calls you coordinate yourself, or move it to a workflow engine (`pi-dynamic-workflows`). No library consumer depended on it.
- **Prompt presets removed**: `/implement`, `/scout-and-plan`, `/implement-and-review` are gone from this package (they were chain-mode wrappers). The surviving recipe moved to [`pi-dynamic-workflows`](../pi-dynamic-workflows) as its `/implement-and-review` prompt, rewritten for successive `subagent` calls. The `pi.prompts` manifest field is removed accordingly.
- **Policy parameters off the wire**: `agentScope` and `confirmProjectAgents` tool parameters are gone. Discovery is always three-source full (project > user > bundled, first-found-wins); project-agent confirmation is the settings key only, so a supervised model can no longer weaken its own supervision per call.
- **`background` observation flag and widget `"background"` mode removed** — dead code: neither consumer nor the tool schema ever produced `background: false`, so the filter never filtered anything.
- **`/agents` slash command removed** — the below-editor fleet surface is the single UI entry to the conversation viewer.
- **Environment-variable configuration channel removed**: `PI_MAX_CONCURRENT_SUBAGENTS` is no longer honored; concurrency comes solely from `maxConcurrency` in the settings file (any positive integer — the old `[3,5,8,10]` enum is gone).
- **`maxTurns: 0` special case removed**: 0/negative is rejected as invalid input instead of meaning "abort after the first message".

### Added

- **Stable spawn ids** — every call gets a short `AdjectiveNoun` id (`SwiftFox`; duplicates get `-2` suffixes; pass `options.id` to choose one), shown consistently in fleet rows, result details, artifact filenames, and warnings. `spawnAgent` returns `id` alongside the unchanged `callId` (registry/abort addressing still uses `callId`).
- **Full-output artifacts** — every call with output writes `<tmpdir>/pi-subagents/<pid>-<n>/<stable-id>.md` synchronously before settlement; a truncated parallel result's marker points at the file instead of vaguely at details. Write failures degrade to a warning line, never an error. `details.results[].outputPath`.
- **Explicit `<result>` contract** — spawned agents are instructed (appended system prompt + bundled agent prompts) to wrap their final answer in `<result></result>`; extraction prefers the last complete block, falls back to the last-assistant-text heuristic, then to an explicit `(no output)` placeholder. `details.results[].extractMethod` distinguishes `result-block` / `assistant-text` / `none`; parallel summaries annotate heuristic extraction so contract misses are observable.
- **Structured output** — agent frontmatter gains `output:` (JSON Schema mapping); calls accept per-task or single-mode `outputSchema` with `schemaMode: "permissive" (default) | "strict"`. Priority: call item > frontmatter > none. Validation runs on the extracted result text (typebox Compile, already a dependency): strict violations fail the task with the validator's error list; permissive ones attach a warning and preserve the original text. When a schema applies, the spawn prompt instructs pure JSON inside `<result>`.
- **Stall watchdog + wall-clock ceiling** — a call silent for `stallMs` (settings, default 60000 ms) is aborted via the existing SIGTERM → 5s → SIGKILL chain with partial output preserved; optional `wallClockMs` (disabled by default, ignored below 2× stallMs) caps total runtime the same way. `AgentSpawnResult.abortReason`: `"user" | "stalled" | "wall-clock" | "maxTurns"`; monitor rows explain watchdog terminations.
- **Failure classification** — non-abort failures carry `failureClass: "transient" | "hard"` from a pattern table over the retained stderr tail (connection resets, timeouts, 429/5xx/rate-limit phrasing ⇒ transient). Parallel results group under Succeeded / Failed headers; each failure lists its class and task summary so the model can replay exactly the failed tasks in one follow-up call.
- Shared top-level `context` parameter on the `subagent` tool — prepended once to every spawned prompt in the call.

### Changed

- **UI merged into one fleet surface**: the former above-editor widget and FleetView roster are a single below-editor surface carrying the union stat set (turns · tools · tokens · context % · elapsed · live activity line), windowed to five rows with more-markers. Rendering is event-driven — monitor notifications coalesce into one ~150ms trailing-edge render; the 80ms/200ms/1000ms polling timers and the three-tier linger machine are gone (single 4s linger tier, self-disarming cadence timer).
- Settings keys renamed/consolidated: `fleet` (bool, default true) replaces the `widget` tri-state and `fleetView`. Legacy keys are ignored with a stderr warning.
- Bad agent files (unparseable frontmatter, missing required fields) now warn naming the file and skip — they no longer abort discovery of the remaining files.

### Migration

Settings migration table and per-key notes: [README → Migration from 2.0](./README.md#migration-from-20). Chain/preset migration: model sequencing as successive `subagent` calls (forward each result verbatim as the next task) or adopt `pi-dynamic-workflows`.

## [2.0.0] - 2026-08-25

**Major release — first npm publication under the `@fyeeme/pi-subagents` name** (successor of `@fyeeme/pi-subagent-core` 0.5.0, now retired). The head of the 2.0 extensions family wave (pi-review / pi-dynamic-workflows compose this package as their fan-out engine). Highlights: the composition architecture (consumers call `piSubagents(pi)` from their version-pinned dependency copy; the `subagent` tool registers exactly once per process via a globalThis guard, so consumer + standalone installs coexist), workflow prompt presets (`/implement`, `/scout-and-plan`, `/implement-and-review`), the `/reload` registration fix, and the whitelist-by-default recursion guard.

### Added

- `prompts/` workflow presets from the reference example (`examples/extensions/subagent/prompts/`), registered as pi prompt commands via the new `pi.prompts` manifest entry: `/implement` (scout → planner → worker), `/scout-and-plan` (scout → planner), `/implement-and-review` (worker → reviewer → worker). The root layout now mirrors the example one-to-one (index.ts / agents.ts / agents/ / prompts/); `src/` carries the inherited core layer beneath it.

### Changed

- `extension.ts` merged into `index.ts`: the package is now a single entry — library barrel + pi extension factory. The `pi.extensions` manifest points at `./index.ts`; the export surface (named library exports + the factory as default) is unchanged, so consumers need no code changes. A directory without `package.json` auto-loaded by pi as `index.ts` now finds the factory instead of failing.
- The extension factory is now exported as the library default (`import piSubagents from "@fyeeme/pi-subagents"`), so consumers compose it inside their own pi factories — tool + UI from their version-pinned dependency copy, replacing the consumer-manifest `node_modules` path wiring. The factory is idempotent per pi instance (globalThis composition guard): repeated composition and a standalone install coexist without double registration or duplicated lifecycle listeners.

### Removed

- Over-engineering audit trims (parity with the reference example's feature set): dead `formatAgentList` export (dead in the example too; carried over with a dead test), the per-call `parallelism` tool parameter (zero users; the shared ceiling env→settings→default precedence remains), the stat-stamp settings read cache (optimized a once-per-fan-out file read), and the `withFileMutationQueue` wrapper around transcript writes into a freshly `mkdtemp`'d directory (single-writer by construction; cargo cult inherited from the example).
- Per-agent transcript files (`os.tmpdir()/pi-sa-out-*` + 24h sweep + the "Full transcripts" result appendix): present in neither the reference example nor pi-subagent-core (it was pi-review's pre-v1.2.0 tool feature) and referenced by no consumer. Full output remains available in tool details and the `/agents` conversation viewer.

### Fixed

- `/reload` no longer silently unregisters the `subagent` tool until restart: the process-global registration guard survives reloads while the Extension objects do not, so every re-run factory saw it claimed and skipped `registerTool`. `session_shutdown(reason: "reload")` — which pi emits before the factories re-run — now releases the guard (quit/new/resume/fork keep it; those reuse the cached Extension objects). Reproduced via the real `DefaultResourceLoader` reload cycle.
- Parallel-mode task cap raised 8 → 16 (the bundled review skill instructs a single 10-finder batch at xhigh/max and grouped verifier fan-outs can exceed 8; concurrency is still bounded by the shared ceiling, so only the per-call task count changed). The cap is now stated in the `tasks` parameter description.
- `allowChildRecursion` wired per the dispatch core's documented whitelist opt-in: an agent definition listing `subagent` in its `tools:` frontmatter now actually opts its children into fan-out (previously the flag never reached spawnAgent and the documented opt-in was silently inert).
- Headless honesty: `confirmProjectAgents` schema text and the agents.ts/README wording now state that confirmation happens in interactive sessions only (headless runs cannot prompt and proceed without asking) — matches the inherited reference-example behavior.
- README "Wiring" section restored (adapted from the deleted pi-subagent-core README): the globalThis `Symbol.for` convergence, consumer `pi.extensions` manifest requirement, and dev-sync caveat the code comments point to.

## [0.1.0] - 2026-08-24

Successor of `@fyeeme/pi-subagent-core` (now deleted from this repo). Capability inheritance map:

| From pi-subagent-core | Here |
|---|---|
| `spawnAgent` / `mapWithConcurrencyLimit` / `createSpawnRegistry` / `abortAgent` / `getPiInvocation` (index.ts) | `src/dispatch.ts` — identical semantics and signatures (re-export surface unchanged for consumers) |
| settings.ts (`pi-subagent.json`, widget/fleetView/maxConcurrency) | `src/concurrency.ts` — same file name and keys |
| monitor.ts + sub-agent.ts + ui/ (agent widget, FleetView, /agents) | `src/monitor.ts`, `extension.ts`, `src/ui/` — globalThis symbol keys renamed to `@fyeeme/pi-subagents/*` |
| (pi-review's env ceiling shim) | `getMaxConcurrency` in `src/dispatch.ts` (PI_MAX_CONCURRENT_SUBAGENTS env → setting → default 5) |

New beyond the old core: the `subagent` tool itself (single/parallel/chain, agent-name referencing — interaction surface ported from pi's `examples/extensions/subagent`, execution on this dispatch core), three-source agent discovery (user / project / bundled `agents/` shipping scout/planner/reviewer/worker), `addAgentDir` for extensions to register their own agent directories (globalThis-shared across pi's per-extension module graphs), per-call `maxTurns`/`parallelism` parameters, and per-agent conversation transcripts under `pi-sa-out-*` (24h sweep).

