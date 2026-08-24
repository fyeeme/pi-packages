import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	addRecommendedSuffix,
	askSingleQuestion,
	formatCustomInputTitle,
	getAutoSelectionOnTimeout,
	OTHER_OPTION,
	stripRecommendedSuffix,
	type UIContext,
} from "../src/ask-legacy.ts";
import type { ExtensionUISelectItem } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Fakes: a full omp-signature select that the logic layer drives 1:1
// ---------------------------------------------------------------------------

interface ScriptedSelect {
	title: string;
	options: ExtensionUISelectItem[];
	opts: Record<string, unknown>;
}

function makeScriptedUi(
	selects: Array<string | undefined>,
	editors: Array<string | undefined> = [],
	options: { onLeftRight?: boolean } = {},
): { ui: UIContext; calls: ScriptedSelect[]; editorTitles: string[] } {
	const calls: ScriptedSelect[] = [];
	const editorTitles: string[] = [];
	const ui: UIContext = {
		select: (title, selectOptions, dialogOptions) => {
			calls.push({ title, options: selectOptions, opts: dialogOptions as Record<string, unknown> });
			const choice = selects.shift();
			if (choice === undefined && options.onLeftRight && dialogOptions?.onRight) {
				dialogOptions.onRight();
				return Promise.resolve(undefined);
			}
			return Promise.resolve(choice);
		},
		editor: title => {
			editorTitles.push(title);
			return Promise.resolve(editors.shift());
		},
	};
	return { ui, calls, editorTitles };
}

const SINGLE_OPTS = [
	{ label: "JWT" },
	{ label: "Session" },
];

const MULTI_OPTS = [
	{ label: "a" },
	{ label: "b" },
	{ label: "c" },
];

describe("recommended suffix helpers", () => {
	it("adds and strips the suffix symmetrically", () => {
		expect(addRecommendedSuffix(SINGLE_OPTS, 1).map(o => (typeof o === "string" ? o : o.label))).toEqual([
			"JWT",
			"Session (Recommended)",
		]);
		expect(stripRecommendedSuffix("Session (Recommended)")).toBe("Session");
		expect(stripRecommendedSuffix("JWT")).toBe("JWT");
	});

	it("out-of-range recommended indexes pass labels through", () => {
		expect(addRecommendedSuffix(SINGLE_OPTS, 9).every(o => !String(o).includes("Recommended"))).toBe(true);
	});

	it("auto-selection picks recommended, else the first option", () => {
		expect(getAutoSelectionOnTimeout(SINGLE_OPTS, 1)).toEqual(["Session"]);
		expect(getAutoSelectionOnTimeout(SINGLE_OPTS)).toEqual(["JWT"]);
		expect(getAutoSelectionOnTimeout([], 0)).toEqual([]);
	});
});

describe("formatCustomInputTitle (omp option windowing)", () => {
	it("includes the question, options, and response hint", () => {
		const options: ExtensionUISelectItem[] = [...SINGLE_OPTS.map(o => o.label), OTHER_OPTION];
		const title = formatCustomInputTitle("Which auth?", options, {
			selectionMarker: "radio",
			markableCount: 2,
		});
		const lines = title.split("\n");
		expect(lines[0]).toBe("Which auth?");
		expect(title).toContain("JWT");
		expect(title).toContain(OTHER_OPTION);
		expect(lines.at(-1)).toBe("Enter your response:");
	});

	it("windows long option lists to the row budget with gap markers", () => {
		const many: ExtensionUISelectItem[] = Array.from({ length: 30 }, (_, i) => `opt-${i}`);
		many.push(OTHER_OPTION);
		const title = formatCustomInputTitle("Q?", many, {
			selectionMarker: "checkbox",
			markableCount: 30,
			checkedIndices: [25],
		});
		const lines = title.split("\n");
		expect(lines.length).toBeLessThanOrEqual(16);
		expect(title).toContain("more option");
		expect(title).toContain("opt-25");
	});
});

