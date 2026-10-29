/**
 * HTML rendering for the session-web extension.
 *
 * Layout mirrors a desktop session browser: a resizable sidebar (max 450px)
 * with sessions grouped by project directory, and a main pane that renders
 * either the conversation view (default) or a raw entry timeline
 * (?view=trace). Light/dark theme with light as the default; both persist
 * via localStorage.
 *
 * Markdown and code highlighting are rendered client-side with pi's vendored
 * marked and highlight.js, inlined into the page.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	getPackageDir,
	type SessionEntry,
	type SessionHeader,
	type SessionInfo,
	type SessionManager,
	type SessionTreeNode,
} from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Themes (CSS custom properties; light is the default)
// ---------------------------------------------------------------------------

/**
 * Palette sources: pi themes resolved to hex offline via colorToHex
 * semantics — src/modes/interactive/theme/{light,dark}.json. okhsl()
 * strings cannot be used in browser CSS, so they are baked to hex.
 */
const THEME_VARS = `
:root, :root[data-theme="light"] {
  color-scheme: light;
  --page-bg: #efeeee;
  --sidebar-bg: #e1e3e4;
  --card-bg: #f7f6f6;
  --hover: #dfe7ec;
  --border: #d9dcde;
  --text: #3b3f41;
  --muted: #677176;
  --dim: #879095;
  --accent: #7459b4;
  --link: #2f7899;
  --user-bubble: #dfe7ec;
  --selected-text: #2b4a5e;
  --success: #337e58;
  --error: #c8253d;
  --tool-bg: #e9eaeb;
  --code-bg: #f7f6f6;
  --md-code: #7459b4;
  --syntax-comment: #677176;
  --syntax-keyword: #2f7899;
  --syntax-function: #8f6802;
  --syntax-variable: #287a81;
  --syntax-string: #a45417;
  --syntax-number: #337e58;
  --syntax-type: #7459b4;
  --syntax-operator: #677176;
  --syntax-punctuation: #677176;
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --page-bg: #0f1a21;
  --sidebar-bg: #13222b;
  --card-bg: #16262e;
  --hover: #1c3441;
  --border: #24363f;
  --text: #dee0e1;
  --muted: #9da5a9;
  --dim: #6d7a81;
  --accent: #a798d7;
  --link: #69add0;
  --user-bubble: #213b49;
  --selected-text: #ffffff;
  --success: #68b78d;
  --error: #ea7f81;
  --tool-bg: #1a2c36;
  --code-bg: #0b141a;
  --md-code: #a798d7;
  --syntax-comment: #9da5a9;
  --syntax-keyword: #69add0;
  --syntax-function: #cd9a22;
  --syntax-variable: #5db3ba;
  --syntax-string: #de8d5a;
  --syntax-number: #68b78d;
  --syntax-type: #a798d7;
  --syntax-operator: #9da5a9;
  --syntax-punctuation: #9da5a9;
}
`;

