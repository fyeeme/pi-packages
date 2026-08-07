/**
 * src/tools/subagent.ts — the `subagent` LLM tool.
 *
 * A general-purpose fan-out tool: spawn one or more real pi subprocesses to
 * run prompts as independent agents. This is the capability the code-review
 * skill needs for its medium+ multi-agent flow (parallel finders, an
 * independent verify agent, a gap-hunter) — the skill calls this tool instead
 * of doing multi-perspective work inline.
 *
 * Modes:
 *   - single   run prompts[0] once
 *   - parallel run all prompts concurrently (capped at MAX_CONCURRENCY)
 *   - chain    run sequentially; each later prompt receives prior output
 */
import { defineTool, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	abortAgent,
	createSpawnRegistry,
	mapWithConcurrencyLimit,
	spawnAgent,
	type AgentSpawnRegistry,
	type AgentSpawnOptions,
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
	/** Killed because the maxTurns budget was reached (not an external cancel). */
	maxTurnsReached: boolean;
	errorMessage?: string;
	/**
	 * 完整对话转录文件路径(总是写入,含 user/assistant/tool result 全量消息)。
	 * 内联预览只展示最终文本,模型可随时用 read 读取该文件深挖完整过程。
	 */
	transcriptFile?: string;
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

/**
 * 提取单条消息的可读文本（string content 或 content block 数组）。
 *
 * 转录用：除 text 外也渲染 thinking 与 toolCall 块，否则转录会静默丢弃中间推理与
 * 工具调用——与“全量转录含 tool result”的声明不符。内联预览（resultText）仍只取
 * assistant 的 text，保持简短。
 */
function messageText(m: { role?: string; content?: unknown }): string {
	const content = m.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as { type?: string; text?: unknown; thinking?: unknown; name?: unknown; arguments?: unknown };
		switch (b.type) {
			case "text":
				if (typeof b.text === "string") parts.push(b.text);
				break;
			case "thinking":
				if (typeof b.thinking === "string") parts.push(`[thinking] ${b.thinking}`);
				break;
			case "toolCall":
				if (typeof b.name === "string") {
					const args = b.arguments === undefined ? "" : JSON.stringify(b.arguments);
					parts.push(`[tool_call] ${b.name}(${args})`);
				}
				break;
			default:
				break;
		}
	}
	return parts.join("\n");
}

/**
 * 将 agent 的完整对话(全部消息:user / assistant / tool result)渲染为可读转录文本。
 * 内联预览只含最终 assistant 文本;这里保留中间推理与工具调用过程,供模型深挖。
 */
function transcriptText(messages: AgentSpawnResult["messages"]): string {
	const parts: string[] = [];
	for (const m of messages) {
		const body = messageText(m).trim();
		if (!body) continue;
		const role = m.role ?? "message";
		// toolResult 消息标出工具名，便于定位是哪个工具的返回。
		const label =
			role === "toolResult" && typeof (m as { toolName?: unknown }).toolName === "string"
				? `${role}(${(m as { toolName: string }).toolName})`
				: role;
		parts.push(`--- ${label} ---\n${body}`);
	}
	return parts.join("\n\n");
}

/**
 * 将 agent 的完整对话转录写入临时文件。总是写入(借鉴 tintinweb/pi-subagents:
 * 完整转录落盘 + 路径随结果给出),不只在输出超限时才写。
 */
async function writeTranscriptFile(tmpDir: string, callId: string, text: string): Promise<string> {
	const safeName = callId.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `agent-${safeName}.txt`);
	await fs.promises.writeFile(filePath, text, { encoding: "utf-8", mode: 0o600 });
	return filePath;
}

/**
 * 单个 agent 的展示预览:最终文本用 pi 内置截断(默认 50KB / 2000 行)呈现——
 * 正常体量输出直接完整内联;超限时保留截断内容并标注。无论是否超限,都附上
 * 完整对话转录文件路径,模型可随时 read 深挖。
 */
function previewEntry(r: SubagentEntry): string {
	const trunc = truncateHead(r.text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	let preview = trunc.content;
	const extras: string[] = [];
	if (trunc.truncated) {
		extras.push(`输出截断: ${trunc.outputLines}/${trunc.totalLines} 行, ${formatSize(trunc.outputBytes)}/${formatSize(trunc.totalBytes)}`);
	}
	if (r.transcriptFile) {
		extras.push(`完整转录: ${r.transcriptFile}`);
	}
	if (extras.length > 0) preview += `\n    [${extras.join(" · ")}]`;
	return preview;
}

function summarize(d: SubagentDetails): string {
	const lines = [
		`subagent (${d.mode}) → ${d.results.length} agent(s), ${d.stats.turns} turn(s), $${d.stats.cost.toFixed(4)}`,
	];
	for (const r of d.results) {
		const tag = r.maxTurnsReached
			? "[max-turns]"
			: r.aborted
				? "[aborted]"
				: r.errorMessage
					? "[error]"
					: "[ok]";
		lines.push(`  ${tag} #${r.index + 1}: ${previewEntry(r)}`);
	}
	return lines.join("\n");
}

export const subagentTool = defineTool<typeof SubagentParams, SubagentDetails>({
	name: "subagent",
	label: "Sub-agent",
	description:
		"Spawn one or more sub-agents (real pi subprocesses) to fan out work — e.g. parallel code-review finders, an independent verify agent, or a gap-hunter. Each sub-agent is a full pi run in --mode json. 每个 agent 的完整对话转录都会写入临时文件并在结果中附上路径;内联预览展示最终文本(超长时截断),需要完整过程时可用 read 工具读取转录文件。",
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
		// Per-call-agnostic subset of AgentSpawnOptions; callId/task are added per spawn.
		const baseOpts: Omit<AgentSpawnOptions, "callId" | "task"> = {
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

		// 本次 tool call 内所有 agent 共享一个临时目录（N 个 agent → 1 个目录），
		// 取代每个 agent 各自 mkdtemp。转录需保留供模型稍后 read，故此处不清理。
		let sharedTmpDir: string | null = null;
		const getTmpDir = async (): Promise<string> => {
			if (!sharedTmpDir) {
				sharedTmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-cr-out-"));
			}
			return sharedTmpDir;
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
				maxTurnsReached: r.maxTurnsReached,
				errorMessage:
					r.errorMessage ||
					(r.exitCode !== 0 && !r.aborted
						? `exit ${r.exitCode}${r.stderr ? `: ${r.stderr.slice(0, 200)}` : ""}`
						: undefined),
			};
			// 总是写入完整对话转录文件并附路径(借鉴 tintinweb/pi-subagents)。写失败不阻塞结果。
			try {
				entry.transcriptFile = await writeTranscriptFile(await getTmpDir(), callId, transcriptText(r.messages));
			} catch {
				/* 转录写失败不阻塞:previewEntry 无路径时仅展示内联预览 */
			}
			partial.results.push(entry);
			partial.stats.agents++;
			partial.stats.turns += r.usage.turns;
			partial.stats.cost += r.usage.cost;
			// Only count genuine external cancels as aborted; a maxTurns budget
			// stop is a normal bounded completion, not a cancellation.
			if (r.aborted && !r.maxTurnsReached) partial.stats.aborted++;
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
				// Stop the chain on a hard failure so downstream prompts don't run
				// on missing/garbage context (and don't waste subprocesses). An
				// aborted/maxTurns step may still carry useful text worth chaining.
				if (entry.errorMessage) break;
				// 始终赋值（即便是空串）以清空链上下文：否则空文本步骤会让后续步骤复用
				// 更早步骤的输出作为“Previous sub-agent output”，传递陈旧上下文。
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
