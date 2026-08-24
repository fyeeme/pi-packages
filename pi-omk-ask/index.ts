/**
 * pi-omk-ask — the oh-my-pi `ask` tool migrated to a pi extension
 *
 * Source: oh-my-pi (github.com/can1357/oh-my-pi, a fork of badlogic/pi-mono)
 *   - packages/coding-agent/src/tools/ask.ts        → execute + renderer (below)
 *   - packages/coding-agent/src/modes/components/ask-dialog.ts → src/ask-dialog.ts
 *   - packages/coding-agent/src/tools/ask.ts (askSingleQuestion) → src/ask-legacy.ts
 *   - packages/coding-agent/src/prompts/tools/ask.md → tool description
 *
 * The tool lets the LLM surface clarifying questions with selectable options
 * while it works. Multi questions render as a tabbed dialog with a Submit
 * review page; hosts without custom component support (RPC) degrade to
 * per-question native dialogs; hosts without any UI never see the tool.
 *
 * Adaptations for pi's extension API (each maps an omp-internal surface to
 * the public extension boundary):
 *
 *   omp surface                      → pi adaptation
 *   ─────────────────────────────────────────────────────────────────────────
 *   AgentTool class + createIf gate  → pi.registerTool + session_start strip
 *                                      (print/json hosts cannot prompt, so the
 *                                      tool is removed from the active set and
 *                                      execute() throws as a backstop)
 *   ArkType schema + narrow          → typebox schema; the reserved-label
 *                                      narrow runs at the top of execute()
 *   concurrency: "exclusive"         → executionMode: "sequential"
 *   settings ask.timeout/ask.notify  → timeoutSeconds tool parameter + BEL
 *                                      (pi extensions cannot read pi settings)
 *   plan-mode timeout suppression    → dropped (no plan-mode API on pi ctx)
 *   speech/TTS vocalizer             → dropped
 *   collab guest race, ACP
 *   elicitation, /tree re-answer     → dropped (host-internal surfaces)
 *   ToolAbortError + context.abort() → ctx.abort() + thrown Error
 *   ExtensionUIContext.askDialog     → ctx.ui.custom() mounting AskDialogComponent
 *   askToolRenderer (mergeCall+Result) → split pi renderCall/renderResult slots
 *                                      (call slot renders a summary line
 *                                      only; the merged question/options/
 *                                      answer block renders once from the
 *                                      result slot — pi appends result
 *                                      renders below call renders, so a
 *                                      full call block would duplicate the
 *                                      transcript)
 *
 * omp result semantics are kept verbatim: `User selected: X`, custom input
 * and note blocks, `User answers:` for multi-question, `chatRedirect`, and
 * `(auto-selected after timeout)` markers; answers persist in `details`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { AskDialogComponent } from "./src/ask-dialog.ts";
import {
	askSingleQuestion,
	RESERVED_OPTION_LABELS,
	type AskOption,
	type NavigationControls,
	type UIContext,
	uiContextFromExtension,
} from "./src/ask-legacy.ts";
import { ELLIPSIS, replaceTabs, renderInlineMarkdown, SYMBOLS, truncateToWidth, visibleWidth } from "./src/compat.ts";
import { bottomBorder, divider, row, topBorder } from "./src/overlay-box.ts";
import type {
	AskToolDetails,
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResult,
	ExtensionUISelectItem,
	QuestionResult,
} from "./src/types.ts";

// ---------------------------------------------------------------------------
// Schema (omp askSchema; timeoutSeconds replaces omp's settings-driven budget)
// ---------------------------------------------------------------------------

const OptionSchema = Type.Object({
	label: Type.String({ description: "display label" }),
	description: Type.Optional(Type.String({ description: "optional explanatory text displayed below the label" })),
	preview: Type.Optional(
		Type.String({ description: "optional rich preview content for interactive ask dialogs" }),
	),
});

const AskQuestionSchema = Type.Object({
	id: Type.String({ description: "question id" }),
	question: Type.String({ description: "question text" }),
	header: Type.Optional(Type.String({ description: "optional short display chip for rich ask dialogs" })),
	options: Type.Array(OptionSchema, { description: "available options" }),
	multi: Type.Optional(Type.Boolean({ description: "allow multiple selections" })),
	recommended: Type.Optional(Type.Integer({ minimum: 0, description: "recommended option index" })),
});

const AskParamsSchema = Type.Object({
	questions: Type.Array(AskQuestionSchema, { minItems: 1, description: "questions to ask" }),
	timeoutSeconds: Type.Optional(
		Type.Integer({
			minimum: 1,
			description:
				"Inactivity timeout in seconds for the whole dialog; keypresses in the dialog reset it " +
				"(not while typing an Other answer or note, and not on hosts limited to plain sequential " +
				"dialogs). On expiry unanswered questions auto-pick the noted or recommended option " +
				"(omp's settings-driven ask.timeout, parameterized for pi)",
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

const ASK_DESCRIPTION = `Ask user for clarification/input during task execution.

<conditions>
- Multiple approaches with significantly different tradeoffs user should weigh.
</conditions>

<instruction>
- \`recommended: <index>\` marks default (0-indexed); " (Recommended)" added automatically.
- Use \`questions\` for related questions, not one at a time.
- Set \`multi: true\` on a question to allow multiple selections.
- Short option labels; explanatory tradeoffs in \`description\`, not labels.
</instruction>

<caution>
- Provide 2-5 concise, distinct options.
</caution>

<critical>
- Default to action. Resolve ambiguity via repo conventions, existing patterns, reasonable defaults. Exhaust existing sources (code, configs, docs, history) before asking. Ask only when options have materially different tradeoffs the user must decide.
- If multiple choices acceptable: pick most conservative/standard option; proceed; state choice.
- Do NOT include "Other"; UI automatically adds "Other (type your own)" to every question.
</critical>`;

// ---------------------------------------------------------------------------
// Response formatting (omp ask.ts, verbatim)
// ---------------------------------------------------------------------------

function formatQuestionResult(result: QuestionResult): string {
	const noteSuffix = result.note ? ` (note: ${result.note})` : "";
	if (result.customInput !== undefined) {
		return `${result.id}: "${result.customInput}"${noteSuffix}`;
	}
	if (result.selectedOptions.length > 0) {
		const suffix = `${result.timedOut ? " (auto-selected after timeout)" : ""}${noteSuffix}`;
		return result.multi
			? `${result.id}: [${result.selectedOptions.join(", ")}]${suffix}`
			: `${result.id}: ${result.selectedOptions[0]}${suffix}`;
	}
	return result.multi ? `${result.id}: []${noteSuffix}` : `${result.id}: (cancelled)${noteSuffix}`;
}

function formatSingleQuestionResponse(result: {
	selectedOptions: string[];
	customInput?: string;
	note?: string;
	timedOut?: boolean;
	multi: boolean;
}): string {
	const responseParts: string[] = [];
	if (result.selectedOptions.length > 0) {
		const selectedText = result.multi
			? `User selected: ${result.selectedOptions.join(", ")}`
			: `User selected: ${result.selectedOptions[0]}`;
		responseParts.push(result.timedOut ? `${selectedText} (auto-selected after timeout)` : selectedText);
	}
	if (result.customInput !== undefined) {
		responseParts.push(
			result.customInput.includes("\n")
				? `User provided custom input:\n${result.customInput
						.split("\n")
						.map(line => `  ${line}`)
						.join("\n")}`
				: `User provided custom input: ${result.customInput}`,
		);
	}
	if (result.note) {
		responseParts.push(
			result.note.includes("\n")
				? `User added note:\n${result.note
						.split("\n")
						.map(line => `  ${line}`)
						.join("\n")}`
				: `User added note: ${result.note}`,
		);
	}
	if (responseParts.length > 0) return responseParts.join("\n");
	return result.multi ? "User did not select any options" : "User cancelled the selection";
}

// ---------------------------------------------------------------------------
// Transcript rendering (omp askToolRenderer, split into pi render slots)
// ---------------------------------------------------------------------------

/** omp framedBlock as a pi Component: titled frame with divider-labelled
 *  sections. Section content renders lazily per frame width (omp renders at
 *  `outputBlockContentWidth(width)`; a fixed width would clip on narrow
 *  terminals). */
