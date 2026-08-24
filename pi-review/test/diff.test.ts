/**
 * diff.test.ts — deterministic diff resolution (v1 commands.test.ts cases,
 * relocated with src/diff.ts; identical semantics).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildContextPackage,
	CONTEXT_PACKAGE_MAX_FILES,
	detectVerifyCommand,
	getRepoDiff,
	resolveDiffScope,
} from "../src/diff.ts";

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
