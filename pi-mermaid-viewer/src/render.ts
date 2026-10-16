import { pageScript, FA_CSS_URL } from "./page-script.ts";
import type { DiagramData } from "./types.ts";

// Page CSS. Authored as a plain template literal — it contains no backslashes
// (the template-literal gotcha only bites regex-bearing JS; see page-script.ts).

const PAGE_CSS = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{font-family:-apple-system,sans-serif;color:var(--text,#c9d1d9);padding:0;transition:background .3s}
.bg-dark{background:#0d1117} .bg-light{background:#f6f8fa} .bg-white{background:#fff}
.bg-dark{--surface:rgba(22,27,34,.85);--surface-pop:rgba(22,27,34,.95);--field:rgba(48,54,61,.4);--field-hover:rgba(48,54,61,.8);--border:rgba(48,54,61,.6);--text:#c9d1d9;--text-muted:#8b949e;--accent:#58a6ff;--divider:rgba(255,255,255,.12);--shadow:rgba(0,0,0,.3);--hover:rgba(255,255,255,.08)}
.bg-light{--surface:rgba(255,255,255,.85);--surface-pop:rgba(255,255,255,.96);--field:rgba(208,215,222,.4);--field-hover:rgba(208,215,222,.8);--border:rgba(208,215,222,.8);--text:#24292f;--text-muted:#57606a;--accent:#0969da;--divider:rgba(0,0,0,.1);--shadow:rgba(0,0,0,.12);--hover:rgba(36,41,47,.06)}
.bg-white{--surface:rgba(255,255,255,.9);--surface-pop:rgba(255,255,255,.98);--field:rgba(0,0,0,.05);--field-hover:rgba(0,0,0,.1);--border:rgba(0,0,0,.12);--text:#24292f;--text-muted:#57606a;--accent:#0969da;--divider:rgba(0,0,0,.1);--shadow:rgba(0,0,0,.1);--hover:rgba(0,0,0,.05)}
.bg-dark #canvas-viewport{background-image:radial-gradient(circle,rgba(70,70,70,.275) 2px,transparent 2px);background-size:30px 30px}
.bg-light #canvas-viewport{background-image:radial-gradient(circle,rgba(228,228,228,.55) 2px,transparent 2px);background-size:30px 30px}
.bg-white #canvas-viewport{background-image:radial-gradient(circle,rgba(228,228,228,.55) 2px,transparent 2px);background-size:30px 30px}
.bar{position:fixed;top:16px;right:16px;z-index:99;
  display:flex;gap:8px;align-items:center;height:32px;white-space:nowrap;
  background:transparent;backdrop-filter:none;padding:0;border:none;box-shadow:none}
.bar .grp{display:flex;gap:2px;align-items:center;height:40px;
  background:var(--surface);backdrop-filter:blur(12px);
  padding:4px 8px;border-radius:9999px;border:1px solid var(--border);
  box-shadow:0 2px 12px var(--shadow)}
/* thin vertical divider between icon groups inside one pill */
.bar .vsep{width:1px;height:18px;background:var(--divider);margin:0 4px;flex:none}
.bar .title{display:none}
.bar button,.bar select{padding:3px 8px;border:none;border-radius:6px;font-size:11px;font-weight:600;
  cursor:pointer;color:var(--text);transition:.15s;background:transparent;line-height:1;
  display:inline-flex;align-items:center;gap:4px}
.bar button:hover,.bar select:hover{background:var(--hover)}
.bar button svg,.bar button img{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}
/* icon-only toolbar buttons (mermaid.live floating-pill style) */
.bar .ib{width:32px;height:32px;padding:0;justify-content:center;border-radius:9999px;background:transparent}
.bar .ib:hover{background:var(--hover)}
.bar .ib svg{width:20px;height:20px}
/* Generic dropdown trigger (shared by theme + format selectors) */
.dd{position:relative;display:inline-flex;align-items:stretch;background:transparent;border-radius:6px}
.dd-btn{padding:3px 8px;border:none;border-radius:6px;cursor:pointer;color:var(--text);
  font-size:11px;font-weight:600;display:inline-flex;align-items:center;gap:4px;background:transparent;transition:.15s}
.dd-btn:hover{background:var(--hover)}
.dd-caret{width:10px;height:10px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;transition:transform .15s}
.dd-caret.spin{transform:rotate(180deg)}
.dd-pop{position:absolute;top:calc(100% + 4px);right:0;z-index:100;min-width:100%;
  background:var(--surface-pop);backdrop-filter:blur(12px);
  border:1px solid var(--border);border-radius:8px;padding:4px;
  box-shadow:0 8px 24px var(--shadow);display:none}
.dd-pop.open{display:block}
.dd-pop button{display:flex;width:100%;align-items:center;gap:8px;
  padding:5px 8px;border-radius:5px;color:var(--text);background:transparent;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap}
.dd-pop button:hover{background:var(--hover)}
.dd-pop button.active{color:var(--accent)}
/* Download split button: main (download) + caret (switch), reusing dd styling.
   Selector is prefixed with .bar so its specificity ties .bar button and wins
   by source order (these rules come later), otherwise the universal
   .bar button{border:none;border-radius:6px} would flatten the half-round
   corners and erase the divider. */
.dl-split{display:inline-flex;align-items:stretch;background:transparent;border-radius:6px}
.bar .dl-main{padding:3px 8px;border:none;border-radius:6px 0 0 6px;cursor:pointer;color:var(--text);
  font-size:11px;font-weight:600;display:inline-flex;align-items:center;gap:4px;background:transparent;transition:.15s}
.bar .dl-main:hover{background:var(--hover)}
.dl-main svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.bar .dl-toggle{padding:3px 6px;border:none;border-radius:0 6px 6px 0;border-left:1px solid var(--divider);
  cursor:pointer;color:var(--text);background:transparent;display:inline-flex;align-items:center;transition:.15s}
.bar .dl-toggle:hover{background:var(--hover)}
.dl-toggle svg{width:10px;height:10px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
/* zoom-bar now lives inside .bar as a .grp; legacy fixed positioning removed */
.tabs{position:fixed;top:16px;left:16px;right:auto;z-index:98;
  display:flex;gap:4px;align-items:center;height:32px;padding:0;overflow-x:auto;
  max-width:calc(100vw - 320px)}
.tabs:empty{display:none}
.tab{padding:5px 12px;font-size:11px;font-weight:600;color:#8b949e;cursor:pointer;
  background:rgba(22,27,34,.85);backdrop-filter:blur(12px);
  border:1px solid rgba(48,54,61,.6);border-radius:8px;
  white-space:nowrap;transition:.15s;line-height:1}
.tab:hover{color:#c9d1d9;background:var(--hover)}
.tab.active{color:#58a6ff;background:rgba(31,111,235,.2);border-color:rgba(88,166,255,.4)}
.content{display:flex;height:100vh}
/* Editor panel (Split view): live preview on the left, editable source on
   the right. */
#src-wrap{display:none;flex:1;flex-direction:column;overflow:hidden;border-left:1px solid var(--divider);min-width:0}
.content.split #src-wrap{display:flex}
#src-area{display:flex;flex:1;overflow:hidden;background:var(--surface)}
#src_gutter{min-width:44px;padding:16px 10px 16px 0;text-align:right;color:var(--text-muted);
  font:12px/1.7 "SF Mono",monospace;user-select:none;overflow:hidden;white-space:pre}
#src{flex:1;resize:none;border:none;outline:none;background:transparent;color:var(--text);
  font:12px/1.7 "SF Mono",monospace;line-height:1.7;padding:16px;white-space:pre;overflow:auto;
  caret-color:var(--accent);tab-size:4}
#src:focus{outline:none}
/* lock the page to the window: a freshly inserted mermaid SVG reports its
   natural height for one layout pass; without this lock the viewport block
   grows to that height and the fit engine centers inside the inflated box */
body{overflow:hidden}
.content.split #canvas-viewport{border-right:1px solid var(--divider)}
#canvas-viewport{flex:1;min-width:0;min-height:0;overflow:hidden;padding:60px 24px 24px 24px;cursor:grab;user-select:none;
  text-align:center;position:relative}
#canvas-viewport:active{cursor:grabbing}
#canvas-viewport.dragging{cursor:grabbing;scroll-behavior:auto}
#svg-wrap,#svg{width:100%;height:100%}
#svg-wrap svg{width:100%;height:100%;display:block}
.loading{color:#8b949e;font-size:14px;padding:40px 0;width:100%}
.fixes{position:fixed;bottom:16px;right:16px;z-index:10;
  background:rgba(28,18,4,.85);backdrop-filter:blur(8px);
  border:1px solid rgba(187,128,9,.4);border-radius:8px;padding:6px 12px;
  font-size:11px;color:#d29922;max-width:320px;display:none}
.err{background:#1c0a0a;border:1px solid #f85149;border-radius:6px;padding:16px;
  color:#f85149;font-family:monospace;white-space:pre-wrap;display:none;margin-bottom:12px;max-width:960px;width:100%}
.src-header{padding:8px 16px;background:var(--surface-pop);border-bottom:1px solid var(--divider);
  display:flex;align-items:center;gap:8px}
.src-header span{color:var(--text-muted);font-size:12px;flex:1}
.src-header button{background:var(--field);border:none;border-radius:4px;color:var(--text);
  padding:4px 10px;font-size:11px;cursor:pointer}
.src-header button:hover{background:var(--field-hover)}
.zoom-bar{display:flex;align-items:center;gap:2px;height:40px;padding:4px 8px;border-radius:9999px;
  background:rgba(22,27,34,.85);backdrop-filter:blur(12px);
  border:1px solid rgba(48,54,61,.6);box-shadow:0 2px 12px rgba(0,0,0,.3)}
.zoom-bar button{background:transparent;border:none;border-radius:9999px;width:32px;height:32px;
  padding:0;cursor:pointer;color:var(--text,#c9d1d9);display:flex;align-items:center;justify-content:center;
  transition:all .15s}
.zoom-bar button:hover{color:var(--text,#c9d1d9);background:var(--field-hover,rgba(48,54,61,.5))}
.zoom-bar button:disabled{opacity:.3;pointer-events:none}
.zoom-bar button:focus-visible{outline:2px solid #58a6ff;outline-offset:2px}
.zoom-bar svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:2;
  stroke-linecap:round;stroke-linejoin:round}
/* View toggles (hand-drawn look, grid): plain icons, active = accent icon */
#vt button.on{color:var(--accent)}
/* visually-hidden zoom % — keeps the a11y live region without breaking the
   icon-only rhythm of the pill */
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
/* Grid off: same specificity as the .bg-* #canvas-viewport rules, wins by
   source order (this block is last). */
body.no-grid #canvas-viewport{background-image:none}
`;

export function renderHtml(diagrams: DiagramData[], theme: "dark" | "light"): string {
	return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Mermaid Viewer</title>
<link rel="stylesheet" href="${FA_CSS_URL}">
<style>${PAGE_CSS}</style></head><body class="bg-${theme}">
<div class="bar">
  <span id="title" style="display:none"></span>
  <div class="grp" id="zb">
    <button class="ib" id="fs_btn" title="Fullscreen" aria-label="Toggle fullscreen" aria-pressed="false">
      <svg viewBox="0 0 24 24"><path d="M4 9V6a2 2 0 0 1 2-2h3"/><path d="M15 4h3a2 2 0 0 1 2 2v3"/><path d="M20 15v3a2 2 0 0 1-2 2h-3"/><path d="M9 20H6a2 2 0 0 1-2-2v-3"/></svg>
    </button>
    <span class="vsep"></span>
    <button class="ib" id="zout" title="Zoom out" aria-label="Zoom out" onclick="zoom(-10)">
      <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/><path d="M8 11h6"/></svg>
    </button>
    <span id="zl" class="sr-only" aria-live="polite" role="status">100%</span>
    <button class="ib" id="zin" title="Zoom in" aria-label="Zoom in" onclick="zoom(10)">
      <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/><path d="M8 11h6"/><path d="M11 8v6"/></svg>
    </button>
    <span class="vsep"></span>
    <button class="ib" id="zreset" title="Fit to view" aria-label="Fit to view" onclick="zoom(0)">
      <svg viewBox="0 0 24 24"><path d="M4 20 20 4"/><path d="M14 4h6v6"/><path d="M10 20H4v-6"/></svg>
    </button>
  </div>
  <div class="grp" id="vt">
    <button class="ib" id="rough_btn" title="Hand-drawn look" aria-label="Toggle hand-drawn look" aria-pressed="false">
      <svg viewBox="0 0 24 24"><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/><path d="M13 20c1.2 0 1.6.9 3 .9s1.4-.9 2.6-.9"/></svg>
    </button>
    <button class="ib" id="grid_btn" title="Grid background" aria-label="Toggle grid background" aria-pressed="true">
      <svg viewBox="0 0 24 24"><path d="M4 9h16"/><path d="M4 15h16"/><path d="M10 3 8 21"/><path d="M16 3l-2 18"/></svg>
    </button>
  </div>
  <div class="grp">
    <span class="dd" id="bg_dd">
      <button class="dd-btn" id="bg_btn" title="Theme" aria-label="Theme" aria-haspopup="true">
        <span id="bg_label">Dark</span>
        <svg class="dd-caret" id="bg_caret" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>
      </button>
      <div class="dd-pop" id="bg_pop">
        <button data-bg="dark">Dark</button>
        <button data-bg="light">Light</button>
        <button data-bg="white">White</button>
      </div>
    </span>
    <span class="dl-split" id="dl_split" style="position:relative"><button class="dl-main" id="dlm_main" title="Download PNG" aria-label="Download"><svg viewBox="0 0 24 24"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/></svg><span id="dlm_fmt">PNG</span></button><button class="dl-toggle" id="dlm_tgl" title="Switch format" aria-label="Switch format" aria-haspopup="true"><svg class="dd-caret" id="dlm_caret" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button><div class="dd-pop" id="dlm"><button data-fmt="png"><span>PNG</span></button><button data-fmt="svg"><span>SVG</span></button></div></span>
    <button class="bc" id="cb" onclick="copyCode()">Copy</button>
    <button class="bs" id="sb" onclick="toggleSrc()">Split</button>
  </div>
</div>
<div class="tabs" id="tabs"></div>
<div class="content" id="content">
  <div id="canvas-viewport">
    <div class="loading" id="ld">Loading diagram...</div>
    <div class="fixes" id="fx"></div>
    <div class="err" id="er"></div>
    <div id="svg-wrap"><div id="svg"></div></div>
  </div>
  <div id="src-wrap">
    <div class="src-header">
      <span id="srcLabel">SOURCE</span>
      <button onclick="copySrc()">Copy</button>
    </div>
    <div id="src-area">
      <div id="src_gutter">1</div>
      <textarea id="src" spellcheck="false" wrap="off" autocomplete="off" autocapitalize="off"></textarea>
    </div>
  </div>
</div>
<script type="module">
${pageScript(diagrams, theme)}</script></body></html>`;
}
