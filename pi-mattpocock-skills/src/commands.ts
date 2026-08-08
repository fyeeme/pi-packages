import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "./prefs.ts";

/**
 * Default skills directory (path A: mattpocock skills symlinked here). Derived
 * from `getAgentDir()` so it honors `PI_CODING_AGENT_DIR` like the prefs file,
 * instead of duplicating a hardcoded `~/.pi/agent` that silently diverges.
 */
export const DEFAULT_SKILLS_DIR = join(getAgentDir(), "skills");

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
 * Strip a leading YAML frontmatter fence (`--- ... ---`) from skill content.
 *
 * Inlined (per design D1) to mirror pi's own `stripFrontmatter` body logic —
 * CRLF-normalize, then slice between the `---` fences — so the injected `<skill>`
 * block stays identical to `/skill:<name>` for valid YAML frontmatter regardless
 * of the source file's line endings. Inlined rather than value-imported so
 * loading this module does not pull the coding-agent agent-session graph into
 * tests or the extension runtime. Note: pi's version also runs a YAML parse on
 * the frontmatter (throwing on malformed YAML); this inline copy deliberately
 * skips the parse, so malformed frontmatter is stripped rather than errored.
 * Returns the body; content without a frontmatter fence is returned normalized.
 */
export function stripFrontmatter(content: string): string {
	const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	if (!normalized.startsWith("---")) return normalized;
	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) return normalized;
	return normalized.slice(endIndex + 4).trim();
}

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
				try {
					pi.sendUserMessage(expandSkill(skillDir, args || "", baseDir));
				} catch (error) {
					// Surface instead of dropping the invocation (pi's /skill: passes
					// through on missing skills): the user sees why nothing happened.
					const msg = error instanceof Error ? error.message : String(error);
					pi.sendUserMessage(
						`/${command} failed: cannot read ${skillDir}/SKILL.md (${msg}). ` +
							`Check the mattpocock skills symlink under ${join(baseDir, skillDir)} (README: path A).`,
					);
				}
			},
		});
	}
}
