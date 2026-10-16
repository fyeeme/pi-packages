import { quoteBareLabels } from "./healer.ts";
import type { DiagramData } from "./types.ts";

// Browser-side module script for the preview page.
//
// BACKSLASH SAFETY: this source is authored inside String.raw, so regex
// literals (EMOJI_RE, ICON_SYNTAX_RE) keep their backslashes verbatim.
// The two historical template-literal bugs (EMOJI_RE corrupted to
// /[p{Emoji...}]/gu silently breaking PNG export; see CHANGELOG 1.0.0) are
// structurally impossible here — no regex source strings, no runtime
// `new RegExp` assembly. Only quoteBareLabels is still injected via
// Function.prototype.toString() so the healer stays a single tested source.

const MERMAID_URL =
	"https://cdn.jsdelivr.net/npm/mermaid@12.2.0/dist/mermaid.esm.min.mjs";
const SVG2ROUGHJS_URL = "https://cdn.jsdelivr.net/npm/svg2roughjs@3.2.3/+esm";
const ZENUML_URL =
	"https://cdn.jsdelivr.net/npm/@mermaid-js/mermaid-zenuml@0/dist/mermaid-zenuml.esm.min.mjs";
export const FA_CSS_URL =
	"https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6/css/all.min.css";

/** Serialize the diagram payload for embedding in a module script. */
function diagramsPayload(diagrams: DiagramData[]): string {
	return JSON.stringify(diagrams)
		.replace(/</g, "\\u003c")
		.replace(/\u2028/g, "\\u2028")
		.replace(/\u2029/g, "\\u2029");
}

