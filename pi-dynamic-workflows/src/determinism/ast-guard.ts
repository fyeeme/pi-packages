/**
 * Determinism AST guard — the pi port of Claude Code's `DSo`.
 *
 * Workflow `.ts` files are loaded via jiti (a real module, not a vm-sandboxed
 * script string), so we cannot sandbox at eval time the way CC does. Instead
 * we parse the source BEFORE jiti loads it and reject any reference to the
 * four non-deterministic APIs: `Date.now`, `Math.random`, `new Date()`, and
 * `Date()` (no-arg call). Reading "now" or randomness inside a workflow body
 * would make its output — and therefore the resume cache key derived from it
 * — unstable across runs.
 *
 * Uses the typescript compiler's `createSourceFile` (pure parse, no type-check
 * program) — the only reliable way to walk TypeScript syntax without a custom
 * parser. Same patterns CC's `DSo` flags via acorn visitors, plus the `Date()`
 * no-arg call (merged in from the alternative loader.ts implementation during
 * Task 5 unification — that version caught this case, the original did not).
 */
import {
	type CallExpression,
	type Identifier,
	type NewExpression,
	type Node,
	type PropertyAccessExpression,
	ScriptTarget,
	SyntaxKind,
	createSourceFile,
} from "typescript";

export type DeterminismViolationKind = "date_now" | "math_random" | "new_date" | "date_call";

export interface DeterminismViolation {
	readonly kind: DeterminismViolationKind;
	readonly line: number;
	readonly column: number;
	readonly source: string;
}

export const BANNED_API_MESSAGE: Record<DeterminismViolationKind, string> = {
	date_now: "Date.now() is non-deterministic — pass a timestamp into the runtime instead",
	math_random: "Math.random() is non-deterministic — use a sequence counter or pass a seed in",
	new_date: "new Date() with no args is non-deterministic — pass a timestamp explicitly",
	date_call: "Date() with no args is non-deterministic — pass an explicit format or timestamp",
};

/**
 * Scan TypeScript source for non-deterministic API references.
 * Returns one entry per offending node, with 1-based line:column.
 */
export function findDeterminismViolations(source: string, filename = "<workflow>"): DeterminismViolation[] {
	const sf = createSourceFile(filename, source, ScriptTarget.Latest, /*setParentNodes*/ false);
	const violations: DeterminismViolation[] = [];
	walk(sf, (node) => {
		const kind = classify(node);
		if (kind !== null) {
			const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
			violations.push({ kind, line: line + 1, column: character + 1, source: node.getText(sf) });
		}
	});
	return violations;
}

/**
 * Assert source is deterministic; throw DeterminismError listing every
 * violation. Loader calls this immediately before jiti-imports a workflow.
 *
 * Scope limitation (P1-3): scans ONLY the entry source passed in. Static
 * imports (`import { now } from "./time-util.ts"`) whose helper calls
 * Date.now / Math.random are NOT transitively scanned — keep workflows
 * single-file, or guard imported helpers separately. Aliasing
 * (`const D = Date; D.now()`) and `globalThis.Math.random()` also bypass it.
 * This is a single-file lint, not a full determinism proof.
 */
export function assertDeterministic(source: string, filename?: string): void {
	const violations = findDeterminismViolations(source, filename);
	if (violations.length === 0) return;
	const label = filename ?? "<workflow>";
	const detail = violations
		.map((v) => `  ${label}:${v.line}:${v.column}  ${v.source}  — ${BANNED_API_MESSAGE[v.kind]}`)
		.join("\n");
	throw new DeterminismError(
		`Workflow source is non-deterministic (${violations.length} violation(s)):\n${detail}`,
	);
}

export class DeterminismError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DeterminismError";
	}
}

function classify(node: Node): DeterminismViolationKind | null {
	// Date.now() / Math.random() — a property access off the global identifier.
	if (node.kind === SyntaxKind.PropertyAccessExpression) {
		const pae = node as PropertyAccessExpression;
		if (pae.expression.kind === SyntaxKind.Identifier) {
			const obj = (pae.expression as Identifier).text;
			if (obj === "Date" && pae.name.text === "now") return "date_now";
			if (obj === "Math" && pae.name.text === "random") return "math_random";
		}
		return null;
	}
	// Date() — a no-arg call expression returns the current-time string.
	// Date.now() is a CallExpression too, but its callee is a PropertyAccess,
	// not a bare Identifier, so it falls through here without matching.
	if (node.kind === SyntaxKind.CallExpression) {
		const ce = node as CallExpression;
		if (
			ce.expression.kind === SyntaxKind.Identifier &&
			(ce.expression as Identifier).text === "Date" &&
			(ce.arguments === undefined || ce.arguments.length === 0)
		) {
			return "date_call";
		}
		return null;
	}
	// new Date() with zero arguments. new Date(ts) / new Date(y, m, d) are allowed.
	if (node.kind === SyntaxKind.NewExpression) {
		const ne = node as NewExpression;
		if (
			ne.expression.kind === SyntaxKind.Identifier &&
			(ne.expression as Identifier).text === "Date" &&
			(ne.arguments === undefined || ne.arguments.length === 0)
		) {
			return "new_date";
		}
	}
	return null;
}

function walk(node: Node, visit: (n: Node) => void): void {
	visit(node);
	node.forEachChild((child) => walk(child, visit));
}
