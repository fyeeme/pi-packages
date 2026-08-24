import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AskDialogComponent } from "../src/ask-dialog.ts";
import type { ExtensionAskDialogQuestion, ExtensionAskDialogResult } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const passthroughTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	strikethrough: (text: string) => text,
	underline: (text: string) => text,
} as never;

const KEY_MAP: Record<string, string> = {
	"\r": "tui.select.confirm",
	"\n": "tui.select.confirm",
	"\x1b": "tui.select.cancel",
	"\x1b[A": "tui.select.up",
	"\x1b[B": "tui.select.down",
	"\x1b[5~": "tui.select.pageUp",
	"\x1b[6~": "tui.select.pageDown",
};

const fakeKeybindings = {
	matches: (data: string, id: string) => KEY_MAP[data] === id,
	getKeys: (id: string) => (id === "tui.select.cancel" ? ["escape"] : id.includes("page") ? ["pageup"] : []),
} as never;

const fakeTui = { requestRender: () => {} };

const SINGLE: ExtensionAskDialogQuestion = {
	id: "auth",
	question: "Which auth method?",
	options: [
		{ label: "JWT" },
		{ label: "Session" },
	],
};

const MULTI_Q: ExtensionAskDialogQuestion = {
	id: "deploy",
	question: "Where to deploy?",
	options: [
		{ label: "staging" },
		{ label: "prod" },
	],
	multi: true,
};

interface DialogRun {
	component: AskDialogComponent;
	result: Promise<ExtensionAskDialogResult | undefined>;
}

function mount(questions: ExtensionAskDialogQuestion[], options: { timeout?: number } = {}): DialogRun {
	let component: AskDialogComponent | undefined;
	const result = new Promise<ExtensionAskDialogResult | undefined>(resolve => {
		component = new AskDialogComponent(
			passthroughTheme,
			fakeKeybindings,
			questions,
			{
				onSubmit: r => resolve(r),
				onCancel: () => resolve(undefined),
			},
			{ ...options, tui: fakeTui },
		);
	});
	return { component: component!, result };
}

// ---------------------------------------------------------------------------
// Single question
// ---------------------------------------------------------------------------

