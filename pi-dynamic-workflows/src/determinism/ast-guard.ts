/**
 * Determinism AST guard — the load-time counterpart of CC.s vm-sandbox determinism ban.
 *
 * Workflow `.ts` files are loaded via jiti (a real module, not a vm-sandboxed
 * script string), so we cannot sandbox at eval time the way CC does. Instead
 * we parse the source BEFORE jiti loads it and reject any reference to the
 * non-deterministic APIs: `Date.now`, `Math.random`, `new Date()`, `Date()`, and
 * the Web Crypto randomness surface (`crypto.randomUUID`/`randomBytes`/
 * `getRandomValues`), `performance.now`, and `process.hrtime`. Reading "now" or
 * randomness inside a workflow body would make its output — and therefore the
 * resume cache key derived from it — unstable across runs.
 *
 * Uses the typescript compiler's `createSourceFile` (pure parse, no type-check
 * program) — the only reliable way to walk TypeScript syntax without a custom
 * parser. Same patterns CC.s vm-sandbox flags (Date.now/Math.random), plus the `Date()`
 * no-arg call (merged in from the alternative loader.ts implementation during
 * Task 5 unification — that version caught this case, the original did not).
 */
import {
	type CallExpression,
	type ElementAccessExpression,
	type Identifier,
	type NewExpression,
	type Node,
	type NoSubstitutionTemplateLiteral,
	type ParenthesizedExpression,
	type PropertyAccessExpression,
	type StringLiteral,
	ScriptTarget,
	SyntaxKind,
	createSourceFile,
} from "typescript";
import { WorkflowError } from "../errors.ts";

export type DeterminismViolationKind =
	| "date_now"
	| "math_random"
	| "new_date"
	| "date_call"
	| "crypto_random"
	| "performance_now"
	| "process_hrtime";

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
	crypto_random:
		"crypto.randomUUID/randomBytes/getRandomValues is non-deterministic — use a seeded RNG or pass randomness in",
	performance_now: "performance.now() is non-deterministic — use the run's deterministic inception time",
	process_hrtime: "process.hrtime() is non-deterministic — use the run's deterministic inception time",
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
 * single-file, or guard imported helpers separately. Both dot and bracket
 * access (`Date.now()` / `Date["now"]()`) are caught; destructuring aliases
 * (`const {now} = Date; now()`) and `globalThis.Math.random()` still bypass.
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

export class DeterminismError extends WorkflowError {
	constructor(message: string) {
		super(message, { category: "determinism" });
		this.name = "DeterminismError";
	}
}

function classify(node: Node): DeterminismViolationKind | null {
	// Unwrap `(...)` so `(Date).now()` and `(crypto)['randomUUID']` cannot bypass
	// the identifier checks below.
	function unwrap(n: Node): Node {
		let cur = n;
		while (cur.kind === SyntaxKind.ParenthesizedExpression) cur = (cur as ParenthesizedExpression).expression;
		return cur;
	}

	// Date.now / Math.random / crypto.* / performance.now / process.hrtime — a
	// property access off the global identifier (covers `crypto.randomUUID()`,
	// `performance.now()`, and `process.hrtime.bigint()` via its `process.hrtime`
	// base access).
	if (node.kind === SyntaxKind.PropertyAccessExpression) {
		const pae = node as PropertyAccessExpression;
		const base = unwrap(pae.expression);
		if (base.kind === SyntaxKind.Identifier) {
			return matchGlobal((base as Identifier).text, pae.name.text);
		}
		return null;
	}
	// Bracket access off a known non-deterministic global: Date["now"],
	// crypto["randomUUID"], performance["now"], process["hrtime"]. Closes the
	// bracket-aliasing bypass (review m3) and the template-literal subscript
	// bypass Date[`now`] (a NoSubstitutionTemplateLiteral, not a StringLiteral).
	// Destructuring aliases (`const {now} = Date; now()`) and local shadowing
	// (`const Date = {now: () => 42}`) still bypass / false-positive: the former
	// needs cross-scope alias tracking, the latter scope analysis — both out of
	// scope for this guard, which targets direct global-API use.
	if (node.kind === SyntaxKind.ElementAccessExpression) {
		const eae = node as ElementAccessExpression;
		const base = unwrap(eae.expression);
		const arg = eae.argumentExpression;
		if (base.kind === SyntaxKind.Identifier) {
			const obj = (base as Identifier).text;
			if (arg?.kind === SyntaxKind.StringLiteral) {
				return matchGlobal(obj, (arg as StringLiteral).text);
			}
			if (arg?.kind === SyntaxKind.NoSubstitutionTemplateLiteral) {
				return matchGlobal(obj, (arg as NoSubstitutionTemplateLiteral).text);
			}
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

/** Map a (globalObject, property) pair from a property/element access to a
 *  violation kind, or null if neither side is a known non-deterministic API. */
function matchGlobal(obj: string, prop: string): DeterminismViolationKind | null {
	if (obj === "Date" && prop === "now") return "date_now";
	if (obj === "Math" && prop === "random") return "math_random";
	if (obj === "crypto" && (prop === "randomUUID" || prop === "randomBytes" || prop === "getRandomValues")) return "crypto_random";
	if (obj === "performance" && prop === "now") return "performance_now";
	if (obj === "process" && prop === "hrtime") return "process_hrtime";
	return null;
}

function walk(node: Node, visit: (n: Node) => void): void {
	visit(node);
	node.forEachChild((child) => walk(child, visit));
}
