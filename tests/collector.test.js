// The collector's stop rules: a run always ends, and always hands back what it
// collected. The page's clock is fake (see harness), so long runs are instant.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, result, reel } = require("./harness");

const REELS_TAB = "https://www.instagram.com/demo.creator/reels/";
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
  assert.ok(w.scrolls >= 9 && w.scrolls <= 11, "scrolls: " + w.scrolls);
});

test("no reels, but reels arrived that we couldn't attribute: reported", async () => {
  const { r } = await run({ sortBy: "views", limit: 100 }, (w) => {
    w.__IG_SORTER_RESPONSES__++;
    w.__IG_SORTER_UNREADABLE__ += 4;
  });
  assert.equal(r.reason, "no_reels");
  assert.equal(r.unreadable > 0, true);
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
});

test("leaving the Reels tab mid-run stops it", async () => {
  const { r } = await run({ sortBy: "views", limit: 100 }, (w, n) => {
    w.__IG_SORTER_BUFFER__.push(reel("demo.creator"));
    if (n === 5) w.location.href = "https://www.instagram.com/demo.creator/";
  });
  assert.equal(r.reason, "navigated");
  assert.equal(r.total, 5);
});

test("never scrolls when the job lands off a Reels tab", async () => {
  const w = loadPage("https://www.instagram.com/demo.creator/", {
    job: { sortBy: "views", limit: 25 }
  });
  const r = await result(w);
  assert.equal(r.reason, "wrong_page");
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
