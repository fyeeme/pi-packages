import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SIMPLIFY_ANGLES } from "../src/commands/code-simplify.ts";

/**
 * The four cleanup angle bodies (Reuse / Simplification / Efficiency / Altitude)
 * are shared verbatim between code-review and simplify (CC ships them from the
 * same source variables). This snapshot test turns drift into a failing test so
 * the two SKILL.md files cannot silently diverge (harden-code-simplify, Decision
 * C3) without someone noticing.
 */
const SKILLS_DIR = join(__dirname, "..", "skills");
const REVIEW = readFileSync(join(SKILLS_DIR, "code-review", "SKILL.md"), "utf8");
const SIMPLIFY = readFileSync(join(SKILLS_DIR, "simplify", "SKILL.md"), "utf8");

const ANGLES = ["Reuse", "Simplification", "Efficiency", "Altitude"] as const;

/**
 * Extract the body paragraph immediately following each `### <Angle>` header,
 * up to the next heading. Returns one entry per occurrence (simplify's angles
 * appear in both its PARALLEL and SINGLE-PASS bodies, so there can be >1).
 */
function angleBodies(md: string, angle: string): string[] {
	const out: string[] = [];
	// `### Reuse` ... up to the next `### ` or `## ` or `# ` heading.
	const re = new RegExp(`### ${angle}\\s*\\n([\\s\\S]*?)(?=\\n#{1,3} |$)`, "g");
	let m: RegExpExecArray | null;
	while ((m = re.exec(md)) !== null) {
		out.push(m[1]!.trim());
	}
	return out;
}

describe("shared angle bodies stay in sync across code-review and simplify", () => {
	for (const angle of ANGLES) {
		it(`"${angle}" body is identical in both skills`, () => {
			const reviewBodies = angleBodies(REVIEW, angle);
			const simplifyBodies = angleBodies(SIMPLIFY, angle);
			// Sanity: each skill actually contains the angle.
			expect(reviewBodies.length, `code-review must define ### ${angle}`).toBeGreaterThan(0);
			expect(simplifyBodies.length, `simplify must define ### ${angle}`).toBeGreaterThan(0);
			// Every simplify occurrence must match code-review's canonical body.
			const canonical = reviewBodies[0]!;
			for (const body of simplifyBodies) {
				expect(body).toBe(canonical);
			}
			// And code-review itself must not internally disagree.
			for (const body of reviewBodies) {
				expect(body).toBe(canonical);
			}
		});
	}
});

describe("SIMPLIFY_ANGLES (TS) stay in sync with the skill bodies", () => {
	const normalize = (s: string): string => s.replace(/\s+/g, " ").trim();

	it("covers exactly the four angles in skill order", () => {
		expect(SIMPLIFY_ANGLES.map((a) => a.displayName)).toEqual([...ANGLES]);
	});

	it("each TS definition matches the canonical skill body verbatim (whitespace-normalized)", () => {
		for (const angle of SIMPLIFY_ANGLES) {
			const canonical = angleBodies(REVIEW, angle.displayName)[0]!;
			expect(
				normalize(angle.definition),
				`TS definition of ${angle.displayName} must match the skill body — update both or neither`,
			).toBe(normalize(canonical));
		}
	});
});
