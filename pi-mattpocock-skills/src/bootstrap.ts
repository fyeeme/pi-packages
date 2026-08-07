import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Unique marker carried by the bootstrap message; its presence blocks re-injection. */
const BOOTSTRAP_MARKER = "mattpocock-skills-bootstrap-v1";

const BOOTSTRAP_CONTENT = `${BOOTSTRAP_MARKER}

mattpocock skills are installed. /ask-matt is the router.

Main flow: idea -> /grill-with-docs -> /to-spec -> /to-tickets -> /implement (drives /tdd + /code-review internally).

Short commands (user-invoked):
  /grill-me  /ask-matt  /grill-with-docs  /implement  /to-spec  /to-tickets
  /triage  /wayfinder  /improve-codebase-architecture  /setup-matt-pocock-skills
  /handoff  /teach  /writing-great-skills

Model-invoked skills (tdd, diagnosing-bugs, code-review, domain-modeling, codebase-design, prototype, research, resolving-merge-conflicts, grilling) are already in your system prompt and fire automatically — no command needed.

This is reference, not a mandate — reach for these when the user's task fits.`;

/** Whether a pending bootstrap injection is needed (set on start/compact). */
let injectBootstrap = true;

function messageContainsMarker(message: AgentMessage): boolean {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content.includes(BOOTSTRAP_MARKER);
	if (!Array.isArray(content)) return false;
	return content.some((part) => {
		return (
			part !== null &&
			typeof part === "object" &&
			(part as { type?: unknown }).type === "text" &&
			typeof (part as { text?: unknown }).text === "string" &&
			(part as { text: string }).text.includes(BOOTSTRAP_MARKER)
		);
	});
}

function firstNonCompactionSummaryIndex(messages: AgentMessage[]): number {
	let index = 0;
	while ((messages[index] as { role?: string } | undefined)?.role === "compactionSummary") {
		index += 1;
	}
	return index;
}

/**
 * Register the opt-in bootstrap. Injects the ask-matt router guidance once after
 * `session_start` and after each `session_compact` (when the prior message gets
 * summarised away). `agent_end` + the in-band marker prevent repeat injection.
 *
 * Only called when `MATTPOCOCK_ENABLE_BOOTSTRAP=1` (see index.ts).
 */
export function registerBootstrap(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		injectBootstrap = true;
	});
	pi.on("session_compact", () => {
		injectBootstrap = true;
	});
	pi.on("agent_end", () => {
		injectBootstrap = false;
	});
	pi.on("context", (event) => {
		if (!injectBootstrap) return;
		if (event.messages.some(messageContainsMarker)) return;

		const insertAt = firstNonCompactionSummaryIndex(event.messages);
		const bootstrapMessage = {
			role: "user",
			content: [{ type: "text", text: BOOTSTRAP_CONTENT }],
			timestamp: Date.now(),
		} as AgentMessage;

		injectBootstrap = false;
		return {
			messages: [
				...event.messages.slice(0, insertAt),
				bootstrapMessage,
				...event.messages.slice(insertAt),
			],
		};
	});
}

/** Exposed for tests to assert content without depending on the module-level flag. */
export const BOOTSTRAP_CONTENT_FOR_TEST = BOOTSTRAP_CONTENT;
