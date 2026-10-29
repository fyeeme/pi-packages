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
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { isFanoutToolAllowed } from "@fyeeme/pi-subagents";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTurnBudgets } from "./config.ts";
import { DIFF_SCOPES, buildContextPackage, countDiffLines, getRepoDiff, verifyLine } from "./diff.ts";
import { extractLoopFlag, runLoopFixing } from "./loop.ts";
import { buildReviewNote, readReviewInstructions } from "./review-md.ts";
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
 *  placeholders are left visible (they self-report in the rendered message).
 *  Pure — unit-testable. */
export function render(body: string, vars: Record<string, string>): string {
	return body.replace(/\{\{([a-z-]+)\}\}/g, (whole, name: string) =>
		name in vars ? vars[name]! : whole,
	);
}

// ---------------------------------------------------------------------------
// /code-review — effort-level code review (v1 command semantics, relocated)
// ---------------------------------------------------------------------------

/** Effort levels the /code-review command accepts (mirrors CC's effort enum). */
const REVIEW_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ReviewLevel = (typeof REVIEW_LEVELS)[number];

const DEFAULT_LEVEL: ReviewLevel = "low";

/** Where the last explicitly-typed effort is persisted (CC 2.1.223
 *  codeReviewLastEffort). Shares the config file so users have a single
 *  pi-review.json; the field is written alongside `maxTurns`, never over it. */
const STATE_FILE = path.join(getAgentDir(), "pi-review.json");

export type EffortSource = "explicit" | "last-used" | "default";

/**
 * Parse a leading effort level out of raw args; the remainder (flags + target)
 * is returned verbatim. Pure — unit-testable.
 */
/** True when the effort level uses the xhigh/max finder/verifier fan-out;
 *  false for the single-pass levels (low/medium/high). Pure — unit-testable. */
export function usesFanout(level: ReviewLevel): boolean {
	return level === "xhigh" || level === "max";
}

/** Optimal-string-alignment (Damerau–Levenshtein) edit distance — catches
 *  transpositions ("meduim") that plain Levenshtein scores 2 for. */
function editDistance(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	// d[i][j] = distance between a[..i] and b[..j]
	const d: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
	for (let i = 0; i <= m; i++) d[i][0] = i;
	for (let j = 0; j <= n; j++) d[0][j] = j;
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			let v = Math.min(d[i - 1][j]! + 1, d[i][j - 1]! + 1, d[i - 1][j - 1]! + cost);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
				v = Math.min(v, d[i - 2][j - 2]! + 1);
			}
			d[i][j] = v;
		}
	}
	return d[m][n]!;
}

/** True when `token` is plausibly a mistyped effort level rather than a real
 *  review target (path / PR# / branch): a prefix of a level ("hig"), a level
 *  plus a short suffix ("high2"), or within edit distance 1 (2 once the token
 *  is long enough that a distance-2 collision with a real word is unlikely).
 *  "main", "dev", "123", "src/foo.ts" all stay targets. */
function looksLikeLevelTypo(token: string): boolean {
	const t = token.toLowerCase();
	if (t.length < 2) return false;
	return REVIEW_LEVELS.some((lvl) => {
		if (lvl.startsWith(t) || (t.startsWith(lvl) && t.length <= lvl.length + 2)) return true;
		const d = editDistance(t, lvl);
		return d === 1 || (d === 2 && t.length >= 6);
	});
}

/** CC 2.1.291 `To` — accepts `--max-findings 20`, `--max-findings=20`,
 *  `--max-findings = 20`, and a bare `--max-findings` (no value → ignored).
 *  Global + last-match-wins (CC reads the LAST occurrence via `.at(-1)`),
 *  and the whole match (boundary + flag + value) strips back to its leading
 *  boundary so the value can never leak into the target. */
const MAX_FINDINGS_RE = /(^|\s)--max-findings(?:(?:\s*=\s*|\s+)(?!--)(\S+)|\s*=\S*)?(?=\s|$)/g;

