// lib/extract.js — PAGE world.
// Shape-based extraction. Every Instagram field name comes from the rules
// (lib/rules.js, handed over by content.js); nothing here names one. See Rule 3
// in BUILD_SPEC.md.

(function () {
  if (window.__IG_SORTER_EXTRACT__) return;

  // ---- Rules ----
  // The page never loads lib/rules.js: content.js puts the current copy on
  // this script's element as JSON. Anything missing or malformed in it is
  // filled from this small built-in copy, and the gap is recorded so a sort
  // can say it ran on fallback rules. Same shape as lib/rules.js, fewer aliases
  // (tests check every alias here is also there).
  var BUILT_IN = {
    version: 0,
    responses: {
      hosts: ["instagram.com"],
      pathPrefixes: ["/api/"],
      pathContains: ["graphql"],
      bodyPrefixes: ["for (;;);"],
      maxBodyChars: 5000000
    },
    skipKeys: ["inbox", "thread", "message", "notification"],
    fields: {
      code: ["code"],
      pk: ["pk"],
      owner: ["user.username"],
      coauthors: ["coauthor_producers"],
      coauthorName: ["username"],
      views: ["play_count"],
      likes: ["like_count"],
      comments: ["comment_count"],
      date: ["taken_at"],
      videoDuration: ["video_duration"],
      caption: ["caption.text"],
      thumbnail: ["image_versions2.candidates.0.url"],
      videoVersions: ["video_versions"],
      renditionUrl: ["url"],
      renditionWidth: ["width"],
      renditionHeight: ["height"],
      videoUrl: ["video_url"],
      mediaType: ["media_type"],
      isVideo: ["is_video"],
      productType: ["product_type"]
    },
    videoMediaTypes: [2],
    videoProductTypes: ["clips"],
    pkEpochMs: 1314220021721,
    paging: {
      hasNext: ["page_info.has_next_page", "more_available"],
      reelsListKeys: ["clips"]
    },
    limits: {
      scrollsWithoutReels: 10,
      scrollsWithoutNewReels: 25,
      timeLimitMs: 180000,
      timeLimitAllMs: 600000
    }
  };

  // got, shaped like want: each part of got that has want's type is kept,
  // anything else is want's own. Lists must be non-empty and hold want's item
  // type; numbers must be positive. filled collects the paths that fell back.
  function fit(want, got, path, filled) {
    if (Array.isArray(want)) {
      var t = typeof want[0];
      var ok = Array.isArray(got) && got.length > 0 && got.every(function (x) {
        return typeof x === t && (t !== "number" || isFinite(x));
      });
      if (!ok) filled.push(path);
      return ok ? got.slice() : want.slice();
    }
    if (want && typeof want === "object") {
      if (!got || typeof got !== "object" || Array.isArray(got)) {
        filled.push(path);
        got = {};
      }
      var out = {};
      for (var k in want) {
        if (Object.prototype.hasOwnProperty.call(want, k)) {
          out[k] = fit(want[k], got[k], path ? path + "." + k : k, filled);
        }
      }
      return out;
    }
    if (typeof want === "number") {
      if (typeof got === "number" && isFinite(got) && got > 0) return got;
      filled.push(path);
      return want;
    }
    if (typeof got === typeof want) return got;
    filled.push(path);
    return want;
  }

  function handedOver() {
    try {
      var el = typeof document !== "undefined" && document.currentScript;
      var raw = el && el.getAttribute && el.getAttribute("data-sortcut-rules");
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function resolveRules(got) {
    var info = { source: "content", version: null, warning: null };
    if (!got || typeof got !== "object" || typeof got.version !== "number") {
      info.source = "builtin";
      info.version = BUILT_IN.version;
      info.warning = "No rules were handed over; sorted with the built-in copy.";
      return { rules: fit(BUILT_IN, BUILT_IN, "", []), info: info };
    }
    var filled = [];
    var rules = fit(BUILT_IN, got, "", filled);
    rules.version = got.version;
    info.version = got.version;
    filled = filled.filter(function (p) {
      return p !== "version";
    });
    if (filled.length) info.warning = "Built-in copy used for: " + filled.join(", ");
    return { rules: rules, info: info };
  }

  var resolved = resolveRules(handedOver());
  var R = resolved.rules;
  window.__IG_SORTER_RULES__ = R;
  window.__IG_SORTER_RULES_INFO__ = resolved.info;
  if (resolved.info.warning && resolved.info.source === "content") {
    try {
      console.warn("[GridSorter] rules:", resolved.info.warning);
    } catch (e) {}
  }

  // Paths split once: F.views is a list of ["a", "b"] steps.
  var F = {};
  for (var fk in R.fields) {
    if (Object.prototype.hasOwnProperty.call(R.fields, fk)) {
      F[fk] = R.fields[fk].map(function (p) {
        return p.split(".");
      });
    }
  }
  var HAS_NEXT = R.paging.hasNext.map(function (p) {
    return p.split(".");
  });
  var SKIP = R.skipKeys.map(function (s) {
    return s.toLowerCase();
  });
  var REELS_LIST = R.paging.reelsListKeys.map(function (s) {
    return s.toLowerCase();
  });

  function at(o, steps) {
    for (var i = 0; i < steps.length; i++) {
      if (o === null || typeof o !== "object") return undefined;
      o = o[steps[i]];
    }
    return o;
  }

  function num(v) {
    return typeof v === "number" && isFinite(v) ? v : null;
  }

  // The first alias holding a number / a non-empty string / anything set.
  function firstNum(o, paths) {
    for (var i = 0; i < paths.length; i++) {
      var v = num(at(o, paths[i]));
      if (v !== null) return v;
    }
    return null;
  }

  function firstStr(o, paths) {
    for (var i = 0; i < paths.length; i++) {
      var v = at(o, paths[i]);
      if (typeof v === "string" && v) return v;
    }
    return null;
  }

  function firstSet(o, paths) {
    for (var i = 0; i < paths.length; i++) {
      var v = at(o, paths[i]);
      if (v !== null && v !== undefined && v !== "") return v;
    }
    return null;
  }

  function keyHas(key, words) {
    var k = String(key).toLowerCase();
    for (var i = 0; i < words.length; i++) {
      if (k.indexOf(words[i]) !== -1) return true;
    }
    return false;
  }

  // Instagram's media "pk" encodes creation time in its upper bits.
  // Reels responses often omit taken_at, so we recover the date from the id.
  function pkToDate(pk) {
    if (pk === null || pk === undefined || pk === "") return null;
    try {
      var ms = (BigInt(pk) >> 23n) + BigInt(R.pkEpochMs);
      var d = new Date(Number(ms));
      return isNaN(d.getTime()) ? null : d.toISOString();
    } catch (e) {
      return null;
    }
  }

  // A node counts as a post if it has a shortcode AND at least one engagement
  // number. Matching on structure survives field renames far better than
  // hardcoding an exact path.
  function looksLikePost(o) {
    if (!o || typeof o !== "object" || Array.isArray(o)) return false;
    if (firstStr(o, F.code) === null) return false;
    return firstNum(o, F.views) !== null || firstNum(o, F.likes) !== null || firstNum(o, F.comments) !== null;
  }

  // Who posted this. Returns null when the response omits the author entirely
  // — profile-grid payloads often do, because it's implied.
  function ownerOf(o) {
    return firstStr(o, F.owner);
  }

  // Collab reels name the other accounts here. The reel shows up on every
  // collaborator's profile, but its owner is only the one who posted it.
  function coauthorsOf(o) {
    var out = [];
    for (var i = 0; i < F.coauthors.length; i++) {
      var list = at(o, F.coauthors[i]);
      if (!Array.isArray(list)) continue;
      for (var j = 0; j < list.length; j++) {
        var name = firstStr(list[j], F.coauthorName);
        if (name && out.indexOf(name) === -1) out.push(name);
      }
    }
    return out;
  }

  // The playable MP4. Instagram ships several renditions of the same reel and
  // we deliberately take the SMALLEST: the audio track is identical across all
  // of them, and transcription is the only thing we want the file for. The
  // 1080p rendition is often 5x the bytes for exactly the same words.
  //
  // These URLs are signed and expire in hours, so they are only good within the
  // session that captured them.
  function videoUrlOf(o) {
    try {
      for (var a = 0; a < F.videoVersions.length; a++) {
        var vs = at(o, F.videoVersions[a]);
        if (!Array.isArray(vs) || !vs.length) continue;
        var best = null;
        var bestPx = Infinity;
        for (var i = 0; i < vs.length; i++) {
          var url = firstStr(vs[i], F.renditionUrl);
          if (!url) continue;
          // Renditions missing dimensions sort last rather than winning by
          // scoring zero.
          var px = (firstNum(vs[i], F.renditionWidth) || 1e9) * (firstNum(vs[i], F.renditionHeight) || 1e9);
          if (px < bestPx) {
            bestPx = px;
            best = url;
          }
        }
        if (best) return best;
      }
      return firstStr(o, F.videoUrl);
    } catch (e) {}
    return null;
  }

  function isVideoPost(o, views) {
    if (views !== null) return true;
    if (R.videoMediaTypes.indexOf(firstNum(o, F.mediaType)) !== -1) return true;
    for (var i = 0; i < F.isVideo.length; i++) {
      if (at(o, F.isVideo[i]) === true) return true;
    }
    var product = firstStr(o, F.productType);
    return product !== null && R.videoProductTypes.indexOf(product) !== -1;
  }

  function normalise(o) {
    var code = firstStr(o, F.code) || "";
    var pk = firstSet(o, F.pk);
    var views = firstNum(o, F.views);

    var secs = firstNum(o, F.date);
    var created = secs !== null ? new Date(secs * 1000).toISOString() : pkToDate(pk);

    return {
      code: code,
      pk: pk !== null ? String(pk) : null,
      owner: ownerOf(o),
      coauthors: coauthorsOf(o),
      url: code ? "https://www.instagram.com/p/" + code + "/" : null,
      views: views,
      likes: firstNum(o, F.likes),
      comments: firstNum(o, F.comments),
      createdAt: created,
      isVideo: isVideoPost(o, views),
      thumbnail: firstStr(o, F.thumbnail),
      caption: firstStr(o, F.caption) || "",
      videoUrl: videoUrlOf(o),
      durationSec: firstNum(o, F.videoDuration)
    };
  }

  // page is the nearest enclosing list (a node carrying a "has more" flag).
  // Every post is filed under it, so a caller can tell which flag belongs to
  // which list — one response can hold several unrelated lists, and only the
  // one with the posts it cares about matters. key is the property the node
  // was found under.
  function walk(node, out, seen, depth, page, key) {
    if (depth > 14 || node === null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);

    if (looksLikePost(node)) {
      var post = normalise(node);
      out.posts.push(post);
      if (page) page.codes.push(post.code);
      return; // don't descend into a post we already captured
    }

    // The object a flag was read through (page_info) is part of its list, not
    // a list of its own.
    if (!Array.isArray(node) && !(page && page.holder === node)) {
      for (var h = 0; h < HAS_NEXT.length; h++) {
        var more = at(node, HAS_NEXT[h]);
        if (typeof more === "boolean") {
          out.hasNextPage = more;
          page = { hasNextPage: more, codes: [], key: key || "" };
          Object.defineProperty(page, "holder", { value: at(node, HAS_NEXT[h].slice(0, 1)) });
          out.pages.push(page);
          break;
        }
      }
    }

    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) walk(node[i], out, seen, depth + 1, page, key);
    } else {
      for (var k in node) {
        if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
        // DMs, notifications: never read, whatever they carry.
        if (keyHas(k, SKIP)) continue;
        walk(node[k], out, seen, depth + 1, page, k);
      }
    }
  }

  window.__IG_SORTER_EXTRACT__ = function (json) {
    var out = { posts: [], hasNextPage: undefined, pages: [] };
    walk(json, out, new WeakSet(), 0, null, "");

    var byCode = {};
    out.posts = out.posts.filter(function (p) {
      if (!p.code || byCode[p.code]) return false;
      byCode[p.code] = true;
      return true;
    });
    return out;
  };

  // An empty list that says it has no more, under a key that names reels: the
  // profile has none.
  window.__IG_SORTER_IS_EMPTY_REELS_LIST__ = function (page) {
    return !!page && page.hasNextPage === false && page.codes.length === 0 && keyHas(page.key, REELS_LIST);
  };

  // ---- Which page we're on, and whose reels count ----
  // Shared by the page scripts and the popup (which loads this file too), so
  // the popup's "can I sort here?" and the collector's agree by construction.

  // First path segments that are Instagram's own pages, never a username.
  var RESERVED = {
    p: 1, reel: 1, reels: 1, tv: 1, explore: 1, stories: 1, direct: 1,
    accounts: 1, challenge: 1, your_activity: 1, about: 1, legal: 1,
    developer: 1, emails: 1, web: 1, api: 1, graphql: 1, session: 1,
    settings: 1, notifications: 1, oauth: 1, privacy: 1, terms: 1,
    topics: 1, locations: 1, popular: 1, ar: 1, s: 1
  };
  var USERNAME = /^[A-Za-z0-9._]{1,30}$/;

  // { kind: "reelsTab" | "profileGrid" | "other", owner: lowercased username or null }
  // Only https://www.instagram.com/<username>/reels/ is a reels tab; the query
  // string and hash are ignored.
  function pageKind(url) {
    var other = { kind: "other", owner: null };
    var m = /^https:\/\/www\.instagram\.com(\/[^?#]*)?(?:[?#]|$)/.exec(String(url || ""));
    if (!m) return other;
    var segs = (m[1] || "/").split("/").filter(Boolean);
    var user = segs[0];
    if (!user || !USERNAME.test(user) || RESERVED[user.toLowerCase()]) return other;
    if (segs.length === 1) return { kind: "profileGrid", owner: user.toLowerCase() };
    if (segs.length === 2 && segs[1] === "reels") return { kind: "reelsTab", owner: user.toLowerCase() };
    return other;
  }

  function reelsTabOwner(url) {
    var k = pageKind(url);
    return k.kind === "reelsTab" ? k.owner : null;
  }

  // A reel belongs to a profile when the profile posted it or is credited as a
  // collaborator on it. A post that names nobody can't be attributed, so it
  // doesn't count — Reels-tab pages always carry the author.
  function ownsReel(p, target) {
    if (!p || !target) return false;
    var t = String(target).toLowerCase();
    if (typeof p.owner === "string" && p.owner.toLowerCase() === t) return true;
    var co = p.coauthors || [];
    for (var i = 0; i < co.length; i++) {
      if (String(co[i]).toLowerCase() === t) return true;
    }
    return false;
  }

  function isTargetReel(p, target) {
    return !!p && p.isVideo === true && ownsReel(p, target);
  }

  window.__IG_SORTER_REELS__ = {
    pageKind: pageKind,
    reelsTabOwner: reelsTabOwner,
    ownsReel: ownsReel,
    isTargetReel: isTargetReel
  };
})();
