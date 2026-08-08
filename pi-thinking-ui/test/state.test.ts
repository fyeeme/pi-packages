import { beforeEach, describe, expect, it } from "vitest";
import {
	getCurrentThinkingScopeKey,
	getThinkingUIMode,
	nextThinkingRefreshLabel,
	resetThinkingUIViewState,
	setCurrentThinkingScopeKey,
	setThinkingUIMode,
} from "../state.ts";

// state.ts keeps a singleton store on globalThis (keyed by a well-known
// Symbol) so module reloads share state. resetThinkingUIViewState() restores
// the mode/refresh slices.

describe("thinking-ui state — scope key + default mode", () => {
	beforeEach(() => {
		resetThinkingUIViewState();
	});

	it("defaults the current scope key to the default bucket", () => {
		expect(getCurrentThinkingScopeKey()).toBe("__default__");
	});

	it("defaults to collapsed mode", () => {
		expect(getThinkingUIMode()).toBe("collapsed");
	});

	it("set/get round-trips the mode for the current scope", () => {
		setThinkingUIMode("expanded");
		expect(getThinkingUIMode()).toBe("expanded");
		setThinkingUIMode("collapsed");
		expect(getThinkingUIMode()).toBe("collapsed");
	});

	it("switching scope resets to collapsed for that scope", () => {
		setThinkingUIMode("expanded");
		setCurrentThinkingScopeKey("/proj/a");
		expect(getThinkingUIMode()).toBe("collapsed");
		expect(getThinkingUIMode("__default__")).toBe("expanded");
	});

	it("modes are isolated per scope", () => {
		setThinkingUIMode("expanded", "__default__");
		setThinkingUIMode("collapsed", "/proj/a");
		expect(getThinkingUIMode("__default__")).toBe("expanded");
		expect(getThinkingUIMode("/proj/a")).toBe("collapsed");
	});
});

describe("thinking-ui state — refresh label toggle", () => {
	beforeEach(() => {
		resetThinkingUIViewState();
	});

	it("toggles an invisible suffix on repeated calls within a scope", () => {
		setCurrentThinkingScopeKey("/proj/a");
		const first = nextThinkingRefreshLabel("Thinking...", "/proj/a");
		const second = nextThinkingRefreshLabel("Thinking...", "/proj/a");
		expect(first).toBe("Thinking...");
		expect(second.startsWith("Thinking...")).toBe(true);
		expect(second.length).toBeGreaterThan(first.length);
	});
});

describe("thinking-ui state — full reset", () => {
	it("restores the default scope and collapsed mode", () => {
		setCurrentThinkingScopeKey("/proj/a");
		setThinkingUIMode("expanded", "/proj/a");
		resetThinkingUIViewState();
		expect(getCurrentThinkingScopeKey()).toBe("__default__");
		expect(getThinkingUIMode()).toBe("collapsed");
	});
});