/** A parsed `--max-findings` value: a positive integer, `all` (no numeric cap
 *  this run, 32-report hard ceiling still applies), or `default` (clear the
 *  persisted value, use the effort table's cap). CC 2.1.291 `Io`. */
export type MaxFindings = number | "all" | "default";

/** Validate a `--max-findings` value (string form from the flag, or a
 *  persisted number). Returns undefined for anything invalid (0, negative,
 *  non-numeric, garbage). Pure — unit-testable. */
export function normalizeMaxFindings(v: unknown): number | "all" | undefined {
	if (v === "all") return "all";
	if (typeof v === "number") return Number.isSafeInteger(v) && v > 0 ? v : undefined;
	if (typeof v === "string" && /^\d+$/.test(v)) {
		const n = Number(v);
		return n > 0 ? n : undefined;
	}
	return undefined;
}

export function parseReviewArgs(args: string): {
	level: ReviewLevel | undefined;
	rest: string;
	/** A first token that looks like a mistyped effort level ("meduim") but
	 *  matches none — the handler warns (CC "Ignoring unrecognized effort")
	 *  instead of silently reviewing it as a target. */
	unrecognized?: string;
	/** Explicit `--max-findings` value (last occurrence wins); `default` means
	 *  clear the persisted limit, not "use no limit". */
	maxFindings?: MaxFindings;
	/** The flag was typed with a value that validates against nothing — the
	 *  handler warns and the review uses the usual limit (CC
	 *  `maxFindingsIgnored`); the token is stripped, never a target. */
	maxFindingsIgnored?: boolean;
} {
	const raw = (args ?? "").trim();
	const lastMax = [...raw.matchAll(MAX_FINDINGS_RE)].at(-1);
	const stripped = lastMax ? raw.replace(MAX_FINDINGS_RE, "$1") : raw;
	const tokens = stripped.split(/\s+/).filter(Boolean);
	let level: ReviewLevel | undefined;
	let rest = "";
	let unrecognized: string | undefined;
	if (tokens.length > 0) {
		const first = tokens[0]!.toLowerCase();
		const isLevel = (REVIEW_LEVELS as readonly string[]).includes(first);
		if (isLevel) {
			level = first as ReviewLevel;
			rest = tokens.slice(1).join(" ");
		} else {
			const typo = looksLikeLevelTypo(first);
			rest = (typo ? tokens.slice(1) : tokens).join(" ");
			unrecognized = typo ? first : undefined;
		}
	}
	let maxFindings: MaxFindings | undefined;
	let maxFindingsIgnored: boolean | undefined;
	if (lastMax) {
		const v = (lastMax[2] ?? "").toLowerCase();
		if (v === "all" || v === "default") maxFindings = v;
		else {
			maxFindings = normalizeMaxFindings(v);
			if (maxFindings === undefined) maxFindingsIgnored = true;
		}
	}
	return { level, rest, unrecognized, maxFindings, maxFindingsIgnored };
}

/** CC 2.1.291 `Bs` — finder budget: clamp(ceil(lines/150), 2, 8); undefined
 *  when the count failed (no hint injected, default fan-out unchanged).
 *  Pure — unit-testable. */
export function budgetFromLines(lines: number | undefined): number | undefined {
	if (lines === undefined || lines <= 0) return undefined;
	return Math.max(2, Math.min(8, Math.ceil(lines / 150)));
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

// Best-effort persistence — sticky-effort and sticky-max-findings are
// conveniences, not correctness invariants; a read/write failure must not
// break the review. Both share one state file with user-authored config
// (maxTurns), so all writes are read-modify-write and never clobber a
// hand-edited file they cannot parse. The `file` parameter exists for tests.
export function readStateFile(file = STATE_FILE): Record<string, unknown> {
	try {
		const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
		return raw as Record<string, unknown>;
	} catch {
		return {};
	}
}
export function updateStateFile(patch: Record<string, unknown>, file = STATE_FILE): void {
	try {
		let existing: Record<string, unknown> = {};
		if (fs.existsSync(file)) {
			let raw: unknown;
			try {
				raw = JSON.parse(fs.readFileSync(file, "utf8"));
			} catch {
				return;
			}
			if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
			existing = raw as Record<string, unknown>;
		}
		for (const [key, value] of Object.entries(patch)) {
			if (value === undefined) delete existing[key];
			else existing[key] = value;
		}
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, `${JSON.stringify(existing, null, 2)}\n`);
	} catch {
		/* ignore — non-critical */
	}
}
function readLastEffort(file = STATE_FILE): ReviewLevel | undefined {
	const v = readStateFile(file).codeReviewLastEffort;
	return typeof v === "string" && (REVIEW_LEVELS as readonly string[]).includes(v)
		? (v as ReviewLevel)
		: undefined;
}
function writeLastEffort(level: ReviewLevel): void {
	updateStateFile({ codeReviewLastEffort: level });
}

