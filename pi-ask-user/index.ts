/**
 * pi-ask-user - Structured multi-question ask tool for pi
 *
 * Registers an `ask_user` tool that lets the LLM surface clarifying questions
 * with options while it works: all questions presented through one dialog with
 * left/right (or tab/shift+tab) navigation between them, a per-question status
 * strip, single or multi select, a recommended default, optional
 * descriptions/previews, numbered options, free-text "Other" and answer notes
 * captured by an editor embedded in the dialog (the option list stays visible
 * while typing), a review page that summarizes every answer before submitting,
 * an optional overall timeout that auto-selects the recommended options, and a
 * "Chat about this" redirect for deferring the decision into conversation.
 *
 * Answers are stored in tool result `details` so they survive branching and
 * `/tree` inspection.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionUIContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, type TUI, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Types & schema
// ---------------------------------------------------------------------------

export interface AskOption {
	label: string;
	description?: string;
	preview?: string;
}

export interface AskQuestion {
	id: string;
	question: string;
	header?: string;
	options: AskOption[];
	multi: boolean;
	recommended?: number;
}

export interface QuestionResult {
	id: string;
	question: string;
	options: string[];
	multi: boolean;
	selectedOptions: string[];
	customInput?: string;
	note?: string;
	/** True when the answer was auto-selected because the dialog timed out. */
	timedOut?: boolean;
}

export interface AskUserDetails {
	/** Per-question answers in the order the questions were asked. */
	results?: QuestionResult[];
	/** Original question texts (present when the user cancelled mid-way). */
	questions?: string[];
	/** True when the user pressed Escape before finishing all questions. */
	cancelled?: boolean;
	/** True when the user chose to discuss the questions instead of answering. */
	chatRedirect?: boolean;
}

const OTHER_OPTION = "Other (type your own)";
const CHAT_OPTION = "Chat about this";
const RECOMMENDED_SUFFIX = " (Recommended)";

const RESERVED_LABELS = new Set([OTHER_OPTION, CHAT_OPTION]);

const OptionSchema = Type.Object({
	label: Type.String({ description: "Short display label (1-5 words)" }),
	description: Type.Optional(Type.String({ description: "Optional tradeoff/explanation shown below the label" })),
	preview: Type.Optional(
		Type.String({ description: "Optional rich preview shown while the cursor rests on this option" }),
	),
});

const AskQuestionSchema = Type.Object({
	id: Type.String({ description: "Stable identifier for the question, e.g. auth_method" }),
	question: Type.String({ description: "The question text shown to the user" }),
	header: Type.Optional(Type.String({ description: "Short display chip rendered next to the progress counter" })),
	options: Type.Array(OptionSchema, {
		minItems: 2,
		maxItems: 6,
		description: "2-6 distinct options",
	}),
	multi: Type.Optional(Type.Boolean({ description: "Allow selecting multiple options" })),
	recommended: Type.Optional(
		Type.Integer({ minimum: 0, description: "Index of the recommended option (0-based)" }),
	),
});

const AskParamsSchema = Type.Object({
	questions: Type.Array(AskQuestionSchema, { minItems: 1, maxItems: 6, description: "Questions to ask" }),
	timeoutSeconds: Type.Optional(
		Type.Integer({
			minimum: 1,
			description:
				"Overall time budget for the whole dialog; on expiry unanswered questions auto-select the recommended option",
		}),
	),
});

