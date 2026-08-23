import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	createSpawnRegistry,
	isFanoutToolAllowed,
	lastAssistantText,
	mapWithConcurrencyLimit,
	spawnAgent,
} from "@fyeeme/pi-subagent-core";
import { getMaxConcurrency } from "../concurrency.ts";
import { bundledSkillPath } from "../skills.ts";

/** Context fraction at which we fall back to single-pass — a Pi-specific heuristic (see decideSimplifyMode). */
const CONTEXT_NEAR_FULL_THRESHOLD = 0.8;

/** Diff size (chars) at which we fall back to single-pass — a Pi-specific
 *  heuristic (see decideSimplifyMode). ~100K tokens per task copy: the 4-copy
 *  fan-out would spend ~400K input tokens on prompt text alone, and each
 *  agent's own window would be half-spent before it explores anything. */
export const DIFF_TOO_LARGE_CHARS = 400_000;

/** Soft cap on the changed-file list in the context package (see buildContextPackage). */
export const CONTEXT_PACKAGE_MAX_FILES = 200;

/** Turn budget for each of the 4 cleanup agents (mirrors code-review's gap-hunt cap). */
const SIMPLIFY_AGENT_MAX_TURNS = 15;

/** Tool whitelist for the cleanup agents — read-only exploration, no recursion. */
const SIMPLIFY_AGENT_TOOLS = ["read", "grep", "find", "ls", "bash"] as const;

/** Monotonic sequence for unique per-invocation fan-out callIds. */
let simplifyRunSeq = 0;

export type SimplifyMode = "parallel" | "single-pass";

/** Priority order for picking a verification command from package.json scripts. */
const VERIFY_SCRIPT_PRIORITY = ["check", "test", "lint", "typecheck"] as const;

/** One cleanup angle: display name + prompt. The angle definitions mirror the
 *  simplify skill's four angles so the command and the skill stay in sync. */
export interface SimplifyAngle {
	/** Row label in the agent UI (widget/FleetView). */
	displayName: string;
	/** Task opening line (also becomes the agent's row description). */
	headline: string;
	/** Full angle definition (the cleanup guidance the agent follows). */
	definition: string;
}

export const SIMPLIFY_ANGLES: SimplifyAngle[] = [
	{
		displayName: "Reuse",
		headline: "Review the changed code for reuse cleanup opportunities.",
		definition:
			"Flag new code that re-implements something the codebase already has — Grep shared/utility modules and files adjacent to the change, and name the existing helper to call instead.",
	},
	{
		displayName: "Simplification",
		headline: "Review the changed code for simplification opportunities.",
		definition:
			"Flag unnecessary complexity the diff adds: redundant or derivable state, copy-paste with slight variation, deep nesting, dead code left behind. Name the simpler form that does the same job.",
	},
	{
		displayName: "Efficiency",
		headline: "Review the changed code for efficiency opportunities.",
		definition:
			"Flag wasted work the diff introduces: redundant computation or repeated I/O, independent operations run sequentially, blocking work added to startup or hot paths. Also flag long-lived objects built from closures or captured environments — they keep the entire enclosing scope alive for the object's lifetime (a memory leak when that scope holds large values); prefer a class/struct that copies only the fields it needs. Name the cheaper alternative.",
	},
	{
		displayName: "Altitude",
		headline: "Review the changed code for altitude (right-depth) issues.",
		definition:
			"Check that each change is implemented at the right depth, not as a fragile bandaid. Special cases layered on shared infrastructure are a sign the fix isn't deep enough — prefer generalizing the underlying mechanism over adding special cases.",
	},
];

/**
 * Build the 4 cleanup-agent task specs from the diff. Pure — unit-testable.
 * Each spec carries a shared zero-token context package (repo root, scope
 * label, changed-file index — gathered handler-side where it costs no
 * parent-context tokens), its own angle prompt, and the diff; a shared
 * output-shape instruction keeps the collected findings uniformly structured.
 * The angle definition rides ONLY the systemPrompt (the agent's role) —
 * repeating it in the task body would send every agent the same definition
 * twice for zero information gain.
 */
export function buildSimplifyTasks(
	diff: string,
	contextPackage: string,
): { angle: SimplifyAngle; task: string; systemPrompt: string }[] {
	const shape =
		"Return your findings as a concise list. For each finding: `file:line` — one-line summary — the concrete cost (what is duplicated, wasted, or harder to maintain). Do not propose applying fixes; report only.";
	return SIMPLIFY_ANGLES.map((angle) => ({
		angle,
		task: `${contextPackage}\n\n${angle.headline}\n\n${shape}\n\nDiff to review:\n\n${diff}`,
		systemPrompt: angle.definition,
	}));
}

