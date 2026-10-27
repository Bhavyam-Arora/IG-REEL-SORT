// page/interceptor.js — PAGE world.
// Passively copies JSON responses Instagram fetches for itself.
// It NEVER initiates a request of its own. See Rule 1 in BUILD_SPEC.md.

(function () {
  if (window.__IG_SORTER_HOOKED__) return;
  window.__IG_SORTER_HOOKED__ = true;

  window.__IG_SORTER_BUFFER__ = window.__IG_SORTER_BUFFER__ || [];
  window.__IG_SORTER_PAGEINFO__ = { hasNextPage: true };
  window.__IG_SORTER_HITS__ = 0;
  // Every JSON body from a listened-to endpoint, whether it held reels or not.
  // Lets the collector tell "Instagram is answering but none of it is readable
  // as this profile's reels" apart from "nothing has loaded yet".
  window.__IG_SORTER_RESPONSES__ = 0;
  // Reels that credit nobody: no user, no coauthors. Every reels-tab reel names
  // its author, so these are reels we can see but can't attribute — the sign
  // that Instagram has changed its format, as opposed to a profile with none.
  window.__IG_SORTER_UNREADABLE__ = 0;

  // /api/graphql is where the Reels tab's pages arrive (Oct 2026). It also
  // carries the inbox, highlights, notifications and much else, which is why
  // handleBody keeps only the target profile's reels.
  var INTERESTING = ["/graphql/query", "/api/graphql", "/api/v1/feed", "/api/v1/clips"];

  // Endpoints that only ever serve other people's posts. Instagram prefetches
  // your home timeline while you browse a profile, and it does so through
  // /api/v1/feed/*. Skipping these outright is cheaper than filtering their
  // contents later. It is only a first pass: the timeline also arrives over
  // GraphQL, so handleBody still does the authoritative owner check.
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
    var lib = window.__IG_SORTER_REELS__;
    if (typeof window.__IG_SORTER_EXTRACT__ !== "function" || !lib) return;
    window.__IG_SORTER_RESPONSES__++;

    // Whose reels count is decided per response, from the page it landed on.
    // Off a profile's Reels tab nothing is collected at all.
    var target = lib.reelsTabOwner(location.href);
    if (!target) return;

    try {
      var found = window.__IG_SORTER_EXTRACT__(json);
      var mine = {};
      var reels = found.posts.filter(function (p) {
        var ok = lib.isTargetReel(p, target);
        if (ok) mine[p.code] = true;
        else if (p.isVideo && !p.owner && !(p.coauthors || []).length) {
          window.__IG_SORTER_UNREADABLE__++;
        }
        return ok;
      });
      // A body with none of the target's reels — the inbox, highlights, a
      // suggested-reels rail — says nothing about whether the profile has more,
      // so it must not touch hasNextPage. Their own page_info used to flip it
      // to false and end collection early.
      if (!reels.length) return;

      window.__IG_SORTER_HITS__++;
      var buf = window.__IG_SORTER_BUFFER__;
      var seen = {};
      for (var i = 0; i < buf.length; i++) seen[buf[i].code] = true;
      var added = 0;
      for (var j = 0; j < reels.length; j++) {
        var p = reels[j];
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

      // Same rule one level down: only the list that held the reels speaks for
      // the profile, not some other list sharing the response.
      for (var k = 0; k < found.pages.length; k++) {
        var page = found.pages[k];
        for (var c = 0; c < page.codes.length; c++) {
          if (mine[page.codes[c]]) {
            window.__IG_SORTER_PAGEINFO__.hasNextPage = page.hasNextPage;
            break;
          }
        }
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

  // ---- Developer capture ----
  // Off unless chrome.storage.local.devCapture is true (see README); content.js
  // tells us which. When on, keeps the last few raw GraphQL response bodies in
  // memory so the popup's "Save debug sample" button can download them.
  // Captures BEFORE the INTERESTING filter on purpose, so a filter that's
  // wrong shows up in the sample. Nothing here makes a request or sends data
  // anywhere; it only lives in this tab's memory until the page reloads.
  var devCapture = false;
  var DEBUG_MAX_SAMPLES = 5;
  var DEBUG_MAX_LOG = 40;
  var DEBUG_MAX_BODY = 3000000; // chars per body; a grid page is far smaller
  var debugSamples = [];
  var debugLog = [];

  function debugTap(url, text, meta) {
    try {
      var u = String(url || "");
      var accepted = isInteresting(u);
      var parse = "ok";
      var posts = null;
      try {
        var json = JSON.parse(text);
        if (typeof window.__IG_SORTER_EXTRACT__ === "function") {
          posts = window.__IG_SORTER_EXTRACT__(json).posts.length;
        }
      } catch (e) {
        parse = String(e && e.message).slice(0, 160);
      }
      var row = {
        t: new Date().toISOString(),
        via: meta.via,
        url: u,
        status: meta.status,
        contentType: meta.contentType,
        length: text ? text.length : 0,
        acceptedByFilter: accepted,
        parse: parse,
        postsFound: posts,
        head: text ? text.slice(0, 200) : ""
      };
      debugLog.push(row);
      if (debugLog.length > DEBUG_MAX_LOG) debugLog.shift();

      if (/graphql/i.test(u)) {
        var sample = {};
        for (var k in row) sample[k] = row[k];
        sample.truncated = !!text && text.length > DEBUG_MAX_BODY;
        sample.body = text ? text.slice(0, DEBUG_MAX_BODY) : "";
        debugSamples.push(sample);
        if (debugSamples.length > DEBUG_MAX_SAMPLES) debugSamples.shift();
      }
    } catch (e) {}
  }

  function debugWants(url) {
    if (!devCapture) return false;
    var u = String(url || "");
    return /graphql/i.test(u) || u.indexOf("/api/v1/") !== -1;
  }

  window.addEventListener("message", function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.source !== "ig-sorter-debug") return;
    if (d.type === "devCapture") {
      devCapture = d.on === true;
      if (!devCapture) {
        debugSamples = [];
        debugLog = [];
      }
      return;
    }
    if (d.type !== "debugSampleRequest" || !devCapture) return;
    window.postMessage(
      {
        source: "ig-sorter",
        type: "debugSample",
        sample: {
          page: location.pathname,
          capturedAt: new Date().toISOString(),
          userAgent: navigator.userAgent,
          hits: window.__IG_SORTER_HITS__ || 0,
          responses: window.__IG_SORTER_RESPONSES__ || 0,
          buffered: (window.__IG_SORTER_BUFFER__ || []).length,
          hasNextPage: window.__IG_SORTER_PAGEINFO__.hasNextPage,
          recentRequests: debugLog.slice(),
          graphqlBodies: debugSamples.slice()
        }
      },
      "*"
    );
  });
  // content.js may have read the setting before this script loaded, in which
  // case its message went unheard. Ask again now that someone is listening.
  window.postMessage({ source: "ig-sorter", type: "interceptorReady" }, "*");

  XMLHttpRequest.prototype.send = function () {
    this.addEventListener("load", function () {
      try {
        if (debugWants(this.__igSorterUrl) && (this.responseType === "" || this.responseType === "text")) {
          debugTap(this.__igSorterUrl, this.responseText, {
            via: "xhr",
            status: this.status,
            contentType: this.getResponseHeader("content-type")
          });
        }
      } catch (e) {}
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
        if (debugWants(url)) {
          response
            .clone()
            .text()
            .then(function (t) {
              debugTap(url, t, {
                via: "fetch",
                status: response.status,
                contentType: response.headers.get("content-type")
              });
            })
            .catch(function () {});
        }
      } catch (e) {}
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
