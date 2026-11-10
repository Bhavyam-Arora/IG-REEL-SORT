// content.js — ISOLATED world, runs at document_start.
// Injects the page-world scripts, receives results, renders the sorted grid.

(function () {
  // ---------------------------------------------------------------
  // 1. Inject page-world scripts, with the rules
  // ---------------------------------------------------------------
  // The rules (lib/rules.js) say which responses to read and what each value
  // is called. The worker mirrors them into storage; this script can't read
  // that file itself, and the page can't load it without the manifest listing
  // it. So they ride along as JSON on extract.js's own <script> element, which
  // extract.js reads as it runs, before the interceptor exists to see a
  // response. Without them it falls back to its small built-in copy.
  function injectPageScript(path, rules) {
    var el = document.createElement("script");
    el.src = chrome.runtime.getURL(path);
    if (rules) {
      try {
        el.setAttribute("data-sortcut-rules", JSON.stringify(rules));
      } catch (e) {}
    }
    // Dynamically created scripts default to async, which would let them run
    // out of order. The interceptor depends on extract.js already existing,
    // so order must be preserved.
    el.async = false;
    el.onload = function () {
      this.remove();
    };
    (document.head || document.documentElement).appendChild(el);
  }

  var injected = false;
  function injectAll(rules) {
    if (injected) return;
    injected = true;
    injectPageScript("lib/extract.js", rules);
    injectPageScript("page/interceptor.js");
    injectPageScript("page/collector.js");
  }

  // ---------------------------------------------------------------
  // 2. Developer capture, and the storage read that injects the scripts
  // ---------------------------------------------------------------
  // Off unless chrome.storage.local.devCapture is true, set by hand from the
  // service worker console (see README). The page-world interceptor can't read
  // storage, so it's told. Captured bodies stay in the tab and are only ever
  // saved to a local file on request.
  var devCapture = false;
  // Forced failure, for testing the error report: off unless
  // chrome.storage.local.devForceFailure is set by hand (see README) to one of
  // REPORT_REASONS. The next sort's result then ends with that code, after its
  // normal collection, and the key is removed: one use.
  var forcedFailure = null;

  function tellPageDevCapture() {
    window.postMessage({ source: "ig-sorter-debug", type: "devCapture", on: devCapture }, "*");
  }

  // One storage read for both, then the page scripts go in. It takes
  // milliseconds; Instagram's first request waits on megabytes of its own JS.
  // No rules stored (the worker hasn't run since an install, update or reload):
  // ask the worker, which writes them and sends them back. A worker that is
  // slow to wake doesn't hold the page up past RULES_WAIT_MS; extract.js then
  // uses its built-in copy and the sort says so.
  var RULES_WAIT_MS = 1000;

  function isRules(r) {
    return !!r && typeof r === "object" && typeof r.version === "number";
  }

  function askForRules() {
    setTimeout(function () {
      injectAll(null);
    }, RULES_WAIT_MS);
    try {
      chrome.runtime.sendMessage({ type: "getRules" }, function (res) {
        var err = chrome.runtime.lastError; // read, so Chrome doesn't log it
        injectAll(!err && res && isRules(res.rules) ? res.rules : null);
      });
    } catch (e) {
      injectAll(null);
    }
  }

  try {
    chrome.storage.local.get({ devCapture: false, rules: null, devForceFailure: null }, function (o) {
      o = o || {};
      if (isRules(o.rules)) injectAll(o.rules);
      else askForRules();
      devCapture = o.devCapture === true;
      forcedFailure = o.devForceFailure;
      tellPageDevCapture();
    });
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== "local" || !changes.devCapture) return;
      devCapture = changes.devCapture.newValue === true;
      tellPageDevCapture();
    });
  } catch (e) {
    // No storage (the extension was reloaded under this tab): inject anyway.
    injectAll(null);
  }

  // ---------------------------------------------------------------
  // 3. Helpers
  // ---------------------------------------------------------------
  var LAST = [];
  var observer = null;
  var pendingDebugReply = null; // developer capture, see section 2
  var WRAP_ID = "ig-sorter-wrap";

  function fmt(n) {
    if (n === null || n === undefined) return "\u2014";
    if (n >= 1000000) return (n / 1000000).toFixed(n >= 10000000 ? 0 : 1) + "M";
    if (n >= 1000) return (n / 1000).toFixed(n >= 100000 ? 0 : 1) + "K";
    return String(n);
  }

  // The latest transcription outcome, for the popup. Kept in storage rather
  // than messaged: clicking a tile on the page closes the popup, so it is
  // almost never open to hear a message when the result comes back.
  function saveTranscribeStatus(ok, code, text) {
    try {
      chrome.storage.local.set({
        transcribeStatus: { ok: ok, code: code, text: text, at: Date.now() }
      });
    } catch (e) {}
  }

  // Find the element holding the most post links. Deliberately structural —
  // never match on Instagram's CSS class names, which are randomised.
  function findGridContainer() {
    var links = Array.prototype.slice.call(
      document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')
    );
    if (!links.length) return null;

    var counts = new Map();
    links.forEach(function (a) {
      var el = a;
      for (var i = 0; i < 6 && el; i++) {
        el = el.parentElement;
        if (!el) break;
        counts.set(el, (counts.get(el) || 0) + 1);
      }
    });

    var best = null;
    var bestN = 0;
    counts.forEach(function (n, el) {
      if (n > bestN) {
        bestN = n;
        best = el;
      }
    });
    return bestN >= 3 ? best : null;
  }

  // ---------------------------------------------------------------
  // 4. Render
  // ---------------------------------------------------------------
  var OUTLIER_FIELD = {
    outlier: "views",
    outlierLikes: "likes",
    outlierComments: "comments"
  };

  var METRIC_SORTS = {
    views: 1,
    likes: 1,
    comments: 1,
    outlier: 1,
    outlierLikes: 1,
    outlierComments: 1
  };

  // 333.33 reads as 333x; 2.47 reads as 2.5x. Decimals only matter near the
  // baseline, where the difference between 1.2x and 1.8x is the whole story.
  function fmtScore(x) {
    return (x >= 10 ? Math.round(x) : x.toFixed(1)) + "x";
  }

  // Everything on the page is ours only by prefix: the igs- classes, under
  // elements marked data-sortcut, which is where the shared tokens
  // (lib/tokens.css, injected by the manifest) apply. Every rule sets what it
  // relies on, so Instagram's element styles can't reach in, and nothing here
  // matches an element of Instagram's except the one attribute that dims its
  // grid during a sort. (Not a shadow root: the tests and the popup reach
  // these elements through the page's own DOM.)
  var STYLE_ID = "ig-sorter-style";
  var CSS = [
    "[data-sortcut],[data-sortcut] *{box-sizing:border-box;}",
    "[data-sortcut]{font-family:var(--font);-webkit-font-smoothing:antialiased;}",
    "[data-sortcut] button{font-family:var(--font);text-transform:none;letter-spacing:normal;}",
    ".igs-logo{display:block;flex:none;width:24px;height:24px;margin:0;border:0;}",

    // ---- While a sort runs: Instagram's grid softly dimmed, and the pill ----
    "[data-ig-sorter-dim]{opacity:.38 !important;filter:blur(2px) saturate(.7) !important;",
    "transition:opacity .3s ease,filter .3s ease;}",
    ".igs-pill{position:fixed;top:18px;left:50%;z-index:2147483646;transform:translateX(-50%);",
    "display:flex;align-items:center;gap:12px;width:max-content;max-width:calc(100vw - 32px);",
    "margin:0;padding:10px 18px 10px 12px;border:1px solid var(--line);border-radius:var(--r-pill);",
    "background:var(--bg);color:var(--ink);box-shadow:var(--shadow-float);",
    "font:500 13px/1.3 var(--font);animation:igs-in .25s ease both;}",
    ".igs-pill .igs-logo{width:28px;height:28px;}",
    ".igs-pill-body{display:flex;flex-direction:column;gap:7px;min-width:220px;}",
    ".igs-pill-text{margin:0;color:var(--gray);white-space:nowrap;}",
    ".igs-pill-text b{color:var(--ink);font-weight:650;}",
    ".igs-bar{position:relative;height:4px;overflow:hidden;border-radius:var(--r-pill);background:var(--line);}",
    ".igs-bar i{position:absolute;top:0;bottom:0;left:0;display:block;width:0;",
    "border-radius:inherit;background:var(--ig-btn);transition:width .4s ease;}",
    // "All reels" has no target: a band that keeps moving instead.
    ".igs-bar.is-open i{width:35%;animation:igs-slide 1.3s ease-in-out infinite;}",
    "@keyframes igs-slide{from{left:-35%;}to{left:100%;}}",
    "@keyframes igs-in{from{opacity:0;transform:translate(-50%,-6px);}to{opacity:1;transform:translate(-50%,0);}}",

    // ---- The sorted view: a header card above the grid ----
    ".igs-wrap{display:block;width:100%;margin:0 0 28px;padding:0;color:var(--ink);text-align:left;}",
    ".igs-head{display:flex;align-items:center;gap:14px;margin:0 0 14px;padding:14px 14px 14px 16px;",
    "border:1px solid var(--line);border-radius:var(--r-card);background:var(--bg);box-shadow:var(--shadow-card);}",
    ".igs-head .igs-logo{width:36px;height:36px;}",
    ".igs-head-text{flex:1;min-width:0;}",
    ".igs-title{margin:0;padding:0;border:0;color:var(--ink);font:700 16px/1.25 var(--font);letter-spacing:-.02em;}",
    ".igs-sub{margin:2px 0 0;padding:0;color:var(--gray);font:400 13px/1.4 var(--font);}",
    ".igs-note{margin:4px 0 0;padding:0;color:var(--ink-2);font:500 12px/1.4 var(--font);}",
    ".igs-note.is-bad{color:var(--bad);}",
    ".igs-actions{display:flex;align-items:center;gap:8px;flex:none;}",
    ".igs-primary,.igs-ghost{display:inline-flex;align-items:center;gap:6px;height:36px;margin:0;",
    "padding:0 16px;border:0;border-radius:var(--r-pill);cursor:pointer;white-space:nowrap;",
    "font:600 13px/1 var(--font);transition:filter .12s ease,background .12s ease;}",
    ".igs-primary{background:var(--ig-btn);color:#fff;box-shadow:var(--shadow-btn);}",
    ".igs-primary:hover{filter:brightness(1.06);}",
    ".igs-ghost{background:var(--bg-2);color:var(--ink);}",
    ".igs-ghost:hover{background:var(--line);}",
    ".igs-primary svg,.igs-ghost svg{display:block;flex:none;}",
    ".igs-menu-wrap{position:relative;}",
    ".igs-menu{position:absolute;top:calc(100% + 6px);right:0;z-index:10;min-width:190px;margin:0;padding:6px;",
    "border:1px solid var(--line);border-radius:14px;background:var(--bg);box-shadow:var(--shadow-float);}",
    ".igs-menu[hidden]{display:none;}",
    ".igs-menu-item{display:flex;align-items:center;gap:10px;width:100%;height:36px;margin:0;padding:0 10px;",
    "border:0;border-radius:var(--r-input);background:transparent;color:var(--ink);cursor:pointer;",
    "text-align:left;font:500 13px/1 var(--font);}",
    ".igs-menu-item:hover,.igs-menu-item:focus-visible{background:var(--bg-2);outline:none;}",
    ".igs-menu-item svg{color:var(--gray);}",

    // ---- Tiles ----
    ".igs-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;width:100%;margin:0;padding:0;}",
    // The tile's cell.
    ".igs-cell{position:relative;min-width:0;border-radius:12px;}",
    // #1: a thin ring in the Instagram gradient.
    ".igs-top::before{content:\"\";position:absolute;inset:-3px;border-radius:15px;background:var(--ig);}",
    // content-visibility lets the browser skip layout and paint for tiles that
    // are scrolled out of view. An all-posts run puts hundreds of tiles in the
    // DOM at once, and without this every one of them is painted on every
    // frame. The intrinsic size keeps the scrollbar from jumping as skipped
    // tiles are realised.
    ".igs-tile{position:relative;display:block;aspect-ratio:3/4;overflow:hidden;margin:0;padding:0;",
    "border-radius:12px;background:var(--bg-2);text-decoration:none;color:#fff;",
    "content-visibility:auto;contain-intrinsic-size:auto 300px;}",
    ".igs-top .igs-tile{z-index:1;}",
    ".igs-tile img{display:block;width:100%;height:100%;max-width:none;margin:0;object-fit:cover;",
    "transition:transform .25s ease;}",
    ".igs-tile:hover img{transform:scale(1.03);}",
    ".igs-badge{position:absolute;top:8px;z-index:2;display:flex;align-items:center;height:22px;",
    "margin:0;padding:0 8px;border-radius:var(--r-pill);color:#fff;",
    "font:700 11.5px/1 var(--font);font-variant-numeric:tabular-nums;}",
    ".igs-rank{left:8px;min-width:22px;justify-content:center;background:var(--scrim);}",
    ".igs-rank.is-filler{color:rgba(255,255,255,.6);}",
    ".igs-score{right:8px;background:var(--ig-btn);box-shadow:0 2px 8px rgba(0,0,0,.25);}",
    ".igs-meta{position:absolute;left:0;right:0;bottom:0;z-index:1;display:flex;flex-wrap:wrap;",
    "align-items:center;gap:4px 10px;margin:0;padding:28px 10px 9px;",
    "background:linear-gradient(transparent,rgba(12,11,16,.82));color:#fff;",
    "font:600 12px/1 var(--font);font-variant-numeric:tabular-nums;}",
    ".igs-meta.has-tx{padding-right:46px;}",
    ".igs-stat{display:inline-flex;align-items:center;gap:4px;opacity:.78;}",
    ".igs-stat.is-main{opacity:1;font-size:13px;font-weight:700;}",
    ".igs-stat svg{display:block;flex:none;}",

    // Transcribe: shown on hover (and keyboard focus), so 100 tiles don't
    // read as 100 buttons. No backdrop blur anywhere on a tile: it forces a
    // compositing layer per tile, hundreds of them during an all-posts run.
    ".igs-tx{position:absolute;bottom:8px;right:8px;z-index:3;width:30px;height:30px;padding:0;margin:0;",
    "border:0;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;",
    "background:rgba(255,255,255,.94);color:#0C0B10;opacity:0;transform:scale(.9);",
    "box-shadow:0 2px 8px rgba(0,0,0,.25);",
    "transition:opacity .15s ease,transform .12s ease,background .15s ease,color .15s ease;}",
    ".igs-tile:hover .igs-tx,.igs-tx:focus-visible{opacity:1;transform:none;}",
    ".igs-tx:not(.is-busy):not(.is-done):not(.is-error):hover{background:var(--ig-btn);color:#fff;transform:scale(1.08);}",
    ".igs-tx:focus-visible{outline:3px solid var(--focus);outline-offset:2px;}",
    ".igs-tx.is-busy{opacity:1;transform:none;cursor:progress;}",
    ".igs-tx.is-done{opacity:1;transform:none;background:var(--ig-btn);color:#fff;}",
    ".igs-tx.is-error{opacity:1;transform:none;background:#C42B4B;color:#fff;}",
    ".igs-tx.is-busy svg{animation:igs-spin .8s linear infinite;}",
    "@keyframes igs-spin{to{transform:rotate(360deg);}}",

    // Shared close button: the dialogs and the result cards.
    ".igs-x{position:absolute;top:12px;right:12px;width:30px;height:30px;",
    "margin:0;padding:0;border:0;border-radius:50%;background:transparent;",
    "color:var(--gray);display:flex;align-items:center;justify-content:center;",
    "font:400 20px/1 var(--font);cursor:pointer;}",
    ".igs-x:hover{background:var(--bg-2);color:var(--ink);}",
    "[data-sortcut] :focus-visible{outline:3px solid var(--focus);outline-offset:2px;}",

    // Sign-in and Upgrade dialogs.
    ".igs-modal{position:fixed;inset:0;z-index:2147483647;",
    "display:flex;align-items:center;justify-content:center;padding:16px;",
    "background:rgba(12,11,16,.45);animation:igs-fade .2s ease both;}",
    ".igs-dialog{position:relative;width:100%;max-width:360px;",
    "margin:0;padding:22px 22px 20px;border:1px solid var(--line);border-radius:var(--r-card);",
    "background:var(--bg);color:var(--ink);box-shadow:var(--shadow-float);",
    "font:400 14px/1.45 var(--font);text-align:left;}",
    ".igs-dialog-head{display:flex;align-items:center;gap:10px;margin:0 34px 10px 0;}",
    ".igs-dialog-head .igs-logo{width:30px;height:30px;}",
    ".igs-dialog h2{margin:0;padding:0;border:0;color:var(--ink);",
    "font:700 17px/1.25 var(--font);letter-spacing:-.02em;}",
    ".igs-dialog p{margin:0 0 16px;padding:0;color:var(--ink-2);font:400 14px/1.45 var(--font);}",
    ".igs-dialog p.igs-dialog-err{margin:-6px 0 14px;padding:9px 12px;border:1px solid var(--bad-line);",
    "border-radius:var(--r-input);background:var(--bad-bg);color:var(--bad);font:500 12.5px/1.45 var(--font);}",
    ".igs-dialog p.igs-dialog-err[hidden]{display:none;}",
    ".igs-btn{display:block;width:100%;height:44px;margin:0;padding:0 16px;",
    "border:0;border-radius:var(--r-pill);background:var(--ig-btn);color:#fff;cursor:pointer;",
    "box-shadow:var(--shadow-btn);font:650 14px/1 var(--font);letter-spacing:-.01em;}",
    ".igs-btn:hover{filter:brightness(1.06);}",
    ".igs-btn:disabled{opacity:.6;cursor:progress;filter:none;}",
    "@keyframes igs-fade{from{opacity:0;}to{opacity:1;}}",

    // While a reel transcribes: the sort's pill, with its step.
    ".igs-tx-pill .igs-pill-body{min-width:180px;}",

    // The transcript, once it's ready, and a transcription's failure.
    // Never taller than the window: the text scrolls inside its box instead.
    ".igs-dialog.igs-result{display:flex;flex-direction:column;max-width:560px;",
    "max-height:calc(100vh - 32px);overflow:hidden;}",
    ".igs-dialog.igs-result.is-wide{max-width:960px;}",
    ".igs-result>*{flex:none;}",
    ".igs-dialog.igs-result .igs-dialog-head{margin-bottom:2px;}",
    ".igs-dialog p.igs-result-sub{margin:0 34px 14px 40px;color:var(--gray);font:500 12.5px/1.4 var(--font);}",
    ".igs-dialog p.igs-result-msg{margin:0;color:var(--ink-2);}",
    // The transcript, and the original script beside it when it's shown.
    ".igs-result>.igs-tx-panes{flex:1 1 auto;}",
    ".igs-tx-panes{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;min-height:0;}",
    ".igs-tx-panes.is-split{grid-template-columns:repeat(2,minmax(0,1fr));}",
    ".igs-tx-pane{display:flex;flex-direction:column;gap:6px;min-width:0;min-height:0;}",
    ".igs-tx-pane[hidden]{display:none;}",
    ".igs-pane-label{margin:0;color:var(--gray);font:600 11.5px/1.3 var(--font);}",
    ".igs-tx-panes:not(.is-split) .igs-pane-label{display:none;}",
    ".igs-tx-text{flex:1 1 auto;min-height:0;max-height:min(52vh,420px);overflow:auto;",
    "overscroll-behavior:contain;margin:0;padding:12px 14px;",
    "border:1px solid var(--line);border-radius:var(--r-input);background:var(--bg-2);color:var(--ink);",
    "font:400 14px/1.55 var(--font);white-space:pre-wrap;overflow-wrap:anywhere;user-select:text;}",
    // Too narrow for two columns: one above the other, each still scrolling.
    "@media (max-width:640px){.igs-tx-panes.is-split{grid-template-columns:minmax(0,1fr);}",
    ".igs-tx-text{max-height:32vh;}}",
    ".igs-link{display:inline-block;margin:8px 0 0;padding:2px 0;border:0;background:none;color:var(--gray);",
    "cursor:pointer;font:500 12.5px/1.3 var(--font);text-decoration:underline;",
    "text-decoration-color:var(--line-2);text-underline-offset:3px;}",
    ".igs-link:hover{color:var(--ink);text-decoration-color:currentColor;}",
    ".igs-result-actions{display:flex;justify-content:flex-end;gap:8px;margin:16px 0 0;}",
    ".igs-dialog.is-bad{border-color:var(--bad-line);background:var(--bad-bg);}",
    ".igs-dialog.is-bad h2{color:var(--bad);}",
    ".igs-dialog.is-bad .igs-x:hover{background:var(--bg);}",

    "@media (prefers-reduced-motion:reduce){",
    ".igs-pill,.igs-modal{animation:none;}.igs-bar.is-open i{animation:none;left:0;width:100%;opacity:.5;}",
    ".igs-tx.is-busy svg{animation:none;}.igs-tx,.igs-tile img,[data-ig-sorter-dim]{transition:none;}",
    ".igs-tile:hover img{transform:none;}}"
  ].join("");

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  // ---- Theme ----
  // Instagram's own light or dark theme, read off the page's background, so
  // our cards sit in it rather than on it. Anything unreadable counts as light.
  function parseRgb(css) {
    var m = String(css || "").match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+)(%?))?\s*\)/);
    if (!m) return null;
    var a = m[4] === undefined ? 1 : parseFloat(m[4]) / (m[5] ? 100 : 1);
    return { r: +m[1], g: +m[2], b: +m[3], a: a };
  }

  function pageTheme() {
    try {
      var nodes = [document.body, document.documentElement];
      for (var i = 0; i < nodes.length; i++) {
        if (!nodes[i]) continue;
        var c = parseRgb(getComputedStyle(nodes[i]).backgroundColor);
        // A transparent body shows the root's background; look there instead.
        if (!c || c.a < 0.5) continue;
        var luma = (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
        return luma < 0.5 ? "dark" : "light";
      }
    } catch (e) {}
    return "light";
  }

  // Marks a root of our UI: the tokens apply under it, in the page's theme.
  function ours(node) {
    node.setAttribute("data-sortcut", "");
    node.setAttribute("data-theme", pageTheme());
    return node;
  }

  function logo() {
    var img = document.createElement("img");
    img.className = "igs-logo";
    img.alt = "";
    try {
      img.src = chrome.runtime.getURL("icons/128.png");
    } catch (e) {}
    return img;
  }

  var SVG_NS = "http://www.w3.org/2000/svg";

  // Built node by node rather than through innerHTML: Instagram enforces
  // Trusted Types on some surfaces, which rejects markup assignment outright.
  var ICONS = {
    // Ragged lines of text — a transcript.
    idle: ["M5 6h14", "M5 10h14", "M5 14h10", "M5 18h7"],
    busy: ["M12 3a9 9 0 1 0 9 9"],
    done: ["M4.5 12.5l5 5 10-11"],
    error: ["M6 6l12 12", "M18 6L6 18"],
    views: ["M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z", "M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6"],
    likes: ["M12 20s-7.5-4.6-7.5-10.1A4.3 4.3 0 0 1 12 7.4a4.3 4.3 0 0 1 7.5 2.5C19.5 15.4 12 20 12 20z"],
    comments: ["M20.5 11.5a8.5 8.5 0 0 1-12.4 7.6L3.5 20.5l1.4-4.4A8.5 8.5 0 1 1 20.5 11.5z"],
    download: ["M12 4v11", "M7.5 10.5L12 15l4.5-4.5", "M5 19.5h14"],
    chevron: ["M6.5 9.5L12 15l5.5-5.5"],
    sheet: ["M5 3.5h14v17H5z", "M5 9h14", "M5 14.5h14", "M10.5 9v11.5"],
    file: ["M6 3.5h8l4 4v13H6z", "M14 3.5v4h4"],
    // Two heads — Similar accounts.
    people: ["M9 11a3.5 3.5 0 1 0 0-7a3.5 3.5 0 1 0 0 7", "M2.5 20a6.5 6.5 0 0 1 13 0",
      "M15.5 4.3a3.5 3.5 0 0 1 0 6.4", "M18 14.3a6.5 6.5 0 0 1 3.5 5.7"],
    search: ["M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14", "M20 20l-4-4"]
  };

  function svgIcon(name, size, width) {
    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", String(width || 2));
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    ICONS[name].forEach(function (d) {
      var path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", d);
      svg.appendChild(path);
    });
    return svg;
  }

  function setIcon(btn, name) {
    while (btn.firstChild) btn.removeChild(btn.firstChild);
    btn.appendChild(svgIcon(name, 15, 2.2));
  }

  var IDLE_LABEL = "Transcribe this reel";

  // Status lines the worker sends while a job waits on the server ("Waiting
  // in queue…"), keyed by reel code so each reaches the tile that asked.
  var TX_PROGRESS = {};

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  }

  function closeButton(label, onClose) {
    var x = el("button", "igs-x", "×");
    x.type = "button";
    x.title = label;
    x.setAttribute("aria-label", label);
    x.addEventListener("click", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      onClose();
    });
    return x;
  }

  // ---- Dialogs ----
  // A Transcribe click that can't go ahead lands in one of these instead: the
  // sign-in dialog when signed out (Google only opens from its button), the
  // Upgrade dialog on Free. One dialog at a time; opening another abandons the
  // first.
  var PRICING_URL = "https://sortcut.co/pricing.html";
  var dialog = null; // { close }

  function closeDialog() {
    if (dialog) dialog.close();
  }

  // o: { title, text, action, onAction(ui) }. onAction gets
  // { go, err, close, isOpen } and decides what the main button does.
  function showDialog(returnFocus, o) {
    closeDialog();
    ensureStyles();

    var open = true;
    var backdrop = ours(el("div", "igs-modal"));
    var box = el("div", "igs-dialog");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-labelledby", "igs-dialog-title");
    box.setAttribute("aria-describedby", "igs-dialog-text");

    var head = el("div", "igs-dialog-head");
    head.appendChild(logo());
    var title = el("h2", "", o.title);
    title.id = "igs-dialog-title";
    head.appendChild(title);
    box.appendChild(head);

    var text = el("p", "", o.text);
    text.id = "igs-dialog-text";
    box.appendChild(text);

    var err = el("p", "igs-dialog-err");
    err.setAttribute("role", "status");
    err.hidden = true;
    box.appendChild(err);

    var go = el("button", "igs-btn", o.action);
    go.type = "button";
    box.appendChild(go);

    var x = closeButton("Close", close);
    box.appendChild(x);
    backdrop.appendChild(box);

    function close() {
      if (!open) return;
      open = false;
      dialog = null;
      document.removeEventListener("keydown", onKey, true);
      backdrop.remove();
      if (returnFocus && returnFocus.isConnected) returnFocus.focus();
      // A transcript that finished while this was up.
      showNextResult();
    }

    // Escape closes; Tab stays between the dialog's two buttons. Nothing else
    // is intercepted, so Instagram's own keys keep working underneath.
    function onKey(ev) {
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        close();
      } else if (ev.key === "Tab") {
        var first = go.disabled ? x : go;
        var last = x;
        var active = document.activeElement;
        if (ev.shiftKey ? active === first || !box.contains(active) : active === last) {
          ev.preventDefault();
          (ev.shiftKey ? last : first).focus();
        }
      }
    }

    var ui = { go: go, err: err, close: close, isOpen: function () { return open; } };
    go.addEventListener("click", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      if (go.disabled) return;
      o.onAction(ui);
    });

    backdrop.addEventListener("click", function (ev) {
      ev.stopPropagation();
    });
    document.addEventListener("keydown", onKey, true);
    (document.body || document.documentElement).appendChild(backdrop);
    dialog = { close: close };
    go.focus();
  }

  function showSignInDialog(returnFocus, onSignedIn) {
    showDialog(returnFocus, {
      title: "Sign in to transcribe",
      text: "You need to be signed in first.",
      action: "Sign in with Google",
      onAction: function (ui) {
        ui.go.disabled = true;
        ui.go.textContent = "Signing in…";
        ui.err.hidden = true;
        chrome.runtime.sendMessage({ type: "pageSignIn" }, function (res) {
          var failed = chrome.runtime.lastError || !res || !res.ok;
          // Closed while Google's window was up: the sign-in itself stands, but
          // the transcription it was opened for is dropped with the dialog.
          if (!ui.isOpen()) return;
          if (failed) {
            ui.go.disabled = false;
            ui.go.textContent = "Sign in with Google";
            // Closing Google's window comes back as "Sign-in was cancelled."
            ui.err.textContent = (res && res.error) || "Extension worker unavailable — reload the extension.";
            ui.err.hidden = false;
            return;
          }
          ui.close();
          // Tries the reel again, which on a Free account opens the Upgrade
          // dialog instead of transcribing.
          onSignedIn();
        });
      }
    });
  }

  // o, optional: { title, text } for a feature other than transcription.
  function showProDialog(returnFocus, o) {
    o = o || {};
    showDialog(returnFocus, {
      title: o.title || "Upgrade to transcribe",
      text: o.text || "Transcription is part of Sortcut Pro.",
      action: "Upgrade to Pro",
      onAction: function (ui) {
        window.open(PRICING_URL, "_blank", "noopener");
        ui.close();
      }
    });
  }

  // ---- Transcription, on the page ----
  // While a reel transcribes, the sorted grid dims behind the same pill a sort
  // shows, with the step the worker is on, until the job ends. When it's done,
  // the transcript (or why it failed) opens in a card: one card at a time, the
  // others waiting their turn. Nothing downloads unless Download .txt is
  // clicked.
  var TX_PILL_ID = "ig-sorter-tx-progress";
  var txJobs = []; // { code, label }, oldest first, while they run
  var txPillAway = false; // the sorted grid went, for the jobs running now

  function sortedGrid() {
    var wrap = document.getElementById(WRAP_ID);
    return wrap && wrap.querySelector(".igs-grid");
  }

  function showTxProgress() {
    var pill = document.getElementById(TX_PILL_ID);
    var grid = sortedGrid();
    if (!txJobs.length || txPillAway || !document.body) {
      if (pill) pill.remove();
      if (grid) grid.removeAttribute(DIM_ATTR);
      return;
    }
    ensureStyles();
    if (!pill) {
      pill = ours(el("div", "igs-pill igs-tx-pill"));
      pill.id = TX_PILL_ID;
      pill.setAttribute("role", "status");
      pill.appendChild(logo());
      var body = el("div", "igs-pill-body");
      var line = el("p", "igs-pill-text");
      line.appendChild(el("b", "igs-tx-step"));
      line.appendChild(el("span", "igs-pill-count"));
      body.appendChild(line);
      // No step has a size to measure, so the band just keeps moving.
      var bar = el("div", "igs-bar is-open");
      bar.appendChild(el("i"));
      body.appendChild(bar);
      pill.appendChild(body);
      document.body.appendChild(pill);
    }
    // The newest job's step; the others only as a count.
    pill.querySelector(".igs-tx-step").textContent = txJobs[txJobs.length - 1].label;
    pill.querySelector(".igs-pill-count").textContent =
      txJobs.length > 1 ? " · " + txJobs.length + " reels" : "";
    if (grid) grid.setAttribute(DIM_ATTR, "1");
  }

  function hideTxProgress() {
    txPillAway = true;
    showTxProgress();
  }

  function txJob(code) {
    for (var i = 0; i < txJobs.length; i++) if (txJobs[i].code === code) return txJobs[i];
    return null;
  }

  function txStarted(code, label) {
    txJobs.push({ code: code, label: label });
    // A new transcription brings the pill back.
    txPillAway = false;
    showTxProgress();
  }

  function txStep(code, label) {
    var job = txJob(code);
    if (job) job.label = label;
    showTxProgress();
  }

  function txEnded(code) {
    txJobs = txJobs.filter(function (j) { return j.code !== code; });
    showTxProgress();
  }

  // ---- Result cards ----
  var results = []; // waiting to open: functions that open one
  var resultOpen = false;

  function queueResult(open) {
    results.push(open);
    showNextResult();
  }

  // One at a time, and not over a sign-in or Upgrade dialog.
  function showNextResult() {
    if (resultOpen || dialog || !results.length) return;
    results.shift()();
  }

  // A centred card in the dialogs' style. o: { title, sub, bad, returnFocus,
  // fill(box) }; fill adds the card's own content under the title.
  function openResultCard(o) {
    ensureStyles();
    resultOpen = true;
    var open = true;
    var backdrop = ours(el("div", "igs-modal igs-result-modal"));
    var box = el("div", "igs-dialog igs-result" + (o.bad ? " is-bad" : ""));
    box.setAttribute("role", o.bad ? "alertdialog" : "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-labelledby", "igs-result-title");

    var head = el("div", "igs-dialog-head");
    head.appendChild(logo());
    var title = el("h2", "", o.title);
    title.id = "igs-result-title";
    head.appendChild(title);
    box.appendChild(head);
    if (o.sub) box.appendChild(el("p", "igs-result-sub", o.sub));

    o.fill(box);

    var x = closeButton("Close", close);
    box.appendChild(x);
    backdrop.appendChild(box);

    function close() {
      if (!open) return;
      open = false;
      resultOpen = false;
      document.removeEventListener("keydown", onKey, true);
      backdrop.remove();
      if (o.returnFocus && o.returnFocus.isConnected) o.returnFocus.focus();
      showNextResult();
    }

    // Escape closes; Tab stays inside the card.
    function onKey(ev) {
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        close();
      } else if (ev.key === "Tab") {
        var stops = Array.prototype.slice.call(box.querySelectorAll("button")).filter(function (b) {
          return !b.disabled && !b.hidden;
        });
        var first = stops[0];
        var last = stops[stops.length - 1];
        var active = document.activeElement;
        if (ev.shiftKey ? active === first || !box.contains(active) : active === last) {
          ev.preventDefault();
          (ev.shiftKey ? last : first).focus();
        }
      }
    }

    // Clicks stay in the card: none of them should reach Instagram.
    backdrop.addEventListener("click", function (ev) {
      ev.stopPropagation();
    });
    document.addEventListener("keydown", onKey, true);
    (document.body || document.documentElement).appendChild(backdrop);
    var firstButton = box.querySelector("button");
    (o.bad ? x : firstButton || x).focus();
    return { close: close };
  }

  // "Hindi → Hinglish": the language heard and, when the text was romanised,
  // what it was written in. The worker's language is a name or a code.
  function languageName(lang) {
    var s = String(lang || "").trim();
    if (!s || s === "unknown") return "Unknown language";
    if (/^[a-z]{2,3}$/i.test(s)) {
      try {
        var n = new Intl.DisplayNames(["en"], { type: "language" }).of(s.toLowerCase());
        if (n && n.toLowerCase() !== s.toLowerCase()) return n;
      } catch (e) {}
    }
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // What the transcript is written in: Hinglish for romanised Hindi.
  function scriptName(r) {
    var name = languageName(r.language);
    if (!r.romanised) return name;
    return name === "Hindi" ? "Hinglish" : "Latin script";
  }

  function languageLabel(r) {
    var name = languageName(r.language);
    return r.romanised ? name + " → " + scriptName(r) : name;
  }

  // The clipboard, or failing that the old select-and-copy. done(ok).
  function copyText(text, holder, done) {
    function fallback() {
      var ok = false;
      try {
        var ta = el("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;";
        holder.appendChild(ta);
        ta.select();
        ok = document.execCommand("copy");
        ta.remove();
      } catch (e) {}
      done(!!ok);
    }
    try {
      navigator.clipboard.writeText(text).then(function () { done(true); }, fallback);
    } catch (e) {
      fallback();
    }
  }

  var COPY_LABEL = "Copy text";

  function showTranscriptCard(p, r, returnFocus) {
    openResultCard({
      title: "Transcript",
      sub: (p.code || "reel") + " · " + languageLabel(r),
      returnFocus: returnFocus,
      fill: function (box) {
        // Each text in its own scrolling box; the original, when shown, sits
        // beside the transcript and the card widens to hold both.
        var panes = el("div", "igs-tx-panes");
        function pane(label, text) {
          var wrap = el("div", "igs-tx-pane");
          wrap.appendChild(el("p", "igs-pane-label", label));
          var t = el("div", "igs-tx-text", text);
          t.setAttribute("tabindex", "0");
          wrap.appendChild(t);
          panes.appendChild(wrap);
          return wrap;
        }
        pane(scriptName(r), r.text);
        box.appendChild(panes);

        if (r.original) {
          var orig = pane("Original script", r.original);
          orig.hidden = true;
          var toggle = el("button", "igs-link", "Show original script");
          toggle.type = "button";
          toggle.setAttribute("aria-expanded", "false");
          toggle.addEventListener("click", function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            orig.hidden = !orig.hidden;
            panes.classList.toggle("is-split", !orig.hidden);
            box.classList.toggle("is-wide", !orig.hidden);
            toggle.textContent = orig.hidden ? "Show original script" : "Hide original script";
            toggle.setAttribute("aria-expanded", String(!orig.hidden));
          });
          box.appendChild(toggle);
        }

        var actions = el("div", "igs-result-actions");
        var copy = el("button", "igs-primary", COPY_LABEL);
        copy.type = "button";
        var timer = null;
        copy.addEventListener("click", function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          copyText(r.text, box, function (ok) {
            copy.textContent = ok ? "Copied ✓" : "Couldn't copy";
            clearTimeout(timer);
            timer = setTimeout(function () {
              copy.textContent = COPY_LABEL;
            }, 2000);
          });
        });
        var save = el("button", "igs-ghost");
        save.type = "button";
        save.appendChild(svgIcon("download", 15, 2));
        save.appendChild(el("span", "", "Download .txt"));
        save.addEventListener("click", function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          downloadTranscript(p, r);
        });
        actions.appendChild(copy);
        actions.appendChild(save);
        box.appendChild(actions);
      }
    });
  }

  function showFailureResult(p, text, returnFocus) {
    openResultCard({
      title: "Couldn't transcribe",
      sub: p.code || "",
      bad: true,
      returnFocus: returnFocus,
      fill: function (box) {
        box.appendChild(el("p", "igs-result-msg", text));
      }
    });
  }

  // A tile is an <a> to the post, so anything placed inside it has to stop its
  // own clicks from navigating away mid-transcription.
  function buildTranscribeButton(p) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "igs-tx";
    btn.title = IDLE_LABEL;
    btn.setAttribute("aria-label", IDLE_LABEL);
    setIcon(btn, "idle");

    function state(name, label) {
      btn.classList.remove("is-busy", "is-done", "is-error");
      if (name !== "idle") btn.classList.add("is-" + name);
      setIcon(btn, name);
      btn.title = label;
      btn.setAttribute("aria-label", label);
    }

    btn.addEventListener("click", function (ev) {
      // Without both of these the tile's <a> navigates to the post and the
      // in-flight transcription dies with the page.
      ev.preventDefault();
      ev.stopPropagation();
      if (btn.disabled) return;
      start();
    });

    function start() {
      btn.disabled = true;
      state("busy", "Transcribing…");
      txStarted(p.code, "Transcribing…");
      // Label only: re-running state() would restart the spinner each time.
      TX_PROGRESS[p.code] = function (label) {
        btn.title = label;
        btn.setAttribute("aria-label", label);
        txStep(p.code, label);
      };

      var settle = function (name, label) {
        delete TX_PROGRESS[p.code];
        txEnded(p.code);
        btn.disabled = false;
        state(name, label);
        // Return to idle so it can be run again — an expired link and a rate
        // limit both clear up.
        setTimeout(function () {
          state("idle", IDLE_LABEL);
        }, 4000);
      };

      // The same words on the tile, on the card and in the popup.
      var fail = function (text) {
        settle("error", text);
        queueResult(function () { showFailureResult(p, text, btn); });
        saveTranscribeStatus(false, p.code, text);
      };

      chrome.runtime.sendMessage({ type: "transcribe", post: p }, function (res) {
        if (chrome.runtime.lastError || !res) {
          fail("Extension worker unavailable — reload the extension.");
          return;
        }
        if (!res.ok && (res.signedOut || res.needsPro)) {
          // Nothing was attempted. A dialog takes over: signed out, a
          // successful sign-in runs this same reel again; on Free, it offers
          // the upgrade.
          delete TX_PROGRESS[p.code];
          txEnded(p.code);
          btn.disabled = false;
          state("idle", IDLE_LABEL);
          if (res.signedOut) showSignInDialog(btn, start);
          else showProDialog(btn);
          return;
        }
        if (!res.ok) {
          fail(res.error || "Transcription failed.");
          return;
        }
        var r = res.result;
        settle("done", "Transcript ready");
        queueResult(function () { showTranscriptCard(p, r, btn); });
        saveTranscribeStatus(true, p.code, "Transcript ready (" + languageLabel(r) + ").");
      });
    }

    return btn;
  }

  function downloadTranscript(p, r) {
    var head = [
      "Instagram transcript",
      "URL:       " + (p.url || ""),
      "Posted:    " + (p.createdAt || "unknown"),
      "Language:  " + r.language + (r.romanised ? " (romanised to Latin script)" : ""),
      "Generated: " + new Date().toISOString(),
      ""
    ];
    var body = [r.text];
    // The native-script original is kept below the Hinglish so nothing Whisper
    // heard is lost to the romanisation pass.
    if (r.original) body.push("", "--- original script ---", "", r.original);

    download(
      profileSlug() + "-" + (p.code || "reel") + ".txt",
      head.concat(body).join("\n") + "\n",
      "text/plain"
    );
  }

  // The header card's title for each sort.
  var SORT_TITLE = {
    views: "Top reels by views",
    likes: "Top reels by likes",
    comments: "Top reels by comments",
    outlier: "Outlier reels by views",
    outlierLikes: "Outlier reels by likes",
    outlierComments: "Outlier reels by comments"
  };

  function reels(n) {
    return n + (n === 1 ? " reel" : " reels");
  }

  // The header's Export menu: the popup's four exports, through the same
  // functions. Google Sheets goes through the worker, as the popup's does.
  var EXPORT_ITEMS = [
    { kind: "csv", label: "CSV", icon: "file" },
    { kind: "json", label: "JSON", icon: "file" },
    { kind: "xlsx", label: "Excel", icon: "sheet" },
    { kind: "sheets", label: "Google Sheets", icon: "sheet" }
  ];
  var closeExportMenu = null; // set while the sorted grid is up

  function sheetsFromPage(note) {
    function say(text, bad) {
      note.textContent = text;
      note.hidden = !text;
      note.classList.toggle("is-bad", !!bad);
    }
    say("Exporting to Google Sheets…");
    try {
      chrome.runtime.sendMessage({ type: "sheetsExport", tabId: TAB_ID }, function (res) {
        if (chrome.runtime.lastError || !res) {
          say("Extension worker unavailable — reload the extension.", true);
          return;
        }
        if (res.ok) say("Opened in Google Sheets.");
        else say(res.error || "Nothing to export on this page. Run a sort first.", true);
      });
    } catch (e) {
      say("Extension worker unavailable — reload the extension.", true);
    }
  }

  function buildExportMenu(note) {
    var box = el("div", "igs-menu-wrap");
    var btn = el("button", "igs-primary");
    btn.type = "button";
    btn.setAttribute("aria-haspopup", "menu");
    btn.setAttribute("aria-expanded", "false");
    btn.appendChild(svgIcon("download", 15, 2));
    btn.appendChild(el("span", "", "Export"));
    btn.appendChild(svgIcon("chevron", 14, 2));

    var menu = el("div", "igs-menu");
    menu.setAttribute("role", "menu");
    menu.hidden = true;
    EXPORT_ITEMS.forEach(function (item) {
      var b = el("button", "igs-menu-item");
      b.type = "button";
      b.setAttribute("role", "menuitem");
      b.appendChild(svgIcon(item.icon, 16, 1.8));
      b.appendChild(el("span", "", item.label));
      b.addEventListener("click", function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        close();
        if (item.kind === "sheets") sheetsFromPage(note);
        else exportData(item.kind);
      });
      menu.appendChild(b);
    });

    function onDoc(ev) {
      if (ev.type === "keydown" ? ev.key === "Escape" : !box.contains(ev.target)) close();
    }
    function close() {
      if (menu.hidden) return;
      menu.hidden = true;
      btn.setAttribute("aria-expanded", "false");
      document.removeEventListener("click", onDoc, true);
      document.removeEventListener("keydown", onDoc, true);
    }
    btn.addEventListener("click", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      if (!menu.hidden) return close();
      menu.hidden = false;
      btn.setAttribute("aria-expanded", "true");
      document.addEventListener("click", onDoc, true);
      document.addEventListener("keydown", onDoc, true);
    });
    closeExportMenu = close;

    box.appendChild(btn);
    box.appendChild(menu);
    return box;
  }

  function stat(name, value, main) {
    var s = el("span", "igs-stat" + (main ? " is-main" : ""));
    s.appendChild(svgIcon(name, main ? 14 : 12, 2.2));
    s.appendChild(el("span", "", fmt(value)));
    return s;
  }

  function buildGrid(posts, sortBy, ranked, median) {
    if (ranked === null || ranked === undefined) ranked = posts.length;
    // Which metric the outlier score is measured on, or null for a plain sort.
    var outlierOn = OUTLIER_FIELD[sortBy] || null;
    // The metric the order is by, shown first and largest on every tile.
    var metric = outlierOn || (METRIC_SORTS[sortBy] ? sortBy : null);
    ensureStyles();

    var wrap = ours(el("div", "igs-wrap"));
    wrap.id = WRAP_ID;

    // ---- Header card ----
    var head = el("div", "igs-head");
    head.appendChild(logo());
    var text = el("div", "igs-head-text");
    text.appendChild(el("h2", "igs-title", SORT_TITLE[sortBy] || "Reels sorted by " + sortBy));

    var rest = posts.length - ranked;
    var sub = reels(posts.length);
    // The median is the whole basis of the score, so state it rather than
    // leaving every badge as an unexplained multiplier.
    if (outlierOn && median) sub += " · median " + fmt(Math.round(median)) + " " + outlierOn;
    // Say plainly that the tail isn't ranked, otherwise the numbered badges
    // imply an ordering the filler reels don't actually have.
    if (metric && rest > 0) sub += " · " + rest + " with no " + metric;
    text.appendChild(el("p", "igs-sub", sub));

    var note = el("p", "igs-note");
    note.setAttribute("role", "status");
    note.hidden = true;
    text.appendChild(note);
    head.appendChild(text);

    // Similar accounts (Pro only, once the worker says so), Restore, then
    // Export at the far right.
    var actions = el("div", "igs-actions");
    var restore = el("button", "igs-ghost", "Restore original");
    restore.type = "button";
    restore.addEventListener("click", function () {
      teardown();
    });
    actions.appendChild(restore);
    addSimilarButton(actions, restore);
    actions.appendChild(buildExportMenu(note));
    head.appendChild(actions);
    wrap.appendChild(head);

    // ---- Tiles ----
    var grid = el("div", "igs-grid");

    posts.forEach(function (p, idx) {
      var isFiller = idx >= ranked;

      var cell = el("div", "igs-cell" + (idx === 0 && !isFiller ? " igs-top" : ""));

      var tile = document.createElement("a");
      tile.href = p.url || "#";
      tile.target = "_blank";
      tile.rel = "noopener noreferrer";
      tile.className = "igs-tile";

      if (p.thumbnail) {
        var img = document.createElement("img");
        img.src = p.thumbnail;
        img.loading = "lazy";
        img.referrerPolicy = "no-referrer";
        img.alt = "";
        tile.appendChild(img);
      }

      // Filler posts get a dash, not a position. Numbering them would claim
      // post #21 beat post #22 on a metric neither of them has.
      tile.appendChild(el("div", "igs-badge igs-rank" + (isFiller ? " is-filler" : ""), isFiller ? "–" : String(idx + 1)));

      // Only above the baseline. A 0.4x badge on a below-median post is noise —
      // and at exactly 1x the score says nothing the median line doesn't.
      if (outlierOn && p.outlierScore > 1) {
        var score = el("div", "igs-badge igs-score", fmtScore(p.outlierScore));
        score.title =
          fmt(p[outlierOn]) + " " + outlierOn +
          " vs median " + fmt(Math.round(median));
        tile.appendChild(score);
      }

      // Every video gets a button. Deliberately NOT gated on p.videoUrl:
      // Instagram's grid queries return thumbnails and counts but no playable
      // rendition, so gating on it hid the button on literally every tile. The
      // URL is resolved at click time instead.
      var canTranscribe = !!p.isVideo;
      if (canTranscribe) tile.appendChild(buildTranscribeButton(p));

      // Keep the stats clear of the transcribe button in the same corner.
      var meta = el("div", "igs-meta" + (canTranscribe ? " has-tx" : ""));
      var shown = ["views", "likes", "comments"].filter(function (k) {
        return k !== "views" || (p.views !== null && p.views !== undefined);
      });
      // The sort's own metric first; views lead otherwise.
      if (metric && shown.indexOf(metric) > 0) {
        shown.splice(shown.indexOf(metric), 1);
        shown.unshift(metric);
      }
      shown.forEach(function (k, i) {
        meta.appendChild(stat(k, p[k], i === 0));
      });
      tile.appendChild(meta);

      cell.appendChild(tile);
      grid.appendChild(cell);
    });

    wrap.appendChild(grid);
    return wrap;
  }

  // ---- Similar accounts (Pro) ----
  // A curated list of creators by niche (decisions.md §14), which the worker
  // fetches and caches. The header's button shows only once the worker says
  // the account is Pro; the server refuses everyone else anyway, and a refusal
  // here closes the panel for the Upgrade dialog.
  //
  // The panel is a drawer in a closed shadow root, so Instagram's styles and
  // scripts can't reach in. The tokens still do: custom properties inherit
  // from its host, which is marked like the rest of our UI. Every field is
  // untrusted display text, set with textContent only, and a link is only
  // ever built from a username of Instagram's own characters.
  var SIMILAR_ID = "ig-sorter-similar";
  var SIMILAR_NICHE_KEY = "similarNiche"; // chrome.storage.local: the niche last chosen
  // chrome.storage.local: { username, sortBy, limit, maxReels, expiresAt }.
  // Sort reels leaves it for the tab it opens, which uses it once.
  var PENDING_SORT_KEY = "pendingSort";
  var PENDING_SORT_MS = 60 * 1000;
  // Sort reels when this page shows no sort of its own: the popup's Pro default.
  var DEFAULT_SORT = { sortBy: "views", limit: 100, maxReels: null };
  var USERNAME_RE = /^[A-Za-z0-9._]{1,30}$/;
  var SIMILAR_FAILED = "Couldn't load similar accounts. Please try again.";
  // White initials read on each of these.
  var AVATAR_COLORS = ["#D62976", "#962FBF", "#4F5BD5", "#E8590C", "#0E9F6E", "#0277BD", "#C42B4B", "#6D28D9"];

  var SIMILAR_CSS = [
    ":host{all:initial;}",
    "*{box-sizing:border-box;}",
    "[hidden]{display:none !important;}",
    ".scrim{position:fixed;inset:0;z-index:2147483645;background:rgba(12,11,16,.28);animation:fade .2s ease both;}",
    ".drawer{position:fixed;top:0;right:0;bottom:0;z-index:2147483645;display:flex;flex-direction:column;",
    "width:420px;max-width:100vw;margin:0;padding:0;border-left:1px solid var(--line);",
    "background:var(--bg);color:var(--ink);box-shadow:var(--shadow-float);",
    "font:400 14px/1.45 var(--font);-webkit-font-smoothing:antialiased;text-align:left;",
    "animation:slide .25s ease both;}",
    "button,input,select{font-family:var(--font);}",
    ":focus-visible{outline:3px solid var(--focus);outline-offset:2px;}",

    // Head
    ".head{position:relative;flex:none;display:flex;align-items:center;gap:12px;padding:14px 58px 12px 18px;}",
    ".igs-logo{display:block;flex:none;width:32px;height:32px;margin:0;border:0;}",
    "h2{margin:0;padding:0;color:var(--ink);font:700 17px/1.25 var(--font);letter-spacing:-.02em;}",
    ".count{margin:2px 0 0;color:var(--gray);font:500 12.5px/1.3 var(--font);}",
    ".igs-x{position:absolute;top:14px;right:16px;width:32px;height:32px;margin:0;padding:0;border:0;",
    "border-radius:50%;background:transparent;color:var(--gray);display:flex;align-items:center;",
    "justify-content:center;font:400 22px/1 var(--font);cursor:pointer;}",
    ".igs-x:hover{background:var(--bg-2);color:var(--ink);}",

    // Niche, filter chips, search: fixed at the top and compact, so the list
    // below keeps the height.
    ".controls{flex:none;display:flex;flex-direction:column;gap:8px;padding:0 18px 12px;border-bottom:1px solid var(--line);}",
    ".field{position:relative;display:block;margin:0;}",
    ".field svg{position:absolute;top:50%;transform:translateY(-50%);color:var(--gray);pointer-events:none;}",
    ".niche svg{right:12px;}",
    ".find svg{left:12px;}",
    "select,input{display:block;width:100%;height:36px;margin:0;border:1px solid var(--line-2);",
    "border-radius:var(--r-input);background:var(--bg);color:var(--ink);outline:none;}",
    "select{appearance:none;-webkit-appearance:none;padding:0 38px 0 12px;cursor:pointer;font:600 13.5px/1 var(--font);}",
    "input{padding:0 12px 0 36px;font:400 13.5px/1 var(--font);}",
    "input::placeholder{color:var(--gray-2);}",
    "select:focus,input:focus{border-color:var(--pink);box-shadow:0 0 0 3px var(--focus);}",
    // Chips wrap, two rows at most until "+N more" is clicked.
    ".chips{display:flex;flex-wrap:wrap;gap:6px;margin:0;padding:0;}",
    ".chip,.chip-toggle{display:inline-flex;align-items:center;gap:5px;height:30px;margin:0;padding:0 12px;",
    "border:1px solid var(--line-2);border-radius:var(--r-pill);background:transparent;color:var(--ink-2);",
    "cursor:pointer;white-space:nowrap;font:600 12.5px/1 var(--font);}",
    ".chip:hover,.chip-toggle:hover{background:var(--bg-2);}",
    ".chip-toggle{border-style:dashed;color:var(--gray);}",
    ".chip i{font-style:normal;font-weight:500;color:var(--gray);}",
    ".chip[aria-pressed=\"true\"]{border-color:var(--ink);background:var(--ink);color:var(--bg);}",
    ".chip[aria-pressed=\"true\"] i{color:inherit;opacity:.7;}",

    // The list
    ".body{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain;padding:14px 18px 24px;}",
    ".list{display:flex;flex-direction:column;gap:10px;margin:0;padding:0;list-style:none;}",
    ".card{display:grid;grid-template-columns:44px minmax(0,1fr);gap:0 12px;margin:0;padding:14px;",
    "border:1px solid var(--line);border-radius:var(--r-card);background:var(--bg);}",
    ".avatar{display:flex;align-items:center;justify-content:center;width:44px;height:44px;",
    "border-radius:50%;color:#fff;font:700 18px/1 var(--font);user-select:none;}",
    ".info{min-width:0;}",
    ".user,.name{margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
    ".user{color:var(--ink);font:650 14px/1.3 var(--font);}",
    ".name{color:var(--ink-2);font:400 13px/1.35 var(--font);}",
    ".tag{display:inline-block;max-width:100%;margin:7px 0 0;padding:3px 9px;overflow:hidden;",
    "text-overflow:ellipsis;white-space:nowrap;border-radius:var(--r-pill);background:var(--bg-2);",
    "color:var(--ink-2);font:600 11.5px/1.3 var(--font);vertical-align:top;}",
    ".topics{margin:7px 0 0;color:var(--gray);font:400 12.5px/1.45 var(--font);overflow-wrap:anywhere;}",
    ".acts{grid-column:1 / -1;display:flex;gap:8px;margin:12px 0 0;}",
    ".ghost,.primary{display:inline-flex;flex:1 1 0;align-items:center;justify-content:center;",
    "height:34px;margin:0;padding:0 14px;border:0;border-radius:var(--r-pill);cursor:pointer;",
    "white-space:nowrap;font:600 13px/1 var(--font);transition:filter .12s ease,background .12s ease;}",
    ".ghost{background:var(--bg-2);color:var(--ink);}",
    ".ghost:hover{background:var(--line);}",
    ".primary{background:var(--ig-btn);color:#fff;box-shadow:var(--shadow-btn);}",
    ".primary:hover{filter:brightness(1.06);}",

    // Loading, empty and failed
    ".sk{pointer-events:none;}",
    ".sk .avatar,.sk-line{background:var(--bg-2);animation:pulse 1.2s ease-in-out infinite;}",
    ".sk-line{display:block;height:11px;margin:4px 0 9px;border-radius:6px;}",
    ".state{margin:0;padding:40px 12px;color:var(--gray);text-align:center;font:500 13.5px/1.5 var(--font);}",
    ".state.is-bad{color:var(--bad);}",
    ".state .primary{flex:none;margin:14px auto 0;padding:0 22px;}",

    "@keyframes fade{from{opacity:0;}to{opacity:1;}}",
    "@keyframes slide{from{transform:translateX(24px);opacity:0;}to{transform:none;opacity:1;}}",
    "@keyframes pulse{50%{opacity:.45;}}",
    "@media (prefers-reduced-motion:reduce){.scrim,.drawer,.sk .avatar,.sk-line{animation:none;}}"
  ].join("");

  var similar = null; // { close } while the panel is open

  function closeSimilar() {
    if (similar) similar.close();
  }

  // Added to the header only when the worker answers Pro: Free and signed-out
  // accounts never see it.
  function addSimilarButton(actions, before) {
    try {
      chrome.runtime.sendMessage({ type: "isPro" }, function (res) {
        if (chrome.runtime.lastError || !res || !res.ok || res.pro !== true) return;
        if (before.parentElement !== actions || actions.querySelector(".igs-similar")) return;
        var btn = el("button", "igs-ghost igs-similar");
        btn.type = "button";
        btn.appendChild(svgIcon("people", 15, 2));
        btn.appendChild(el("span", "", "Similar accounts"));
        btn.addEventListener("click", function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          openSimilar(btn);
        });
        actions.insertBefore(btn, before);
      });
    } catch (e) {}
  }

  function dropSimilarButton() {
    document.querySelectorAll(".igs-similar").forEach(function (b) {
      b.remove();
    });
  }

  function plural(n, word) {
    return n + " " + word + (n === 1 ? "" : "s");
  }

  function byUsername(a, b) {
    var x = a.username.toLowerCase();
    var y = b.username.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  }

  // The accounts a niche shows: never the profile this page is on, nor one
  // without a username a link can be built from.
  function nicheAccounts(accounts, niche, here) {
    return accounts.filter(function (a) {
      return a.niche === niche && USERNAME_RE.test(a.username) && a.username.toLowerCase() !== here;
    });
  }

  // The filter chips after All: { name, n } for each filter with someone in
  // it, the most accounts first, then A to Z.
  function chipOrder(filters, accounts) {
    return filters.map(function (name) {
      return { name: name, n: accounts.filter(function (a) { return a.filter === name; }).length };
    }).filter(function (c) {
      return c.n > 0;
    }).sort(function (a, b) {
      return b.n - a.n || a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
  }

  // Through the chip (null is All) and the search: username, full name or
  // topics, ignoring case and a leading @. A to Z by username.
  function similarList(accounts, filter, query) {
    var q = query.trim().replace(/^@/, "").toLowerCase();
    return accounts.filter(function (a) {
      if (filter !== null && a.filter !== filter) return false;
      if (!q) return true;
      return [a.username, a.fullName, a.topics].some(function (s) {
        return String(s || "").toLowerCase().indexOf(q) !== -1;
      });
    }).sort(byUsername);
  }

  // The same colour for a username every time.
  function avatarColor(username) {
    var h = 0;
    var s = username.toLowerCase();
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return AVATAR_COLORS[h % AVATAR_COLORS.length];
  }

  function initialOf(a) {
    var first = Array.from((a.fullName || "").trim())[0] || a.username.charAt(0);
    return first.toUpperCase();
  }

  function openProfile(username) {
    window.open("https://www.instagram.com/" + username + "/", "_blank", "noopener");
  }

  // Opens the account's Reels tab with a pending sort for it: this page's
  // sort and depth, used once by that tab within PENDING_SORT_MS.
  function sortReelsOf(username) {
    var s = CURRENT_SORT || DEFAULT_SORT;
    var url = "https://www.instagram.com/" + username + "/reels/";
    var o = {};
    o[PENDING_SORT_KEY] = {
      username: username.toLowerCase(),
      sortBy: s.sortBy,
      limit: s.limit,
      maxReels: s.maxReels || null,
      expiresAt: Date.now() + PENDING_SORT_MS
    };
    try {
      chrome.storage.local.set(o, function () {
        window.open(url, "_blank", "noopener");
      });
    } catch (e) {
      window.open(url, "_blank", "noopener");
    }
  }

  // In a tab Sort reels opened: start the pending sort if it's for this
  // profile's Reels tab, and only once. One for another profile is left for
  // its own tab; an expired one goes.
  function takePendingSort() {
    var m = /^\/([A-Za-z0-9._]{1,30})\/reels\/?$/.exec(location.pathname);
    var want = {};
    want[PENDING_SORT_KEY] = null;
    try {
      chrome.storage.local.get(want, function (o) {
        var p = o && o[PENDING_SORT_KEY];
        if (!p || typeof p !== "object") return;
        var now = Date.now();
        // A time too far ahead (the clock was set back) counts as expired.
        if (!(typeof p.expiresAt === "number" && p.expiresAt > now && p.expiresAt <= now + PENDING_SORT_MS)) {
          chrome.storage.local.remove(PENDING_SORT_KEY);
          return;
        }
        if (!m || typeof p.username !== "string" || p.username.toLowerCase() !== m[1].toLowerCase()) return;
        var ok = !!SORT_TITLE[p.sortBy] && (p.limit === "all" || (Number.isInteger(p.limit) && p.limit > 0));
        chrome.storage.local.remove(PENDING_SORT_KEY, function () {
          if (ok) beginSort({ sortBy: p.sortBy, limit: p.limit, maxReels: p.maxReels });
        });
      });
    } catch (e) {}
  }

  function emptyNode(n) {
    while (n.firstChild) n.removeChild(n.firstChild);
  }

  function similarCard(a) {
    var card = el("li", "card");
    var avatar = el("div", "avatar", initialOf(a));
    avatar.setAttribute("aria-hidden", "true");
    avatar.style.setProperty("background", avatarColor(a.username));
    card.appendChild(avatar);

    var info = el("div", "info");
    info.appendChild(el("p", "user", "@" + a.username));
    if (a.fullName) info.appendChild(el("p", "name", a.fullName));
    if (a.filter) info.appendChild(el("span", "tag", a.filter));
    if (a.topics) info.appendChild(el("p", "topics", a.topics));
    card.appendChild(info);

    var acts = el("div", "acts");
    var open = el("button", "ghost", "Open profile");
    open.type = "button";
    open.setAttribute("aria-label", "Open @" + a.username + "'s profile in a new tab");
    open.addEventListener("click", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      openProfile(a.username);
    });
    var sort = el("button", "primary", "Sort reels");
    sort.type = "button";
    sort.setAttribute("aria-label", "Sort @" + a.username + "'s reels in a new tab");
    sort.addEventListener("click", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      sortReelsOf(a.username);
    });
    acts.appendChild(open);
    acts.appendChild(sort);
    card.appendChild(acts);
    return card;
  }

  function skeleton() {
    var list = el("ul", "list");
    list.setAttribute("aria-hidden", "true");
    for (var i = 0; i < 6; i++) {
      var card = el("li", "card sk");
      card.appendChild(el("div", "avatar"));
      var info = el("div", "info");
      [60, 85, 40].forEach(function (w) {
        var line = el("span", "sk-line");
        line.style.setProperty("width", w + "%");
        info.appendChild(line);
      });
      card.appendChild(info);
      list.appendChild(card);
    }
    return list;
  }

  function openSimilar(returnFocus) {
    closeSimilar();
    closeDialog();

    var open = true;
    var here = ownerHere();
    var data = null;
    var niche = null;
    var filter = null; // a filter's name, or null for All

    var host = ours(el("div"));
    host.id = SIMILAR_ID;
    var root = host.attachShadow({ mode: "closed" });
    var style = el("style");
    style.textContent = SIMILAR_CSS;
    root.appendChild(style);

    var scrim = el("div", "scrim");
    scrim.addEventListener("click", function (ev) {
      ev.stopPropagation();
      close();
    });
    root.appendChild(scrim);

    var box = el("aside", "drawer");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", "Similar accounts");

    var head = el("div", "head");
    head.appendChild(logo());
    var titles = el("div", "");
    titles.appendChild(el("h2", "", "Similar accounts"));
    var count = el("p", "count");
    count.setAttribute("aria-live", "polite");
    titles.appendChild(count);
    head.appendChild(titles);
    var x = closeButton("Close", close);
    head.appendChild(x);
    box.appendChild(head);

    var controls = el("div", "controls");
    controls.hidden = true;
    var nicheField = el("label", "field niche");
    var select = el("select");
    select.setAttribute("aria-label", "Niche");
    nicheField.appendChild(select);
    nicheField.appendChild(svgIcon("chevron", 16, 2));
    controls.appendChild(nicheField);
    var chips = el("div", "chips");
    chips.setAttribute("role", "group");
    chips.setAttribute("aria-label", "Filter");
    controls.appendChild(chips);
    // For this panel only: all the chips, after "+N more" until "Show less".
    var chipsOpen = false;
    var moreChip = chipToggle(true);
    var lessChip = chipToggle(false);
    // A narrower window can need a third row: laid out again when the width
    // changes (not the height, which the layout itself sets).
    var chipWidth = 0;
    var chipResize = typeof ResizeObserver === "function" ? new ResizeObserver(function () {
      if (chips.clientWidth === chipWidth) return;
      chipWidth = chips.clientWidth;
      layOutChips();
    }) : null;
    if (chipResize) chipResize.observe(chips);
    var findField = el("label", "field find");
    findField.appendChild(svgIcon("search", 16, 2));
    var input = el("input");
    input.type = "search";
    input.placeholder = "Search username, name or topic";
    input.setAttribute("aria-label", "Search accounts");
    input.setAttribute("autocomplete", "off");
    input.setAttribute("spellcheck", "false");
    findField.appendChild(input);
    controls.appendChild(findField);
    box.appendChild(controls);

    var body = el("div", "body");
    box.appendChild(body);
    root.appendChild(box);

    function close() {
      if (!open) return;
      open = false;
      similar = null;
      if (chipResize) chipResize.disconnect();
      document.removeEventListener("keydown", onKey, true);
      host.remove();
      if (returnFocus && returnFocus.isConnected) returnFocus.focus();
    }

    // Escape closes, unless a dialog of ours is over the panel.
    function onKey(ev) {
      if (ev.key !== "Escape" || dialog) return;
      ev.preventDefault();
      ev.stopPropagation();
      close();
    }

    function showState(text, bad, retry) {
      controls.hidden = !data;
      count.textContent = "";
      emptyNode(body);
      var p = el("div", "state" + (bad ? " is-bad" : ""));
      p.setAttribute("role", "status");
      p.appendChild(el("p", "", text));
      if (retry) {
        var again = el("button", "primary", "Retry");
        again.type = "button";
        again.addEventListener("click", function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          load();
        });
        p.appendChild(again);
      }
      body.appendChild(p);
    }

    function nicheList() {
      return nicheAccounts(data.accounts, niche, here);
    }

    // "+N more", which shows every chip, or "Show less", which goes back to
    // two rows. Focus moves to the other one, since this one is then hidden.
    function chipToggle(more) {
      var b = el("button", "chip-toggle", more ? "" : "Show less");
      b.type = "button";
      b.hidden = true;
      b.setAttribute("aria-expanded", String(!more));
      b.addEventListener("click", function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        chipsOpen = more;
        layOutChips();
        var other = more ? lessChip : moreChip;
        if (!other.hidden) other.focus();
      });
      return b;
    }

    // Two rows of chips at most, the last place on the second going to
    // "+N more". The chosen chip always shows: when it's past the cut it takes
    // the last chip's place. All shown once opened, then "Show less". Rows
    // are read off the laid-out chips; unmeasured, everything shows.
    function layOutChips() {
      var list = Array.prototype.slice.call(chips.querySelectorAll(".chip"));
      var top = function (c) { return c.offsetTop || 0; };
      list.forEach(function (c) { c.hidden = false; });
      moreChip.hidden = true;
      lessChip.hidden = true;
      var rows = [];
      list.forEach(function (c) {
        if (rows.indexOf(top(c)) === -1) rows.push(top(c));
      });
      if (rows.length <= 2) return;
      if (chipsOpen) {
        lessChip.hidden = false;
        return;
      }
      rows.sort(function (a, b) { return a - b; });
      var last = rows[1];
      var chosen = list.filter(function (c) { return c.getAttribute("aria-pressed") === "true"; })[0];
      var at = list.indexOf(chosen);
      var k = list.filter(function (c) { return top(c) <= last; }).length;
      for (; k > 1; k--) {
        list.forEach(function (c, i) {
          c.hidden = at >= k ? !(i < k - 1 || i === at) : i >= k;
        });
        moreChip.textContent = "+" + (list.length - k) + " more";
        moreChip.hidden = false;
        if (top(moreChip) <= last) break;
      }
    }

    function renderChips() {
      emptyNode(chips);
      var inNiche = nicheList();
      var info = data.niches.filter(function (n) { return n.name === niche; })[0];
      var rows = [{ name: null, n: inNiche.length }].concat(chipOrder((info ? info.filters : []).map(function (f) {
        return f.name;
      }), inNiche));
      rows.forEach(function (row) {
        var chip = el("button", "chip", row.name === null ? "All" : row.name);
        chip.type = "button";
        chip.setAttribute("aria-pressed", String(filter === row.name));
        chip.appendChild(el("i", "", String(row.n)));
        chip.addEventListener("click", function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          filter = row.name;
          // Not rebuilt, so the chip keeps focus.
          chips.querySelectorAll(".chip").forEach(function (c) {
            c.setAttribute("aria-pressed", String(c === chip));
          });
          layOutChips();
          renderList();
        });
        chips.appendChild(chip);
      });
      chips.appendChild(moreChip);
      chips.appendChild(lessChip);
      layOutChips();
    }

    function renderList() {
      var list = similarList(nicheList(), filter, input.value);
      count.textContent = plural(list.length, "account");
      emptyNode(body);
      if (!list.length) {
        var none = el("p", "state", "No accounts match");
        none.setAttribute("role", "status");
        body.appendChild(none);
        return;
      }
      var ul = el("ul", "list");
      list.forEach(function (a) {
        ul.appendChild(similarCard(a));
      });
      body.appendChild(ul);
    }

    function pickNiche(n) {
      niche = n;
      filter = null;
      select.value = n;
      renderChips();
      renderList();
    }

    // The niche of the profile this page is on, else the last one chosen,
    // else the first. Only niches with someone to show are offered.
    function fill(last) {
      var names = data.niches.map(function (n) { return n.name; }).filter(function (name) {
        return nicheAccounts(data.accounts, name, here).length > 0;
      });
      if (!names.length) {
        data = null;
        showState("There are no similar accounts to show yet.", false, false);
        return;
      }
      emptyNode(select);
      names.forEach(function (name) {
        var o = el("option", "", name + " (" + nicheAccounts(data.accounts, name, here).length + ")");
        o.value = name;
        select.appendChild(o);
      });
      var mine = data.accounts.filter(function (a) {
        return a.username.toLowerCase() === here && names.indexOf(a.niche) !== -1;
      })[0];
      controls.hidden = false;
      pickNiche(mine ? mine.niche : names.indexOf(last) !== -1 ? last : names[0]);
    }

    function load() {
      data = null;
      controls.hidden = true;
      count.textContent = "Loading…";
      emptyNode(body);
      body.appendChild(skeleton());
      try {
        chrome.runtime.sendMessage({ type: "directory" }, function (res) {
          if (!open) return;
          if (chrome.runtime.lastError || !res) {
            showState("Extension worker unavailable — reload the extension.", true, true);
            return;
          }
          if (!res.ok) {
            if (res.needsPro) {
              close();
              dropSimilarButton();
              showProDialog(null, {
                title: "Upgrade for similar accounts",
                text: "Similar accounts is part of Sortcut Pro."
              });
              return;
            }
            showState(res.error || SIMILAR_FAILED, true, true);
            return;
          }
          var d = res.directory;
          if (!d || !Array.isArray(d.niches) || !Array.isArray(d.accounts)) {
            showState(SIMILAR_FAILED, true, true);
            return;
          }
          var want = {};
          want[SIMILAR_NICHE_KEY] = null;
          chrome.storage.local.get(want, function (o) {
            if (!open) return;
            data = d;
            fill(o && o[SIMILAR_NICHE_KEY]);
          });
        });
      } catch (e) {
        showState("Extension worker unavailable — reload the extension.", true, true);
      }
    }

    select.addEventListener("change", function () {
      var o = {};
      o[SIMILAR_NICHE_KEY] = select.value;
      try {
        chrome.storage.local.set(o);
      } catch (e) {}
      pickNiche(select.value);
    });
    input.addEventListener("input", function () {
      if (data) renderList();
    });
    // Keys typed in the panel are ours, not Instagram's shortcuts.
    box.addEventListener("keydown", function (ev) {
      if (ev.key !== "Escape") ev.stopPropagation();
    });

    document.addEventListener("keydown", onKey, true);
    (document.body || document.documentElement).appendChild(host);
    similar = { close: close };
    x.focus();
    load();
  }

  // ---- Progress, while a sort runs ----
  // A pill at the top of the page with the run's count, and Instagram's grid
  // dimmed behind it: the collector is scrolling it, and it isn't the result.
  // The same numbers the popup shows; nothing here changes the run.
  var PILL_ID = "ig-sorter-progress";
  var DIM_ATTR = "data-ig-sorter-dim";
  var progressShown = null; // { collected, target } while the pill is up
  var waitingForBody = false;

  function dimGrid() {
    var grid = findGridContainer();
    if (!grid || grid.hasAttribute(DIM_ATTR)) return;
    undimGrid();
    grid.setAttribute(DIM_ATTR, "1");
  }

  function undimGrid() {
    Array.prototype.forEach.call(document.querySelectorAll("[" + DIM_ATTR + "]"), function (n) {
      n.removeAttribute(DIM_ATTR);
    });
  }

  function showProgress(collected, target) {
    progressShown = { collected: collected || 0, target: target || null };
    // At document_start there's no <body> yet; the pill waits for it.
    if (!document.body) {
      if (!waitingForBody) {
        waitingForBody = true;
        document.addEventListener("DOMContentLoaded", function () {
          if (progressShown) showProgress(progressShown.collected, progressShown.target);
        });
      }
      return;
    }
    ensureStyles();
    var pill = document.getElementById(PILL_ID);
    if (!pill) {
      pill = ours(el("div", "igs-pill"));
      pill.id = PILL_ID;
      pill.setAttribute("role", "status");
      pill.appendChild(logo());
      var body = el("div", "igs-pill-body");
      var line = el("p", "igs-pill-text");
      line.appendChild(el("b", "", "Collecting reels"));
      line.appendChild(el("span", "", " — don't scroll"));
      line.appendChild(el("span", "igs-pill-count"));
      body.appendChild(line);
      var bar = el("div", "igs-bar");
      bar.appendChild(el("i"));
      body.appendChild(bar);
      pill.appendChild(body);
      document.body.appendChild(pill);
    }
    var n = progressShown.collected;
    var t = progressShown.target;
    pill.querySelector(".igs-pill-count").textContent = n ? " · " + n + " found" : "";
    var barEl = pill.querySelector(".igs-bar");
    barEl.classList.toggle("is-open", !t);
    barEl.querySelector("i").style.width = t ? Math.min(100, Math.round((n / t) * 100)) + "%" : "";
    dimGrid();
  }

  function hideProgress() {
    progressShown = null;
    var pill = document.getElementById(PILL_ID);
    if (pill) pill.remove();
    undimGrid();
  }

  // Everything hidden while the sorted grid is up, each with the inline display
  // it had before, so Restore puts back exactly what Instagram rendered rather
  // than blanking a display Instagram had set itself.
  var HIDDEN = [];
  var HIDDEN_ATTR = "data-ig-sorter-hidden";
  var FOOTER = 'footer, [role="contentinfo"]';

  function hide(node) {
    if (node.hasAttribute(HIDDEN_ATTR)) return;
    HIDDEN.push({
      el: node,
      value: node.style.getPropertyValue("display"),
      priority: node.style.getPropertyPriority("display")
    });
    node.setAttribute(HIDDEN_ATTR, "1");
    node.style.setProperty("display", "none", "important");
    // React re-renders can rewrite the style and un-hide it.
    if (observer) observer.observe(node, { attributes: true, attributeFilter: ["style"] });
  }

  function unhideAll() {
    HIDDEN.forEach(function (h) {
      if (h.value) h.el.style.setProperty("display", h.value, h.priority);
      else h.el.style.removeProperty("display");
      h.el.removeAttribute(HIDDEN_ATTR);
    });
    HIDDEN = [];
    // Left behind by an earlier copy of this script (the extension was
    // reloaded with the sorted grid up), whose list went with it.
    Array.prototype.forEach.call(document.querySelectorAll("[" + HIDDEN_ATTR + "]"), function (n) {
      n.style.removeProperty("display");
      n.removeAttribute(HIDDEN_ATTR);
    });
  }

  function isFooter(node) {
    return node.matches(FOOTER) || !!node.querySelector(FOOTER);
  }

  // What Instagram renders below its grid: the loading spinner, skeleton
  // tiles, and grid rows it adds after the ones we found. Walks up from the
  // grid hiding every later sibling at each level, and stops at Instagram's
  // footer, which stays. Never goes above <main>, nor touches <body>'s own
  // children: past those are the portals for Instagram's dialogs and menus.
  // Returns the parents it walked, which is where anything new will appear.
  function hideBelow(grid) {
    var parents = [];
    var node = grid;
    for (var depth = 0; depth < 8; depth++) {
      var parent = node.parentElement;
      if (!parent || parent === document.body || parent === document.documentElement) break;
      parents.push(parent);
      for (var sib = node.nextElementSibling; sib; sib = sib.nextElementSibling) {
        if (isFooter(sib)) return parents;
        if (sib.id === WRAP_ID || sib.tagName === "SCRIPT" || sib.tagName === "STYLE") continue;
        hide(sib);
      }
      if (parent.matches('main, [role="main"]')) break;
      node = parent;
    }
    return parents;
  }

  function teardown() {
    closeDialog();
    closeSimilar();
    // The grid a transcription's pill was over is going; the job isn't, and
    // its transcript still opens when it's ready.
    hideTxProgress();
    if (closeExportMenu) closeExportMenu();
    closeExportMenu = null;
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    var wrap = document.getElementById(WRAP_ID);
    if (wrap) wrap.remove();
    unhideAll();
  }

  function renderSorted(posts, sortBy, ranked, median) {
    teardown();

    var container = findGridContainer();
    if (!container) return false;

    // Instagram keeps adding to the page below the grid while ours is up: a
    // spinner and skeleton tiles whenever it fetches the next page, and the
    // rows that page brings. Each one lands in a parent walked by hideBelow,
    // and is hidden as it arrives. So is a hidden node React un-hides.
    observer = new MutationObserver(function () {
      if (!container.isConnected) return;
      hideBelow(container);
      HIDDEN.forEach(function (h) {
        if (h.el.style.getPropertyValue("display") !== "none") {
          h.el.style.setProperty("display", "none", "important");
        }
      });
    });

    // Hide Instagram's grid rather than destroying it. Replacing innerHTML
    // makes React fight back and can break navigation. Whatever Instagram
    // watches to know it's near the end (the last rows, a sentinel, the
    // spinner) is in what's hidden, and a hidden element never comes into
    // view. Instagram's own requests are never touched (Rule 1).
    hide(container);
    var parents = hideBelow(container);

    var wrap = buildGrid(posts, sortBy, ranked, median);
    container.parentElement.insertBefore(wrap, container);

    parents.forEach(function (p) {
      observer.observe(p, { childList: true });
    });

    return true;
  }

  // ---------------------------------------------------------------
  // 5. Export
  // ---------------------------------------------------------------
  // data is text or bytes (a Uint8Array).
  function download(filename, data, mime) {
    var blob = new Blob([data], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      a.remove();
      URL.revokeObjectURL(url);
    }, 1500);
  }

  function profileSlug() {
    var seg = location.pathname.replace(/^\/|\/$/g, "").split("/")[0];
    return (seg || "instagram").replace(/[^a-zA-Z0-9_.-]+/g, "_");
  }

  function exportData(kind) {
    if (!LAST.length) return;
    if (kind === "json") {
      // videoUrl is a signed CDN link that dies within hours. Writing it into a
      // file people keep would ship a column of URLs that are already broken by
      // the time anyone opens it.
      var clean = LAST.map(function (p) {
        var c = {};
        for (var k in p) {
          if (Object.prototype.hasOwnProperty.call(p, k) && k !== "videoUrl") c[k] = p[k];
        }
        return c;
      });
      download(profileSlug() + "-sorted.json", JSON.stringify(clean, null, 2), "application/json");
      return;
    }
    var cols = exportColumns(LAST);
    if (kind === "xlsx") {
      download(
        profileSlug() + "-sorted.xlsx",
        buildXlsx(cols, LAST),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      return;
    }

    // BOM so Excel reads UTF-8 captions correctly.
    download(profileSlug() + "-sorted.csv", "\uFEFF" + csvText(cols, LAST), "text/csv");
  }

  // The CSV export's text, without the BOM. Google Sheets gets the very same
  // text through the worker, so the two can't disagree on columns or format.
  function csvText(cols, posts) {
    var esc = function (v) {
      return '"' + String(v === null || v === undefined ? "" : v).replace(/"/g, '""') + '"';
    };
    var rows = [cols.join(",")];
    posts.forEach(function (p) {
      rows.push(
        cols
          .map(function (c) {
            var v = p[c];
            if (c === "outlierScore" && typeof v === "number") v = v.toFixed(2);
            return esc(v);
          })
          .join(",")
      );
    });
    return rows.join("\r\n");
  }

  // The CSV's and the Excel file's columns, in order.
  function exportColumns(posts) {
    var cols = ["code", "url", "views", "likes", "comments", "createdAt", "isVideo", "caption"];
    // Only carry the column when the run actually produced scores, so a views
    // or likes export doesn't ship a column of blanks.
    var hasScore = posts.some(function (p) {
      return typeof p.outlierScore === "number";
    });
    if (hasScore) cols.splice(3, 0, "outlierScore");
    return cols;
  }

  // ---- Excel (.xlsx) ----
  // Written here rather than with a library: an .xlsx is a zip of a few XML
  // files, and one sheet of numbers, dates and text needs very little of the
  // format. The zip is "stored" (uncompressed), which every spreadsheet app
  // reads. Cells are typed: counts and scores are numbers, createdAt a real
  // date, isVideo a boolean, and everything else, links included, plain text.
  var XLSX_TYPE = {
    views: "number", likes: "number", comments: "number", outlierScore: "score",
    createdAt: "date", isVideo: "bool"
  };
  // Indexes into cellXfs in XLSX_STYLES.
  var XF_DATE = 1;
  var XF_HEADER = 2;
  var XF_SCORE = 3;
  var XLSX_WIDTH = { code: 14, url: 44, createdAt: 20, caption: 60 };
  var XLSX_TEXT_MAX = 32767; // Excel's limit for one cell
  var XLSX_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  var REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  var PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
  var XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

  var XLSX_STYLES =
    XML_HEAD + '<styleSheet xmlns="' + XLSX_NS + '">' +
    '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm:ss"/></numFmts>' +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>' +
    '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="2"><fill><patternFill patternType="none"/></fill>' +
    '<fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="4">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
    '<xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>';

  // XML 1.0 can't carry most control characters at all, even escaped.
  function xmlText(v) {
    return String(v)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function colName(i) {
    var s = "";
    for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) {
      s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
    }
    return s;
  }

  // One cell, or "" for an empty one.
  function xlsxCell(ref, v, type) {
    if (v === null || v === undefined || v === "") return "";
    if (type === "number" || type === "score") {
      if (typeof v !== "number" || !isFinite(v)) return "";
      if (type === "score") v = Math.round(v * 100) / 100;
      return '<c r="' + ref + '"' + (type === "score" ? ' s="' + XF_SCORE + '"' : "") +
        "><v>" + v + "</v></c>";
    }
    if (type === "date") {
      var t = Date.parse(v);
      if (isNaN(t)) return "";
      // Excel counts days from 1899-12-30; createdAt is UTC, and so is this.
      return '<c r="' + ref + '" s="' + XF_DATE + '"><v>' + (t / 86400000 + 25569) + "</v></c>";
    }
    if (type === "bool") return '<c r="' + ref + '" t="b"><v>' + (v ? 1 : 0) + "</v></c>";
    if (type === "header") {
      return '<c r="' + ref + '" s="' + XF_HEADER + '" t="inlineStr"><is><t>' + xmlText(v) + "</t></is></c>";
    }
    var text = String(v).slice(0, XLSX_TEXT_MAX);
    return '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + xmlText(text) + "</t></is></c>";
  }

  function xlsxSheet(cols, posts) {
    var rows = [];
    var cells = cols.map(function (c, i) { return xlsxCell(colName(i) + "1", c, "header"); });
    rows.push('<row r="1">' + cells.join("") + "</row>");
    posts.forEach(function (p, n) {
      var r = n + 2;
      var line = cols.map(function (c, i) {
        return xlsxCell(colName(i) + r, p[c], XLSX_TYPE[c] || "text");
      });
      rows.push('<row r="' + r + '">' + line.join("") + "</row>");
    });
    var widths = cols.map(function (c, i) {
      return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + (XLSX_WIDTH[c] || 11) +
        '" customWidth="1"/>';
    });
    return XML_HEAD + '<worksheet xmlns="' + XLSX_NS + '">' +
      // The header row stays put while scrolling.
      '<sheetViews><sheetView workbookViewId="0">' +
      '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
      "</sheetView></sheetViews>" +
      "<cols>" + widths.join("") + "</cols>" +
      "<sheetData>" + rows.join("") + "</sheetData></worksheet>";
  }

  // Uint8Array of a complete .xlsx: one sheet, "Reels".
  function buildXlsx(cols, posts) {
    return zipStored([
      ["[Content_Types].xml", XML_HEAD +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        "</Types>"],
      ["_rels/.rels", XML_HEAD + '<Relationships xmlns="' + PKG_REL_NS + '">' +
        '<Relationship Id="rId1" Type="' + REL_NS + '/officeDocument" Target="xl/workbook.xml"/>' +
        "</Relationships>"],
      ["xl/workbook.xml", XML_HEAD + '<workbook xmlns="' + XLSX_NS + '" xmlns:r="' + REL_NS + '">' +
        '<sheets><sheet name="Reels" sheetId="1" r:id="rId1"/></sheets></workbook>'],
      ["xl/_rels/workbook.xml.rels", XML_HEAD + '<Relationships xmlns="' + PKG_REL_NS + '">' +
        '<Relationship Id="rId1" Type="' + REL_NS + '/worksheet" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Type="' + REL_NS + '/styles" Target="styles.xml"/>' +
        "</Relationships>"],
      ["xl/styles.xml", XLSX_STYLES],
      ["xl/worksheets/sheet1.xml", xlsxSheet(cols, posts)]
    ]);
  }

  var CRC_TABLE = null;

  function crc32(bytes) {
    if (!CRC_TABLE) {
      CRC_TABLE = new Uint32Array(256);
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        CRC_TABLE[n] = c >>> 0;
      }
    }
    var crc = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  // A zip of [name, text] entries, each stored uncompressed: a local header
  // and the bytes per file, then the central directory and its end record.
  function zipStored(entries) {
    var enc = new TextEncoder();
    var now = new Date();
    var dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    var dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    var parts = [];
    var central = [];
    var offset = 0;

    entries.forEach(function (e) {
      var name = enc.encode(e[0]);
      var data = enc.encode(e[1]);
      var crc = crc32(data);

      var local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true); // version needed: 2.0
      local.setUint16(6, 0, true); // flags
      local.setUint16(8, 0, true); // method: stored
      local.setUint16(10, dosTime, true);
      local.setUint16(12, dosDate, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, name.length, true);
      local.setUint16(28, 0, true); // extra field length
      parts.push(new Uint8Array(local.buffer), name, data);

      var dir = new DataView(new ArrayBuffer(46));
      dir.setUint32(0, 0x02014b50, true);
      dir.setUint16(4, 20, true); // version made by
      dir.setUint16(6, 20, true); // version needed
      dir.setUint16(8, 0, true);
      dir.setUint16(10, 0, true);
      dir.setUint16(12, dosTime, true);
      dir.setUint16(14, dosDate, true);
      dir.setUint32(16, crc, true);
      dir.setUint32(20, data.length, true);
      dir.setUint32(24, data.length, true);
      dir.setUint16(28, name.length, true);
      // extra, comment, disk number, internal and external attributes: all 0
      dir.setUint32(42, offset, true);
      central.push(new Uint8Array(dir.buffer), name);

      offset += 30 + name.length + data.length;
    });

    var dirSize = central.reduce(function (n, b) { return n + b.length; }, 0);
    var end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, dirSize, true);
    end.setUint32(16, offset, true);

    var all = parts.concat(central, [new Uint8Array(end.buffer)]);
    var out = new Uint8Array(offset + dirSize + 22);
    var at = 0;
    all.forEach(function (b) {
      out.set(b, at);
      at += b.length;
    });
    return out;
  }

  // ---------------------------------------------------------------
  // 6. Sort state
  // ---------------------------------------------------------------
  // The popup closes whenever it loses focus, so it can't be the one holding a
  // sort's progress. The run's state lives in storage instead; the popup reads
  // it on open and follows it live. One run at a time: a new sort replaces it.
  //   status: "running" | "done" | "stopped"
  //   message: the progress line, while running
  //   warning: what went wrong on this page, once finished; null when nothing did
  // Each state is stamped with the tab, profile and page load it belongs to, and
  // the popup shows it only on that same page. The worker ends it when the tab
  // loads a new page or closes; leaving the profile ends it here (watchProfile).
  var LOAD_ID = Date.now().toString(36) + Math.random().toString(36).slice(2);
  var TAB_ID = null; // from the worker on load, or the popup's startSort until then
  var RUN_PROFILE = null; // lowercased owner of the Reels tab the run was started on
  var lastStateWrite = 0;
  var lastStateCount = -1;

  function saveSortState(state) {
    state.tabId = TAB_ID;
    state.loadId = LOAD_ID;
    state.profile = RUN_PROFILE;
    state.path = location.pathname;
    state.updatedAt = Date.now();
    lastStateWrite = state.updatedAt;
    try {
      chrome.storage.local.set({ sortState: state });
    } catch (e) {}
  }

  // Only this page load's own state: a newer run, maybe in another tab, may
  // have replaced it already.
  function dropSortState() {
    try {
      chrome.storage.local.get({ sortState: null }, function (o) {
        var s = o.sortState;
        if (s && s.loadId === LOAD_ID) chrome.storage.local.remove("sortState");
      });
    } catch (e) {}
  }

  function ownerHere() {
    return profileSlug().toLowerCase();
  }

  // Opening a post or reel puts its own path in the address bar over the
  // profile without leaving it.
  var OVER_PROFILE = { p: 1, reel: 1, tv: 1 };

  function leftProfile() {
    var here = ownerHere();
    return !!RUN_PROFILE && here !== RUN_PROFILE && !OVER_PROFILE[here];
  }

  // Instagram moves between pages without loading a new one, so a run's page
  // can be left without the worker hearing of it. Leaving the profile ends the
  // sort: the sorted grid goes, and so do its exports and its popup state.
  var watching = false;
  var lastPath = null;

  function watchProfile() {
    if (watching) return;
    watching = true;
    lastPath = location.pathname;
    setInterval(function () {
      if (location.pathname === lastPath) return;
      lastPath = location.pathname;
      if (leftProfile()) endRun();
    }, 1000);
  }

  // RUN_PROFILE stays: a result still on its way from the collector is then
  // seen to belong to the profile that was left.
  function endRun() {
    hideProgress();
    teardown();
    LAST = [];
    dropSortState();
  }

  function minutes(ms) {
    var m = Math.round((ms || 0) / 60000);
    return m + "-minute";
  }

  function progressState(d) {
    showProgress(d.collected, d.target);
    // Written when the count moves, and otherwise every few seconds as a
    // heartbeat; every scroll would be a storage write a second.
    if (d.collected === lastStateCount && Date.now() - lastStateWrite < 5000) return;
    lastStateCount = d.collected;
    saveSortState({
      status: "running",
      sortBy: d.sortBy,
      collected: d.collected,
      target: d.target,
      message:
        "Collecting reels\u2026 " + d.collected + (d.target ? " of " + d.target : "") + " so far."
    });
  }

  var METRIC_WORD = { views: "views", likes: "likes", comments: "comments" };

  // What the user is told for each reason code the collector sends.
  function codeMessage(code, d) {
    switch (code) {
      case "wrong_page":
        return "Open an Instagram profile's Reels tab to sort.";
      case "no_responses":
        return "Instagram didn't send anything while we scrolled \u2014 check your connection, reload the page and try again.";
      case "responses_but_no_reels":
        return "No reels found. This profile may not have any reels, or Instagram may have changed something.";
      case "reels_but_none_from_profile":
        return "Couldn't read reels \u2014 Instagram may have changed something.";
      case "profile_has_no_reels":
        return "This profile hasn't posted any reels.";
      case "stopped_time_limit":
        return (
          "Stopped at the " + minutes(d.limitMs) + " time limit \u2014 sorted the " + d.total +
          " reels collected by then."
        );
      case "reels_missing_metric": {
        var alts = (d.alternatives || []).map(function (m) {
          return METRIC_WORD[m] || m;
        });
        return (
          "Instagram isn't sending " + (METRIC_WORD[d.missingMetric] || d.missingMetric) + " right now" +
          (alts.length ? " \u2014 try sorting by " + alts.join(" or ") + "." : ".")
        );
      }
    }
    return null;
  }

  // ---- Error report offer ----
  // A failed sort that may mean Instagram changed something can offer the
  // user an anonymous error report; the popup asks, and only the worker sends,
  // and only on the user's click. Offered only for these codes (never an empty
  // profile), never after a run that left the Reels tab, and only when the user
  // can see this profile's reels: Instagram said it is public, or (in a break
  // that took is_private with it) it said nothing and the page itself shows at
  // least REPORT_MIN_THUMBS of the profile's reel thumbnails. A profile
  // Instagram said is private is never offered. These are the facts the worker builds the
  // report from: the reason code, counts, the rules it ran on and a browser
  // hint. No profile name, URL or reel goes in.
  var REPORT_REASONS = ["no_responses", "responses_but_no_reels", "reels_but_none_from_profile", "reels_missing_metric"];
  var REPORT_MIN_THUMBS = 3;

  // Instagram's own thumbnails of this profile's reels and posts in its grid
  // (/<profile>/reel/<code>/, /reel/<code>/ or the /p/ forms). Counted before
  // the sorted grid goes in, so ours are never counted.
  function profileThumbs() {
    var grid = findGridContainer();
    if (!grid) return 0;
    var owner = RUN_PROFILE || ownerHere();
    var seen = {};
    var n = 0;
    grid.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]').forEach(function (a) {
      var href = String(a.getAttribute("href") || "").replace(/^https?:\/\/[^/]+/i, "");
      var m = href.match(/^\/(?:([^/?#]+)\/)?(?:reel|p)\/([^/?#]+)/);
      if (!m || (m[1] && m[1].toLowerCase() !== owner) || seen[m[2]]) return;
      seen[m[2]] = true;
      n++;
    });
    return n;
  }

  // Arc puts its theme colours on every page it shows as --arc-palette-*
  // custom properties; Chrome has none. Its user agent is plain Chrome's.
  function looksLikeArc() {
    try {
      return !!getComputedStyle(document.documentElement).getPropertyValue("--arc-palette-title").trim();
    } catch (e) {
      return false;
    }
  }

  function reportOffer(d, codes, thumbs) {
    if (d.reason === "navigated") return null;
    var visible =
      d.profilePrivate === false ||
      ((d.profilePrivate === null || d.profilePrivate === undefined) && thumbs >= REPORT_MIN_THUMBS);
    if (!visible) return null;
    var reason = null;
    for (var i = 0; i < codes.length && !reason; i++) {
      if (REPORT_REASONS.indexOf(codes[i]) !== -1) reason = codes[i];
    }
    if (!reason) return null;
    var rules = d.rules || {};
    return {
      id: LOAD_ID,
      reason: reason,
      rulesSource: rules.source === "remote" ? "remote" : "builtin",
      rulesVersion: typeof rules.version === "number" ? rules.version : 0,
      responsesSeen: d.responses || 0,
      postsFound: d.total || 0,
      scrolls: d.scrolls || 0,
      durationMs: d.elapsedMs || 0,
      arc: looksLikeArc()
    };
  }

  // The result as if it had failed with forcedFailure, once, then the switch
  // is removed. Only a sort that collected normally: not one that left the
  // Reels tab or never started. The three empty-handed codes drop the reels,
  // as a real one would have none; a missing metric keeps them.
  function forceFailure(d) {
    var code = forcedFailure;
    if (REPORT_REASONS.indexOf(code) === -1 || d.reason === "navigated" || d.reason === "wrong_page") return d;
    forcedFailure = null;
    try {
      chrome.storage.local.remove("devForceFailure");
    } catch (e) {}
    console.log("[GridSorter] devForceFailure: this sort ends with " + code + " (switch now off)");
    var out = {};
    for (var k in d) out[k] = d[k];
    out.codes = [code];
    if (code === "reels_missing_metric") {
      out.missingMetric = OUTLIER_FIELD[d.sortBy] || (METRIC_WORD[d.sortBy] ? d.sortBy : "views");
      out.alternatives = [];
    } else {
      out.posts = [];
      out.ranked = 0;
    }
    return out;
  }

  // A finished run says nothing in the popup unless something on this page
  // went wrong: the sorted grid itself is the result. Every failed or partial
  // run carries its reason codes, and the words for each.
  // thumbs: profileThumbs() as the result arrived, before any render.
  function resultState(d, rendered, thumbs) {
    var n = (d.posts || []).length;
    var codes = Array.isArray(d.codes) ? d.codes : [];
    var state = {
      status: d.reason === "complete" || d.reason === "end" ? "done" : "stopped",
      reason: d.reason,
      codes: codes,
      sortBy: d.sortBy,
      collected: d.total,
      target: d.target,
      count: n,
      warning: null,
      // Set when the page scripts ran on (part of) their built-in rules.
      rulesWarning: (d.rules && d.rules.warning) || null,
      // Counts only, for telling why a run stopped where it did: responses
      // read, those holding this profile's reels (hits), reels seen from
      // anyone, others' reels dropped, reels naming no author, and the last
      // "more to load" flag.
      counts: {
        responses: d.responses || 0,
        hits: d.hits || 0,
        reels: (d.stats && d.stats.reels) || 0,
        foreign: (d.stats && d.stats.foreign) || 0,
        unreadable: d.unreadable || 0,
        hasNextPage: d.hasNextPage === undefined ? null : d.hasNextPage
      },
      // Set when the popup may offer an error report (see reportOffer).
      report: reportOffer(d, codes, thumbs || 0)
    };

    var warnings = codes.map(function (c) {
      return codeMessage(c, d);
    }).filter(Boolean);

    if (!n) {
      state.status = "stopped";
      // After navigating, the popup is on some other page and says so.
      state.warning = d.reason === "navigated" ? null : warnings[0] || codeMessage("responses_but_no_reels", d);
      return state;
    }

    if (!rendered && d.reason !== "navigated") {
      warnings.push("Couldn't place the sorted grid on the page \u2014 export still works.");
    }
    state.warning = warnings.join(" ") || null;
    return state;
  }

  // The job a sort reloaded the page for, if this load is that reload.
  function pendingJob() {
    try {
      var raw = sessionStorage.getItem("igSorterJob");
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  // The sort this page load is running or showing, { sortBy, limit, maxReels },
  // so Similar accounts' Sort reels can run the same one on another profile.
  var CURRENT_SORT = null;

  // Starts a sort here: the popup's Sort button, or a pending sort from
  // Similar accounts. o: { sortBy, limit, maxReels, tabId? }. The job waits in
  // sessionStorage for the reload, which arms the interceptor before
  // Instagram's first request.
  function beginSort(o) {
    // maxReels is set on a Free run only: how many reels it keeps, of any
    // age. The collector enforces it.
    var maxReels = o.maxReels > 0 ? o.maxReels : null;
    var limit = maxReels && (o.limit === "all" || o.limit > maxReels) ? maxReels : o.limit;
    if (o.tabId !== undefined) TAB_ID = o.tabId;
    RUN_PROFILE = ownerHere();
    saveSortState({
      status: "running",
      sortBy: o.sortBy,
      collected: 0,
      target: limit === "all" ? null : limit,
      message: "Reloading and collecting reels…"
    });
    try {
      sessionStorage.setItem(
        "igSorterJob",
        JSON.stringify({
          sortBy: o.sortBy, limit: limit, maxReels: maxReels, tabId: TAB_ID,
          // Free is the plan that sends a cap. For the health log.
          plan: maxReels ? "free" : "pro"
        })
      );
    } catch (e) {}
    location.reload();
  }

  // On load: carry on the sort this reload is for, or let the worker end any
  // state this tab had from its last page.
  (function () {
    var job = pendingJob();
    if (job) {
      CURRENT_SORT = { sortBy: job.sortBy, limit: job.limit, maxReels: job.maxReels || null };
      TAB_ID = job.tabId === undefined ? null : job.tabId;
      RUN_PROFILE = ownerHere();
      watchProfile();
      saveSortState({
        status: "running",
        sortBy: job.sortBy,
        collected: 0,
        target: job.limit === "all" ? null : job.limit, // capped by startSort already
        message: "Collecting reels\u2026"
      });
      showProgress(0, job.limit === "all" ? null : job.limit);
    }
    try {
      chrome.runtime.sendMessage({ type: "pageLoad", loadId: LOAD_ID, keep: !!job }, function (res) {
        if (chrome.runtime.lastError || !res) return;
        // The worker's word wins: a duplicated tab inherits the job, tab id and all.
        if (typeof res.tabId === "number") TAB_ID = res.tabId;
      });
    } catch (e) {}
    if (!job) takePendingSort();
  })();

  // The health log: one entry per sort, newest first, the last LOG_MAX kept
  // (chrome.storage.local.health). What was asked, what came back, what was
  // left out and why, and what stopped it. Counts and the profile name only:
  // no reels, captions, links or tokens. It stays on this machine and is never
  // sent anywhere. The only thing that ever leaves is the opt-in error report
  // (background.js, sent only on the user's click): its 10 fields, a few of
  // them the same counts, never the profile name or this log. The worker's
  // sortLog() prints it.
  var LOG_MAX = 50;

  function logSort(d) {
    var stats = d.stats || {};
    var kept = (d.posts || []).length;
    var seen = d.total || 0;
    var entry = {
      type: "sort",
      at: new Date().toISOString(),
      profile: RUN_PROFILE || ownerHere(),
      plan: d.plan || null,
      mode: d.sortBy,
      depth: d.depth === undefined ? null : d.depth,
      // The profile's reels kept in the sorted grid, of `seen` collected.
      kept: kept,
      seen: seen,
      // Seen but left out, by why: past the depth asked for; another
      // account's reel; a reel naming no author; the same reel sent again.
      overDepth: Math.max(0, seen - kept),
      notProfile: stats.foreign || 0,
      noAuthor: d.unreadable || 0,
      duplicates: stats.duplicates || 0,
      // Kept, but without the metric (missing or 0): shown after the ranked ones.
      unranked: METRIC_SORTS[d.sortBy] ? Math.max(0, kept - (d.ranked || 0)) : 0,
      // Responses holding the profile's reels, of all the responses read.
      pages: d.hits || 0,
      responses: d.responses || 0,
      stop: d.reason || null,
      codes: d.codes || [],
      seconds: Math.round((d.elapsedMs || 0) / 1000),
      rules: d.rules ? d.rules.source + " v" + d.rules.version : null,
      rulesWarning: d.rules && d.rules.warning ? String(d.rules.warning).slice(0, 300) : null
    };
    // Says in this tab's console whether it was saved: a failure here is
    // otherwise invisible, and the sort itself works either way.
    function failed(e) {
      console.warn("[GridSorter] health log: couldn't save this sort \u2014", e && e.message ? e.message : e);
    }
    try {
      chrome.storage.local.get({ health: [] }, function (o) {
        if (chrome.runtime.lastError || !o) return failed(chrome.runtime.lastError);
        var list = (Array.isArray(o.health) ? o.health : []).slice(0, LOG_MAX - 1);
        list.unshift(entry);
        chrome.storage.local.set({ health: list }, function () {
          if (chrome.runtime.lastError) return failed(chrome.runtime.lastError);
          console.log("[GridSorter] health log: sort saved (" + entry.kept + " reels, stop: " + entry.stop + "; " +
            list.length + " entries)");
        });
      });
    } catch (e) {
      failed(e);
    }
  }

  // ---------------------------------------------------------------
  // 7. Messages from the page world
  // ---------------------------------------------------------------
  window.addEventListener("message", function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.source !== "ig-sorter") return;

    if (d.type === "progress") progressState(d);

    if (d.type === "interceptorReady") tellPageDevCapture();

    // Only ever in answer to the popup's request. A page script can post this
    // message too; without the check it could make us download whatever it
    // put in it.
    if (d.type === "debugSample" && devCapture && pendingDebugReply) {
      var reply = pendingDebugReply;
      pendingDebugReply = null;
      var sample = d.sample || {};
      try {
        sample.extensionVersion = chrome.runtime.getManifest().version;
      } catch (e) {}
      download(
        profileSlug() + "-debug-sample-" + Date.now() + ".json",
        JSON.stringify(sample, null, 2),
        "application/json"
      );
      reply({ ok: true, bodies: (sample.graphqlBodies || []).length });
    }

    if (d.type === "result") {
      hideProgress();
      d = forceFailure(d);
      logSort(d);
      // Run off to another profile: nothing of it belongs on this page.
      if (leftProfile()) {
        endRun();
        return;
      }
      LAST = d.posts || [];
      var thumbs = profileThumbs();
      // After navigating away the "grid" on screen belongs to some other page.
      var ok =
        LAST.length && d.reason !== "navigated"
          ? renderSorted(LAST, d.sortBy, d.ranked, d.median)
          : false;
      try {
        chrome.storage.local.set({ lastRun: { count: LAST.length, sortBy: d.sortBy, ts: Date.now() } });
      } catch (e) {}
      saveSortState(resultState(d, ok, thumbs));
    }
  });

  // ---------------------------------------------------------------
  // 8. Messages from the popup
  // ---------------------------------------------------------------
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg.type === "transcribeProgress") {
      var setLabel = TX_PROGRESS[msg.code];
      if (setLabel) setLabel(msg.label);
      return false;
    }

    if (msg.type === "startSort") {
      beginSort(msg);
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === "export") {
      exportData(msg.kind);
      sendResponse({ ok: LAST.length > 0, count: LAST.length });
      return true;
    }

    // From the worker, for Export to Google Sheets: the CSV export's text and
    // whose reels they are. Nothing is downloaded here.
    if (msg.type === "sheetsCsv") {
      sendResponse(
        LAST.length
          ? { ok: true, csv: csvText(exportColumns(LAST), LAST), username: profileSlug(), count: LAST.length }
          : { ok: false }
      );
      return true;
    }

    if (msg.type === "restore") {
      teardown();
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === "debugSample") {
      if (!devCapture) {
        sendResponse({ ok: false, error: "Developer capture is off." });
        return true;
      }
      pendingDebugReply = sendResponse;
      window.postMessage({ source: "ig-sorter-debug", type: "debugSampleRequest" }, "*");
      // The page world answers almost instantly; if it never does (interceptor
      // not injected), don't leave the popup hanging.
      setTimeout(function () {
        if (pendingDebugReply === sendResponse) {
          pendingDebugReply = null;
          sendResponse({ ok: false, error: "Interceptor did not answer. Reload the tab." });
        }
      }, 3000);
      return true;
    }

    if (msg.type === "ping") {
      // have: reels to export; sorted: the sorted grid is up, to restore.
      sendResponse({
        ok: true, have: LAST.length, sorted: !!document.getElementById(WRAP_ID), loadId: LOAD_ID
      });
      return true;
    }
    return true;
  });
})();