/**
 * Walk up from `from` to the nearest directory containing `.git` (a directory
 * or a submodule pointer file). Returns that root or null.
 */
export function findGitRoot(from: string): string | null {
	let dir = path.resolve(from);
	for (;;) {
		if (fs.existsSync(path.join(dir, ".git"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/** Normalize a /code-simplify target argument: trimmed, with an optional
 *  path-prefix `@` PRESERVED — a real directory may itself start with `@`
 *  (e.g. node_modules/@scope/pkg), so the resolver tries the literal path
 *  first and only falls back to the @-stripped form when it does not exist.
 *  Single source for the scope resolver and the trigger message's
 *  tool-invocation text so the two cannot diverge. */
function normalizeTarget(target: string | undefined): string {
	return (target ?? "").trim();
}

/** Resolve the diff scope for a `/code-simplify` target. Pure — unit-testable.
 *
 *  - target absent/unresolvable → the nearest git root of `cwd`, full diff.
 *  - target is a path → its nearest git root; the relative path inside that
 *    root is the diff scope. Crucially this covers git SUBMODULES: a target
 *    like `@packages/extensions/pi-review/` resolves to the submodule's own
 *    git root, so the real changes inside it (invisible to the parent repo's
 *    `git diff`) are reviewed instead of a dirty-submodule pointer.
 *  - target at the git root itself (e.g. the whole submodule) → full diff.
 * Returns null when no git root exists.
 */
export function resolveDiffScope(
	cwd: string,
	target: string | undefined,
): { gitRoot: string; relPath: string | null } | null {
	const raw = normalizeTarget(target);
	// The `@`-prefix path convention (`@packages/extensions/pi-review/`): try
	// the literal path FIRST (a real directory may itself start with `@`, e.g.
	// node_modules/@scope/pkg) and only fall back to the @-stripped form.
	let abs: string | null = null;
	if (raw) {
		for (const candidate of raw.startsWith("@") ? [raw, raw.slice(1)] : [raw]) {
			const resolved = path.resolve(cwd, candidate);
			if (fs.existsSync(resolved)) {
				abs = resolved;
				break;
			}
		}
	}
	// Unresolvable target — absent, or a non-path (branch / PR number) that
	// doesn't exist on disk — keeps the whole-diff scope of cwd's git root.
	if (abs == null) {
		const gitRoot = findGitRoot(cwd);
		return gitRoot ? { gitRoot, relPath: null } : null;
	}
	const gitRoot = findGitRoot(abs);
	if (!gitRoot) return null;
	const relPath = path.relative(gitRoot, abs);
	return { gitRoot, relPath: relPath === "" || relPath === "." ? null : relPath };
}

/** Injectably run `git` (defaults to promisified execFile — array argv, no
 * shell, and non-blocking: the handler is async, so git runs on the event
 * loop instead of freezing the TUI for the whole diff duration). */
export type GitRunner = (args: string[], opts: { cwd: string }) => Promise<string>;

const execFileAsync = promisify(execFile);

const defaultGitRunner: GitRunner = async (args, opts) =>
	(await execFileAsync("git", args, {
		cwd: opts.cwd,
		encoding: "utf8",
		maxBuffer: 10 * 1024 * 1024,
	})).stdout;

/** Which diff range produced the diff (drives scope reporting in prompts/messages). */
export type DiffScopeKind = "upstream" | "worktree" | "staged-fresh" | "unstaged-fresh";

/** Human label per scope kind — the single place the wording lives (the kind
 * itself is already carried by the map key / the outcome's scopeKind). */
export const DIFF_SCOPES: Record<DiffScopeKind, string> = {
	upstream: "unpushed commits + uncommitted changes (merge-base of @{upstream} → working tree)",
	worktree: "uncommitted changes (HEAD → working tree)",
	"staged-fresh": "staged changes (repo has no commits yet)",
	"unstaged-fresh": "unstaged changes (repo has no commits yet)",
};

/**
 * Result of resolving the /code-simplify diff. `ok` carries the diff plus the
 * scope kind that produced it and `gitCommand` — a shell-ready command that
 * reproduces the exact diff invocation (range + path limiter + git root), so
 * the trigger message can have the model re-read the SAME diff visibly
 * (CC-parity Phase 0) instead of re-deriving a different range; the failure
 * kinds are distinguishable so the handler can report WHY nothing was
 * reviewed instead of a blanket "no changes".
 */
export type DiffOutcome =
	| { kind: "ok"; diff: string; gitRoot: string; scopeKind: DiffScopeKind; gitCommand: string }
	| { kind: "no-repo" }
	| { kind: "empty" }
	| { kind: "git-error"; message: string };

/**
 * Resolve the diff for the `/code-simplify` scope (see resolveDiffScope),
 * widening the previously unstaged-only view to the full "changed code":
 *
 *  1. upstream — `git diff <merge-base @{upstream} HEAD>`: everything since
 *     divergence from the tracked upstream (unpushed commits + staged +
 *     unstaged) in one range. Matches the simplify skill's Phase 0 scope
 *     (`@{upstream}...HEAD` plus `git diff HEAD`): two-dot from the merge-base
 *     to the working tree is that union as a single unified diff. Skipped when
 *     no upstream is configured.
 *  2. worktree — `git diff HEAD`: all uncommitted (staged + unstaged).
 *  3. staged-fresh / unstaged-fresh — repos with no commits yet (HEAD doesn't
 *     resolve): index vs empty tree, then worktree vs index.
 *
 * The first candidate that yields a non-empty diff wins. All empty → `empty`;
 * every candidate erroring (broken repo, diff exceeding maxBuffer) →
 * `git-error` carrying the last error message; no git root → `no-repo`.
 */
export async function getRepoDiff(
	cwd: string,
	target: string | undefined,
	run: GitRunner = defaultGitRunner,
): Promise<DiffOutcome> {
	const scope = resolveDiffScope(cwd, target);
	if (!scope) return { kind: "no-repo" };
	const { gitRoot, relPath } = scope;
	const pathArgs: string[] = relPath ? ["--", relPath] : [];
	/** argv of one diff invocation — the single construction shared by the
	 *  executed call (diffAttempt) and the reproduction command (commandFor),
	 *  so the command shown to the model cannot drift from what ran. */
	const diffArgs = (range: string[]): string[] => ["diff", "--no-color", ...range, ...pathArgs];
	/** Shell-ready reproduction of a diff invocation (JSON.stringify quotes each
	 *  path — valid POSIX quoting that also escapes embedded quotes). Note the
	 *  relPath is re-quoted here for the DISPLAY only; the executed call uses
	 *  the raw argv (diffArgs). A shell interpreting the displayed command
	 *  produces the same argv, so the two cannot drift. */
	const commandFor = (range: string[]): string => {
		// Only shell-unsafe relPaths get quoted — a plain path stays clean in
		// the displayed command, a path with spaces/glob metachars is quoted
		// (JSON.stringify = valid POSIX quoting) so Phase 0 reproduces it
		// exactly.
		const safeRelPath = (p: string): string => (/^[A-Za-z0-9_./-]+$/.test(p) ? p : JSON.stringify(p));
		return [
			"git",
			"-C",
			JSON.stringify(gitRoot),
			"diff",
			"--no-color",
			...range,
			...(relPath ? ["--", safeRelPath(relPath)] : []),
		].join(" ");
	};

	let lastError: string | undefined;
	/** `recordError` false = a failure that is a legitimate fallback signal
	 *  (git diff HEAD on a repo with no commits yet) — it must not be mistaken
	 *  for a broken repo, or an empty fresh repo would report git-error
	 *  instead of empty. */
	const diffAttempt = async (range: string[], recordError = true): Promise<string | null> => {
		try {
			const out = (await run(diffArgs(range), { cwd: gitRoot })).trim();
			return out || null;
		} catch (err) {
			if (recordError) lastError = err instanceof Error ? err.message : String(err);
			return null;
		}
	};
	const mergeBaseWithUpstream = async (): Promise<string | null> => {
		try {
			return (await run(["merge-base", "@{upstream}", "HEAD"], { cwd: gitRoot })).trim() || null;
		} catch {
			return null;
		}
	};

	// Candidate ladder in priority order — the first non-empty diff wins.
	// `git diff HEAD` failing (recordError false) is the EXPECTED fresh-repo
	// signal, not a broken repo; the later staged/unstaged candidates carry
	// the real errors so a genuinely broken repo still surfaces git-error.
	const candidates: { scopeKind: DiffScopeKind; range: string[]; recordError: boolean }[] = [];
	const mb = await mergeBaseWithUpstream();
	if (mb) candidates.push({ scopeKind: "upstream", range: [mb], recordError: true });
	candidates.push(
		{ scopeKind: "worktree", range: ["HEAD"], recordError: false },
		{ scopeKind: "staged-fresh", range: ["--staged"], recordError: true },
		{ scopeKind: "unstaged-fresh", range: [], recordError: true },
	);
	for (const c of candidates) {
		const out = await diffAttempt(c.range, c.recordError);
		if (out) return { kind: "ok", diff: out, gitRoot, scopeKind: c.scopeKind, gitCommand: commandFor(c.range) };
	}
	return lastError ? { kind: "git-error", message: lastError } : { kind: "empty" };
}

/**
 * Build the zero-token context package injected into every cleanup-agent task
 * (and the single-pass trigger message): repo root, the resolved diff scope,
 * and a changed-file index with add/remove line counts, parsed straight out of
 * the diff — no extra git calls, no drift from the diff embedded below. This
 * is the context the handler can gather for free (handler-side git/parsing
 * costs no parent-context tokens), so each agent skips its own 1–3 exploration
 * rounds of `git diff --stat` and goes straight to its angle's grep targets.
 * Pure — unit-testable.
 */
export function buildContextPackage(diff: string, gitRoot: string, scopeLabel: string): string {
	const churn = new Map<string, { added: number; removed: number; binary: boolean }>();
	let current: string | null = null;
	/** git quotes path headers with non-ASCII/special chars (core.quotepath
	 *  default true) — accept both the plain and the quoted "a/…" "b/…" forms. */
	const FILE_HEADER = /^diff --git (?:a\/(.*) b\/(.*)|"a\/(.*)" "b\/(.*)")$/;
	/** `--- a/…` / `+++ b/…` (or /dev/null, or quoted variants) are file
	 *  headers, not content lines — but a CONTENT line may itself start with
	 *  `+`/`-` (rendered `+++x`), so only the exact header prefixes skip. */
	const HEADER_PREFIXES = [
		"--- a/",
		"--- /dev/null",
		"+++ b/",
		"+++ /dev/null",
		'--- "a/',
		'+++ "b/',
	];
	for (const line of diff.split("\n")) {
		const m = FILE_HEADER.exec(line);
		if (m) {
			current = m[2] ?? m[4]!;
			if (!churn.has(current)) churn.set(current, { added: 0, removed: 0, binary: false });
			continue;
		}
		if (current == null) continue;
		const c = churn.get(current)!;
		if (line.startsWith("Binary files")) c.binary = true;
		else if (HEADER_PREFIXES.some((p) => line.startsWith(p))) continue;
		else if (line.startsWith("+")) c.added++;
		else if (line.startsWith("-")) c.removed++;
	}

	// Map iterates in insertion order — the keys ARE the first-seen file order.
	const files = [...churn.keys()];
	const lines: string[] = [`Repo root: ${gitRoot}`, `Diff scope: ${scopeLabel}`];
	if (files.length > 0) {
		lines.push("Changed files (added/removed lines):");
		for (const f of files.slice(0, CONTEXT_PACKAGE_MAX_FILES)) {
			const c = churn.get(f)!;
			lines.push(`  ${f}${c.binary ? " (binary)" : ` +${c.added} -${c.removed}`}`);
		}
		if (files.length > CONTEXT_PACKAGE_MAX_FILES)
			lines.push(`  … and ${files.length - CONTEXT_PACKAGE_MAX_FILES} more (see the diff below)`);
	}
	return lines.join("\n");
}

/**
 * Pick the project verification command from a package.json `scripts` map, in
 * priority order (check → test → lint → typecheck). Pure — unit-testable.
 * Returns the runnable command (e.g. `npm run check`) or null when none exists.
 */
export function detectVerifyCommand(scripts: Record<string, string> | null): string | null {
	if (!scripts) return null;
	for (const key of VERIFY_SCRIPT_PRIORITY) {
		const v = scripts[key];
		if (typeof v === "string" && v.trim() !== "") return `npm run ${key}`;
	}
	return null;
}

/** Read package.json scripts from `cwd`; returns null when absent/unparseable. */
function readScriptsAt(cwd: string): Record<string, string> | null {
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")) as {
			scripts?: Record<string, string>;
		};
		return pkg.scripts ?? null;
	} catch {
		return null;
	}
}

/**
 * Decide simplify mode deterministically from real context usage, diff size,
 * and fan-out availability. Pure — unit-testable. Returns the mode plus the
 * reasons that produced it (announced in the trigger message so the decision
 * stays observable).
 *
 * CC parity note: CC's /simplify guard (Dii, verified in the 2.1.227 binary) is
 * a SPAWN-DEPTH recursion limit, NOT a context check — `ok(ctx.agentContext) >= wV()`
 * where ok() returns the agent's depth (main=0) and wV() returns
 * CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH (default 3). That is N/A on Pi: the
 * `subagent` tool spawns a fresh subprocess (depth 0), so depth never accumulates.
 * The guards below are Pi-specific substitutes, NOT mirrors of Dii:
 *   - context fraction (don't fan out when the parent's context is near-full);
 *   - diff size (don't 4× a huge diff into task prompts — DIFF_TOO_LARGE_CHARS);
 *   - fan-out availability (the `simplify_fanout` tool must be registered for
 *     THIS process — isFanoutToolAllowed(); a default-spawned child has no
 *     fan-out tools, so PARALLEL is only offered where it can physically run).
 * Dii's other clause (the Agent-equivalent tool must be in the allowlist) is
 * the Pi counterpart of that last guard. The cleanup agents' tool whitelist
 * (read/grep/find/ls/bash) never includes a fan-out tool, so recursion stays
 * physically bounded regardless of tool registration.
 */
export function decideSimplifyMode(opts: {
	tokens: number | null;
	contextWindow: number;
	diffChars: number;
	/** Whether fan-out tools are registered in this process (top-level session:
	 *  yes; a default-spawned child: no — the recursion guard). PARALLEL mode is
	 *  only offered when the fan-out can physically be launched. */
	fanoutAvailable: boolean;
}): { mode: SimplifyMode; reasons: string[] } {
	const { tokens, contextWindow, diffChars, fanoutAvailable } = opts;
	const reasons: string[] = [];
	// Conservative: if we can't measure context (tokens unknown / window 0),
	// don't risk fan-out — go single-pass.
	if (tokens == null || contextWindow <= 0) reasons.push("context usage unknown");
	if (tokens != null && contextWindow > 0 && tokens / contextWindow >= CONTEXT_NEAR_FULL_THRESHOLD)
		reasons.push(`context ${Math.round((tokens / contextWindow) * 100)}% full`);
	if (diffChars >= DIFF_TOO_LARGE_CHARS)
		reasons.push(`diff too large (${Math.round(diffChars / 1024)} KB ≥ fan-out threshold)`);
	if (!fanoutAvailable) reasons.push("fan-out unavailable in this context (subagent recursion guard)");
	return { mode: reasons.length > 0 ? "single-pass" : "parallel", reasons };
}

/** One fan-out agent's collected outcome (see runSimplifyFanoutSpecs). */
export interface FanoutResult {
	angle: string;
	text: string;
	failed: boolean;
	aborted: boolean;
	exitCode: number;
	errorMessage?: string;
}

/** Render the 4 fan-out results as the findings markdown handed to Phase 2.
 * Pure — unit-testable. Aborted (user cancel / maxTurns budget) must not
 * masquerade as a clean "(no findings)" review outcome — it is marked, keeping
 * any partial findings the agent did write. */
export function formatFanoutResults(results: FanoutResult[]): string {
	return results
		.map((res) => {
			let body: string;
			if (!res.failed) body = res.text || "(no findings)";
			else if (res.aborted)
				body = res.text
					? `[agent aborted — partial findings]\n${res.text}`
					: "[agent aborted — no findings]";
			else body = res.text
				? `[agent failed: ${res.errorMessage ?? `exit ${res.exitCode}`} — partial findings]\n${res.text}`
				: `[agent failed: ${res.errorMessage ?? `exit ${res.exitCode}`} — no findings]`;
			return `### ${res.angle}\n${body}`;
		})
		.join("\n\n");
}

/** Build the "verify/apply" guidance line shown to the model after fan-out. */
function verifyLine(ctx: { cwd: string }): string {
	const verifyCmd = detectVerifyCommand(readScriptsAt(ctx.cwd));
	return verifyCmd
		? `Verification command: \`${verifyCmd}\` (detected from package.json scripts). After applying Phase 2 fixes, run it; on failure, follow the skill's auto-revert procedure — never leave the working tree verified-broken.`
		: `No verification command detected in package.json (looked for check/test/lint/typecheck). Apply fixes and report outcomes, but state in the report that no verification was run (verification is opportunistic, never blocking).`;
}

/** The Phase 2 procedure as cited by the PARALLEL trigger message and the
 *  fan-out tool's result — one source so the two citations cannot drift. */
const PHASE2_PROCEDURE =
	"snapshot → apply → verify → auto-revert on failure → report via review_report with `fanned_out: true`";

/** The verbatim-shared Phase 0 opening (context package + the exact
 *  reproduction command) — identical in both trigger builders, keeping the
 *  "same CC-parity opening" claim true by construction. */
function phase0Block(contextPackage: string, gitCommand: string): string {
	return (
		`${contextPackage}\n\n` +
		`Run exactly this command (the handler already resolved the scope — do not re-derive a different range):\n\n` +
		`    ${gitCommand}\n\n`
	);
}

/**
 * Build the SINGLE-PASS trigger message. Pure — unit-testable. Phase 0 is a
 * visible, model-run step: the exact git command the handler resolved plus a
 * change-intent summary before the angles are worked — same CC-parity opening
 * as PARALLEL mode, minus the fan-out.
 */
export function buildSinglePassTrigger(opts: {
	target: string;
	scopeLabel: string;
	gitCommand: string;
	contextPackage: string;
	reasons: string[];
	tooLarge: boolean;
	skill: string;
	verify: string;
}): string {
	return (
		`Clean up the changed code now. Target: ${opts.target}.\n\n` +
		`Handler decided SINGLE-PASS mode (${opts.reasons.join("; ")}). Scope: ${opts.scopeLabel}.\n\n` +
		`## Phase 0 — read the diff first\n\n` +
		phase0Block(opts.contextPackage, opts.gitCommand) +
		`Read the full diff, then write a 2–4 line change-intent summary before reviewing.\n` +
		(opts.tooLarge
			? `The diff is too large to read at once — work through it file-by-file from the changed-file list above.\n`
			: "") +
		`\nThen load ${opts.skill} via the read tool and follow its single-pass body. ` +
		`Work the four angles inline — do not fake fan-out.` +
		`\n${opts.verify}`
	);
}

/**
 * Build the PARALLEL trigger message. Pure — unit-testable. This is the
 * CC-parity opening: the model gathers the diff VISIBLY first (run the exact
 * git command the handler resolved, read it, write a change-intent summary)
 * and only then dispatches via the `simplify_fanout` tool — nothing spawns
 * until the model has read the diff, so the session never "rushes" into
 * agents. The tool (not the model) re-resolves the diff and owns the task
 * packaging; its result carries the findings for Phase 2.
 */
export function buildParallelTrigger(opts: {
	target: string;
	scopeLabel: string;
	gitCommand: string;
	contextPackage: string;
	pct: string;
	/** How to invoke the fan-out tool, preformatted (with or without a target). */
	toolInvocation: string;
	skill: string;
	verify: string;
}): string {
	return (
		`Clean up the changed code now. Target: ${opts.target}.\n\n` +
		`Handler decided PARALLEL mode (context ${opts.pct} full; scope ${opts.scopeLabel}). ` +
		`Follow the phases IN ORDER — do not launch anything before Phase 0 is done.\n\n` +
		`## Phase 0 — read the diff (visible, before any agent launches)\n\n` +
		phase0Block(opts.contextPackage, opts.gitCommand) +
		`Read the full diff, then write a 2–4 line change-intent summary BEFORE launching anything — ` +
		`that summary and your first-hand reading are what you will use to merge, dedup, and judge ` +
		`the agents' findings in Phase 2.\n\n` +
		`## Phase 1 — launch the 4 cleanup agents\n\n` +
		`Call ${opts.toolInvocation}. It re-resolves this same diff deterministically, embeds it in each ` +
		`agent's task, and dispatches ${SIMPLIFY_ANGLES.map((a) => a.displayName).join(" / ")} as real pi subprocesses ` +
		`(maxTurns ${SIMPLIFY_AGENT_MAX_TURNS}, read-only tools; they appear live in the agent widget / FleetView). Do NOT write the ` +
		`agent prompts yourself or inline the diff anywhere — the tool owns the packaging. Its result ` +
		`carries the four findings reports.\n\n` +
		`## Phase 2 — apply, verify, report\n\n` +
		`When the tool result arrives, merge/dedup the findings against your Phase 0 reading, then ` +
		`load ${opts.skill} via the read tool and follow its Phase 2 (${PHASE2_PROCEDURE} — the 4-agent fan-out ` +
		`actually ran). Never apply changes the findings don't justify.` +
		`\n${opts.verify}`
	);
}

/** Parameters for the simplify_fanout tool. */
const SimplifyFanoutParams = Type.Object({
	target: Type.Optional(
		Type.String({
			description:
				"Diff target exactly as announced in the /code-simplify trigger message (pass through verbatim; file path or @-prefixed path). Omit when the trigger says whole-diff.",
		}),
	),
});

/** Details streamed via onUpdate while the fan-out runs (progress counter). */
interface SimplifyFanoutDetails {
	done?: number;
	total?: number;
}

/**
 * The `simplify_fanout` tool — PARALLEL mode's dispatch gate (CC-parity
 * opening). The command's trigger message has the model gather the diff
 * visibly first; this tool is the visible "launch" moment (the counterpart of
 * CC's Agent-tool call). It re-resolves the diff ITSELF — never trusting
 * model-passed diff text — and re-checks the fan-out guards with FRESH
 * context usage (the model has just read the whole diff, which is exactly the
 * growth the command-side check could not see) before spawning the 4 agents
 * through the shared subagent core. Registered only when fan-out is allowed
 * for this process (same recursion guard as the `subagent` tool).
 */
export const simplifyFanoutTool = defineTool<typeof SimplifyFanoutParams, SimplifyFanoutDetails>({
	name: "simplify_fanout",
	label: "Simplify fan-out",
	description:
		"Launch the 4 cleanup review agents (Reuse / Simplification / Efficiency / Altitude) for /code-simplify PARALLEL mode. Call it only as instructed by the /code-simplify trigger message, AFTER reading the diff and writing the change-intent summary. It re-resolves the diff itself (pass `target` through verbatim from the trigger message; omit for whole-diff) — never send diff text. Returns the four agents' findings reports for Phase 2.",
	promptSnippet:
		"Launch the 4 /code-simplify cleanup agents (Reuse/Simplification/Efficiency/Altitude); returns their findings.",
	parameters: SimplifyFanoutParams,
	async execute(_toolCallId, params, signal, onUpdate, ctx) {
		const outcome = await getRepoDiff(ctx.cwd, params.target?.trim() || undefined);
		if (outcome.kind === "no-repo")
			return {
				content: [
					{
						type: "text" as const,
						text: "simplify_fanout: cwd is not inside a git repo — nothing to clean up. Say so and stop.",
					},
				],
				details: {},
			};
		if (outcome.kind === "git-error")
			return {
				content: [
					{
						type: "text" as const,
						text: `simplify_fanout: git failed — ${outcome.message}. Say so and stop (do not retry — the failure is persistent).`,
					},
				],
				details: {},
			};
		if (outcome.kind === "empty")
			return {
				content: [
					{
						type: "text" as const,
						text: "simplify_fanout: no changes found (the tree changed since /code-simplify ran?) — nothing to clean up. Say so and stop.",
					},
				],
				details: {},
			};

		// Fresh-usage guard: redirect to single-pass when the fan-out conditions
		// no longer hold. Soft guidance (not an error) — the skill's single-pass
		// body is the documented fallback.
		const usage = ctx.getContextUsage();
		const { mode, reasons } = decideSimplifyMode({
			tokens: usage?.tokens ?? null,
			contextWindow: usage?.contextWindow ?? 0,
			diffChars: outcome.diff.length,
			fanoutAvailable: true, // the tool only registers when fan-out is allowed
		});
		if (mode === "single-pass")
			return {
				content: [
					{
						type: "text" as const,
						text: `Fan-out conditions no longer hold since /code-simplify ran (${reasons.join("; ")}). Do NOT launch agents — load the simplify skill via the read tool and follow its SINGLE-PASS body instead; report with \`fanned_out: false\`.`,
					},
				],
				details: {},
			};

		const scopeLabel = DIFF_SCOPES[outcome.scopeKind];
		const contextPackage = buildContextPackage(outcome.diff, outcome.gitRoot, scopeLabel);
		const tasks = buildSimplifyTasks(outcome.diff, contextPackage);
		const registry = createSpawnRegistry();
		// Explicit ceiling via the subagent tool's shared resolver — the same
		// PI_MAX_CONCURRENT_SUBAGENTS env → maxConcurrency setting precedence
		// on every fan-out path in this package.
		let done = 0;
		// Unique per-invocation callId: a re-run while the previous fan-out is
		// still alive must not re-register the same monitor callId (callStarted
		// replaces; the old subprocess's late callEnded would mark the NEW call
		// settled early).
		const runToken = `${Date.now()}-${++simplifyRunSeq}`;
		const results = await mapWithConcurrencyLimit(tasks, getMaxConcurrency(), async (spec) => {
			// No --model: a bare ctx.model.id is ambiguous across providers
			// ("glm-5.3" matches opencode-go/zai/zai-coding-cn) and would
			// fail the subprocess. Omitting it matches the subagent tool's
			// default — the child runs the configured default model.
			const r = await spawnAgent(registry, {
				callId: `simplify-${spec.angle.displayName}-${runToken}`,
				task: spec.task,
				systemPrompt: spec.systemPrompt,
				maxTurns: SIMPLIFY_AGENT_MAX_TURNS,
				tools: [...SIMPLIFY_AGENT_TOOLS],
				displayName: spec.angle.displayName,
				// The diff paths / context package "Repo root:" are relative to
				// the RESOLVED git root (possibly a git submodule, or a root above
				// the session cwd) — agents must explore from there, not from
				// process.cwd(), or every read/grep of a diff path ENOENTs.
				cwd: outcome.gitRoot,
				signal,
			});
			done++;
			onUpdate?.({
				content: [{ type: "text" as const, text: `${done}/${tasks.length} cleanup agents finished` }],
				details: { done, total: tasks.length },
			});
			return {
				angle: spec.angle.displayName,
				text: lastAssistantText(r.messages),
				// An aborted agent must not masquerade as a clean review even when
				// its process exited 0 (graceful SIGTERM handler).
				failed: r.exitCode !== 0 || r.aborted,
				aborted: r.aborted,
				exitCode: r.exitCode,
				errorMessage: r.errorMessage,
			};
		});

		return {
			content: [
				{
					type: "text" as const,
					text: `All ${results.length} cleanup agents finished (scope: ${scopeLabel}).\n\n${formatFanoutResults(results)}\n\nProceed to Phase 2 per the trigger message: merge/dedup the findings, then load the simplify skill and follow its Phase 2 (${PHASE2_PROCEDURE}).`,
				},
			],
			details: { done, total: results.length },
		};
	},
});

/**
 * Register the /code-simplify command.
 *
 * The handler resolves the diff FIRST (widened scope — see getRepoDiff), so the
 * mode decision can factor in diff size and fan-out availability alongside
 * ctx.getContextUsage(), and so an unresolvable/empty diff terminates before
 * any parent-context tokens are spent in either mode. Both modes then open
 * the SAME way (CC parity): the trigger message carries the handler-resolved
 * scope, the changed-file index, and the exact git command, and makes the
 * model run Phase 0 visibly — read the diff, write a change-intent summary —
 * BEFORE anything launches. In PARALLEL mode the fan-out is TOOL-GATED: the
 * model dispatches by calling `simplify_fanout` (registered by the extension
 * entry), whose handler re-resolves the diff and spawns the 4 agents through
 * the shared subagent core; the findings come back as that tool's result for
 * Phase 2. SINGLE-PASS mode delegates the four angles to the model inline.
 */
export function registerSimplify(pi: ExtensionAPI): void {
	pi.registerCommand("code-simplify", {
		description:
			"Clean up the changed code (reuse/simplification/efficiency/altitude) using the simplify skill. Mode (parallel 4-agent vs single-pass) is decided by the handler from real context usage, diff size, and fan-out availability; PARALLEL opens with a visible Phase 0 (read the diff, summarize) before the simplify_fanout tool launches the agents. Usage: /code-simplify [<target>]",
		async handler(args, ctx) {
			try {
				const outcome = await getRepoDiff(ctx.cwd, args?.trim() || undefined);
				if (outcome.kind === "no-repo") {
					ctx.ui.notify(
						`/code-simplify: ${ctx.cwd} is not inside a git repo — nothing to clean up.`,
						"warning",
					);
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
				const { mode, reasons } = decideSimplifyMode({
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
				// The raw target travels through to the tool invocation so the tool's
				// own resolveDiffScope re-resolves the SAME scope (literal @-paths
				// first).
				const targetArg = normalizeTarget(args);

				if (mode === "single-pass") {
					pi.sendUserMessage(
						buildSinglePassTrigger({
							target,
							scopeLabel,
							gitCommand: outcome.gitCommand,
							contextPackage,
							reasons,
							tooLarge: outcome.diff.length >= DIFF_TOO_LARGE_CHARS,
							skill,
							verify: verifyLine({ cwd: outcome.gitRoot }),
						}),
					);
					return;
				}

				// PARALLEL: tool-gated fan-out. The trigger message makes the model
				// gather the diff visibly first (Phase 0) and dispatch via the
				// simplify_fanout tool — no agents spawn until that call happens.
				pi.sendUserMessage(
					buildParallelTrigger({
						target,
						scopeLabel,
						gitCommand: outcome.gitCommand,
						contextPackage,
						pct,
						toolInvocation: targetArg
							? `the \`simplify_fanout\` tool with \`target: "${targetArg}"\` (pass the target through verbatim)`
							: "the `simplify_fanout` tool (no arguments)",
						skill,
						verify: verifyLine({ cwd: outcome.gitRoot }),
					}),
				);
			} catch (err) {
				ctx.ui.notify(`/code-simplify failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}