const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 450;
const SIDEBAR_DEFAULT_WIDTH = 300;
const THEME_STORAGE_KEY = "pi-session-web:theme";
const SIDEBAR_WIDTH_STORAGE_KEY = "pi-session-web:sidebar-width";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function formatDateTime(date: Date): string {
	return `${date.toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

function formatRelative(date: Date, now: Date): string {
	const seconds = Math.round((now.getTime() - date.getTime()) / 1000);
	if (seconds < 60) return "刚刚";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes} 分钟前`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} 小时前`;
	const days = Math.round(hours / 24);
	if (days < 30) return `${days} 天前`;
	const months = Math.round(days / 30);
	if (months < 12) return `${months} 个月前`;
	return `${Math.round(months / 12)} 年前`;
}

function truncate(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

type MessageLike = { content: string | Array<{ type: string; text?: string }> };

/** Extract plain text from user/assistant/toolResult message content. */
function messageText(message: MessageLike): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n");
}

/** Sidebar/title text: drop XML tags (skill/system injections), collapse whitespace. */
function cleanTitle(raw: string, max = 72): string {
	const withoutTags = raw
		.replace(/<[^>]{0,300}>/g, " ")
		// Drop the "YYYY-MM-DD HH:MM – " prefix some prompts carry.
		.replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}\s*[–—-]\s*/, "")
		.replace(/^[|>│\s]+/u, "")
		.replace(/\s+/g, " ")
		.trim();
	return truncate(withoutTags || raw.replace(/\s+/g, " ").trim(), max) || "(空会话)";
}

/** Sidebar title: cleaned user-defined name, else cleaned first user message. */
function sessionItemTitle(session: SessionInfo): string {
	return (session.name?.trim() && cleanTitle(session.name)) || cleanTitle(session.firstMessage);
}

/** Project label for a session cwd: the directory basename. */
function projectLabel(cwd: string): string {
	if (!cwd) return "(未知项目)";
	return basename(cwd) || cwd;
}

// ---------------------------------------------------------------------------
// Sidebar (project-grouped session list)
// ---------------------------------------------------------------------------

const VISIBLE_PER_GROUP = 5;

interface ProjectGroup {
	label: string;
	cwd: string;
	sessions: SessionInfo[];
}

function groupByProject(sessions: readonly SessionInfo[]): ProjectGroup[] {
	const groups = new Map<string, ProjectGroup>();
	for (const session of sessions) {
		const key = session.cwd || "(未知项目)";
		let group = groups.get(key);
		if (!group) {
			group = { label: projectLabel(session.cwd), cwd: key, sessions: [] };
			groups.set(key, group);
		}
		group.sessions.push(session);
	}
	return [...groups.values()];
}

function sessionItemHtml(session: SessionInfo, now: Date, selectedId: string | undefined): string {
	const href = `/session/${encodeURIComponent(session.id)}`;
	const title = sessionItemTitle(session);
	const classes = session.id === selectedId ? ' class="item selected"' : ' class="item"';
	const tooltip = `${title}\n${session.cwd}`;
	return [
		`<a${classes} href="${href}" title="${escapeHtml(tooltip)}">`,
		`<span class="item-title">${escapeHtml(title)}</span>`,
		`<span class="item-time">${escapeHtml(formatRelative(session.modified, now))}</span>`,
		"</a>",
	].join("");
}

function groupHtml(group: ProjectGroup, now: Date, selectedId: string | undefined): string {
	const visible = group.sessions.slice(0, VISIBLE_PER_GROUP);
	const hidden = group.sessions.slice(VISIBLE_PER_GROUP);
	const parts: string[] = [`<div class="group-label">${escapeHtml(group.label)}</div>`];
	for (const session of visible) parts.push(sessionItemHtml(session, now, selectedId));
	if (hidden.length > 0) {
		parts.push(`<details class="group-more"><summary>展开其余 ${hidden.length} 个会话</summary>`);
		for (const session of hidden) parts.push(sessionItemHtml(session, now, selectedId));
		parts.push("</details>");
	}
	return parts.join("");
}

function renderSidebar(
	sessions: readonly SessionInfo[],
	query: string,
	now: Date,
	selectedId: string | undefined,
): string {
	const normalized = query.trim().toLowerCase();
	const filtered = normalized
		? sessions.filter(
				(session) =>
					session.firstMessage.toLowerCase().includes(normalized) ||
					(session.name ?? "").toLowerCase().includes(normalized) ||
					session.cwd.toLowerCase().includes(normalized) ||
					session.allMessagesText.toLowerCase().includes(normalized),
			)
		: sessions;
	const groups = groupByProject(filtered);
	const listHtml = groups.map((group) => groupHtml(group, now, selectedId)).join("\n");

	return [
		'<aside id="sidebar">',
		'<div class="sidebar-top">',
		'<form method="get" action="/">',
		`<input type="search" name="q" value="${escapeHtml(query)}" placeholder="搜索会话…" autofocus>`,
		"</form>",
		'<button type="button" id="theme-toggle" class="theme-toggle" title="切换主题"></button>',
		"</div>",
		`<div class="sidebar-stats">${groups.length} 个项目 · ${filtered.length} 个会话</div>`,
		'<nav id="session-list">',
		listHtml || '<div class="sidebar-empty">没有匹配的会话</div>',
		"</nav>",
		"</aside>",
	].join("");
}

// ---------------------------------------------------------------------------
// Shared page shell
// ---------------------------------------------------------------------------

const GLOBAL_CSS = `
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
	margin: 0;
	display: flex;
	background: var(--page-bg);
	color: var(--text);
	font: 14px/1.6 -apple-system, "SF Pro Text", "Segoe UI", "PingFang SC", "Hiragino Sans GB", sans-serif;
}
a { color: var(--link); text-decoration: none; }
a:hover { text-decoration: underline; }

