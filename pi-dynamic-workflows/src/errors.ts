/**
 * Categorized workflow errors (A5 taxonomy).
 *
 * A single `WorkflowError` class carries a `category` discriminator so retry
 * policy and callers can distinguish recoverable from terminal failures
 * without a subclass per category (design D6). The pre-existing
 * `BudgetExceededError` and `DeterminismError` are retrofitted to extend this
 * class so they gain the discriminator without breaking their exported identity.
 *
 * Retry policy keys off `category`: only `dispatch-error` and `unexpected-state`
 * auto-retry by default; the rest are terminal (size-limit, determinism,
 * control-chars, policy-gate, compile, killed, budget-exceeded).
 */

export type ErrorCategory =
	| "budget-exceeded"
	| "determinism"
	| "size-limit"
	| "control-chars"
	| "compile"
	| "policy-gate"
	| "killed"
	| "dispatch-error"
	| "unexpected-state";

/** Structured detail attached to a categorized error (limit hit, byte count,
 *  offending source location, underlying message, …). */
export type ErrorDetail = Readonly<Record<string, unknown>>;

export interface WorkflowErrorOptions {
	readonly category?: ErrorCategory;
	readonly detail?: ErrorDetail;
	readonly cause?: unknown;
}

export class WorkflowError extends Error {
	readonly category: ErrorCategory;
	readonly detail?: ErrorDetail;

	constructor(message: string, opts: WorkflowErrorOptions = {}) {
		super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
		this.name = "WorkflowError";
		this.category = opts.category ?? "unexpected-state";
		this.detail = opts.detail;
	}
}

/** Categories that are eligible for automatic retry by default. All others are
 *  treated as terminal (retrying a size-limit or determinism violation just
 *  wastes budget). */
export const RETRYABLE_CATEGORIES: readonly ErrorCategory[] = ["dispatch-error", "unexpected-state"];

export function isRetryable(err: unknown): boolean {
	return err instanceof WorkflowError && RETRYABLE_CATEGORIES.includes(err.category);
}