describe("askSingleQuestion (single select)", () => {
	beforeEach(() => {
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns the chosen option with the suffix stripped", async () => {
		const { ui, calls } = makeScriptedUi(["Session (Recommended)"]);
		const result = await askSingleQuestion(ui, "Which?", SINGLE_OPTS, false, { recommended: 1 });
		expect(result).toEqual({ selectedOptions: ["Session"], customInput: undefined, note: undefined, timedOut: false });
		expect(calls[0]?.opts.initialIndex).toBe(1);
		expect(calls[0]?.opts.selectionMarker).toBe("radio");
	});

	it("routes Other through the editor and clears options", async () => {
		const { ui, editorTitles } = makeScriptedUi([OTHER_OPTION], ["custom text"]);
		const result = await askSingleQuestion(ui, "Which?", SINGLE_OPTS, false);
		expect(result.customInput).toBe("custom text");
		expect(result.selectedOptions).toEqual([]);
		expect(editorTitles[0]).toContain("Which?");
	});

	it("reports cancelled when the select is dismissed", async () => {
		const { ui } = makeScriptedUi([undefined]);
		const result = await askSingleQuestion(ui, "Which?", SINGLE_OPTS, false);
		expect(result.cancelled).toBe(true);
	});

	it("re-asks after Other is declined", async () => {
		const { ui, calls } = makeScriptedUi([OTHER_OPTION, undefined], [undefined]);
		const result = await askSingleQuestion(ui, "Which?", SINGLE_OPTS, false);
		expect(result.cancelled).toBe(true);
		expect(calls.length).toBe(2);
	});
});

describe("askSingleQuestion (multi select)", () => {
	beforeEach(() => {
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("toggles options through repeated selects and finishes on Done", async () => {
		const { ui, calls } = makeScriptedUi(["a", "b", "+ Done selecting"]);
		const result = await askSingleQuestion(ui, "Pick?", MULTI_OPTS, true);
		expect(result.selectedOptions).toEqual(["a", "b"]);
		expect(result.cancelled).toBeUndefined();
		// Second round shows the checked marker on "a".
		expect(String(calls[1]?.options[0])).toContain("a");
		expect(calls[2]?.title).toContain("2 selected");
	});

	it("keeps the Done option absent until a selection exists", async () => {
		const { ui, calls } = makeScriptedUi(["a", "+ Done selecting"]);
		await askSingleQuestion(ui, "Pick?", MULTI_OPTS, true);
		expect(calls[0]?.options.at(-1)).toBe(OTHER_OPTION);
		expect(calls[1]?.options.some(o => String(o).includes("Done selecting"))).toBe(true);
	});

	it("supports Other as custom multi input", async () => {
		const { ui } = makeScriptedUi([OTHER_OPTION], ["free form"]);
		const result = await askSingleQuestion(ui, "Pick?", MULTI_OPTS, true);
		expect(result.customInput).toBe("free form");
	});

	it("an empty multi submission is a valid select-none", async () => {
		const { ui } = makeScriptedUi(["+ Done selecting"]);
		const result = await askSingleQuestion(ui, "Pick?", MULTI_OPTS, true);
		expect(result.selectedOptions).toEqual([]);
		expect(result.cancelled).toBeUndefined();
	});
});

describe("askSingleQuestion (timeout)", () => {
	beforeEach(() => {
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("invokes onTimeout and auto-picks recommended on timeout", async () => {
		let timedOutCb = false;
		const ui: UIContext = {
			select: (_t, _o, dialogOptions) => {
				if (dialogOptions?.onTimeout && !timedOutCb) {
					timedOutCb = true;
					dialogOptions.onTimeout();
				}
				return Promise.resolve(undefined);
			},
			editor: () => Promise.resolve(undefined),
		};
		const result = await askSingleQuestion(ui, "Which?", SINGLE_OPTS, false, {
			recommended: 1,
			timeout: 5000,
		});
		expect(result.timedOut).toBe(true);
		expect(result.selectedOptions).toEqual(["Session"]);
		expect(result.cancelled).toBeUndefined();
	});
});

describe("askSingleQuestion (navigation)", () => {
	beforeEach(() => {
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("surfaces progress text in the prompt title", async () => {
		const { ui, calls } = makeScriptedUi(["JWT"]);
		await askSingleQuestion(ui, "Which?", SINGLE_OPTS, false, {
			navigation: { allowBack: false, allowForward: true, progressText: "1/2" },
		});
		expect(calls[0]?.title).toBe("Which? (1/2)");
	});

	it("reports forward navigation when onRight fires", async () => {
		const ui: UIContext = {
			select: (_t, _o, dialogOptions) => {
				dialogOptions?.onRight?.();
				return Promise.resolve(undefined);
			},
			editor: () => Promise.resolve(undefined),
		};
		const result = await askSingleQuestion(ui, "Which?", SINGLE_OPTS, false, {
			navigation: { allowBack: false, allowForward: true },
		});
		expect(result.navigation).toBe("forward");
	});

	it("restores a previous answer as the initial selection", async () => {
		const { ui, calls } = makeScriptedUi(["Session"]);
		await askSingleQuestion(ui, "Which?", SINGLE_OPTS, false, {
			initialSelection: { selectedOptions: ["Session"] },
		});
		expect(calls[0]?.opts.initialIndex).toBe(1);
	});
});