// ---------------------------------------------------------------------------
// /code-simplify — cleanup fan-out with the declared parallel strategy
// ---------------------------------------------------------------------------

/** v1 DIFF_TOO_LARGE_CHARS — kept for the single-pass "too large to read at
 *  once" note (the strategy threshold itself lives in the template). */
const DIFF_TOO_LARGE_CHARS = 400_000;

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** The trigger's "Findings limit:" note (CC 2.1.291 `Oo`): states the
 *  effective limit, marks a reused one, and names the reset flag. Empty when
 *  no limit applies (effort-table default). Pure — unit-testable. */
export function buildLimitNote(
	explicit: MaxFindings | undefined,
	sticky: number | "all" | undefined,
): string {
	const effective = explicit !== undefined && explicit !== "default" ? explicit : sticky;
	if (effective === undefined) return "";
	const reused = explicit === undefined ? " (reused from the last run)" : "";
	return effective === "all"
		? `\nFindings limit: \`all\`${reused} — no numeric cap this run, but a single report is hard-capped at 32 findings. \`--max-findings default\` restores the usual limit.\n`
		: `\nFindings limit: ${effective}${reused} — report at most ${effective} findings, most-severe first. \`--max-findings default\` restores the usual limit.\n`;
}

/** REVIEW.md resolution for the trigger message — never fails the command
 *  (readReviewInstructions already degrades internally; this belt-and-suspenders
 *  guard keeps an unexpected throw from breaking the review). */
async function buildReviewNoteSafely(cwd: string, signal?: AbortSignal): Promise<string> {
	try {
		return buildReviewNote(await readReviewInstructions(cwd, undefined, undefined, signal));
	} catch {
		return "";
	}
}

