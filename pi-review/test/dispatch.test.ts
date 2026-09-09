/**
 * dispatch.test.ts — the declarative orchestration layer: strategy guard
 * evaluation (v1 decideSimplifyMode semantics, thresholds from template
 * data), effort parsing/sticky resolution, and prompt-template asset
 * assertions (frontmatter guards, phase structure, agent references).
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { parseGuards, selectVariant } from "../src/strategy.ts";
import { parseReviewArgs, render, resolveEffort } from "../src/dispatch.ts";

const PKG_ROOT = fileURLToPath(new URL("..", import.meta.url));
const template = (rel: string) =>
	parseFrontmatter<Record<string, unknown>>(readFileSync(join(PKG_ROOT, "prompts", rel), "utf8"));

/** The guards the shipped parallel template declares (strategy as data). */
const GUARDS = parseGuards(template("simplify.parallel.md").frontmatter);

describe("selectVariant (v1 decideSimplifyMode semantics, thresholds from template data)", () => {
	const window = 100_000;

	it("the shipped template declares the v1 thresholds (0.8 context, 400k diff chars)", () => {
		expect(GUARDS).toEqual({ contextBelow: 0.8, diffCharsBelow: 400_000 });
	});

	it("parallel when context is not near-full and the diff is small", () => {
		const d = selectVariant(GUARDS, { tokens: 50_000, contextWindow: window, diffChars: 1_000, fanoutAvailable: true });
		expect(d.variant).toBe("parallel");
		expect(d.reasons).toEqual([]);
	});

	it("single-pass when context is at/above the threshold (>=80%)", () => {
		const d = selectVariant(GUARDS, { tokens: 85_000, contextWindow: window, diffChars: 1_000, fanoutAvailable: true });
		expect(d.variant).toBe("single-pass");
		expect(d.reasons.join(" ")).toContain("85% full");
	});

	it("at exactly 80% → single-pass (boundary is >=)", () => {
		const d = selectVariant(GUARDS, { tokens: 80_000, contextWindow: window, diffChars: 1_000, fanoutAvailable: true });
		expect(d.variant).toBe("single-pass");
	});

	it("just below the threshold → parallel", () => {
		const d = selectVariant(GUARDS, { tokens: 79_000, contextWindow: window, diffChars: 1_000, fanoutAvailable: true });
		expect(d.variant).toBe("parallel");
	});

	it("single-pass (conservative) when token count is unknown", () => {
		const d = selectVariant(GUARDS, { tokens: null, contextWindow: window, diffChars: 1_000, fanoutAvailable: true });
		expect(d.variant).toBe("single-pass");
		expect(d.reasons.join(" ")).toContain("unknown");
	});

	it("single-pass when the diff reaches the declared ceiling, even with full headroom", () => {
		const d = selectVariant(GUARDS, { tokens: 10_000, contextWindow: window, diffChars: 400_000, fanoutAvailable: true });
		expect(d.variant).toBe("single-pass");
		expect(d.reasons.join(" ")).toContain("diff too large");
	});

	it("just below the diff ceiling → parallel", () => {
		const d = selectVariant(GUARDS, { tokens: 10_000, contextWindow: window, diffChars: 399_999, fanoutAvailable: true });
		expect(d.variant).toBe("parallel");
	});

	it("accumulates multiple reasons (unknown context + huge diff)", () => {
		const d = selectVariant(GUARDS, { tokens: null, contextWindow: 0, diffChars: 400_000, fanoutAvailable: true });
		expect(d.variant).toBe("single-pass");
		expect(d.reasons).toHaveLength(2);
	});

	it("single-pass when fan-out is unavailable, even with full headroom and a tiny diff", () => {
		const d = selectVariant(GUARDS, { tokens: 10_000, contextWindow: window, diffChars: 1_000, fanoutAvailable: false });
		expect(d.variant).toBe("single-pass");
		expect(d.reasons.join(" ")).toContain("fan-out unavailable");
	});

	it("a template without guards still falls back on the safety invariants", () => {
		const d = selectVariant({}, { tokens: null, contextWindow: 0, diffChars: 10, fanoutAvailable: true });
		expect(d.variant).toBe("single-pass");
	});
});

describe("parseGuards", () => {
	it("drops unknown/garbage fields silently", () => {
		expect(parseGuards({ "parallel-when": { "context-below": "high", nonsense: 1 } })).toEqual({});
	});

	it("accepts only a (0,1] context fraction and a positive char ceiling", () => {
		expect(parseGuards({ "parallel-when": { "context-below": 1.5, "diff-chars-below": -3 } })).toEqual({});
		expect(parseGuards({ "parallel-when": { "context-below": 0.9, "diff-chars-below": 1000 } })).toEqual({
			contextBelow: 0.9,
			diffCharsBelow: 1000,
		});
	});
});