interface AskParams {
	questions: Array<{
		id: string;
		question: string;
		header?: string;
		options: Array<{ label: string; description?: string; preview?: string }>;
		multi?: boolean;
		recommended?: number;
	}>;
	timeoutSeconds?: number;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Coerce untrusted call arguments (partially streamed, model-mangled, or
 * double-encoded as a JSON string) into well-formed questions. Returns
 * undefined when nothing renderable remains.
 */
export function normalizeQuestions(raw: unknown): AskQuestion[] | undefined {
	if (typeof raw === "string") {
		try {
			raw = JSON.parse(raw);
		} catch {
			return undefined;
		}
	}
	if (!Array.isArray(raw)) return undefined;

	const questions: AskQuestion[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") continue;
		const q = entry as Record<string, unknown>;
		if (typeof q.id !== "string" || typeof q.question !== "string") continue;
		if (!Array.isArray(q.options)) continue;

		const options: AskOption[] = [];
		for (const opt of q.options) {
			if (typeof opt === "string") {
				options.push({ label: opt });
				continue;
			}
			if (!opt || typeof opt !== "object") continue;
			const o = opt as Record<string, unknown>;
			if (typeof o.label !== "string" || RESERVED_LABELS.has(o.label)) continue;
			const option: AskOption = { label: o.label };
			if (typeof o.description === "string") option.description = o.description;
			if (typeof o.preview === "string") option.preview = o.preview;
			options.push(option);
		}
		if (options.length < 2) continue;

		questions.push({
			id: q.id,
			question: q.question,
			...(typeof q.header === "string" ? { header: q.header } : {}),
			options,
			multi: q.multi === true,
			recommended:
				typeof q.recommended === "number" &&
				Number.isInteger(q.recommended) &&
				q.recommended >= 0 &&
				q.recommended < options.length
					? q.recommended
					: undefined,
		});
	}
	return questions.length > 0 ? questions : undefined;
}

/** Add "(Recommended)" to the label at `index`; other labels pass through. */
export function addRecommendedSuffix(options: AskOption[], index: number | undefined): string[] {
	return options.map((option, i) =>
		i === index && !option.label.endsWith(RECOMMENDED_SUFFIX) ? option.label + RECOMMENDED_SUFFIX : option.label,
	);
}

/** Strip a trailing "(Recommended)" marker added for display. */
export function stripRecommendedSuffix(label: string): string {
	return label.endsWith(RECOMMENDED_SUFFIX) ? label.slice(0, -RECOMMENDED_SUFFIX.length) : label;
}

/** Auto-selection for one question on timeout: recommended option, else first. */
export function autoSelectionForQuestion(question: AskQuestion): string[] {
	if (question.options.length === 0) return [];
	const index =
		typeof question.recommended === "number" && question.recommended >= 0 && question.recommended < question.options.length
			? question.recommended
			: 0;
	return [stripRecommendedSuffix(question.options[index]!.label)];
}

/** Prefix a label with its 1-based option number, e.g. `2. OAuth2` (raw label when not found). */
export function numberedLabel(options: readonly string[], label: string): string {
	const index = options.indexOf(label);
	return index >= 0 ? `${index + 1}. ${label}` : label;
}

/** Display form of an answer: `"custom text"`, `2. OAuth2`, `[1. A, 3. C]`, or `(no selection)`. */
export function formatAnswerValue(
	options: string[],
	multi: boolean,
	answer: { selectedOptions: string[]; customInput?: string },
): string {
	if (answer.customInput !== undefined) return `"${answer.customInput}"`;
	if (answer.selectedOptions.length === 0) return "(no selection)";
	const numbered = answer.selectedOptions.map((label) => numberedLabel(options, label));
	return multi ? `[${numbered.join(", ")}]` : numbered[0]!;
}

/** Human-readable answer line for one question, e.g. `auth_method: 1. JWT`. */
export function formatAnswerLine(result: QuestionResult): string {
	let line = `${result.id}: ${formatAnswerValue(result.options, result.multi, result)}`;
	if (result.timedOut) line += " (auto-selected after timeout)";
	if (result.note !== undefined) line += ` (note: ${result.note})`;
	return line;
}

/** Full text returned to the LLM describing what the user answered. */
export function formatAnswerText(results: QuestionResult[], cancelled = false): string {
	const lines = results.map(formatAnswerLine);
	const header = results.length === 1 ? "User answer:" : "User answers:";
	let text = lines.length > 0 ? `${header}\n${lines.join("\n")}` : "No questions were answered";
	if (cancelled) {
		text +=
			"\n\nThe user cancelled before answering every question. Proceed with what you have or take the least destructive action.";
	}
	return text;
}

// ---------------------------------------------------------------------------
// Multi-question dialog (radio / checkbox list rendered via ctx.ui.custom)
// ---------------------------------------------------------------------------

type AskUi = Pick<ExtensionUIContext, "custom">;

interface DialogAction {
	kind: "submit" | "chat" | "cancel";
	timedOut?: boolean;
}

interface DialogState {
	index: number;
	cursors: number[]; // per question: highlighted row 0..options.length+1 (Other, Chat)
	checked: Array<Set<number>>; // per question (multi mode)
	answers: Array<{ selectedOptions: string[]; customInput?: string } | undefined>;
	notes: Array<string | undefined>;
}

function initialDialogState(questions: AskQuestion[]): DialogState {
	return {
		index: 0,
		cursors: questions.map((q) => Math.min(q.recommended ?? 0, q.options.length)),
		checked: questions.map(() => new Set<number>()),
		answers: questions.map(() => undefined),
		notes: questions.map(() => undefined),
	};
}

const MAX_PREVIEW_LINES = 6;

function createAskDialog(
	tui: TUI,
	theme: Theme,
	questions: AskQuestion[],
	state: DialogState,
	deadline: number | undefined,
	signal: AbortSignal | undefined,
	done: (action: DialogAction) => void,
): { render: (width: number) => string[]; invalidate: () => void; handleInput: (data: string) => boolean; dispose: () => void } {
	let cachedLines: string[] | undefined;
	let settled = false;
	/** Free-text overlay: "other" captures a custom answer, "note" annotates the current one. */
	let inputMode: "other" | "note" | null = null;

	const settle = (action: DialogAction): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timerId);
		signal?.removeEventListener("abort", onAbort);
		done(action);
	};

	function onAbort(): void {
		settle({ kind: "cancel" });
	}
	signal?.addEventListener("abort", onAbort, { once: true });

	const remainingMs = deadline === undefined ? undefined : Math.max(0, deadline - Date.now());
	const timerId =
		remainingMs === undefined ? undefined : setTimeout(() => settle({ kind: "submit", timedOut: true }), remainingMs);
	if (typeof timerId === "object" && timerId !== null && "unref" in timerId) timerId.unref();

	const question = () => questions[state.index];
	const onSummary = () => state.index === questions.length;
	const allAnswered = () => questions.every((_q, i) => state.answers[i] !== undefined);

	// Embedded single-line editor for "Other" answers and notes: the option
	// list stays visible while typing and Esc returns to the rows.
	const editorTheme: EditorTheme = {
		borderColor: (s) => theme.fg("accent", s),
		selectList: {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		},
	};
	const editor = new Editor(tui, editorTheme);

	editor.onSubmit = (value: string): void => {
		if (inputMode === "other") {
			if (value.length > 0) {
				state.answers[state.index] = { selectedOptions: [], customInput: value };
				state.checked[state.index] = new Set();
				advanceAfterAnswer();
			} else {
				exitInputMode(); // empty submit declines the custom input
			}
		} else if (inputMode === "note") {
			state.notes[state.index] = value.length > 0 ? value : undefined;
			exitInputMode();
		}
	};

	function enterInputMode(mode: "other" | "note"): void {
		inputMode = mode;
		const prefill = mode === "note" ? state.notes[state.index] : state.answers[state.index]?.customInput;
		editor.setText(prefill ?? "");
		cachedLines = undefined;
	}

	function exitInputMode(): void {
		inputMode = null;
		editor.setText("");
		cachedLines = undefined;
	}

	function move(delta: number): void {
		if (onSummary()) return;
		const rows = question().options.length + 2; // + Other + Chat
		state.cursors[state.index] = Math.min(Math.max(state.cursors[state.index]! + delta, 0), rows - 1);
		cachedLines = undefined;
	}

	function toggle(): void {
		const q = question();
		const cursor = state.cursors[state.index]!;
		if (cursor < q.options.length) {
			const checked = state.checked[state.index]!;
			if (checked.has(cursor)) checked.delete(cursor);
			else checked.add(cursor);
			cachedLines = undefined;
		}
	}

	function recordCurrentAnswer(): void {
		const q = question();
		const cursor = state.cursors[state.index]!;
		if (cursor === q.options.length) return; // handled by caller ("other")
		if (cursor === q.options.length + 1) return; // handled by caller ("chat")
		if (!q.multi) {
			const label = stripRecommendedSuffix(addRecommendedSuffix(q.options, q.recommended)[cursor]!);
			// Re-selecting an option replaces any previous custom input (omp semantics).
			state.answers[state.index] = { selectedOptions: [label] };
		} else {
			const labels = [...state.checked[state.index]!].sort((a, b) => a - b).map((i) => q.options[i]?.label ?? "");
			state.answers[state.index] = { selectedOptions: labels };
		}
	}

	/**
	 * Advance after an answer. Single-question dialogs submit immediately;
	 * multi-question dialogs jump to the next unanswered question, or the
	 * review page once every question has an answer (revising an earlier
	 * answer skips the already-answered ones instead of re-walking them).
	 */
	function advanceAfterAnswer(): void {
		exitInputMode();
		if (questions.length === 1) {
			settle({ kind: "submit" });
			return;
		}
		const next = questions.findIndex((_q, i) => state.answers[i] === undefined);
		state.index = next === -1 ? questions.length : next; // -1 → review page
		cachedLines = undefined;
	}

	return {
		render(width: number): string[] {
			if (cachedLines) return cachedLines;
			const q = onSummary() ? undefined : question();
			const lines: string[] = [];
			const renderWidth = Math.max(1, width);

			const wrapWithPrefix = (prefix: string, text: string) => {
				const prefixWidth = visibleWidth(prefix);
				const wrapped = wrapTextWithAnsi(text, Math.max(1, renderWidth - prefixWidth));
				const continuationPrefix = " ".repeat(Math.min(prefixWidth, renderWidth));
				for (let i = 0; i < wrapped.length; i++) {
					lines.push(i === 0 ? prefix + wrapped[i] : continuationPrefix + wrapped[i]);
				}
			};

			lines.push(theme.fg("accent", "-".repeat(renderWidth)));

			// Per-question status strip (multi-question dialogs only).
			if (questions.length > 1) {
				const chips = questions.map((question_, i) => {
					const answered = state.answers[i] !== undefined;
					const marker = theme.fg(answered ? "success" : "dim", answered ? "●" : "○");
					const label = question_.header ?? `Q${i + 1}`;
					const color = i === state.index ? "text" : answered ? "muted" : "dim";
					return `${marker} ${theme.fg(color, label)}`;
				});
				wrapWithPrefix(" ", chips.join("  "));
			}

			if (!q) {
				// Review page: summarize every answer, confirm on Enter.
				const answeredCount = questions.filter((_question, i) => state.answers[i] !== undefined).length;
				wrapWithPrefix(
					" ",
					`${theme.fg("accent", "Review")} ${theme.fg("muted", `(${answeredCount}/${questions.length} answered)`)}`,
				);
				lines.push("");
				questions.forEach((question_, i) => {
					const answer = state.answers[i];
					const label = question_.header ?? question_.question;
					if (!answer) {
						wrapWithPrefix(" ", `${theme.fg("dim", "○")} ${theme.fg("warning", `${label}: (unanswered)`)}`);
						return;
					}
					const value = formatAnswerValue(
						question_.options.map((option) => option.label),
						question_.multi,
						answer,
					);
					wrapWithPrefix(" ", `${theme.fg("success", "●")} ${theme.fg("muted", `${label}: `)}${theme.fg("accent", value)}`);
					if (state.notes[i] !== undefined) {
						wrapWithPrefix("   ", theme.fg("dim", `note: ${state.notes[i]}`));
					}
				});
				lines.push("");
				if (allAnswered()) {
					wrapWithPrefix(" ", theme.fg("success", "Press Enter to submit"));
					wrapWithPrefix(" ", theme.fg("dim", "left revise - esc cancel"));
				} else {
					const missing = questions
						.filter((_question, i) => state.answers[i] === undefined)
						.map((question_) => question_.header ?? question_.question)
						.join(", ");
					wrapWithPrefix(" ", theme.fg("warning", `Unanswered: ${missing}`));
				}
			} else {
				const progress = `[${state.index + 1}/${questions.length}]`;
				const headerChip = q.header ? ` ${theme.fg("muted", q.header)}` : "";
				const noteMark = state.notes[state.index] !== undefined ? theme.fg("dim", " · n") : "";
				wrapWithPrefix(" ", `${theme.fg("accent", progress)}${headerChip}${noteMark} ${theme.fg("text", q.question)}`);
				lines.push("");

				const labels = addRecommendedSuffix(q.options, q.multi ? undefined : q.recommended);
				q.options.forEach((option, i) => {
					const cursorHere = state.cursors[state.index] === i;
					const checked = state.checked[state.index]!.has(i);
					const marker = q.multi
						? checked
							? theme.fg("success", "[x]")
							: theme.fg("dim", "[ ]")
						: checked
							? theme.fg("success", "(o)")
							: theme.fg("dim", "( )");
					const cursorPrefix = cursorHere ? theme.fg("accent", "> ") : "  ";
					wrapWithPrefix(cursorPrefix, `${marker} ${theme.fg(checked ? "accent" : "text", `${i + 1}. ${labels[i]}`)}`);
					if (option.description) wrapWithPrefix("     ", theme.fg("muted", option.description));
					if (cursorHere && option.preview) {
						for (const previewLine of option.preview.split("\n").slice(0, MAX_PREVIEW_LINES)) {
							wrapWithPrefix("       ", theme.fg("dim", previewLine));
						}
					}
				});

				lines.push("");
				const cursor = state.cursors[state.index]!;
				const otherCursor = cursor === q.options.length;
				const chatCursor = cursor === q.options.length + 1;
				const otherLabel = inputMode === "other" ? `${OTHER_OPTION} ✎` : OTHER_OPTION;
				wrapWithPrefix(
					otherCursor ? theme.fg("accent", "> ") : "  ",
					theme.fg(otherCursor ? "accent" : "text", otherLabel),
				);
				wrapWithPrefix(
					chatCursor ? theme.fg("accent", "> ") : "  ",
					theme.fg(chatCursor ? "accent" : "text", CHAT_OPTION),
				);

				if (inputMode !== null) {
					lines.push("");
					wrapWithPrefix(" ", theme.fg("muted", inputMode === "other" ? "Your answer:" : "Note:"));
					for (const line of editor.render(Math.max(1, renderWidth - 2))) {
						lines.push(` ${line}`);
					}
					lines.push("");
					wrapWithPrefix(" ", theme.fg("dim", "enter submit - esc back"));
				} else {
					lines.push("");
					const hints = q.multi
						? questions.length > 1
							? "space toggle - enter next - left/right/tab question - n note - esc cancel"
							: "space toggle - enter submit - n note - esc cancel"
						: questions.length > 1
							? "enter select - left/right/tab question - n note - esc cancel"
							: "enter select - n note - esc cancel";
					wrapWithPrefix(" ", theme.fg("dim", hints));
				}
			}

			lines.push(theme.fg("accent", "-".repeat(renderWidth)));

			cachedLines = lines;
			return lines;
		},

		invalidate(): void {
			cachedLines = undefined;
		},

		handleInput(data: string): boolean {
			// Free-text mode: everything except Esc routes to the embedded editor.
			if (inputMode !== null) {
				if (matchesKey(data, Key.escape)) {
					exitInputMode();
					return true;
				}
				editor.handleInput(data);
				cachedLines = undefined;
				return true;
			}

			if (matchesKey(data, Key.up)) {
				move(-1);
				return true;
			}
			if (matchesKey(data, Key.down)) {
				move(1);
				return true;
			}
			if (matchesKey(data, Key.escape)) {
				settle({ kind: "cancel" });
				return true;
			}

			// Question navigation: arrows plus tab/shift+tab aliases. Forward
			// moves require an answer for the current question; the review
			// page is the last stop.
			if (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab"))) {
				if (state.index > 0) {
					state.index -= 1;
					cachedLines = undefined;
				}
				return true;
			}
			if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
				if (
					questions.length > 1 &&
					state.index < questions.length &&
					state.answers[state.index] !== undefined
				) {
					state.index += 1; // may land on the review page
					cachedLines = undefined;
				}
				return true;
			}

			// Review page: Enter submits once everything is answered.
			if (onSummary()) {
				if (matchesKey(data, Key.return) && allAnswered()) {
					settle({ kind: "submit" });
				}
				return true;
			}

			if (data === "n" || data === "N") {
				enterInputMode("note");
				return true;
			}

			if (matchesKey(data, Key.return)) {
				const q = question();
				const cursor = state.cursors[state.index]!;
				if (cursor === q.options.length) {
					enterInputMode("other");
					return true;
				}
				if (cursor === q.options.length + 1) {
					settle({ kind: "chat" });
					return true;
				}
				if (q.multi) {
					// Enter records the current checkbox set as-is; space does the toggling.
					// An empty set is not an answer: enter stays put instead of marking
					// the question answered with a misleading "(no selection)".
					if (state.checked[state.index]!.size === 0) return true;
				} else {
					// Single mode: exactly one marker — selecting a row replaces the
					// previous one instead of stacking another (o).
					state.checked[state.index] = new Set([cursor]);
				}
				recordCurrentAnswer();
				advanceAfterAnswer();
				return true;
			}

			if (matchesKey(data, Key.space)) {
				// Toggling is multi-select only: in single mode space is a no-op so
				// one question can never accumulate several (o) markers.
				if (!onSummary() && question().multi) toggle();
				return true;
			}
			return false;
		},

		dispose(): void {
			settled = true;
			clearTimeout(timerId);
			signal?.removeEventListener("abort", onAbort);
		},
	};
}

