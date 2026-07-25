import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearActiveThinkingState,
	clearThinkingMessageOwnership,
	decrementPatchRefCount,
	getActiveThinkingState,
	getCurrentThinkingScopeKey,
	getPatchRefCount,
	getThinkingUIMode,
	incrementPatchRefCount,
	nextThinkingRefreshLabel,
	recordThinkingMessageScope,
	registerThinkingPatchRelease,
	resetThinkingUIViewState,
	resolveThinkingMessageScope,
	setActiveThinkingState,
	setCurrentThinkingScopeKey,
	setThinkingUIMode,
	takeThinkingPatchRelease,
} from "../state.ts";

// state.ts keeps a singleton store on globalThis (keyed by a well-known
// Symbol) so module reloads share state. resetThinkingUIViewState() restores
// the mode/active/refresh/ownership slices; patch counters are normalized
// inline in the tests that touch them.

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

describe("thinking-ui state — active thinking state", () => {
	beforeEach(() => {
		resetThinkingUIViewState();
	});

	it("is inactive by default", () => {
		expect(getActiveThinkingState()).toEqual({ active: false });
	});

	it("records and retrieves an active entry by timestamp", () => {
		setCurrentThinkingScopeKey("/proj/a");
		setActiveThinkingState({ active: true, messageTimestamp: 123, contentIndex: 2 }, "/proj/a");
		expect(getActiveThinkingState(123, "/proj/a")).toEqual({ active: true, messageTimestamp: 123, contentIndex: 2 });
	});

	it("clears a specific timestamp", () => {
		setCurrentThinkingScopeKey("/proj/a");
		setActiveThinkingState({ active: true, messageTimestamp: 123 }, "/proj/a");
		clearActiveThinkingState(123, "/proj/a");
		expect(getActiveThinkingState(123, "/proj/a")).toEqual({ active: false });
	});

	it("clears an entire scope", () => {
		setCurrentThinkingScopeKey("/proj/a");
		setActiveThinkingState({ active: true, messageTimestamp: 123 }, "/proj/a");
		clearActiveThinkingState(undefined, "/proj/a");
		expect(getActiveThinkingState(123, "/proj/a")).toEqual({ active: false });
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

describe("thinking-ui state — message scope ownership", () => {
	beforeEach(() => {
		resetThinkingUIViewState();
	});

	it("records and resolves the owning scope for a message object", () => {
		setCurrentThinkingScopeKey("/proj/a");
		const message = { timestamp: 999 };
		recordThinkingMessageScope(message, "/proj/a");
		expect(resolveThinkingMessageScope(message, "__default__")).toBe("/proj/a");
	});

	it("falls back when no ownership is recorded", () => {
		const message = { timestamp: 999 };
		expect(resolveThinkingMessageScope(message, "__default__")).toBe("__default__");
	});

	it("clears ownership for a scope and falls back to the fallback key", () => {
		setCurrentThinkingScopeKey("/proj/a");
		const message = { timestamp: 999 };
		recordThinkingMessageScope(message, "/proj/a");
		clearThinkingMessageOwnership("/proj/a");
		expect(resolveThinkingMessageScope(message, "__default__")).toBe("__default__");
	});
});

describe("thinking-ui state — patch ref counting", () => {
	// patchRefCount is a singleton counter; clamp it to zero before the test.
	beforeEach(() => {
		while (getPatchRefCount() > 0) decrementPatchRefCount();
	});

	it("counts up and down, clamped at zero", () => {
		expect(getPatchRefCount()).toBe(0);
		expect(incrementPatchRefCount()).toBe(1);
		expect(incrementPatchRefCount()).toBe(2);
		expect(decrementPatchRefCount()).toBe(1);
		expect(decrementPatchRefCount()).toBe(0);
		expect(decrementPatchRefCount()).toBe(0);
	});
});

describe("thinking-ui state — patch release stack", () => {
	// Use a unique scope per test so the LIFO stack is isolated.
	it("pushes and pops release callbacks LIFO", () => {
		const scope = "/release-test-1";
		const first = vi.fn(async () => {});
		const second = vi.fn(async () => {});
		registerThinkingPatchRelease(scope, first);
		registerThinkingPatchRelease(scope, second);
		expect(takeThinkingPatchRelease(scope)).toBe(second);
		expect(takeThinkingPatchRelease(scope)).toBe(first);
		expect(takeThinkingPatchRelease(scope)).toBeUndefined();
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
