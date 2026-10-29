(function () {
	"use strict";
	function esc(s) {
		return String(s)
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#39;");
	}

	// --- markdown parity with the TUI renderer (packages/tui/src/components/markdown.ts) ---
	// 1. Strict strikethrough: ~~text~~ without inner edge spaces.
	var STRICT_DEL = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;
	// 2. LaTeX delimiters with the same heuristics as the TUI tokenizer.
	function isEscaped(src, index) {
		var backslashes = 0;
		for (var p = index - 1; p >= 0 && src[p] === "\\"; p--) backslashes++;
		return backslashes % 2 === 1;
	}
	function findClosing(source, closing, start) {
		var index = source.indexOf(closing, start);
		while (index >= 0 && isEscaped(source, index)) index = source.indexOf(closing, index + closing.length);
		return index;
	}
	function tokenizeInlineLatex(src) {
		var opening = "";
		var closing = "";
		if (src.startsWith("$$")) {
			opening = "$$";
			closing = "$$";
		} else if (src.startsWith("\\(")) {
			opening = "\\(";
			closing = "\\)";
		} else if (src.startsWith("\\[")) {
			opening = "\\[";
			closing = "\\]";
		} else if (src.startsWith("$") && !/^\$\s/.test(src)) {
			opening = "$";
			closing = "$";
		} else {
			return undefined;
		}
		var end = findClosing(src, closing, opening.length);
		if (end < 0) return undefined;
		var inner = src.slice(opening.length, end);
		if (
			opening === "$" &&
			(/\s$/.test(inner) ||
				/^\d/.test(src.slice(end + 1)) ||
				(/^[A-Z_][A-Z0-9_]*(?:[^A-Za-z0-9_\s])?$/.test(inner) &&
					/^[A-Za-z_][A-Za-z0-9_]*/.test(src.slice(end + 1))) ||
				inner.includes("`"))
		) {
			return undefined;
		}
		return { type: "latex", raw: src.slice(0, end + closing.length), text: inner };
	}
	function tokenizeBlockLatex(src) {
		var dollar = /^ {0,3}\$\$[ \t]*(?:\n)?([\s\S]*?)\$\$[ \t]*(?:\n|$)/.exec(src);
		if (dollar && dollar[1]) return { type: "latexBlock", raw: dollar[0], text: dollar[1].trim() };
		var bracket = /^ {0,3}\\\[[ \t]*(?:\n)?([\s\S]*?)\\\][ \t]*(?:\n|$)/.exec(src);
		if (bracket && bracket[1]) return { type: "latexBlock", raw: bracket[0], text: bracket[1].trim() };
		return undefined;
	}

	marked.use({
		tokenizer: {
			del: function (src) {
				var m = STRICT_DEL.exec(src);
				if (!m) return undefined;
				return { type: "del", raw: m[0], text: m[2], tokens: this.lexer.inlineTokens(m[2]) };
			},
		},
		extensions: [
			{
				name: "latexBlock",
				level: "block",
				start: function (source) {
					var m = /(?:^|\n) {0,3}(?:\$\$|\\\[)/.exec(source);
					return m ? m.index + (m[0].startsWith("\n") ? 1 : 0) : undefined;
				},
				tokenizer: tokenizeBlockLatex,
				renderer: function (token) {
					return '<div class="md-math-block">' + esc(token.text) + "</div>";
				},
			},
			{
				name: "latex",
				level: "inline",
				start: function (source) {
					var indices = [source.indexOf("$"), source.indexOf("\\("), source.indexOf("\\[")].filter(
						function (i) {
							return i >= 0;
						},
					);
					return indices.length > 0 ? Math.min.apply(null, indices) : undefined;
				},
				tokenizer: tokenizeInlineLatex,
				renderer: function (token) {
					return '<span class="md-math">' + esc(token.text) + "</span>";
				},
			},
		],
		renderer: {
			// HTML is never rendered, only shown as text (TUI parity).
			html: function (token) {
				return '<span class="md-raw">' + esc(String(token.raw).trim()) + "</span>";
			},
			// Links show only their text; the URL goes to the tooltip (TUI hyperlink parity).
			link: function (token) {
				var inner =
					token.tokens && token.tokens.length ? this.parser.parseInline(token.tokens) : esc(token.text);
				return (
					'<a href="' +
					esc(token.href) +
					'" title="' +
					esc(token.href) +
					'" target="_blank" rel="noopener noreferrer">' +
					inner +
					"</a>"
				);
			},
			// Markdown images are not rendered either; show the raw markup (TUI parity).
			image: function (token) {
				return '<code class="md-raw">![' + esc(token.text || "") + "](" + esc(token.href) + ")</code>";
			},
		},
	});

	// --- mermaid diagrams (mermaid fence blocks), rendered client-side ---
	// The library is lazily imported from a CDN on first use; offline or
	// per-diagram parse failures degrade to the raw source block.
	var MERMAID_URL = "https://cdn.jsdelivr.net/npm/mermaid@12.2.0/dist/mermaid.esm.min.mjs";
	var mermaidLib = null; // resolved import cache; reset on failure to allow retry
	var mermaidSeq = 0; // unique render ids across the page lifetime

	function currentTheme() {
		return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
	}

	function loadMermaid() {
		if (!mermaidLib) {
			// mermaid@12 ESM ships a default-only export; unwrap it.
			mermaidLib = import(MERMAID_URL)
				.then(function (mod) {
					return mod && mod.default ? mod.default : mod;
				})
				.catch(function (err) {
					mermaidLib = null; // allow a retry on the next render pass
					throw err;
				});
		}
		return mermaidLib;
	}

	function initMermaidTheme(mermaid) {
		mermaid.initialize({
			startOnLoad: false, // securityLevel stays at the safe default "strict"
			theme: currentTheme() === "dark" ? "dark" : "default",
		});
	}

	function b64encodeUtf8(text) {
		var bytes = new TextEncoder().encode(text);
		var bin = "";
		for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
		return btoa(bin);
	}

	function b64decodeUtf8(b64) {
		var bin = atob(b64);
		var bytes = new Uint8Array(bin.length);
		for (var c = 0; c < bin.length; c++) bytes[c] = bin.charCodeAt(c);
		return new TextDecoder().decode(bytes);
	}

	function mermaidSource(el) {
		try {
			return b64decodeUtf8(el.getAttribute("data-mmd") || "");
		} catch (e) {
			return "";
		}
	}

	/** Replace one container's content with an error line plus the raw source. */
	function degradeMermaid(el, src, message) {
		el.classList.remove("pending");
		el.classList.add("failed");
		el.innerHTML = "";
		var err = document.createElement("div");
		err.className = "md-mermaid-err";
		err.textContent = message;
		el.appendChild(err);
		var code = document.createElement("code");
		code.textContent = src;
		if (window.hljs) hljs.highlightElement(code);
		var pre = document.createElement("pre");
		pre.appendChild(code);
		el.appendChild(pre);
	}

	/** Remove the scratch/error elements mermaid leaves in <body> after a
	 * failed render (temp div "d<id>" holding the bomb-error svg "<id>"). */
	function cleanupMermaidScratch(id) {
		var leftover = document.getElementById("d" + id);
		if (leftover) leftover.remove();
		leftover = document.getElementById(id);
		if (leftover) leftover.remove();
	}

	// All mermaid.render calls on the page serialize through this queue:
	// concurrent renders share mermaid's DOM scratch space and corrupt each
	// other. The queue spans first render and theme re-renders alike.
	var renderQueue = Promise.resolve();
	function enqueueRender(step) {
		var run = renderQueue.then(step);
		renderQueue = run.then(function () {}, function () {});
		return run;
	}

	/** Render one diagram into its container; sync and async failures both
	 * degrade to an error line plus the source. isStale lets a superseded
	 * re-render pass drop its results instead of stomping the newer pass. */
	function renderOneMermaid(mermaid, el, src, isStale) {
		var renderId = "sw-mmd-" + ++mermaidSeq;
		try {
			return Promise.resolve(mermaid.render(renderId, src)).then(
				function (out) {
					if ((isStale && isStale()) || !el.isConnected) return;
					el.classList.remove("pending", "failed");
					el.innerHTML = out.svg;
				},
				function () {
					if (isStale && isStale()) return;
					cleanupMermaidScratch(renderId);
					degradeMermaid(el, src, "mermaid 渲染失败，已显示源码");
				},
			);
		} catch (e) {
			if (isStale && isStale()) return;
			cleanupMermaidScratch(renderId);
			degradeMermaid(el, src, "mermaid 渲染失败，已显示源码");
		}
	}

	function renderMermaidIn(root) {
		var codes = root.querySelectorAll(".md pre code.language-mermaid");
		if (!codes.length) return;
		// Phase 1 (sync): swap each source block for a placeholder carrying the
		// base64 source, so no dead markup stays in the DOM.
		var blocks = [];
		for (var i = 0; i < codes.length; i++) {
			var code = codes[i];
			var pre = code.parentNode;
			var src = code.textContent || "";
			var holder = document.createElement("div");
			holder.className = "md-mermaid pending";
			holder.setAttribute("data-mmd", b64encodeUtf8(src));
			holder.textContent = "图表渲染中…";
			if (pre && pre.parentNode) pre.parentNode.replaceChild(holder, pre);
			blocks.push({ el: holder, src: src });
		}
		// Phase 2 (async): import mermaid, then render each block through the
		// page-wide serial queue (see enqueueRender for why serial matters).
		loadMermaid().then(
			function (mermaid) {
				initMermaidTheme(mermaid);
				for (var j = 0; j < blocks.length; j++) {
					(function (block) {
						enqueueRender(function () {
							return renderOneMermaid(mermaid, block.el, block.src);
						});
					})(blocks[j]);
				}
			},
			function () {
				for (var k = 0; k < blocks.length; k++) {
					degradeMermaid(blocks[k].el, blocks[k].src, "mermaid 加载失败（离线？），已显示源码");
				}
			},
		);
	}

	// Render every markdown placeholder inside `root`. Exposed so the tab
	// switcher can re-run it after lazy-injecting a view fragment.
	function renderDoc(root) {
		var blocks = root.querySelectorAll("[data-md]");
		for (var i = 0; i < blocks.length; i++) {
			var el = blocks[i];
			try {
				var bin = atob(el.getAttribute("data-md"));
				var bytes = new Uint8Array(bin.length);
				for (var c = 0; c < bin.length; c++) bytes[c] = bin.charCodeAt(c);
				var src = new TextDecoder().decode(bytes);
				el.innerHTML = marked.parse(src, { async: false });
			} catch (e) {
				el.textContent = "(渲染失败)";
			}
		}
		if (window.hljs) {
			var code = root.querySelectorAll("pre code");
			for (var j = 0; j < code.length; j++) hljs.highlightElement(code[j]);
		}
		var links = root.querySelectorAll(".md a[href]");
		for (var k = 0; k < links.length; k++) links[k].target = "_blank";
		renderMermaidIn(root);
	}
	window.__swRenderDoc = renderDoc;
	renderDoc(document);

	// --- theme switching: re-render diagrams in the new theme ---
	// Stale-run guard: rapid light/dark flips must not interleave; only the
	// latest pass may touch the DOM.
	var rerenderSeq = 0;
	function rerenderAllMermaid() {
		var els = document.querySelectorAll(".md-mermaid");
		if (!els.length) return;
		var seq = ++rerenderSeq;
		loadMermaid().then(
			function (mermaid) {
				initMermaidTheme(mermaid);
				for (var i = 0; i < els.length; i++) {
					(function (el) {
						enqueueRender(function () {
							if (seq !== rerenderSeq) return; // superseded by a newer pass
							var src = mermaidSource(el);
							if (!src) return;
							return renderOneMermaid(mermaid, el, src, function () {
								return seq !== rerenderSeq;
							});
						});
					})(els[i]);
				}
			},
			function () {
				if (seq !== rerenderSeq) return;
				for (var k = 0; k < els.length; k++) {
					degradeMermaid(els[k], mermaidSource(els[k]), "mermaid 加载失败（离线？），已显示源码");
				}
			},
		);
	}
	new MutationObserver(function () {
		rerenderAllMermaid();
	}).observe(document.documentElement, {
		attributes: true,
		attributeFilter: ["data-theme"],
	});

	// --- click a rendered diagram to open it large in a new tab ---
	function openMermaidLarge(el) {
		var svg = el.querySelector("svg");
		if (!svg) return;
		var html =
			'<!DOCTYPE html><html><head><meta charset="utf-8"><title>mermaid</title></head>' +
			'<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;">' +
			'<div style="padding:16px;max-width:100%;overflow-x:auto;">' + svg.outerHTML + "</div></body></html>";
		var url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
		window.open(url, "_blank");
		setTimeout(function () {
			URL.revokeObjectURL(url);
		}, 60000);
	}
	// One delegated listener covers diagrams inside SPA-injected fragments too.
	document.addEventListener("click", function (ev) {
		var target = ev.target && ev.target.closest ? ev.target.closest(".md-mermaid:not(.pending):not(.failed)") : null;
		if (target) openMermaidLarge(target);
	});

	// --- SPA tabs: switch chat/trace without a page reload ---
	// Both panels live in one document. The inactive one is a placeholder that
	// lazily fetches its fragment (?fragment=1) on first activation.
	var main = document.getElementById("main");

	function panelFor(view) {
		return document.getElementById("view-" + view);
	}
	function activePanel() {
		return document.querySelector(".view-panel:not([hidden])");
	}
	function paintTabs(view) {
		var tabs = document.querySelectorAll(".view-tabs a[data-view]");
		for (var i = 0; i < tabs.length; i++)
			tabs[i].classList.toggle("active", tabs[i].getAttribute("data-view") === view);
	}
	function currentView() {
		var panel = activePanel();
		return panel ? (panel.getAttribute("data-view") || "chat") : "chat";
	}
	function swapTo(view) {
		var from = activePanel();
		var to = panelFor(view);
		if (!to || from === to) return;
		if (from) {
			from.setAttribute("data-scroll", String(main ? main.scrollTop : 0));
			from.hidden = true;
		}
		to.hidden = false;
		if (main) main.scrollTop = Number(to.getAttribute("data-scroll") || 0);
		paintTabs(view);
	}
	function activate(view, pushUrl, url) {
		var to = panelFor(view);
		if (!to) return;
		if (to.getAttribute("data-src")) {
			var src = to.getAttribute("data-src");
			to.removeAttribute("data-src");
			fetch(src)
				.then(function (r) {
					if (!r.ok) throw new Error("HTTP " + r.status);
					return r.text();
				})
				.then(function (html) {
					to.innerHTML = html;
					renderDoc(to);
					swapTo(view);
				})
				.catch(function () {
					to.innerHTML =
						'<div class="error-main"><h1>视图加载失败</h1><p><a href="' +
						esc(src) +
						'">改为整页打开</a></p></div>';
					swapTo(view);
				});
			if (pushUrl && url) history.pushState({ view: view }, "", url);
			return;
		}
		swapTo(view);
		if (pushUrl && url) history.pushState({ view: view }, "", url);
	}

	var tabLinks = document.querySelectorAll(".view-tabs a[data-view]");
	for (var t = 0; t < tabLinks.length; t++) {
		(function (link) {
			link.addEventListener("click", function (ev) {
				if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
				ev.preventDefault();
				activate(link.getAttribute("data-view"), true, link.getAttribute("href"));
			});
		})(tabLinks[t]);
	}
	window.addEventListener("popstate", function () {
		var view = "chat";
		try {
			view = new URLSearchParams(window.location.search).get("view") === "trace" ? "trace" : "chat";
		} catch (e) {}
		activate(view, false);
	});
})();
