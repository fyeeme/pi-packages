/**
 * Ask dialog types — migrated from oh-my-pi. The ExtensionAskDialog / ExtensionUI
 * shapes come from packages/coding-agent/src/extensibility/extensions/types.ts;
 * QuestionResult/AskToolDetails/AskOption come from packages/coding-agent/src/tools/ask.ts.
 *
 * Adaptation: none — these are pure data shapes, carried over verbatim.
 */

export interface ExtensionUISelectOption {
	label: string;
	description?: string;
}

export type ExtensionUISelectItem = string | ExtensionUISelectOption;

export interface ExtensionAskDialogOption {
	label: string;
	description?: string;
	preview?: string;
}

export interface ExtensionAskDialogQuestion {
	id: string;
	question: string;
	header?: string;
	options: ExtensionAskDialogOption[];
	multi?: boolean;
	recommended?: number;
}

export interface ExtensionAskDialogResultItem {
	id: string;
	question: string;
	options: string[];
	multi: boolean;
	selectedOptions: string[];
	customInput?: string;
	timedOut?: boolean;
}

export interface ExtensionAskDialogSubmitResult {
	kind: "submit";
	results: ExtensionAskDialogResultItem[];
}

export type ExtensionAskDialogResult = ExtensionAskDialogSubmitResult;

/**
 * Ask dialog types — migrated from oh-my-pi. The ExtensionAskDialog / ExtensionUI
 * shapes come from packages/coding-agent/src/extensibility/extensions/types.ts;
 * QuestionResult/AskToolDetails/AskOption come from packages/coding-agent/src/tools/ask.ts.
 *
 * Adaptation: none — these are pure data shapes, carried over verbatim.
 *//** Result for a single question (omp AskToolDetails.QuestionResult). */
export interface QuestionResult {
	id: string;
	question: string;
	options: string[];
	multi: boolean;
	selectedOptions: string[];
	customInput?: string;
	timedOut?: boolean;
}

export interface AskToolDetails {
	question?: string;
	options?: string[];
	multi?: boolean;
	selectedOptions?: string[];
	customInput?: string;
	timedOut?: boolean;
	results?: QuestionResult[];
}

export interface AskOption {
	label: string;
	description?: string;
}
