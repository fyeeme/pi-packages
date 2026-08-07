import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	COMMAND_TO_SKILL,
	buildSkillBlock,
	expandSkill,
	registerCommands,
	stripFrontmatter,
} from "../src/commands.ts";

describe("stripFrontmatter", () => {
	it("removes a YAML frontmatter block", () => {
		const content = "---\nname: x\ndescription: y\n---\n# Body\nline";
		expect(stripFrontmatter(content)).toBe("# Body\nline");
	});

	it("returns content unchanged when no frontmatter present", () => {
		expect(stripFrontmatter("plain text")).toBe("plain text");
	});
});

describe("buildSkillBlock", () => {
	it("matches pi _expandSkillCommand format exactly", () => {
		const block = buildSkillBlock(
			"grill-me",
			"/home/u/.pi/agent/skills/grill-me/SKILL.md",
			"BODY",
		);
		expect(block).toBe(
			'<skill name="grill-me" location="/home/u/.pi/agent/skills/grill-me/SKILL.md">\n' +
				"References are relative to /home/u/.pi/agent/skills/grill-me.\n\n" +
				"BODY\n</skill>",
		);
	});
});

describe("expandSkill", () => {
	it("reads SKILL.md, strips frontmatter, builds block, appends args", () => {
		const dir = mkdtempSync(join(tmpdir(), "mp-"));
		const skillDir = join(dir, "grill-me");
		mkdirSync(skillDir);
		writeFileSync(join(skillDir, "SKILL.md"), "---\nname: grill-me\n---\n# Grill Me\nbody");
		const out = expandSkill("grill-me", "arg1", dir);
		expect(out).toContain('<skill name="grill-me"');
		expect(out).toContain("# Grill Me\nbody");
		expect(out.endsWith("\n\narg1")).toBe(true);
	});
});

describe("registerCommands", () => {
	function mockPi() {
		const commands = new Map<string, { handler: (args: string) => Promise<void> }>();
		const sent: string[] = [];
		const pi = {
			registerCommand(name: string, opts: { handler: (args: string) => Promise<void> }) {
				commands.set(name, opts);
			},
			sendUserMessage(content: string) {
				sent.push(content);
			},
		} as unknown as ExtensionAPI;
		return { pi, commands, sent };
	}

	it("registers all 13 commands named per COMMAND_TO_SKILL", () => {
		const { pi, commands } = mockPi();
		registerCommands(pi);
		expect(commands.size).toBe(13);
		for (const name of COMMAND_TO_SKILL.keys()) expect(commands.has(name)).toBe(true);
	});

	it("handler sends a <skill> block, not a 'load with read' message", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mp-"));
		const skillDir = join(dir, "grill-me");
		mkdirSync(skillDir);
		writeFileSync(join(skillDir, "SKILL.md"), "---\nname: grill-me\n---\n# Grill");
		const { pi, commands, sent } = mockPi();
		registerCommands(pi, dir);
		await commands.get("grill-me")?.handler("");
		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain("<skill");
		expect(sent[0]).not.toContain("load with read");
	});
});
