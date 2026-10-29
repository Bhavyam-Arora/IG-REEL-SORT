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

  // The interceptor only buffers the target's reels, but the buffer outlives
  // in-page navigation, so the owner check is repeated against the reels tab
  // the job was started on.
  function collected(owner) {
    var lib = window.__IG_SORTER_REELS__;
    return (window.__IG_SORTER_BUFFER__ || []).filter(function (p) {
      return lib.isTargetReel(p, owner);
    });
  }

  // An outlier sort measures one metric against the profile's own typical post,
  // so it ranks on exactly the same number as the plain sort of that metric —
  // only the labelling and the badge differ.
  var OUTLIER_FIELD = {
    outlier: "views",
    outlierLikes: "likes",
    outlierComments: "comments"
  };

  var METRICS = {
    views: 1,
    likes: 1,
    comments: 1,
    outlier: 1,
    outlierLikes: 1,
    outlierComments: 1
  };

  function metricField(sortBy) {
    return OUTLIER_FIELD[sortBy] || sortBy;
  }

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
  // "Top 50 by comments" on a profile where only 20 reels were ever commented
  // on should still hand back 50 tiles: the 20 that rank, then the rest as
  // filler. Truncating to the ones that happen to carry the metric silently
  // gives back a shorter grid than was asked for.
  function rankPosts(posts, sortBy, target) {
    var ranked;
    var filler = [];

    if (METRICS[sortBy]) {
      var field = metricField(sortBy);
      ranked = [];
      posts.forEach(function (p) {
        var v = p[field];
        // null means the payload never carried the metric (Instagram hides
        // counts on some reels); 0 means it carried it and the reel has none.
        // Neither can be ranked, so both become filler.
        if (typeof v === "number" && isFinite(v) && v > 0) ranked.push(p);
        else filler.push(p);
      });
      ranked.sort(function (a, b) {
        return b[field] - a[field] || byNewest(a, b);
      });
      filler.sort(byNewest);
    } else {
      ranked = posts.slice().sort(byNewest);
    }

    var out = ranked.concat(filler).slice(0, target);
    // How many of the returned tiles actually carry the metric. Everything
    // past this index is filler and is labelled as such in the grid.
    var rankedCount = Math.min(ranked.length, out.length);
    var med = null;

    var outlierOn = OUTLIER_FIELD[sortBy] || null;
    if (outlierOn) {
      // The baseline is the set the user actually asked for — "top 50 by
      // outlier score" means each post measured against the median of those 50,
      // not against everything that happened to get scrolled past. Filler posts
      // have none of the metric and would drag the median toward zero, so
      // they're out.
      med = median(
        out.slice(0, rankedCount).map(function (p) {
          return p[outlierOn];
        })
      );
      out.forEach(function (p) {
        var v = p[outlierOn];
        p.outlierScore = med && typeof v === "number" && v > 0 ? v / med : null;
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

  // Stop rules. Collection must always end on its own, whatever Instagram
  // does, and always hand back whatever it has by then.
  //  - NO_REELS: responses keep arriving but none hold this profile's reels.
  //    Instagram has changed something; scrolling longer won't help.
  //  - STALL: reels were arriving and then stopped.
  //  - TIME_LIMIT: a backstop for everything else, e.g. nothing arriving at all.
  //  - PAST_RANGE: a Free run (job.days) has scrolled past its date range.
  var NO_REELS_SCROLLS = 10;
  var STALL_SCROLLS = 25;
  var TIME_LIMIT_MS = 3 * 60 * 1000;
  var TIME_LIMIT_ALL_MS = 10 * 60 * 1000;

  // The Reels tab lists newest first, except for up to three pinned reels at
  // the top, which can be any age. So the first old reel may just be a pin;
  // one more old reel than can be pinned means the range is behind us.
  var MAX_PINNED = 3;
  var DAY_MS = 24 * 60 * 60 * 1000;

  async function run(job) {
    var lib = window.__IG_SORTER_REELS__;
    var owner = lib ? lib.reelsTabOwner(location.href) : null;

    // "All reels" has no count to stop at, so collection ends when the profile
    // runs out (hasNextPage false) or a stop rule fires. reported is what the
    // UI sees — Infinity is not JSON, and "of Infinity" would be a nonsense
    // progress line anyway.
    var target = job.limit === "all" ? Infinity : job.limit || 100;
    // A Free run keeps at most job.maxReels, whatever depth was asked for: the
    // popup's Depth menu is not the only thing standing between Free and more.
    if (job.maxReels > 0) target = Math.min(target, job.maxReels);
    var reported = isFinite(target) ? target : null;
    var limitMs = isFinite(target) ? TIME_LIMIT_MS : TIME_LIMIT_ALL_MS;
    var started = Date.now();
    var reason = null;

    // A Free run counts only reels from the last job.days days. A reel whose
    // date can't be read can't be shown to be in range, so it doesn't count.
    var days = job.days > 0 ? job.days : null;
    var since = days ? started - days * DAY_MS : null;
    var inRange = function (p) {
      return since === null || (p.createdAt !== null && p.createdAt !== undefined && ts(p) >= since);
    };

    // The popup only starts a job on a Reels tab, so this is a backstop: never
    // scroll anything else.
    if (!owner) {
      clearJob();
      post("result", {
        posts: [], ranked: 0, median: null, sortBy: job.sortBy, target: reported, days: days,
        total: 0, hits: 0, unreadable: 0, reason: "wrong_page", limitMs: limitMs, elapsedMs: 0
      });
      return;
    }

    var last = 0;
    var stagnant = 0;
    var emptyScrolls = 0;
    var responsesSeen = window.__IG_SORTER_RESPONSES__ || 0;

    for (;;) {
      // Leaving the tab mid-run would have us scrolling some other page.
      if (lib.reelsTabOwner(location.href) !== owner) {
        reason = "navigated";
        break;
      }

      // seen is every reel of this profile's that has arrived; count is the
      // ones the run keeps, which on Pro is all of them.
      var seen = collected(owner);
      var count = seen.filter(inRange).length;
      if (count >= target) {
        reason = "complete";
        break;
      }
      if (seen.length > 0 && window.__IG_SORTER_PAGEINFO__.hasNextPage === false) {
        reason = "end";
        break;
      }
      if (seen.length - count > MAX_PINNED) {
        reason = "past_range";
        break;
      }
      if (Date.now() - started >= limitMs) {
        reason = "timeout";
        break;
      }

      if (seen.length === 0) {
        // Only scrolls during which Instagram actually answered count here; a
        // slow first load is the time limit's business.
        var responses = window.__IG_SORTER_RESPONSES__ || 0;
        if (responses > responsesSeen) emptyScrolls++;
        responsesSeen = responses;
        if (emptyScrolls >= NO_REELS_SCROLLS) {
          reason = "no_reels";
          break;
        }
      } else if (seen.length === last) {
        if (++stagnant >= STALL_SCROLLS) {
          reason = "stalled";
          break;
        }
      } else {
        stagnant = 0;
      }
      last = seen.length;

      // Sent every scroll, not just when the count moves: it doubles as the
      // heartbeat that tells the popup this run is still alive.
      post("progress", {
        collected: count,
        target: reported,
        sortBy: job.sortBy,
        days: days,
        elapsedMs: Date.now() - started,
        limitMs: limitMs
      });

      window.scrollTo(0, document.body.scrollHeight);

      // Human-ish pacing. Do not lower below 600ms — aggressive scrolling is
      // what triggers rate limiting.
      await wait(900);
    }

    var seenAll = collected(owner);
    var all = seenAll.filter(inRange);
    var result = rankPosts(all, job.sortBy, target);

    if (reason !== "navigated") window.scrollTo(0, 0);

    if (seenAll.length === 0) {
      post("healthAlert", {
        reason: "zero_posts_captured",
        stop: reason,
        path: location.pathname,
        hits: window.__IG_SORTER_HITS__ || 0,
        responses: window.__IG_SORTER_RESPONSES__ || 0,
        ts: new Date().toISOString()
      });
    }

    post("result", {
      posts: result.posts,
      ranked: result.ranked,
      median: result.median,
      sortBy: job.sortBy,
      target: reported,
      days: days,
      total: all.length,
      // Including any outside a Free run's range.
      seen: seenAll.length,
      hits: window.__IG_SORTER_HITS__ || 0,
      unreadable: window.__IG_SORTER_UNREADABLE__ || 0,
      reason: reason,
      limitMs: limitMs,
      elapsedMs: Date.now() - started
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
