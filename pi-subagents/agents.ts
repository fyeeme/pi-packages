/**
 * agents.ts — three-source agent discovery for the `subagent` tool.
 *
 * Agent definitions are markdown files with YAML frontmatter:
 *
 *     ---
 *     name: my-agent
 *     description: What this agent does
 *     tools: read, grep, find, ls
 *     model: claude-haiku-4-5
 *     ---
 *     System prompt for the agent goes here.
 *
 * Sources (highest priority first):
 *   1. project — nearest `.pi/agents/` walking up from cwd (repo-controlled;
 *      requires per-call confirmation in interactive sessions; headless runs
 *      cannot prompt and proceed without asking)
 *   2. user    — `~/.pi/agent/agents/` (personal, cross-project)
 *   3. bundled — this package's own `agents/` directory (scout / planner /
 *      reviewer / worker — the generic baseline, always available)
 *
 * `agentScope` controls which of the user/project sources are included
 * ("user" default, "project", "both"); the bundled source is always included
 * as the package's own capability baseline. Same-name collisions resolve by
 * that priority order (project overrides user overrides bundled).
 *
 * Discovery re-runs on every invocation, so a dropped-in file takes effect on
 * the next call without a restart.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter, CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

/** Where an agent definition was found. */
export type AgentSource = "user" | "project" | "bundled";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	/** Optional JSON Schema (frontmatter `output:`) the agent's <result> payload
	 *  must satisfy when the caller does not pass a per-call outputSchema. */
	output?: Record<string, unknown>;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

/**
 * This file lives at the package root → the bundled agents directory is
 * `<pkg>/agents`. realpath collapses install-path symlinks (the package is
 * often symlinked into the pi extensions dir), matching how pi-review
 * resolves its bundled skills.
 */
const PKG_ROOT = fs.realpathSync(path.dirname(fileURLToPath(import.meta.url)));
const BUNDLED_AGENTS_DIR = path.join(PKG_ROOT, "agents");

/**
 * Extra agent directories registered by other extensions (e.g. pi-review
 * adds its own `agents/` with the finder/cleaner roles). Registered dirs sit
 * between user and this package's bundled dir in the priority order; the
 * later-registered dir wins among extras.
 *
 * The registry lives on globalThis (registered symbol), NOT module state: pi
 * loads every extension entry with `moduleCache: false`, so the registering
 * extension (pi-review's entry) and the tool (this package's extension
 * entry) run in separate module graphs that must still share this state —
 * the same pattern the dispatch monitor uses.
 */
const EXTRA_AGENT_DIRS_KEY = Symbol.for("@fyeeme/pi-subagents/agent-dirs");

function extraAgentDirs(): string[] {
	const store = globalThis as Record<symbol, unknown>;
	const existing = store[EXTRA_AGENT_DIRS_KEY] as string[] | undefined;
	if (existing) return existing;
	const created: string[] = [];
	store[EXTRA_AGENT_DIRS_KEY] = created;
	return created;
}

/** Register an extra agent discovery directory. Idempotent per resolved path.
 *  Returns a disposer that unregisters the dir (a test seam in practice —
 *  pi loads extensions once per process). */
export function addAgentDir(dir: string): () => void {
	const resolved = path.resolve(dir);
	const dirs = extraAgentDirs();
	if (!dirs.includes(resolved)) dirs.push(resolved);
	return () => {
		const i = dirs.indexOf(resolved);
		if (i >= 0) dirs.splice(i, 1);
	};
}

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			console.warn(`[pi-subagents] Skipping unreadable agent file: ${filePath}`);
			continue;
		}

		let frontmatter: Record<string, unknown>;
		let body: string;
		try {
			const parsed = parseFrontmatter<Record<string, unknown>>(content);
			frontmatter = parsed.frontmatter ?? {};
			body = parsed.body;
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			console.warn(`[pi-subagents] Skipping agent file with unparseable frontmatter (${reason}): ${filePath}`);
			continue;
		}

		// Strict string types, matching the reference implementation: a numeric
		// name (legal YAML) must not masquerade as an agent named "123".
		if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") {
			console.warn(
				`[pi-subagents] Skipping agent file missing required frontmatter fields (name, description): ${filePath}`,
			);
			continue;
		}

		// Both spellings are valid YAML and both are in use (parity with the
		// example's parseToolList):
		//     tools: read, bash        # string
		//     tools: [read, bash]      # array
		// Anything else yields no tools rather than throwing: agent discovery
		// must not let one bad file take down the other agents in the dir.
		const rawTools = Array.isArray(frontmatter.tools)
			? frontmatter.tools
			: typeof frontmatter.tools === "string"
				? frontmatter.tools.split(",")
				: [];
		const tools = rawTools
			.filter((t): t is string => typeof t === "string")
			.map((t) => t.trim())
			.filter(Boolean);

		// `output:` must be a YAML mapping; anything else is ignored (warned) so
		// a typo cannot silently disable validation.
		let output: Record<string, unknown> | undefined;
		if (frontmatter.output != null) {
			if (typeof frontmatter.output === "object" && !Array.isArray(frontmatter.output)) {
				output = frontmatter.output as Record<string, unknown>;
			} else {
				console.warn(`[pi-subagents] Ignoring non-object "output:" frontmatter in ${filePath}`);
			}
		}

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			output,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

/**
 * Discover agents per scope. Same-name collisions resolve by source priority:
 * project overrides user, user overrides extra/bundled dirs (insertion order
 * into the map below is the priority order).
 */
export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(path.join(getAgentDir(), "agents"), "user");
	const projectAgents =
		scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");
	// Insertion order = priority (a later set() overrides an earlier same-name
	// entry): package-bundled first, then extension-registered extra dirs
	// (later registration wins among extras).
	const bundledAgents = [
		...loadAgentsFromDir(BUNDLED_AGENTS_DIR, "bundled"),
		...extraAgentDirs().flatMap((dir) => loadAgentsFromDir(dir, "bundled")),
	];

	const agentMap = new Map<string, AgentConfig>();
	for (const agent of bundledAgents) agentMap.set(agent.name, agent);
	if (scope !== "project") for (const agent of userAgents) agentMap.set(agent.name, agent);
	if (scope !== "user" && projectAgentsDir)
		for (const agent of projectAgents) agentMap.set(agent.name, agent);

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}
