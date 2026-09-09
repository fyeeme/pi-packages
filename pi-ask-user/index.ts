/**
 * pi-ask-user — the oh-my-pi `ask` tool migrated to a pi extension
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
 * blocks, `User answers:` for multi-question, and
 * `(auto-selected after timeout)` markers; answers persist in `details`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
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
import { replaceTabs } from "./src/compat.ts";
import type {
	AskToolDetails,
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResult,
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
				"(not while typing an Other answer, and not on hosts limited to plain sequential " +
				"dialogs). On expiry unanswered questions auto-pick the recommended option " +
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
	if (result.customInput !== undefined) {
		return `${result.id}: "${result.customInput}"`;
	}
	if (result.selectedOptions.length > 0) {
		const suffix = result.timedOut ? " (auto-selected after timeout)" : "";
		return result.multi
			? `${result.id}: [${result.selectedOptions.join(", ")}]${suffix}`
			: `${result.id}: ${result.selectedOptions[0]}${suffix}`;
	}
	return result.multi ? `${result.id}: []` : `${result.id}: (cancelled)`;
}

function formatSingleQuestionResponse(result: {
	selectedOptions: string[];
	customInput?: string;
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
	if (responseParts.length > 0) return responseParts.join("\n");
	return result.multi ? "User did not select any options" : "User cancelled the selection";
}

// ---------------------------------------------------------------------------
// Transcript rendering
// ---------------------------------------------------------------------------

/** Flatten a question/custom input into one plain-text line for the compact
 *  result row. The dialog already showed the full options list; the transcript
 *  only needs the asked question and the given answer. */
function flattenToOneLine(text: string): string {
	return replaceTabs(text).replace(/\s+/g, " ").trim();
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
			// the bell stays configurable via PI_OMK_ASK_NOTIFY=0. Terminal-direct:
			// TUI only — RPC stdout is the JSON protocol channel (Mode Behavior).
			if (ctx.mode === "tui" && process.env.PI_OMK_ASK_NOTIFY !== "0") process.stdout.write("\x07");

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
					const { selectedOptions, customInput, navigation, cancelled, timedOut } = await askSingleQuestion(
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
					return { optionLabels, selectedOptions, customInput, navigation, cancelled, timedOut };
				} catch (error) {
					if (error instanceof Error && error.name === "AbortError") {
						throw new Error("Ask input was cancelled");
					}
					throw error;
				}
			};

			if (params.questions.length === 1) {
				const [q] = params.questions;
				const { optionLabels, selectedOptions, customInput, cancelled, timedOut } = await askQuestion(q);

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
					timedOut: timedOut || undefined,
				};

				const responseText = formatSingleQuestionResponse({
					selectedOptions,
					customInput,
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
			const details = result.details as AskToolDetails | undefined;

			if (!details) {
				const txt = result.content[0];
				const fallback = txt?.type === "text" && txt.text ? txt.text : "";
				return new Text(`${theme.fg("warning", "~ Ask")}${fallback ? `\n${theme.fg("dim", fallback)}` : ""}`, 0, 0);
			}

			// One compact line per question: the asked question and the given
			// answer. The dialog already showed the full options list, so the
			// transcript does not re-list unselected options.
			const answerLine = (
				label: string,
				selectedOptions: string[] | undefined,
				customInput: string | undefined,
				timedOut: boolean | undefined,
			): string => {
				const parts: string[] = [];
				if (selectedOptions && selectedOptions.length > 0) parts.push(selectedOptions.join(", "));
				if (customInput !== undefined) parts.push(`“${flattenToOneLine(customInput)}”`);
				const answer =
					parts.length > 0
						? theme.fg("toolOutput", parts.join(" · "))
						: theme.fg("warning", "(no answer)");
				// Distinguish auto-selection from a real user choice.
				const timeoutMark = timedOut ? theme.fg("dim", " · auto-selected after timeout") : "";
				return `${theme.fg("muted", label)}${theme.fg("dim", " → ")}${answer}${timeoutMark}`;
			};

			if (details.results && details.results.length > 0) {
				const lines = details.results.map(r =>
					answerLine(`[${r.id}] ${flattenToOneLine(r.question)}`, r.selectedOptions, r.customInput, r.timedOut),
				);
				return new Text(lines.join("\n"), 0, 0);
			}

			if (!details.question) {
				const txt = result.content[0];
				const fallback = txt?.type === "text" && txt.text ? txt.text : "";
				return new Text(fallback, 0, 0);
			}

			return new Text(
				answerLine(flattenToOneLine(details.question), details.selectedOptions, details.customInput, details.timedOut),
				0,
				0,
			);
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