class FramedComponent {
	private lines: string[] | undefined;
	private cachedWidth: number | undefined;
	private readonly theme: Theme;
	private readonly title: string;
	private readonly sections: Array<{ label?: string; linesFor: (width: number) => readonly string[] }>;

	constructor(
		theme: Theme,
		title: string,
		sections: Array<{ label?: string; linesFor: (width: number) => readonly string[] }>,
	) {
		this.theme = theme;
		this.title = title;
		this.sections = sections;
	}

	invalidate(): void {
		this.lines = undefined;
		this.cachedWidth = undefined;
	}

	render(width: number): string[] {
		// Cache keyed by width: pi's resize path re-renders the tree with the
		// new width without calling invalidate() (pi-tui Text convention), so an
		// unconditional cache would keep stale wide lines after a shrink and the
		// terminal would hardware-wrap them, garbling the transcript.
		if (this.lines && this.cachedWidth === width) return [...this.lines];
		// Render sections at the content width row() actually fits into
		// (width - 4 for the "│ " insets). Rendering at the full width makes
		// every padded line (e.g. Markdown, which pads to its render width)
		// truncate in fit(), and truncation appends a full \x1b[0m reset that
		// kills the surrounding toolSuccessBg background — leaving bg holes on
		// the right edge of those rows (omp renders at outputBlockContentWidth).
		const contentWidth = Math.max(1, width - 4);
		const out: string[] = [topBorder(this.theme, width, this.title)];
		for (let i = 0; i < this.sections.length; i++) {
			const section = this.sections[i]!;
			if (section.label !== undefined) out.push(row(this.theme, section.label, width));
			for (const line of section.linesFor(contentWidth)) out.push(row(this.theme, line, width));
			if (i < this.sections.length - 1) out.push(divider(this.theme, width));
		}
		out.push(bottomBorder(this.theme, width));
		this.lines = out;
		this.cachedWidth = width;
		return [...out];
	}
}

