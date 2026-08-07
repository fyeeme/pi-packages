import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { bundledSkillPath } from "../skills.ts";

/** Effort levels the /code-review command accepts (mirrors CC's effort enum). */
export const REVIEW_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ReviewLevel = (typeof REVIEW_LEVELS)[number];

const DEFAULT_LEVEL: ReviewLevel = "low";

/** Where the last explicitly-typed effort is persisted (CC 2.1.223 codeReviewLastEffort). */
const STATE_FILE = path.join(os.homedir(), ".pi", ".pi-review-state.json");

export type EffortSource = "explicit" | "last-used" | "default";

/**
 * Parse a leading effort level out of raw args; the remainder (flags + target)
 * is returned verbatim. Pure — unit-testable. Mirrors CC's ecl()/Tjn(): the
 * first token is the level only if it matches the enum; otherwise the whole
 * string is the target/flags.
 */
export function parseReviewArgs(args: string): { level: ReviewLevel | undefined; rest: string } {
	const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return { level: undefined, rest: "" };
	const first = tokens[0]!.toLowerCase();
	const isLevel = (REVIEW_LEVELS as readonly string[]).includes(first);
	return {
		level: isLevel ? (first as ReviewLevel) : undefined,
		rest: isLevel ? tokens.slice(1).join(" ") : tokens.join(" "),
	};
}

/**
 * Resolve the effective effort + where it came from. Pure — unit-testable.
 * Mirrors CC 2.1.223: explicit wins; otherwise reuse the last-typed level;
 * otherwise the default. (220 defaulted straight to low with no memory.)
 */
export function resolveEffort(
	explicit: ReviewLevel | undefined,
	lastUsed: ReviewLevel | undefined,
): { level: ReviewLevel; source: EffortSource } {
	if (explicit) return { level: explicit, source: "explicit" };
	if (lastUsed) return { level: lastUsed, source: "last-used" };
	return { level: DEFAULT_LEVEL, source: "default" };
}

// Best-effort persistence — sticky-effort is a convenience, not a correctness
// invariant; a read/write failure must not break the review.
function readLastEffort(): ReviewLevel | undefined {
	try {
		const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as { codeReviewLastEffort?: unknown };
		const v = raw.codeReviewLastEffort;
		return typeof v === "string" && (REVIEW_LEVELS as readonly string[]).includes(v)
			? (v as ReviewLevel)
			: undefined;
	} catch {
		return undefined;
	}
}
function writeLastEffort(level: ReviewLevel): void {
	try {
		fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
		fs.writeFileSync(STATE_FILE, JSON.stringify({ codeReviewLastEffort: level }));
	} catch {
		/* ignore — non-critical */
	}
}

/**
 * Register the /code-review command — triggers the code-review skill.
 *
 * Handler decides the effective effort deterministically (CC 2.1.223): an
 * explicit level is persisted and used; with no level, the last-typed level is
 * reused; with no history, it falls back to low. The decision is announced in
 * the trigger message so it is observable — same pattern as /code-simplify.
 */
export function registerCodeReview(pi: ExtensionAPI): void {
	pi.registerCommand("code-review", {
		description:
			"Review the current diff using the code-review skill. Usage: /code-review [low|medium|high|xhigh|max] [--fix] [--comment] [--share] [<pr#>|<branch>|<path>]",
		getArgumentCompletions(prefix) {
			const tokens = ["low", "medium", "high", "xhigh", "max", "--fix", "--comment", "--share"];
			return tokens.filter((t) => t.startsWith(prefix)).map((t) => ({ label: t, value: t }));
		},
		async handler(args) {
			const { level: explicit, rest } = parseReviewArgs(args ?? "");
			// Skip the read when we just wrote it — resolveEffort returns `explicit` unchanged.
			const lastUsed = explicit ? undefined : readLastEffort();
			if (explicit) writeLastEffort(explicit); // CC 2.1.223: remember the explicit level
			const { level, source } = resolveEffort(explicit, lastUsed);
			pi.sendUserMessage(
				`Run a code review now. Effective effort: ${level} (${source})${rest ? `; extra args: ${rest}` : ""}.\n\n` +
					`First load the review skill with the read tool: ${bundledSkillPath("code-review/SKILL.md")}. ` +
					`Then follow it exactly — use the \`subagent\` tool for any fan-out / verify / gap-hunt the skill calls for.`,
			);
		},
	});
}
