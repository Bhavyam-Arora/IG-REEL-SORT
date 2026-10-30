// Every fixture in tests/fixtures runs through the whole pipeline — address
// filter → body unwrapping → extraction → ownership → paging, and optionally a
// full sort — and must match its expected-results file.
//
// Adding a sample (synthetic, or a real debug sample from "Save debug sample")
// needs nothing here: drop NAME.json in tests/fixtures next to a
// NAME.expected.json. Real samples are gitignored, expected files with them;
// a sample without an expected file fails.
//
// NAME.expected.json:
//   { "runs": [ {
//       "page": "/{owner}/reels/",   // {owner}: the sample's own profile
//       "reels": 4,                  // reels kept (buffered)
//       "reelCodes": ["..."],        // optional: exactly these, in any order
//       "collabs": 1,                // optional: kept reels the profile is only a collaborator on
//       "with": { "views": 4, "likes": 4, "comments": 4, "date": 4 }, // optional: kept reels carrying each
//       "hasNextPage": true,         // the "more to load" flag afterwards
//       "hits": 1, "responses": 1, "unreadable": 0,                  // optional counters
//       "stats": { "foreign": 0, "emptyReelsLists": 0, ... },       // optional, see interceptor.js
//       "sort": { "sortBy": "views", "limit": 50,                   // optional: the collector, fed one body per scroll
//                 "codes": [], "ranked": 4, "first": "..." }
//   } ] }
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { loadPage, respond, result, bodies, FIXTURES } = require("./harness");

const EXPECTED = ".expected.json";
const samples = fs
  .readdirSync(FIXTURES)
  .filter((f) => f.endsWith(".json") && !f.endsWith(EXPECTED))
  .sort();

const read = (f) => JSON.parse(fs.readFileSync(path.join(FIXTURES, f), "utf8"));
const count = (list, f) => list.filter(f).length;
// Values from the vm have its prototypes; compare as plain JSON.
const plain = (x) => JSON.parse(JSON.stringify(x));

async function feed(sample, run) {
  const owner = sample.page.split("/").filter(Boolean)[0].toLowerCase();
  const href = "https://www.instagram.com" + run.page.replace("{owner}", owner);
  const w = loadPage(href);
  for (const b of bodies(sample)) await respond(w, b.url, b.text);
  return { w, owner, href };
}

async function sortRun(sample, href, sort) {
  const list = bodies(sample);
  const w = loadPage(href, {
    job: { sortBy: sort.sortBy, limit: sort.limit || 50 },
    onScroll: (w, n) => {
      const b = list[n - 1];
      if (b) w.fetch(b.url, { body: b.text });
    }
  });
  return result(w);
}

test("every fixture has an expected-results file", () => {
  const missing = samples.filter((f) => !fs.existsSync(path.join(FIXTURES, f.replace(/\.json$/, EXPECTED))));
  assert.deepEqual(missing, [], "add " + missing.map((f) => f.replace(/\.json$/, EXPECTED)).join(", "));
});

for (const file of samples) {
  const expectedFile = file.replace(/\.json$/, EXPECTED);
  if (!fs.existsSync(path.join(FIXTURES, expectedFile))) continue; // reported above
  const sample = read(file);
  const { runs } = read(expectedFile);

  for (const run of runs) {
    test(file + " on " + run.page, async () => {
      const { w, owner, href } = await feed(sample, run);
      const buf = w.__IG_SORTER_BUFFER__;
      const where = file + " " + run.page;

      assert.equal(buf.length, run.reels, where + ": reels kept");
      if (run.reelCodes) assert.deepEqual(plain(buf.map((p) => p.code)).sort(), [...run.reelCodes].sort(), where);
      if (run.collabs !== undefined) {
        assert.equal(count(buf, (p) => String(p.owner).toLowerCase() !== owner), run.collabs, where + ": collabs");
      }
      // Everything kept is this profile's reel.
      const { isTargetReel } = w.__IG_SORTER_REELS__;
      assert.ok(buf.every((p) => isTargetReel(p, owner)), where + ": only the profile's reels");

      const has = (v) => typeof v === "number" && isFinite(v);
      for (const [k, n] of Object.entries(run.with || {})) {
        const got = k === "date" ? count(buf, (p) => !!p.createdAt) : count(buf, (p) => has(p[k]));
        assert.equal(got, n, where + ": reels with " + k);
      }
      assert.equal(w.__IG_SORTER_PAGEINFO__.hasNextPage, run.hasNextPage === undefined ? true : run.hasNextPage, where + ": hasNextPage");
      if (run.hits !== undefined) assert.equal(w.__IG_SORTER_HITS__, run.hits, where + ": hits");
      if (run.responses !== undefined) assert.equal(w.__IG_SORTER_RESPONSES__, run.responses, where + ": responses");
      if (run.unreadable !== undefined) assert.equal(w.__IG_SORTER_UNREADABLE__, run.unreadable, where + ": unreadable");
      for (const [k, n] of Object.entries(run.stats || {})) {
        assert.equal(w.__IG_SORTER_STATS__[k], n, where + ": stats." + k);
      }

      if (run.sort) {
        const r = await sortRun(sample, href, run.sort);
        assert.deepEqual(plain(r.codes), run.sort.codes, where + ": reason codes");
        if (run.sort.ranked !== undefined) assert.equal(r.ranked, run.sort.ranked, where + ": ranked");
        if (run.sort.first !== undefined) assert.equal(r.posts[0] && r.posts[0].code, run.sort.first, where + ": first");
        if (run.sort.alternatives) assert.deepEqual(plain(r.alternatives), run.sort.alternatives, where + ": alternatives");
        // Never nothing: whatever was kept is handed back.
        assert.equal(r.posts.length, Math.min(run.reels, run.sort.limit || 50), where + ": posts handed back");
      }
    });
  }
}
