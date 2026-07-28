/**
 * src/tools/subagent.ts — the `subagent` LLM tool.
 *
 * A general-purpose fan-out tool: spawn one or more real pi subprocesses to
 * run prompts as independent agents. This is the capability the code-review-v3
 * skill needs for its medium+ multi-agent flow (parallel finders, an
 * independent verify agent, a gap-hunter) — the skill calls this tool instead
 * of doing multi-perspective work inline.
 *
 * Modes:
 *   - single   run prompts[0] once
 *   - parallel run all prompts concurrently (capped at MAX_CONCURRENCY)
 *   - chain    run sequentially; each later prompt receives prior output
 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	abortAgent,
	createSpawnRegistry,
	mapWithConcurrencyLimit,
	spawnAgent,
	type AgentSpawnRegistry,
	type AgentSpawnResult,
} from "../agent/dispatch.ts";

/** Cap on concurrent subprocesses (matches pi-dynamic-workflows + examples/subagent). */
const MAX_CONCURRENCY = 8;

// Module-level registry so abortAgent can reach in-flight calls. callIds are
// unique per tool call (toolCallId#index), so a single registry is safe.
const registry: AgentSpawnRegistry = createSpawnRegistry();

const SubagentParams = Type.Object({
	// single: run prompts[0] once. parallel: run all prompts concurrently.
	// chain: run sequentially, each later prompt sees prior output.
	mode: Type.Union([Type.Literal("single"), Type.Literal("parallel"), Type.Literal("chain")]),
	prompts: Type.Array(Type.String(), {
		description: "Prompt(s) for the sub-agent(s). single/chain use order; parallel runs all.",
	}),
	model: Type.Optional(Type.String({ description: "Full model id (e.g. claude-sonnet-5). Omit for the session default." })),
	systemPrompt: Type.Optional(Type.String({ description: "Appended to the sub-agent's system prompt." })),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Tool whitelist for the sub-agent. Omit for default tools." })),
	parallelism: Type.Optional(
		Type.Number({ description: `Max concurrent agents in parallel mode (default min(prompts.length, ${MAX_CONCURRENCY})).` }),
	),
	maxTurns: Type.Optional(
		Type.Number({ description: "Max assistant turns per sub-agent. When reached, the subprocess is aborted. Omit for unlimited." }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to the session cwd." })),
});

interface SubagentEntry {
	index: number;
	exitCode: number;
	text: string;
	aborted: boolean;
	errorMessage?: string;
}

interface SubagentDetails {
	mode: string;
	results: SubagentEntry[];
	stats: { agents: number; turns: number; cost: number; aborted: number };
}

/** Pull the assistant text out of a spawn result's messages. Defensive about
 *  the Message.content shape (string | content-block array). */
function resultText(r: AgentSpawnResult): string {
	const texts: string[] = [];
	for (const m of r.messages) {
		if (m.role !== "assistant") continue;
		const content: unknown = (m as { content?: unknown }).content;
		if (typeof content === "string") {
			texts.push(content);
			continue;
		}
		if (Array.isArray(content)) {
			for (const block of content) {
				if (block && typeof block === "object" && "text" in block) {
					const text = (block as { text?: unknown }).text;
					if (typeof text === "string") texts.push(text);
				}
			}
		}
	}
	return texts.join("\n").trim();
}

function summarize(d: SubagentDetails): string {
	const lines = [
		`subagent (${d.mode}) → ${d.results.length} agent(s), ${d.stats.turns} turn(s), $${d.stats.cost.toFixed(4)}`,
	];
	for (const r of d.results) {
		const tag = r.aborted ? "[aborted]" : r.errorMessage ? "[error]" : "[ok]";
		const preview = r.text.slice(0, 200);
		lines.push(`  ${tag} #${r.index + 1}: ${preview}${r.text.length > 200 ? "…" : ""}`);
	}
	return lines.join("\n");
}

export const subagentTool = defineTool<typeof SubagentParams, SubagentDetails>({
	name: "subagent",
	label: "Sub-agent",
	description:
		"Spawn one or more sub-agents (real pi subprocesses) to fan out work — e.g. parallel code-review finders, an independent verify agent, or a gap-hunter. Each sub-agent is a full pi run in --mode json. Use this instead of doing multi-perspective analysis inline.",
	promptSnippet: "subagent — spawn parallel/sequential sub-agents (fan-out finders, independent verify, gap-hunt)",
	promptGuidelines: [
		"Use `subagent` with mode:parallel to fan out multiple reviewers/finders at once (e.g. one per angle); collect their outputs and synthesize.",
		"Use mode:single for an independent second opinion (e.g. verify a candidate finding without your own confirmation bias).",
		"Do not fake fan-out by doing the work yourself inline — call `subagent` so the work genuinely runs in parallel subprocesses.",
	],
	parameters: SubagentParams,

	async execute(toolCallId, params, signal, onUpdate, ctx) {
		const prompts = params.prompts;
		if (prompts.length === 0) throw new Error("subagent: prompts must be non-empty");
		if (params.mode === "single" && prompts.length > 1) {
			throw new Error(`subagent: mode "single" takes exactly one prompt (got ${prompts.length})`);
		}

		const cwd = params.cwd ?? ctx.cwd;
		const baseSystem = params.systemPrompt;
		const baseOpts: Parameters<typeof spawnAgent>[1] & { maxTurns?: number } = {
			cwd,
			model: params.model,
			tools: params.tools,
			signal,
			maxTurns: params.maxTurns,
		};

		const partial: SubagentDetails = {
			mode: params.mode,
			results: [],
			stats: { agents: 0, turns: 0, cost: 0, aborted: 0 },
		};
		const emit = (): void => {
			onUpdate?.({ content: [{ type: "text" as const, text: summarize(partial) }], details: partial });
		};

		const runOne = async (prompt: string, index: number, extraSystem?: string): Promise<SubagentEntry> => {
			const callId = `${toolCallId}#${index}`;
			const systemPrompt = extraSystem
				? [baseSystem, extraSystem].filter(Boolean).join("\n\n")
				: baseSystem;
			const r = await spawnAgent(registry, { callId, task: prompt, ...baseOpts, systemPrompt });
			const entry: SubagentEntry = {
				index,
				exitCode: r.exitCode,
				text: resultText(r),
				aborted: r.aborted,
				errorMessage:
					r.errorMessage ||
					(r.exitCode !== 0 && !r.aborted
						? `exit ${r.exitCode}${r.stderr ? `: ${r.stderr.slice(0, 200)}` : ""}`
						: undefined),
			};
			partial.results.push(entry);
			partial.stats.agents++;
			partial.stats.turns += r.usage.turns;
			partial.stats.cost += r.usage.cost;
			if (r.aborted) partial.stats.aborted++;
			// Keep results sorted by index for stable output (parallel settles out of order).
			partial.results.sort((a, b) => a.index - b.index);
			emit();
			return entry;
		};

		if (params.mode === "parallel") {
			const conc = Math.min(params.parallelism ?? MAX_CONCURRENCY, MAX_CONCURRENCY, prompts.length);
			await mapWithConcurrencyLimit(prompts, conc, (p, i) => runOne(p, i));
		} else {
			// single or chain
			let chainContext = "";
			for (let i = 0; i < prompts.length; i++) {
				const extra = params.mode === "chain" && chainContext ? `Previous sub-agent output:\n${chainContext}` : undefined;
				const entry = await runOne(prompts[i], i, extra);
				chainContext = entry.text;
			}
		}

		// Surface a hard failure (non-aborted, non-zero exit) by throwing so the
		// agent loop marks isError=true (pi tool contract: throw, don't return isError).
		const failed = partial.results.find((r) => r.errorMessage && !r.aborted);
		if (failed) throw new Error(`subagent: agent #${failed.index + 1} failed — ${failed.errorMessage}`);

		return {
			content: [{ type: "text" as const, text: summarize(partial) }],
			details: partial,
		};
	},
});

/** Abort one in-flight sub-agent by its callId. Exposed for future per-agent
 *  abort UI; the caller-level `signal` already handles run-wide ESC. */
export function abortSubagent(callId: string): boolean {
	return abortAgent(registry, callId);
}
