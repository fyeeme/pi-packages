import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
