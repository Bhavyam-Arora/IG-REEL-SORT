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
  var METRIC_SORTS = { views: 1, likes: 1, comments: 1, outlier: 1 };

  // 333.33 reads as 333x; 2.47 reads as 2.5x. Decimals only matter near the
  // baseline, where the difference between 1.2x and 1.8x is the whole story.
  function fmtScore(x) {
    return (x >= 10 ? Math.round(x) : x.toFixed(1)) + "x";
  }

  function buildGrid(posts, sortBy, ranked, median) {
    if (ranked === null || ranked === undefined) ranked = posts.length;
    var isOutlier = sortBy === "outlier";

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
    if (isOutlier) {
      // The median is the whole basis of the score, so state it rather than
      // leaving every badge as an unexplained multiplier.
      label.textContent =
        ranked + " reels \u00b7 outlier score vs median " + fmt(Math.round(median)) + " views" +
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

      // Only above the baseline. A 0.4x badge on a below-median reel is noise —
      // and at exactly 1x the score says nothing the median line doesn't.
      if (isOutlier && p.outlierScore > 1) {
        var score = document.createElement("div");
        score.textContent = fmtScore(p.outlierScore);
        score.title = fmt(p.views) + " views vs median " + fmt(Math.round(median));
        score.style.cssText =
          "position:absolute;top:6px;right:6px;height:20px;display:flex;" +
          "align-items:center;padding:0 7px;border-radius:6px;" +
          "background:#E8A33D;color:#17151C;" +
          "font:700 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;";
        tile.appendChild(score);
      }

      var meta = document.createElement("div");
      meta.style.cssText =
        "position:absolute;left:0;right:0;bottom:0;padding:16px 8px 7px;" +
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
      download(profileSlug() + "-sorted.json", JSON.stringify(LAST, null, 2), "application/json");
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
