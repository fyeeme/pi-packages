import { exec } from "node:child_process";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export function openInBrowser(path: string, ctx: ExtensionCommandContext): void {
  // cmd.exe `start` treats the first quoted argument as the new window's
  // title, so an empty title placeholder must precede the quoted path.
  const command =
    process.platform === "win32"
      ? `start "" "${path}"`
      : `${process.platform === "linux" ? "xdg-open" : "open"} "${path}"`;
  exec(command, (err) => {
    if (err) {
      ctx.ui.notify(`Failed to open browser: ${err.message}`, "error");
    } else {
      ctx.ui.notify("Opened in browser!", "info");
    }
  });
}
