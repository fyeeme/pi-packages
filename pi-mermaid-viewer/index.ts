/**
 * pi-mermaid-viewer
 *
 * Renders Mermaid diagrams found in the conversation as an HTML page
 * opened in the default browser. Supports dark/light themes, zoom,
 * PNG export, and split source view.
 */

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec, execSync } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// ============================================================================
// Types
// ============================================================================

export interface DiagramData {
  code: string;
  label: string;
}

export interface MermaidBlock {
  raw: string;
  label: string;
}

// ============================================================================
// Bare-label healer (runs only after Mermaid fails to parse)
// ============================================================================

// Authored with full TS annotations — at runtime tsx/esbuild strips them, so
// Function.prototype.toString() yields annotation-free browser-valid JS for
// injection into the rendered page. Invoked only when the original source
// fails to parse, so correctly-quoted source is NEVER rewritten. The earlier
// "sanitize everything up front" design corrupted valid input (e.g. it
// re-wrapped an already-correct `subgraph L1["…()"]`, producing double
// quotes and a guaranteed parse error). Try-first makes that class of bug
// structurally impossible.
export function quoteBareLabels(code: string): { code: string; fixes: string[] } {
  const fixes: string[] = [];
  const SPECIAL = /[?@<>\/&#!(){}\[\]]/;
  const SHAPES = [
    { o: "(((", c: ")))" },
    { o: "((", c: "))" },
    { o: "{{", c: "}}" },
    { o: "[[", c: "]]" },
    { o: "[(", c: ")]" },
    { o: "[/", c: "/]" },
    { o: "{", c: "}" },
    { o: "(", c: ")" },
    { o: "[", c: "]" },
  ];
  // One alternation per node; longer wrappers first so ((...)) beats (...).
  const SHAPE_RE = /(\w+)(?:\(\(\(([^)]*)\)\)\)|\(\(([^)]*)\)\)|\{\{([^}]*)\}\}|\[\[([^\]]*)\]\]|\[\(([^)]*)\)\]|\[\/([^/]*)\/\]|\{([^}]*)\}|\(([^)]*)\)|\[([^\]]*)\])/g;

  // Edge-label syntaxes Mermaid accepts on a link. Text inside any of these
  // must be quoted when it contains a special char, or the parser rejects it
  // (the "got 'LINK_ID'" / "got 'TEXT'" parse errors). Pipe is the canonical
  // form; dotted and dash are the inline-text forms. All three are protected
  // from the node pass below via placeholders, so a label like |foo(x)| is
  // never mistaken for a node shape `foo(x)`.
  const PIPE_RE = /\|([^|\n]*)\|/g;                       // |text|
  const DOTTED_RE = /(-\.)\s+([^\n]*?)\s+(\.-?>)/g;       // -. text .->
  const DASH_RE = /(--)\s+([^\n]*?)\s+(-->|---)/g;        // -- text --> / ---

  // Quote a bare edge-label text if it contains a special char. Already
  // quoted labels are left untouched.
  const healEdgeText = (text: string): { out: string; changed: boolean } => {
    const trimmed = text.trim();
    if (trimmed.charAt(0) === '"' && trimmed.slice(-1) === '"') return { out: text, changed: false };
    if (!SPECIAL.test(text)) return { out: text, changed: false };
    return { out: '"' + text.replace(/^"+|"+$/g, "").trim() + '"', changed: true };
  };

  const fixed = code.split("\n").map((line) => {
    // Subgraph: only heal a genuinely BARE label. Skip the canonical
    // `ID[...]` form, quoted forms, and bracket forms — all already safe.
    const sm = line.match(/^(\s*subgraph\s+)(.+)$/);
    if (sm) {
      const slabel = sm[2].trim();
      if (slabel.charAt(0) === '"' || slabel.charAt(0) === "[" || /^\w+\s*\[/.test(slabel)) return line;
      if (SPECIAL.test(slabel)) {
        fixes.push("subgraph " + slabel);
        return sm[1] + "sg" + fixes.length + ' ["' + slabel + '"]';
      }
      return line;
    }

    // Protect every edge label with a placeholder BEFORE the node pass, so
    // a label like |foo(x)| or -- foo(x) --> is never mistaken for a node
    // shape `foo(x)`. The node pass runs on the placeholder line and the
    // real labels are restored afterwards.
    const stash: string[] = [];
    const park = (s: string) => { stash.push(s); return "\x00E" + (stash.length - 1) + "\x00"; };

    let work = line.replace(PIPE_RE, (m, text) => {
      const h = healEdgeText(text);
      if (!h.changed) return park(m);
      fixes.push("edge |" + text.trim() + "|");
      return park("|" + h.out + "|");
    });
    work = work.replace(DOTTED_RE, (m, pre, text, post) => {
      const h = healEdgeText(text);
      if (!h.changed) return park(m);
      fixes.push("edge -. " + text.trim() + " " + post);
      return park(pre + " " + h.out + " " + post);
    });
    work = work.replace(DASH_RE, (m, pre, text, post) => {
      const h = healEdgeText(text);
      if (!h.changed) return park(m);
      fixes.push("edge -- " + text.trim() + " " + post);
      return park(pre + " " + h.out + " " + post);
    });

    // Nodes: quote bare labels containing special chars. Labels that are
    // already double-quoted are left untouched (defence in depth — though
    // this path only runs after a parse failure anyway).
    work = work.replace(SHAPE_RE, (match, id, ...groups) => {
      const idx = groups.findIndex((g) => g !== undefined);
      if (idx < 0) return match;
      const shape = SHAPES[idx];
      const label = String(groups[idx]);
      const trimmed = label.trim();
      if (trimmed.charAt(0) === '"' && trimmed.slice(-1) === '"') return match;
      if (!SPECIAL.test(label)) return match;
      fixes.push(id + " " + shape.o + "…" + shape.c);
      const clean = label.replace(/^"+|"+$/g, "").trim();
      return id + shape.o + '"' + clean + '"' + shape.c;
    });

    // Restore the protected edge labels.
    return work.replace(/\x00E(\d+)\x00/g, (_m, i) => stash[Number(i)]);
  }).join("\n");

  return { code: fixed, fixes };
}

