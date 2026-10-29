// content.js — ISOLATED world, runs at document_start.
// Injects the page-world scripts, receives results, renders the sorted grid.

(function () {
  // ---------------------------------------------------------------
  // 1. Inject page-world scripts
  // ---------------------------------------------------------------
  function injectPageScript(path) {
    var el = document.createElement("script");
    el.src = chrome.runtime.getURL(path);
    // Dynamically created scripts default to async, which would let them run
    // out of order. The interceptor depends on extract.js already existing,
    // so order must be preserved.
    el.async = false;
    el.onload = function () {
      this.remove();
    };
    (document.head || document.documentElement).appendChild(el);
  }

  injectPageScript("lib/extract.js");
  injectPageScript("page/interceptor.js");
  injectPageScript("page/collector.js");

  // ---------------------------------------------------------------
  // 2. Developer capture
  // ---------------------------------------------------------------
  // Off unless chrome.storage.local.devCapture is true, set by hand from the
  // service worker console (see README). The page-world interceptor can't read
  // storage, so it's told. Captured bodies stay in the tab and are only ever
  // saved to a local file on request.
  var devCapture = false;

  function tellPageDevCapture() {
    window.postMessage({ source: "ig-sorter-debug", type: "devCapture", on: devCapture }, "*");
  }

  try {
    chrome.storage.local.get({ devCapture: false }, function (o) {
      devCapture = o.devCapture === true;
      tellPageDevCapture();
    });
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== "local" || !changes.devCapture) return;
      devCapture = changes.devCapture.newValue === true;
      tellPageDevCapture();
    });
  } catch (e) {}

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

  // Hover states can't be expressed in inline styles, so the tile button is the
  // one thing here that needs a real stylesheet. Everything is prefixed and
  // scoped under .igs-tile so nothing can bleed into Instagram's own UI.
  var STYLE_ID = "ig-sorter-style";
  var SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif";
  var MONO = "ui-monospace,SFMono-Regular,Menlo,monospace";
  var CSS = [
    // content-visibility lets the browser skip layout and paint for tiles that
    // are scrolled out of view. An all-posts run puts hundreds of tiles in the
    // DOM at once, and without this every one of them is painted on every
    // frame. The intrinsic size keeps the scrollbar from jumping as skipped
    // tiles are realised.
    ".igs-tile{position:relative;content-visibility:auto;",
    "contain-intrinsic-size:auto 220px;}",

    ".igs-tx{position:absolute;bottom:6px;right:6px;z-index:3;",
    "width:28px;height:28px;padding:0;margin:0;border:0;border-radius:8px;",
    "display:flex;align-items:center;justify-content:center;cursor:pointer;",
    "background:rgba(23,21,28,.7);color:#EFECF4;opacity:.5;",
    "transition:opacity .15s ease,background .15s ease,transform .12s ease;}",

    // Visible at rest so it can be discovered without hovering, but held back
    // far enough that 100 tiles don't read as 100 buttons.
    //
    // The blur lives ONLY here, on hover, and never on the resting button.
    // backdrop-filter forces a compositing layer and re-samples what is behind
    // it every frame; opacity:.5 does not switch that off. On the resting rule
    // it meant one live blur per video tile, which is hundreds of them during
    // an all-posts scroll. Scoped to :hover there is at most one.
    ".igs-tile:hover .igs-tx:not(.is-busy):not(.is-done):not(.is-error)",
    "{opacity:1;background:rgba(23,21,28,.92);",
    "-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);}",
    ".igs-tx:not(.is-busy):not(.is-done):not(.is-error):hover",
    "{opacity:1;background:#E8A33D;color:#17151C;transform:scale(1.09);}",

    // Keyboard users get the same affordance as the mouse, without a hover.
    ".igs-tx:focus-visible{opacity:1;outline:2px solid #E8A33D;outline-offset:2px;}",

    ".igs-tx.is-busy{opacity:1;background:rgba(23,21,28,.92);cursor:progress;}",
    ".igs-tx.is-done{opacity:1;background:#3A7D4E;color:#fff;}",
    ".igs-tx.is-error{opacity:1;background:#8F3A3A;color:#fff;}",

    ".igs-tx.is-busy svg{animation:igs-spin .8s linear infinite;}",
    "@keyframes igs-spin{to{transform:rotate(360deg);}}",
    "@media (prefers-reduced-motion:reduce){",
    ".igs-tx.is-busy svg{animation:none;}.igs-tx{transition:none;}}",

    // The tile's cell. The failure card sits here, beside the tile's <a>
    // rather than inside it, so clicking the card can't open the post.
    ".igs-cell{position:relative;min-width:0;}",

    // Shared close button: the failure card and the dialogs.
    ".igs-x{position:absolute;top:10px;right:10px;width:28px;height:28px;",
    "margin:0;padding:0;border:0;border-radius:7px;background:transparent;",
    "color:#918AA0;display:flex;align-items:center;justify-content:center;",
    "font:400 20px/1 " + SANS + ";cursor:pointer;}",
    ".igs-x:hover{background:#221E29;color:#EFECF4;}",
    ".igs-x:focus-visible,.igs-btn:focus-visible{outline:2px solid #E8A33D;outline-offset:2px;}",

    // Failure card: over the bottom of the reel it belongs to, until dismissed.
    ".igs-card{position:absolute;left:6px;right:6px;bottom:6px;z-index:4;",
    "box-sizing:border-box;max-height:calc(100% - 12px);overflow:auto;margin:0;",
    "padding:8px 28px 9px 10px;border:1px solid rgba(240,138,122,.42);border-radius:8px;",
    "background:#17151C;color:#EFECF4;box-shadow:0 6px 18px rgba(0,0,0,.35);",
    "font:500 11.5px/1.4 " + SANS + ";text-align:left;cursor:default;}",
    ".igs-card-title{display:block;margin:0 0 3px;color:#F08A7A;",
    "font:700 10px/1.2 " + MONO + ";letter-spacing:.06em;text-transform:uppercase;}",
    ".igs-card .igs-x{top:3px;right:3px;width:22px;height:22px;font-size:16px;}",

    // Sign-in and Upgrade dialogs. The palette and the three-bar mark are the popup's.
    ".igs-modal{position:fixed;inset:0;z-index:2147483647;box-sizing:border-box;",
    "display:flex;align-items:center;justify-content:center;padding:16px;",
    "background:rgba(10,9,13,.55);}",
    ".igs-dialog{position:relative;box-sizing:border-box;width:100%;max-width:340px;",
    "margin:0;padding:20px 18px 18px;border:1px solid #322C3D;border-radius:12px;",
    "background:#17151C;color:#EFECF4;box-shadow:0 18px 48px rgba(0,0,0,.45);",
    "font:400 13px/1.45 " + SANS + ";text-align:left;}",
    ".igs-dialog-head{display:flex;align-items:center;gap:10px;margin:0 30px 8px 0;}",
    ".igs-marks{flex:none;display:flex;align-items:flex-end;gap:3px;height:16px;}",
    ".igs-marks i{display:block;width:4px;border-radius:2px;background:#E8A33D;}",
    ".igs-marks i:nth-child(1){height:16px;}",
    ".igs-marks i:nth-child(2){height:11px;opacity:.72;}",
    ".igs-marks i:nth-child(3){height:7px;opacity:.46;}",
    ".igs-dialog h2{margin:0;padding:0;color:#EFECF4;",
    "font:700 15px/1.25 " + SANS + ";letter-spacing:-.02em;}",
    ".igs-dialog p{margin:0 0 14px;padding:0;color:#C9C4D3;font:400 13px/1.45 " + SANS + ";}",
    ".igs-dialog p.igs-dialog-err{margin:-4px 0 12px;color:#F08A7A;",
    "font:500 11.5px/1.45 " + MONO + ";}",
    ".igs-btn{display:block;box-sizing:border-box;width:100%;margin:0;padding:11px;",
    "border:0;border-radius:8px;background:#E8A33D;color:#17151C;cursor:pointer;",
    "font:700 13px/1 " + SANS + ";letter-spacing:-.01em;}",
    ".igs-btn:hover{filter:brightness(1.07);}",
    ".igs-btn:disabled{opacity:.6;cursor:progress;filter:none;}"
  ].join("");

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  var SVG_NS = "http://www.w3.org/2000/svg";

  // Built node by node rather than through innerHTML: Instagram enforces
  // Trusted Types on some surfaces, which rejects markup assignment outright.
  var ICONS = {
    // Ragged lines of text — a transcript.
    idle: ["M5 6h14", "M5 10h14", "M5 14h10", "M5 18h7"],
    busy: ["M12 3a9 9 0 1 0 9 9"],
    done: ["M4.5 12.5l5 5 10-11"],
    error: ["M6 6l12 12", "M18 6L6 18"]
  };

  function setIcon(btn, name) {
    while (btn.firstChild) btn.removeChild(btn.firstChild);
    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "15");
    svg.setAttribute("height", "15");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2.2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    ICONS[name].forEach(function (d) {
      var path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", d);
      svg.appendChild(path);
    });
    btn.appendChild(svg);
  }

  var IDLE_LABEL = "Transcribe this reel and download it as .txt";

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

  // Every failure gets one of these on its reel, and it stays until it's
  // dismissed or the reel is tried again. The tile's own tooltip resets after a
  // few seconds, which is too short to read, let alone report.
  function showFailureCard(cell, text) {
    clearFailureCard(cell);
    var card = el("div", "igs-card");
    card.setAttribute("role", "alert");
    card.appendChild(el("span", "igs-card-title", "Couldn't transcribe"));
    card.appendChild(el("span", "igs-card-msg", text));
    card.appendChild(
      closeButton("Dismiss", function () {
        card.remove();
      })
    );
    // Clicks stay on the card: none of them should reach Instagram.
    card.addEventListener("click", function (ev) {
      ev.stopPropagation();
    });
    cell.appendChild(card);
  }

  function clearFailureCard(cell) {
    var old = cell.querySelector(".igs-card");
    if (old) old.remove();
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
    var backdrop = el("div", "igs-modal");
    var box = el("div", "igs-dialog");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-labelledby", "igs-dialog-title");
    box.setAttribute("aria-describedby", "igs-dialog-text");

    var head = el("div", "igs-dialog-head");
    var marks = el("div", "igs-marks");
    marks.setAttribute("aria-hidden", "true");
    for (var i = 0; i < 3; i++) marks.appendChild(el("i"));
    head.appendChild(marks);
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

  function showProDialog(returnFocus) {
    showDialog(returnFocus, {
      title: "Upgrade to transcribe",
      text: "Transcription is part of Sortcut Pro.",
      action: "Upgrade to Pro",
      onAction: function (ui) {
        window.open(PRICING_URL, "_blank", "noopener");
        ui.close();
      }
    });
  }

  // A tile is an <a> to the post, so anything placed inside it has to stop its
  // own clicks from navigating away mid-transcription.
  function buildTranscribeButton(p, cell) {
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
      clearFailureCard(cell);
      btn.disabled = true;
      state("busy", "Transcribing…");
      // Label only: re-running state() would restart the spinner each time.
      TX_PROGRESS[p.code] = function (label) {
        btn.title = label;
        btn.setAttribute("aria-label", label);
      };

      var settle = function (name, label) {
        delete TX_PROGRESS[p.code];
        btn.disabled = false;
        state(name, label);
        // Return to idle so it can be run again — an expired link and a rate
        // limit both clear up, and a saved transcript may want re-downloading.
        setTimeout(function () {
          state("idle", IDLE_LABEL);
        }, 4000);
      };

      // The same words on the tile, on the card and in the popup.
      var fail = function (text) {
        settle("error", text);
        showFailureCard(cell, text);
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
        downloadTranscript(p, res.result);
        settle("done", "Saved — click to download again");
        saveTranscribeStatus(
          true, p.code, "Transcript saved (" + (res.result.language || "unknown") + ")."
        );
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

  function buildGrid(posts, sortBy, ranked, median, days) {
    if (ranked === null || ranked === undefined) ranked = posts.length;
    // Which metric the outlier score is measured on, or null for a plain sort.
    var outlierOn = OUTLIER_FIELD[sortBy] || null;
    ensureStyles();

    var wrap = document.createElement("div");
    wrap.id = WRAP_ID;
    wrap.style.cssText = "width:100%;margin:0 0 24px 0;";

    var bar = document.createElement("div");
    bar.style.cssText =
      "display:flex;align-items:center;justify-content:space-between;gap:12px;" +
      "padding:10px 12px;margin-bottom:10px;border-radius:10px;" +
      "background:#17151C;color:#EFECF4;" +
      "font:600 13px/1.3 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;";

    var label = document.createElement("span");
    var rest = posts.length - ranked;
    if (outlierOn && median) {
      // The median is the whole basis of the score, so state it rather than
      // leaving every badge as an unexplained multiplier.
      label.textContent =
        ranked + " reels \u00b7 outlier score vs median " + fmt(Math.round(median)) + " " + outlierOn +
        (rest > 0 ? " \u00b7 " + rest + " with none" : "");
    } else if (METRIC_SORTS[sortBy] && rest > 0) {
      // Say plainly that the tail isn't ranked, otherwise the numbered badges
      // imply an ordering the filler reels don't actually have.
      label.textContent =
        posts.length + " reels \u00b7 " + ranked + " ranked by " + (outlierOn || sortBy) +
        " \u00b7 " + rest + " with none";
    } else {
      label.textContent =
        posts.length + " reels sorted by " + sortBy + " \u00b7 highest first";
    }
    if (days) label.textContent += " \u00b7 last " + days + " days";
    bar.appendChild(label);

    var restore = document.createElement("button");
    restore.textContent = "Restore original";
    restore.style.cssText =
      "border:0;border-radius:7px;padding:6px 11px;cursor:pointer;" +
      "background:#E8A33D;color:#17151C;font:600 12px/1 inherit;";
    restore.addEventListener("click", function () {
      teardown();
    });
    bar.appendChild(restore);
    wrap.appendChild(bar);

    var grid = document.createElement("div");
    grid.style.cssText =
      "display:grid;grid-template-columns:repeat(4,1fr);gap:4px;width:100%;";

    posts.forEach(function (p, idx) {
      var isFiller = idx >= ranked;

      var cell = document.createElement("div");
      cell.className = "igs-cell";

      var tile = document.createElement("a");
      tile.href = p.url || "#";
      tile.target = "_blank";
      tile.rel = "noopener noreferrer";
      // The class is what the transcribe button's hover rule hangs off; the
      // positioning stays inline to match the rest of the grid.
      tile.className = "igs-tile";
      tile.style.cssText =
        "position:relative;display:block;aspect-ratio:1/1;overflow:hidden;" +
        "background:#221E29;text-decoration:none;";

      if (p.thumbnail) {
        var img = document.createElement("img");
        img.src = p.thumbnail;
        img.loading = "lazy";
        img.referrerPolicy = "no-referrer";
        img.style.cssText =
          "width:100%;height:100%;object-fit:cover;display:block;";
        tile.appendChild(img);
      }

      var rank = document.createElement("div");
      // Filler posts get a dash, not a position. Numbering them would claim
      // post #21 beat post #22 on a metric neither of them has.
      rank.textContent = isFiller ? "–" : String(idx + 1);
      rank.style.cssText =
        "position:absolute;top:6px;left:6px;min-width:20px;height:20px;" +
        "display:flex;align-items:center;justify-content:center;padding:0 5px;" +
        "border-radius:6px;background:rgba(23,21,28,.82);color:" +
        (isFiller ? "#8F8A99" : "#E8A33D") + ";" +
        "font:700 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;";
      tile.appendChild(rank);

      // Only above the baseline. A 0.4x badge on a below-median post is noise —
      // and at exactly 1x the score says nothing the median line doesn't.
      if (outlierOn && p.outlierScore > 1) {
        var score = document.createElement("div");
        score.textContent = fmtScore(p.outlierScore);
        score.title =
          fmt(p[outlierOn]) + " " + outlierOn +
          " vs median " + fmt(Math.round(median));
        score.style.cssText =
          "position:absolute;top:6px;right:6px;height:20px;display:flex;" +
          "align-items:center;padding:0 7px;border-radius:6px;" +
          "background:#E8A33D;color:#17151C;" +
          "font:700 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;";
        tile.appendChild(score);
      }

      // Every video gets a button. Deliberately NOT gated on p.videoUrl:
      // Instagram's grid queries return thumbnails and counts but no playable
      // rendition, so gating on it hid the button on literally every tile. The
      // URL is resolved at click time instead.
      var canTranscribe = !!p.isVideo;
      if (canTranscribe) tile.appendChild(buildTranscribeButton(p, cell));

      var meta = document.createElement("div");
      meta.style.cssText =
        "position:absolute;left:0;right:0;bottom:0;" +
        // Keep the stats clear of the transcribe button in the same corner.
        "padding:16px " + (canTranscribe ? "42px" : "8px") + " 7px 8px;" +
        "background:linear-gradient(transparent,rgba(23,21,28,.88));" +
        "color:#fff;display:flex;gap:9px;flex-wrap:wrap;" +
        "font:600 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;";

      var parts = [];
      if (p.views !== null && p.views !== undefined) parts.push("\u25B6 " + fmt(p.views));
      parts.push("\u2665 " + fmt(p.likes));
      parts.push("\u25CB " + fmt(p.comments));
      meta.textContent = parts.join("   ");
      tile.appendChild(meta);

      cell.appendChild(tile);
      grid.appendChild(cell);
    });

    wrap.appendChild(grid);
    return wrap;
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
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    var wrap = document.getElementById(WRAP_ID);
    if (wrap) wrap.remove();
    unhideAll();
  }

  function renderSorted(posts, sortBy, ranked, median, days) {
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

    var wrap = buildGrid(posts, sortBy, ranked, median, days);
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

    var esc = function (v) {
      return '"' + String(v === null || v === undefined ? "" : v).replace(/"/g, '""') + '"';
    };
    var rows = [cols.join(",")];
    LAST.forEach(function (p) {
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
    // BOM so Excel reads UTF-8 captions correctly.
    download(profileSlug() + "-sorted.csv", "\uFEFF" + rows.join("\r\n"), "text/csv");
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
    teardown();
    LAST = [];
    dropSortState();
  }

  function minutes(ms) {
    var m = Math.round((ms || 0) / 60000);
    return m + "-minute";
  }

  function progressState(d) {
    // Written when the count moves, and otherwise every few seconds as a
    // heartbeat; every scroll would be a storage write a second.
    if (d.collected === lastStateCount && Date.now() - lastStateWrite < 5000) return;
    lastStateCount = d.collected;
    saveSortState({
      status: "running",
      sortBy: d.sortBy,
      collected: d.collected,
      target: d.target,
      days: d.days || null,
      message:
        "Collecting reels\u2026 " + d.collected + (d.target ? " of " + d.target : "") + " so far."
    });
  }

  // A finished run says nothing in the popup unless something on this page
  // went wrong: the sorted grid itself is the result.
  function resultState(d, rendered) {
    var n = (d.posts || []).length;
    var state = {
      status: d.reason === "complete" || d.reason === "end" || d.reason === "past_range" ? "done" : "stopped",
      reason: d.reason,
      sortBy: d.sortBy,
      collected: d.total,
      target: d.target,
      days: d.days || null,
      count: n,
      warning: null
    };

    if (!n) {
      state.status = "stopped";
      state.warning =
        d.reason === "navigated"
          ? null // the popup is on some other page by now, and says so
          : d.reason === "wrong_page"
          ? "Open an Instagram profile's Reels tab to sort."
          : d.days && d.seen > 0
          ? // Reels arrived, just none recent enough for a Free run.
            "No reels from the last " + d.days + " days."
          : d.unreadable > 0
          ? // Reels arrived but none named an author we could match.
            "Couldn't read reels \u2014 Instagram may have changed something."
          : "No reels found. This profile may not have any reels, or Instagram may have changed something.";
      return state;
    }

    var warnings = [];
    if (d.reason === "timeout") {
      warnings.push(
        "Stopped at the " + minutes(d.limitMs) + " time limit \u2014 sorted the " + d.total +
        " reels collected by then."
      );
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

  // On load: carry on the sort this reload is for, or let the worker end any
  // state this tab had from its last page.
  (function () {
    var job = pendingJob();
    if (job) {
      TAB_ID = job.tabId === undefined ? null : job.tabId;
      RUN_PROFILE = ownerHere();
      watchProfile();
      saveSortState({
        status: "running",
        sortBy: job.sortBy,
        collected: 0,
        target: job.limit === "all" ? null : job.limit, // capped by startSort already
        days: job.days || null,
        message: "Collecting reels\u2026"
      });
    }
    try {
      chrome.runtime.sendMessage({ type: "pageLoad", loadId: LOAD_ID, keep: !!job }, function (res) {
        if (chrome.runtime.lastError || !res) return;
        // The worker's word wins: a duplicated tab inherits the job, tab id and all.
        if (typeof res.tabId === "number") TAB_ID = res.tabId;
      });
    } catch (e) {}
  })();

  // ---------------------------------------------------------------
  // 7. Messages from the page world
  // ---------------------------------------------------------------
  window.addEventListener("message", function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.source !== "ig-sorter") return;

    if (d.type === "progress") progressState(d);

    if (d.type === "interceptorReady") tellPageDevCapture();

    if (d.type === "healthAlert") {
      try {
        chrome.storage.local.get({ health: [] }, function (o) {
          var list = o.health || [];
          list.unshift({
            reason: d.reason, stop: d.stop, path: d.path, hits: d.hits,
            responses: d.responses, ts: d.ts
          });
          chrome.storage.local.set({ health: list.slice(0, 20) });
        });
      } catch (e) {}
    }

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
      // Run off to another profile: nothing of it belongs on this page.
      if (leftProfile()) {
        endRun();
        return;
      }
      LAST = d.posts || [];
      // After navigating away the "grid" on screen belongs to some other page.
      var ok =
        LAST.length && d.reason !== "navigated"
          ? renderSorted(LAST, d.sortBy, d.ranked, d.median, d.days)
          : false;
      try {
        chrome.storage.local.set({ lastRun: { count: LAST.length, sortBy: d.sortBy, ts: Date.now() } });
      } catch (e) {}
      saveSortState(resultState(d, ok));
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
      // days and maxReels are set on a Free run only: how far back it reaches
      // and how many reels it keeps. The collector enforces both.
      var days = msg.days > 0 ? msg.days : null;
      var maxReels = msg.maxReels > 0 ? msg.maxReels : null;
      var limit = maxReels && (msg.limit === "all" || msg.limit > maxReels) ? maxReels : msg.limit;
      if (msg.tabId !== undefined) TAB_ID = msg.tabId;
      RUN_PROFILE = ownerHere();
      saveSortState({
        status: "running",
        sortBy: msg.sortBy,
        collected: 0,
        target: limit === "all" ? null : limit,
        days: days,
        message: "Reloading and collecting reels\u2026"
      });
      try {
        sessionStorage.setItem(
          "igSorterJob",
          JSON.stringify({
            sortBy: msg.sortBy, limit: limit, days: days, maxReels: maxReels, tabId: TAB_ID
          })
        );
      } catch (e) {}
      sendResponse({ ok: true });
      // Reload so the interceptor is armed before Instagram's first request.
      location.reload();
      return true;
    }

    if (msg.type === "export") {
      exportData(msg.kind);
      sendResponse({ ok: LAST.length > 0, count: LAST.length });
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
