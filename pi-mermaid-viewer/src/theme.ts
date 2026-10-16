import { execSync } from "node:child_process";

export function parseGnomeColorScheme(out: string): "dark" | "light" {
  return out.includes("prefer-dark") ? "dark" : "light";
}

export function parseWindowsLightTheme(out: string): "dark" | "light" {
  // "AppsUseLightTheme    REG_DWORD    0x1" → light; 0x0 → dark; missing → light.
  const m = out.match(/AppsUseLightTheme\s+REG_DWORD\s+0x(\d)/i);
  return m && m[1] === "0" ? "dark" : "light";
}

export function detectSystemTheme(): "dark" | "light" {
  try {
    if (process.platform === "darwin") {
      const out = execSync("defaults read -g AppleInterfaceStyle 2>/dev/null")
        .toString()
        .trim();
      return out === "Dark" ? "dark" : "light";
    }
    if (process.platform === "linux") {
      const out = execSync(
        "gsettings get org.gnome.desktop.interface color-scheme 2>/dev/null",
      )
        .toString()
        .trim();
      return parseGnomeColorScheme(out);
    }
    if (process.platform === "win32") {
      const out = execSync(
        'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize" /v AppsUseLightTheme 2> nul',
      ).toString();
      return parseWindowsLightTheme(out);
    }
  } catch {
    /* unknown → light */
  }
  return "light";
}