// ============================================================================
// Emoji regex source (authored at module scope to survive template literals)
// ============================================================================
// Like quoteBareLabels, this is authored outside the renderHtml template
// literal because template literals EAT backslashes: inlined as
// /[\p{Emoji_Presentation}...]/gu it would be corrupted to /[p{Emoji...}]/gu,
// which (as a character class) matches the letters p, E, m, o, j, i... and
// strips ~45% of every exported SVG — breaking PNG export (Image fails to
// load the corrupted SVG, so img.onload never fires). We inject the regex
// SOURCE string into the template and build the RegExp at runtime.
const EMOJI_RE_SRC = "[\\\\p{Emoji_Presentation}\\\\p{Extended_Pictographic}\\\\u{FE0F}\\\\u{200D}]";

// ============================================================================
// System theme detection (macOS only)
// ============================================================================

function detectSystemTheme(): "dark" | "light" {
  try {
    const out = execSync("defaults read -g AppleInterfaceStyle 2>/dev/null")
      .toString()
      .trim();
    return out === "Dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

// ============================================================================
// HTML page template
// ============================================================================

export function renderHtml(diagrams: DiagramData[], theme: "dark" | "light"): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Mermaid Viewer</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{font-family:-apple-system,sans-serif;color:#c9d1d9;padding:0;transition:background .3s}
.bg-dark{background:#0d1117} .bg-light{background:#f6f8fa} .bg-white{background:#fff}
.bg-dark{--surface:rgba(22,27,34,.85);--surface-pop:rgba(22,27,34,.95);--field:rgba(48,54,61,.4);--field-hover:rgba(48,54,61,.8);--border:rgba(48,54,61,.6);--text:#c9d1d9;--text-muted:#8b949e;--accent:#58a6ff;--divider:rgba(255,255,255,.12);--shadow:rgba(0,0,0,.3)}
.bg-light{--surface:rgba(255,255,255,.85);--surface-pop:rgba(255,255,255,.96);--field:rgba(208,215,222,.4);--field-hover:rgba(208,215,222,.8);--border:rgba(208,215,222,.8);--text:#24292f;--text-muted:#57606a;--accent:#0969da;--divider:rgba(0,0,0,.1);--shadow:rgba(0,0,0,.12)}
.bg-white{--surface:rgba(255,255,255,.9);--surface-pop:rgba(255,255,255,.98);--field:rgba(0,0,0,.05);--field-hover:rgba(0,0,0,.1);--border:rgba(0,0,0,.12);--text:#24292f;--text-muted:#57606a;--accent:#0969da;--divider:rgba(0,0,0,.1);--shadow:rgba(0,0,0,.1)}
.bg-dark #canvas-viewport{background-image:radial-gradient(circle,rgba(255,255,255,.06) 1px,transparent 1px)}
.bg-light #canvas-viewport{background-image:radial-gradient(circle,rgba(0,0,0,.08) 1px,transparent 1px)}
.bg-white #canvas-viewport{background-image:radial-gradient(circle,rgba(0,0,0,.06) 1px,transparent 1px)}
.bar{position:fixed;top:16px;right:16px;z-index:99;
  display:flex;gap:8px;align-items:center;height:32px;white-space:nowrap;
  background:transparent;backdrop-filter:none;padding:0;border:none;box-shadow:none}
.bar .grp{display:flex;gap:4px;align-items:center;height:32px;
  background:var(--surface);backdrop-filter:blur(12px);
  padding:4px 10px;border-radius:10px;border:1px solid var(--border);
  box-shadow:0 2px 12px var(--shadow)}
.bar .title{display:none}
.bar button,.bar select{padding:3px 8px;border:none;border-radius:6px;font-size:11px;font-weight:600;
  cursor:pointer;color:var(--text);transition:.15s;background:var(--field);line-height:1;
  display:inline-flex;align-items:center;gap:4px}
.bar button:hover,.bar select:hover{background:var(--field-hover)}
.bar button svg,.bar button img{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}
.bc:hover{background:#e94560!important}
/* Generic dropdown trigger (shared by theme + format selectors) */
.dd{position:relative;display:inline-flex;align-items:stretch;background:var(--field);border-radius:6px}
.dd-btn{padding:3px 8px;border:none;border-radius:6px;cursor:pointer;color:var(--text);
  font-size:11px;font-weight:600;display:inline-flex;align-items:center;gap:4px;background:transparent;transition:.15s}
.dd-btn:hover{background:var(--field-hover)}
.dd-caret{width:10px;height:10px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;transition:transform .15s}
.dd-caret.spin{transform:rotate(180deg)}
.dd-pop{position:absolute;top:calc(100% + 4px);right:0;z-index:100;min-width:100%;
  background:var(--surface-pop);backdrop-filter:blur(12px);
  border:1px solid var(--border);border-radius:8px;padding:4px;
  box-shadow:0 8px 24px var(--shadow);display:none}
.dd-pop.open{display:block}
.dd-pop button{display:flex;width:100%;align-items:center;gap:8px;
  padding:5px 8px;border-radius:5px;color:var(--text);background:transparent;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap}
.dd-pop button:hover{background:var(--field-hover)}
.dd-pop button.active{color:var(--accent)}
/* Download split button: main (download) + caret (switch), reusing dd styling.
   Selector is prefixed with .bar so its specificity ties .bar button and wins
   by source order (these rules come later), otherwise the universal
   .bar button{border:none;border-radius:6px} would flatten the half-round
   corners and erase the divider. */
.dl-split{display:inline-flex;align-items:stretch;background:var(--field);border-radius:6px}
.bar .dl-main{padding:3px 8px;border:none;border-radius:6px 0 0 6px;cursor:pointer;color:var(--text);
  font-size:11px;font-weight:600;display:inline-flex;align-items:center;gap:4px;background:transparent;transition:.15s}
.bar .dl-main:hover{background:var(--field-hover)}
.dl-main svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.bar .dl-toggle{padding:3px 6px;border:none;border-radius:0 6px 6px 0;border-left:1px solid var(--divider);
  cursor:pointer;color:var(--text);background:transparent;display:inline-flex;align-items:center;transition:.15s}
.bar .dl-toggle:hover{background:var(--field-hover)}
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
.tab:hover{color:#c9d1d9;background:rgba(48,54,61,.6)}
.tab.active{color:#58a6ff;background:rgba(31,111,235,.2);border-color:rgba(88,166,255,.4)}
.content{display:flex;min-height:100vh}
.content.split #canvas-viewport{border-right:1px solid #30363d}
#canvas-viewport{flex:1;overflow:hidden;padding:60px 24px 24px 24px;cursor:grab;user-select:none;
  background-image:radial-gradient(circle,rgba(128,128,128,.15) 1px,transparent 1px);
  background-size:20px 20px;text-align:center;position:relative}
#canvas-viewport>*+*{margin-top:12px}
#canvas-viewport:active{cursor:grabbing}
#canvas-viewport.dragging{cursor:grabbing;scroll-behavior:auto}
#src-wrap{display:none;flex:1;overflow:hidden;border-left:1px solid #30363d}
.content.split #src-wrap{display:flex;flex-direction:column}
#src{white-space:pre-wrap;font-family:"SF Mono",monospace;font-size:12px;
  line-height:1.7;background:#161b22;padding:16px;user-select:all;flex:1;overflow:auto;color:#c9d1d9}
#svg-wrap{display:inline-block;position:relative;left:0;top:0;vertical-align:top}
#svg-wrap svg{max-width:100%;height:auto;display:block}
.loading{color:#8b949e;font-size:14px;padding:40px 0;width:100%}
.fixes{position:fixed;bottom:16px;right:16px;z-index:10;
  background:rgba(28,18,4,.85);backdrop-filter:blur(8px);
  border:1px solid rgba(187,128,9,.4);border-radius:8px;padding:6px 12px;
  font-size:11px;color:#d29922;max-width:320px;display:none}
.err{background:#1c0a0a;border:1px solid #f85149;border-radius:6px;padding:16px;
  color:#f85149;font-family:monospace;white-space:pre-wrap;display:none;margin-bottom:12px;max-width:960px;width:100%}
.src-header{padding:8px 16px;background:#161b22;border-bottom:1px solid #30363d;
  display:flex;align-items:center;gap:8px}
.src-header span{color:#8b949e;font-size:12px;flex:1}
.src-header button{background:#30363d;border:none;border-radius:4px;color:#c9d1d9;
  padding:4px 10px;font-size:11px;cursor:pointer}
.src-header button:hover{background:#484f58}
.split-toggle{background:#6e40c9!important}.split-toggle:hover{background:#8957e5!important}
.zoom-bar{display:flex;align-items:center;gap:4px;height:32px;padding:4px 10px;border-radius:10px;
  background:rgba(22,27,34,.85);backdrop-filter:blur(12px);
  border:1px solid rgba(48,54,61,.6);box-shadow:0 2px 12px rgba(0,0,0,.3)}
.zoom-bar button{background:transparent;border:none;border-radius:5px;width:24px;height:24px;
  padding:2px;cursor:pointer;color:#8b949e;display:flex;align-items:center;justify-content:center;
  transition:all .15s}
.zoom-bar button:hover{color:#c9d1d9;background:rgba(48,54,61,.5)}
.zoom-bar button:disabled{opacity:.3;pointer-events:none}
.zoom-bar button:focus-visible{outline:2px solid #58a6ff;outline-offset:2px}
.zoom-bar span{color:#8b949e;font-size:11px;min-width:36px;text-align:center;
  font-variant-numeric:tabular-nums;line-height:1}
.zoom-bar svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;
  stroke-linecap:round;stroke-linejoin:round}
</style></head><body class="bg-${theme}">
<div class="bar">
  <span id="title" style="display:none"></span>
  <div class="grp" id="zb">
    <button id="zout" title="Zoom out" aria-label="Zoom out" onclick="zoom(-10)">
      <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/><path d="M8 11h6"/></svg>
    </button>
    <span id="zl" aria-live="polite" role="status">100%</span>
    <button id="zin" title="Zoom in" aria-label="Zoom in" onclick="zoom(10)">
      <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/><path d="M8 11h6"/><path d="M11 8v6"/></svg>
    </button>
    <button id="zreset" title="Reset view" aria-label="Reset view" onclick="zoom(0)">
      <svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
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
    <div id="src"></div>

  </div>
</div>
<script type="module">
const DIAGRAMS = ${JSON.stringify(diagrams)};
const INIT_BG = "${theme}";

let zoomLevel = 100;
let svgNaturalW = -1, svgNaturalH = -1;
let mermaidLib = null;
let currentBg = INIT_BG;
let activeIdx = 0;

const bgClass = { dark: "bg-dark", light: "bg-light", white: "bg-white" };
const bgFill  = { dark: "#0d1117", light: "#f6f8fa", white: "#ffffff" };
const themeMap = { dark: "dark", light: "default", white: "base" };
const EMOJI_RE = new RegExp("${EMOJI_RE_SRC}", "gu");

document.getElementById("bg_label").textContent = INIT_BG.charAt(0).toUpperCase() + INIT_BG.slice(1);
document.querySelectorAll("#bg_pop button[data-bg]").forEach(function(b){
  b.classList.toggle("active", b.getAttribute("data-bg") === INIT_BG);
});

if (DIAGRAMS.length > 1) {
  DIAGRAMS.forEach((d, i) => {
    const t = document.createElement("div");
    t.className = "tab" + (i === 0 ? " active" : "");
    t.textContent = d.label;
    t.onclick = () => switchTab(i);
    document.getElementById("tabs").appendChild(t);
  });
}

function updateZoomButtons() {
  document.getElementById("zin").disabled = zoomLevel >= 400;
  document.getElementById("zout").disabled = zoomLevel <= 25;
}

function switchTab(idx) {
  activeIdx = idx;
  document.querySelectorAll(".tab").forEach((t, i) =>
    t.classList.toggle("active", i === idx));
  zoomLevel = 100;
  updateZoomButtons();
  if (window.resetPan) window.resetPan();
  render(themeMap[currentBg] || "dark");
  document.getElementById("srcLabel").textContent = "SOURCE #" + (idx + 1);
}

${quoteBareLabels.toString()}

async function render(theme) {
  const d = DIAGRAMS[activeIdx];
  document.getElementById("ld").style.display = "block";
  document.getElementById("svg").innerHTML = "";
  document.getElementById("fx").style.display = "none";
  document.getElementById("er").style.display = "none";

  // Try-first: render the user's source verbatim. Only if Mermaid rejects it
  // do we run quoteBareLabels() and retry once. Valid source is never rewritten.
  let svg = null, fixes = null, err = null;
  try {
    if (!mermaidLib) {
      mermaidLib = (await import("https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs")).default;
    }
    mermaidLib.initialize({startOnLoad:false,theme:theme,securityLevel:"loose",
      themeVariables: theme === "dark" ? {} : { fontSize:"14px", fontFamily:"-apple-system,sans-serif" },
      flowchart:{useMaxWidth:true,htmlLabels:true,curve:"basis"}});
    try {
      svg = (await mermaidLib.render("m" + Date.now(), d.code)).svg;
    } catch (e1) {
      const healed = quoteBareLabels(d.code);
      if (!healed.fixes.length) throw e1;          // nothing to heal → surface original error
      svg = (await mermaidLib.render("m" + Date.now() + "f", healed.code)).svg;
      d.code = healed.code;                         // surface healed source in split view / copy
      fixes = healed.fixes;
    }
  } catch (e) {
    err = e;
  }

  document.getElementById("ld").style.display = "none";
  if (err) {
    const el = document.getElementById("er");
    el.textContent = err.message; el.style.display = "block";
    document.getElementById("title").textContent = "Error";
  } else {
    document.getElementById("svg").innerHTML = svg;
    document.getElementById("title").textContent = d.label;

    const svgEl = document.querySelector("#svg svg");
    if (svgEl) {
      svgNaturalW = svgEl.viewBox?.baseVal?.width || svgEl.getBBox?.().width || 400;
      svgNaturalH = svgEl.viewBox?.baseVal?.height || svgEl.getBBox?.().height || 300;
      svgEl.setAttribute("width", String(svgNaturalW));
      svgEl.setAttribute("height", String(svgNaturalH));
      const wrap = document.getElementById("svg-wrap");
      wrap.style.width = svgNaturalW + "px";
      wrap.style.maxWidth = "";
    }

    const fxEl = document.getElementById("fx");
    if (fixes && fixes.length) {
      fxEl.innerHTML = "<strong>Auto-fixed:</strong> " + fixes.map(f => f.replace(/&/g,"&amp;").replace(/</g,"&lt;")).join(" &middot; ");
      fxEl.style.display = "block";
    }
  }
  document.getElementById("src").textContent = d.code;
}
render(themeMap[INIT_BG] || "dark");
updateZoomButtons();

function applyZoom() {
  const svgEl = document.querySelector("#svg svg");
  if (!svgEl || svgNaturalW <= 0) return;
  const s = zoomLevel / 100;
  const zw = Math.round(svgNaturalW * s);
  const zh = Math.round(svgNaturalH * s);
  svgEl.setAttribute("width", String(zw));
  svgEl.setAttribute("height", String(zh));
  svgEl.style.maxWidth = zoomLevel > 100 ? "none" : "";
  const wrap = document.getElementById("svg-wrap");
  wrap.style.width = zw + "px";
  wrap.style.maxWidth = zoomLevel > 100 ? "none" : "";
  document.getElementById("zl").textContent = zoomLevel + "%";
  updateZoomButtons();
}

window.zoom = function(delta) {
  if (delta === 0) {
    zoomLevel = 100;
    if (window.resetPan) window.resetPan();
  } else {
    zoomLevel = Math.max(25, Math.min(400, zoomLevel + delta));
  }
  applyZoom();
};

// Ctrl+scroll = zoom (intercept before browser handles it)
window.addEventListener("wheel", function(e) {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    zoomLevel = Math.max(25, Math.min(400, zoomLevel + (e.deltaY < 0 ? 10 : -10)));
    applyZoom();
  }
}, { passive: false });

window.setBg = function(v) {
  currentBg = v;
  document.body.className = bgClass[v] || "bg-dark";
  // sync the theme dropdown label + active item
  document.getElementById("bg_label").textContent = (v.charAt(0).toUpperCase() + v.slice(1));
  document.querySelectorAll("#bg_pop button[data-bg]").forEach(function(b){
    b.classList.toggle("active", b.getAttribute("data-bg") === v);
  });
  closeAllPops();
  render(themeMap[v] || "dark");
};

function getSvgEl() { return document.querySelector("#svg svg"); }

function svgNaturalSize(el) {
  const vb = el.viewBox?.baseVal;
  if (vb && vb.width > 0 && vb.height > 0) return { w: vb.width, h: vb.height };
  const bbox = el.getBBox?.();
  if (bbox) return { w: bbox.width, h: bbox.height };
  return { w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height };
}

window.exportSvg = function() {
  const svgEl = getSvgEl();
  if (!svgEl) { alert("No diagram to export"); return; }
  const d = DIAGRAMS[activeIdx];
  const clone = svgEl.cloneNode(true);
  const { w, h } = svgNaturalSize(svgEl);
  clone.setAttribute("width", w);
  clone.setAttribute("height", h);
  clone.style.background = bgFill[currentBg] || "#0d1117";
  const data = new XMLSerializer().serializeToString(clone).replace(EMOJI_RE, "");
  const blob = new Blob([data], { type: "image/svg+xml" });
  const a = document.createElement("a");
  a.download = (d.label || "mermaid") + "-" + Date.now() + ".svg";
  a.href = URL.createObjectURL(blob);
  a.click();
  URL.revokeObjectURL(a.href);
};

window.exportPng = function() {
  const svgEl = getSvgEl();
  if (!svgEl) { alert("No diagram to export"); return; }
  const d = DIAGRAMS[activeIdx];
  const { w, h } = svgNaturalSize(svgEl);
  const scale = 3;
  const canvas = document.createElement("canvas");
  canvas.width = w * scale; canvas.height = h * scale;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = bgFill[currentBg] || "#0d1117";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const data = new XMLSerializer().serializeToString(svgEl).replace(EMOJI_RE, "");
  const img = new Image();
  img.onload = function() {
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const a = document.createElement("a");
    a.download = (d.label || "mermaid") + "-" + Date.now() + ".png";
    a.href = canvas.toDataURL("image/png");
    a.click();
  };
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(data);
};

// Shared dropdown helpers — both theme (.dd) and format (.dl-split) popups
// use .dd-pop.open + a .dd-caret.spin that must be reset together.
function closeAllPops(){
  document.querySelectorAll(".dd-pop.open").forEach(function(p){ p.classList.remove("open"); });
  document.querySelectorAll(".dd-caret.spin").forEach(function(c){ c.classList.remove("spin"); });
}

// Download split button: one-click download + format switcher.
let dlFormat = "png";
try { dlFormat = localStorage.getItem("mv:dlFormat") === "svg" ? "svg" : "png"; } catch {}
function toggleDlMenu(){
  const pop = document.getElementById("dlm");
  const willOpen = !pop.classList.contains("open");
  closeAllPops();
  if (willOpen) { pop.classList.add("open"); document.getElementById("dlm_caret").classList.add("spin"); }
}
function applyFormat(){
  const fmt = dlFormat.toUpperCase();
  document.getElementById("dlm_fmt").textContent = fmt;
  document.getElementById("dlm_main").title = "Download " + fmt;
  document.querySelectorAll("#dlm button[data-fmt]").forEach(function(b){
    b.classList.toggle("active", b.getAttribute("data-fmt") === dlFormat);
  });
}
function doDownload(){
  closeAllPops();
  (dlFormat === "svg" ? window.exportSvg : window.exportPng)();
}
function setFormat(fmt){
  dlFormat = fmt;
  try { localStorage.setItem("mv:dlFormat", fmt); } catch {}
  applyFormat();
  closeAllPops();
}
// Event delegation on the format split button.
document.getElementById("dl_split").addEventListener("click", function(e){
  e.stopPropagation();
  if (e.target.closest(".dl-main")) { doDownload(); return; }
  if (e.target.closest(".dl-toggle")) { toggleDlMenu(); return; }
  const item = e.target.closest("[data-fmt]");
  if (item) { setFormat(item.getAttribute("data-fmt")); return; }
});
// Theme dropdown: open/close + pick.
document.getElementById("bg_dd").addEventListener("click", function(e){
  e.stopPropagation();
  const item = e.target.closest("[data-bg]");
  if (item) { window.setBg(item.getAttribute("data-bg")); return; }
  if (e.target.closest(".dd-btn")) {
    const pop = document.getElementById("bg_pop");
    const willOpen = !pop.classList.contains("open");
    closeAllPops();
    if (willOpen) { pop.classList.add("open"); document.getElementById("bg_caret").classList.add("spin"); }
  }
});
// Close any open popup when clicking outside both dropdowns.
document.addEventListener("click", function(e) {
  if (!e.target.closest(".dl-split") && !e.target.closest(".dd")) closeAllPops();
});
applyFormat();

window.copyCode = function() {
  navigator.clipboard.writeText(DIAGRAMS[activeIdx].code).then(() => {
    const b = document.getElementById("cb"); b.textContent = "Copied!";
    setTimeout(() => b.textContent = "Copy", 1500);
  });
};
window.copySrc = function() {
  navigator.clipboard.writeText(DIAGRAMS[activeIdx].code).then(function() {
    var b = document.querySelector(".src-header button");
    b.textContent = "Copied!";
    setTimeout(function() { b.textContent = "Copy"; }, 1500);
  });
};

// Drag-to-pan — global vars for reliable access
let _panX = 0, _panY = 0;
let _dragging = false, _mx = 0, _my = 0, _sx = 0, _sy = 0;
function _applyPan() {
  const w = document.getElementById("svg-wrap");
  if (w) { w.style.left = _panX + "px"; w.style.top = _panY + "px"; }
}
document.addEventListener("mousedown", function(e) {
  if (e.button > 0) return;
  if (e.target.closest("button") || e.target.closest("select")) return;
  if (!document.getElementById("canvas-viewport").contains(e.target)) return;
  e.preventDefault();
  _dragging = true;
  _mx = e.pageX; _my = e.pageY;
  _sx = _panX; _sy = _panY;
  document.getElementById("canvas-viewport").classList.add("dragging");
});
document.addEventListener("mousemove", function(e) {
  if (!_dragging) return;
  _panX = _sx + e.pageX - _mx;
  _panY = _sy + e.pageY - _my;
  _applyPan();
});
document.addEventListener("pointermove", function(e) {
  if (!_dragging) return;
  _panX = _sx + e.pageX - _mx;
  _panY = _sy + e.pageY - _my;
  _applyPan();
});
document.addEventListener("mouseup", function() {
  if (!_dragging) return;
  _dragging = false;
  const vp = document.getElementById("canvas-viewport");
  if (vp) vp.classList.remove("dragging");
});
window.resetPan = function() { _panX = 0; _panY = 0; _applyPan(); };
document.getElementById("svg-wrap").style.position = "relative";

window.toggleSrc = function() {
  const c = document.getElementById("content");
  const b = document.getElementById("sb");
  if (c.classList.contains("split")) {
    c.classList.remove("split");
    b.textContent = "Split";
  } else {
    c.classList.add("split");
    b.textContent = "Close";
  }
};
</script></body></html>`;
}

// ============================================================================
// Browser opening
// ============================================================================

function openInBrowser(path: string, ctx: ExtensionCommandContext): void {
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

// ============================================================================
// Mermaid block extraction from session
// ============================================================================

export function extractMermaidBlocks(ctx: ExtensionCommandContext): MermaidBlock[] {
  const blocks: MermaidBlock[] = [];
  let idx = 0;

  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type !== "text" || !block.text) continue;
      for (const m of block.text.matchAll(/```mermaid\s*\n([\s\S]*?)```/g)) {
        idx += 1;
        blocks.push({ raw: m[1].trim(), label: `Diagram ${idx}` });
      }
    }
  }

  return blocks;
}

export function labelBlocks(blocks: MermaidBlock[]): void {
  blocks.reverse();
  blocks.forEach((b, i) => {
    if (blocks.length === 1) {
      b.label = "Diagram";
    } else {
      b.label = `#${blocks.length - i}${i === 0 ? " (latest)" : ""}`;
    }
  });
}

// ============================================================================
// Extension
// ============================================================================

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("mermaid", {
    description: "Render Mermaid diagrams from the conversation in the browser",

    handler: async (_args, ctx) => {
      const blocks = extractMermaidBlocks(ctx);

      if (blocks.length === 0) {
        ctx.ui.notify("No Mermaid diagrams found in the conversation.", "error");
        return;
      }

      labelBlocks(blocks);

      const diagrams: DiagramData[] = blocks.map((b) => ({
        code: b.raw,
        label: b.label,
      }));

      const theme = detectSystemTheme();
      const html = renderHtml(diagrams, theme);
      const path = join(tmpdir(), `mermaid-${Date.now()}.html`);

      writeFileSync(path, html, "utf-8");
      openInBrowser(path, ctx);
    },
  });
}
