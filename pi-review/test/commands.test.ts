import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSpawnResult } from "@fyeeme/pi-subagent-core";
import { lastAssistantText } from "@fyeeme/pi-subagent-core";
import {
	buildContextPackage,
	buildParallelTrigger,
	buildSinglePassTrigger,
	buildSimplifyTasks,
	CONTEXT_PACKAGE_MAX_FILES,
	decideSimplifyMode,
	detectVerifyCommand,
	DIFF_TOO_LARGE_CHARS,
	formatFanoutResults,
	getRepoDiff,
	resolveDiffScope,
	type FanoutResult,
} from "../src/commands/code-simplify.ts";
import { parseReviewArgs, resolveEffort } from "../src/commands/code-review.ts";

describe("decideSimplifyMode", () => {
	const window = 100_000;

	it("parallel when context is not near-full and the diff is small", () => {
		const d = decideSimplifyMode({ tokens: 50_000, contextWindow: window, diffChars: 1_000, fanoutAvailable: true });
		expect(d.mode).toBe("parallel");
		expect(d.reasons).toEqual([]);
	});

	it("single-pass when context is near-full (>=80%)", () => {
		const d = decideSimplifyMode({ tokens: 85_000, contextWindow: window, diffChars: 1_000, fanoutAvailable: true });
		expect(d.mode).toBe("single-pass");
		expect(d.reasons.join(" ")).toContain("85% full");
	});

	it("single-pass (conservative) when token count is unknown", () => {
		const d = decideSimplifyMode({ tokens: null, contextWindow: window, diffChars: 1_000, fanoutAvailable: true });
		expect(d.mode).toBe("single-pass");
		expect(d.reasons.join(" ")).toContain("unknown");
	});

	it("at exactly the 80% threshold → single-pass (boundary is >=)", () => {
		const d = decideSimplifyMode({ tokens: 80_000, contextWindow: window, diffChars: 1_000, fanoutAvailable: true });
		expect(d.mode).toBe("single-pass");
	});

	it("just below the threshold → parallel", () => {
		const d = decideSimplifyMode({ tokens: 79_000, contextWindow: window, diffChars: 1_000, fanoutAvailable: true });
		expect(d.mode).toBe("parallel");
	});

	it("single-pass when the diff is too large, even with full headroom", () => {
		const d = decideSimplifyMode({ tokens: 10_000, contextWindow: window, diffChars: DIFF_TOO_LARGE_CHARS, fanoutAvailable: true });
		expect(d.mode).toBe("single-pass");
		expect(d.reasons.join(" ")).toContain("diff too large");
	});

	it("just below the diff-size threshold → parallel", () => {
		const d = decideSimplifyMode({
			tokens: 10_000,
			contextWindow: window,
			diffChars: DIFF_TOO_LARGE_CHARS - 1,
			fanoutAvailable: true,
		});
		expect(d.mode).toBe("parallel");
	});

	it("accumulates multiple reasons (unknown context + huge diff)", () => {
		const d = decideSimplifyMode({ tokens: null, contextWindow: 0, diffChars: DIFF_TOO_LARGE_CHARS, fanoutAvailable: true });
		expect(d.mode).toBe("single-pass");
		expect(d.reasons).toHaveLength(2);
	});

	it("single-pass when fan-out is unavailable, even with full headroom and a tiny diff", () => {
		const d = decideSimplifyMode({ tokens: 10_000, contextWindow: window, diffChars: 1_000, fanoutAvailable: false });
		expect(d.mode).toBe("single-pass");
		expect(d.reasons.join(" ")).toContain("fan-out unavailable");
	});
});

describe("parseReviewArgs", () => {
	it("parses a leading level and returns the rest", () => {
		expect(parseReviewArgs("high src/foo.ts --fix")).toEqual({ level: "high", rest: "src/foo.ts --fix" });
	});

	it("is case-insensitive on the level token", () => {
		expect(parseReviewArgs("XHIGH").level).toBe("xhigh");
	});

	it("treats a leading flag as flags (no level)", () => {
		expect(parseReviewArgs("--fix")).toEqual({ level: undefined, rest: "--fix" });
	});

	it("treats a non-level first token as target (no level)", () => {
		expect(parseReviewArgs("src/foo.ts --comment")).toEqual({ level: undefined, rest: "src/foo.ts --comment" });
	});

	it("empty args → no level, empty rest", () => {
		expect(parseReviewArgs("")).toEqual({ level: undefined, rest: "" });
	});

	it("whitespace-only args → no level, empty rest", () => {
		expect(parseReviewArgs("   ")).toEqual({ level: undefined, rest: "" });
	});
});