/* ---------- sidebar ---------- */
#sidebar {
	--sidebar-w: ${SIDEBAR_DEFAULT_WIDTH}px;
	width: var(--sidebar-w); min-width: var(--sidebar-w); height: 100vh;
	display: flex; flex-direction: column;
	background: var(--sidebar-bg);
	border-right: 1px solid var(--border);
}
.sidebar-top { display: flex; gap: 8px; padding: 14px 14px 8px; align-items: center; }
.sidebar-top form { flex: 1; display: flex; }
#sidebar input[type="search"] {
	width: 100%; padding: 7px 12px;
	background: var(--card-bg); color: var(--text);
	border: 1px solid var(--border); border-radius: 8px;
	font: inherit; font-size: 13px;
}
#sidebar input[type="search"]:focus { outline: 1px solid var(--link); }
.theme-toggle {
	flex: none; width: 32px; height: 32px;
	display: flex; align-items: center; justify-content: center;
	background: var(--card-bg); color: var(--muted);
	border: 1px solid var(--border); border-radius: 8px;
	font-size: 14px; cursor: pointer; padding: 0;
}
.theme-toggle:hover { color: var(--accent); border-color: var(--accent); }
.sidebar-stats { padding: 0 16px 10px; color: var(--dim); font-size: 12px; }
#session-list { flex: 1; overflow-y: auto; padding: 0 8px 24px; }
.sidebar-empty { color: var(--dim); padding: 24px 8px; text-align: center; }
.group-label {
	display: flex; align-items: center; gap: 6px;
	margin: 14px 8px 4px; color: var(--muted);
	font-size: 12px; font-weight: 600;
}
.group-label::before {
	content: ""; width: 0; height: 0;
	border-left: 5px solid var(--muted);
	border-top: 4px solid transparent; border-bottom: 4px solid transparent;
}
.item {
	display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
	padding: 7px 10px; border-radius: 8px;
	color: var(--text); font-size: 13px;
}
.item:hover { background: var(--hover); text-decoration: none; }
.item.selected { background: var(--user-bubble); }
.item.selected .item-title { color: var(--selected-text); font-weight: 600; }
.item-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item-time { flex: none; color: var(--dim); font-size: 11px; }
.group-more summary {
	padding: 5px 10px; color: var(--dim); font-size: 12px; cursor: pointer;
	list-style: none; user-select: none;
}
.group-more summary:hover { color: var(--link); }
.group-more[open] summary { color: var(--link); }

/* ---------- sidebar resizer ---------- */
#sidebar-resizer {
	flex: none; width: 5px; height: 100vh; cursor: col-resize;
	background: transparent; z-index: 5;
}
#sidebar-resizer:hover, #sidebar-resizer.active { background: var(--accent); }
body.resizing { cursor: col-resize; }
body.resizing #session-list, body.resizing .item { user-select: none; }

/* ---------- main pane ---------- */
#main { flex: 1; height: 100vh; overflow-y: auto; min-width: 0; }
.main-inner { max-width: 860px; margin: 0 auto; padding: 28px 32px 80px; }
.session-header h1 { font-size: 18px; margin: 0 0 6px; }
.session-meta { color: var(--dim); font-size: 12px; }
.view-tabs { margin: 14px 0 0; border-bottom: 1px solid var(--border); }
.view-tabs a {
	display: inline-block; padding: 7px 4px; margin-right: 18px;
	color: var(--muted); font-size: 13px;
	border-bottom: 2px solid transparent;
}
.view-tabs a.active { color: var(--text); border-bottom-color: var(--accent); font-weight: 600; }
.view-panel[hidden] { display: none; }
.empty-main { display: flex; height: 100%; align-items: center; justify-content: center; color: var(--dim); }

