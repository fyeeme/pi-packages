/**
 * HTTP server for the session-web extension.
 *
 * Routes (GET only):
 *   /                session list page (sidebar + welcome pane)
 *   /session/:id     session detail: chat view (default) or ?view=trace
 *
 * Security:
 * - Binds to 127.0.0.1 only; no remote access.
 * - Session ids are resolved through a filename suffix match against the
 *   sessions directory, so URL segments never reach the filesystem directly.
 */

import { existsSync, readdirSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { getAgentDir, type SessionInfo, SessionManager } from "@earendil-works/pi-coding-agent";
import {
	loadStaticScript,
	renderErrorPage,
	renderListPage,
	renderSessionFragment,
	renderSessionPage,
} from "./views.ts";

const HOST = "127.0.0.1";
const SESSION_LIST_TTL_MS = 30_000;

let server: Server | null = null;
let boundUrl: string | null = null;
let sessionCache: { at: number; sessions: SessionInfo[] } | null = null;

export function getSessionWebUrl(): string | null {
	return boundUrl;
}

export function stopSessionWebServer(): boolean {
	if (!server) return false;
	const closing = server;
	server = null;
	boundUrl = null;
	closing.close();
	closing.closeAllConnections();
	return true;
}

function listen(server: Server, port: number): Promise<number> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error): void => {
			server.removeListener("error", onError);
			reject(error);
		};
		server.once("error", onError);
		server.listen(port, HOST, () => {
			server.removeListener("error", onError);
			const address = server.address();
			if (address === null || typeof address === "string") {
				reject(new Error(`Unexpected listen address: ${String(address)}`));
				return;
			}
			resolve(address.port);
		});
	});
}

/**
 * Start the server (idempotent: returns the existing URL if already running).
 * Port 0 picks a free ephemeral port.
 */
export async function startSessionWebServer(port: number): Promise<string> {
	if (server && boundUrl) return boundUrl;

	const newServer = createServer((request, response) => {
		void handleRequest(request, response);
	});
	// Keep socket errors from crashing the host pi process.
	newServer.on("error", (error) => {
		console.error(`session-web: server error: ${error.message}`);
	});

	const actualPort = await listen(newServer, port);
	server = newServer;
	boundUrl = `http://${HOST}:${actualPort}/`;
	return boundUrl;
}

/** Session list with a short TTL so sidebar navigation stays cheap. */
async function listSessions(): Promise<SessionInfo[]> {
	if (sessionCache && Date.now() - sessionCache.at < SESSION_LIST_TTL_MS) {
		return sessionCache.sessions;
	}
	const sessions = await SessionManager.listAll();
	sessionCache = { at: Date.now(), sessions };
	return sessions;
}

/** Find the JSONL file for a session id by scanning sessions subdirectories. */
function findSessionFileById(id: string): string | undefined {
	const sessionsDir = join(getAgentDir(), "sessions");
	if (!existsSync(sessionsDir)) return undefined;

	let found: string | undefined;
	for (const entry of readdirSync(sessionsDir, { withFileTypes: true })) {
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
		const dir = join(sessionsDir, entry.name);
		let files: string[];
		try {
			files = readdirSync(dir);
		} catch {
			continue;
		}
		// File names are {timestamp}_{sessionId}.jsonl; newest timestamp wins.
		const matches = files.filter((file) => file.endsWith(`_${id}.jsonl`)).sort();
		const last = matches[matches.length - 1];
		if (last) found = join(dir, last);
	}
	return found;
}

function sendHtml(response: ServerResponse, status: number, html: string): void {
	// Pages are cheap to rebuild and change with the extension; never let the
	// browser serve a stale copy from heuristic caching.
	response.writeHead(status, {
		"content-type": "text/html; charset=utf-8",
		"cache-control": "no-store",
	});
	response.end(html);
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
	let url: URL;
	try {
		url = new URL(request.url ?? "/", `http://${HOST}`);
	} catch {
		sendHtml(response, 400, renderErrorPage("Bad request", "Could not parse the request URL."));
		return;
	}

	if (request.method !== "GET") {
		response.writeHead(405, { allow: "GET" });
		response.end();
		return;
	}

	if (url.pathname === "/favicon.ico") {
		response.writeHead(204);
		response.end();
		return;
	}

	try {
		if (url.pathname === "/" || url.pathname === "/index.html") {
			const query = url.searchParams.get("q") ?? "";
			const sessions = await listSessions();
			sendHtml(response, 200, renderListPage(sessions, query, new Date()));
			return;
		}

		const sessionMatch = /^\/session\/([^/]+)$/.exec(url.pathname);
		if (sessionMatch) {
			const id = decodeURIComponent(sessionMatch[1] ?? "");
			// Ids are UUID-shaped; reject anything else before touching the filesystem.
			if (!/^[a-zA-Z0-9-]{8,64}$/.test(id)) {
				sendHtml(response, 404, renderErrorPage("Session not found", `Invalid session id: ${id}`));
				return;
			}
			const file = findSessionFileById(id);
			if (!file) {
				sendHtml(response, 404, renderErrorPage("Session not found", `No session file matches id ${id}.`));
				return;
			}
			const view = url.searchParams.get("view") === "trace" ? "trace" : "chat";
			const staticScripts = {
				marked: loadStaticScript("marked"),
				highlight: loadStaticScript("highlight"),
			};
			if (url.searchParams.get("fragment") === "1") {
				// Bare view fragment for the SPA tab switcher; no shell, no sidebar.
				sendHtml(response, 200, renderSessionFragment(SessionManager.open(file), view));
				return;
			}
			const sessions = await listSessions();
			const html = renderSessionPage(SessionManager.open(file), view, staticScripts, sessions, new Date());
			sendHtml(response, 200, html);
			return;
		}

		sendHtml(response, 404, renderErrorPage("Not found", `No route matches ${url.pathname}.`));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`session-web: request failed: ${message}`);
		sendHtml(response, 500, renderErrorPage("Request failed", message));
	}
}