describe("AskDialogComponent (single question)", () => {
	beforeEach(() => {
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("submits on Enter with the recommended-suffixed option desuffixed in the result", async () => {
		const run = mount([{ ...SINGLE, recommended: 1 }]);
		run.component.handleInput("\r"); // cursor starts on the recommended option
		const result = await run.result;
		expect(result).toEqual({
			kind: "submit",
			results: [
				{
					id: "auth",
					question: "Which auth method?",
					options: ["JWT", "Session"],
					multi: false,
					selectedOptions: ["Session"],
					customInput: undefined,
					note: undefined,
					timedOut: undefined,
				},
			],
		});
	});

	it("cancels on the cancel keybinding", async () => {
		const run = mount([SINGLE]);
		run.component.handleInput("\x1b");
		await expect(run.result).resolves.toBeUndefined();
	});

	it("renders radio markers and the Other row", () => {
		const run = mount([SINGLE]);
		const text = run.component.render(80).join("\n");
		expect(text).toContain("Which auth method?");
		expect(text).toContain("JWT");
		expect(text).toContain("Session");
		expect(text).toContain("Other (type your own)");
		// Single non-multi question: no tab bar, no Submit tab.
		expect(text).not.toContain("Submit");
	});
});

// ---------------------------------------------------------------------------
// Embedded prompt (Other / note)
// ---------------------------------------------------------------------------

describe("AskDialogComponent embedded prompt", () => {
	beforeEach(() => {
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("collects a custom Other answer inline", async () => {
		const run = mount([SINGLE]);
		run.component.handleInput("\x1b[B"); // Session
		run.component.handleInput("\x1b[B"); // Other
		run.component.handleInput("\r"); // open embedded prompt
		run.component.handleInput("m");
		run.component.handleInput("T");
		run.component.handleInput("L");
		run.component.handleInput("S");
		run.component.handleInput("\r"); // confirm
		const result = await run.result;
		expect(result?.kind).toBe("submit");
		if (result?.kind !== "submit") return;
		expect(result.results[0]?.customInput).toBe("mTLS");
		expect(result.results[0]?.selectedOptions).toEqual([]);
	});

	it("an empty Other submission clears the custom answer", async () => {
		const run = mount([SINGLE]);
		run.component.handleInput("\x1b[B");
		run.component.handleInput("\x1b[B");
		run.component.handleInput("\r");
		run.component.handleInput("\r"); // empty confirm
		// Cursor still on the Other row; two ups reach the first option.
		run.component.handleInput("\x1b[A");
		run.component.handleInput("\x1b[A");
		run.component.handleInput("\r");
		const result = await run.result;
		if (result?.kind !== "submit") throw new Error("expected submit");
		expect(result.results[0]?.customInput).toBeUndefined();
		expect(result.results[0]?.selectedOptions).toEqual(["JWT"]);
	});

	it("escape from the prompt returns to the dialog without changes", async () => {
		const run = mount([SINGLE]);
		run.component.handleInput("\x1b[B");
		run.component.handleInput("\x1b[B");
		run.component.handleInput("\r");
		run.component.handleInput("x");
		run.component.handleInput("\x1b"); // back
		run.component.handleInput("\x1b[A"); // Session
		run.component.handleInput("\x1b[A"); // JWT
		run.component.handleInput("\r");
		const result = await run.result;
		if (result?.kind !== "submit") throw new Error("expected submit");
		expect(result.results[0]?.customInput).toBeUndefined();
		expect(result.results[0]?.selectedOptions).toEqual(["JWT"]);
	});

	it("attaches a note to the cursored option via n", async () => {
		const run = mount([SINGLE]);
		run.component.handleInput("n"); // note for JWT (cursor default 0)
		run.component.handleInput("p");
		run.component.handleInput("r");
		run.component.handleInput("o");
		run.component.handleInput("d");
		run.component.handleInput("\r");
		run.component.handleInput("\r"); // select JWT, submit
		const result = await run.result;
		if (result?.kind !== "submit") throw new Error("expected submit");
		expect(result.results[0]?.note).toBe("prod");
	});
});

// ---------------------------------------------------------------------------
// Multi-question tabs and the Submit review tab
// ---------------------------------------------------------------------------

describe("AskDialogComponent tabs", () => {
	beforeEach(() => {
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("advances through questions and submits from the review tab", async () => {
		const run = mount([SINGLE, MULTI_Q]);
		// q1: Enter selects JWT (cursor at 0) and advances to tab 2.
		run.component.handleInput("\r");
		// q2 (multi): Space toggles staging, Enter advances to the Submit tab.
		run.component.handleInput(" ");
		run.component.handleInput("\r");
		// Review tab shows answers; Enter submits.
		const reviewText = run.component.render(80).join("\n");
		expect(reviewText).toContain("Review answers");
		expect(reviewText).toContain("Submit");
		run.component.handleInput("\r");
		const result = await run.result;
		if (result?.kind !== "submit") throw new Error("expected submit");
		expect(result.results.map(r => [r.id, r.selectedOptions])).toEqual([
			["auth", ["JWT"]],
			["deploy", ["staging"]],
		]);
	});

	it("left/right cycle tabs including the review tab", () => {
		const run = mount([SINGLE, MULTI_Q]);
		run.component.handleInput("\x1b[C"); // right
		let text = run.component.render(80).join("\n");
		expect(text).toContain("Where to deploy?");
		// Right from the last question lands on Submit; right again wraps to q1.
		run.component.handleInput("\x1b[C");
		text = run.component.render(80).join("\n");
		expect(text).toContain("Review answers");
		run.component.handleInput("\x1b[D"); // left back to q2
		text = run.component.render(80).join("\n");
		expect(text).toContain("Where to deploy?");
	});

	it("a single multi-select question still gets a Submit tab", async () => {
		const run = mount([MULTI_Q]);
		const text = run.component.render(80).join("\n");
		expect(text).toContain("Submit");
		run.component.handleInput(" "); // toggle staging
		run.component.handleInput("\r"); // advance to Submit
		run.component.handleInput("\r"); // submit
		const result = await run.result;
		if (result?.kind !== "submit") throw new Error("expected submit");
		expect(result.results[0]?.selectedOptions).toEqual(["staging"]);
	});
});

// ---------------------------------------------------------------------------
// Timeout auto-selection
// ---------------------------------------------------------------------------

describe("AskDialogComponent timeout", () => {
	beforeEach(() => {
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("auto-picks recommended options on expiry and flags timedOut", async () => {
		vi.useFakeTimers();
		try {
			const run = mount([{ ...SINGLE, recommended: 1 }, MULTI_Q], { timeout: 30_000 });
			await vi.advanceTimersByTimeAsync(31_000);
			const result = await run.result;
			if (result?.kind !== "submit") throw new Error("expected submit");
			expect(result.results[0]).toMatchObject({ selectedOptions: ["Session"], timedOut: true });
			// No recommended on the multi question: first option auto-picked.
			expect(result.results[1]).toMatchObject({ selectedOptions: ["staging"], timedOut: true });
		} finally {
			vi.useRealTimers();
		}
	});

	it("resets the countdown on any handled keypress", async () => {
		vi.useFakeTimers();
		try {
			const run = mount([SINGLE], { timeout: 30_000 });
			await vi.advanceTimersByTimeAsync(20_000);
			run.component.handleInput("\x1b[B"); // resets the countdown
			await vi.advanceTimersByTimeAsync(20_000); // 40s since spawn, 20s since reset
			const settled = await Promise.race([run.result.then(() => true), Promise.resolve(false)]);
			expect(settled).toBe(false); // still open
			await vi.advanceTimersByTimeAsync(11_000); // past the reset deadline
			const result = await run.result;
			if (result?.kind !== "submit") throw new Error("expected submit");
			expect(result.results[0]?.timedOut).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("defers the timeout while the embedded prompt is open", async () => {
		vi.useFakeTimers();
		try {
			const run = mount([SINGLE], { timeout: 10_000 });
			run.component.handleInput("\x1b[B");
			run.component.handleInput("\x1b[B");
			run.component.handleInput("\r"); // prompt opens
			await vi.advanceTimersByTimeAsync(15_000); // expires mid-prompt
			// Confirming the prompt applies the input FIRST; the deferred
			// timeout then sees customInput set, so it neither force-picks
			// nor flags timedOut (omp #promptForCustomInput ordering).
			run.component.handleInput("o");
			run.component.handleInput("k");
			run.component.handleInput("\r");
			const result = await run.result;
			if (result?.kind !== "submit") throw new Error("expected submit");
			expect(result.results[0]?.customInput).toBe("ok");
			expect(result.results[0]?.selectedOptions).toEqual([]);
			expect(result.results[0]?.timedOut).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});
});

// ---------------------------------------------------------------------------
// Robustness (omp normalization)
// ---------------------------------------------------------------------------

describe("AskDialogComponent robustness", () => {
	it("tolerates malformed streamed questions", async () => {
		const malformed = [
			{ id: 42, question: null, options: "nope" },
			{ id: "ok", question: "Fine?", options: [{ label: "a" }, { label: "b" }] },
		] as never as ExtensionAskDialogQuestion[];
		const run = mount(malformed);
		run.component.render(80); // must not throw on malformed entries
		run.component.handleInput("\x1b");
		await expect(run.result).resolves.toBeUndefined();
	});
});