interface DialogOutcome {
	kind: "submit" | "chat" | "cancel";
	timedOut: boolean;
	state: DialogState;
}

/**
 * Run the multi-question dialog to completion. "Other"/"note" free text is
 * captured by an editor embedded in the dialog itself, so the component keeps
 * keyboard focus and its navigation state throughout.
 */
async function runAskDialog(
	ui: AskUi,
	questions: AskQuestion[],
	options_: { deadline?: number; signal?: AbortSignal },
): Promise<DialogOutcome> {
	const state = initialDialogState(questions);
	const action = await ui.custom<DialogAction>((tui, theme, _kb, done) =>
		createAskDialog(tui, theme, questions, state, options_.deadline, options_.signal, done),
	);
	return { kind: action.kind, timedOut: action.timedOut === true, state };
}

function buildResults(questions: AskQuestion[], state: DialogState, timedOut: boolean): QuestionResult[] {
	return questions.map((q, i) => {
		const answer = state.answers[i];
		const autoPicked = timedOut && answer === undefined;
		const selected = autoPicked ? autoSelectionForQuestion(q) : (answer?.selectedOptions ?? []);
		return {
			id: q.id,
			question: q.question,
			options: q.options.map((option) => option.label),
			multi: q.multi,
			selectedOptions: selected,
			...(answer?.customInput !== undefined ? { customInput: answer.customInput } : {}),
			...(state.notes[i] !== undefined ? { note: state.notes[i] } : {}),
			...(autoPicked ? { timedOut: true } : {}),
		};
	});
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

const askUserTool: ToolDefinition<typeof AskParamsSchema, AskUserDetails> = {
	name: "ask_user",
	label: "Ask User",
		description:
			"Ask the user one or more clarifying questions with selectable options. " +
			"Use when choices have materially different tradeoffs the user must decide. " +
			"The user can always provide free-form input via an automatic 'Other' option.",
		promptSnippet: "Ask the user structured questions with options during execution",
		promptGuidelines: [
			"Use ask_user only after exhausting repo conventions, configs, and docs; reserve it for decisions whose options have materially different tradeoffs.",
		],
		parameters: AskParamsSchema,
		executionMode: "sequential",

		async execute(_toolCallId, params: AskParams, signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				throw new Error("ask_user requires an interactive session (TUI or RPC mode)");
			}

			// Reserved-label collision check (mirrors omp's schema narrow).
			for (const q of params.questions) {
				const clash = q.options.find((option) => RESERVED_LABELS.has(option.label ?? ""));
				if (clash) {
					throw new Error(
						`ask_user: option label "${clash.label}" in question "${q.id}" collides with a reserved runtime label`,
					);
				}
			}

			const questions: AskQuestion[] = params.questions.map((q) => ({
				id: q.id,
				question: q.question,
				...(typeof q.header === "string" ? { header: q.header } : {}),
				options: q.options.map((option) => ({
					label: option.label,
					...(typeof option.description === "string" ? { description: option.description } : {}),
					...(typeof option.preview === "string" ? { preview: option.preview } : {}),
				})),
				multi: q.multi === true,
				recommended: typeof q.recommended === "number" ? q.recommended : undefined,
			}));

			const deadline =
				typeof params.timeoutSeconds === "number" && params.timeoutSeconds > 0 ? Date.now() + params.timeoutSeconds * 1000 : undefined;

			const outcome = await runAskDialog(ctx.ui, questions, { deadline, signal });

			if (outcome.kind === "chat") {
				const questionTexts = questions.map((q) => q.question).join("\n");
				return {
					content: [
						{
							type: "text",
							text: `User chose to chat about this instead of answering.\n\nQuestions asked:\n${questionTexts}`,
						},
					],
					details: { chatRedirect: true, questions: questions.map((q) => q.question), results: [] } satisfies AskUserDetails,
				};
			}

			if (outcome.kind === "cancel") {
				const details: AskUserDetails = {
					results: [],
					questions: questions.map((q) => q.question),
					cancelled: true,
				};
				return {
					content: [{ type: "text", text: formatAnswerText([], true) }],
					details,
				};
			}

			const results = buildResults(questions, outcome.state, outcome.timedOut);
			const details: AskUserDetails = { results, questions: questions.map((q) => q.question) };
			return {
				content: [{ type: "text", text: formatAnswerText(results, false) }],
				details,
			};
		},

		renderCall(args, theme) {
			const questions = normalizeQuestions(args?.questions);
			if (!questions) {
				return new Text(theme.fg("toolTitle", theme.bold("ask_user")), 0, 0);
			}
			const lines = questions.map((q) => {
				const mode = q.multi ? "multi" : "single";
				const header = q.header ? ` ${theme.fg("muted", q.header)}` : "";
				return `${theme.fg("dim", `[${q.id}]`)}${header} ${theme.fg("text", q.question)} ${theme.fg("muted", `(${mode}, ${q.options.length} options)`)}`;
			});
			return new Text(`${theme.fg("toolTitle", theme.bold("ask_user"))}\n${lines.join("\n")}`, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as AskUserDetails | undefined;

			if (details?.chatRedirect) {
				const lines = (details.questions ?? []).map((q) => theme.fg("dim", q));
				return new Text(
					`${theme.fg("warning", "~")} ${theme.fg("muted", "chat redirect")}\n${lines.map((l) => `  ${l}`).join("\n")}`,
					0,
					0,
				);
			}

			const results = details?.results;
			if (!results || results.length === 0) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}
			const lines = results.map((r) => formatAnswerLine(r));
			const status = details?.cancelled ? theme.fg("warning", "~") : theme.fg("success", "+");
			return new Text(
				`${status} ${theme.fg("muted", "answers:")}\n${lines.map((l) => `  ${theme.fg("accent", l)}`).join("\n")}`,
				0,
				0,
			);
		},
};

