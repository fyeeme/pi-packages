/**
 * Outcome collectors — extract a structured value from an agent's text output.
 *
 * The new runner's agent results are plain strings (finalText); a collector
 * turns that text into a typed value (a URL list, a file-path list, a JSON
 * object). This is the lean successor to the old prototype's Artifact/handle
 * outcome system: no handle abstraction, no RunState coupling — collectors are
 * pure functions of text, applied by whoever consumes a StepResult.
 *
 * Not wired into step types (no speculative executor change): call
 * `collect(spec, text)` on a step's results when you want a structured outcome.
 */

/** Declarative description of what to extract from an agent's text. */
export type OutputSpec =
	| { readonly kind: "url"; readonly pattern?: RegExp }
	| { readonly kind: "file_path" }
	| { readonly kind: "json" };

/** A pure extractor: text → value (or undefined if nothing matched). */
export type Collector<T = unknown> = (text: string) => T | undefined;

const DEFAULT_URL_PATTERN = /https?:\/\/[^\s)"'<>]+/g;
// Heuristic: any whitespace-delimited token containing a slash (a path); URLs filtered after.
const DEFAULT_PATH_PATTERN = /[^\s"'<>]*\/[^\s"'<>]+/g;

/** Collect every URL in `text` (default http/https pattern). */
export const urlCollector: Collector<string[]> = (text) => {
	const out = [...text.matchAll(DEFAULT_URL_PATTERN)].map((m) => m[0]);
	return out.length > 0 ? out : undefined;
};

/** Collect heuristic file paths from `text`. */
export const filePathCollector: Collector<string[]> = (text) => {
	const out = [...text.matchAll(DEFAULT_PATH_PATTERN)].map((m) => m[0]).filter((p) => !/^https?:\/\//.test(p));
	return out.length > 0 ? out : undefined;
};

/** Extract the first balanced JSON object or array from `text` (string/escape aware). Shared with the runner's composite judges. */
export function parseFirstJson(text: string): unknown {
	return extractJson(text);
}

/** Collect the first JSON value via the shared extractor. */
export const jsonCollector: Collector<unknown> = (text) => extractJson(text);

/**
 * Apply a spec to `text`, returning the extracted value (or undefined).
 * Generic so callers narrow: `collect<string[]>>({ kind: "url" }, text)`.
 */
export function collect<T = unknown>(spec: OutputSpec, text: string): T | undefined {
	switch (spec.kind) {
		case "url":
			return urlList(text, spec.pattern) as T | undefined;
		case "file_path":
			return filePathCollector(text) as T | undefined;
		case "json":
			return jsonCollector(text) as T | undefined;
	}
}

function urlList(text: string, pattern?: RegExp): string[] | undefined {
	const re = pattern ?? DEFAULT_URL_PATTERN;
	const out = [...text.matchAll(re)].map((m) => m[0]);
	return out.length > 0 ? out : undefined;
}

function extractJson(text: string): unknown {
	const objStart = text.indexOf("{");
	const arrStart = text.indexOf("[");
	let start: number;
	let openCh: string;
	let closeCh: string;
	if (objStart === -1 && arrStart === -1) return undefined;
	if (objStart === -1) {
		start = arrStart;
		openCh = "[";
		closeCh = "]";
	} else if (arrStart === -1) {
		start = objStart;
		openCh = "{";
		closeCh = "}";
	} else {
		if (objStart < arrStart) {
			start = objStart;
			openCh = "{";
			closeCh = "}";
		} else {
			start = arrStart;
			openCh = "[";
			closeCh = "]";
		}
	}
	let depth = 0;
	let inStr = false;
	let escape = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (inStr) {
			if (escape) escape = false;
			else if (ch === "\\") escape = true;
			else if (ch === '"') inStr = false;
			continue;
		}
		if (ch === '"') inStr = true;
		else if (ch === openCh) depth++;
		else if (ch === closeCh) {
			depth--;
			if (depth === 0) {
				try {
					return JSON.parse(text.slice(start, i + 1));
				} catch {
					return undefined;
				}
			}
		}
	}
	return undefined;
}