/* ---------- chat view ---------- */
.msg { margin: 18px 0; }
.msg-user {
	display: flex; flex-direction: column; align-items: flex-end;
}
.msg-user .bubble {
	width: fit-content; max-width: 560px; padding: 10px 14px;
	background: var(--user-bubble); border-radius: 14px 14px 4px 14px;
	white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px;
}
.msg-user .who {
	display: block; margin-bottom: 4px;
	color: var(--dim); font-size: 11px;
}
.msg-user .who { text-align: right; }
.md { overflow-wrap: anywhere; }
.md p { margin: 0.5em 0; }
.md pre {
	background: var(--code-bg); border: 1px solid var(--border); border-radius: 8px;
	padding: 12px; overflow-x: auto; font-size: 13px; line-height: 1.5;
}
.md code { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
.md > pre, .md li > pre { margin: 0.6em 0; }
.md :not(pre) > code { background: var(--tool-bg); border-radius: 4px; padding: 1px 5px; font-size: 0.92em; color: var(--md-code); }
.md h1, .md h2, .md h3, .md h4 { margin: 0.8em 0 0.4em; line-height: 1.3; }
.md h1 { font-size: 1.4em; } .md h2 { font-size: 1.25em; } .md h3 { font-size: 1.1em; }
.md blockquote { margin: 0.6em 0; padding: 2px 12px; border-left: 3px solid var(--border); color: var(--muted); }
.md table { border-collapse: collapse; margin: 0.6em 0; }
.md th, .md td { border: 1px solid var(--border); padding: 4px 10px; font-size: 13px; }
.md img { max-width: 100%; }
.md hr { border: none; border-top: 1px solid var(--border); }
/* Raw HTML / markdown image markup, shown as text (TUI parity). */
.md-raw {
	background: var(--tool-bg); border-radius: 4px; padding: 1px 5px;
	font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
	font-size: 0.92em; color: var(--md-code); overflow-wrap: anywhere;
}
/* LaTeX sources, shown as text like the TUI renderer does. */
.md-math {
	font-style: italic; color: var(--md-code);
	font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
	font-size: 0.95em;
}
.md-math-block {
	margin: 0.6em 0; padding: 8px 12px;
	background: var(--code-bg); border: 1px solid var(--border); border-radius: 8px;
	font-style: italic; color: var(--md-code);
	font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
	font-size: 0.95em; overflow-x: auto;
}
/* Mermaid diagrams (mermaid fence blocks), rendered client-side from a CDN.
   Clicking a rendered diagram opens it in a new tab. Degraded diagrams
   (offline / parse failure) show an error line plus the raw source. */
.md-mermaid {
	margin: 0.6em 0; padding: 12px;
	text-align: center; overflow-x: auto;
	background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px;
	cursor: zoom-in;
}
.md-mermaid svg { max-width: 100%; height: auto; }
.md-mermaid.pending { cursor: default; color: var(--dim); }
.md-mermaid.failed {
	background: transparent; border: none; padding: 0;
	cursor: default; text-align: left;
}
.md-mermaid-err { color: var(--error); font-size: 12px; margin-bottom: 4px; }

/* highlight.js token colors (class mapping from pi's export template). */
.hljs { background: transparent; color: var(--text); }
.hljs-comment, .hljs-quote { color: var(--syntax-comment); }
.hljs-keyword, .hljs-selector-tag { color: var(--syntax-keyword); }
.hljs-number, .hljs-literal { color: var(--syntax-number); }
.hljs-string, .hljs-doctag { color: var(--syntax-string); }
.hljs-function, .hljs-title, .hljs-title.function_, .hljs-section, .hljs-name { color: var(--syntax-function); }
.hljs-type, .hljs-class, .hljs-title.class_, .hljs-built_in { color: var(--syntax-type); }
.hljs-attr, .hljs-variable, .hljs-variable.language_, .hljs-params, .hljs-property { color: var(--syntax-variable); }
.hljs-meta, .hljs-meta .hljs-keyword, .hljs-meta .hljs-string { color: var(--syntax-keyword); }
.hljs-operator { color: var(--syntax-operator); }
.hljs-punctuation { color: var(--syntax-punctuation); }
.hljs-subst { color: var(--text); }

details.tool, details.thinking, details.branch, details.extra {
	border: 1px solid var(--border); border-radius: 8px;
	margin: 8px 0; background: var(--tool-bg);
}
details.thinking, details.branch, details.extra { background: transparent; }
details.thinking { margin: 5px 0; }
details.branch { border-style: dashed; }
details.tool summary, details.thinking summary, details.branch summary, details.extra summary {
	padding: 7px 12px; cursor: pointer; user-select: none;
	color: var(--muted); font-size: 12.5px; list-style: none;
	display: flex; align-items: center; gap: 8px;
}
details.tool summary::before, details.thinking summary::before,
details.branch summary::before, details.extra summary::before { content: "▸"; color: var(--dim); }
details[open].tool summary, details[open].thinking summary,
details[open].branch summary, details[open].extra summary { border-bottom: 1px solid var(--border); }
details[open].tool summary::before, details[open].thinking summary::before,
details[open].branch summary::before, details[open].extra summary::before { content: "▾"; }
.tool-name { color: var(--text); font-weight: 600; }
.tool-status-ok { color: var(--success); }
.tool-status-err { color: var(--error); }
.tool-body { padding: 10px 12px; }
.tool-body .tool-section { margin: 0 0 10px; }
.tool-body .tool-section:last-child { margin-bottom: 0; }
.tool-body .tool-section-title { color: var(--dim); font-size: 11px; margin-bottom: 4px; }
.tool-body pre {
	margin: 0; padding: 8px 10px;
	background: var(--code-bg); border-radius: 6px;
	font-size: 12px; line-height: 1.5; overflow-x: auto;
	white-space: pre-wrap; overflow-wrap: anywhere;
	max-height: 340px; overflow-y: auto;
}
details.thinking .tool-body { color: var(--muted); font-style: italic; }
details.branch > summary { color: var(--dim); }

.sysline { margin: 14px 0; text-align: center; color: var(--dim); font-size: 12px; }
.sysline .sys-pill {
	display: inline-block; padding: 2px 12px;
	background: var(--card-bg); border: 1px solid var(--border); border-radius: 999px;
}

/* ---------- trace view ---------- */
.trace { font-size: 12.5px; }
.trace-row { display: flex; gap: 10px; padding: 6px 0; border-bottom: 1px solid var(--border); }
.trace-time { flex: none; width: 150px; color: var(--dim); font-family: ui-monospace, monospace; font-size: 11px; padding-top: 2px; }
.trace-type { flex: none; width: 130px; color: var(--accent); font-family: ui-monospace, monospace; font-size: 11px; padding-top: 2px; overflow-wrap: anywhere; }
.trace-body { flex: 1; min-width: 0; }
.trace-body pre {
	margin: 0; white-space: pre-wrap; overflow-wrap: anywhere;
	color: var(--muted); font-family: ui-monospace, monospace; font-size: 11.5px; line-height: 1.5;
}

/* ---------- build badge ---------- */
#build-badge {
	position: fixed; right: 10px; bottom: 8px; z-index: 9;
	padding: 2px 10px; border-radius: 999px;
	background: var(--card-bg); color: var(--dim);
	border: 1px solid var(--border);
	font-size: 10.5px; opacity: 0.75; pointer-events: none;
}

