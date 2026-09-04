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

  function walk(node, out, seen, depth) {
    if (depth > 12 || node === null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);

    if (looksLikePost(node)) {
      out.posts.push(normalise(node));
      return; // don't descend into a post we already captured
    }

    if (node.page_info && typeof node.page_info.has_next_page === "boolean") {
      out.hasNextPage = node.page_info.has_next_page;
    }
    if (typeof node.more_available === "boolean") {
      out.hasNextPage = node.more_available;
    }

    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) walk(node[i], out, seen, depth + 1);
    } else {
      for (var k in node) {
        if (Object.prototype.hasOwnProperty.call(node, k)) {
          walk(node[k], out, seen, depth + 1);
        }
      }
    }
  }

  window.__IG_SORTER_EXTRACT__ = function (json) {
    var out = { posts: [], hasNextPage: undefined };
    walk(json, out, new WeakSet(), 0);

    var byCode = {};
    out.posts = out.posts.filter(function (p) {
      if (!p.code || byCode[p.code]) return false;
      byCode[p.code] = true;
      return true;
    });
    return out;
  };
})();
