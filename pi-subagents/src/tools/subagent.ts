/**
 * src/tools/subagent.ts — the `subagent` LLM tool.
 *
 * Interaction surface: two mutually exclusive modes — single { agent, task }
 * and parallel { tasks[] } — with agent-name referencing, streaming
 * progress, and the collapsed/expanded renderers.
 *
 * Execution surface is this package's dispatch core (src/dispatch.ts): real
 * `pi --mode json -p --no-session` subprocesses via spawnAgent, per-callId
 * abort, maxTurns budget, the shared concurrency ceiling, and monitor
 * notifications (agent widget / FleetView / /agents).
 *
 * Recursion guard: the extension entry registers this tool only when
 * isFanoutToolAllowed() holds for THIS process; spawned children default to
 * a tool set without the fan-out tool (and env-capped recursion), so they
 * physically cannot recurse.
 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as os from "node:os";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { type AgentConfig, discoverAgents } from "../../agents.ts";
import { loadCoreSettings } from "../concurrency.ts";
import {
	createSpawnRegistry,
	type AgentSpawnRegistry,
	getMaxConcurrency,
	lastAssistantText,
	mapWithConcurrencyLimit,
	spawnAgent,
} from "../dispatch.ts";

/** Parallel-mode task-count ceiling. 16 covers the review skill's largest
 *  instructed single batch (10 finders at xhigh/max) plus grouped-verifier
 *  fan-outs; actual concurrent subprocesses remain capped by the shared
 *  concurrency ceiling, so this only bounds one call's task count. */
const MAX_PARALLEL_TASKS = 16;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

/**
 * Default turn budget for a subagent when the agent definition omits one. A
 * runaway agent cannot otherwise be bounded. Generous (well above the ~10–15
 * turns recon/review agents need) so legitimate work is not truncated; agent
 * definitions may override with a smaller or larger explicit value.
 * 50 = CC's FORKED_AGENT_DEFAULT_MAX_TURNS.
 */
const DEFAULT_FANOUT_MAX_TURNS = 50;

// Module-level registry so abortAgent can reach in-flight calls. callIds are
// unique per tool call (toolCallId#index), so a single registry is safe.
const registry: AgentSpawnRegistry = createSpawnRegistry();

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface SingleResult {
	agent: string;
	/** Stable spawn id (AdjectiveNoun) — matches monitor rows/artifacts. */
	id?: string;
	agentSource: AgentConfig["source"] | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens: number;
		turns: number;
	};
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	aborted?: boolean;
}

interface SubagentDetails {
	mode: "single" | "parallel";
	projectAgentsDir: string | null;
	results: SingleResult[];
}

function isFailedResult(result: SingleResult): boolean {
	return (
		result.exitCode !== 0 ||
		result.stopReason === "error" ||
		result.stopReason === "aborted" ||
		result.aborted === true
	);
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || lastAssistantText(result.messages) || "(no output)";
	}
	return lastAssistantText(result.messages) || "(no output)";
}

function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

/** Spawn one agent by name through the dispatch core and normalize the
 *  result into the tool's SingleResult shape. */