export function registerDispatcher(pi: ExtensionAPI): void {
	// The `subagent` tool ships dormant at the top level (pi-subagents design
	// dormant-top-level-tool): registered everywhere, declared to the model
	// nowhere until someone activates it. Review/simplify need it only on the
	// fan-out paths, so three entry points activate it for the session:
	//   1. /code-review at xhigh/max (the fan-out effort levels);
	//   2. /code-simplify when the strategy picks the parallel variant;
	//   3. the `before_agent_start` hook below, when a user-triggered run's
	//      prompt carries a code-review/code-simplify skill injection (the
	//      skill body tells the model to call `subagent` directly at xhigh/max,
	//      without a command).
	// Staying active after the run is harmless and keeps follow-up reviews
	// in the same session tool-continuous.
	const ensureSubagentTool = (): void => {
		const active = pi.getActiveTools();
		if (!active.includes("subagent")) pi.setActiveTools([...active, "subagent"]);
	};
	const REVIEW_SKILL_MARKERS = ['<skill name="code-review"', '<skill name="code-simplify"'];
	pi.on("before_agent_start", (event) => {
		// Only user-triggered runs: the skill block reaches this hook expanded in
		// `prompt` (pi expands /skill:name before the run starts), and this event
		// fires BEFORE the run's tool declarations are snapshotted, so the
		// activation lands in the SAME request (a `context` hook would fire one
		// loadout-generation too late). Custom messages (extension-driven sends)
		// are covered by their own command-time activation above.
		if (event.messageType !== "user") return;
		if (pi.getActiveTools().includes("subagent")) return;
		if (REVIEW_SKILL_MARKERS.some((marker) => event.prompt.includes(marker))) ensureSubagentTool();
	});

	pi.registerCommand("code-review", {
		description:
			"Review the current diff using the code-review skill. low/medium/high review in a single pass in this session; xhigh/max fan out finder/verifier agents. Usage: /code-review [low|medium|high|xhigh|max] [--fix] [--loop] [--comment] [--share] [--max-findings <n>|all|default] [<pr#>|<branch>|<path>]",
		getArgumentCompletions(prefix) {
			const tokens = [
				"low",
				"medium",
				"high",
				"xhigh",
				"max",
				"--fix",
				"--loop",
				"--comment",
				"--share",
				"--max-findings",
			];
			return tokens.filter((t) => t.startsWith(prefix)).map((t) => ({ label: t, value: t }));
		},
		async handler(args, ctx) {
			const { level: explicit, rest, unrecognized, maxFindings, maxFindingsIgnored } = parseReviewArgs(args ?? "");
			if (unrecognized !== undefined) {
				ctx.ui.notify(
					`/code-review: ignoring unrecognized effort "${unrecognized}"; valid: ${REVIEW_LEVELS.join(", ")}.`,
					"warning",
				);
			}
			if (maxFindingsIgnored) {
				ctx.ui.notify(
					"/code-review: --max-findings was ignored: type a whole number above zero, `all`, or `default` after it. Using the usual limit.",
					"warning",
				);
			}
			// Skip the read when we just wrote it — resolveEffort returns `explicit` unchanged.
			const lastUsed = explicit ? undefined : readLastEffort();
			if (explicit) writeLastEffort(explicit); // remember the explicit level
			const { level, source } = resolveEffort(explicit, lastUsed);
			const budgets = loadTurnBudgets();
			// Fan-out efforts need the dormant `subagent` tool declared to the model.
			if (level === "xhigh" || level === "max") ensureSubagentTool();

			// Sticky --max-findings (CC 2.1.291 Io/Oo): an explicit value persists,
			// `default` clears it, and no value reuses the persisted one — including
			// when the typed value was ignored (CC falls back to the persisted limit
			// there too). Never persisted: `default` itself.
			if (maxFindings === "default") {
				updateStateFile({ codeReviewLastMaxFindings: undefined });
			} else if (maxFindings !== undefined) {
				updateStateFile({ codeReviewLastMaxFindings: maxFindings });
			}
			const effectiveMax =
				maxFindings === undefined || maxFindings === "default"
					? normalizeMaxFindings(readStateFile().codeReviewLastMaxFindings)
					: maxFindings;
			const limitNote = buildLimitNote(maxFindings, effectiveMax);

			// Effort split: low/medium/high review in ONE pass in the main session
			// (no subprocess fan-out); xhigh/max keep the finder/verifier pipeline.
			const fanout = usesFanout(level);

			// --loop is extension-level (drives fix→re-review rounds against the
			// structured report), so it never reaches the skill text. It needs a
			// single report turn to loop on — fan-out levels have no such turn.
			const { wantLoop, rest: flagsRest } = extractLoopFlag(rest);
			const loopArmed = wantLoop && !fanout;
			if (wantLoop && fanout) {
				ctx.ui.notify(
					`/code-review: --loop applies to single-pass levels (low/medium/high) — ignored for ${level}.`,
					"warning",
				);
			}

			const { body } = loadTemplate(fanout ? "review.parallel.md" : "review.single.md");

			// Finder budget hint (CC 2.1.291 Bs/Gs): fan-out levels only — measure
			// the committed range with numstat (hooks off, bounded) and suggest a
			// finder count scaled to diff size. Silent no-hint when the count
			// fails, so a slow or exotic repo keeps the default fan-out.
			let budgetNote = "";
			if (fanout) {
				const lines = await countDiffLines(ctx.cwd, flagsRest.trim() || undefined, undefined, ctx.signal);
				const finders = budgetFromLines(lines);
				if (lines !== undefined && finders !== undefined) {
					budgetNote = `\nFinder budget: the committed range measures about ${lines} changed lines. Start with about ${finders} finder agents (min 2, max 8) and scale your investigation depth to the diff size rather than a fixed large fleet. Uncommitted changes are not counted — treat the count as a floor.\n`;
				}
			}

			const shared = {
				effort: level,
				"effort-source": source,
				"extra-args": flagsRest ? `; extra args: ${flagsRest}` : "",
				skill: bundledSkillPath("code-review/SKILL.md"),
				// Consumed by the skill's --fix flow (apply → verify → re-report).
				verify: verifyLine(ctx.cwd),
				// The skill's Output contract consumes the effective findings limit.
				"limit-note": limitNote,
				// REVIEW.md (base-resolved by the dispatcher) — empty when absent.
				"review-note": await buildReviewNoteSafely(ctx.cwd, ctx.signal),
			};
			void pi.sendUserMessage(
				render(
					body,
					fanout
						? {
								...shared,
								"budget-note": budgetNote,
							}
						: {
								...shared,
								// Told to the session so every finding carries a P0–P3 priority.
								"loop-note": loopArmed
									? `\nLoop fixing is armed: after your report, the extension drives up to ${budgets.loop} fix→re-review rounds until no P0/P1 findings remain — so tag every finding with a priority (P0–P3).\n`
									: "",
							},
				),
			);
			if (loopArmed) {
				await runLoopFixing(pi, ctx, {
					level,
					passes: budgets.loop,
					// Must match where review_report writes (CONFIG_DIR_NAME,
					// not necessarily ".pi") or the loop never finds a report.
					reviewDir: path.join(ctx.cwd, CONFIG_DIR_NAME, "review"),
				});
			}
		},
	});

	pi.registerCommand("code-simplify", {
		description:
			"Clean up the changed code (reuse/simplification/efficiency/altitude) using the code-simplify skill. Mode (parallel 4-agent vs single-pass) is decided from the strategy declared in prompts/simplify.*.md (context usage, diff size, fan-out availability); PARALLEL opens with a visible Phase 0 before the subagent tool launches the agents. Usage: /code-simplify [<target>]",
		async handler(args, ctx) {
			try {
				// ctx.signal (undefined while idle) lets Esc abort an in-flight diff.
			const outcome = await getRepoDiff(ctx.cwd, args?.trim() || undefined, undefined, ctx.signal);
				if (outcome.kind === "no-repo") {
					ctx.ui.notify(`/code-simplify: ${ctx.cwd} is not inside a git repo — nothing to clean up.`, "warning");
					return;
				}
				if (outcome.kind === "git-error") {
					ctx.ui.notify(`/code-simplify: git failed — ${outcome.message}`, "error");
					return;
				}
				if (outcome.kind === "empty") {
					ctx.ui.notify(
						`/code-simplify: no changes found (checked unpushed+uncommitted vs @{upstream}, uncommitted vs HEAD, staged, unstaged) — nothing to clean up.`,
						"warning",
					);
					return;
				}

				const usage = ctx.getContextUsage();
				const budgets = loadTurnBudgets(ctx.cwd);
				const parallelTemplate = loadTemplate("simplify.parallel.md");
				const { variant, reasons } = selectVariant(parseGuards(parallelTemplate.frontmatter), {
					tokens: usage?.tokens ?? null,
					contextWindow: usage?.contextWindow ?? 0,
					diffChars: outcome.diff.length,
					fanoutAvailable: isFanoutToolAllowed(),
				});
				// The parallel variant fans out through the dormant `subagent` tool.
				if (variant !== "single-pass") ensureSubagentTool();
				const pct = usage && usage.percent != null ? `${Math.round(usage.percent)}%` : "?";
				const target = args || "(whole diff)";
				const skill = bundledSkillPath("code-simplify/SKILL.md");
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
				ctx.ui.notify(`/code-simplify failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}
