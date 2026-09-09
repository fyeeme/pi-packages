/**
 * pi-goal — independent completion / impossibility evaluator.
 *
 * Absorbed from Claude Code 2.1.261's goal architecture (bin/claude.exe,
 * 2026-09-07): CC ends a goal via a SEPARATE evaluator query that judges the
 * condition against evidence, with a strict JSON contract and a default of
 * "insufficient evidence in transcript = not met", plus an `impossible`
 * channel whose own rule is "the assistant's claim is evidence, not proof —
 * independently confirm before agreeing". CC's evaluator is transcript-only
 * (it cannot run commands); pi-goal's is GROUNDED — a fresh `pi -p`
 * subprocess with tools that re-checks the repository itself. This removes
 * the self-grading bias of the in-session `goal({op:"complete"})` call (the
 * omp design this extension ported): the model that claims completion is no
 * longer the model that decides it.
 *
 * Spawn mechanics mirror @fyeeme/pi-subagents' subprocess convention — a
 * one-shot `pi -p --no-session "<prompt>"`; getPiInvocation is ported
 * verbatim from its src/dispatch.ts (itself ported from
 * examples/extensions/subagent). pi-goal stays dependency-free by keeping
 * the small resolver local.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { escapeXmlText, renderTemplate } from "./template.ts";

const execFileAsync = promisify(execFile);

const promptsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "prompts");
const evaluatorCompletePrompt = readFileSync(path.join(promptsDir, "evaluator-complete.md"), "utf8");
const evaluatorImpossiblePrompt = readFileSync(path.join(promptsDir, "evaluator-impossible.md"), "utf8");

/** Hard cap on one evaluator run — the grounded check may run test suites,
 *  so this is deliberately generous; anything longer has failed. */
export const EVALUATOR_TIMEOUT_MS = 300_000;

/** Argv-safety caps (kernel MAX_ARG_STRLEN ≈ 128KB; these keep the prompt
 *  argument far under it even for verbose objectives/audits). */
const OBJECTIVE_CAP = 4_000;
const CLAIM_CAP = 8_000;

export type GoalEvaluatorMode = "complete" | "impossible";

export interface GoalEvaluatorRequest {
	mode: GoalEvaluatorMode;
	/** The goal objective, verbatim. */
	objective: string;
	/** What the claiming agent asserts: the per-deliverable completion audit
	 *  (complete mode) or the impossibility reason (impossible mode). */
	claim: string;
}

export type GoalEvaluatorOutcome =
	| { status: "confirmed"; reason: string }
	| { status: "refuted"; reason: string }
	| { status: "unavailable"; detail: string };

export interface GoalEvaluatorRunOptions {
	cwd: string;
	signal?: AbortSignal;
	spawn?: EvaluatorSpawn;
	timeoutMs?: number;
}

export type EvaluatorSpawn = (
	invocation: { command: string; args: string[] },
	opts: { cwd: string; timeoutMs: number; signal?: AbortSignal },
) => Promise<string>;

const defaultSpawn: EvaluatorSpawn = async (invocation, opts) => {
	const { stdout } = await execFileAsync(invocation.command, invocation.args, {
		cwd: opts.cwd,
		timeout: opts.timeoutMs,
		signal: opts.signal,
		encoding: "utf8",
		maxBuffer: 8 * 1024 * 1024,
	});
	return stdout;
};

/**
 * Resolve the `pi` invocation for the subprocess. Ported verbatim from
 * @fyeeme/pi-subagents src/dispatch.ts (itself ported from
 * examples/extensions/subagent): prefer re-entering the current script
 * (node <script> / bun <script>); fall back to the `pi` binary on PATH under
 * a generic runtime.
 */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

function clip(text: string, cap: number): string {
	return text.length > cap ? `${text.slice(0, cap - 1)}…[truncated]` : text;
}