/* ---------- errors ---------- */
.error-main { max-width: 640px; margin: 96px auto; text-align: center; }
.error-main h1 { color: var(--error); }
.error-main p { color: var(--muted); overflow-wrap: anywhere; }
`;

/**
 * Runs on every page: restore stored theme/width before first paint, wire
 * the theme toggle, and drive the sidebar drag-resize handle.
 */
const GLOBAL_CLIENT_JS = `
(function () {
	var KEY_T = ${JSON.stringify(THEME_STORAGE_KEY)};
	var KEY_W = ${JSON.stringify(SIDEBAR_WIDTH_STORAGE_KEY)};
	var MIN_W = ${SIDEBAR_MIN_WIDTH}, MAX_W = ${SIDEBAR_MAX_WIDTH}, DEFAULT_W = ${SIDEBAR_DEFAULT_WIDTH};
	var root = document.documentElement;

	var toggle = document.getElementById("theme-toggle");
	function currentTheme() { return root.getAttribute("data-theme") === "dark" ? "dark" : "light"; }
	function paintToggle() {
		if (!toggle) return;
		var dark = currentTheme() === "dark";
		toggle.textContent = dark ? "\\u2600" : "\\u263E";
		toggle.title = dark ? "\\u5207\\u6362\\u5230\\u6D45\\u8272" : "\\u5207\\u6362\\u5230\\u6DF1\\u8272";
	}
	if (toggle) {
		toggle.addEventListener("click", function () {
			var next = currentTheme() === "dark" ? "light" : "dark";
			root.setAttribute("data-theme", next);
			try { localStorage.setItem(KEY_T, next); } catch (e) {}
			paintToggle();
		});
	}
	paintToggle();

	var sidebar = document.getElementById("sidebar");
	var handle = document.getElementById("sidebar-resizer");
	function applyWidth(w) {
		w = Math.max(MIN_W, Math.min(MAX_W, w));
		sidebar.style.setProperty("--sidebar-w", w + "px");
	}
	if (sidebar && handle) {
		try {
			var storedW = Number.parseInt(localStorage.getItem(KEY_W) || "", 10);
			if (storedW >= MIN_W && storedW <= MAX_W) applyWidth(storedW);
		} catch (e) {}
		var dragging = false;
		handle.addEventListener("mousedown", function (ev) {
			dragging = true;
			handle.classList.add("active");
			document.body.classList.add("resizing");
			ev.preventDefault();
		});
		document.addEventListener("mousemove", function (ev) {
			if (dragging) applyWidth(ev.clientX);
		});
		document.addEventListener("mouseup", function () {
			if (!dragging) return;
			dragging = false;
			handle.classList.remove("active");
			document.body.classList.remove("resizing");
			try {
				localStorage.setItem(KEY_W, String(Math.round(sidebar.getBoundingClientRect().width)));
			} catch (e) {}
		});
		handle.addEventListener("dblclick", function () {
			applyWidth(DEFAULT_W);
			try { localStorage.removeItem(KEY_W); } catch (e) {}
		});
	}
})();
`;

/** Anti-flash: restore the stored theme before the page paints. */
const THEME_BOOT_JS = `(function(){try{var t=localStorage.getItem(${JSON.stringify(
	THEME_STORAGE_KEY,
)});if(t==="dark"||t==="light")document.documentElement.setAttribute("data-theme",t);}catch(e){}})();`;

/** Module-load timestamp; rendered on the page so stale servers are obvious. */
const BUILD_ID = new Date().toISOString().replace("T", " ").slice(0, 19);

function pageShell(sidebar: string, main: string, title: string, clientScripts = ""): string {
	const resizer = sidebar ? '<div id="sidebar-resizer" title="拖拽调整宽度，双击重置"></div>\n' : "";
	return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>${THEME_VARS}${GLOBAL_CSS}</style>
<script>${THEME_BOOT_JS}</script>
</head>
<body>
${sidebar}${resizer}<main id="main">
${main}
</main>
<script>${GLOBAL_CLIENT_JS}</script>
${clientScripts}
<div id="build-badge" title="session-web \u670d\u52a1\u7aef\u6784\u5efa\u65f6\u95f4\uff1a${BUILD_ID}">session-web \u00b7 ${BUILD_ID}</div>
</body>
</html>
`;
}

export function renderErrorPage(title: string, message: string): string {
	const main = `<div class="error-main"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p><a href="/">返回会话列表</a></p></div>`;
	return pageShell("", main, title);
}

// ---------------------------------------------------------------------------
// List page
// ---------------------------------------------------------------------------

export function renderListPage(sessions: readonly SessionInfo[], query: string, now: Date): string {
	const sidebar = renderSidebar(sessions, query, now, undefined);
	const main =
		'<div class="empty-main"><div style="text-align:center">' +
		`<div style="font-size:15px;margin-bottom:6px">pi 会话</div>共 ${sessions.length} 个会话，从左侧选择查看</div></div>`;
	return pageShell(sidebar, main, "pi sessions");
}

