import { describe, expect, it } from "vitest";
import { startOfCurrentWeekLocal, startOfNextWeekLocal } from "../week.ts";

describe("startOfCurrentWeekLocal", () => {
	it("returns Monday 00:00 local for a mid-week date", () => {
		// Friday 2026-06-19 10:30 (local)
		const start = new Date(startOfCurrentWeekLocal(new Date("2026-06-19T10:30:00")));
		expect(start.getDay()).toBe(1); // Monday
		expect(start.getHours()).toBe(0);
		expect(start.getMinutes()).toBe(0);
		expect(start.getSeconds()).toBe(0);
	});

	it("maps Sunday to the preceding Monday", () => {
		// Sunday 2026-06-21 → week started 2026-06-15
		const start = new Date(startOfCurrentWeekLocal(new Date("2026-06-21T08:00:00")));
		expect(start.getDay()).toBe(1);
		expect(start.getDate()).toBe(15);
	});

	it("maps Saturday to the same Monday", () => {
		const start = new Date(startOfCurrentWeekLocal(new Date("2026-06-20T23:59:00")));
		expect(start.getDay()).toBe(1);
		expect(start.getDate()).toBe(15);
	});

	it("returns the same Monday when called on a Monday", () => {
		const start = new Date(startOfCurrentWeekLocal(new Date("2026-06-15T03:00:00")));
		expect(start.getDay()).toBe(1);
		expect(start.getDate()).toBe(15);
	});
});

describe("startOfNextWeekLocal", () => {
	it("is exactly 7 days after the current week start", () => {
		const now = new Date("2026-06-19T10:30:00");
		const cur = startOfCurrentWeekLocal(now);
		const next = startOfNextWeekLocal(now);
		expect(next - cur).toBe(7 * 24 * 60 * 60 * 1000);
	});

	it("lands on the following Monday 00:00 local", () => {
		const next = new Date(startOfNextWeekLocal(new Date("2026-06-19T10:30:00")));
		expect(next.getDay()).toBe(1);
		expect(next.getDate()).toBe(22);
	});
});