function renderCustomInputLines(uiTheme: Theme, customInput: string): string[] {
	const lines = customInput.split("\n");
	const out: string[] = [
		` ${uiTheme.fg("success", SYMBOLS.status.success)} ${uiTheme.fg("toolOutput", lines[0] ?? "")}`,
	];
	for (let i = 1; i < lines.length; i++) out.push(`   ${uiTheme.fg("toolOutput", lines[i]!)}`);
	return out;
}

function renderNoteLines(uiTheme: Theme, note: string, width: number): string[] {
	const prefix = " Note: ";
	const continuationPrefix = "       ";
	const firstLineWidth = Math.max(1, width - visibleWidth(prefix));
	const continuationWidth = Math.max(1, width - visibleWidth(continuationPrefix));
	return replaceTabs(note)
		.split("\n")
		.map((line, index) => {
			const linePrefix = index === 0 ? `${uiTheme.fg("dim", " Note:")} ` : continuationPrefix;
			const maxWidth = index === 0 ? firstLineWidth : continuationWidth;
			return `${linePrefix}${uiTheme.fg("toolOutput", truncateToWidth(line, maxWidth, ELLIPSIS))}`;
		});
}

function optionMarker(uiTheme: Theme, multi: boolean | undefined, selected: boolean): string {
	if (multi) return selected ? SYMBOLS.checkbox.checked : SYMBOLS.checkbox.unchecked;
	return selected ? SYMBOLS.radio.selected : SYMBOLS.radio.unselected;
}

