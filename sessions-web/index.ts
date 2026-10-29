/**
 * Sessions Web Viewer
 *
 * Read-only web viewer over local pi session history. Registers the
 * /session-web command, which starts an HTTP server bound to 127.0.0.1:
 *
 *   /              session list, sorted by last activity, keyword filter
 *   /session/:id   full message stream rendered with pi's HTML export template
 *
 * Usage:
 *   pi --extension ./examples/extensions/session-web
 *   /session-web [port]   start the viewer (default port 8765)
 *   /session-web stop     stop the server
 *
 * The server is read-only: it never writes, resumes, edits, or deletes
 * sessions, and it listens on localhost only.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { startSessionWebServer, stopSessionWebServer } from "./src/server.ts";

export const DEFAULT_PORT = 8765;

export default function sessionsWebExtension(pi: ExtensionAPI) {
	pi.registerCommand("session-web", {
		description: "Start a read-only web viewer for local session history",
		handler: async (args, ctx) => {
			const arg = args.trim();

			if (arg === "stop") {
				const stopped = stopSessionWebServer();
				ctx.ui.notify(stopped ? "session-web: server stopped" : "session-web: server is not running", "info");
				return;
			}

			const port = arg ? Number.parseInt(arg, 10) : DEFAULT_PORT;
			if (!Number.isInteger(port) || port < 0 || port > 65535) {
				ctx.ui.notify(`session-web: invalid port "${arg}"`, "error");
				return;
			}

			try {
				const url = await startSessionWebServer(port);
				ctx.ui.notify(`session-web: ${url}`, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`session-web: ${message}`, "error");
			}
		},
	});

	// Close the server when the session ends, so no socket outlives the run.
	pi.on("session_shutdown", async () => {
		stopSessionWebServer();
	});
}