// ---------------------------------------------------------------------------
// Chat view
// ---------------------------------------------------------------------------

/** Base64 payload for client-side markdown rendering. */
function mdPayload(text: string): string {
	return Buffer.from(text, "utf8").toString("base64");
}

function renderAssistantContent(content: string | Array<{ type: string; [key: string]: unknown }>): string {
	if (typeof content === "string") {
		return `<div class="md" data-md="${mdPayload(content)}"></div>`;
	}
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text" && typeof block.text === "string") {
			parts.push(`<div class="md" data-md="${mdPayload(block.text)}"></div>`);
		} else if (block.type === "thinking" && typeof block.thinking === "string") {
			parts.push(
				[
					'<details class="thinking">',
					"<summary>思考过程</summary>",
					`<div class="tool-body"><pre style="background:transparent;padding:4px 2px">${escapeHtml(truncate(block.thinking, 20000))}</pre></div>`,
					"</details>",
				].join(""),
			);
		} else if (block.type === "image") {
			parts.push('<div class="sysline"><span class="sys-pill">[图片内容]</span></div>');
		}
		// Tool calls are intentionally not rendered in the chat view; see the
		// trace tab for the full tool call/result timeline.
	}
	return parts.join("\n");
}

function systemLine(text: string): string {
	return `<div class="sysline"><span class="sys-pill">${escapeHtml(text)}</span></div>`;
}

function renderEntryAsChat(entry: SessionEntry): string {
	if (entry.type !== "message") {
		if (entry.type === "model_change") {
			return systemLine(`切换模型 → ${entry.provider}/${entry.modelId}`);
		}
		if (entry.type === "thinking_level_change") {
			return systemLine(`思考级别 → ${entry.thinkingLevel}`);
		}
		if (entry.type === "compaction") {
			return [
				'<details class="extra">',
				`<summary>上下文压缩（${entry.tokensBefore} tokens）</summary>`,
				`<div class="tool-body"><pre>${escapeHtml(truncate(entry.summary, 8000))}</pre></div>`,
				"</details>",
			].join("");
		}
		if (entry.type === "branch_summary") {
			return [
				'<details class="extra">',
				"<summary>分支摘要</summary>",
				`<div class="tool-body"><pre>${escapeHtml(truncate(entry.summary, 8000))}</pre></div>`,
				"</details>",
			].join("");
		}
		return "";
	}

	const message = entry.message;
	if (message.role === "user") {
		return [
			'<div class="msg msg-user"><div><span class="who">You</span><div class="bubble">',
			escapeHtml(messageText(message as MessageLike)),
			"</div></div></div>",
		].join("");
	}
	if (message.role === "assistant") {
		const content = message.content as unknown as string | Array<{ type: string; [key: string]: unknown }>;
		const inner = renderAssistantContent(content);
		// Messages without visible text (tool-call turns: thinking + calls)
		// skip the shell so bare "Assistant" labels and lone collapsed strips
		// do not pile up. Adjacent strips are merged in renderChatView.
		const hasVisibleText =
			typeof content === "string"
				? content.trim() !== ""
				: content.some(
						(block) => block.type === "text" && typeof block.text === "string" && block.text.trim() !== "",
					);
		if (!hasVisibleText) return inner;
		// No role label: the folded thinking strip and markdown body already
		// distinguish assistant turns, and repeated labels waste height.
		return `<div class="msg msg-assistant">${inner}</div>`;
	}
	// toolResult messages are folded into their toolCall blocks; custom and
	// system messages are skipped in the chat view (see trace view).
	return "";
}

/**
 * Depth-first render over the entry tree: the active branch continues
 * inline; sibling subtrees collapse into branch blocks at the fork point.
 */
function renderSubtree(node: SessionTreeNode, mainPath: Set<string>, out: string[]): void {
	const rendered = renderEntryAsChat(node.entry);
	if (rendered) out.push(rendered);
	const children = node.children ?? [];
	const mainChild = children.find((child) => mainPath.has(child.entry.id));
	for (const child of children) {
		if (child === mainChild) continue;
		const subtree: string[] = [];
		renderSubtreeFully(child, subtree);
		out.push(
			[
				'<details class="branch">',
				"<summary>分支变体</summary>",
				`<div class="tool-body">${subtree.join("\n")}</div>`,
				"</details>",
			].join(""),
		);
	}
	if (mainChild) renderSubtree(mainChild, mainPath, out);
}

function renderSubtreeFully(node: SessionTreeNode, out: string[]): void {
	const rendered = renderEntryAsChat(node.entry);
	if (rendered) out.push(rendered);
	for (const child of node.children ?? []) renderSubtreeFully(child, out);
}

function findNode(root: SessionTreeNode, id: string | null): SessionTreeNode | undefined {
	if (!id) return undefined;
	if (root.entry.id === id) return root;
	for (const child of root.children ?? []) {
		const found = findNode(child, id);
		if (found) return found;
	}
	return undefined;
}

