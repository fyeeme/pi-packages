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

	it("pressing n does nothing (note feature removed)", async () => {
		const run = mount([SINGLE]);
		run.component.handleInput("n"); // ignored, stays on the option list
		run.component.handleInput("\r"); // select JWT, submit
		const result = await run.result;
		if (result?.kind !== "submit") throw new Error("expected submit");
		expect(result.results[0]?.selectedOptions).toEqual(["JWT"]);
	});

	it("accepts multi-char CJK IME commits in the embedded prompt", async () => {
		const run = mount([SINGLE]);
		run.component.handleInput("\x1b[B"); // Session
		run.component.handleInput("\x1b[B"); // Other
		run.component.handleInput("\r"); // open embedded prompt
		run.component.handleInput("中文输入"); // single commit event
		run.component.handleInput("\r"); // confirm
		const result = await run.result;
		if (result?.kind !== "submit") throw new Error("expected submit");
		expect(result.results[0]?.customInput).toBe("中文输入");
	});

	it("accepts emoji and deletes them as one grapheme", async () => {
		const run = mount([SINGLE]);
		run.component.handleInput("\x1b[B");
		run.component.handleInput("\x1b[B");
		run.component.handleInput("\r");
		run.component.handleInput("a\u{1F4A1}b");
		run.component.handleInput("\x7f"); // backspace deletes the b
		run.component.handleInput("\x7f"); // backspace deletes the whole emoji
		run.component.handleInput("\r");
		const result = await run.result;
		if (result?.kind !== "submit") throw new Error("expected submit");
		expect(result.results[0]?.customInput).toBe("a");
	});

	it("buffers bracketed paste into the embedded prompt", async () => {
		const run = mount([SINGLE]);
		run.component.handleInput("\x1b[B");
		run.component.handleInput("\x1b[B");
		run.component.handleInput("\r");
		run.component.handleInput("\x1b[200~pa"); // paste starts mid-chunk
		run.component.handleInput("sted text\x1b[201~x"); // terminator + trailing key
		run.component.handleInput("\r");
		const result = await run.result;
		if (result?.kind !== "submit") throw new Error("expected submit");
		expect(result.results[0]?.customInput).toBe("pasted textx");
	});

	it("rejects stray escape sequences in the embedded prompt", async () => {
		const run = mount([SINGLE]);
		run.component.handleInput("\x1b[B");
		run.component.handleInput("\x1b[B");
		run.component.handleInput("\r");
		run.component.handleInput("\x1b[Z"); // shift-tab: unknown sequence
		run.component.handleInput("\r"); // empty submit clears
		// Re-open and check the value is still empty via a fresh input
		run.component.handleInput("\x1b[B");
		run.component.handleInput("\r");
		run.component.handleInput("ok");
		run.component.handleInput("\r");
		const result = await run.result;
		if (result?.kind !== "submit") throw new Error("expected submit");
		expect(result.results[0]?.customInput).toBe("ok");
	});

	it("emits the hardware cursor marker at the input point when focused (IME)", () => {
		const run = mount([SINGLE]);
		// Simulate the TUI granting focus at mount (ui.custom → setFocus).
		run.component.focused = true;
		run.component.handleInput("\x1b[B");
		run.component.handleInput("\x1b[B");
		run.component.handleInput("\r"); // open embedded prompt
		run.component.handleInput("ab");
		run.component.handleInput("\x1b[D"); // cursor left, between a and b
		const text = run.component.render(80).join("\n");
		expect(text).toContain("\x1b_pi:c\x07");
		// Marker sits between 'a' and the reversed 'b' (pi-tui Input contract).
		expect(text).toContain(`a\x1b_pi:c\x07\x1b[7mb`);
		// Losing focus (dialog closes the prompt) must clear the marker path:
		// the Input instance stops emitting it once unfocused.
		run.component.focused = false;
		const unfocused = run.component.render(80).join("\n");
		expect(unfocused).not.toContain("\x1b_pi:c\x07");
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

	it("two single-select questions submit directly on the last Enter (no review tab)", async () => {
		const second: ExtensionAskDialogQuestion = {
			id: "env",
			question: "Which environment?",
			options: [
				{ label: "dev" },
				{ label: "test" },
			],
		};
		const run = mount([SINGLE, second]);
		const text = run.component.render(80).join("\n");
		expect(text).not.toContain("Submit");
		expect(text).not.toContain("Review answers");
		// No review tab, but the tab bar stays for ←/→ navigation.
		expect(text).toContain("auth");
		expect(text).toContain("env");
		run.component.handleInput("\r"); // q1: select JWT, advance
		const q2Text = run.component.render(80).join("\n");
		expect(q2Text).toContain("Which environment?");
		run.component.handleInput("\x1b[D"); // ← back to q1
		expect(run.component.render(80).join("\n")).toContain("Which auth method?");
		run.component.handleInput("\x1b[C"); // → forward to q2
		run.component.handleInput("\x1b[B"); // test
		run.component.handleInput("\r"); // q2: select + submit (last question)
		const result = await run.result;
		if (result?.kind !== "submit") throw new Error("expected submit");
		expect(result.results.map(r => [r.id, r.selectedOptions])).toEqual([
			["auth", ["JWT"]],
			["env", ["test"]],
		]);
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

describe("AskDialogComponent side-by-side preview", () => {
	beforeEach(() => {
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const PREVIEW_Q: ExtensionAskDialogQuestion = {
		id: "deploy",
		question: "Where to deploy?",
		options: [
			{ label: "staging", preview: "alpha-preview-first\nsecond-line" },
			{ label: "prod", preview: "beta-preview" },
		],
	};

	it("renders options and the cursored preview side-by-side on wide terminals", () => {
		const run = mount([PREVIEW_Q]);
		const lines = run.component.render(110);
		// First option row and its preview share a line behind the divider.
		const combined = lines.find(line => line.includes("staging") && line.includes("alpha-preview-first"));
		expect(combined).toBeDefined();
		// Right pane swaps when the cursor moves to the second option. The pane
		// anchors at the top of the body, like fzf's preview column.
		run.component.handleInput("\x1b[B");
		const after = run.component.render(110);
		expect(after.some(line => line.includes("beta-preview"))).toBe(true);
		expect(after.some(line => line.includes("alpha-preview-first"))).toBe(false);
	});

	it("falls back to the inline preview under the label on narrow terminals", () => {
		const run = mount([PREVIEW_Q]);
		const lines = run.component.render(60);
		const text = lines.join("\n");
		expect(text).toContain("staging");
		expect(text).toContain("alpha-preview-first");
		// No line carries both the option label and the preview content.
		expect(lines.some(line => line.includes("staging") && line.includes("alpha-preview-first"))).toBe(false);
	});
});

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
