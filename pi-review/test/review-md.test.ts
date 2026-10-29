/**
 * review-md.test.ts — REVIEW.md resolution: base-first fidelity
 * (CC cloud-review semantics: "REVIEW.md from the base or default branch and
 * never from the pull request's own changes"), worktree fallback, absence,
 * truncation, and the rendered trigger note.
 */
import { describe, expect, it } from "vitest";
import {
	buildReviewNote,
	clampReviewContent,
	readReviewInstructions,
	REVIEW_MD_MAX_CHARS,
	toInstructions,
	type ReviewInstructions,
} from "../src/review-md.ts";

/** Fake GitRunner keyed by exact argv (diff.test.ts strictRunner pattern). */
const strictRunner =
	(table: Record<string, string | Error>) =>
	async (args: string[]): Promise<string> => {
		const v = table[args.join(" ")];
		if (v === undefined) throw new Error(`unexpected git call: git ${args.join(" ")}`);
		if (v instanceof Error) throw v;
		return v;
	};

const NONE: ReviewInstructions = { found: false, source: "worktree", content: "" };

describe("clampReviewContent", () => {
	it("passes short content through untouched", () => {
		expect(clampReviewContent("rules")).toEqual({ content: "rules", truncated: false });
	});

	it("cuts at exactly the cap and stamps the truncation", () => {
		const out = clampReviewContent("x".repeat(REVIEW_MD_MAX_CHARS + 500));
		expect(out.truncated).toBe(true);
		expect(out.content.startsWith("x".repeat(REVIEW_MD_MAX_CHARS))).toBe(true);
		expect(out.content).toContain("truncated");
	});
});

describe("toInstructions", () => {
	it("whitespace-only content counts as absent (found: false, empty content)", () => {
		expect(toInstructions("  \n\t ", "base")).toMatchObject({ found: false, content: "" });
		expect(toInstructions(undefined, "base")).toMatchObject({ found: false, content: "" });
	});

	it("trims and tags the source", () => {
		const out = toInstructions("  # rules  ", "base");
		expect(out).toEqual({ found: true, source: "base", content: "# rules", truncated: false });
	});
});

describe("readReviewInstructions (base-first fidelity)", () => {
	it("prefers the upstream base version over a diverging worktree copy", async () => {
		const run = strictRunner({
			"rev-parse --show-toplevel": "/repo\n",
			"show @{upstream}:REVIEW.md": "# base rules",
		});
		const readFileCalls: string[] = [];
		const out = await readReviewInstructions("/repo", run, (p) => {
			readFileCalls.push(p);
			return Promise.resolve("# worktree rules — must not win");
		});
		expect(out).toEqual({ found: true, source: "base", content: "# base rules", truncated: false });
		expect(readFileCalls).toEqual([]); // never touched the worktree copy
	});

	it("falls back to main when no upstream exists, still beating the worktree", async () => {
		const run = strictRunner({
			"rev-parse --show-toplevel": "/repo\n",
			"show @{upstream}:REVIEW.md": new Error("no upstream configured"),
			"show main:REVIEW.md": "# main rules",
		});
		const out = await readReviewInstructions("/repo", run, () => Promise.resolve("# worktree rules"));
		expect(out).toMatchObject({ found: true, source: "base", content: "# main rules" });
	});

	it("uses the worktree copy only when no base revision resolves (and it exists)", async () => {
		const run = strictRunner({
			"rev-parse --show-toplevel": "/repo\n",
			"show @{upstream}:REVIEW.md": new Error("no upstream"),
			"show main:REVIEW.md": new Error("bad revision main"),
		});
		const out = await readReviewInstructions("/repo", run, () => Promise.resolve("# worktree rules"));
		expect(out).toMatchObject({ found: true, source: "worktree", content: "# worktree rules" });
	});

	it("absent everywhere → not found (the note stays empty)", async () => {
		const run = strictRunner({
			"rev-parse --show-toplevel": "/repo\n",
			"show @{upstream}:REVIEW.md": new Error("no upstream"),
			"show main:REVIEW.md": new Error("bad revision"),
		});
		const out = await readReviewInstructions("/repo", run, () => Promise.reject(new Error("ENOENT")));
		expect(out).toEqual(NONE);
	});

	it("a non-git cwd → not found, without any further git calls", async () => {
		const run = strictRunner({ "rev-parse --show-toplevel": new Error("not a git repository") });
		const out = await readReviewInstructions("/nowhere", run, () => Promise.reject(new Error("ENOENT")));
		expect(out).toEqual(NONE);
	});

	it("an empty base file counts as absent", async () => {
		const run = strictRunner({
			"rev-parse --show-toplevel": "/repo\n",
			"show @{upstream}:REVIEW.md": "  \n",
		});
		const out = await readReviewInstructions("/repo", run, () => Promise.reject(new Error("ENOENT")));
		expect(out).toEqual(NONE);
	});
});

describe("buildReviewNote", () => {
	it("empty when nothing was found", () => {
		expect(buildReviewNote(NONE)).toBe("");
	});

	it("renders base-resolved instructions with the carry-verbatim contract", () => {
		const out = buildReviewNote({ found: true, source: "base", content: "# rules", truncated: false });
		expect(out).toContain("REVIEW.md, resolved from the base revision — NOT the worktree copy");
		expect(out).toContain("<review-instructions>\n# rules\n</review-instructions>");
		expect(out).toContain("Phase 0.5 scope block");
		expect(out).toContain("never license actions");
		expect(out).not.toContain("truncated");
	});

	it("renders the worktree source honestly and stamps truncation", () => {
		const out = buildReviewNote({
			found: true,
			source: "worktree",
			content: "x".repeat(REVIEW_MD_MAX_CHARS + 1),
			truncated: true,
		});
		expect(out).toContain("read from the repo root (no base revision resolved)");
		expect(out).toContain("truncated");
	});
});
