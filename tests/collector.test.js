// The collector's stop rules: a run always ends, and always hands back what it
// collected. The page's clock is fake (see harness), so long runs are instant.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, result, reel, fixture, bodies } = require("./harness");

const REELS_TAB = "https://www.instagram.com/demo.creator/reels/";
const codes = (r) => JSON.parse(JSON.stringify(r.codes));
const MIN = 60 * 1000;

function run(job, onScroll, setup) {
  const w = loadPage(REELS_TAB, { job, onScroll });
  if (setup) setup(w);
  return result(w).then((r) => ({ w, r }));
}

test("reaches the requested depth", async () => {
  const { r } = await run({ sortBy: "views", limit: 25 }, (w) => {
    for (let i = 0; i < 4; i++) w.__IG_SORTER_BUFFER__.push(reel("demo.creator"));
  });
  assert.equal(r.reason, "complete");
  assert.equal(r.posts.length, 25);
  assert.equal(r.ranked, 25);
  // Highest views first.
  assert.ok(r.posts[0].views >= r.posts[24].views);
});

test("stops at the end of the profile's reels", async () => {
  const { r } = await run({ sortBy: "likes", limit: 100 }, (w, n) => {
    for (let i = 0; i < 4; i++) w.__IG_SORTER_BUFFER__.push(reel("demo.creator"));
    if (n === 3) w.__IG_SORTER_PAGEINFO__.hasNextPage = false;
  });
  assert.equal(r.reason, "end");
  assert.equal(r.total, 12);
});

test("responses arriving but no target reels: stops after ~10 scrolls", async () => {
  const { w, r } = await run({ sortBy: "views", limit: 100 }, (w) => {
    w.__IG_SORTER_RESPONSES__++;
    // Someone else's reels don't count.
    w.__IG_SORTER_BUFFER__.push(reel("other.studio"));
  });
  assert.equal(r.reason, "no_reels");
  assert.equal(r.posts.length, 0);
  assert.equal(r.unreadable, 0, "a profile with no reels, as far as we can tell");
  assert.deepEqual(codes(r), ["responses_but_no_reels"]);
  assert.ok(w.scrolls >= 9 && w.scrolls <= 11, "scrolls: " + w.scrolls);
});

test("no reels, but reels arrived that we couldn't attribute: reported", async () => {
  const { r } = await run({ sortBy: "views", limit: 100 }, (w) => {
    w.__IG_SORTER_RESPONSES__++;
    w.__IG_SORTER_UNREADABLE__ += 4;
  });
  assert.equal(r.reason, "no_reels");
  assert.equal(r.unreadable > 0, true);
  assert.deepEqual(codes(r), ["reels_but_none_from_profile"]);
});

test("reels stop arriving: stops after ~25 scrolls with what it has", async () => {
  const { w, r } = await run(
    { sortBy: "views", limit: 100 },
    (w, n) => {
      w.__IG_SORTER_RESPONSES__++;
      if (n <= 2) for (let i = 0; i < 4; i++) w.__IG_SORTER_BUFFER__.push(reel("demo.creator"));
    }
  );
  assert.equal(r.reason, "stalled");
  assert.equal(r.posts.length, 8);
  assert.deepEqual(codes(r), [], "a stall is just the end of what Instagram sends");
  assert.ok(w.scrolls >= 26 && w.scrolls <= 28, "scrolls: " + w.scrolls);
});

test("fixed depth: 3-minute limit, returns what it collected", async () => {
  // A trickle that never stalls and never reaches the target.
  const { w, r } = await run({ sortBy: "comments", limit: 1000 }, (w) => {
    w.__IG_SORTER_BUFFER__.push(reel("demo.creator"));
  });
  assert.equal(r.reason, "timeout");
  assert.equal(r.limitMs, 3 * MIN);
  assert.ok(r.elapsedMs >= 3 * MIN && r.elapsedMs < 3 * MIN + 2000);
  assert.ok(r.posts.length > 100);
  assert.equal(r.posts.length, w.__IG_SORTER_BUFFER__.length);
  assert.deepEqual(codes(r), ["stopped_time_limit"]);
});

test("All reels: 10-minute limit", async () => {
  const { r } = await run({ sortBy: "views", limit: "all" }, (w) => {
    w.__IG_SORTER_BUFFER__.push(reel("demo.creator"));
  });
  assert.equal(r.reason, "timeout");
  assert.equal(r.target, null);
  assert.equal(r.limitMs, 10 * MIN);
  assert.ok(r.elapsedMs >= 10 * MIN && r.elapsedMs < 10 * MIN + 2000);
});