/** Build the evaluator prompt: fresh-context agent, so everything it needs
 *  rides in the message — objective + claim, both as escaped quoted data. */
export function buildEvaluatorPrompt(request: GoalEvaluatorRequest): string {
	const template = request.mode === "complete" ? evaluatorCompletePrompt : evaluatorImpossiblePrompt;
	return renderTemplate(template, {
		objective: clip(escapeXmlText(request.objective), OBJECTIVE_CAP),
		claim: clip(escapeXmlText(request.claim), CLAIM_CAP),
	});
}

/** Extract the first balanced JSON object from evaluator output. Handles the
 *  clean case, code-fenced output, and prose-wrapped JSON; anything else is
 *  unparseable. Never throws. */
export function extractJsonObject(text: string): Record<string, unknown> | undefined {
	const trimmed = text
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/```\s*$/, "");
	const candidates: string[] = [];
	if (trimmed) candidates.push(trimmed);
	const start = trimmed.indexOf("{");
	if (start !== -1) {
		let depth = 0;
		let inString = false;
		let escaped = false;
		for (let i = start; i < trimmed.length; i++) {
			const ch = trimmed[i]!;
			if (inString) {
				if (escaped) escaped = false;
				else if (ch === "\\") escaped = true;
				else if (ch === '"') inString = false;
				continue;
			}
			if (ch === '"') inString = true;
			else if (ch === "{") depth++;
			else if (ch === "}") {
				depth--;
				if (depth === 0) {
					candidates.push(trimmed.slice(start, i + 1));
					break;
				}
			}
		}
	}
	for (const candidate of candidates) {
		try {
			const parsed: unknown = JSON.parse(candidate);
			if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
		} catch {
			/* try the next candidate */
		}
	}
	return undefined;
}

function asReason(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/**
 * Run the independent evaluator and map its output onto a three-way outcome.
 * Any failure to obtain a well-formed verdict (spawn error, timeout,
 * unparseable output) is `unavailable` — the caller decides the fallback —
 * except a caller-initiated abort, which rethrows.
 */
export async function runGoalEvaluator(
	request: GoalEvaluatorRequest,
	opts: GoalEvaluatorRunOptions,
): Promise<GoalEvaluatorOutcome> {
	const prompt = buildEvaluatorPrompt(request);
	const spawn = opts.spawn ?? defaultSpawn;
	const timeoutMs = opts.timeoutMs ?? EVALUATOR_TIMEOUT_MS;
	let stdout: string;
	try {
		stdout = await spawn(getPiInvocation(["-p", "--no-session", prompt]), {
			cwd: opts.cwd,
			timeoutMs,
			signal: opts.signal,
		});
	} catch (err) {
		if (opts.signal?.aborted) {
			throw new Error("goal evaluation aborted");
		}
		const message = err instanceof Error ? err.message : String(err);
		const killed = (err as { killed?: boolean }).killed === true;
		return {
			status: "unavailable",
			detail: killed ? `evaluator timed out after ${Math.round(timeoutMs / 1000)}s` : clip(message, 300),
		};
	}
	if (!stdout.trim()) {
		return { status: "unavailable", detail: "evaluator produced no output" };
	}
	const parsed = extractJsonObject(stdout);
	if (!parsed) {
		return { status: "unavailable", detail: `unparseable evaluator output: ${clip(stdout.trim(), 200)}` };
	}
	if (request.mode === "complete") {
		if (parsed.ok === true) return { status: "confirmed", reason: asReason(parsed.reason) };
		if (parsed.ok === false) return { status: "refuted", reason: asReason(parsed.reason) };
	} else {
		if (parsed.impossible === true) return { status: "confirmed", reason: asReason(parsed.reason) };
		if (parsed.impossible === false) return { status: "refuted", reason: asReason(parsed.reason) };
	}
	return { status: "unavailable", detail: `evaluator returned an out-of-contract verdict: ${clip(JSON.stringify(parsed), 200)}` };
}
