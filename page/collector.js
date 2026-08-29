// page/collector.js — PAGE world.
// Drives collection by scrolling only (Rule 2), then sorts and hands the
// result to the content script via postMessage.

(function () {
  var JOB_KEY = "igSorterJob";

  function readJob() {
    try {
      var raw = sessionStorage.getItem(JOB_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function clearJob() {
    try {
      sessionStorage.removeItem(JOB_KEY);
    } catch (e) {}
  }

  function post(type, payload) {
    var msg = { source: "ig-sorter", type: type };
    for (var k in payload) {
      if (Object.prototype.hasOwnProperty.call(payload, k)) msg[k] = payload[k];
    }
    window.postMessage(msg, "*");
  }

  // Instagram prefetches your home timeline and the suggested-reels rails while
  // you sit on someone's profile, and those responses come down the very same
  // endpoints the interceptor listens to. Without an owner check their posts end
  // up mixed into the profile's grid.
  var NON_PROFILE_SEGMENTS = {
    p: 1,
    reel: 1,
    reels: 1,
    explore: 1,
    stories: 1,
    direct: 1,
    accounts: 1,
    challenge: 1,
    your_activity: 1
  };

  function targetOwner() {
    var seg = location.pathname.replace(/^\/+|\/+$/g, "").split("/")[0];
    if (!seg || NON_PROFILE_SEGMENTS[seg.toLowerCase()]) return null;
    return seg.toLowerCase();
  }

  // Deliberately asymmetric: a post with no owner attached is kept, because
  // profile-grid payloads routinely omit the author. Only posts we can
  // positively attribute to someone else get dropped.
  function ownedByTarget(p, owner) {
    if (!owner || !p.owner) return true;
    return String(p.owner).toLowerCase() === owner;
  }

  function collected(owner) {
    var buf = window.__IG_SORTER_BUFFER__ || [];
    if (!owner) return buf.slice();
    return buf.filter(function (p) {
      return ownedByTarget(p, owner);
    });
  }

  var METRICS = { views: 1, likes: 1, comments: 1, outlier: 1 };

  // Outlier score is views measured against the profile's own typical reel, so
  // it ranks on exactly the same number as a views sort — only the labelling
  // differs.
  var METRIC_FIELD = {
    views: "views",
    likes: "likes",
    comments: "comments",
    outlier: "views"
  };

  // Median, not mean: one 2.5M-view breakout would drag a mean up far enough to
  // flatten its own score. The median stays put and the outlier stands out.
  function median(nums) {
    if (!nums.length) return null;
    var s = nums.slice().sort(function (a, b) {
      return a - b;
    });
    var mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  function ts(p) {
    var t = new Date(p.createdAt || 0).getTime();
    return isNaN(t) ? 0 : t;
  }

  function byNewest(a, b) {
    return ts(b) - ts(a);
  }

  // Ranking a metric splits the profile in two, and both halves matter.
  // "Top 50 by comments" on a profile where only 20 posts were ever commented
  // on should still hand back 50 tiles: the 20 that rank, then the rest as
  // filler. Truncating to the ones that happen to carry the metric silently
  // gives back a shorter grid than was asked for.
  function rankPosts(posts, sortBy, target) {
    var ranked;
    var filler = [];

    if (METRICS[sortBy]) {
      var field = METRIC_FIELD[sortBy];
      ranked = [];
      posts.forEach(function (p) {
        var v = p[field];
        // null means the payload never carried the metric (image posts have no
        // view count); 0 means it carried it and the post has none. Neither can
        // be ranked, so both become filler.
        if (typeof v === "number" && isFinite(v) && v > 0) ranked.push(p);
        else filler.push(p);
      });
      ranked.sort(function (a, b) {
        return b[field] - a[field] || byNewest(a, b);
      });
      filler.sort(byNewest);
    } else if (sortBy === "oldest") {
      ranked = posts.slice().sort(function (a, b) {
        return ts(a) - ts(b);
      });
    } else {
      ranked = posts.slice().sort(byNewest);
    }

    var out = ranked.concat(filler).slice(0, target);
    // How many of the returned tiles actually carry the metric. Everything
    // past this index is filler and is labelled as such in the grid.
    var rankedCount = Math.min(ranked.length, out.length);
    var med = null;

    if (sortBy === "outlier") {
      // The baseline is the set the user actually asked for — "top 50 by
      // outlier score" means each reel measured against the median of those 50,
      // not against everything that happened to get scrolled past. Filler posts
      // have no views and would drag the median toward zero, so they're out.
      med = median(
        out.slice(0, rankedCount).map(function (p) {
          return p.views;
        })
      );
      out.forEach(function (p) {
        p.outlierScore =
          med && typeof p.views === "number" && p.views > 0 ? p.views / med : null;
      });
    }

    return {
      posts: out,
      ranked: rankedCount,
      median: med
    };
  }

  function wait(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  async function run(job) {
    var target = job.limit || 100;
    var maxScrolls = 400;
    var STALL_LIMIT = 14;
    var scrolls = 0;
    var stagnant = 0;
    var last = 0;
    var lastHeight = 0;
    var owner = targetOwner();

    post("progress", { collected: 0, target: target });

    while (scrolls < maxScrolls) {
      // Count only this profile's posts, so foreign ones can neither satisfy the
      // target early nor keep resetting the stall counter.
      var count = collected(owner).length;

      if (count >= target) break;
      if (window.__IG_SORTER_PAGEINFO__.hasNextPage === false && count > 0) break;

      // Stall detection. Posts arriving is the strong signal, but the page
      // growing taller means Instagram is still feeding us and the next batch
      // just hasn't landed — so a stall only counts when neither moved. Giving
      // up on the count alone cuts collection short on slow responses and is
      // what leaves the grid short of the requested depth.
      var height = document.body.scrollHeight;
      if (count === last && height === lastHeight) {
        stagnant++;
        if (stagnant >= STALL_LIMIT) break;
      } else {
        if (count !== last) post("progress", { collected: count, target: target });
        stagnant = 0;
      }
      last = count;
      lastHeight = height;

      window.scrollTo(0, document.body.scrollHeight);
      scrolls++;

      // Human-ish pacing. Do not lower below 600ms — aggressive scrolling is
      // what triggers rate limiting.
      await wait(900);
    }

    var all = collected(owner);
    var result = rankPosts(all, job.sortBy, target);

    window.scrollTo(0, 0);

    if (all.length === 0) {
      post("healthAlert", {
        reason: "zero_posts_captured",
        path: location.pathname,
        hits: window.__IG_SORTER_HITS__ || 0,
        ts: new Date().toISOString()
      });
    }

    post("result", {
      posts: result.posts,
      ranked: result.ranked,
      median: result.median,
      sortBy: job.sortBy,
      target: target,
      total: all.length,
      hits: window.__IG_SORTER_HITS__ || 0
    });
    clearJob();
  }

  var job = readJob();
  if (job) {
    // Let Instagram render its first page before we start scrolling.
    setTimeout(function () {
      run(job);
    }, 2500);
  }
})();
