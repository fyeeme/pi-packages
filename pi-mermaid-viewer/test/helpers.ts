import { vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// ============================================================================
// Session-entry constructors (for extractMermaidBlocks)
// ============================================================================

let nextId = 0;
const uid = (prefix: string) => `${prefix}-${++nextId}`;

export function textContentBlock(text: string) {
	return { type: "text" as const, text };
}

export function imageContentBlock() {
	return { type: "image" as const, source: { data: "abc", media_type: "image/png" } };
}

export function assistantMessage(content: Array<{ type: string; text?: string }>) {
	return {
		role: "assistant" as const,
		content,
		timestamp: new Date().toISOString(),
	};
}

export function userMessage(text: string) {
	return {
		role: "user" as const,
		content: [textContentBlock(text)],
		timestamp: new Date().toISOString(),
	};
}

export function messageEntry(message: { role: string; content: unknown; timestamp: string }) {
	return {
		type: "message" as const,
		id: uid("msg"),
		parentId: null,
		timestamp: message.timestamp,
		message,
	};
}

export function customEntry(customType: string, data?: unknown) {
	return {
		type: "custom" as const,
		id: uid("custom"),
		parentId: null,
		timestamp: new Date().toISOString(),
		customType,
		data,
	};
}

/** Build a minimal mock ExtensionCommandContext for testing extractMermaidBlocks. */
export function mockCtx(entries: Array<{ type: string; message?: unknown }>): ExtensionCommandContext {
	return {
		sessionManager: {
			getEntries: () => entries,
		},
		ui: { notify: vi.fn() },
		hasUI: true,
		cwd: "/test",
	} as unknown as ExtensionCommandContext;
}

// ============================================================================
// node --check sandbox
// ============================================================================
// The viewer injects authored functions (quoteBareLabels) and a generated
// module script into the browser page. These tests verify the serialized JS
// still parses. Files land in one per-suite temp dir removed in afterAll —
// never accumulate in os.tmpdir() across runs.

export function nodeCheckSandbox() {
	const dir = mkdtempSync(join(tmpdir(), "mvw-check-"));
	let n = 0;
	return {
		/** Writes src to a temp .js file and asserts it parses via `node --check`. */
		check(src: string): void {
			const file = join(dir, `check-${++n}.js`);
			writeFileSync(file, src);
			execFileSync("node", ["--check", file]);
		},
		cleanup(): void {
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
