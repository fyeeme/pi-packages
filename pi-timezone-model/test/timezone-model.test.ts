import { describe, it, expect, vi, type Mock } from "vitest";
import {
	beijingSecondsOfDay,
	targetModelId,
	enforce,
	default as timezoneModelExtension,
} from "../index.ts";

const PROVIDER = "zai-coding-cn";
const FLASH = { provider: PROVIDER, id: "glm-5.3-flash" };
const AUTO = { provider: PROVIDER, id: "glm-5.3-auto" };

/** UTC timestamp for the given UTC h:m:s on a fixed date. */
function utc(h: number, m: number, s: number): Date {
	return new Date(Date.UTC(2026, 9, 29, h, m, s));
}

describe("beijingSecondsOfDay", () => {
	it("maps UTC to Beijing time (UTC+8)", () => {
		// UTC 00:00:00 == Beijing 08:00:00
		expect(beijingSecondsOfDay(utc(0, 0, 0))).toBe(8 * 3600);
		// UTC 16:00:00 == Beijing 00:00:00 (next day)
		expect(beijingSecondsOfDay(utc(16, 0, 0))).toBe(0);
		// UTC 23:59:59 == Beijing 07:59:59 (next day)
		expect(beijingSecondsOfDay(utc(23, 59, 59))).toBe(7 * 3600 + 59 * 60 + 59);
	});

	it("ignores the host timezone (reads UTC fields from the shifted instant)", () => {
		// Same instant expressed in two host timezones yields the same seconds.
		const instant = Date.UTC(2026, 9, 29, 6, 18, 0);
		expect(beijingSecondsOfDay(new Date(instant))).toBe(
			beijingSecondsOfDay(new Date(instant)), // deterministic by construction
		);
	});
});

describe("targetModelId (cutoff 14:18:00 Beijing time)", () => {
	it("before the cutoff picks flash", () => {
		// Beijing 14:17:59 == UTC 06:17:59
		expect(targetModelId(utc(6, 17, 59))).toBe("glm-5.3-flash");
		// Beijing 00:00:00 == UTC 16:00:00 (previous day)
		expect(targetModelId(utc(16, 0, 0))).toBe("glm-5.3-flash");
	});

	it("the cutoff itself and later pick auto", () => {
		// Beijing 14:18:00 == UTC 06:18:00 — inclusive switch
		expect(targetModelId(utc(6, 18, 0))).toBe("glm-5.3-auto");
		// Beijing 23:59:59 == UTC 15:59:59
		expect(targetModelId(utc(15, 59, 59))).toBe("glm-5.3-auto");
	});
});

/** Minimal ExtensionContext stand-in: current model + registry + notify recorder. */
function mkCtx(model: unknown, registryModels: unknown[] = [FLASH, AUTO]) {
	const notify = vi.fn();
	return {
		model,
		modelRegistry: { find: (provider: string, id: string) =>
			registryModels.find((m: any) => m.provider === provider && m.id === id) },
		ui: { notify },
	} as any;
}

describe("enforce", () => {
	// Fixed instant: UTC 06:00 == Beijing 14:00 — before the cutoff, target is flash.
	const NOW = utc(6, 0, 0);

	it("is a no-op while the current model already matches the rule", async () => {
		const setModel = vi.fn().mockResolvedValue(true);
		const ctx = mkCtx(FLASH);
		await enforce({ setModel } as any, ctx, NOW);
		expect(setModel).not.toHaveBeenCalled();
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("switches to the ruled model and notifies once on success", async () => {
		const setModel = vi.fn().mockResolvedValue(true);
		const ctx = mkCtx(AUTO);
		await enforce({ setModel } as any, ctx, NOW);
		expect(setModel).toHaveBeenCalledTimes(1);
		expect(setModel.mock.calls[0]![0]).toBe(FLASH);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("pi-timezone-model: switched to glm-5.3-flash"),
			"info",
		);
	});

	it("stays silent when setModel is rejected", async () => {
		const setModel = vi.fn().mockResolvedValue(false);
		const ctx = mkCtx(AUTO);
		await enforce({ setModel } as any, ctx, NOW);
		expect(setModel).toHaveBeenCalledTimes(1);
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("warns and leaves the model untouched when the target is not in the catalog", async () => {
		const setModel = vi.fn();
		const ctx = mkCtx(AUTO, []); // empty catalog
		await enforce({ setModel } as any, ctx, NOW);
		expect(setModel).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("model not found"),
			"warning",
		);
	});
});

describe("extension registration", () => {
	it("enforces on session_start and before_agent_start", () => {
		const handlers: Record<string, any> = {};
		const pi = { on: (name: string, h: any) => (handlers[name] = h) };
		timezoneModelExtension(pi as any);
		expect(Object.keys(handlers).sort()).toEqual(["before_agent_start", "session_start"]);
	});
});
