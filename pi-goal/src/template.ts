/**
 * pi-goal — minimal template renderer.
 *
 * Replaces oh-my-pi's `prompt.render` (from @oh-my-pi/pi-utils) for the goal
 * prompt templates, which use exactly three constructs:
 *
 *   {{variable}}                 interpolate (values arrive pre-stringified)
 *   {{#if var}}A{{else}}B{{/if}} conditional; `else` branch optional
 *   {{#each arr}}...{{/each}}    iteration; item fields shadow outer scope
 *
 * Unknown variables render as empty strings. This is a renderer, not an
 * escaper: callers escape XML-sensitive text with escapeXmlText before passing
 * values in, matching omp call sites.
 */

export type TemplateValue = string | number | boolean | undefined | null | TemplateValue[] | Record<string, unknown>;
export type TemplateScope = Record<string, TemplateValue>;

type Node =
	| { kind: "text"; text: string }
	| { kind: "var"; name: string }
	| { kind: "if"; name: string; whenTrue: Node[]; whenFalse: Node[] }
	| { kind: "each"; name: string; body: Node[] };

const TAG = /\{\{([^}]+)\}\}/;

/**
 * Parse from `start` until the closing tag named `stopName` ("if" / "each" /
 * null for top level). When parsing an if-body, an `{{else}}` ends the
 * then-branch and is reported via `sawElse`; the caller parses the else branch.
 */
function parseUntil(
	template: string,
	start: number,
	stopName: "if" | "each" | null,
): { nodes: Node[]; end: number; sawElse: boolean } {
	const nodes: Node[] = [];
	let cursor = start;
	while (cursor < template.length) {
		const rest = template.slice(cursor);
		const match = TAG.exec(rest);
		if (!match || match.index === undefined) {
			if (stopName !== null) {
				throw new Error(`goal template: unclosed {{#${stopName}}}`);
			}
			nodes.push({ kind: "text", text: rest });
			return { nodes, end: template.length, sawElse: false };
		}
		const tagStart = cursor + match.index;
		if (tagStart > cursor) {
			nodes.push({ kind: "text", text: template.slice(cursor, tagStart) });
		}
		const raw = match[1].trim();
		const afterTag = tagStart + match[0].length;

		if (raw === "else") {
			if (stopName === "if") {
				return { nodes, end: afterTag, sawElse: true };
			}
			throw new Error("goal template: unexpected {{else}} outside {{#if}}");
		}
		if (raw.startsWith("/")) {
			const closing = raw.slice(1);
			if (stopName !== null && closing === stopName) {
				return { nodes, end: afterTag, sawElse: false };
			}
			throw new Error(`goal template: unexpected closing tag {{${raw}}}`);
		}
		if (raw.startsWith("#if ")) {
			const name = raw.slice(4).trim();
			const thenPart = parseUntil(template, afterTag, "if");
			let otherwise: Node[] = [];
			let end = thenPart.end;
			if (thenPart.sawElse) {
				const elsePart = parseUntil(template, thenPart.end, "if");
				otherwise = elsePart.nodes;
				end = elsePart.end;
			}
			nodes.push({ kind: "if", name, whenTrue: thenPart.nodes, whenFalse: otherwise });
			cursor = end;
			continue;
		}
		if (raw.startsWith("#each ")) {
			const name = raw.slice(6).trim();
			const body = parseUntil(template, afterTag, "each");
			nodes.push({ kind: "each", name, body: body.nodes });
			cursor = body.end;
			continue;
		}
		nodes.push({ kind: "var", name: raw });
		cursor = afterTag;
	}
	if (stopName !== null) {
		throw new Error(`goal template: unclosed {{#${stopName}}}`);
	}
	return { nodes, end: template.length, sawElse: false };
}

function lookup(scope: TemplateScope, name: string): TemplateValue {
	if (!(name in scope)) return "";
	return scope[name];
}

function isTruthy(value: TemplateValue): boolean {
	if (Array.isArray(value)) return value.length > 0;
	return Boolean(value);
}

function renderNodes(nodes: Node[], scope: TemplateScope): string {
	let out = "";
	for (const node of nodes) {
		if (node.kind === "text") {
			out += node.text;
		} else if (node.kind === "var") {
			out += String(lookup(scope, node.name) ?? "");
		} else if (node.kind === "if") {
			out += isTruthy(lookup(scope, node.name))
				? renderNodes(node.whenTrue, scope)
				: renderNodes(node.whenFalse, scope);
		} else {
			const value = lookup(scope, node.name);
			if (!Array.isArray(value)) continue;
			for (const item of value) {
				const itemScope: TemplateScope =
					item !== null && typeof item === "object" && !Array.isArray(item)
						? { ...scope, ...(item as TemplateScope) }
						: { ...scope, this: item as TemplateValue };
				out += renderNodes(node.body, itemScope);
			}
		}
	}
	return out;
}

const parseCache = new Map<string, Node[]>();

/** Render a goal prompt template. Templates are static; parse results are cached. */
export function renderTemplate(template: string, scope: TemplateScope): string {
	let nodes = parseCache.get(template);
	if (!nodes) {
		nodes = parseUntil(template, 0, null).nodes;
		parseCache.set(template, nodes);
	}
	return renderNodes(nodes, scope);
}

/**
 * Escape XML-sensitive characters — omp `escapeXmlText`
 * (packages/utils/src/sanitize-text.ts) escapes ONLY the & < > trio; quotes
 * stay verbatim (element-body semantics, pinned by omp's goal-runtime tests).
 */
export function escapeXmlText(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