export function pageScript(diagrams: DiagramData[], theme: "dark" | "light"): string {
	return String.raw`const DIAGRAMS = ${diagramsPayload(diagrams)};
const INIT_BG = "${theme}";

const MERMAID_URL = "${MERMAID_URL}";
const ZENUML_URL = "${ZENUML_URL}";
const SVG2ROUGHJS_URL = "${SVG2ROUGHJS_URL}";
const FA_CSS_URL = "${FA_CSS_URL}";
const ICON_SYNTAX_RE = /(?:fa:fa-|icon:)/;
const EMOJI_RE = /[\p{Emoji_Presentation}\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;

// Pan/zoom engine — operates on the SVG viewBox, the same single-coordinate-
// system mechanism svg-pan-zoom uses on mermaid.live. No CSS left/top offset
// stacked on top of text-align centering, so panning cannot drift; wheel zoom
// anchors at the cursor like svg-pan-zoom's zoomAtPoint.
const MIN_REL = 20, MAX_REL = 1200; // % of fit size (svg-pan-zoom range 0.2–12)
const pz = { z: 1, fitZ: 1, cx: 0, cy: 0, nw: 0, nh: 0, nx: 0, ny: 0, dirty: false };
let mermaidLib = null;
let currentBg = INIT_BG;
let activeIdx = 0;

const bgClass = { dark: "bg-dark", light: "bg-light", white: "bg-white" };
const bgFill  = { dark: "#0d1117", light: "#f6f8fa", white: "#ffffff" };
const themeMap = { dark: "redux-dark-color", light: "redux-color", white: "redux-color" };

// The CDN ESM build already bundles every built-in diagram type and the
// lazy ELK/tidy-tree layout chunks (flowchart-elk works with no extra
// registration). ZenUML is the one external diagram — register it when the
// package is reachable; degrade silently otherwise (all other types keep
// working).
async function loadMermaid() {
  if (mermaidLib) return mermaidLib;
  const m = (await import(MERMAID_URL)).default;
  try {
    const zenuml = (await import(ZENUML_URL)).default;
    await m.registerExternalDiagrams([zenuml]);
  } catch (e) {
    console.warn("zenuml diagrams unavailable:", e);
  }
  mermaidLib = m;
  return m;
}

// mermaid.live's rough:true pipeline: post-process the classic render with
// Svg2Roughjs (kept on a laid-out hidden host — the library measures the
// source with getBBox, which returns zeros under display:none). Falls back
// to the classic SVG on any failure.
let roughMod = null;
async function roughify(svgText) {
  try {
    if (!roughMod) roughMod = await import(SVG2ROUGHJS_URL);
    let host = document.getElementById("rough-src");
    if (!host) {
      host = document.createElement("div");
      host.id = "rough-src";
      host.style.cssText = "position:absolute;left:-99999px;top:0;width:0;height:0;overflow:hidden";
      document.body.appendChild(host);
    }
    host.innerHTML = svgText;
    const srcEl = host.querySelector("svg");
    if (!srcEl) return svgText;
    const vb = srcEl.getAttribute("viewBox");
    let out = document.getElementById("rough-out");
    if (!out) {
      out = document.createElement("div");
      out.id = "rough-out";
      out.style.cssText = "position:absolute;left:-99999px;top:0;width:0;height:0;overflow:hidden";
      document.body.appendChild(out);
    }
    out.innerHTML = "";
    const rj = new roughMod.Svg2Roughjs(out);
    rj.svg = srcEl;
    await rj.sketch();
    const sketch = out.querySelector("svg");
    if (!sketch) return svgText;
    if (vb) sketch.setAttribute("viewBox", vb);
    return new XMLSerializer().serializeToString(sketch);
  } catch (e) {
    console.warn("hand-drawn post-process failed:", e);
    return svgText;
  }
}

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
  const rel = relPercent();
  document.getElementById("zin").disabled = rel >= MAX_REL;
  document.getElementById("zout").disabled = rel <= MIN_REL;
}

function switchTab(idx) {
  activeIdx = idx;
  document.querySelectorAll(".tab").forEach((t, i) =>
    t.classList.toggle("active", i === idx));
  render(themeMap[currentBg] || "dark");
  document.getElementById("srcLabel").textContent = "SOURCE #" + (idx + 1);
}

// esbuild/tsx keepNames wraps transpiled inner functions with __name(obj, name)
// (an identity wrapper that only sets the name property). The injected
// quoteBareLabels source below may reference it depending on the host
// transpiler — provide the identity fallback so it runs in any browser.
var __name = typeof __name === "function" ? __name : function (fn) { return fn; };
${quoteBareLabels.toString()}

async function render(theme) {
  const d = DIAGRAMS[activeIdx];
  document.getElementById("ld").style.display = "block";
  // No blanking here: while live-editing, a parse error must keep the last
  // good diagram visible next to the message (mermaid.live behavior).
  document.getElementById("fx").style.display = "none";
  document.getElementById("er").style.display = "none";

  // Try-first: render the user's source verbatim. Only if Mermaid rejects it
  // do we run quoteBareLabels() and retry once. Valid source is never rewritten.
  let svg = null, fixes = null, err = null;
  try {
    const mermaidLib = await loadMermaid();
    // FontAwesome glyphs: when the diagram uses fa:/icon: syntax, wait for
    // the webfont (linked in <head>) so icons don't rasterize as blanks.
    if (ICON_SYNTAX_RE.test(d.code) && document.fonts && document.fonts.ready) {
      try { await document.fonts.ready; } catch (e) {}
    }
    // mermaid.live passes only the theme — theme defaults (fonts, sizes)
    // carry the redux look. Hand-drawn is NOT look:"handDrawn" (which paints
    // clusters in saturated accents); mermaid.live roughifies a classic
    // render through Svg2Roughjs, so pastel cluster fills survive.
    mermaidLib.initialize({startOnLoad:false,theme:theme,securityLevel:"loose",
      flowchart:{useMaxWidth:true,htmlLabels:true,curve:"basis"}});
    try {
      svg = (await mermaidLib.render("m" + Date.now(), d.code)).svg;
      if (drawLook) svg = await roughify(svg);
    } catch (e1) {
      const healed = quoteBareLabels(d.code);
      if (!healed.fixes.length) throw e1;          // nothing to heal → surface original error
      svg = (await mermaidLib.render("m" + Date.now() + "f", healed.code)).svg;
      d.code = healed.code;                         // surface healed source in split view / copy
      fixes = healed.fixes;
      if (drawLook) svg = await roughify(svg);
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
    document.getElementById("svg").innerHTML = svg; // replaces any stale/last-good render
    document.getElementById("title").textContent = d.label;

    // Fit + center fresh renders — but during live editing keep the view
    // the user has panned/zoomed (svg-pan-zoom keeps pan across re-renders).
    if (captureNatural()) { if (pz.dirty) applyVB(); else resetView(); }

    const fxEl = document.getElementById("fx");
    if (fixes && fixes.length) {
      fxEl.innerHTML = "<strong>Auto-fixed:</strong> " + fixes.map(f => f.replace(/&/g,"&amp;").replace(/</g,"&lt;")).join(" &middot; ");
      fxEl.style.display = "block";
    }
  }
  syncEditor(d);
}

// --- Editor (Split view): editable source with live preview ---
function syncEditor(d) {
  var ta = document.getElementById("src");
  // only overwrite when content actually changed (auto-fix or tab switch) so
  // the caret survives normal re-renders
  if (ta.value !== d.code) ta.value = d.code;
  updateGutter();
}
function updateGutter() {
  var ta = document.getElementById("src");
  var n = ta.value.split("\n").length;
  var out = "";
  for (var i = 1; i <= n; i++) out += i + "\n";
  var g = document.getElementById("src_gutter");
  g.textContent = out;
  g.scrollTop = ta.scrollTop;
}

var editTimer = null;
document.getElementById("src").addEventListener("input", function() {
  var d = DIAGRAMS[activeIdx];
  d.code = this.value;
  updateGutter();
  clearTimeout(editTimer);
  editTimer = setTimeout(function() { render(themeMap[currentBg] || "dark"); }, 400);
});
document.getElementById("src").addEventListener("scroll", function() {
  document.getElementById("src_gutter").scrollTop = this.scrollTop;
});
// Tab inserts an indent instead of leaving the editor
document.getElementById("src").addEventListener("keydown", function(e) {
  if (e.key !== "Tab") return;
  e.preventDefault();
  var s = this.selectionStart, en = this.selectionEnd;
  this.value = this.value.slice(0, s) + "    " + this.value.slice(en);
  this.selectionStart = this.selectionEnd = s + 4;
  this.dispatchEvent(new Event("input"));
});
syncEditor(DIAGRAMS[activeIdx]);
render(themeMap[INIT_BG] || "dark");
updateZoomButtons();

function svgViewEl() { return document.querySelector("#svg svg"); }
function viewportEl() { return document.getElementById("canvas-viewport"); }
function relPercent() { return Math.round(pz.z / pz.fitZ * 100); }

function applyVB() {
  const el = svgViewEl();
  if (!el) return;
  const vp = viewportEl();
  const w = vp.clientWidth / pz.z, h = vp.clientHeight / pz.z;
  // The viewBox spans exactly the viewport aspect ratio, so
  // preserveAspectRatio="none" never distorts: content scale is pz.z px per
  // viewBox unit everywhere, and pan offsets carry no letterbox term.
  el.setAttribute("width", "100%");
  el.setAttribute("height", "100%");
  el.setAttribute("preserveAspectRatio", "none");
  // Mermaid ships useMaxWidth SVGs with style="max-width:<natural>px" which
  // clamps the 100% box back down to natural size and parks the diagram in
  // the top-left — neutralize it so the viewBox engine owns all sizing.
  el.style.maxWidth = "none";
  el.style.width = "100%";
  el.style.height = "100%";
  el.setAttribute("viewBox", (pz.cx - w / 2) + " " + (pz.cy - h / 2) + " " + w + " " + h);
  document.getElementById("zl").textContent = relPercent() + "%";
  updateZoomButtons();
}

// Capture the diagram's natural bounds once per render. applyVB overwrites
// the viewBox attribute, so re-reading it later would return our own view
// box, not the content — that polluted the second resetView's fit.
function captureNatural() {
  const el = svgViewEl();
  if (!el) return false;
  const vb = el.viewBox && el.viewBox.baseVal;
  const box = (vb && vb.width > 0 && vb.width < 1e7)
    ? { x: vb.x, y: vb.y, w: vb.width, h: vb.height }
    : (el.getBBox ? el.getBBox() : null);
  if (!box || !box.w || !box.h) return false;
  pz.nx = box.x + box.w / 2;
  pz.ny = box.y + box.h / 2;
  pz.nw = box.w;
  pz.nh = box.h;
  return true;
}

// fit: scale the content to the viewport; center: content center = view
// center (svg-pan-zoom fit:true center:true).
function resetView() {
  if (!pz.nw) return;
  pz.cx = pz.nx;
  pz.cy = pz.ny;
  const vp = viewportEl();
  // canvas-viewport padding: 60px top, 24px sides and bottom
  const availW = Math.max(1, vp.clientWidth - 48);
  const availH = Math.max(1, vp.clientHeight - 84);
  pz.fitZ = Math.min(availW / pz.nw, availH / pz.nh);
  pz.z = pz.fitZ;
  pz.dirty = false;
  applyVB();
}

// Zoom by factor, keeping the viewBox point under (mx,my) fixed — the
// cursor-anchored zoom that makes svg-pan-zoom feel glued to the pointer.
function zoomAt(mx, my, factor) {
  const vp = viewportEl();
  const rel = Math.min(MAX_REL, Math.max(MIN_REL, Math.round(relPercent() * factor)));
  const nz = pz.fitZ * rel / 100;
  if (nz === pz.z) return;
  const px = pz.cx + (mx - vp.clientWidth / 2) / pz.z;
  const py = pz.cy + (my - vp.clientHeight / 2) / pz.z;
  pz.z = nz;
  pz.cx = px - (mx - vp.clientWidth / 2) / pz.z;
  pz.cy = py - (my - vp.clientHeight / 2) / pz.z;
  pz.dirty = true;
  applyVB();
}

function panBy(dx, dy) {
  pz.cx -= dx / pz.z;
  pz.cy -= dy / pz.z;
  pz.dirty = true;
  applyVB();
}

window.zoom = function(delta) {
  if (delta === 0) { resetView(); return; }
  const vp = viewportEl();
  zoomAt(vp.clientWidth / 2, vp.clientHeight / 2, delta > 0 ? 1.2 : 1 / 1.2);
};

// Wheel = zoom anchored at the cursor (svg-pan-zoom default; the preview
// viewport has no page scroll to compete with).
window.addEventListener("wheel", function(e) {
  e.preventDefault();
  const r = viewportEl().getBoundingClientRect();
  zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.1 : 1 / 1.1);
}, { passive: false });

// Keyboard zoom — browser-standard mapping: Cmd/Ctrl +/-/= zoom, Cmd/Ctrl+0
// fits the view. preventDefault keeps the browser page-zoom out of the way.
document.addEventListener("keydown", function(e) {
  if (!(e.metaKey || e.ctrlKey)) return;
  if (e.key === "-" || e.key === "_") { e.preventDefault(); window.zoom(-10); }
  else if (e.key === "=" || e.key === "+") { e.preventDefault(); window.zoom(10); }
  else if (e.key === "0") { e.preventDefault(); window.zoom(0); }
});

// Refit on container resize unless the user has moved the view (the
// ResizeObserver behavior of mermaid.live's PanZoomState).
new ResizeObserver(function() { if (pz.dirty) applyVB(); else resetView(); })
  .observe(document.getElementById("canvas-viewport"));

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
  // Icon nodes reference FontAwesome classes; a standalone SVG file needs
  // the stylesheet, or the glyphs silently disappear when opened elsewhere.
  if (ICON_SYNTAX_RE.test(d.code)) {
    const styleEl = document.createElementNS("http://www.w3.org/2000/svg", "style");
    styleEl.textContent = '@import url("' + FA_CSS_URL + '");';
    clone.prepend(styleEl);
  }
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

// View toggles: hand-drawn look (mermaid look:"handDrawn" — unsupported
// diagram types fall back to classic silently) and the canvas grid, both
// persisted like the download format.
let drawLook = false;
let showGrid = true;
try { drawLook = localStorage.getItem("mv:look") === "handDrawn"; } catch {}
try { showGrid = localStorage.getItem("mv:grid") !== "off"; } catch {}
function applyViewToggles() {
  document.body.classList.toggle("no-grid", !showGrid);
  const roughBtn = document.getElementById("rough_btn");
  roughBtn.classList.toggle("on", drawLook);
  roughBtn.setAttribute("aria-pressed", drawLook ? "true" : "false");
  const gridBtn = document.getElementById("grid_btn");
  gridBtn.classList.toggle("on", showGrid);
  gridBtn.setAttribute("aria-pressed", showGrid ? "true" : "false");
}
applyViewToggles();
// Fullscreen toggle (corner-bracket button; Esc exits natively).
document.getElementById("fs_btn").addEventListener("click", function() {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else if (document.documentElement.requestFullscreen) {
    document.documentElement.requestFullscreen().catch(function(e) {
      console.warn("fullscreen unavailable:", e);
    });
  }
});
document.addEventListener("fullscreenchange", function() {
  var on = !!document.fullscreenElement;
  var b = document.getElementById("fs_btn");
  b.classList.toggle("on", on);
  b.setAttribute("aria-pressed", on ? "true" : "false");
});

document.getElementById("rough_btn").addEventListener("click", function() {
  drawLook = !drawLook;
  try { localStorage.setItem("mv:look", drawLook ? "handDrawn" : "classic"); } catch {}
  applyViewToggles();
  render(themeMap[currentBg] || "dark");
});
document.getElementById("grid_btn").addEventListener("click", function() {
  showGrid = !showGrid;
  try { localStorage.setItem("mv:grid", showGrid ? "on" : "off"); } catch {}
  applyViewToggles();
});

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

// Drag-to-pan — one pointer stream with pointer capture. The old parallel
// mousemove+pointermove listeners both mutated pan state and were a drift
// source; a captured pointer delivers every move exactly once.
let _dragging = false, _lastX = 0, _lastY = 0;
const _vp = document.getElementById("canvas-viewport");
_vp.addEventListener("pointerdown", function(e) {
  if (e.button !== 0) return;
  if (e.target.closest("button") || e.target.closest("select")) return;
  _dragging = true;
  _lastX = e.clientX; _lastY = e.clientY;
  _vp.setPointerCapture(e.pointerId);
  _vp.classList.add("dragging");
  e.preventDefault();
});
_vp.addEventListener("pointermove", function(e) {
  if (!_dragging) return;
  panBy(e.clientX - _lastX, e.clientY - _lastY);
  _lastX = e.clientX; _lastY = e.clientY;
});
function _endDrag() {
  if (!_dragging) return;
  _dragging = false;
  _vp.classList.remove("dragging");
}
_vp.addEventListener("pointerup", _endDrag);
_vp.addEventListener("pointercancel", _endDrag);

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
};`;
}
