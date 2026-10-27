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

    // Shared close button: the failure card and the sign-in dialog.
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

    // Sign-in dialog. The palette and the three-bar mark are the popup's.
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

  // ---- Sign-in dialog ----
  // A signed-out Transcribe click lands here instead of opening Google: the
  // Google window only opens from this dialog's button. One dialog at a time;
  // opening another abandons the first.
  var signInDialog = null; // { close }

  function closeSignInDialog() {
    if (signInDialog) signInDialog.close();
  }

  function showSignInDialog(returnFocus, onSignedIn) {
    closeSignInDialog();
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
    var title = el("h2", "", "Sign in to transcribe");
    title.id = "igs-dialog-title";
    head.appendChild(title);
    box.appendChild(head);

    var text = el("p", "", "You need to be signed in first.");
    text.id = "igs-dialog-text";
    box.appendChild(text);

    var err = el("p", "igs-dialog-err");
    err.setAttribute("role", "status");
    err.hidden = true;
    box.appendChild(err);

    var go = el("button", "igs-btn", "Sign in with Google");
    go.type = "button";
    box.appendChild(go);

    var x = closeButton("Close", close);
    box.appendChild(x);
    backdrop.appendChild(box);

    function close() {
      if (!open) return;
      open = false;
      signInDialog = null;
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

    go.addEventListener("click", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      if (go.disabled) return;
      go.disabled = true;
      go.textContent = "Signing in…";
      err.hidden = true;
      chrome.runtime.sendMessage({ type: "pageSignIn" }, function (res) {
        var failed = chrome.runtime.lastError || !res || !res.ok;
        // Closed while Google's window was up: the sign-in itself stands, but
        // the transcription it was opened for is dropped with the dialog.
        if (!open) return;
        if (failed) {
          go.disabled = false;
          go.textContent = "Sign in with Google";
          // Closing Google's window comes back as "Sign-in was cancelled."
          err.textContent = (res && res.error) || "Extension worker unavailable — reload the extension.";
          err.hidden = false;
          return;
        }
        close();
        onSignedIn();
      });
    });

    backdrop.addEventListener("click", function (ev) {
      ev.stopPropagation();
    });
    document.addEventListener("keydown", onKey, true);
    (document.body || document.documentElement).appendChild(backdrop);
    signInDialog = { close: close };
    go.focus();
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
        if (!res.ok && res.signedOut) {
          // Nothing was attempted. The dialog takes over, and a successful
          // sign-in runs this same reel again.
          delete TX_PROGRESS[p.code];
          btn.disabled = false;
          state("idle", IDLE_LABEL);
          showSignInDialog(btn, start);
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

  function buildGrid(posts, sortBy, ranked, median) {
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
    closeSignInDialog();
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
  function download(filename, text, mime) {
    var blob = new Blob([text], { type: mime });
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
    var cols = ["code", "url", "views", "likes", "comments", "createdAt", "isVideo", "caption"];
    // Only carry the column when the run actually produced scores, so a views
    // or likes export doesn't ship a column of blanks.
    var hasScore = LAST.some(function (p) {
      return typeof p.outlierScore === "number";
    });
    if (hasScore) cols.splice(3, 0, "outlierScore");

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

  // ---------------------------------------------------------------
  // 6. Sort state
  // ---------------------------------------------------------------
  // The popup closes whenever it loses focus, so it can't be the one holding a
  // sort's progress. The run's state lives in storage instead; the popup reads
  // it on open and follows it live. One run at a time: a new sort replaces it.
  //   status: "running" | "done" | "stopped"
  //   message: the line the popup shows, written here so wording lives in one place
  var SORT_LABEL = {
    views: "views",
    likes: "likes",
    comments: "comments",
    outlier: "outlier score (views)",
    outlierLikes: "outlier score (likes)",
    outlierComments: "outlier score (comments)"
  };
  var lastStateWrite = 0;
  var lastStateCount = -1;

  function saveSortState(state) {
    state.profile = profileSlug();
    state.path = location.pathname;
    state.updatedAt = Date.now();
    lastStateWrite = state.updatedAt;
    try {
      chrome.storage.local.set({ sortState: state });
    } catch (e) {}
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
      message:
        "Collecting reels\u2026 " + d.collected + (d.target ? " of " + d.target : "") + " so far."
    });
  }

  function resultState(d, rendered) {
    var n = (d.posts || []).length;
    var label = SORT_LABEL[d.sortBy] || d.sortBy;
    var metric = OUTLIER_FIELD[d.sortBy] || d.sortBy;
    var state = {
      status: d.reason === "complete" || d.reason === "end" ? "done" : "stopped",
      reason: d.reason,
      sortBy: d.sortBy,
      collected: d.total,
      target: d.target,
      count: n,
      tone: "good"
    };

    if (!n) {
      state.status = "stopped";
      state.tone = "bad";
      state.message =
        d.reason === "navigated"
          ? "Stopped: you left the Reels tab before any reels were collected."
          : d.reason === "wrong_page"
          ? "Open an Instagram profile's Reels tab to sort."
          : d.unreadable > 0
          ? // Reels arrived but none named an author we could match.
            "Couldn't read reels \u2014 Instagram may have changed something."
          : "No reels found. This profile may not have any reels, or Instagram may have changed something.";
      return state;
    }

    var lead = {
      complete: "Sorted " + n + " reels by " + label + ".",
      end: "Sorted all " + d.total + " reels by " + label + " \u2014 that's the whole Reels tab.",
      stalled:
        "Stopped: Instagram sent no new reels for a while. Sorted the " + d.total +
        " collected by " + label + ".",
      timeout:
        "Stopped at the " + minutes(d.limitMs) + " limit. Sorted the " + d.total +
        " collected by " + label + ".",
      navigated:
        "Stopped: you left the Reels tab. " + d.total + " reels collected \u2014 export still works."
    }[d.reason] || "Sorted " + n + " reels by " + label + ".";

    var note = "";
    var rest = n - (typeof d.ranked === "number" ? d.ranked : n);
    if (METRIC_SORTS[d.sortBy] && rest > n / 2) {
      // Ranking a handful and listing the rest after them would look like a
      // complete ranking. Say so instead.
      state.tone = "";
      note =
        " Most of these reels (" + rest + " of " + n + ") have no " + metric +
        " count, so they can't be ranked by " + metric + "; they're listed last, unranked.";
    } else if (METRIC_SORTS[d.sortBy] && rest > 0) {
      note = " " + rest + " have no " + metric + " count and are listed last.";
    }
    if (OUTLIER_FIELD[d.sortBy] && d.median) {
      note += " Median " + fmt(Math.round(d.median)) + " " + metric + ".";
    }
    if (!rendered && d.reason !== "navigated") {
      note += " Couldn't place the sorted grid on the page \u2014 export still works.";
    }
    if (state.status === "stopped") state.tone = "";
    state.message = lead + note;
    return state;
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
      LAST = d.posts || [];
      // After navigating away the "grid" on screen belongs to some other page.
      var ok =
        LAST.length && d.reason !== "navigated"
          ? renderSorted(LAST, d.sortBy, d.ranked, d.median)
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
      saveSortState({
        status: "running",
        sortBy: msg.sortBy,
        collected: 0,
        target: msg.limit === "all" ? null : msg.limit,
        message: "Reloading and collecting reels\u2026"
      });
      try {
        sessionStorage.setItem(
          "igSorterJob",
          JSON.stringify({ sortBy: msg.sortBy, limit: msg.limit })
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
      sendResponse({ ok: true, have: LAST.length });
      return true;
    }
    return true;
  });
})();
