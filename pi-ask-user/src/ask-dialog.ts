/**
 * AskDialogComponent — migrated from oh-my-pi
 * (packages/coding-agent/src/modes/components/ask-dialog.ts).
 *
 * The multi-question tabbed ask dialog: one tab per question (plus a Submit
 * review tab for 3+ questions or any multi question), radio/checkbox markers,
 * markdown/code option previews, an inactivity countdown that auto-picks
 * recommended options, and an embedded single-line prompt for "Other" answers.
 *
 * Adaptations for pi's extension API (everything else is omp code):
 * - omp's global `theme` singleton and `getMarkdownTheme()` become a pi Theme
 *   instance injected via the constructor plus `markdownThemeFrom()`.
 * - omp's symbol table (theme.radio/checkbox/nav/boxRound) becomes SYMBOLS.
 * - omp's TabBar component becomes a self-drawn tab chip row (pi-tui has no
 *   TabBar), visually aligned with omp's chips.
 * - omp's ScrollView string window becomes windowLines + clipIndicator (pi's
 *   ScrollView is a layout container, not a string[] window).
 * - omp's global keybinding matchers (matchesSelectUp/…) and editorKey labels
 *   resolve through the KeybindingsManager pi injects into ui.custom().
 * - omp's nested HookEditorComponent prompts (onPrompt callback swapping the
 *   editor container) become an embedded prompt mode inside this component:
 *   pi extensions own a single custom component slot and cannot mount a
 *   second focused component, so the dialog itself renders the input row and
 *   handles its keystrokes while #promptActive.
 * - The inputGuard (draft editor proxy) is dropped: pi extensions cannot
 *   access the draft editor.
 */

import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, highlightCode } from "@earendil-works/pi-coding-agent";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { Markdown } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, Input } from "@earendil-works/pi-tui";
import {
	clamp,
	ELLIPSIS,
	keyLabel,
	replaceTabs,
	renderInlineMarkdown,
	SYMBOLS,
	windowLines,
	clipIndicator,
} from "./compat.ts";
import { CountdownTimer, type TuiRenderHandle } from "./countdown-timer.ts";
import { bottomBorder, divider, fit, row, topBorder } from "./overlay-box.ts";import type {
	ExtensionAskDialogOption,
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResultItem,
	ExtensionAskDialogSubmitResult,
} from "./types.ts";

const OTHER_OPTION = "Other (type your own)";
const SUBMIT_OPTION = "Submit";

/** Fraction of the terminal the dialog may occupy. The box height is fixed
 *  at spawn from the tallest tab's content (re-measured only on viewport
 *  resize) and clamped to this ratio; it rises from the bottom as a stable
 *  panel that never resizes on tab switches or cursor moves. */
const DIALOG_HEIGHT_RATIO = 0.7;
const MIN_DIALOG_ROWS = 12;
const MIN_BODY_ROWS = 5;
const MAX_HEADER_CHIP_WIDTH = 16;
/** Maximum number of wrapped lines for an in-body question header, so a long
 *  or multi-line question cannot push the option list off-screen. */
const MAX_HEADER_ROWS = 4;
/** Maximum rows of the embedded prompt view (title + input + hint) rendered
 *  inside the dialog frame while the user types an Other answer. */
const MAX_PROMPT_TITLE_ROWS = 3;

/** Minimum inner width for the side-by-side option/preview split. */
const SPLIT_MIN_WIDTH = 80;

interface AskDialogCallbacks {
	onSubmit(result: ExtensionAskDialogSubmitResult): void;
	onCancel(): void;
}

interface AskDialogOptions {
	timeout?: number;
	onTimeout?: () => void;
	tui?: TuiRenderHandle;
}

interface QuestionState {
	selectedOptions: Set<string>;
	customInput: string | undefined;
	cursorIndex: number;
	scrollOffset: number;
	manualScroll: boolean;
	timedOut: boolean;
}

type QuestionRowKind = "option" | "other";

interface QuestionRow {
	kind: QuestionRowKind;
	key: string;
	label: string;
	optionIndex: number | undefined;
}

interface RenderedList {
	lines: string[];
	scrollOffset: number;
	indicator: string;
}

interface PreviewSegment {
	kind: "markdown" | "code";
	text: string;
	language: string | undefined;
}

type PreviewRenderCache = Map<string, Map<number, readonly string[]>>;

/** Embedded prompt state (replaces omp's nested HookEditorComponent):
 *  a pi-tui Input instance owns the input line — cursor marker (IME
 *  positioning), horizontal scroll, grapheme edits, paste, undo — while the
 *  dialog keeps the question/state snapshot. */
interface EmbeddedPrompt {
	title: string;
	input: Input;
	prefill: string | undefined;
	/** State snapshot of the question the prompt belongs to. */
	question: ExtensionAskDialogQuestion;
	state: QuestionState;
}

function stripRecommendedSuffix(label: string): string {
	const suffix = " (Recommended)";
	return label.endsWith(suffix) ? label.slice(0, -suffix.length) : label;
}

function questionTabLabel(question: ExtensionAskDialogQuestion, index: number): string {
	const base = question.header?.trim() || question.id || `Q${index + 1}`;
	return truncateToWidth(replaceTabs(base), MAX_HEADER_CHIP_WIDTH, ELLIPSIS);
}