describe("parseReviewArgs", () => {
	it("extracts a leading level and returns the rest verbatim", () => {
		expect(parseReviewArgs("medium --fix 123")).toEqual({ level: "medium", rest: "--fix 123" });
		expect(parseReviewArgs("  HIGH x")).toEqual({ level: "high", rest: "x" });
	});

	it("no leading level → whole string is the target/flags", () => {
		expect(parseReviewArgs("feat/branch --fix")).toEqual({ level: undefined, rest: "feat/branch --fix" });
	});

	it("empty args", () => {
		expect(parseReviewArgs("")).toEqual({ level: undefined, rest: "" });
	});
});

describe("resolveEffort", () => {
	it("explicit wins, then last-used, then default low", () => {
		expect(resolveEffort("xhigh", "low")).toEqual({ level: "xhigh", source: "explicit" });
		expect(resolveEffort(undefined, "high")).toEqual({ level: "high", source: "last-used" });
		expect(resolveEffort(undefined, undefined)).toEqual({ level: "low", source: "default" });
	});
});

describe("prompt template assets", () => {
	it("the three templates exist and declare their vars", () => {
		for (const rel of ["review.md", "simplify.parallel.md", "simplify.single.md"]) {
			const { frontmatter } = template(rel);
			expect(typeof frontmatter.description).toBe("string");
			expect(Array.isArray(frontmatter.vars)).toBe(true);
		}
	});

	it("the parallel template carries the CC-parity phase structure", () => {
		const body = template("simplify.parallel.md").body;
		expect(body).toContain("Phase 0 — read the diff");
		expect(body).toContain("Phase 1 — launch the 4 cleanup agents");
		expect(body).toContain("Phase 2");
		expect(body).toContain("{{git-command}}");
		expect(body).toContain("change-intent summary");
		// Turn budgets are config-injected placeholders (src/config.ts), not literals.
		expect(body).toContain("maxTurns: {{simplify-max-turns}}");
		expect(body).not.toContain("maxTurns: 15");
		expect(body).toContain("fanned_out: true");
	});

	it("the single-pass template forbids faking the fan-out", () => {
		const body = template("simplify.single.md").body;
		expect(body).toContain("SINGLE-PASS mode ({{reasons}})");
		expect(body).toContain("do not fake fan-out");
		expect(body).toContain("{{git-command}}");
	});

	it("both simplify variants and the review trigger carry the verify guidance", () => {
		expect(template("simplify.parallel.md").body).toContain("{{verify}}");
		expect(template("simplify.single.md").body).toContain("{{verify}}");
		expect(template("review.md").body).toContain("{{verify}}");
	});
});

	describe("turn-budget injection", () => {
		const reviewVars = (finder: string, verifier: string, gapHunt: string) => ({
			effort: "low",
			"effort-source": "default",
			"extra-args": "",
			skill: "/skills/review/SKILL.md",
			"finder-max-turns": finder,
			"verifier-max-turns": verifier,
			"gap-hunt-max-turns": gapHunt,
			verify: "",
		});

		it("defaults render the pre-config literals byte-for-byte", () => {
			const out = render(template("review.md").body, reviewVars("20", "15", "15"));
			expect(out).toContain("with `maxTurns: 20` per finder batch");
			expect(out).toContain("`maxTurns: 15` per verifier");
			expect(out).toContain("`maxTurns: 15`\nfor the gap-hunt as the skill instructs");
		});

		it("configured budgets replace the defaults in the rendered message", () => {
			const out = render(template("review.md").body, reviewVars("30", "25", "50"));
			expect(out).toContain("with `maxTurns: 30` per finder batch");
			expect(out).toContain("`maxTurns: 25` per verifier");
			expect(out).toContain("`maxTurns: 50`\nfor the gap-hunt as the skill instructs");
			expect(out).not.toContain("{{finder-max-turns}}");
			expect(out).not.toContain("{{verifier-max-turns}}");
			expect(out).not.toContain("{{gap-hunt-max-turns}}");
		});

		it("renders the simplify cleaner budget from the var", () => {
			const out = render(template("simplify.parallel.md").body, {
				target: "src/",
				"scope-label": "unpushed+uncommitted",
				pct: "3%",
				"git-command": "git diff",
				"context-package": "(diff)",
				skill: "/skills/simplify/SKILL.md",
				verify: "",
				"simplify-max-turns": "15",
			});
			expect(out).toContain("Set `maxTurns: 15` on the call");
			expect(out).not.toContain("{{simplify-max-turns}}");
		});
	});

	describe("bundled agents directory", () => {
	it("ships the full review agent set", () => {
		const names = readdirSync(join(PKG_ROOT, "agents"))
			.filter((f) => f.endsWith(".md"))
			.sort();
		expect(names).toEqual([
			"cleaner-altitude.md",
			"cleaner-efficiency.md",
			"cleaner-reuse.md",
			"cleaner-simplification.md",
			"finder-conventions.md",
			"finder-cross-file.md",
			"finder-diff-scan.md",
			"finder-language-pitfall.md",
			"finder-removed-behavior.md",
			"finder-wrapper-proxy.md",
			"gap-hunter.md",
			"verifier.md",
		]);
	});
});
