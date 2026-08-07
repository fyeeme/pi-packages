import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { stripFrontmatter, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Default skills directory (path A: mattpocock skills symlinked here). */
export const DEFAULT_SKILLS_DIR = join(homedir(), ".pi", "agent", "skills");

/**
 * mattpocock user-invoked promoted skills mapped to their skill directory names.
 * Command name equals skill dir for all 13; kept explicit so future aliases are
 * one-place edits and a startup self-check can diff against the installed set.
 */
export const COMMAND_TO_SKILL: ReadonlyMap<string, string> = new Map([
	["grill-me", "grill-me"],
	["ask-matt", "ask-matt"],
	["grill-with-docs", "grill-with-docs"],
	["implement", "implement"],
	["to-spec", "to-spec"],
	["to-tickets", "to-tickets"],
	["triage", "triage"],
	["wayfinder", "wayfinder"],
	["improve-codebase-architecture", "improve-codebase-architecture"],
	["setup-matt-pocock-skills", "setup-matt-pocock-skills"],
	["handoff", "handoff"],
	["teach", "teach"],
	["writing-great-skills", "writing-great-skills"],
]);

/**
 * Strip YAML frontmatter (`--- ... ---`) from skill content.
 *
 * Delegates to pi's own `stripFrontmatter` (re-exported from
 * @earendil-works/pi-coding-agent), which normalizes CRLF and matches pi's
 * `_expandSkillCommand` behavior exactly — so the injected <skill> block stays
 * byte-identical to `/skill:<name>` regardless of the source file's line endings.
 */
export { stripFrontmatter };

/**
 * Build the pi `<skill>` block, mirroring pi's `_expandSkillCommand` format so
 * the injected content is byte-identical to `/skill:<name>` — guarantees the
 * content reaches the model and gets the `[skill]` render.
 */
export function buildSkillBlock(skillDir: string, filePath: string, body: string): string {
	return `<skill name="${skillDir}" location="${filePath}">\nReferences are relative to ${dirname(
		filePath,
	)}.\n\n${body}\n</skill>`;
}

/**
 * Expand a skill into the pi `<skill>` block plus optional args, reading
 * `SKILL.md` from `baseDir/<skillDir>/SKILL.md`. Mirrors `/skill:<name>` exactly.
 */
export function expandSkill(
	skillDir: string,
	args: string,
	baseDir: string = DEFAULT_SKILLS_DIR,
): string {
	const filePath = join(baseDir, skillDir, "SKILL.md");
	const content = readFileSync(filePath, "utf-8");
	const body = stripFrontmatter(content).trim();
	const block = buildSkillBlock(skillDir, filePath, body);
	return args ? `${block}\n\n${args}` : block;
}

/** Register the 13 short commands; each forwards to its skill via `expandSkill`. */
export function registerCommands(pi: ExtensionAPI, baseDir: string = DEFAULT_SKILLS_DIR): void {
	for (const [command, skillDir] of COMMAND_TO_SKILL) {
		pi.registerCommand(command, {
			description: `Run the ${skillDir} skill (equivalent to /skill:${skillDir}).`,
			async handler(args) {
				pi.sendUserMessage(expandSkill(skillDir, args || "", baseDir));
			},
		});
	}
}