describe("resolveEffort", () => {
	it("explicit wins over last-used", () => {
		expect(resolveEffort("high", "low")).toEqual({ level: "high", source: "explicit" });
	});

	it("falls back to last-used when no explicit level", () => {
		expect(resolveEffort(undefined, "max")).toEqual({ level: "max", source: "last-used" });
	});

	it("falls back to default low when neither explicit nor last-used", () => {
		expect(resolveEffort(undefined, undefined)).toEqual({ level: "low", source: "default" });
	});
});

describe("detectVerifyCommand", () => {
	it("prefers `check` over test/lint/typecheck", () => {
		expect(detectVerifyCommand({ check: "tsc", test: "vitest", lint: "eslint" })).toBe("npm run check");
	});

	it("falls back to test when check is absent", () => {
		expect(detectVerifyCommand({ test: "vitest", lint: "eslint" })).toBe("npm run test");
	});

	it("falls back to lint, then typecheck", () => {
		expect(detectVerifyCommand({ lint: "eslint" })).toBe("npm run lint");
		expect(detectVerifyCommand({ typecheck: "tsc --noEmit" })).toBe("npm run typecheck");
	});

	it("returns null when no recognized script exists", () => {
		expect(detectVerifyCommand({ build: "tsc", dev: "vite" })).toBeNull();
	});

	it("returns null for null/empty scripts", () => {
		expect(detectVerifyCommand(null)).toBeNull();
		expect(detectVerifyCommand({})).toBeNull();
	});

	it("ignores a script whose value is empty/whitespace", () => {
		expect(detectVerifyCommand({ check: "   ", test: "" })).toBeNull();
	});
});

describe("buildSimplifyTasks", () => {
	it("builds one task per angle (4), each carrying the context package and the diff", () => {
		const pkg = "Repo root: /repo\nDiff scope: worktree";
		const tasks = buildSimplifyTasks("+new code\n-old code", pkg);
		expect(tasks).toHaveLength(4);
		expect(tasks.map((t) => t.angle.displayName)).toEqual(["Reuse", "Simplification", "Efficiency", "Altitude"]);
		for (const t of tasks) {
			expect(t.task).toContain(t.angle.headline);
			expect(t.task).toContain("+new code");
			expect(t.task).toContain(pkg);
			// The package is a header: repo orientation comes before the angle prompt.
			expect(t.task.indexOf("Repo root:")).toBeLessThan(t.task.indexOf(t.angle.headline));
			expect(t.systemPrompt).toBe(t.angle.definition);
		}
	});

	it("asks for findings only, not fixes", () => {
		const [first] = buildSimplifyTasks("diff", "pkg");
		expect(first?.task).toContain("report only");
		expect(first?.task).toContain("file:line");
	});
});

