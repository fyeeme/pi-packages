import { describe, expect, it } from "vitest";
import { parseGnomeColorScheme, parseWindowsLightTheme } from "../index.ts";

// Theme parsing is pure string → "dark" | "light" over real command output
// shapes (gsettings / reg query), including the failure shapes (unknown key,
// missing value).

describe("parseGnomeColorScheme", () => {
	it.each([
		{ out: "'prefer-dark'\n", want: "dark" },
		{ out: "'prefer-contrast'\n", want: "light" },
		{ out: "", want: "light" },
	])("$out → $want", ({ out, want }) => {
		expect(parseGnomeColorScheme(out)).toBe(want);
	});
});

describe("parseWindowsLightTheme", () => {
	it.each([
		{ out: "AppsUseLightTheme    REG_DWORD    0x0", want: "dark" },
		{ out: "AppsUseLightTheme    REG_DWORD    0x1", want: "light" },
		{ out: "ERROR: The system was unable to find the specified registry key.", want: "light" },
	])("0x/missing → $want", ({ out, want }) => {
		expect(parseWindowsLightTheme(out)).toBe(want);
	});
});