function findParent(root: SessionTreeNode, childId: string): SessionTreeNode | undefined {
	for (const child of root.children ?? []) {
		if (child.entry.id === childId) return root;
		const found = findParent(child, childId);
		if (found) return found;
	}
	return undefined;
}

/** Entry ids from the tree roots down to the leaf (the active branch). */
function computeMainPath(tree: SessionTreeNode[], leafId: string | null): Set<string> {
	const mainPath = new Set<string>();
	let cursor: SessionTreeNode | undefined;
	for (const root of tree) {
		cursor ??= findNode(root, leafId);
	}
	while (cursor) {
		mainPath.add(cursor.entry.id);
		const target = cursor;
		cursor = undefined;
		for (const root of tree) {
			cursor ??= findParent(root, target.entry.id);
		}
	}
	if (mainPath.size === 0) {
		// No leaf resolved (legacy files): render roots only, children as branches.
		for (const root of tree) mainPath.add(root.entry.id);
	}
	return mainPath;
}

/** Chat-page client script (markdown/LaTeX/toolbars logic), kept as a plain asset. */
let chatClientScript: string | null = null;

function loadChatClientScript(): string {
	if (chatClientScript === null) {
		chatClientScript = readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "chat-client.js"), "utf8");
	}
	return chatClientScript;
}

function renderChatView(tree: SessionTreeNode[], leafId: string | null): string {
	const mainPath = computeMainPath(tree, leafId);
	const parts: string[] = [];
	for (const root of tree) renderSubtree(root, mainPath, parts);
	// Rendering scripts (marked/hljs/chat-client) live in the page shell so
	// both view panels are pure data and can be swapped without reloads.
	return mergeAdjacentThinkingStrips(parts.join("\n"));
}

/**
 * Collapse runs of consecutive thinking strips into a single strip so
 * tool-call turns do not stack a dozen near-identical collapsed rows.
 * Non-whitespace text between strips breaks the run and is kept verbatim.
 */
function mergeAdjacentThinkingStrips(html: string): string {
	const strip =
		/<details class="thinking"><summary>思考过程<\/summary><div class="tool-body">([\s\S]*?)<\/div><\/details>/g;
	const pieces: string[] = [];
	let cursor = 0;
	let run: string[] = [];
	const flushRun = (suffix: string): void => {
		if (run.length === 0) {
			pieces.push(suffix);
			return;
		}
		const bodies = run.map((body) => `<div class="tool-body">${body}</div>`).join("");
		pieces.push(`<details class="thinking"><summary>思考过程</summary>${bodies}</details>${suffix}`);
		run = [];
	};
	for (const match of html.matchAll(strip)) {
		const start = match.index ?? 0;
		const gap = html.slice(cursor, start);
		if (gap.trim() !== "") flushRun("");
		pieces.push(gap);
		run.push(match[1]);
		cursor = start + match[0].length;
	}
	flushRun(html.slice(cursor));
	return pieces.join("");
}

// ---------------------------------------------------------------------------
// Trace view
// ---------------------------------------------------------------------------

function traceBody(entry: SessionEntry): string {
	let text = "";
	if (entry.type === "message") {
		const message = entry.message as { role?: string } & MessageLike;
		text = `[${message.role ?? "?"}] ${messageText(message)}`;
	} else if (entry.type === "compaction" || entry.type === "branch_summary") {
		text = entry.summary;
	} else if (entry.type === "model_change") {
		text = `${entry.provider}/${entry.modelId}`;
	} else if (entry.type === "thinking_level_change") {
		text = entry.thinkingLevel;
	} else if (entry.type === "session_info") {
		text = entry.name ?? "";
	} else if (entry.type === "label") {
		text = `${entry.targetId}: ${entry.label ?? ""}`;
	} else if (entry.type === "usage") {
		text = `${entry.provider}/${entry.model} ${JSON.stringify(entry.usage)}`;
	} else if (entry.type === "custom") {
		text = `${entry.customType} ${JSON.stringify(entry.data ?? {})}`;
	} else if (entry.type === "custom_message") {
		text = `${entry.customType} ${typeof entry.content === "string" ? entry.content : "(blocks)"}`;
	} else if (entry.type === "context_edit") {
		text = `${entry.targetId} → ${entry.replacement === null ? "(omitted)" : JSON.stringify(entry.replacement).slice(0, 400)}`;
	}
	return escapeHtml(truncate(text.replace(/\s+/g, " ").trim(), 600));
}

function renderTraceView(entries: readonly SessionEntry[]): string {
	const rows = entries.map((entry) => {
		const time = new Date(entry.timestamp);
		const timeText = Number.isNaN(time.getTime()) ? "" : time.toISOString().replace("T", " ").slice(11, 19);
		return [
			'<div class="trace-row">',
			`<span class="trace-time">${escapeHtml(timeText)}</span>`,
			`<span class="trace-type">${escapeHtml(entry.type)}</span>`,
			`<div class="trace-body"><pre>${traceBody(entry)}</pre></div>`,
			"</div>",
		].join("");
	});
	return `<div class="trace">${rows.join("\n")}</div>`;
}