describe("buildContextPackage", () => {
	const DIFF = [
		"diff --git a/src/foo.ts b/src/foo.ts",
		"index 111..222 100644",
		"--- a/src/foo.ts",
		"+++ b/src/foo.ts",
		"@@ -1,2 +1,4 @@",
		" context",
		"+new line",
		"+another new line",
		"-gone line",
		"diff --git a/assets/logo.png b/assets/logo.png",
		"Binary files a/assets/logo.png and b/assets/logo.png differ",
	].join("\n");

	it("lists repo root, scope label, and per-file add/remove counts parsed from the diff", () => {
		const pkg = buildContextPackage(DIFF, "/repo", "uncommitted changes (HEAD → working tree)");
		expect(pkg).toContain("Repo root: /repo");
		expect(pkg).toContain("Diff scope: uncommitted changes (HEAD → working tree)");
		expect(pkg).toContain("src/foo.ts +2 -1");
		expect(pkg).toContain("assets/logo.png (binary)");
	});

	it("omits the file section when the diff has no parseable files", () => {
		const pkg = buildContextPackage("not a diff", "/repo", "label");
		expect(pkg).toBe("Repo root: /repo\nDiff scope: label");
	});

	it("counts added/removed lines whose CONTENT starts with +/- (not misread as headers)", () => {
		const pkg = buildContextPackage(
			[
				"diff --git a/x.md b/x.md",
				"--- a/x.md",
				"+++ b/x.md",
				"@@ -1 +1 @@",
				"-old",
				"+++new", // added line whose content is "++new"
				"---gone", // removed line whose content is "--gone"
			].join("\n"),
			"/repo",
			"label",
		);
		expect(pkg).toContain("x.md +1 -2");
	});

	it("recognizes git-quoted path headers (core.quotepath: non-ASCII filenames)", () => {
		const pkg = buildContextPackage(
			[
				"diff --git \"a/\\346\\226\\207\" \"b/\\346\\226\\207\"",
				"index 111..222 100644",
				"--- \"a/\\346\\226\\207\"",
				"+++ \"b/\\346\\226\\207\"",
				"@@ -1 +1 @@",
				"+内容",
			].join("\n"),
			"/repo",
			"label",
		);
		expect(pkg).toContain("+1");
	});

	it("caps the file list and reports the remainder", () => {
		const files = Array.from(
			{ length: CONTEXT_PACKAGE_MAX_FILES + 50 },
			(_, i) => `diff --git a/f${i}.ts b/f${i}.ts`,
		).join("\n");
		const pkg = buildContextPackage(files, "/repo", "label");
		const listed = pkg.split("\n").filter((l) => l.startsWith("  f"));
		expect(listed).toHaveLength(CONTEXT_PACKAGE_MAX_FILES);
		expect(pkg).toContain(`… and 50 more (see the diff below)`);
	});
});

describe("formatFanoutResults", () => {
	const ok = (angle: string, text: string): FanoutResult => ({
		angle,
		text,
		failed: false,
		aborted: false,
		exitCode: 0,
	});

	it("renders one ### section per angle in input order", () => {
		const md = formatFanoutResults([ok("Reuse", "r"), ok("Altitude", "a")]);
		expect(md).toBe("### Reuse\nr\n\n### Altitude\na");
	});

	it("an empty agent text reads as (no findings), not silence", () => {
		expect(formatFanoutResults([ok("Reuse", "")])).toBe("### Reuse\n(no findings)");
	});

	it("an aborted agent keeps partial findings and is explicitly marked", () => {
		const md = formatFanoutResults([
			{ angle: "Efficiency", text: "partial", failed: true, aborted: true, exitCode: 1 },
		]);
		expect(md).toBe("### Efficiency\n[agent aborted — partial findings]\npartial");
	});

	it("an aborted agent with no text is marked as aborted — no findings", () => {
		const md = formatFanoutResults([
			{ angle: "Efficiency", text: "", failed: true, aborted: true, exitCode: 1 },
		]);
		expect(md).toBe("### Efficiency\n[agent aborted — no findings]");
	});

	it("a hard failure surfaces the error message instead of masquerading as clean", () => {
		const md = formatFanoutResults([
			{ angle: "Simplification", text: "", failed: true, aborted: false, exitCode: 127, errorMessage: "spawn pi ENOENT" },
		]);
		expect(md).toBe("### Simplification\n[agent failed: spawn pi ENOENT — no findings]");
	});
});

