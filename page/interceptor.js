// page/interceptor.js — PAGE world.
// Passively copies JSON responses Instagram fetches for itself.
// It NEVER initiates a request of its own. See Rule 1 in BUILD_SPEC.md.
//
// Which responses are read, and how their bodies are unwrapped, comes from the
// rules lib/extract.js resolved (window.__IG_SORTER_RULES__).

(function () {
  if (window.__IG_SORTER_HOOKED__) return;
  window.__IG_SORTER_HOOKED__ = true;

  window.__IG_SORTER_BUFFER__ = window.__IG_SORTER_BUFFER__ || [];
  window.__IG_SORTER_PAGEINFO__ = { hasNextPage: true };
  window.__IG_SORTER_HITS__ = 0;
  // Every JSON body read, whether it held reels or not. Lets the collector
  // tell "Instagram is answering but none of it is readable as this profile's
  // reels" apart from "nothing has loaded yet".
  window.__IG_SORTER_RESPONSES__ = 0;
  // Reels that credit nobody: no user, no coauthors. Every reels-tab reel names
  // its author, so these are reels we can see but can't attribute — the sign
  // that Instagram has changed its format, as opposed to a profile with none.
  window.__IG_SORTER_UNREADABLE__ = 0;
  // Counts only, never which reels or whose: they tell a failed sort's causes
  // apart. reels: every reel seen, anyone's. foreign: reels credited to other
  // accounts, dropped on the spot. duplicates: the profile's reels sent again
  // after they were already kept. emptyReelsLists: finished, empty reels
  // lists. tooLarge / unparsable: bodies skipped unread.
  window.__IG_SORTER_STATS__ = {
    reels: 0, foreign: 0, duplicates: 0, emptyReelsLists: 0, tooLarge: 0, unparsable: 0
  };
  var stats = window.__IG_SORTER_STATS__;

  function rules() {
    return window.__IG_SORTER_RULES__ || null;
  }

  function lower(list) {
    return list.map(function (s) {
      return String(s).toLowerCase();
    });
  }

  function parseUrl(url) {
    try {
      return new URL(String(url), location.href);
    } catch (e) {
      return null;
    }
  }

  function onInstagram(u) {
    var r = rules();
    if (!r || !u) return false;
    var host = u.hostname.toLowerCase();
    return lower(r.responses.hosts).some(function (h) {
      return host === h || host.slice(-(h.length + 1)) === "." + h;
    });
  }

  // Every JSON response on Instagram under one of the rules' paths, not a fixed
  // list of endpoints: Instagram moves its data between addresses on its own,
  // and a missed address fails silently. What's kept is decided by content.
  function shouldInspect(url) {
    var r = rules();
    var u = url ? parseUrl(url) : null;
    if (!r || !u || !onInstagram(u)) return false;
    var p = u.pathname.toLowerCase();
    return (
      lower(r.responses.pathPrefixes).some(function (x) {
        return p.indexOf(x) === 0;
      }) ||
      lower(r.responses.pathContains).some(function (x) {
        return p.indexOf(x) !== -1;
      })
    );
  }

  // ---- Body unwrapping ----
  // A body may start with anti-hijacking junk ("for (;;);"), and a streamed
  // GraphQL response holds several JSON objects one after another. Returns
  // every JSON value found; none means the body isn't JSON.
  function stripPrefixes(s) {
    var prefixes = rules().responses.bodyPrefixes;
    for (var changed = true; changed; ) {
      changed = false;
      s = s.replace(/^\s+/, "");
      for (var i = 0; i < prefixes.length; i++) {
        if (s.indexOf(prefixes[i]) === 0) {
          s = s.slice(prefixes[i].length);
          changed = true;
        }
      }
    }
    return s;
  }

  // Top-level JSON objects/arrays back to back, by bracket depth (strings
  // respected). Anything between them is skipped.
  function splitValues(s) {
    var out = [];
    var depth = 0;
    var inStr = false;
    var esc = false;
    var start = -1;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (inStr) {
        if (esc) esc = false;
        else if (c === 92) esc = true; // backslash
        else if (c === 34) inStr = false; // quote
        continue;
      }
      if (c === 34) {
        if (depth > 0) inStr = true;
      } else if (c === 123 || c === 91) {
        if (depth === 0) start = i;
        depth++;
      } else if ((c === 125 || c === 93) && depth > 0) {
        if (--depth === 0) out.push(s.slice(start, i + 1));
      }
    }
    return out;
  }

  function jsonValues(text) {
    var s = stripPrefixes(String(text));
    var c = s.charAt(0);
    if (c !== "{" && c !== "[") return [];
    try {
      return [JSON.parse(s)];
    } catch (e) {}
    var out = [];
    var parts = splitValues(s);
    for (var i = 0; i < parts.length; i++) {
      try {
        out.push(JSON.parse(parts[i]));
      } catch (e) {}
    }
    return out;
  }

  function handleBody(text) {
    var r = rules();
    if (!r || typeof text !== "string" || text.length < 2) return;
    if (text.length > r.responses.maxBodyChars) {
      stats.tooLarge++;
      return;
    }
    var values = jsonValues(text);
    if (!values.length) {
      stats.unparsable++;
      return;
    }
    handleValues(values);
  }

  function handleValues(values) {
    var lib = window.__IG_SORTER_REELS__;
    if (typeof window.__IG_SORTER_EXTRACT__ !== "function" || !lib) return;
    window.__IG_SORTER_RESPONSES__++;

    // Whose reels count is decided per response, from the page it landed on.
    // Off a profile's Reels tab nothing is collected at all.
    var target = lib.reelsTabOwner(location.href);
    if (!target) return;

    try {
      var found = window.__IG_SORTER_EXTRACT__(values.length === 1 ? values[0] : values);

      // The post-finder decides. Anything that isn't the target's reel is
      // counted and dropped here: never buffered, never logged.
      var mine = {};
      var reels = [];
      for (var i = 0; i < found.posts.length; i++) {
        var p = found.posts[i];
        if (!p.isVideo) continue; // photos aren't reels
        stats.reels++;
        if (lib.isTargetReel(p, target)) {
          mine[p.code] = true;
          reels.push(p);
        } else if (!p.owner && !(p.coauthors || []).length) {
          window.__IG_SORTER_UNREADABLE__++;
        } else {
          stats.foreign++;
        }
      }

      for (var e = 0; e < found.pages.length; e++) {
        if (window.__IG_SORTER_IS_EMPTY_REELS_LIST__(found.pages[e])) stats.emptyReelsLists++;
      }

      // A body with none of the target's reels — the inbox, highlights, a
      // suggested-reels rail — says nothing about whether the profile has more,
      // so it must not touch hasNextPage. Their own page_info used to flip it
      // to false and end collection early.
      if (!reels.length) return;

      window.__IG_SORTER_HITS__++;
      var buf = window.__IG_SORTER_BUFFER__;
      var seen = {};
      for (var b = 0; b < buf.length; b++) seen[buf[b].code] = true;
      var added = 0;
      for (var j = 0; j < reels.length; j++) {
        if (reels[j].code && !seen[reels[j].code]) {
          buf.push(reels[j]);
          seen[reels[j].code] = true;
          added++;
        } else {
          stats.duplicates++;
        }
      }
      if (added) {
        window.dispatchEvent(
          new CustomEvent("ig-sorter-batch", {
            detail: { added: added, total: buf.length }
          })
        );
      }

      // Same rule one level down: only a list made up mostly of the target's
      // reels speaks for the profile. A timeline or rail that happens to hold
      // one of them doesn't.
      for (var k = 0; k < found.pages.length; k++) {
        var page = found.pages[k];
        var ours = 0;
        for (var c = 0; c < page.codes.length; c++) {
          if (mine[page.codes[c]]) ours++;
        }
        if (ours && ours * 2 >= page.codes.length) {
          window.__IG_SORTER_PAGEINFO__.hasNextPage = page.hasNextPage;
        }
      }
    } catch (err) {
      console.warn("[GridSorter] extract failed", err);
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
  // tells us which. When on, keeps the last few raw response bodies in memory
  // so the popup's "Save debug sample" button can download them. Logs every
  // Instagram request, not just the inspected ones, so a filter that's wrong
  // shows up in the sample. Nothing here makes a request or sends data
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
      var accepted = shouldInspect(u);
      var parse = "ok";
      var posts = null;
      try {
        var values = jsonValues(text);
        if (!values.length) throw new Error("not JSON");
        if (typeof window.__IG_SORTER_EXTRACT__ === "function") {
          posts = window.__IG_SORTER_EXTRACT__(values.length === 1 ? values[0] : values).posts.length;
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

      if (accepted) {
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
    if (!devCapture || !url) return false;
    return onInstagram(parseUrl(url));
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
        if (!shouldInspect(this.__igSorterUrl)) return;
        if (this.responseType === "" || this.responseType === "text") handleBody(this.responseText);
        else if (this.responseType === "json" && this.response && typeof this.response === "object") {
          handleValues([this.response]);
        }
      } catch (e) {}
    });
    return origSend.apply(this, arguments);
  };

  // ---- fetch hook ----
  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    // A string, a URL object or a Request.
    var url = typeof input === "string" ? input : input && (input.url || input.href);
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
        if (shouldInspect(url)) {
          // Too big to be a page of reels: skipped without reading it.
          var declared = Number(response.headers && response.headers.get("content-length"));
          if (declared > rules().responses.maxBodyChars) {
            stats.tooLarge++;
            return response;
          }
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
