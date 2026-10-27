// The same checks against real debug samples. Those files are gitignored and
// only exist on a developer's machine; without them these tests are skipped.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, respond, fixture, bodies } = require("./harness");

const SKIP = "skipped: real sample not present";
const reelsTab = fixture("reels-tab-api-graphql-2026-10.json");
const grid = fixture("profile-grid-api-graphql-2026-10.json");

// The profile is read from the sample, so no real account is named here.
const profileOf = (sample) => sample.page.split("/").filter(Boolean)[0].toLowerCase();

test("real Reels-tab sample: 20 reels, all with views", { skip: !reelsTab && SKIP }, async () => {
  const owner = profileOf(reelsTab);
  const w = loadPage("https://www.instagram.com/" + owner + "/reels/");
  for (const b of bodies(reelsTab)) await respond(w, b.url, b.text);

  const buf = w.__IG_SORTER_BUFFER__;
  assert.equal(buf.length, 20);
  assert.ok(buf.every((p) => p.isVideo && p.views > 0), "every reel has views");
  assert.equal(w.__IG_SORTER_PAGEINFO__.hasNextPage, true);
});

test("real profile-grid sample: the 2 collab reels are kept", { skip: !grid && SKIP }, () => {
  const owner = profileOf(grid);
  const w = loadPage("https://www.instagram.com/" + owner + "/reels/");
  const { isTargetReel } = w.__IG_SORTER_REELS__;

  const posts = new Map();
  for (const b of bodies(grid)) {
    for (const p of w.__IG_SORTER_EXTRACT__(b.json).posts) posts.set(p.code, p);
  }
  const all = [...posts.values()];
  const collabs = all.filter(
    (p) => p.owner.toLowerCase() !== owner && p.coauthors.some((c) => c.toLowerCase() === owner)
  );
  assert.equal(collabs.length, 2);
  assert.ok(collabs.every((p) => isTargetReel(p, owner)), "collab reels kept");
  assert.equal(all.filter((p) => isTargetReel(p, owner)).length, all.length);
});

test("real profile-grid sample: nothing collected on the main grid", { skip: !grid && SKIP }, async () => {
  const w = loadPage("https://www.instagram.com/" + profileOf(grid) + "/");
  for (const b of bodies(grid)) await respond(w, b.url, b.text);
  assert.equal(w.__IG_SORTER_BUFFER__.length, 0);
});