describe("buildParallelTrigger / buildSinglePassTrigger (CC-parity opening)", () => {
	const base = {
		target: "(whole diff)",
		scopeLabel: "uncommitted changes (HEAD → working tree)",
		gitCommand: 'git -C "/repo" diff --no-color HEAD',
		contextPackage: "Repo root: /repo\nDiff scope: worktree\nChanged files (added/removed lines):\n  src/foo.ts +2 -1",
		skill: "/pkg/skills/simplify/SKILL.md",
		verify: "Verification command: `npm run check`.",
	};

	it("PARALLEL: Phase 0 comes first — exact git command before any launch instruction", () => {
		const msg = buildParallelTrigger({ ...base, pct: "8%", toolInvocation: "the `simplify_fanout` tool (no arguments)" });
		const phase0 = msg.indexOf("## Phase 0");
		const git = msg.indexOf(base.gitCommand);
		const launch = msg.indexOf("## Phase 1");
		expect(phase0).toBeGreaterThanOrEqual(0);
		expect(git).toBeGreaterThan(phase0);
		expect(launch).toBeGreaterThan(git);
		expect(msg).toContain("2–4 line change-intent summary");
	});

	it("PARALLEL: dispatch goes through the simplify_fanout tool, which owns the packaging", () => {
		const msg = buildParallelTrigger({ ...base, pct: "8%", toolInvocation: 'the `simplify_fanout` tool with `target: "src/foo.ts"`' });
		expect(msg).toContain("simplify_fanout");
		expect(msg).toContain('target: "src/foo.ts"');
		expect(msg).toContain("Do NOT write the agent prompts yourself or inline the diff");
		expect(msg).toContain("fanned_out: true");
		// The old handler-dispatched wording must be gone.
		expect(msg).not.toContain("already ran the 4-agent cleanup fan-out");
	});

	it("SINGLE-PASS: same visible opening — exact git command + summary, no tool dispatch", () => {
		const msg = buildSinglePassTrigger({ ...base, reasons: ["context usage unknown"], tooLarge: false });
		expect(msg).toContain("SINGLE-PASS mode (context usage unknown)");
		expect(msg.indexOf(base.gitCommand)).toBeGreaterThan(msg.indexOf("## Phase 0"));
		expect(msg).toContain("2–4 line change-intent summary");
		expect(msg).not.toContain("simplify_fanout");
		expect(msg).toContain("do not fake fan-out");
	});

	it("SINGLE-PASS: too-large diff switches to file-by-file guidance", () => {
		const msg = buildSinglePassTrigger({ ...base, reasons: ["diff too large (500 KB ≥ fan-out threshold)"], tooLarge: true });
		expect(msg).toContain("file-by-file");
	});
});

describe("lastAssistantText", () => {
	const fakeResult = (messages: unknown[]): AgentSpawnResult =>
		({
			callId: "c",
			exitCode: 0,
			messages,
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
			aborted: false,
			maxTurnsReached: false,
		}) as unknown as AgentSpawnResult;

	it("returns the trailing run of assistant text, skipping interim progress chatter", () => {
		const r = fakeResult([
			{ role: "assistant", content: "Let me check the shared modules first." },
			{ role: "user", content: "tool result" },
			{ role: "assistant", content: "### Findings\nsrc/foo.ts:12 — duplicates helper" },
		]);
		expect(lastAssistantText(r.messages)).toBe(
			"### Findings\nsrc/foo.ts:12 — duplicates helper",
		);
	});

	it("joins text blocks inside one message; consecutive assistant texts both survive", () => {
		const r = fakeResult([
			{ role: "assistant", content: [{ type: "text", text: "progress" }] },
			{ role: "assistant", content: [{ type: "text", text: "part 1" }, { type: "text", text: "part 2" }] },
		]);
		expect(lastAssistantText(r.messages)).toBe("progress\npart 1\npart 2");
	});

	it("an empty/whitespace final assistant message joins as empty, keeping the earlier text", () => {
		const r = fakeResult([
			{ role: "assistant", content: "the report" },
			{ role: "assistant", content: "   " },
		]);
		expect(lastAssistantText(r.messages)).toBe("the report");
	});

	it("a toolCall-only final turn yields empty — earlier chatter is NOT resurrected", () => {
		const r = fakeResult([
			{ role: "assistant", content: "Let me check the shared modules first." },
			{ role: "toolResult", content: "ok" },
			{ role: "assistant", content: [{ type: "toolCall", name: "bash" }] },
		]);
		expect(lastAssistantText(r.messages)).toBe("");
	});

	it("returns empty string when the trailing assistant run carries no text", () => {
		const r = fakeResult([{ role: "user", content: "hi" }, { role: "assistant", content: [] }]);
		expect(lastAssistantText(r.messages)).toBe("");
	});
});

