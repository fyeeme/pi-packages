/**
 * agents.test.ts — three-source discovery (bundled / user / project).
 *
 * The user-level agent directory is redirected via PI_CODING_AGENT_DIR (what
 * getAgentDir() reads) to a temp dir so the suite never touches the real
 * ~/.pi/agent/agents. The project source is exercised against temp dirs with
 * a .pi/agents/ subtree.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { addAgentDir, discoverAgents } from "../agents.ts";

const AGENT_MD = (name: string, description: string, body = "system prompt") =>
	`---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;

let tmpRoot: string;
let userDir: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agents-"));
	// getAgentDir() reads PI_CODING_AGENT_DIR; user agents live in <agentDir>/agents.
	userDir = path.join(tmpRoot, "agent-dir", "agents");
	fs.mkdirSync(userDir, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = path.join(tmpRoot, "agent-dir");
});

afterEach(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("bundled source", () => {
	it("discovers the four bundled generic agents with no user/project agents", () => {
		const { agents, projectAgentsDir } = discoverAgents(tmpRoot, "user");
		const names = agents.map((a) => a.name).sort();
		expect(names).toEqual(["planner", "reviewer", "scout", "worker"]);
		for (const a of agents) expect(a.source).toBe("bundled");
		expect(projectAgentsDir).toBeNull();
	});

	it("parses frontmatter fields (tools whitelist, body as system prompt)", () => {
		const { agents } = discoverAgents(tmpRoot, "user");
		const scout = agents.find((a) => a.name === "scout")!;
		expect(scout.tools).toContain("read");
		expect(scout.systemPrompt).toContain("You are a scout.");
		// The bundled set is provider-neutral: no hardcoded model.
		expect(scout.model).toBeUndefined();
	});
});

describe("source priority", () => {
	it("user overrides bundled on name collision", () => {
		fs.writeFileSync(path.join(userDir, "reviewer.md"), AGENT_MD("reviewer", "my own reviewer", "custom"));
		const { agents } = discoverAgents(tmpRoot, "user");
		const reviewer = agents.find((a) => a.name === "reviewer")!;
		expect(reviewer.source).toBe("user");
		expect(reviewer.systemPrompt).toBe("custom");
	});

	it("project overrides user and bundled on name collision (scope both)", () => {
		fs.writeFileSync(path.join(userDir, "reviewer.md"), AGENT_MD("reviewer", "user reviewer"));
		const proj = path.join(tmpRoot, "proj", ".pi", "agents");
		fs.mkdirSync(proj, { recursive: true });
		fs.writeFileSync(path.join(proj, "reviewer.md"), AGENT_MD("reviewer", "project reviewer", "from project"));

		const { agents, projectAgentsDir } = discoverAgents(path.join(tmpRoot, "proj"), "both");
		const reviewer = agents.find((a) => a.name === "reviewer")!;
		expect(reviewer.source).toBe("project");
		expect(projectAgentsDir).toBe(proj);
	});

	it("scope user excludes project agents; scope project excludes user agents", () => {
		const proj = path.join(tmpRoot, "proj", ".pi", "agents");
		fs.mkdirSync(proj, { recursive: true });
		fs.writeFileSync(path.join(proj, "local.md"), AGENT_MD("local", "project-only agent"));
		fs.writeFileSync(path.join(userDir, "mine.md"), AGENT_MD("mine", "user-only agent"));

		const userScoped = discoverAgents(path.join(tmpRoot, "proj"), "user").agents.map((a) => a.name);
		expect(userScoped).toContain("mine");
		expect(userScoped).not.toContain("local");

		const projectScoped = discoverAgents(path.join(tmpRoot, "proj"), "project").agents.map((a) => a.name);
		expect(projectScoped).toContain("local");
		expect(projectScoped).not.toContain("mine");
		// Bundled stays available in every scope.
		expect(projectScoped).toContain("scout");
	});

	it("skips files without required frontmatter fields", () => {
		fs.writeFileSync(path.join(userDir, "broken.md"), "---\nname: broken\n---\nno description");
		fs.writeFileSync(path.join(userDir, "notmd.txt"), AGENT_MD("ignored", "wrong extension"));
		const { agents } = discoverAgents(tmpRoot, "user");
		expect(agents.find((a) => a.name === "broken")).toBeUndefined();
		expect(agents.find((a) => a.name === "ignored")).toBeUndefined();
	});
});

describe("project dir discovery", () => {
	it("walks up from cwd to the nearest .pi/agents", () => {
		const proj = path.join(tmpRoot, "walk-up", ".pi", "agents");
		fs.mkdirSync(proj, { recursive: true });
		fs.writeFileSync(path.join(proj, "deep.md"), AGENT_MD("deep", "found from below"));

		const fromDeep = path.join(tmpRoot, "walk-up", "a", "b", "c");
		const { projectAgentsDir, agents } = discoverAgents(fromDeep, "both");
		expect(projectAgentsDir).toBe(proj);
		expect(agents.find((a) => a.name === "deep")).toBeDefined();
	});
});

describe("malformed agent files", () => {
	it("warns on stderr naming the file, skips it, keeps siblings", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		fs.writeFileSync(path.join(userDir, "broken.md"), "no frontmatter here");
		fs.writeFileSync(
			path.join(userDir, "half.md"),
			"---\nname: only-name\n---\nbody",
		);
		fs.writeFileSync(
			path.join(userDir, "good.md"),
			AGENT_MD("good-agent", "A good agent", "works"),
		);
		const { agents } = discoverAgents(tmpRoot, "user");
		const names = agents.map((a) => a.name);
		expect(names).toContain("good-agent");
		expect(names).not.toContain("only-name");
		expect(warn.mock.calls.some((c) => String(c[0]).includes("broken.md"))).toBe(true);
		expect(warn.mock.calls.some((c) => String(c[0]).includes("half.md"))).toBe(true);
		warn.mockRestore();
	});
});

describe("output schema frontmatter", () => {
	it("parses a YAML `output:` mapping into AgentConfig.output", () => {
		fs.writeFileSync(
			path.join(userDir, "structured.md"),
			[
				"---",
				"name: structured",
				"description: emits json",
				"output:",
				"  type: object",
				"  properties:",
				"    summary:",
				"      type: string",
				"  required:",
				"    - summary",
				"---",
				"prompt body",
			].join("\n"),
		);
		const agent = discoverAgents(tmpRoot, "both").agents.find((a) => a.name === "structured");
		expect(agent?.output).toEqual({
			type: "object",
			properties: { summary: { type: "string" } },
			required: ["summary"],
		});
	});

	it("ignores and warns about non-object output frontmatter", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		fs.writeFileSync(
			path.join(userDir, "bad-output.md"),
			"---\nname: bad-output\ndescription: x\noutput: oops\n---\nbody\n",
		);
		const agent = discoverAgents(tmpRoot, "both").agents.find((a) => a.name === "bad-output");
		expect(agent?.output).toBeUndefined();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('"output:"'));
		warn.mockRestore();
	});
});
