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
  // 2. Helpers
  // ---------------------------------------------------------------
  var LAST = [];
  var observer = null;

  function fmt(n) {
    if (n === null || n === undefined) return "\u2014";
    if (n >= 1000000) return (n / 1000000).toFixed(n >= 10000000 ? 0 : 1) + "M";
    if (n >= 1000) return (n / 1000).toFixed(n >= 100000 ? 0 : 1) + "K";
    return String(n);
  }

  function tellPopup(msg) {
    try {
      chrome.runtime.sendMessage(msg, function () {
        // Popup is usually closed. Reading lastError prevents a console warning.
        void chrome.runtime.lastError;
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
  // 3. Render
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
    ".igs-tx.is-busy svg{animation:none;}.igs-tx{transition:none;}}"
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

      btn.disabled = true;
      state("busy", "Transcribing…");

      var settle = function (name, label) {
        btn.disabled = false;
        state(name, label);
        // Return to idle so it can be run again — an expired link and a rate
        // limit both clear up, and a saved transcript may want re-downloading.
        setTimeout(function () {
          state("idle", IDLE_LABEL);
        }, 4000);
      };

      chrome.runtime.sendMessage({ type: "transcribe", post: p }, function (res) {
        if (chrome.runtime.lastError || !res) {
          settle("error", "Extension worker unavailable — reload the extension.");
          tellPopup({ type: "transcribeError", error: "Extension worker unavailable." });
          return;
        }
        if (!res.ok) {
          settle("error", res.error || "Transcription failed");
          tellPopup({ type: "transcribeError", error: res.error });
          return;
        }
        downloadTranscript(p, res.result);
        settle("done", "Saved — click to download again");
        tellPopup({ type: "transcribeDone", code: p.code, language: res.result.language });
      });
    });

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
    wrap.id = "ig-sorter-wrap";
    wrap.style.cssText = "width:100%;margin:0 0 24px 0;";

    var bar = document.createElement("div");
    bar.style.cssText =
      "display:flex;align-items:center;justify-content:space-between;gap:12px;" +
      "padding:10px 12px;margin-bottom:10px;border-radius:10px;" +
      "background:#17151C;color:#EFECF4;" +
      "font:600 13px/1.3 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;";

    var label = document.createElement("span");
    var rest = posts.length - ranked;
    if (outlierOn) {
      // The median is the whole basis of the score, so state it rather than
      // leaving every badge as an unexplained multiplier.
      label.textContent =
        ranked + (outlierOn === "views" ? " reels" : " posts") +
        " \u00b7 outlier score vs median " + fmt(Math.round(median)) + " " + outlierOn +
        (rest > 0 ? " \u00b7 " + rest + " with none" : "");
    } else if (METRIC_SORTS[sortBy] && rest > 0) {
      // Say plainly that the tail isn't ranked, otherwise the numbered badges
      // imply an ordering the filler posts don't actually have.
      label.textContent =
        posts.length + " posts \u00b7 " + ranked + " ranked by " + sortBy +
        " \u00b7 " + rest + " with none";
    } else {
      label.textContent =
        posts.length + " posts sorted by " + sortBy + " \u00b7 highest first";
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
      if (canTranscribe) tile.appendChild(buildTranscribeButton(p));

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

      grid.appendChild(tile);
    });

    wrap.appendChild(grid);
    return wrap;
  }

  function teardown() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    var wrap = document.getElementById("ig-sorter-wrap");
    if (wrap) wrap.remove();
    var hidden = document.querySelector("[data-ig-sorter-hidden]");
    if (hidden) {
      hidden.style.display = "";
      hidden.removeAttribute("data-ig-sorter-hidden");
    }
  }

  function renderSorted(posts, sortBy, ranked, median) {
    teardown();

    var container = findGridContainer();
    if (!container) {
      tellPopup({ type: "sortError", reason: "no_grid" });
      return false;
    }

    // Hide Instagram's grid rather than destroying it. Replacing innerHTML
    // makes React fight back and can break navigation.
    container.style.display = "none";
    container.setAttribute("data-ig-sorter-hidden", "1");

    var wrap = buildGrid(posts, sortBy, ranked, median);
    container.parentElement.insertBefore(wrap, container);

    // React re-renders can un-hide the original grid. Re-apply if that happens.
    observer = new MutationObserver(function () {
      if (
        container.isConnected &&
        container.getAttribute("data-ig-sorter-hidden") &&
        container.style.display !== "none"
      ) {
        container.style.display = "none";
      }
    });
    observer.observe(container, { attributes: true, attributeFilter: ["style"] });

    return true;
  }

  // ---------------------------------------------------------------
  // 4. Export
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
  // 5. Messages from the page world
  // ---------------------------------------------------------------
  window.addEventListener("message", function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.source !== "ig-sorter") return;

    if (d.type === "progress") {
      tellPopup({ type: "sortProgress", collected: d.collected, target: d.target });
    }

    if (d.type === "healthAlert") {
      try {
        chrome.storage.local.get({ health: [] }, function (o) {
          var list = o.health || [];
          list.unshift({ reason: d.reason, path: d.path, hits: d.hits, ts: d.ts });
          chrome.storage.local.set({ health: list.slice(0, 20) });
        });
      } catch (e) {}
    }

    if (d.type === "result") {
      LAST = d.posts || [];
      var ok = LAST.length ? renderSorted(LAST, d.sortBy, d.ranked, d.median) : false;
      try {
        chrome.storage.local.set({ lastRun: { count: LAST.length, sortBy: d.sortBy, ts: Date.now() } });
      } catch (e) {}
      tellPopup({
        type: "sortDone",
        count: LAST.length,
        ranked: d.ranked,
        median: d.median,
        sortBy: d.sortBy,
        target: d.target,
        total: d.total,
        hits: d.hits,
        rendered: ok
      });
    }
  });

  // ---------------------------------------------------------------
  // 6. Messages from the popup
  // ---------------------------------------------------------------
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg.type === "startSort") {
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

    if (msg.type === "ping") {
      sendResponse({ ok: true, have: LAST.length });
      return true;
    }
    return true;
  });
})();