describe("getRepoDiff + resolveDiffScope (widened scope, submodule support)", () => {
	// Real layout, so findGitRoot/existsSync behave: parent repo + a submodule
	// (repo/.git, repo/sub/.git) with a tracked file inside the submodule.
	let base: string;
	let repo: string;
	let sub: string;

	beforeEach(() => {
		base = mkdtempSync(join(tmpdir(), "pi-sa-git-"));
		repo = join(base, "repo");
		sub = join(repo, "sub");
		mkdirSync(join(repo, ".git"), { recursive: true });
		mkdirSync(join(sub, ".git"), { recursive: true });
		mkdirSync(join(sub, "pi-review"), { recursive: true });
		writeFileSync(join(sub, "pi-review", "x.ts"), "x");
		mkdirSync(join(repo, "src"), { recursive: true });
		writeFileSync(join(repo, "src", "foo.ts"), "foo");
	});

	afterEach(() => {
		rmSync(base, { recursive: true, force: true });
	});

	/** Fake GitRunner keyed by exact argv ("diff --no-color HEAD"): a string is
	 *  returned verbatim, an Error is thrown, an undefined key throws "unexpected". */
	const strictRunner =
		(table: Record<string, string | Error>) =>
		async (args: string[], opts: { cwd: string }): Promise<string> => {
			const key = args.join(" ");
			const v = table[key];
			if (v === undefined) throw new Error(`unexpected git call: git ${key} (cwd ${opts.cwd})`);
			if (v instanceof Error) throw v;
			return v;
		};

	it("prefers the upstream merge-base diff (unpushed + uncommitted) at the nearest git root of cwd", async () => {
		const run = strictRunner({
			"merge-base @{upstream} HEAD": "abc123\n",
			"diff --no-color abc123": "  diff line 1\ndiff line 2  ",
		});
		const r = await getRepoDiff(join(sub, "pi-review"), undefined, run);
		expect(r).toMatchObject({
			kind: "ok",
			diff: "diff line 1\ndiff line 2",
			gitRoot: sub,
			scopeKind: "upstream",
		});
		if (r.kind === "ok") expect(r.gitCommand).toBe(`git -C ${JSON.stringify(sub)} diff --no-color abc123`);
	});

	it("falls back to `git diff HEAD` (staged + unstaged) when no upstream is configured", async () => {
		const run = strictRunner({
			"merge-base @{upstream} HEAD": new Error("no upstream configured"),
			"diff --no-color HEAD": "diff body",
		});
		const r = await getRepoDiff(repo, undefined, run);
		expect(r).toMatchObject({ kind: "ok", diff: "diff body", gitRoot: repo, scopeKind: "worktree" });
	});

	it("limits every diff candidate to the target's relative path inside its git root", async () => {
		const run = strictRunner({
			"merge-base @{upstream} HEAD": new Error("no upstream configured"),
			"diff --no-color HEAD -- src/foo.ts": "diff",
		});
		const r = await getRepoDiff(repo, "src/foo.ts", run);
		expect(r).toMatchObject({ kind: "ok", diff: "diff", scopeKind: "worktree" });
		if (r.kind === "ok") expect(r.gitCommand).toBe(`git -C ${JSON.stringify(repo)} diff --no-color HEAD -- src/foo.ts`);
	});

	it("fresh repo (HEAD unresolvable): staged index wins over the worktree diff", async () => {
		const run = strictRunner({
			"merge-base @{upstream} HEAD": new Error("no upstream"),
			"diff --no-color HEAD": new Error("ambiguous argument 'HEAD'"),
			"diff --no-color --staged": "staged diff",
		});
		const r = await getRepoDiff(repo, undefined, run);
		expect(r).toMatchObject({ kind: "ok", diff: "staged diff", scopeKind: "staged-fresh" });
	});

	it("fresh repo with an empty index: unstaged worktree diff is the last resort", async () => {
		const run = strictRunner({
			"merge-base @{upstream} HEAD": new Error("no upstream"),
			"diff --no-color HEAD": new Error("ambiguous argument 'HEAD'"),
			"diff --no-color --staged": "",
			"diff --no-color": "unstaged diff",
		});
		const r = await getRepoDiff(repo, undefined, run);
		expect(r).toMatchObject({ kind: "ok", diff: "unstaged diff", scopeKind: "unstaged-fresh" });
	});

	it("returns empty when every candidate yields an empty diff", async () => {
		const run = strictRunner({
			"merge-base @{upstream} HEAD": new Error("no upstream"),
			"diff --no-color HEAD": "",
			"diff --no-color --staged": "",
			"diff --no-color": "",
		});
		expect(await getRepoDiff(repo, undefined, run)).toEqual({ kind: "empty" });
	});

	it("fresh repo, zero commits AND zero changes → empty, NOT git-error (HEAD failure is expected)", async () => {
		// Real git on a repo with no commits: `git diff HEAD` exits 128. The
		// HEAD failure is the legitimate fresh-repo fallback signal — the
		// later staged/unstaged candidates return empty, so the result must
		// be `empty`, not a bogus `git-error`.
		const run = strictRunner({
			"merge-base @{upstream} HEAD": new Error("no upstream"),
			"diff --no-color HEAD": new Error("fatal: ambiguous argument 'HEAD'"),
			"diff --no-color --staged": "",
			"diff --no-color": "",
		});
		expect(await getRepoDiff(repo, undefined, run)).toEqual({ kind: "empty" });
	});

	it("a broken repo still surfaces git-error (HEAD + staged + unstaged all fail)", async () => {
		const run = strictRunner({
			"merge-base @{upstream} HEAD": new Error("no upstream"),
			"diff --no-color HEAD": new Error("bad object HEAD"),
			"diff --no-color --staged": new Error("index corrupt"),
			"diff --no-color": new Error("index corrupt"),
		});
		const r = await getRepoDiff(repo, undefined, run);
		expect(r).toEqual({ kind: "git-error", message: "index corrupt" });
	});

	it("returns git-error with the real message when every candidate fails (broken repo / maxBuffer)", async () => {
		const run = strictRunner({
			"merge-base @{upstream} HEAD": new Error("no upstream"),
			"diff --no-color HEAD": new Error("spawn failed"),
			"diff --no-color --staged": new Error("spawn failed"),
			"diff --no-color": new Error("maxBuffer length exceeded"),
		});
		const r = await getRepoDiff(repo, undefined, run);
		expect(r).toEqual({ kind: "git-error", message: "maxBuffer length exceeded" });
	});

	it("returns no-repo when no git root exists anywhere", async () => {
		expect(await getRepoDiff(base, undefined, strictRunner({}))).toEqual({ kind: "no-repo" });
	});

	it("a submodule-internal target (with @ prefix) resolves to the submodule's git root", () => {
		expect(resolveDiffScope(repo, "@sub/pi-review/")).toEqual({
			gitRoot: sub,
			relPath: "pi-review",
		});
	});

	it("a target at the git root itself yields a full diff (relPath null)", () => {
		expect(resolveDiffScope(repo, "@sub")).toEqual({ gitRoot: sub, relPath: null });
	});

	it("a real directory that itself starts with @ (scoped pkg) wins over the @-prefix convention", () => {
		mkdirSync(join(repo, "@scoped"), { recursive: true });
		writeFileSync(join(repo, "@scoped", "y.ts"), "y");
		expect(resolveDiffScope(repo, "@scoped")).toEqual({ gitRoot: repo, relPath: "@scoped" });
		expect(resolveDiffScope(repo, "@scoped/y.ts")).toEqual({ gitRoot: repo, relPath: "@scoped/y.ts" });
	});

	it("a non-path target (branch) keeps the whole-diff scope of cwd", () => {
		expect(resolveDiffScope(repo, "feat/foo")).toEqual({ gitRoot: repo, relPath: null });
	});

	it("no git root anywhere → null", () => {
		expect(resolveDiffScope(base, undefined)).toBeNull();
		expect(resolveDiffScope(base, "src/x.ts")).toBeNull();
	});
});
