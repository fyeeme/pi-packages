import { exec } from "node:child_process";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export function openInBrowser(path: string, ctx: ExtensionCommandContext): void {
  const cmd =
    process.platform === "win32"
      ? "start"
      : process.platform === "linux"
        ? "xdg-open"
        : "open";
  exec(`${cmd} "${path}"`, (err) => {
    if (err) {
      ctx.ui.notify(`Failed to open browser: ${err.message}`, "error");
    } else {
      ctx.ui.notify("Opened in browser!", "info");
    }
  });
}
