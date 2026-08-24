import { describe, expect, it, vi } from "vitest";

import {
	autoSelectionForQuestion,
	addRecommendedSuffix,
	formatAnswerLine,
	formatAnswerText,
	normalizeQuestions,
	stripRecommendedSuffix,
	default as setupAskUser,
	type AskQuestion,
	type AskUserDetails,
	type QuestionResult,
} from "../index.ts";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const passthroughTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as never;

interface Picker {
	handleInput: (data: string) => boolean;
}

/**
 * ui.custom stub: records every picker it opens and lets tests feed raw key
 * sequences to the most recent one. Mirrors how pi presents the component and
 * settles it via done().
 */
function makeUi() {
	const pickers: Picker[] = [];
	const input = vi.fn<(title: string, placeholder?: string) => Promise<string | undefined>>();
	const notify = vi.fn<(message: string, type?: "info" | "warning" | "error") => void>();

	const custom = vi.fn(
		(factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: unknown) => void) => unknown) =>
			new Promise<unknown>((resolve) => {
				const picker = factory(undefined, passthroughTheme, undefined, resolve) as Picker;
				pickers.push(picker);
			}),
	);

	return {
		custom,
		input,
		notify,
		pickers,
		/** Open-count so far. */
		get opened(): number {
			return pickers.length;
		},
		/** Feed key sequences to the current picker and await its settle value. */
		drive(keys: string[]): Promise<unknown> {
			if (pickers.length === 0) throw new Error("no picker is open");
			const picker = pickers[pickers.length - 1]!;
			for (const key of keys) picker.handleInput(key);
			return custom.mock.results[pickers.length - 1]?.value as Promise<unknown>;
		},
	};
}

interface ToolResult {
	content: Array<{ type: string; text?: string }>;
	details: AskUserDetails;
}

/** Load the tool definition exactly the way pi would. */
function loadTool(): {
	execute: (id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: undefined, ctx: unknown) => Promise<ToolResult>;
} {
	let registered: { execute: (id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: undefined, ctx: unknown) => Promise<ToolResult> } | undefined;
	const fakePi = {
		registerCommand: vi.fn(),
		registerTool: vi.fn((tool: never) => {
			registered = tool;
		}),
	} as never;
	setupAskUser(fakePi);
	if (!registered) throw new Error("ask_user was not registered");
	return registered;
}

