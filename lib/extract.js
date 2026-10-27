// lib/extract.js — PAGE world.
// Shape-based extraction. Deliberately does NOT depend on Instagram's internal
// field names staying stable. See Rule 3 in BUILD_SPEC.md.

(function () {
  if (window.__IG_SORTER_EXTRACT__) return;

  // Instagram's media "pk" encodes creation time in its upper bits.
  // Reels responses often omit taken_at, so we recover the date from the id.
  var IG_PK_EPOCH_MS = 1314220021721;

  function num(v) {
    return typeof v === "number" && isFinite(v) ? v : null;
  }

  function pkToDate(pk) {
    if (pk === null || pk === undefined || pk === "") return null;
    try {
      var ms = (BigInt(pk) >> 23n) + BigInt(IG_PK_EPOCH_MS);
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
    if (!o || typeof o !== "object") return false;
    if (typeof o.code !== "string" && typeof o.shortcode !== "string") return false;
    return (
      num(o.play_count) !== null ||
      num(o.view_count) !== null ||
      num(o.video_play_count) !== null ||
      num(o.like_count) !== null ||
      num(o.comment_count) !== null ||
      (o.edge_media_preview_like && num(o.edge_media_preview_like.count) !== null) ||
      (o.edge_liked_by && num(o.edge_liked_by.count) !== null)
    );
  }

  // Who posted this. Instagram nests the author differently depending on the
  // surface, so try each known shape. Returns null when the response omits the
  // author entirely — profile-grid payloads often do, because it's implied.
  function ownerOf(o) {
    try {
      if (o.user && typeof o.user.username === "string") return o.user.username;
      if (o.owner && typeof o.owner.username === "string") return o.owner.username;
      if (o.owner && o.owner.user && typeof o.owner.user.username === "string") {
        return o.owner.user.username;
      }
      if (o.caption && o.caption.user && typeof o.caption.user.username === "string") {
        return o.caption.user.username;
      }
    } catch (e) {}
    return null;
  }

  // Collab reels name the other accounts here. The reel shows up on every
  // collaborator's profile, but its user is only the one who posted it.
  function coauthorsOf(o) {
    var list = o.coauthor_producers;
    if (!Array.isArray(list)) return [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && typeof list[i].username === "string") out.push(list[i].username);
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
      var vs = o.video_versions;
      if (Array.isArray(vs) && vs.length) {
        var best = null;
        var bestPx = Infinity;
        for (var i = 0; i < vs.length; i++) {
          if (!vs[i] || typeof vs[i].url !== "string") continue;
          // Renditions missing dimensions sort last rather than winning by
          // scoring zero.
          var px = (num(vs[i].width) || 1e9) * (num(vs[i].height) || 1e9);
          if (px < bestPx) {
            bestPx = px;
            best = vs[i].url;
          }
        }
        if (best) return best;
      }
      if (typeof o.video_url === "string") return o.video_url; // GraphQL shape
    } catch (e) {}
    return null;
  }

  function firstOf() {
    for (var i = 0; i < arguments.length; i++) {
      if (arguments[i] !== null && arguments[i] !== undefined) return arguments[i];
    }
    return null;
  }

  function normalise(o) {
    var code = o.code || o.shortcode || "";
    var pk = o.pk || o.id || null;

    var likes = firstOf(
      num(o.like_count),
      o.edge_media_preview_like ? num(o.edge_media_preview_like.count) : null,
      o.edge_liked_by ? num(o.edge_liked_by.count) : null
    );

    var comments = firstOf(
      num(o.comment_count),
      o.edge_media_to_comment ? num(o.edge_media_to_comment.count) : null,
      o.edge_media_to_parent_comment ? num(o.edge_media_to_parent_comment.count) : null
    );

    var views = firstOf(num(o.play_count), num(o.view_count), num(o.video_play_count));

    var created = null;
    if (num(o.taken_at)) created = new Date(o.taken_at * 1000).toISOString();
    else if (num(o.taken_at_timestamp)) created = new Date(o.taken_at_timestamp * 1000).toISOString();
    else created = pkToDate(pk);

    var thumb = null;
    try {
      thumb =
        (o.image_versions2 &&
          o.image_versions2.candidates &&
          o.image_versions2.candidates[0] &&
          o.image_versions2.candidates[0].url) ||
        o.display_url ||
        o.thumbnail_src ||
        null;
    } catch (e) {}

    var caption = "";
    try {
      caption =
        (o.caption && o.caption.text) ||
        (o.edge_media_to_caption &&
          o.edge_media_to_caption.edges &&
          o.edge_media_to_caption.edges[0] &&
          o.edge_media_to_caption.edges[0].node.text) ||
        "";
    } catch (e) {}

    var isVideo = num(o.media_type) === 2 || o.is_video === true || views !== null;

    return {
      code: code,
      pk: pk ? String(pk) : null,
      owner: ownerOf(o),
      coauthors: coauthorsOf(o),
      url: code ? "https://www.instagram.com/p/" + code + "/" : null,
      views: views,
      likes: likes,
      comments: comments,
      createdAt: created,
      isVideo: isVideo,
      thumbnail: thumb,
      caption: caption,
      videoUrl: videoUrlOf(o),
      durationSec: firstOf(num(o.video_duration), num(o.duration))
    };
  }

  // page is the nearest enclosing connection (a node carrying page_info or
  // more_available). Every post is filed under it, so a caller can tell which
  // "has next page" flag belongs to which list — one response can hold several
  // unrelated lists, and only the one with the posts it cares about matters.
  function walk(node, out, seen, depth, page) {
    if (depth > 12 || node === null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);

    if (looksLikePost(node)) {
      var post = normalise(node);
      out.posts.push(post);
      if (page) page.codes.push(post.code);
      return; // don't descend into a post we already captured
    }

    var more;
    if (node.page_info && typeof node.page_info.has_next_page === "boolean") {
      more = node.page_info.has_next_page;
    }
    if (typeof node.more_available === "boolean") {
      more = node.more_available;
    }
    if (typeof more === "boolean") {
      out.hasNextPage = more;
      page = { hasNextPage: more, codes: [] };
      out.pages.push(page);
    }

    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) walk(node[i], out, seen, depth + 1, page);
    } else {
      for (var k in node) {
        if (Object.prototype.hasOwnProperty.call(node, k)) {
          walk(node[k], out, seen, depth + 1, page);
        }
      }
    }
  }

  window.__IG_SORTER_EXTRACT__ = function (json) {
    var out = { posts: [], hasNextPage: undefined, pages: [] };
    walk(json, out, new WeakSet(), 0, null);

    var byCode = {};
    out.posts = out.posts.filter(function (p) {
      if (!p.code || byCode[p.code]) return false;
      byCode[p.code] = true;
      return true;
    });
    return out;
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
