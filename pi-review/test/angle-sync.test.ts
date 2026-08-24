/**
 * angle-sync.test.ts — drift anchors for the asset layer (v2).
 *
 * v1 anchored the four cleanup angles as a TS constant (SIMPLIFY_ANGLES)
 * against the skill bodies. v2 materializes the angles as agent definition
 * files under agents/; the anchors become:
 *
 *   1. skill-to-skill: the angle bodies stay identical between the
 *      code-review and simplify skills (unchanged from v1);
 *   2. agents-to-skills: each cleaner-* agent's guidance matches the
 *      canonical skill body for its angle (whitespace-normalized);
 *   3. templates-to-agents: every agent name referenced by a prompt template
 *      exists in agents/, and every agents/ definition is referenced by at
 *      least one template (nothing ships dead).
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

const PKG_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKILLS_DIR = join(PKG_ROOT, "skills");
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
			expect(reviewBodies.length, `code-review must define ### ${angle}`).toBeGreaterThan(0);
			expect(simplifyBodies.length, `simplify must define ### ${angle}`).toBeGreaterThan(0);
			const canonical = reviewBodies[0]!;
			for (const body of simplifyBodies) expect(body).toBe(canonical);
			for (const body of reviewBodies) expect(body).toBe(canonical);
		});
	}
});

describe("cleaner agent definitions stay in sync with the canonical skill bodies", () => {
	const normalize = (s: string): string => s.replace(/\s+/g, " ").trim();
	const angleToAgent = {
		Reuse: "cleaner-reuse",
		Simplification: "cleaner-simplification",
		Efficiency: "cleaner-efficiency",
		Altitude: "cleaner-altitude",
	} as const;

	for (const angle of ANGLES) {
		it(`agent ${angleToAgent[angle]} carries the canonical "${angle}" guidance`, () => {
			const file = join(PKG_ROOT, "agents", `${angleToAgent[angle]}.md`);
			const { frontmatter, body } = parseFrontmatter<Record<string, string>>(readFileSync(file, "utf8"));
			// Agent is invocable by name and is read-only.
			expect(frontmatter.name).toBe(angleToAgent[angle]);
			expect(frontmatter.tools).not.toContain("write");
			// The skill body is the canonical angle text; the agent guidance is
			// its v1 task-side shape contract plus the definition — key phrases
			// from the canonical body must survive (case/whitespace-insensitive:
			// the agent legitimately reflows sentences).
			const flat = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();
			const canonical = flat(angleBodies(REVIEW, angle)[0]!);
			for (const sentence of canonical.split(". ")) {
				const core = sentence.trim();
				if (core.length < 20) continue; // skip fragments/connectives
				expect(flat(body), `${angleToAgent[angle]} must keep: "${core.slice(0, 60)}…"`).toContain(
					core.slice(0, 40),
				);
			}
			expect(flat(body)).toContain("report only");
		});
	}
});

describe("template agent references", () => {
	const agentsDir = join(PKG_ROOT, "agents");
	const agentNames = new Set(
		readdirSync(agentsDir)
			.filter((f) => f.endsWith(".md"))
			.map((f) => parseFrontmatter<Record<string, string>>(readFileSync(join(agentsDir, f), "utf8")).frontmatter.name),
	);

	/** Agent names referenced by a template body (the bundled set is listed
	 *  verbatim in review.md; simplify.parallel.md names the 4 cleaners). */
	const referenced = (rel: string): string[] => {
		const body = readFileSync(join(PKG_ROOT, "prompts", rel), "utf8");
		return [...agentNames].filter((name) => new RegExp(`\\b${name}\\b`).test(body));
	};

	it("every agent referenced by a template exists in agents/", () => {
		for (const rel of ["review.md", "simplify.parallel.md", "simplify.single.md"]) {
			for (const name of referenced(rel)) {
				expect(agentNames.has(name), `${rel} references "${name}" which has no definition`).toBe(true);
			}
		}
	});

	it("every agents/ definition is referenced by at least one template (nothing ships dead)", () => {
		const all = new Set<string>([
			...referenced("review.md"),
			...referenced("simplify.parallel.md"),
			...referenced("simplify.single.md"),
		]);
		for (const name of agentNames) {
			expect(all.has(name), `agent "${name}" is defined but referenced by no template`).toBe(true);
		}
	});

	it("the parallel template dispatches exactly the four cleaners", () => {
		const refs = referenced("simplify.parallel.md");
		expect(refs.sort()).toEqual(["cleaner-altitude", "cleaner-efficiency", "cleaner-reuse", "cleaner-simplification"]);
	});
});