test("nothing arriving at all still ends, at the time limit", async () => {
  const { r } = await run({ sortBy: "views", limit: 50 }, () => {});
  assert.equal(r.reason, "timeout");
  assert.equal(r.posts.length, 0);
  assert.deepEqual(codes(r), ["no_responses"]);
});

test("leaving the Reels tab mid-run stops it", async () => {
  const { r } = await run({ sortBy: "views", limit: 100 }, (w, n) => {
    w.__IG_SORTER_BUFFER__.push(reel("demo.creator"));
    if (n === 5) w.location.href = "https://www.instagram.com/demo.creator/";
  });
  assert.equal(r.reason, "navigated");
  assert.equal(r.total, 5);
  assert.deepEqual(codes(r), []);
});

test("never scrolls when the job lands off a Reels tab", async () => {
  const w = loadPage("https://www.instagram.com/demo.creator/", {
    job: { sortBy: "views", limit: 25 }
  });
  const r = await result(w);
  assert.equal(r.reason, "wrong_page");
  assert.deepEqual(codes(r), ["wrong_page"]);
  assert.equal(w.scrolls, 0);
});

test("reels missing the metric are counted, not silently ranked", async () => {
  const { r } = await run({ sortBy: "views", limit: 10 }, (w) => {
    for (let i = 0; i < 5; i++) {
      // Instagram hides the view count on most of these.
      w.__IG_SORTER_BUFFER__.push(reel("demo.creator", i === 0 ? {} : { views: null }));
    }
  });
  assert.equal(r.posts.length, 10);
  assert.equal(r.ranked, 2, "only the reels with views are ranked");
});

// ---- Free: up to 50 reels, of any age ----

const DAY = 24 * 60 * MIN;
// A reel `days` old by the page's clock when the run started.
const aged = (w, days) => reel("demo.creator", { createdAt: new Date(w.started - days * DAY).toISOString() });

// A Reels tab as Instagram serves it: three old pinned reels on top, then
// newest first. Each scroll brings the next `per` reels of `feed`.
function reelsTab(feed, per) {
  return (w, n) => {
    if (!w.started) return;
    const page = feed(w).slice((n - 1) * per, n * per);
    page.forEach((r) => w.__IG_SORTER_BUFFER__.push(r));
    if (n * per >= feed(w).length) w.__IG_SORTER_PAGEINFO__.hasNextPage = false;
  };
}

// Pinned reels a year old, a few recent ones, then years more: 133 in all.
function oldProfile(w) {
  if (!w.feed) {
    w.feed = [aged(w, 400), aged(w, 300), aged(w, 200)];
    for (let d = 1; d <= 49; d += 4) w.feed.push(aged(w, d)); // 13 recent
    for (let d = 51; d <= 400; d += 3) w.feed.push(aged(w, d)); // and years more
  }
  return w.feed;
}

const runOn = (job) =>
  run(job, reelsTab(oldProfile, 4), (w) => {
    // When the run starts: the collector's 2.5s wait is already on the fake
    // clock, which advances when a timer is set.
    w.started = w.clock.now;
  });

test("Free: 50 reels of any age, old and pinned ones included, no early stop", async () => {
  const { w, r } = await runOn({ sortBy: "views", limit: 50, maxReels: 50 });
  assert.equal(r.reason, "complete");
  assert.equal(r.posts.length, 50);
  const cutoff = w.started - 50 * DAY;
  assert.ok(r.posts.filter((p) => Date.parse(p.createdAt) < cutoff).length > 30, "older reels count like any other");
  assert.equal(r.days, undefined, "no date range anywhere in the result");
  assert.deepEqual(codes(r), []);
});

test("Free: never more than maxReels, whatever depth is asked for", async () => {
  for (const limit of [300, "all"]) {
    const { r } = await run({ sortBy: "views", limit, maxReels: 50 }, (w) => {
      for (let i = 0; i < 4; i++) w.__IG_SORTER_BUFFER__.push(reel("demo.creator"));
    });
    assert.equal(r.reason, "complete", String(limit));
    assert.equal(r.posts.length, 50, String(limit));
    assert.equal(r.target, 50, "progress reads 'of 50'");
  }
});

test("Free: a profile with fewer reels than the cap gets all of them", async () => {
  const { r } = await run({ sortBy: "likes", limit: 50, maxReels: 50 }, (w, n) => {
    for (let i = 0; i < 4; i++) w.__IG_SORTER_BUFFER__.push(reel("demo.creator", { createdAt: "2023-01-01T00:00:00Z" }));
    if (n === 3) w.__IG_SORTER_PAGEINFO__.hasNextPage = false;
  });
  assert.equal(r.reason, "end");
  assert.equal(r.posts.length, 12);
});