async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	maxTurns: number,
	cwd: string | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		};
	}

	const callId = `subagent-${agentName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	// Whitelist-by-default recursion opt-in (the dispatch core's documented
	// contract): a child whose tool whitelist lists the fan-out tool is
	// explicitly allowed to fan out itself; any other child loads without the
	// tool and physically cannot recurse.
	const allowChildRecursion = agent.tools?.includes("subagent") ?? false;
	const r = await spawnAgent(registry, {
		callId,
		task,
		cwd: cwd ?? defaultCwd,
		model: agent.model,
		tools: agent.tools,
		systemPrompt: agent.systemPrompt,
		maxTurns: maxTurns,
		allowChildRecursion,
		displayName: agentName,
		signal,
	});
	const result: SingleResult = {
		agent: agentName,
		id: r.id,
		agentSource: agent.source,
		task,
		exitCode: r.exitCode,
		messages: r.messages,
		stderr: r.stderr,
		usage: {
			input: r.usage.input,
			output: r.usage.output,
			cacheRead: r.usage.cacheRead,
			cacheWrite: r.usage.cacheWrite,
			cost: r.usage.cost,
			contextTokens: r.usage.contextTokens,
			turns: r.usage.turns,
		},
		model: r.model,
		stopReason: r.stopReason,
		errorMessage: r.errorMessage,
		aborted: r.aborted,
	};
	if (onUpdate) {
		onUpdate({
			content: [{ type: "text", text: lastAssistantText(r.messages) || "(running...)" }],
			details: makeDetails([result]),
		});
	}
	return result;
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});



const SubagentParams = Type.Object({
	context: Type.Optional(
		Type.String({
			description:
				"Shared background (project layout, constraints, interfaces) prepended to EVERY agent's prompt in this call — write it once instead of repeating it in each task.",
		}),
	),
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(
		Type.Array(TaskItem, {
			description: "Array of {agent, task} for parallel execution (max 16 tasks per call; concurrency still capped by the shared ceiling)",
		}),
	),
	maxTurns: Type.Optional(
		Type.Number({
			description:
				"Max assistant turns per agent. When reached, the subprocess is aborted (partial output preserved, marked budget-aborted). Must be a positive integer.",
		}),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

export const subagentTool = defineTool<typeof SubagentParams, SubagentDetails>({
	name: "subagent",
	label: "Subagent",
	description: [
		"Delegate tasks to specialized subagents with isolated context.",
		"Modes: single (agent + task), parallel (tasks array).",
		"Agents are discovered from the bundled set (scout/planner/reviewer/worker), ~/.pi/agent/agents, and project .pi/agents.",
	].join(" "),
	promptSnippet: "subagent — delegate to specialized agents (single/parallel)",
	parameters: SubagentParams,

	async execute(_toolCallId, params, signal, onUpdate, ctx) {
		if (params.maxTurns !== undefined && (!Number.isInteger(params.maxTurns) || params.maxTurns <= 0)) {
			return {
				content: [
					{
						type: "text",
						text: `Invalid maxTurns: ${params.maxTurns}. Must be a positive integer (the per-agent assistant-turn budget).`,
					},
				],
				details: { mode: "single", projectAgentsDir: null, results: [] },
			};
		}

		const discovery = discoverAgents(ctx.cwd, "both");
		const agents = discovery.agents;

		const hasTasks = (params.tasks?.length ?? 0) > 0;
		const hasSingle = Boolean(params.agent && params.task);

		const makeDetails =
			(mode: "single" | "parallel") =>
			(results: SingleResult[]): SubagentDetails => ({
				mode,
				projectAgentsDir: discovery.projectAgentsDir,
				results,
			});

		// Project-agent trust gate — settings-driven ONLY (the wire schema has
		// no policy parameters): interactive sessions confirm repo-controlled
		// agents before any subprocess spawns; headless runs cannot prompt.
		if (ctx.hasUI && loadCoreSettings(ctx.cwd).confirmProjectAgents !== false) {
			const requestedAgentNames = new Set<string>();
			if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
			if (params.agent) requestedAgentNames.add(params.agent);

			const projectAgentsRequested = Array.from(requestedAgentNames)
				.map((name) => agents.find((a) => a.name === name))
				.filter((a): a is AgentConfig => a?.source === "project");

			if (projectAgentsRequested.length > 0) {
				const names = projectAgentsRequested.map((a) => a.name).join(", ");
				const dir = discovery.projectAgentsDir ?? "(unknown)";
				const ok = await ctx.ui.confirm(
					"Run project-local agents?",
					`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
				);
				if (!ok)
					return {
						content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
						details: makeDetails("single")([]),
					};
			}
		}

		if (hasTasks && hasSingle) {
			return {
				content: [
					{
						type: "text",
						text: "Invalid parameters. Provide exactly one mode: either `agent` + `task` (single) or `tasks` (parallel).",
					},
				],
				details: makeDetails("single")([]),
			};
		}

		if (params.tasks && params.tasks.length > 0) {
			if (params.tasks.length > MAX_PARALLEL_TASKS)
				return {
					content: [
						{
							type: "text",
							text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
						},
					],
					details: makeDetails("parallel")([]),
				};

			// Track all results for streaming updates.
			const allResults: SingleResult[] = new Array(params.tasks.length);

			// Initialize placeholder results.
			for (let i = 0; i < params.tasks.length; i++) {
				allResults[i] = {
					agent: params.tasks[i].agent,
					agentSource: "unknown",
					task: params.tasks[i].task,
					exitCode: -1, // -1 = still running
					messages: [],
					stderr: "",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				};
			}

			const emitParallelUpdate = () => {
				if (onUpdate) {
					const running = allResults.filter((r) => r.exitCode === -1).length;
					const done = allResults.filter((r) => r.exitCode !== -1).length;
					onUpdate({
						content: [
							{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
						],
						details: makeDetails("parallel")([...allResults]),
					});
				}
			};

			const ceiling = getMaxConcurrency();
			const results = await mapWithConcurrencyLimit(params.tasks, ceiling, async (t, index) => {
				const taskWithContext = params.context ? `${params.context}\n\n${t.task}` : t.task;
				const result = await runSingleAgent(
					ctx.cwd,
					agents,
					t.agent,
					taskWithContext,
					params.maxTurns ?? DEFAULT_FANOUT_MAX_TURNS,
					t.cwd,
					signal,
					(partial) => {
						if (partial.details?.results[0]) {
							allResults[index] = partial.details.results[0];
							emitParallelUpdate();
						}
					},
					makeDetails("parallel"),
				);
				allResults[index] = result;
				emitParallelUpdate();
				return result;
			});

			const successCount = results.filter((r) => !isFailedResult(r)).length;
			const summaries = results.map((r) => {
				const output = truncateParallelOutput(getResultOutput(r));
				const status = isFailedResult(r)
					? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
					: "completed";
				return `### [${r.agent}] ${status}\n\n${output}`;
			});
			return {
				content: [
					{
						type: "text",
						text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
					},
				],
				details: makeDetails("parallel")(results),
			};
		}

		if (params.agent && params.task) {
			const taskWithContext = params.context ? `${params.context}\n\n${params.task}` : params.task;
			const result = await runSingleAgent(
				ctx.cwd,
				agents,
				params.agent,
				taskWithContext,
				params.maxTurns ?? DEFAULT_FANOUT_MAX_TURNS,
				params.cwd,
				signal,
				onUpdate,
				makeDetails("single"),
			);
			if (isFailedResult(result)) {
				const errorMsg = getResultOutput(result);
				return {
					content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
					details: makeDetails("single")([result]),
					isError: true,
				};
			}
			return {
				content: [
					{
						type: "text",
						text: lastAssistantText(result.messages) || "(no output)",
					},
				],
				details: makeDetails("single")([result]),
			};
		}

		const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
		return {
			content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
			details: makeDetails("single")([]),
		};
		},

	renderCall(args, theme, _context) {
		if (args.tasks && args.tasks.length > 0) {
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", `parallel (${args.tasks.length} tasks)`);
			for (const t of args.tasks.slice(0, 3)) {
				const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
				text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
			}
			if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
			return new Text(text, 0, 0);
		}
		const agentName = args.agent || "...";
		const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
		let text =
			theme.fg("toolTitle", theme.bold("subagent ")) +
			theme.fg("accent", agentName);
		text += `\n  ${theme.fg("dim", preview)}`;
		return new Text(text, 0, 0);
	},

	renderResult(result, { expanded }, theme, _context) {
		const details = result.details as SubagentDetails | undefined;
		if (!details || details.results.length === 0) {
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		}

		const mdTheme = getMarkdownTheme();

		const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
			const toShow = limit ? items.slice(-limit) : items;
			const skipped = limit && items.length > limit ? items.length - limit : 0;
			let text = "";
			if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
			for (const item of toShow) {
				if (item.type === "text") {
					const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
					text += `${theme.fg("toolOutput", preview)}\n`;
				} else {
					text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
				}
			}
			return text.trimEnd();
		};

		if (details.mode === "single" && details.results.length === 1) {
			const r = details.results[0];
			const isError = isFailedResult(r);
			const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
			const displayItems = getDisplayItems(r.messages);
			const finalOutput = lastAssistantText(r.messages);

			if (expanded) {
				const container = new Container();
				let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				container.addChild(new Text(header, 0, 0));
				if (isError && r.errorMessage)
					container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
				container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
				if (displayItems.length === 0 && !finalOutput) {
					container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
				} else {
					for (const item of displayItems) {
						if (item.type === "toolCall")
							container.addChild(
								new Text(
									theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
									0,
									0,
								),
							);
					}
					if (finalOutput) {
						container.addChild(new Spacer(1));
						container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
					}
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
				}
				return container;
			}

			let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
			if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
			if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
			else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
			else {
				text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
				if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
			}
			const usageStr = formatUsageStats(r.usage, r.model);
			if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
			return new Text(text, 0, 0);
		}

		const aggregateUsage = (results: SingleResult[]) => {
			const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
			for (const r of results) {
				total.input += r.usage.input;
				total.output += r.usage.output;
				total.cacheRead += r.usage.cacheRead;
				total.cacheWrite += r.usage.cacheWrite;
				total.cost += r.usage.cost;
				total.turns += r.usage.turns;
			}
			return total;
		};


		if (details.mode === "parallel") {
			const running = details.results.filter((r) => r.exitCode === -1).length;
			const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
			const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
			const isRunning = running > 0;
			const icon = isRunning
				? theme.fg("warning", "⏳")
				: failCount > 0
					? theme.fg("warning", "◐")
					: theme.fg("success", "✓");
			const status = isRunning
				? `${successCount + failCount}/${details.results.length} done, ${running} running`
				: `${successCount}/${details.results.length} tasks`;

			if (expanded && !isRunning) {
				const container = new Container();
				container.addChild(
					new Text(
						`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
						0,
						0,
					),
				);

				for (const r of details.results) {
					const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					const finalOutput = lastAssistantText(r.messages);

					container.addChild(new Spacer(1));
					container.addChild(
						new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
					);
					container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

					// Show tool calls
					for (const item of displayItems) {
						if (item.type === "toolCall") {
							container.addChild(
								new Text(
									theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
									0,
									0,
								),
							);
						}
					}

					// Show final output as markdown
					if (finalOutput) {
						container.addChild(new Spacer(1));
						container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
					}

					const taskUsage = formatUsageStats(r.usage, r.model);
					if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
				}

				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
				}
				return container;
			}

			// Collapsed view (or still running)
			let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
			for (const r of details.results) {
				const rIcon =
					r.exitCode === -1
						? theme.fg("warning", "⏳")
						: isFailedResult(r)
							? theme.fg("error", "✗")
							: theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
				if (displayItems.length === 0)
					text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
				else text += `\n${renderDisplayItems(displayItems, 5)}`;
			}
			if (!isRunning) {
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
			}
			if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
			return new Text(text, 0, 0);
		}

		const text = result.content[0];
		return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
	},
});
