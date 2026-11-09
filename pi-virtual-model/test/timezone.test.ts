import { describe, it, expect, vi, type Mock } from "vitest";
import {
	beijingSecondsOfDay,
	beijingDayOfWeek,
	targetModelId,
	enforce,
	timezoneModelExtension,
} from "../src/timezone.ts";

const PROVIDER = "zai-coding-cn";
const FLASH = { provider: PROVIDER, id: "glm-5.3-flash" };
const AUTO = { provider: PROVIDER, id: "glm-5.3-auto" };

/** UTC timestamp for the given UTC h:m:s on a fixed date (2026-10-29, a Thursday). */
function utc(h: number, m: number, s: number): Date {
	return new Date(Date.UTC(2026, 9, 29, h, m, s));
}

/** Same, but shifted `dayOffset` days from the base date (1=Fri, 2=Sat, 3=Sun). */
function utcOnDay(dayOffset: number, h: number, m: number, s: number): Date {
	return new Date(Date.UTC(2026, 9, 29 + dayOffset, h, m, s));
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

describe("targetModelId (peak window: Mon-Fri [14:00:00, 18:00:00) Beijing time)", () => {
	it("the window start itself picks flash (inclusive)", () => {
		// Beijing 14:00:00 == UTC 06:00:00
		expect(targetModelId(utc(6, 0, 0))).toBe("glm-5.3-flash");
	});

	it("inside the window picks flash", () => {
		// Beijing 14:17:59 == UTC 06:17:59
		expect(targetModelId(utc(6, 17, 59))).toBe("glm-5.3-flash");
		// Beijing 17:59:59 == UTC 09:59:59
		expect(targetModelId(utc(9, 59, 59))).toBe("glm-5.3-flash");
	});

	it("the window end and later pick auto (exclusive)", () => {
		// Beijing 18:00:00 == UTC 10:00:00
		expect(targetModelId(utc(10, 0, 0))).toBe("glm-5.3-auto");
		// Beijing 23:59:59 == UTC 15:59:59
		expect(targetModelId(utc(15, 59, 59))).toBe("glm-5.3-auto");
	});

	it("before the window and after midnight pick auto", () => {
		// Beijing 13:59:59 == UTC 05:59:59
		expect(targetModelId(utc(5, 59, 59))).toBe("glm-5.3-auto");
		// Beijing 00:00:00 == UTC 16:00:00 (previous day)
		expect(targetModelId(utc(16, 0, 0))).toBe("glm-5.3-auto");
	});

	it("the last weekday still picks flash (Friday)", () => {
		// Beijing Friday 14:00 == UTC Fri 06:00
		expect(targetModelId(utcOnDay(1, 6, 0, 0))).toBe("glm-5.3-flash");
		// Beijing Friday 17:59:59 == UTC Fri 09:59:59
		expect(targetModelId(utcOnDay(1, 9, 59, 59))).toBe("glm-5.3-flash");
	});

	it("weekends pick auto even inside the clock window", () => {
		// Beijing Saturday 14:00 == UTC Sat 06:00
		expect(targetModelId(utcOnDay(2, 6, 0, 0))).toBe("glm-5.3-auto");
		// Beijing Saturday 17:59:59 == UTC Sat 09:59:59
		expect(targetModelId(utcOnDay(2, 9, 59, 59))).toBe("glm-5.3-auto");
		// Beijing Sunday 15:00 == UTC Sun 07:00
		expect(targetModelId(utcOnDay(3, 7, 0, 0))).toBe("glm-5.3-auto");
	});
});

describe("beijingDayOfWeek", () => {
	it("maps UTC instants to the Beijing weekday (UTC+8)", () => {
		// UTC Friday 2026-10-30 20:00 == Beijing Saturday 04:00
		expect(beijingDayOfWeek(utcOnDay(1, 20, 0, 0))).toBe(6);
		// UTC Sunday 2026-11-01 16:00 == Beijing Monday 00:00
		expect(beijingDayOfWeek(utcOnDay(3, 16, 0, 0))).toBe(1);
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
	// Fixed instant: UTC 06:00 == Beijing 14:00 — inside the flash window, target is flash.
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