// ---------------------------------------------------------------------------
// /ask-demo: interactive battery covering every question type and path
// ---------------------------------------------------------------------------

const DEMO_TYPES: AskParams = {
	questions: [
		{
			id: "framework",
			question: "Which frontend framework should the demo project use?",
			header: "Framework",
			options: [
				{
					label: "React",
					description: "Largest ecosystem, most hiring pool",
					preview: "- Virtual DOM, hooks\n- Huge component marketplaces\n- Heavier bundle baseline",
				},
				{ label: "Vue", description: "Gentle learning curve, SFC single-file components" },
				{ label: "Svelte", description: "Compile-time reactivity, smallest bundles" },
			],
			recommended: 0,
		},
		{
			id: "features",
			question: "Which features should be enabled out of the box?",
			header: "Features",
			options: [
				{ label: "Telemetry", description: "Anonymous usage reporting" },
				{ label: "Auto-update", description: "Background self-update checks" },
				{ label: "Offline cache", description: "Service-worker asset caching" },
			],
			multi: true,
		},
		{
			id: "style",
			question: "Which language for generated code? (try 'Other' + a note here)",
			header: "Style",
			options: [
				{ label: "TypeScript", description: "Strict types, better tooling" },
				{ label: "JavaScript", description: "Zero build setup for simple scripts" },
			],
		},
	],
};