test("a reel whose date can't be read is still counted and sorted", async () => {
  const { r } = await run({ sortBy: "views", limit: 100 }, (w, n) => {
    if (n === 1) {
      w.__IG_SORTER_BUFFER__.push(reel("demo.creator", { createdAt: null }));
      w.__IG_SORTER_BUFFER__.push(reel("demo.creator"));
      w.__IG_SORTER_PAGEINFO__.hasNextPage = false;
    }
  });
  assert.equal(r.reason, "end");
  assert.equal(r.posts.length, 2);
});

test("Pro: the same profile sorts its full history", async () => {
  const { w, r } = await runOn({ sortBy: "views", limit: "all" });
  assert.equal(r.reason, "end");
  assert.equal(r.posts.length, oldProfile(w).length);
});

// ---- Partial results: a metric Instagram isn't sending ----

test("most reels without the chosen metric: still sorted, all handed back, and said why", async () => {
  for (const sortBy of ["views", "outlier"]) {
    const { r } = await run({ sortBy, limit: 100 }, (w, n) => {
      for (let i = 0; i < 4; i++) w.__IG_SORTER_BUFFER__.push(reel("demo.creator", { views: i === 0 ? 5000 : null }));
      if (n === 3) w.__IG_SORTER_PAGEINFO__.hasNextPage = false;
    });
    assert.equal(r.reason, "end", sortBy);
    assert.equal(r.posts.length, 12, sortBy + ": every reel");
    assert.equal(r.ranked, 3, sortBy + ": the three with views rank first");
    assert.deepEqual(codes(r), ["reels_missing_metric"], sortBy);
    assert.equal(r.missingMetric, "views");
    assert.deepEqual(JSON.parse(JSON.stringify(r.alternatives)), ["likes", "comments"]);
  }
});

test("a metric on most reels, or a date sort, is not flagged", async () => {
  for (const [sortBy, views] of [["views", (i) => (i === 0 ? null : 10)], ["date", () => null]]) {
    const { r } = await run({ sortBy, limit: 100 }, (w, n) => {
      for (let i = 0; i < 4; i++) w.__IG_SORTER_BUFFER__.push(reel("demo.creator", { views: views(i) }));
      if (n === 2) w.__IG_SORTER_PAGEINFO__.hasNextPage = false;
    });
    assert.deepEqual(codes(r), [], sortBy);
  }
});

test("the metric missing and nothing else either: flagged with nothing to suggest", async () => {
  const { r } = await run({ sortBy: "likes", limit: 100 }, (w) => {
    for (let i = 0; i < 4; i++) w.__IG_SORTER_BUFFER__.push(reel("demo.creator", { views: null, likes: null, comments: null }));
    w.__IG_SORTER_PAGEINFO__.hasNextPage = false;
  });
  assert.equal(r.posts.length, 4);
  assert.deepEqual(codes(r), ["reels_missing_metric"]);
  assert.deepEqual(JSON.parse(JSON.stringify(r.alternatives)), []);
});

// ---- Regression: a 39-reel profile sorted only 25 (Pro, Depth 50 and 100) ----

test("39 reels in pages of 12, the first with the page load: all 39 at Depth 50 and 100", async () => {
  const pages = bodies(fixture("synthetic-39-reels.json"));
  for (const limit of [50, 100]) {
    let next = 1;
    const w = loadPage(REELS_TAB, {
      job: { sortBy: "views", limit },
      onScroll: (w) => {
        const p = pages[next++];
        if (p) w.fetch(p.url, { body: p.text });
      }
    });
    // Instagram's own first request, answered before the collector's first scroll.
    w.fetch(pages[0].url, { body: pages[0].text });
    const r = await result(w);
    assert.equal(r.posts.length, 39, "Depth " + limit);
    assert.equal(r.ranked, 39);
    assert.equal(r.reason, "end", "the last page says there is no more");
    assert.deepEqual(codes(r), []);
  }
});

test("the result says the depth and plan it was asked on, and posts no separate health alert", async () => {
  const { w, r } = await run({ sortBy: "views", limit: 50, maxReels: 50, plan: "free" }, () => {});
  assert.equal(r.depth, 50);
  assert.equal(r.plan, "free");
  assert.equal(w.messages.filter((m) => m.type === "healthAlert").length, 0);
});