function renderAnswerOptionLines(
	uiTheme: Theme,
	options: string[] | undefined,
	selectedOptions: string[] | undefined,
	multi: boolean | undefined,
	customInput: string | undefined,
	note: string | undefined,
	width: number,
): string[] {
	const selected = new Set(selectedOptions ?? []);
	const list = options && options.length > 0 ? options : (selectedOptions ?? []);

	if (selected.size === 0 && customInput === undefined && note === undefined) {
		return [` ${uiTheme.fg("warning", `${SYMBOLS.status.warning} Cancelled`)}`];
	}

	const out: string[] = [];
	for (const label of list) {
		const isSelected = selected.has(label);
		const marker = optionMarker(uiTheme, multi, isSelected);
		const markerStyled = isSelected ? uiTheme.fg("success", marker) : uiTheme.fg("dim", marker);
		const labelStyled = renderInlineMarkdown(label, t =>
			isSelected ? uiTheme.fg("toolOutput", t) : uiTheme.fg("muted", t),
		);
		out.push(` ${markerStyled} ${labelStyled}`);
	}
	if (customInput !== undefined) out.push(...renderCustomInputLines(uiTheme, customInput));
	if (note !== undefined) out.push(...renderNoteLines(uiTheme, note, width));
	return out;
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function ompAskExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ask",
		label: "Ask",
		description: ASK_DESCRIPTION,
		promptSnippet: "Ask the user a clarifying question",
		promptGuidelines: [
			"Use ask only after exhausting repo conventions, configs, and docs; reserve it for decisions whose options have materially different tradeoffs.",
		],
		parameters: AskParamsSchema,
		executionMode: "sequential",

		async execute(_toolCallId, params: AskParams, signal, _onUpdate, ctx) {
			// Headless fallback (omp: createIf gate + ToolAbortError). pi
			// extension edition: the tool should already have been stripped at
			// session_start; if it still runs, tell the model the question was
			// never displayed instead of letting it read a cancel as an answer.
			if (!ctx.hasUI || !ctx.ui) {
				ctx.abort();
				throw new Error(
					"ask: this session has no interactive UI host, so the question was never shown to the user. " +
						"Do not call ask again in this session; proceed with the safest default or state questions in plain text.",
				);
			}

			// Reserved-label narrow (omp schema narrow, executed eagerly here).
			for (const q of params.questions) {
				const reserved = q.options.find(option => RESERVED_OPTION_LABELS[option.label] === true);
				if (reserved) {
					throw new Error(
						`ask: question "${q.id}" uses reserved runtime label "${reserved.label}"; ` +
							`do not include "Other" — the UI adds it automatically`,
					);
				}
			}

			const extensionUi = ctx.ui;
			const ui: UIContext = uiContextFromExtension(extensionUi);

			// omp derives the timeout from settings (ask.timeout) and disables
			// it in plan mode; pi extensions cannot read settings, so the
			// budget arrives as a tool parameter.
			const timeout =
				typeof params.timeoutSeconds === "number" && params.timeoutSeconds > 0
					? params.timeoutSeconds * 1000
					: null;

			// omp ask.notify → terminal bell (pi extensions cannot send desktop
			// notifications or read settings). omp's setting is opt-out-able, so
			// the bell stays configurable via PI_OMK_ASK_NOTIFY=0.
			if (process.env.PI_OMK_ASK_NOTIFY !== "0") process.stdout.write("\x07");

			if (params.questions.length === 0) {
				return {
					content: [{ type: "text" as const, text: "Error: questions must not be empty" }],
					details: {},
				};
			}

			const richQuestions: ExtensionAskDialogQuestion[] = params.questions.map(q => ({
				id: q.id,
				question: q.question,
				...(q.header?.trim() ? { header: q.header } : {}),
				options: q.options.map(option => ({
					label: option.label,
					...(option.description?.trim() ? { description: option.description.trim() } : {}),
					...(option.preview?.trim() ? { preview: option.preview } : {}),
				})),
				...(q.multi !== undefined ? { multi: q.multi } : {}),
				...(q.recommended !== undefined ? { recommended: q.recommended } : {}),
			}));

			// Rich dialog path (omp ExtensionUIContext.askDialog → pi ui.custom).
			if (ctx.mode === "tui") {
				let richResult: ExtensionAskDialogResult | undefined;
				try {
					const showRichDialog = () =>
						extensionUi.custom<ExtensionAskDialogResult | undefined>((tui, theme, keybindings, done) => {
							const dialog = new AskDialogComponent(
								theme,
								keybindings,
								richQuestions,
								{
									onSubmit: result => done(result),
									onCancel: () => done(undefined),
								},
								{ timeout: timeout ?? undefined, tui: { requestRender: () => tui.requestRender() } },
							);
							// pi's custom() has no signal option; mirror omp's
							// #presentDialog(signal) by cancelling the component
							// when the agent turn is aborted.
							signal?.addEventListener(
								"abort",
								() => {
									dialog.externalCancel();
								},
								{ once: true },
							);
							return dialog;
						});
					richResult = signal ? await raceWithSignal(signal, showRichDialog) : await showRichDialog();
				} catch (error) {
					if (error instanceof Error && error.name === "AbortError") {
						ctx.abort();
						throw new Error("Ask input was cancelled");
					}
					throw error;
				}

				if (!richResult) {
					// omp: cancel aborts the turn (ToolAbortError).
					ctx.abort();
					throw new Error("Ask tool was cancelled by the user");
				}
				if (richResult.kind === "chat") {
					const questionText = params.questions.map(q => q.question).join("\n");
					return {
						content: [
							{
								type: "text" as const,
								text: `User chose to chat about this instead of answering.\n\nQuestions asked:\n${questionText}`,
							},
						],
						details: { chatRedirect: true, questions: params.questions.map(q => q.question) },
					};
				}
				if (richResult.results.length !== params.questions.length) {
					throw new Error("Ask dialog returned a result count that does not match the requested questions");
				}
				const results: QuestionResult[] = [];
				for (let index = 0; index < params.questions.length; index++) {
					const question = params.questions[index];
					const result = richResult.results[index];
					if (!question || !result || result.id !== question.id) {
						throw new Error("Ask dialog returned results that do not match the requested question order");
					}
					results.push({
						id: question.id,
						question: question.question,
						options: question.options.map(option => option.label),
						multi: question.multi ?? false,
						selectedOptions: result.selectedOptions,
						customInput: result.customInput,
						note: result.note,
						timedOut: result.timedOut,
					});
				}
				if (params.questions.length === 1) {
					const result = results[0];
					// An empty multi-select submission is a valid "select none"
					// answer (#8265 review); only a truly empty single-select
					// result counts as cancellation.
					if (
						!result ||
						(!result.timedOut &&
							!result.multi &&
							result.selectedOptions.length === 0 &&
							result.customInput === undefined)
					) {
						ctx.abort();
						throw new Error("Ask tool was cancelled by the user");
					}
					const details: AskToolDetails = {
						question: result.question,
						options: result.options,
						multi: result.multi,
						selectedOptions: result.selectedOptions,
						customInput: result.customInput,
						note: result.note,
						timedOut: result.timedOut,
					};
					const responseText = formatSingleQuestionResponse(result);
					return { content: [{ type: "text" as const, text: responseText }], details };
				}
				const details: AskToolDetails = { results };
				const responseText = `User answers:\n${results.map(formatQuestionResult).join("\n")}`;
				return { content: [{ type: "text" as const, text: responseText }], details };
			}

			// Legacy per-question path (omp ask.ts, verbatim flow).
			const askQuestion = async (
				q: AskParams["questions"][number],
				options?: { previous?: QuestionResult; navigation?: NavigationControls },
			) => {
				const questionOptions: AskOption[] = q.options.map(option => ({
					label: option.label,
					...(option.description?.trim() ? { description: option.description.trim() } : {}),
				}));
				const optionLabels = questionOptions.map(option => option.label);
				try {
					const { selectedOptions, customInput, note, navigation, cancelled, timedOut } = await askSingleQuestion(
						ui,
						q.question,
						questionOptions,
						q.multi ?? false,
						{
							recommended: q.recommended,
							timeout: timeout ?? undefined,
							signal,
							initialSelection: options?.previous,
							navigation: options?.navigation,
						},
					);
					return { optionLabels, selectedOptions, customInput, note, navigation, cancelled, timedOut };
				} catch (error) {
					if (error instanceof Error && error.name === "AbortError") {
						throw new Error("Ask input was cancelled");
					}
					throw error;
				}
			};

			if (params.questions.length === 1) {
				const [q] = params.questions;
				const { optionLabels, selectedOptions, customInput, note, cancelled, timedOut } = await askQuestion(q);

				if (!timedOut && (cancelled || (selectedOptions.length === 0 && customInput === undefined))) {
					ctx.abort();
					throw new Error("Ask tool was cancelled by the user");
				}
				const details: AskToolDetails = {
					question: q.question,
					options: optionLabels,
					multi: q.multi ?? false,
					selectedOptions,
					customInput,
					note,
					timedOut: timedOut || undefined,
				};

				const responseText = formatSingleQuestionResponse({
					selectedOptions,
					customInput,
					note,
					timedOut: timedOut || undefined,
					multi: q.multi ?? false,
				});

				return { content: [{ type: "text" as const, text: responseText }], details };
			}

			const resultsByIndex: Array<QuestionResult | undefined> = Array.from({ length: params.questions.length });
			let questionIndex = 0;
			while (questionIndex < params.questions.length) {
				const q = params.questions[questionIndex];
				if (!q) throw new Error("Ask question index exceeded the requested question list");
				const previous = resultsByIndex[questionIndex];
				const navigation: NavigationControls = {
					allowBack: questionIndex > 0,
					allowForward: true,
					progressText: `${questionIndex + 1}/${params.questions.length}`,
				};
				const {
					optionLabels,
					selectedOptions,
					customInput,
					note,
					navigation: navAction,
					cancelled,
					timedOut,
				} = await askQuestion(q, { previous, navigation });

				if (cancelled && !timedOut) {
					ctx.abort();
					throw new Error("Ask tool was cancelled by the user");
				}

				resultsByIndex[questionIndex] = {
					id: q.id,
					question: q.question,
					options: optionLabels,
					multi: q.multi ?? false,
					selectedOptions,
					customInput,
					note,
					timedOut: timedOut || undefined,
				};

				if (navAction === "back") {
					questionIndex = Math.max(0, questionIndex - 1);
					continue;
				}

				questionIndex += 1;
			}

			const results = params.questions.map((q, index) => {
				const result = resultsByIndex[index];
				if (result) return result;
				return {
					id: q.id,
					question: q.question,
					options: q.options.map(o => o.label),
					multi: q.multi ?? false,
					selectedOptions: [],
				};
			});

			const details: AskToolDetails = { results };
			const responseLines = results.map(formatQuestionResult);
			const responseText = `User answers:\n${responseLines.join("\n")}`;

			return { content: [{ type: "text" as const, text: responseText }], details };
		},

		renderCall(args: { questions?: unknown }, theme) {
			// omp updates the framed question block in place once the user
			// answers; pi's ToolExecutionComponent appends the result render
			// below the call render, so a full question block here would leave
			// the transcript with every question shown twice. Render only a
			// tense-neutral summary line (it also appears in HTML export above
			// the result block); the merged question/options/answer block
			// renders once from renderResult after the dialog settles.
			const count = Array.isArray(args.questions) ? args.questions.length : 0;
			const summary = count > 0 ? `Ask · ${count} ${count === 1 ? "question" : "questions"}` : "Ask";
			return new Text(theme.fg("dim", summary), 0, 0);
		},

		renderResult(result, _options, theme) {
			const mdTheme = getMarkdownTheme();
			const md = (text: string, width: number): readonly string[] =>
				new Markdown(text, 1, 0, mdTheme, { color: t => theme.fg("accent", t) }).render(Math.max(1, width));
			const details = result.details as AskToolDetails | undefined;

			if (!details) {
				const txt = result.content[0];
				const fallback = txt?.type === "text" && txt.text ? txt.text : "";
				return new Text(`${theme.fg("warning", "~ Ask")}${fallback ? `\n${theme.fg("dim", fallback)}` : ""}`, 0, 0);
			}

			// Chat redirect: user chose "Chat about this" instead of answering.
			if (details.chatRedirect) {
				const questions = details.questions ?? [];
				return new FramedComponent(theme, theme.fg("muted", "Ask · chat redirect"), [
					{ linesFor: width => questions.flatMap(q => [...md(q, width), ""]) },
				]);
			}

			// Multi-part results: one divider-labelled section per question.
			if (details.results && details.results.length > 0) {
				const results = details.results;
				const hasAnySelection = results.some(
					r =>
						r.customInput !== undefined ||
						r.note !== undefined ||
						(r.selectedOptions && r.selectedOptions.length > 0),
				);
				const title = `${hasAnySelection ? theme.fg("success", "+") : theme.fg("warning", "~")} Ask ${theme.fg("muted", `${results.length} questions`)}`;
				return new FramedComponent(
					theme,
					title,
					results.map(r => ({
						label: theme.fg("dim", `[${r.id}]`),
						linesFor: width => [
							...md(r.question, width),
							...renderAnswerOptionLines(
								theme,
								r.options,
								r.selectedOptions,
								r.multi,
								r.customInput,
								r.note,
								width,
							),
						],
					})),
				);
			}

			// Single question result
			if (!details.question) {
				const txt = result.content[0];
				const fallback = txt?.type === "text" && txt.text ? txt.text : "";
				return new Text(fallback, 0, 0);
			}

			const hasSelection =
				details.customInput !== undefined ||
				details.note !== undefined ||
				(details.selectedOptions && details.selectedOptions.length > 0);
			const title = `${hasSelection ? theme.fg("success", "+") : theme.fg("warning", "~")} Ask`;
			return new FramedComponent(theme, title, [
				{
					linesFor: width => {
						const lines = [
							...md(details.question!, width),
							...renderAnswerOptionLines(
								theme,
								details.options,
								details.selectedOptions,
								details.multi,
								details.customInput,
								details.note,
								width,
							),
						];
						if (details.timedOut) {
							// Distinguish auto-selection from a real user choice in the transcript.
							lines.push(theme.fg("dim", "auto-selected after timeout — not a user choice"));
						}
						return lines;
					},
				},
			]);
		},
	});

	// print/json hosts cannot prompt: hide the tool instead of letting the LLM
	// discover the error at call time (omp's createIf gate, extension edition).
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) {
			const active = pi.getActiveTools();
			if (active.includes("ask")) {
				pi.setActiveTools(active.filter((name) => name !== "ask"));
			}
		}
	});
}

/** Resolve `undefined` when the signal aborts before the dialog settles;
 *  rejections propagate untouched (omp untilAborted semantics). */
function raceWithSignal<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T | undefined> {
	if (signal.aborted) return Promise.resolve(undefined);
	return new Promise<T | undefined>((resolve, reject) => {
		let settled = false;
		const onAbort = (): void => {
			if (settled) return;
			settled = true;
			resolve(undefined);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		run().then(
			value => {
				if (settled) return;
				settled = true;
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			error => {
				if (settled) return;
				settled = true;
				signal.removeEventListener("abort", onAbort);
				// Propagate like omp's untilAborted: real host failures must not
				// surface as a phantom "user cancelled" outcome.
				reject(error);
			},
		);
	});
}
