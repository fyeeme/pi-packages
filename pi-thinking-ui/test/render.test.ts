import { beforeEach, describe, expect, it } from "vitest";
import { ThinkingUIComponent, renderThinkingUILines } from "../render.ts";
import { deriveThinkingUI } from "../parse.ts";
import { resetThinkingUIViewState, setActiveThinkingState, setThinkingUIMode } from "../state.ts";
import type { ThinkingThemeLike } from "../types.ts";

// A recording theme: it wraps text in XML-ish tags so assertions can inspect
// structure without depending on ANSI escape codes.
function recordingTheme(): ThinkingThemeLike {
	return {
		fg(color: string, text: string) {
			return `<${color}>${text}</${color}>`;
		},
		bold(text: string) {
			return `<b>${text}</b>`;
		},
	};
}

const STEPS = deriveThinkingUI([
	{ contentIndex: 0, text: "I need to read packages/foo.ts and inspect the bar() function before editing." },
]);

describe("renderThinkingUILines", () => {
	beforeEach(() => {
		resetThinkingUIViewState();
	});

	it("returns [] when there are no steps", () => {
		expect(renderThinkingUILines(recordingTheme(), 80, { mode: "expanded", steps: [], isActive: false })).toEqual([]);
		expect(renderThinkingUILines(recordingTheme(), 80, { mode: "summary", steps: [] })).toEqual([]);
		expect(renderThinkingUILines(recordingTheme(), 80, { mode: "collapsed", steps: [], isActive: false })).toEqual([]);
	});

	it("collapsed mode renders a single thinking line with the summary", () => {
		setThinkingUIMode("collapsed");
		const lines = renderThinkingUILines(recordingTheme(), 100, { mode: "collapsed", steps: STEPS, isActive: false });
		expect(lines.length).toBeGreaterThanOrEqual(1);
		const joined = lines.join("\n");
		expect(joined).toContain("Thinking");
		expect(joined).toContain("packages/foo.ts");
	});

	it("summary mode renders a header line plus one line per visible step", () => {
		setThinkingUIMode("summary");
		const lines = renderThinkingUILines(recordingTheme(), 100, { mode: "summary", steps: STEPS });
		expect(lines[0]).toContain("Thinking UI · Summary");
		expect(lines.length).toBeGreaterThanOrEqual(2);
	});

	it("expanded mode renders a header and includes the step body", () => {
		setThinkingUIMode("expanded");
		const lines = renderThinkingUILines(recordingTheme(), 200, { mode: "expanded", steps: STEPS });
		expect(lines[0]).toContain("Thinking UI · Expanded");
		// The raw body text is wrapped into the expanded view.
		expect(lines.join("\n")).toContain("packages/foo.ts");
	});
});

describe("ThinkingUIComponent", () => {
	beforeEach(() => {
		resetThinkingUIViewState();
	});

	it("render() returns the lines for the current mode", () => {
		setThinkingUIMode("summary");
		const component = new ThinkingUIComponent(recordingTheme(), 42, [
			{ contentIndex: 0, text: "I need to read packages/foo.ts before editing." },
		]);
		const lines = component.render(100);
		expect(lines.length).toBeGreaterThan(0);
		expect(lines.join("\n")).toContain("Thinking UI · Summary");
	});

	it("caches rendered lines across identical render() calls", () => {
		setThinkingUIMode("summary");
		const component = new ThinkingUIComponent(recordingTheme(), 42, [
			{ contentIndex: 0, text: "step text" },
		]);
		const first = component.render(100);
		const second = component.render(100);
		expect(second).toBe(first);
	});

	it("invalidate() drops the cache so the next render recomputes", () => {
		setThinkingUIMode("summary");
		const component = new ThinkingUIComponent(recordingTheme(), 42, [
			{ contentIndex: 0, text: "step text" },
		]);
		const first = component.render(100);
		component.invalidate();
		const second = component.render(100);
		expect(Array.isArray(second)).toBe(true);
		// Same content, but a freshly built array (not the same reference).
		expect(second).not.toBe(first);
		expect(second).toEqual(first);
	});

	it("collapsed + active bypasses the cache so the spinner can animate", () => {
		setThinkingUIMode("collapsed");
		const component = new ThinkingUIComponent(recordingTheme(), 42, [
			{ contentIndex: 0, text: "I need to inspect the bar() function." },
		]);
		setActiveThinkingState({ active: true, messageTimestamp: 42, contentIndex: 0 });
		const first = component.render(100);
		const second = component.render(100);
		expect(second).not.toBe(first);
	});
});
