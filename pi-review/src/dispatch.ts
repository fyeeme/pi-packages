/**
 * src/dispatch.ts — the generic prompt dispatcher (v2's only command layer).
 *
 * Per invocation: parse leading arguments, gather deterministic runtime
 * variables (resolved diff via the candidate ladder, context usage,
 * changed-file context package, sticky last-effort state), evaluate the
 * guards declared in the selected template's frontmatter, pick the template
 * variant, substitute {{var}} placeholders, and hand the rendered message to
 * the session via sendUserMessage.
 *
 * The parallel-strategy decisions live in prompts/*.md frontmatter (data);
 * this module only executes them. Adding a new prompt/skill requires no
 * change here — the templates and skills are the registration surface.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { isFanoutToolAllowed } from "@fyeeme/pi-subagents";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DIFF_SCOPES, buildContextPackage, getRepoDiff, verifyLine } from "./diff.ts";
import { bundledSkillPath } from "./skills.ts";
import { parseGuards, selectVariant } from "./strategy.ts";

// This file lives at <pkg>/src/ → ".." is the package root.
const PKG_ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));

/** Absolute path to a prompt template bundled in this package's prompts/ dir. */
function bundledPromptPath(rel: string): string {
	return path.join(PKG_ROOT, "prompts", rel);
}

/** Load a bundled template: frontmatter map + body. */
function loadTemplate(rel: string): { frontmatter: Record<string, unknown>; body: string } {
	const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(
		fs.readFileSync(bundledPromptPath(rel), "utf8"),
	);
	return { frontmatter, body };
}

/** Substitute {{var}} placeholders. An unknown placeholder is an error at
 *  load time in dev, but rendering must never crash a command — unfilled
 *  placeholders are left visible (they self-report in the rendered message). */
function render(body: string, vars: Record<string, string>): string {
	return body.replace(/\{\{([a-z-]+)\}\}/g, (whole, name: string) =>
		name in vars ? vars[name]! : whole,
	);
}

// ---------------------------------------------------------------------------
// /review — effort-level code review (v1 command semantics, relocated)
// ---------------------------------------------------------------------------

/** Effort levels the /review command accepts (mirrors CC's effort enum). */
export const REVIEW_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ReviewLevel = (typeof REVIEW_LEVELS)[number];

const DEFAULT_LEVEL: ReviewLevel = "low";

/** Where the last explicitly-typed effort is persisted (CC 2.1.223 codeReviewLastEffort). */
const STATE_FILE = path.join(os.homedir(), ".pi", ".pi-review-state.json");

export type EffortSource = "explicit" | "last-used" | "default";

/**
 * Parse a leading effort level out of raw args; the remainder (flags + target)
 * is returned verbatim. Pure — unit-testable.
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
 * Explicit wins; otherwise the last-typed level; otherwise low.
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

// ---------------------------------------------------------------------------
// /simplify — cleanup fan-out with the declared parallel strategy
// ---------------------------------------------------------------------------

/** v1 DIFF_TOO_LARGE_CHARS — kept for the single-pass "too large to read at
 *  once" note (the strategy threshold itself lives in the template). */
const DIFF_TOO_LARGE_CHARS = 400_000;

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerDispatcher(pi: ExtensionAPI): void {
	pi.registerCommand("review", {
		description:
			"Review the current diff using the code-review skill. Usage: /review [low|medium|high|xhigh|max] [--fix] [--comment] [--share] [<pr#>|<branch>|<path>]",
		getArgumentCompletions(prefix) {
			const tokens = ["low", "medium", "high", "xhigh", "max", "--fix", "--comment", "--share"];
			return tokens.filter((t) => t.startsWith(prefix)).map((t) => ({ label: t, value: t }));
		},
		async handler(args) {
			const { level: explicit, rest } = parseReviewArgs(args ?? "");
			// Skip the read when we just wrote it — resolveEffort returns `explicit` unchanged.
			const lastUsed = explicit ? undefined : readLastEffort();
			if (explicit) writeLastEffort(explicit); // remember the explicit level
			const { level, source } = resolveEffort(explicit, lastUsed);
			const { body } = loadTemplate("review.md");
			pi.sendUserMessage(
				render(body, {
					effort: level,
					"effort-source": source,
					"extra-args": rest ? `; extra args: ${rest}` : "",
					skill: bundledSkillPath("code-review/SKILL.md"),
				}),
			);
		},
	});

	pi.registerCommand("simplify", {
		description:
			"Clean up the changed code (reuse/simplification/efficiency/altitude) using the simplify skill. Mode (parallel 4-agent vs single-pass) is decided from the strategy declared in prompts/simplify.*.md (context usage, diff size, fan-out availability); PARALLEL opens with a visible Phase 0 before the subagent tool launches the agents. Usage: /simplify [<target>]",
		async handler(args, ctx) {
			try {
				const outcome = await getRepoDiff(ctx.cwd, args?.trim() || undefined);
				if (outcome.kind === "no-repo") {
					ctx.ui.notify(`/simplify: ${ctx.cwd} is not inside a git repo — nothing to clean up.`, "warning");
					return;
				}
				if (outcome.kind === "git-error") {
					ctx.ui.notify(`/simplify: git failed — ${outcome.message}`, "error");
					return;
				}
				if (outcome.kind === "empty") {
					ctx.ui.notify(
						`/simplify: no changes found (checked unpushed+uncommitted vs @{upstream}, uncommitted vs HEAD, staged, unstaged) — nothing to clean up.`,
						"warning",
					);
					return;
				}

				const usage = ctx.getContextUsage();
				const parallelTemplate = loadTemplate("simplify.parallel.md");
				const { variant, reasons } = selectVariant(parseGuards(parallelTemplate.frontmatter), {
					tokens: usage?.tokens ?? null,
					contextWindow: usage?.contextWindow ?? 0,
					diffChars: outcome.diff.length,
					fanoutAvailable: isFanoutToolAllowed(),
				});
				const pct = usage && usage.percent != null ? `${Math.round(usage.percent)}%` : "?";
				const target = args || "(whole diff)";
				const skill = bundledSkillPath("simplify/SKILL.md");
				const scopeLabel = DIFF_SCOPES[outcome.scopeKind];
				const contextPackage = buildContextPackage(outcome.diff, outcome.gitRoot, scopeLabel);
				const verify = verifyLine(outcome.gitRoot);

				if (variant === "single-pass") {
					const { body } = loadTemplate("simplify.single.md");
					pi.sendUserMessage(
						render(body, {
							target,
							reasons: reasons.join("; "),
							"scope-label": scopeLabel,
							"too-large":
								outcome.diff.length >= DIFF_TOO_LARGE_CHARS
									? `\nThe diff is too large to read at once — work through it file-by-file from the changed-file list above.\n`
									: "",
							"git-command": outcome.gitCommand,
							"context-package": contextPackage,
							skill,
							verify,
						}),
					);
					return;
				}

				pi.sendUserMessage(
					render(parallelTemplate.body, {
						target,
						pct,
						"scope-label": scopeLabel,
						"git-command": outcome.gitCommand,
						"context-package": contextPackage,
						skill,
						verify,
					}),
				);
			} catch (err) {
				ctx.ui.notify(`/simplify failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}