// ---------------------------------------------------------------------------
// Detail page
// ---------------------------------------------------------------------------

let templateDir: string | null = null;

/** Locate pi's shipped export template vendor assets (mirrors getExportTemplateDir()). */
function findTemplateDir(): string {
	if (templateDir) return templateDir;
	const packageDir = getPackageDir();
	const candidates = [
		join(packageDir, "export-html"), // standalone binary
		join(packageDir, "src", "core", "export-html"), // source checkout
		join(packageDir, "dist", "core", "export-html"), // npm installation
	];
	for (const candidate of candidates) {
		if (existsSync(join(candidate, "template.html"))) {
			templateDir = candidate;
			return candidate;
		}
	}
	throw new Error(`Export template not found under ${packageDir}`);
}

const staticCache = new Map<"marked" | "highlight", string>();

/** Vendored renderer sources, inlined into chat pages. */
export function loadStaticScript(name: "marked" | "highlight"): string {
	const cached = staticCache.get(name);
	if (cached) return cached;
	const file = name === "marked" ? "vendor/marked.min.js" : "vendor/highlight.min.js";
	const source = readFileSync(join(findTemplateDir(), file), "utf8");
	staticCache.set(name, source);
	return source;
}

/** Latest session_info name, else cleaned first user message. */
function sessionTitleOf(entries: readonly SessionEntry[]): string {
	let name: string | undefined;
	let firstUser = "";
	for (const entry of entries) {
		if (entry.type === "session_info" && entry.name?.trim()) name = entry.name.trim();
		if (!firstUser && entry.type === "message" && entry.message.role === "user") {
			firstUser = messageText(entry.message as MessageLike);
		}
	}
	return (name && cleanTitle(name)) || cleanTitle(firstUser);
}

function hasGetTree(manager: SessionManager): manager is SessionManager & { getTree(): SessionTreeNode[] } {
	return typeof (manager as SessionManager & { getTree?: unknown }).getTree === "function";
}

export interface StaticScripts {
	marked: string;
	highlight: string;
}

export function renderSessionPage(
	manager: SessionManager,
	view: "chat" | "trace",
	staticScripts: StaticScripts,
	sidebarSessions: readonly SessionInfo[],
	now: Date,
): string {
	const header: SessionHeader | null = manager.getHeader();
	const entries = manager.getEntries();
	const title = sessionTitleOf(entries);

	const created = header ? new Date(header.timestamp) : undefined;
	const messageCount = entries.filter((entry) => entry.type === "message").length;
	const metaParts: string[] = [];
	if (created && !Number.isNaN(created.getTime())) metaParts.push(formatDateTime(created));
	metaParts.push(`${messageCount} 条消息`);
	if (header?.cwd) metaParts.push(header.cwd);
	const meta = escapeHtml(metaParts.join(" · "));

	const id = encodeURIComponent(header?.id ?? "");
	const chatActive = view === "chat";
	const tabs = [
		'<div class="view-tabs">',
		`<a href="/session/${id}" data-view="chat"${chatActive ? ' class="active"' : ""}>对话</a>`,
		`<a href="/session/${id}?view=trace" data-view="trace"${chatActive ? "" : ' class="active"'}>轨迹</a>`,
		"</div>",
	].join("");

	const other = view === "chat" ? "trace" : "chat";
	const current = renderViewBody(manager, view);
	const panels = [
		`<div class="view-panel" id="view-${view}" data-view="${view}">${current}</div>`,
		`<div class="view-panel" id="view-${other}" data-view="${other}" hidden data-src="/session/${id}?view=${other}&fragment=1"></div>`,
	].join("\n");

	const main = [
		'<div class="main-inner">',
		'<div class="session-header">',
		`<h1>${escapeHtml(title)}</h1>`,
		`<div class="session-meta">${meta}</div>`,
		tabs,
		"</div>",
		panels,
		"</div>",
	].join("");

	const clientScripts = [
		`<script>${staticScripts.marked}</script>`,
		`<script>${staticScripts.highlight}</script>`,
		`<script>${loadChatClientScript()}</script>`,
	].join("\n");
	const sidebar = renderSidebar(sidebarSessions, "", now, header?.id);
	return pageShell(sidebar, main, `pi session — ${title}`, clientScripts);
}

/** Body of one view (chat or trace); shared by the page and the fragment endpoint. */
function renderViewBody(manager: SessionManager, view: "chat" | "trace"): string {
	const entries = manager.getEntries();
	const leafId = manager.getLeafId();
	return hasGetTree(manager)
		? view === "trace"
			? renderTraceView(entries)
			: renderChatView(manager.getTree(), leafId)
		: renderTraceView(entries);
}

/** Standalone view fragment for the SPA switcher to fetch and inject. */
export function renderSessionFragment(manager: SessionManager, view: "chat" | "trace"): string {
	return renderViewBody(manager, view);
}
