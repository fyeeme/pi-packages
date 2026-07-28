import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Register the /code-review command — triggers the code-review-v3 skill. */
export function registerCodeReview(pi: ExtensionAPI): void {
	pi.registerCommand("code-review", {
		description:
			"Review the current diff using the code-review-v3 skill. Usage: /code-review [low|medium|high|xhigh|max] [--fix] [--comment] [--share] [<target>]",
		getArgumentCompletions(prefix) {
			const tokens = ["low", "medium", "high", "xhigh", "max", "--fix", "--comment", "--share"];
			return tokens.filter((t) => t.startsWith(prefix)).map((t) => ({ label: t, value: t }));
		},
		async handler(args) {
			pi.sendUserMessage(
				`Run a code review now. Args: ${args || "(default: low)"}.\n\n` +
					`First load the review skill with the read tool: ~/.pi/agent/skills/code-review-v3/SKILL.md. ` +
					`Then follow it exactly — use the \`subagent\` tool for any fan-out / verify / gap-hunt the skill calls for.`,
			);
		},
	});
}
