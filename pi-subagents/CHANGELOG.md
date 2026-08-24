# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- `extension.ts` merged into `index.ts`: the package is now a single entry — library barrel + pi extension factory. The `pi.extensions` manifest points at `./index.ts`; the export surface (named library exports + the factory as default) is unchanged, so consumers need no code changes. A directory without `package.json` auto-loaded by pi as `index.ts` now finds the factory instead of failing.
- The extension factory is now exported as the library default (`import piSubagents from "@fyeeme/pi-subagents"`), so consumers compose it inside their own pi factories — tool + UI from their version-pinned dependency copy, replacing the consumer-manifest `node_modules` path wiring. The factory is idempotent per pi instance (globalThis composition guard): repeated composition and a standalone install coexist without double registration or duplicated lifecycle listeners.

### Removed

- Over-engineering audit trims (parity with the reference example's feature set): dead `formatAgentList` export (dead in the example too; carried over with a dead test), the per-call `parallelism` tool parameter (zero users; the shared ceiling env→settings→default precedence remains), the stat-stamp settings read cache (optimized a once-per-fan-out file read), and the `withFileMutationQueue` wrapper around transcript writes into a freshly `mkdtemp`'d directory (single-writer by construction; cargo cult inherited from the example).

### Fixed

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

