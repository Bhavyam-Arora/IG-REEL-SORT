// page/interceptor.js — PAGE world.
// Passively copies JSON responses Instagram fetches for itself.
// It NEVER initiates a request of its own. See Rule 1 in BUILD_SPEC.md.

(function () {
  if (window.__IG_SORTER_HOOKED__) return;
  window.__IG_SORTER_HOOKED__ = true;

  window.__IG_SORTER_BUFFER__ = window.__IG_SORTER_BUFFER__ || [];
  window.__IG_SORTER_PAGEINFO__ = { hasNextPage: true };
  window.__IG_SORTER_HITS__ = 0;

  var INTERESTING = ["/graphql/query", "/api/v1/feed", "/api/v1/clips"];

  // Endpoints that only ever serve other people's posts. Instagram prefetches
  // your home timeline while you browse a profile, and it does so through
  // /api/v1/feed/* — the same prefix we want for profile grids. Skipping these
  // outright is cheaper than filtering their contents later. It is only a first
  // pass: the timeline also arrives over /graphql/query, so the collector still
  // does the authoritative owner check.
  var BORING = [
    "/api/v1/feed/timeline",
    "/api/v1/feed/reels_tray",
    "/api/v1/feed/injected",
    "/api/v1/clips/discover",
    "/api/v1/clips/home"
  ];

  function isInteresting(url) {
    if (!url) return false;
    var u = String(url);
    for (var b = 0; b < BORING.length; b++) {
      if (u.indexOf(BORING[b]) !== -1) return false;
    }
    for (var i = 0; i < INTERESTING.length; i++) {
      if (u.indexOf(INTERESTING[i]) !== -1) return true;
    }
    return false;
  }

  function handleBody(text) {
    if (!text || text.length < 2) return;
    var json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      return; // not JSON, ignore
    }
    if (typeof window.__IG_SORTER_EXTRACT__ !== "function") return;

    try {
      var found = window.__IG_SORTER_EXTRACT__(json);
      if (found.posts.length) {
        window.__IG_SORTER_HITS__++;
        var buf = window.__IG_SORTER_BUFFER__;
        var seen = {};
        for (var i = 0; i < buf.length; i++) seen[buf[i].code] = true;
        var added = 0;
        for (var j = 0; j < found.posts.length; j++) {
          var p = found.posts[j];
          if (p.code && !seen[p.code]) {
            buf.push(p);
            seen[p.code] = true;
            added++;
          }
        }
        if (added) {
          window.dispatchEvent(
            new CustomEvent("ig-sorter-batch", {
              detail: { added: added, total: buf.length }
            })
          );
        }
      }
      if (typeof found.hasNextPage === "boolean") {
        window.__IG_SORTER_PAGEINFO__.hasNextPage = found.hasNextPage;
      }
    } catch (e) {
      console.warn("[GridSorter] extract failed", e);
    }
  }

  // ---- XMLHttpRequest hook ----
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__igSorterUrl = url;
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    this.addEventListener("load", function () {
      try {
        if (!isInteresting(this.__igSorterUrl)) return;
        if (this.responseType !== "" && this.responseType !== "text") return;
        handleBody(this.responseText);
      } catch (e) {}
    });
    return origSend.apply(this, arguments);
  };

  // ---- fetch hook ----
  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : input && input.url;
    return origFetch.apply(this, arguments).then(function (response) {
      try {
        if (isInteresting(url)) {
          // clone() is essential. A response body is a one-time stream; reading
          // the original would hand Instagram an empty body and break the page.
          response
            .clone()
            .text()
            .then(handleBody)
            .catch(function () {});
        }
      } catch (e) {}
      return response;
    });
  };

  console.log("[GridSorter] interceptor armed");
})();