const DEMO_TIMEOUT: AskParams = {
	questions: [
		{
			id: "deploy_target",
			question: "Where should CI deploy? (do nothing, let it time out)",
			header: "Deploy",
			options: [
				{ label: "Staging", description: "Safe default ring" },
				{ label: "Production", description: "Straight to live traffic" },
			],
			recommended: 0,
		},
	],
	timeoutSeconds: 6,
};

const DEMO_CHAT: AskParams = {
	questions: [
		{
			id: "migration",
			question: "Rewrite the legacy module now or plan first? (pick 'Chat about this')",
			header: "Migration",
			options: [
				{ label: "Rewrite now", description: "Fast but risky on shared code" },
				{ label: "Plan first", description: "Slower start, safer rollout" },
			],
		},
	],
};

const DEMO_CANCEL: AskParams = {
	questions: [
		{ id: "a", question: "First of two (press Esc to cancel)", options: [{ label: "x" }, { label: "y" }] },
		{ id: "b", question: "Second (should never be asked)", options: [{ label: "p" }, { label: "q" }] },
	],
};

async function runAskDemo(ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("ask-demo requires an interactive session", "warning");
		return;
	}

	const run = async (label: string, params: AskParams): Promise<string> => {
		ctx.ui.notify(`ask-demo ${label} — follow the dialog instructions`, "info");
		try {
			const result = await askUserTool.execute(`demo-${label}`, params, undefined, undefined, ctx);
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			ctx.ui.notify(`ask-demo ${label} → ${text.split("\n").filter(Boolean).join(" | ").slice(0, 200)}`, "info");
			return text;
		} catch (error) {
			ctx.ui.notify(`ask-demo ${label} failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			return "";
		}
	};

	ctx.ui.notify(
		"ask-demo 1/4 all question types: single+recommended+preview, multi, Other free input, note with n, review page before submit",
		"info",
	);
	await run("types", DEMO_TYPES);

	await run("timeout", DEMO_TIMEOUT); // dialog itself says: wait 6s

	ctx.ui.notify("ask-demo 3/4 chat redirect: choose 'Chat about this' in the next dialog", "info");
	await run("chat", DEMO_CHAT);

	ctx.ui.notify("ask-demo 4/4 cancel: press Esc in the next dialog", "info");
	await run("cancel", DEMO_CANCEL);

	ctx.ui.notify("ask-demo finished — review the four results above", "info");
}

export default function askUserExtension(pi: ExtensionAPI): void {
	pi.registerTool(askUserTool);
	pi.registerCommand("ask-demo", {
		description: "Interactive ask_user battery: all question types, timeout, chat redirect, cancel",
		handler: (_args, ctx) => runAskDemo(ctx),
	});
}
