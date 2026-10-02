/**
 * command.test.ts — the /thinking-ui command surface: argument parsing
 * (bare, mode, scope, scope+mode, clear aliases, garbage) and tab
 * completions via the registered getArgumentCompletions hook.
 */
import { describe, expect, it } from "vitest";
import type { ExtensionAPI, AutocompleteItem } from "@earendil-works/pi-coding-agent";
import thinkingUIExtension, { parseCommandAction } from "../index.ts";

function captureCommand(): { getArgumentCompletions: (prefix: string) => AutocompleteItem[] | null } {
	let def: { getArgumentCompletions: (prefix: string) => AutocompleteItem[] | null } | null = null;
	const pi = {
		registerMarkdownTransformer: () => {},
		registerCommand: (_name: string, d: typeof def) => {
			def = d;
		},
		registerShortcut: () => {},
		on: () => {},
		appendEntry: () => {},
	} as unknown as ExtensionAPI;
	thinkingUIExtension(pi);
	if (!def) throw new Error("command not registered");
	// @ts-expect-error def is assigned inside registerCommand; narrow for use
	return def;
}

describe("parseCommandAction", () => {
	it("bare invocation and bare modes set the session scope", () => {
		expect(parseCommandAction("")).toEqual({ type: "set", scope: "session" });
		expect(parseCommandAction("   ")).toEqual({ type: "set", scope: "session" });
		expect(parseCommandAction("summary")).toEqual({ type: "set", scope: "session", mode: "summary" });
		expect(parseCommandAction("  EXPANDED ")).toEqual({ type: "set", scope: "session", mode: "expanded" });
	});

	it("mode aliases resolve", () => {
		expect(parseCommandAction("c")).toEqual({ type: "set", scope: "session", mode: "collapsed" });
		expect(parseCommandAction("collapse")).toEqual({ type: "set", scope: "session", mode: "collapsed" });
		expect(parseCommandAction("summaries")).toEqual({ type: "set", scope: "session", mode: "summary" });
		expect(parseCommandAction("full")).toEqual({ type: "set", scope: "session", mode: "expanded" });
	});

	it("scope prefixes parse with their aliases", () => {
		expect(parseCommandAction("project")).toEqual({ type: "set", scope: "project" });
		expect(parseCommandAction("P")).toEqual({ type: "set", scope: "project" });
		expect(parseCommandAction("global")).toEqual({ type: "set", scope: "global" });
		expect(parseCommandAction("user")).toEqual({ type: "set", scope: "global" });
		expect(parseCommandAction("g")).toEqual({ type: "set", scope: "global" });
	});

	it("scope + mode and scope + clear compose", () => {
		expect(parseCommandAction("project summary")).toEqual({ type: "set", scope: "project", mode: "summary" });
		expect(parseCommandAction("global expanded")).toEqual({ type: "set", scope: "global", mode: "expanded" });
		expect(parseCommandAction("project clear")).toEqual({ type: "clear", scope: "project" });
		expect(parseCommandAction("g reset")).toEqual({ type: "clear", scope: "global" });
	});

	it("garbage returns undefined", () => {
		expect(parseCommandAction("banana")).toBeUndefined();
		expect(parseCommandAction("project banana")).toBeUndefined();
		expect(parseCommandAction("project clear extra")).toBeUndefined();
	});
});

describe("thinking-ui completions", () => {
	const completions = captureCommand();
	const labels = (items: AutocompleteItem[] | null) => items?.map((i) => i.value) ?? [];

	it("empty prefix offers modes and scopes", () => {
		expect(labels(completions.getArgumentCompletions(""))).toEqual([
			"collapsed",
			"summary",
			"expanded",
			"project",
			"global",
		]);
	});

	it("single fragment filters across modes and scopes", () => {
		expect(labels(completions.getArgumentCompletions("s"))).toEqual(["summary"]);
		expect(labels(completions.getArgumentCompletions("pro"))).toEqual(["project"]);
		expect(labels(completions.getArgumentCompletions("e"))).toEqual(["expanded"]);
		expect(completions.getArgumentCompletions("zzz")).toBeNull();
	});

	it("scope prefix composes modes and clear", () => {
		expect(labels(completions.getArgumentCompletions("project "))).toEqual([
			"project collapsed",
			"project summary",
			"project expanded",
			"project clear",
		]);
		expect(labels(completions.getArgumentCompletions("g sum"))).toEqual(["global summary"]); // alias is canonicalized
		expect(labels(completions.getArgumentCompletions("user cl"))).toEqual(["global clear"]);
	});

	it("non-scope first word yields nothing", () => {
		expect(completions.getArgumentCompletions("summary x")).toBeNull();
		expect(completions.getArgumentCompletions("banana ")).toBeNull();
	});
});