function renderQuestionTitle(theme: Theme, question: ExtensionAskDialogQuestion, width: number): string[] {
	const questionText = renderInlineMarkdown(replaceTabs(question.question), t => theme.fg("text", t));
	const wrapped = wrapTextWithAnsi(questionText, Math.max(1, width));
	if (wrapped.length <= MAX_HEADER_ROWS) return wrapped;
	return [
		...wrapped.slice(0, MAX_HEADER_ROWS - 1),
		truncateToWidth(wrapped.slice(MAX_HEADER_ROWS - 1).join(" "), Math.max(1, width), ELLIPSIS),
	];
}

function splitPreviewSegments(preview: string): PreviewSegment[] {
	const segments: PreviewSegment[] = [];
	const markdownBuffer: string[] = [];
	let fenceChar: string | undefined;
	let fenceLength = 0;
	let fenceLanguage: string | undefined;
	let codeBuffer: string[] = [];

	const flushMarkdown = (): void => {
		if (markdownBuffer.length === 0) return;
		segments.push({ kind: "markdown", text: markdownBuffer.join("\n"), language: undefined });
		markdownBuffer.length = 0;
	};
	const flushCode = (): void => {
		segments.push({ kind: "code", text: codeBuffer.join("\n"), language: fenceLanguage });
		codeBuffer = [];
		fenceChar = undefined;
		fenceLength = 0;
		fenceLanguage = undefined;
	};

	for (const line of replaceTabs(preview).split("\n")) {
		const fenceMatch = /^(\s{0,3})(`{3,}|~{3,})(.*)$/.exec(line);
		if (fenceChar !== undefined) {
			if (fenceMatch) {
				const marker = fenceMatch[2] ?? "";
				const info = fenceMatch[3]?.trim() ?? "";
				if (marker.startsWith(fenceChar) && marker.length >= fenceLength && info === "") {
					flushCode();
					continue;
				}
			}
			codeBuffer.push(line);
			continue;
		}
		if (fenceMatch) {
			flushMarkdown();
			const marker = fenceMatch[2] ?? "";
			fenceChar = marker[0];
			fenceLength = marker.length;
			fenceLanguage = fenceMatch[3]?.trim().split(/\s+/, 1)[0] || undefined;
			codeBuffer = [];
			continue;
		}
		markdownBuffer.push(line);
	}

	if (fenceChar !== undefined) {
		segments.push({ kind: "code", text: codeBuffer.join("\n"), language: fenceLanguage });
	} else {
		flushMarkdown();
	}
	return segments;
}

function renderPreviewContent(theme: Theme, preview: string, width: number): string[] {
	const out: string[] = [];
	const mdTheme: MarkdownTheme = getMarkdownTheme();
	const accentStyle = { color: (text: string) => theme.fg("muted", text) };
	for (const segment of splitPreviewSegments(preview)) {
		if (segment.kind === "code") {
			// pi's highlightCode returns ANSI-styled lines (same signature as
			// omp's); overflow is clipped by the surrounding row() fit().
			out.push(...highlightCode(segment.text, segment.language));
			continue;
		}
		const markdown = new Markdown(segment.text, 0, 0, mdTheme, accentStyle);
		out.push(...markdown.render(Math.max(1, width)));
	}
	return out;
}

/** Cached preview render at a given width. Returns raw lines; callers add
 *  their own gutter (inline mode indents under the option, split mode draws
 *  the right pane). */
function renderCachedPreview(theme: Theme, cache: PreviewRenderCache, preview: string, width: number): readonly string[] {
	let byWidth = cache.get(preview);
	if (!byWidth) {
		byWidth = new Map();
		cache.set(preview, byWidth);
	}
	let rendered = byWidth.get(width);
	if (!rendered) {
		rendered = renderPreviewContent(theme, preview, width);
		byWidth.set(width, rendered);
	}
	return rendered;
}

function normalizedInlineInput(input: string): string {
	return replaceTabs(input).replace(/\s+/g, " ").trim();
}

function renderAnswerSummary(theme: Theme, question: ExtensionAskDialogQuestion, state: QuestionState): string {
	const selected = question.options.map(option => option.label).filter(label => state.selectedOptions.has(label));
	if (question.multi) {
		const answers = [...selected];
		if (state.customInput !== undefined) answers.push(`Other: “${normalizedInlineInput(state.customInput)}”`);
		return answers.length > 0 ? answers.join(", ") : theme.fg("warning", "unanswered");
	}
	if (state.customInput !== undefined) return `“${normalizedInlineInput(state.customInput)}”`;
	if (selected.length === 0) return theme.fg("warning", "unanswered");
	return selected[0] ?? theme.fg("warning", "unanswered");
}

function optionMarker(theme: Theme, question: ExtensionAskDialogQuestion, checked: boolean): string {
	if (question.multi) return checked ? SYMBOLS.checkbox.checked : SYMBOLS.checkbox.unchecked;
	return checked ? SYMBOLS.radio.selected : SYMBOLS.radio.unselected;
}

function renderRowLabel(
	theme: Theme,
	rowItem: QuestionRow,
	question: ExtensionAskDialogQuestion,
	state: QuestionState,
	selected: boolean,
	previewCache: PreviewRenderCache,
	width: number,
	showInlinePreview: boolean,
): string[] {
	const isOption = rowItem.kind === "option";
	const isOther = rowItem.kind === "other";
	const checked = isOption
		? state.selectedOptions.has(stripRecommendedSuffix(rowItem.label))
		: isOther && state.customInput !== undefined;
	const color = selected ? "accent" : checked ? "toolOutput" : "text";
	const marker = `${theme.fg(checked ? "success" : "dim", optionMarker(theme, question, checked))} `;
	const cursor = selected ? theme.fg("accent", `${SYMBOLS.nav.cursor} `) : "  ";
	const label = renderInlineMarkdown(rowItem.label, t => theme.fg(color, t));
	const labelWidth = Math.max(1, width - visibleWidth(cursor) - visibleWidth(marker));
	const wrappedLabel = wrapTextWithAnsi(label, labelWidth);
	const indent = " ".repeat(visibleWidth(cursor) + visibleWidth(marker));
	const lines = [`${cursor}${marker}${wrappedLabel[0] ?? ""}`];
	for (let i = 1; i < wrappedLabel.length; i++) {
		lines.push(`${indent}${wrappedLabel[i] ?? ""}`);
	}
	if (rowItem.kind === "option") {
		const option = question.options[rowItem.optionIndex ?? -1];
		if (option?.description?.trim()) {
			const description = renderInlineMarkdown(option.description.trim(), t => theme.fg("muted", t));
			const wrapped = wrapTextWithAnsi(description, Math.max(1, width - 6));
			for (const line of wrapped.slice(0, 2)) {
				lines.push(`      ${truncateToWidth(line, Math.max(1, width - 6), ELLIPSIS)}`);
			}
		}
		if (option?.preview?.trim() && showInlinePreview) {
			const previewWidth = Math.max(1, width - 8);
			lines.push(
				...renderCachedPreview(theme, previewCache, option.preview, previewWidth).map(
				line => `      ${theme.fg("borderMuted", "│")} ${line}`,
			),
			);
		}
	}
	if (isOther && state.customInput !== undefined) {
		const preview = replaceTabs(state.customInput).replace(/\s+/g, " ").trim();
		lines.push(theme.fg("muted", `      ${truncateToWidth(preview, Math.max(1, width - 6), ELLIPSIS)}`));
	}
	return lines;
}

/**
 * Coerce untrusted dialog questions into a render-safe shape. The live ask
 * dialog is reached from streamed tool args, where a question entry can arrive
 * with a missing or non-string `question` field. The render helpers assume
 * strings, so a malformed entry would throw and take down the whole TUI render
 * loop — normalize first. (omp ask-dialog.ts)
 */
function normalizeDialogQuestions(questions: ExtensionAskDialogQuestion[]): ExtensionAskDialogQuestion[] {
	if (!Array.isArray(questions)) return [];
	const out: ExtensionAskDialogQuestion[] = [];
	for (const entry of questions) {
		if (!entry || typeof entry !== "object") continue;
		const q = entry as Partial<ExtensionAskDialogQuestion>;
		const options: ExtensionAskDialogOption[] = [];
		if (Array.isArray(q.options)) {
			for (const opt of q.options) {
				if (!opt || typeof opt !== "object") continue;
				const o = opt as Partial<ExtensionAskDialogOption>;
				options.push({
					label: typeof o.label === "string" ? o.label : "",
					...(typeof o.description === "string" ? { description: o.description } : {}),
					...(typeof o.preview === "string" ? { preview: o.preview } : {}),
				});
			}
		}
		out.push({
			id: typeof q.id === "string" ? q.id : "?",
			question: typeof q.question === "string" ? q.question : "",
			...(typeof q.header === "string" ? { header: q.header } : {}),
			options,
			...(typeof q.multi === "boolean" ? { multi: q.multi } : {}),
			...(Number.isInteger(q.recommended) ? { recommended: q.recommended } : {}),
		});
	}
	return out;
}

/** Bound a prompt title to a fixed row budget (omp boundPromptTitle). */
function boundPromptTitle(theme: Theme, prefix: string, question: string): string[] {
	const cols = process.stdout.columns ?? 80;
	const width = Math.max(1, cols - 4);
	const flat = `${prefix}${normalizedInlineInput(question)}`;
	const wrapped = wrapTextWithAnsi(theme.fg("text", flat), width);
	if (wrapped.length <= MAX_PROMPT_TITLE_ROWS) return wrapped;
	const kept = wrapped.slice(0, MAX_PROMPT_TITLE_ROWS - 1);
	const last = truncateToWidth(wrapped[MAX_PROMPT_TITLE_ROWS - 1] ?? "", width, ELLIPSIS);
	return [...kept, last];
}

export class AskDialogComponent {
	/** Focusable (IME support, pi-tui contract): the TUI sets `focused` when
	 *  this component gains keyboard focus. While the embedded prompt is
	 *  open, focus propagates to its pi-tui Input so CURSOR_MARKER (and with
	 *  it the hardware cursor / IME candidate window) tracks the input point;
	 *  outside the prompt the dialog renders no marker and keeps the cursor
	 *  hidden. */
	#focused = false;
	get focused(): boolean {
		return this.#focused;
	}
	set focused(value: boolean) {
		this.#focused = value;
		if (this.#embeddedPrompt) this.#embeddedPrompt.input.focused = value;
	}

	#states: QuestionState[];
	#activeTabIndex = 0;
	#submitScrollOffset = 0;
	#bodyRows = MIN_BODY_ROWS;
	#questionCanPage = false;
	#remainingSeconds: number | undefined;
	#countdown: CountdownTimer | undefined;
	#promptActive = false;
	#embeddedPrompt: EmbeddedPrompt | undefined;
	#timeoutExpired = false;
	#closed = false;
	#stableHeight: { key: string; total: number } | undefined;
	#previewCache: PreviewRenderCache = new Map();
	readonly #questions: ExtensionAskDialogQuestion[];
	readonly #theme: Theme;
	readonly #keybindings: KeybindingsManager;
	readonly #callbacks: AskDialogCallbacks;
	readonly #options: AskDialogOptions;

	constructor(
		theme: Theme,
		keybindings: KeybindingsManager,
		questions: ExtensionAskDialogQuestion[],
		callbacks: AskDialogCallbacks,
		options: AskDialogOptions = {},
	) {
		this.#theme = theme;
		this.#keybindings = keybindings;
		this.#callbacks = callbacks;
		this.#options = options;
		this.#questions = normalizeDialogQuestions(questions);
		this.#states = this.#questions.map(question => {
			const recommended = Number.isInteger(question.recommended) ? question.recommended : 0;
			const maxIndex = Math.max(0, question.options.length - 1);
			return {
				selectedOptions: new Set<string>(),
				customInput: undefined,
				cursorIndex: clamp(recommended ?? 0, 0, maxIndex),
				scrollOffset: 0,
				manualScroll: false,
				timedOut: false,
			};
		});
		if (options.timeout && options.timeout > 0) {
			this.#countdown = new CountdownTimer(
				options.timeout,
				options.tui,
				seconds => {
					this.#remainingSeconds = seconds;
				},
				() => this.#handleTimeout(),
			);
		}
	}

	invalidate(): void {
		this.#stableHeight = undefined;
		this.#previewCache.clear();
	}

	dispose(): void {
		this.#closed = true;
		this.#countdown?.dispose();
	}

	handleInput(keyData: string): void {
		if (this.#closed) return;
		if (this.#promptActive) {
			this.#handleEmbeddedPromptInput(keyData);
			return;
		}
		// Reset the inactivity countdown on any key that reaches past the
		// closed/prompt guards, matching HookSelector/HookInput semantics.
		this.#countdown?.reset();
		if (this.#keybindings.matches(keyData, "tui.select.cancel")) {
			this.#finishCancel();
			return;
		}
		if (this.#hasTabBar() && this.#handleTabSwitchKey(keyData)) {
			this.#requestRender();
			return;
		}
		if (this.#isSubmitTab()) {
			this.#handleSubmitTabInput(keyData);
			return;
		}
		this.#handleQuestionInput(keyData);
	}

	render(width: number): string[] {
		const theme = this.#theme;
		const innerWidth = Math.max(1, width - 4);
		// Fixed panel height: measured from the tallest tab at spawn and
		// re-measured only when the viewport changes. Tab switches, cursor
		// moves, and later answers never resize the box; content that
		// outgrows it scrolls.
		const totalRows = this.#dialogHeight(innerWidth, process.stdout.rows || 40);
		const headerLines = this.#renderHeader(innerWidth);
		const fixedRows = 1 + headerLines.length + 1 + 1 + 1 + 1;
		const bodyRows = Math.max(MIN_BODY_ROWS, totalRows - fixedRows);
		this.#bodyRows = bodyRows;
		const bodyLines = this.#promptActive
			? this.#renderEmbeddedPromptBody(innerWidth, bodyRows)
			: this.#isSubmitTab()
				? this.#renderSubmitBody(innerWidth, bodyRows)
				: this.#renderQuestionBody(innerWidth, bodyRows);
		const footer = this.#footerHintText(bodyLines.indicator);
		return [
			topBorder(theme, width, this.#promptActive ? "Ask — input" : this.#titleText()),
			...headerLines.map(line => row(theme, line, width)),
			divider(theme, width),
			...bodyLines.lines.map(line => row(theme, line, width)),
			divider(theme, width),
			row(theme, theme.fg("dim", footer), width),
			bottomBorder(theme, width),
		];
	}

	#dialogHeight(width: number, termRows: number): number {
		const key = `${width}:${termRows}`;
		if (this.#stableHeight?.key === key) return this.#stableHeight.total;
		const total = this.#measureHeight(width, termRows);
		this.#stableHeight = { key, total };
		return total;
	}

	/** Measure the tallest tab's natural content height, clamped to
	 *  DIALOG_HEIGHT_RATIO of the terminal. Derived from questions and
	 *  viewport only — never from cursor, tab, or answer state — so the box
	 *  size is stable for the dialog's lifetime at a given terminal size. */
	#measureHeight(width: number, termRows: number): number {
		const maxHeight = Math.max(MIN_DIALOG_ROWS, Math.floor(termRows * DIALOG_HEIGHT_RATIO));
		const chrome = 5; // topBorder + divider + divider + footer + bottomBorder
		const tabBarRows = this.#hasTabBar() ? 1 : 0;
		let needed = MIN_DIALOG_ROWS;
		for (let index = 0; index < this.#questions.length; index++) {
			const question = this.#questions[index];
			const state = this.#states[index];
			if (!question || !state) continue;
			const headerRows = tabBarRows + renderQuestionTitle(this.#theme, question, width).length;
			const rowItems = this.#questionRows(question);
			let body = 0;
			const split = this.#useSplitLayout(question, width);
			const { leftWidth, rightWidth } = this.#splitWidths(width);
			for (const rowItem of rowItems) {
				body += renderRowLabel(
					this.#theme,
					rowItem,
					question,
					state,
					false,
					this.#previewCache,
					split ? leftWidth : width,
					!split,
				).length;
			}
			if (split) {
				// The right pane must fit the tallest preview at its width.
				let previewRows = 0;
				for (const option of question.options) {
					if (option.preview?.trim()) {
						previewRows = Math.max(
							previewRows,
							renderCachedPreview(this.#theme, this.#previewCache, option.preview, rightWidth).length,
						);
					}
				}
				body = Math.max(body, previewRows);
			}
			needed = Math.max(needed, chrome + headerRows + Math.max(MIN_BODY_ROWS, body));
		}
		if (this.#hasSubmitTab()) {
			const body = 2 + this.#questions.length + 2;
			needed = Math.max(needed, chrome + tabBarRows + 1 + Math.max(MIN_BODY_ROWS, body));
		}
		return Math.min(needed, maxHeight);
	}

	#titleText(): string {
		return this.#remainingSeconds === undefined ? "Ask" : `Ask (${this.#remainingSeconds}s)`;
	}

	#hasTabBar(): boolean {
		// Multi-question dialogs always get a tab bar for ←/→ navigation, even
		// when there is no Submit review tab to switch to; a Submit tab alone
		// (single multi question) also needs its chip row.
		return this.#questions.length > 1 || this.#hasSubmitTab();
	}

	#hasSubmitTab(): boolean {
		// The Submit review tab appears for 3+ questions or any multi question.
		// Multi questions confirm on the Submit tab (Enter toggles, never
		// submits), so any multi question forces the tab even when there is
		// only one question. Fewer than three single-select questions advance
		// Enter-to-submit without a review page.
		return this.#questions.length >= 3 || this.#questions.some(question => question.multi);
	}

	#submitTabIndex(): number {
		return this.#questions.length;
	}

	#isSubmitTab(): boolean {
		return this.#hasSubmitTab() && this.#activeTabIndex === this.#submitTabIndex();
	}

	#currentQuestionIndex(): number {
		return clamp(this.#activeTabIndex, 0, Math.max(0, this.#questions.length - 1));
	}

	#requestRender(): void {
		this.#options.tui?.requestRender();
	}

	#renderHeader(width: number): string[] {
		const theme = this.#theme;
		const lines: string[] = [];
		if (this.#hasTabBar()) {
			lines.push(...this.#renderTabBar(width));
		}
		if (this.#isSubmitTab()) {
			lines.push(theme.bold(theme.fg("accent", "Review answers")));
			return lines;
		}
		const questionIndex = this.#currentQuestionIndex();
		const question = this.#questions[questionIndex];
		if (!question) return lines;
		lines.push(...renderQuestionTitle(theme, question, width));
		return lines;
	}

	/** Self-drawn tab chip row standing in for omp's TabBar component. */
	#renderTabBar(width: number): string[] {
		const theme = this.#theme;
		const chips: string[] = [];
		this.#questions.forEach((question, index) => {
			const label = questionTabLabel(question, index);
			const active = index === this.#activeTabIndex;
			const answered = this.#states[index]?.selectedOptions.size || this.#states[index]?.customInput !== undefined;
			const dot = answered ? theme.fg("success", "●") : theme.fg("dim", "○");
			chips.push(active ? theme.fg("accent", `${SYMBOLS.nav.cursor} ${label} `) : `${dot}${theme.fg("muted", ` ${label} `)}`);
		});
		if (this.#hasSubmitTab()) {
			if (this.#isSubmitTab()) {
				chips.push(theme.fg("accent", `${SYMBOLS.nav.cursor} ${SUBMIT_OPTION} `));
			} else {
				chips.push(theme.fg("muted", `  ${SUBMIT_OPTION} `));
			}
		}
		const joined = chips.join("");
		return [truncateToWidth(joined, Math.max(1, width), "")];
	}

	#footerHintText(indicator: string): string {
		const theme = this.#theme;
		const cancelKey = keyLabel(this.#keybindings.getKeys("tui.select.cancel"), "esc");
		const cancel = `${cancelKey} cancel`;
		if (this.#promptActive) {
			return `Enter confirm · Esc back · ${cancel}`;
		}
		if (this.#isSubmitTab()) {
			const scroll = indicator ? ` ${indicator} scroll ·` : "";
			return `Enter submit · ↑/↓ scroll ·${scroll} ${cancel}`;
		}
		const question = this.#questions[this.#currentQuestionIndex()];
		// Enter advances in multi-question dialogs and submits on the last
		// question when there is no review tab.
		const isLast = this.#currentQuestionIndex() >= this.#questions.length - 1;
		const enterAction = !this.#hasSubmitTab() && isLast ? "submit" : "next";
		const action = question?.multi ? `Space toggle · Enter ${enterAction}` : "Enter select";
		const tabs = this.#hasTabBar() ? " · Tab/←/→" : "";
		if (this.#questionCanPage && indicator) {
			const pageUp = keyLabel(this.#keybindings.getKeys("tui.select.pageUp"), "PgUp");
			const pageDown = keyLabel(this.#keybindings.getKeys("tui.select.pageDown"), "PgDn");
			return `${action} · ↑/↓${tabs} · ${cancel} · ${pageUp}/${pageDown} ${indicator}`;
		}
		const scroll = indicator ? ` ${indicator} scroll ·` : "";
		return `${action} · ↑/↓ move${tabs} ·${scroll} ${cancel}`;
	}

	#questionRows(question: ExtensionAskDialogQuestion): QuestionRow[] {
		const rows: QuestionRow[] = question.options.map((option, index) => ({
			kind: "option",
			key: `option:${index}`,
			label: this.#optionLabel(question, option.label, index),
			optionIndex: index,
		}));
		rows.push({ kind: "other", key: "other", label: OTHER_OPTION, optionIndex: undefined });
		return rows;
	}

	#optionLabel(question: ExtensionAskDialogQuestion, label: string, index: number): string {
		return question.recommended === index ? `${label} (Recommended)` : label;
	}

	#activeQuestionState(): { question: ExtensionAskDialogQuestion; state: QuestionState } | undefined {
		const question = this.#questions[this.#currentQuestionIndex()];
		const state = this.#states[this.#currentQuestionIndex()];
		if (!question || !state) return undefined;
		return { question, state };
	}

	#handleTabSwitchKey(keyData: string): boolean {
		const switchTab = (direction: 1 | -1): void => {
			const tabCount = this.#questions.length + (this.#hasSubmitTab() ? 1 : 0);
			this.#activeTabIndex = (this.#activeTabIndex + direction + tabCount) % tabCount;
			this.#submitScrollOffset = 0;
		};
		if (matchesKey(keyData, Key.tab) || matchesKey(keyData, Key.right)) {
			switchTab(1);
			return true;
		}
		if (matchesKey(keyData, "shift+tab") || matchesKey(keyData, Key.left)) {
			switchTab(-1);
			return true;
		}
		return false;
	}

	#handleQuestionInput(keyData: string): void {
		const active = this.#activeQuestionState();
		if (!active) return;
		const { question, state } = active;
		const rows = this.#questionRows(question);
		if (this.#keybindings.matches(keyData, "tui.select.pageUp")) {
			state.scrollOffset = Math.max(0, state.scrollOffset - Math.max(1, this.#bodyRows - 1));
			state.manualScroll = true;
			this.#requestRender();
			return;
		}
		if (this.#keybindings.matches(keyData, "tui.select.pageDown")) {
			state.scrollOffset += Math.max(1, this.#bodyRows - 1);
			state.manualScroll = true;
			this.#requestRender();
			return;
		}
		if (this.#keybindings.matches(keyData, "tui.select.up")) {
			state.cursorIndex = clamp(state.cursorIndex - 1, 0, Math.max(0, rows.length - 1));
			state.manualScroll = false;
			this.#requestRender();
			return;
		}
		if (this.#keybindings.matches(keyData, "tui.select.down")) {
			state.cursorIndex = clamp(state.cursorIndex + 1, 0, Math.max(0, rows.length - 1));
			state.manualScroll = false;
			this.#requestRender();
			return;
		}
		const rowItem = rows[state.cursorIndex];
		if (!rowItem) return;
		const isEnter = this.#keybindings.matches(keyData, "tui.select.confirm") || keyData === "\n";
		const isSpace = matchesKey(keyData, Key.space) || keyData === " ";
		if (!isEnter && !(question.multi && isSpace)) return;
		if (rowItem.kind === "other") {
			this.#openEmbeddedPrompt(question, state);
			return;
		}
		const option = question.options[rowItem.optionIndex ?? -1];
		if (!option) return;
		if (question.multi) {
			if (isEnter) {
				// Enter confirms the current selection without toggling the
				// focused option; Space toggles. Advances to the next question
				// (submitting only when no review tab remains).
				this.#advanceAfterQuestion();
				return;
			}
			if (state.selectedOptions.has(option.label)) {
				state.selectedOptions.delete(option.label);
			} else {
				state.selectedOptions.add(option.label);
			}
			this.#requestRender();
			return;
		}
		state.selectedOptions = new Set([option.label]);
		state.customInput = undefined;
		this.#advanceAfterQuestion();
	}

	#handleSubmitTabInput(keyData: string): void {
		if (this.#keybindings.matches(keyData, "tui.select.up")) {
			this.#submitScrollOffset = Math.max(0, this.#submitScrollOffset - 1);
			this.#requestRender();
			return;
		}
		if (this.#keybindings.matches(keyData, "tui.select.down")) {
			// Clamped against the rendered line count in #renderSubmitBody.
			this.#submitScrollOffset += 1;
			this.#requestRender();
			return;
		}
		const isEnter = this.#keybindings.matches(keyData, "tui.select.confirm") || keyData === "\n";
		if (isEnter) this.#finishSubmit();
	}

	#advanceAfterQuestion(): void {
		const current = this.#currentQuestionIndex();
		if (this.#hasSubmitTab()) {
			this.#activeTabIndex = current + 1 < this.#submitTabIndex() ? current + 1 : this.#submitTabIndex();
			this.#submitScrollOffset = 0;
			this.#requestRender();
			return;
		}
		if (current + 1 < this.#questions.length) {
			this.#activeTabIndex = current + 1;
			this.#requestRender();
			return;
		}
		this.#finishSubmit();
	}

	// --- embedded prompt (replaces omp's nested HookEditorComponent) --------

	#openEmbeddedPrompt(question: ExtensionAskDialogQuestion, state: QuestionState): void {
		const prefix = "Custom answer: ";
		const prefill = state.customInput;
		const input = new Input();
		if (prefill !== undefined) input.setValue(prefill);
		input.onSubmit = value => this.#submitEmbeddedPrompt(value);
		input.onEscape = () => this.#closeEmbeddedPrompt();
		input.focused = this.#focused;
		this.#promptActive = true;
		this.#embeddedPrompt = {
			title: boundPromptTitle(this.#theme, prefix, question.question).join("\n"),
			input,
			prefill,
			question,
			state,
		};
		this.#requestRender();
	}

	#handleEmbeddedPromptInput(keyData: string): void {
		// The embedded pi-tui Input owns the full input semantics (grapheme
		// edits, paste buffering, kitty CSI-u, undo, kill ring) and emits
		// CURSOR_MARKER at the cursor for IME candidate-window positioning.
		this.#embeddedPrompt?.input.handleInput(keyData);
	}

	#submitEmbeddedPrompt(input: string): void {
		const prompt = this.#embeddedPrompt;
		if (!prompt) return;
		const { question, state } = prompt;
		prompt.input.focused = false;
		this.#promptActive = false;
		this.#embeddedPrompt = undefined;
		// omp ordering (#promptForCustomInput): the input is applied to state
		// first — and Enter may advance/submit — with the deferred timeout only
		// running afterwards, so a countdown that expired mid-prompt sees the
		// just-typed answer instead of discarding it and force-picking.
		try {
			if (input.trim() === "") {
				// Submitting an empty value unselects the custom answer.
				state.customInput = undefined;
				return;
			}
			state.customInput = input;
			if (!question.multi) {
				state.selectedOptions.clear();
				this.#advanceAfterQuestion();
			}
		} finally {
			this.#runDeferredTimeout();
			this.#requestRender();
		}
	}

	#closeEmbeddedPrompt(): void {
		if (this.#embeddedPrompt) this.#embeddedPrompt.input.focused = false;
		this.#promptActive = false;
		this.#embeddedPrompt = undefined;
		this.#runDeferredTimeout();
		this.#requestRender();
	}

	#renderEmbeddedPromptBody(width: number, rows: number): RenderedList {
		const theme = this.#theme;
		const prompt = this.#embeddedPrompt;
		if (!prompt) return { lines: windowLines([], 0, rows), scrollOffset: 0, indicator: "" };
		const lines: string[] = [];
		for (const titleLine of prompt.title.split("\n")) {
			lines.push(theme.fg("text", titleLine));
		}
		lines.push("");
		// pi-tui Input renders the input line itself: "> " prompt, horizontal
		// scrolling, reverse-video fake cursor, and CURSOR_MARKER at the input
		// point (zero-width) so the TUI positions the hardware cursor there —
		// that is what keeps the IME candidate window anchored.
		lines.push(prompt.input.render(width)[0] ?? "");
		if (prompt.prefill !== undefined) {
			lines.push(theme.fg("dim", "Enter keeps the value above when unchanged; empty clears it"));
		}
		const window = windowLines(lines, 0, rows);
		return { lines: window, scrollOffset: 0, indicator: "" };
	}

	// --- body rendering -----------------------------------------------------

	#renderQuestionBody(width: number, maxRows: number): RenderedList {
		const active = this.#activeQuestionState();
		if (!active) return { lines: windowLines([], 0, maxRows), scrollOffset: 0, indicator: "" };
		const { question, state } = active;
		const rowItems = this.#questionRows(question);
		state.cursorIndex = clamp(state.cursorIndex, 0, Math.max(0, rowItems.length - 1));
		return this.#renderQuestionList(question, state, rowItems, width, maxRows);
	}

	#renderQuestionList(
		question: ExtensionAskDialogQuestion,
		state: QuestionState,
		rowItems: QuestionRow[],
		width: number,
		rows: number,
	): RenderedList {
		const allLines: string[] = [];
		const lineStartByRow: number[] = [];
		const split = this.#useSplitLayout(question, width);
		const leftWidth = split ? this.#splitWidths(width).leftWidth : width;
		for (let index = 0; index < rowItems.length; index++) {
			lineStartByRow.push(allLines.length);
			const rowItem = rowItems[index];
			if (!rowItem) continue;
			allLines.push(
				...renderRowLabel(
					this.#theme,
					rowItem,
					question,
					state,
					index === state.cursorIndex,
					this.#previewCache,
					leftWidth,
					!split,
				),
			);
		}
		const cursorStart = lineStartByRow[state.cursorIndex] ?? 0;
		const cursorEnd = lineStartByRow[state.cursorIndex + 1] ?? allLines.length;
		this.#questionCanPage = cursorEnd - cursorStart > rows;
		state.scrollOffset = this.#scrollOffsetForCursor(
			state.scrollOffset,
			cursorStart,
			cursorEnd,
			rows,
			allLines.length,
			state.manualScroll,
		);
		const lines = windowLines(allLines, state.scrollOffset, rows);
		if (!split) {
			return {
				lines,
				scrollOffset: state.scrollOffset,
				indicator: clipIndicator(state.scrollOffset, rows, allLines.length),
			};
		}
		// Side-by-side: options on the left, the cursored option's preview on
		// the right, sharing the body window and the cursor-following scroll.
		const theme = this.#theme;
		const { leftWidth: lw, rightWidth } = this.#splitWidths(width);
		const divider = theme.fg("borderMuted", " │ ");
		const rightLines = this.#previewLinesForRow(question, state, rowItems[state.cursorIndex], rightWidth);
		const rightOffset = Math.min(state.scrollOffset, Math.max(0, rightLines.length - rows));
		const rightWindow = windowLines(rightLines, rightOffset, rows);
		const merged = lines.map((line, index) => `${fit(line, lw)}${divider}${rightWindow[index] ?? ""}`);
		return {
			lines: merged,
			scrollOffset: state.scrollOffset,
			indicator: clipIndicator(state.scrollOffset, rows, allLines.length),
		};
	}

	/** Split layout: wide terminal + at least one option carries a preview. */
	#useSplitLayout(question: ExtensionAskDialogQuestion, width: number): boolean {
		return width >= SPLIT_MIN_WIDTH && question.options.some(option => option.preview?.trim());
	}

	#splitWidths(width: number): { leftWidth: number; rightWidth: number } {
		const leftWidth = Math.max(24, Math.floor(width * 0.42));
		return { leftWidth, rightWidth: Math.max(1, width - leftWidth - 3) };
	}

	/** Raw preview lines for the right pane (cursored option, or the custom
	 *  answer preview under Other). */
	#previewLinesForRow(
		question: ExtensionAskDialogQuestion,
		state: QuestionState,
		rowItem: QuestionRow | undefined,
		width: number,
	): string[] {
		if (!rowItem) return [];
		if (rowItem.kind === "option") {
			const option = question.options[rowItem.optionIndex ?? -1];
			if (option?.preview?.trim()) {
				return [...renderCachedPreview(this.#theme, this.#previewCache, option.preview, width)];
			}
			return [];
		}
		if (state.customInput !== undefined) {
			const preview = replaceTabs(state.customInput).replace(/\s+/g, " ").trim();
			return [this.#theme.fg("muted", truncateToWidth(preview, Math.max(1, width), ELLIPSIS))];
		}
		return [];
	}

	#renderSubmitBody(width: number, rows: number): RenderedList {
		const theme = this.#theme;
		const allLines: string[] = [];
		const unanswered = this.#unansweredCount();
		if (unanswered > 0) {
			allLines.push(
				theme.fg(
					"warning",
					`${unanswered} unanswered question${unanswered === 1 ? "" : "s"}; Enter still submits.`,
				),
			);
			allLines.push("");
		}
		for (let index = 0; index < this.#questions.length; index++) {
			const question = this.#questions[index];
			const state = this.#states[index];
			if (!question || !state) continue;
			const label = questionTabLabel(question, index);
			const answer = renderAnswerSummary(theme, question, state);
			allLines.push(`${theme.fg("dim", `${index + 1}. ${label}:`)} ${answer}`);
		}
		allLines.push("");
		allLines.push(theme.fg("accent", `${SYMBOLS.nav.cursor} ${SUBMIT_OPTION}`));
		this.#submitScrollOffset = clamp(this.#submitScrollOffset, 0, Math.max(0, allLines.length - rows));
		const lines = windowLines(allLines, this.#submitScrollOffset, rows);
		return {
			lines,
			scrollOffset: this.#submitScrollOffset,
			indicator: clipIndicator(this.#submitScrollOffset, rows, allLines.length),
		};
	}

	#scrollOffsetForCursor(
		currentOffset: number,
		cursorStart: number,
		cursorEnd: number,
		rows: number,
		totalRows: number,
		manualScroll: boolean,
	): number {
		const maxOffset = Math.max(0, totalRows - rows);
		if (maxOffset === 0) return 0;
		let nextOffset = clamp(currentOffset, 0, maxOffset);
		const cursorRows = cursorEnd - cursorStart;
		if (manualScroll && cursorRows > rows) {
			// A page must not expose another option while Enter still targets this one.
			nextOffset = clamp(nextOffset, cursorStart, cursorEnd - rows);
		} else if (cursorStart < nextOffset || cursorEnd > nextOffset + rows) {
			nextOffset = cursorRows <= rows ? cursorEnd - rows : cursorStart;
		}
		return clamp(nextOffset, 0, maxOffset);
	}

	#unansweredCount(): number {
		let count = 0;
		for (let index = 0; index < this.#questions.length; index++) {
			const question = this.#questions[index];
			const state = this.#states[index];
			if (!question || !state) continue;
			if (state.selectedOptions.size === 0 && state.customInput === undefined) count += 1;
		}
		return count;
	}

	#handleTimeout(): void {
		if (this.#closed) return;
		if (this.#promptActive) {
			this.#timeoutExpired = true;
			return;
		}
		this.#options.onTimeout?.();
		for (let index = 0; index < this.#questions.length; index++) {
			const question = this.#questions[index];
			const state = this.#states[index];
			if (!question || !state) continue;
			if (state.selectedOptions.size === 0 && state.customInput === undefined) {
				const fallbackIndex = clamp(question.recommended ?? 0, 0, Math.max(0, question.options.length - 1));
				const fallback = question.options[fallbackIndex];
				if (fallback) state.selectedOptions.add(fallback.label);
				state.timedOut = true;
			}
		}
		this.#finishSubmit();
	}

	#runDeferredTimeout(): void {
		if (!this.#timeoutExpired) return;
		this.#timeoutExpired = false;
		this.#handleTimeout();
	}

	#finishSubmit(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#countdown?.dispose();
		this.#callbacks.onSubmit({ kind: "submit", results: this.#buildResults() });
	}

	#finishCancel(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#countdown?.dispose();
		this.#callbacks.onCancel();
	}

	/**
	 * Cancel from outside the component (agent turn aborted). Mirrors omp's
	 * #presentDialog(signal) disposal path: pi's ui.custom() has no signal
	 * option, so index.ts routes the agent abort signal here to close the
	 * dialog and settle the custom() promise with undefined.
	 */
	externalCancel(): void {
		this.#finishCancel();
	}

	#buildResults(): ExtensionAskDialogResultItem[] {
		const results: ExtensionAskDialogResultItem[] = [];
		for (let index = 0; index < this.#questions.length; index++) {
			const question = this.#questions[index];
			const state = this.#states[index];
			if (!question || !state) continue;
			const selectedOptions = question.options
				.map(option => option.label)
				.filter(label => state.selectedOptions.has(label));
			results.push({
				id: question.id,
				question: question.question,
				options: question.options.map(option => option.label),
				multi: question.multi ?? false,
				selectedOptions,
				customInput: state.customInput,
				timedOut: state.timedOut || undefined,
			});
		}
		return results;
	}
}