function makeCtx(ui: ReturnType<typeof makeUi>) {
	return { hasUI: true, mode: "tui", cwd: "/tmp", ui };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("autoSelectionForQuestion", () => {
	it("picks the recommended option on timeout", () => {
		const q: AskQuestion = {
			id: "a",
			question: "Q?",
			options: [{ label: "x" }, { label: "y" }],
			multi: false,
			recommended: 1,
		};
		expect(autoSelectionForQuestion(q)).toEqual(["y"]);
	});

	it("falls back to the first option without a recommendation", () => {
		const q: AskQuestion = { id: "a", question: "Q?", options: [{ label: "x" }, { label: "y" }], multi: false };
		expect(autoSelectionForQuestion(q)).toEqual(["x"]);
	});
});

describe("normalizeQuestions", () => {
	it("passes well-formed questions through with defaults applied", () => {
		const questions = normalizeQuestions([
			{ id: "a", question: "Q?", options: [{ label: "x" }, { label: "y" }], recommended: 1 },
		]);
		expect(questions).toEqual([
			{ id: "a", question: "Q?", options: [{ label: "x" }, { label: "y" }], multi: false, recommended: 1 },
		]);
	});

	it("decodes questions double-encoded as a JSON string", () => {
		const encoded = JSON.stringify([{ id: "a", question: "Q?", options: ["x", "y"] }]);
		expect(normalizeQuestions(encoded)?.[0]?.options).toEqual([{ label: "x" }, { label: "y" }]);
	});

	it("returns undefined for garbage instead of crashing renderers", () => {
		expect(normalizeQuestions("not json")).toBeUndefined();
		expect(normalizeQuestions(42)).toBeUndefined();
		expect(normalizeQuestions([{ question: "no id" }])).toBeUndefined();
	});

	it("drops reserved labels and questions that fall below two options", () => {
		const questions = normalizeQuestions([
			{
				id: "a",
				question: "Q?",
				options: [{ label: "Other (type your own)" }, { label: "x" }],
			},
		]);
		expect(questions).toBeUndefined();
	});

	it("clamps an out-of-range recommended index to undefined", () => {
		const questions = normalizeQuestions([{ id: "a", question: "Q?", options: ["x", "y"], recommended: 9 }]);
		expect(questions?.[0]?.recommended).toBeUndefined();
	});
});

describe("recommended suffix helpers", () => {
	it("marks only the recommended option and strips cleanly", () => {
		const options: AskQuestion["options"] = [{ label: "A" }, { label: "B" }];
		const labels = addRecommendedSuffix(options, 0);
		expect(labels).toEqual(["A (Recommended)", "B"]);
		expect(stripRecommendedSuffix(labels[0]!)).toBe("A");
	});

	it("does not double-append when the label already carries the suffix", () => {
		const labels = addRecommendedSuffix([{ label: "A (Recommended)" }, { label: "B" }], 0);
		expect(labels[0]).toBe("A (Recommended)");
	});
});

describe("answer formatting", () => {
	it("formats selected, custom, and empty answers distinctly", () => {
		const base = { id: "q", question: "Q", options: ["x", "y"], multi: false };
		const single: QuestionResult = { ...base, selectedOptions: ["y"] };
		const multi: QuestionResult = { ...base, multi: true, selectedOptions: ["x", "y"] };
		const custom: QuestionResult = { ...base, selectedOptions: [], customInput: "neither" };
		const none: QuestionResult = { ...base, selectedOptions: [] };

		expect(formatAnswerLine(single)).toBe("q: y");
		expect(formatAnswerLine(multi)).toBe("q: [x, y]");
		expect(formatAnswerLine(custom)).toBe('q: "neither"');
		expect(formatAnswerLine(none)).toBe("q: (no selection)");
	});

	it("tells the LLM how to proceed after a mid-way cancel", () => {
		const text = formatAnswerText([], true);
		expect(text).toContain("cancelled");
		expect(text).toContain("least destructive");
	});
});

// ---------------------------------------------------------------------------
// Execute orchestration through a mocked UI surface
// ---------------------------------------------------------------------------

describe("ask_user tool", () => {
	it("throws in headless modes instead of hanging", async () => {
		const tool = loadTool();
		const questions: AskQuestion[] = [
			{ id: "a", question: "Q?", options: [{ label: "x" }, { label: "y" }], multi: false },
		];
		await expect(
			tool.execute("t1", { questions }, undefined, undefined, { hasUI: false, mode: "print", ui: {} }),
		).rejects.toThrow("interactive session");
	});

	it("single select: enter picks the cursored option and reports it to the LLM", async () => {
		const ui = makeUi();
		const tool = loadTool();
		const questions: AskQuestion[] = [
			{
				id: "auth",
				question: "Which auth?",
				options: [{ label: "JWT" }, { label: "OAuth2" }],
				multi: false,
				recommended: 0,
			},
		];
		const execution = tool.execute("t1", { questions }, undefined, undefined, makeCtx(ui));
		await ui.drive(["\r"]);
		const result = await execution;

		expect(result.details.cancelled).toBeFalsy();
		expect(result.details.results?.[0]).toMatchObject({ id: "auth", selectedOptions: ["JWT"] });
		expect(result.content[0]?.text).toContain("User answer:");
		expect(result.content[0]?.text).toContain("auth: JWT");
	});

	it("down arrow moves onto the Other row; enter routes through text input into customInput", async () => {
		const ui = makeUi();
		ui.input.mockResolvedValue("ssh keys via agent forwarding");
		const tool = loadTool();
		const questions: AskQuestion[] = [
			{ id: "deploy", question: "Deploy target?", options: [{ label: "Vercel" }, { label: "Fly.io" }], multi: false },
		];
		const execution = tool.execute("t1", { questions }, undefined, undefined, makeCtx(ui));
		await ui.drive(["\x1b[B", "\x1b[B", "\r"]); // cursor onto Other row, select it
		const result = await execution;

		expect(ui.input).toHaveBeenCalledWith("Deploy target?", "Type your answer");
		expect(result.details.results?.[0]?.customInput).toBe("ssh keys via agent forwarding");
	});

	it("multi select: space toggles several options and enter submits them sorted", async () => {
		const ui = makeUi();
		const tool = loadTool();
		const questions: AskQuestion[] = [
			{
				id: "extras",
				question: "Enable extras?",
				options: [{ label: "Telemetry" }, { label: "Auto-update" }, { label: "Sentry" }],
				multi: true,
			},
		];
		const execution = tool.execute("t1", { questions }, undefined, undefined, makeCtx(ui));
		await ui.drive([" ", "\x1b[B", "\x1b[B", " ", "\r"]); // toggle row 0 and row 2, submit
		const result = await execution;

		expect(result.details.results?.[0]).toMatchObject({
			id: "extras",
			multi: true,
			selectedOptions: ["Telemetry", "Sentry"],
		});
		expect(result.content[0]?.text).toContain("extras: [Telemetry, Sentry]");
	});

	it("escape cancels: remaining questions are skipped and the LLM is told to proceed safely", async () => {
		const ui = makeUi();
		const tool = loadTool();
		const questions: AskQuestion[] = [
			{ id: "a", question: "First?", options: [{ label: "x" }, { label: "y" }], multi: false },
			{ id: "b", question: "Second?", options: [{ label: "x" }, { label: "y" }], multi: false },
		];
		const execution = tool.execute("t1", { questions }, undefined, undefined, makeCtx(ui));
		await ui.drive(["\x1b"]);
		const result = await execution;

		expect(result.details.cancelled).toBe(true);
		expect(result.details.results).toHaveLength(0);
		expect(result.details.questions).toEqual(["First?", "Second?"]);
		expect(result.content[0]?.text).toContain("cancelled");
	});

	it("declining the Other input reopens the picker instead of losing the answer", async () => {
		const ui = makeUi();
		ui.input.mockResolvedValueOnce("").mockResolvedValueOnce("fallback answer");
		const tool = loadTool();
		const questions: AskQuestion[] = [
			{ id: "a", question: "Pick?", options: [{ label: "x" }, { label: "y" }], multi: false },
		];
		const execution = tool.execute("t1", { questions }, undefined, undefined, makeCtx(ui));

		await ui.drive(["\x1b[B", "\x1b[B", "\r"]); // Other -> empty input -> picker reopens
		await vi.waitFor(() => expect(ui.opened).toBe(2));
		await ui.drive(["\r"]); // cursor was preserved on the Other row -> real answer
		const result = await execution;

		expect(ui.opened).toBe(2);
		expect(result.details.results?.[0]?.customInput).toBe("fallback answer");
	});

	it("rejects reserved-label collisions at the execution path instead of rendering duplicate rows", async () => {
		const ui = makeUi();
		const tool = loadTool();
		await expect(
			tool.execute(
				"t1",
				{
					questions: [
						{ id: "a", question: "Q?", options: [{ label: "Chat about this" }, { label: "y" }] },
					],
				},
				undefined,
				undefined,
				makeCtx(ui),
			),
		).rejects.toThrow(/reserved runtime label/);
		expect(ui.opened).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Multi-question navigation, timeout, chat redirect, notes, abort
// ---------------------------------------------------------------------------

describe("ask_user multi-question dialog", () => {
	it("left arrow revises an earlier answer; the revised answer wins", async () => {
		const ui = makeUi();
		const tool = loadTool();
		const questions: AskQuestion[] = [
			{ id: "a", question: "First?", options: [{ label: "x" }, { label: "y" }], multi: false },
			{ id: "b", question: "Second?", options: [{ label: "p" }, { label: "q" }], multi: false },
		];
		const execution = tool.execute("t1", { questions }, undefined, undefined, makeCtx(ui));
		// a=x (auto-advance), left back to a, revise to y, forward to b, submit b.
		// Matches omp: answering the last question submits, so revision happens
		// by navigating back before finishing.
		await ui.drive(["\r", "\x1b[D", "\x1b[B", "\r", "\r"]);
		const result = await execution;

		expect(result.details.results?.map((r) => r.selectedOptions[0])).toEqual(["y", "p"]);
		expect(result.details.cancelled).toBeFalsy();
	});

	it("right arrow is blocked until the current question has an answer", async () => {
		const ui = makeUi();
		const tool = loadTool();
		const questions: AskQuestion[] = [
			{ id: "a", question: "First?", options: [{ label: "x" }, { label: "y" }], multi: false },
			{ id: "b", question: "Second?", options: [{ label: "p" }, { label: "q" }], multi: false },
		];
		const execution = tool.execute("t1", { questions }, undefined, undefined, makeCtx(ui));
		// early right press must be a no-op; then answer both in order
		await ui.drive(["\x1b[C", "\x1b[B", "\r", "\r"]);
		const result = await execution;

		expect(result.details.results?.map((r) => r.id)).toEqual(["a", "b"]);
		expect(result.details.results?.[0]?.selectedOptions).toEqual(["y"]);
	});

	it("timeout auto-selects the recommended option and flags the result as timedOut", async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(0);
			const ui = makeUi();
			const tool = loadTool();
			const questions: AskQuestion[] = [
				{
					id: "a",
					question: "First?",
					options: [{ label: "x" }, { label: "y" }],
					multi: false,
					recommended: 1,
				},
			];
			const execution = tool.execute("t1", { questions, timeoutSeconds: 5 }, undefined, undefined, makeCtx(ui));
			await vi.advanceTimersByTimeAsync(5_000);
			const result = await execution;

			expect(result.details.results?.[0]).toMatchObject({
				id: "a",
				selectedOptions: ["y"],
				timedOut: true,
			});
			expect(result.content[0]?.text).toContain("auto-selected after timeout");
		} finally {
			vi.useRealTimers();
		}
	});

	it("Chat about this row redirects instead of collecting answers", async () => {
		const ui = makeUi();
		const tool = loadTool();
		const questions: AskQuestion[] = [
			{ id: "a", question: "Pick one?", options: [{ label: "x" }, { label: "y" }], multi: false },
		];
		const execution = tool.execute("t1", { questions }, undefined, undefined, makeCtx(ui));
		// rows: x, y, Other, Chat -> cursor onto Chat and select
		await ui.drive(["\x1b[B", "\x1b[B", "\x1b[B", "\r"]);
		const result = await execution;

		expect(result.details.chatRedirect).toBe(true);
		expect(result.content[0]?.text).toContain("chose to chat");
	});

	it("n opens a note input and attaches it to the answer", async () => {
		const ui = makeUi();
		ui.input.mockResolvedValueOnce("prefer y: existing infra").mockResolvedValueOnce(undefined);
		const tool = loadTool();
		const questions: AskQuestion[] = [
			{ id: "a", question: "Pick one?", options: [{ label: "x" }, { label: "y" }], multi: false },
		];
		const execution = tool.execute("t1", { questions }, undefined, undefined, makeCtx(ui));
		// n -> note input; dialog reopens; enter selects x and submits
		await ui.drive(["n"]);
		await vi.waitFor(() => expect(ui.opened).toBe(2));
		await ui.drive(["\r"]);
		const result = await execution;

		expect(ui.input).toHaveBeenCalledWith('Note for "a"', "Add a note");
		expect(result.details.results?.[0]).toMatchObject({ selectedOptions: ["x"], note: "prefer y: existing infra" });
	});

	it("agent abort closes the dialog and settles the tool as cancelled", async () => {
		const controller = new AbortController();
		const ui = makeUi();
		const tool = loadTool();
		const questions: AskQuestion[] = [
			{ id: "a", question: "First?", options: [{ label: "x" }, { label: "y" }], multi: false },
			{ id: "b", question: "Second?", options: [{ label: "p" }, { label: "q" }], multi: false },
		];
		const execution = tool.execute("t1", { questions }, controller.signal, undefined, makeCtx(ui));
		controller.abort();
		const result = await execution;

		expect(result.details.cancelled).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// /ask-demo battery: multi-question end-to-end across all types + custom input
// ---------------------------------------------------------------------------

describe("ask-demo command", () => {
	it("runs the four-phase battery: all types, custom input, chat redirect, cancel", async () => {
		const ui = makeUi();
		const notify = vi.fn();

		let demoHandler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
		const fakePi = {
			registerCommand: vi.fn((name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
				if (name === "ask-demo") demoHandler = options.handler;
			}),
			registerTool: vi.fn(),
		} as never;
		setupAskUser(fakePi);
		if (!demoHandler) throw new Error("ask-demo was not registered");

		ui.input.mockResolvedValue("custom plain JS"); // q3 "Other" free-form answer

		const running = demoHandler("", { hasUI: true, mode: "tui", cwd: "/tmp", ui });

		// Phase 1: one dialog, three questions — intermediate drives must NOT await
		// the settle promise (it only resolves when the whole dialog closes).
		void ui.drive(["\r"]); // q1 single: React (recommended)
		void ui.drive([" ", "\x1b[B", " ", "\r"]); // q2 multi: toggle Telemetry + Auto-update, advance
		await ui.drive(["\x1b[B", "\x1b[B", "\r"]); // q3 Other -> custom input -> submit
		// Phase 2: answer instead of waiting out the 6s timeout.
		await vi.waitFor(() => expect(ui.opened).toBe(2));
		await ui.drive(["\r"]);
		// Phase 3: cursor onto "Chat about this" (2 options + Other + Chat).
		await vi.waitFor(() => expect(ui.opened).toBe(3));
		await ui.drive(["\x1b[B", "\x1b[B", "\x1b[B", "\r"]);
		// Phase 4: Esc cancels before the second question is ever asked.
		await vi.waitFor(() => expect(ui.opened).toBe(4));
		await ui.drive(["\x1b"]);
		await running;

		const phaseTexts = ui.notify.mock.calls.map((call) => String(call[0]));
		const typesLine = phaseTexts.find((t) => t.includes("types →"));
		expect(typesLine).toContain("framework: React");
		expect(typesLine).toContain("features: [Telemetry, Auto-update]");
		expect(typesLine).toContain('style: "custom plain JS"');
		expect(phaseTexts.find((t) => t.includes("timeout →"))).toContain("deploy_target: Staging");
		expect(phaseTexts.find((t) => t.includes("chat →"))).toContain("chose to chat");
		expect(phaseTexts.find((t) => t.includes("cancel →"))).toContain("cancelled");
		expect(phaseTexts.some((t) => t.includes("finished"))).toBe(true);
	});

	it("refuses to run without UI", async () => {
		const notify = vi.fn();
		let demoHandler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
		const fakePi = {
			registerCommand: vi.fn((name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
				if (name === "ask-demo") demoHandler = options.handler;
			}),
			registerTool: vi.fn(),
		} as never;
		setupAskUser(fakePi);
		if (!demoHandler) throw new Error("ask-demo was not registered");

		await demoHandler("", { hasUI: false, mode: "print", ui: { notify } });
		expect(notify).toHaveBeenCalledWith("ask-demo requires an interactive session", "warning");
	});
});
