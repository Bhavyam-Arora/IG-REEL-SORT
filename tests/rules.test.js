// lib/rules.js: plain data, the only place Instagram's names live, handed to
// the page scripts by content.js, with extract.js's built-in copy behind it.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { loadPage, respond, result, fixture, bodies, bundledRules, reel } = require("./harness");

const ROOT = path.join(__dirname, "..");
const REELS_TAB = "https://www.instagram.com/demo.creator/reels/";
const plain = (x) => JSON.parse(JSON.stringify(x));
const RULES = bundledRules();

// extract.js's built-in copy: what it resolves when nothing is handed over.
const builtIn = () => plain(loadPage(REELS_TAB, { rules: null }).__IG_SORTER_RULES__);

test("rules.js is plain JSON data with a version", () => {
  const src = fs.readFileSync(path.join(ROOT, "lib/rules.js"), "utf8");
  assert.ok(!/function|=>|new RegExp|\/[^/*\n]+\/[gimsuy]*[,\]]/.test(src.replace(/\/\/.*$/gm, "")), "no code in it");
  assert.equal(typeof RULES.version, "number");
  assert.deepEqual(JSON.parse(JSON.stringify(RULES)), RULES, "survives a JSON round trip");
});

test("the built-in copy is a subset of rules.js, same shape", () => {
  const small = builtIn();
  (function check(a, b, at) {
    if (Array.isArray(a)) {
      assert.ok(Array.isArray(b), at + " is a list in rules.js");
      for (const x of a) assert.ok(b.includes(x), at + ": " + JSON.stringify(x) + " missing from rules.js");
      return;
    }
    if (a && typeof a === "object") {
      for (const k of Object.keys(a)) {
        if (k === "version") continue;
        assert.ok(k in b, at + "." + k + " missing from rules.js");
        check(a[k], b[k], at + "." + k);
      }
      return;
    }
    assert.equal(typeof a, typeof b, at);
  })(small, RULES, "rules");
  // And rules.js has nothing the code doesn't know to read.
  (function same(a, b, at) {
    if (!a || typeof a !== "object" || Array.isArray(a)) return;
    for (const k of Object.keys(b)) assert.ok(k in a, at + "." + k + " in rules.js but not read by extract.js");
    for (const k of Object.keys(a)) same(a[k], b[k], at + "." + k);
  })(small, RULES, "rules");
});

test("no Instagram names outside rules.js (and extract.js's built-in copy)", () => {
  const code = (rel) =>
    fs.readFileSync(path.join(ROOT, rel), "utf8")
      .replace(/var BUILT_IN = \{[\s\S]*?\n  \};/, "") // the fallback copy itself
      .replace(/\/\/.*$/gm, ""); // comments
  // Instagram's own names: the underscored / numbered field names (generic
  // words like "text" or "url" are everywhere in plain JS), and the address
  // and prefix strings as literals.
  const names = new Set();
  (function collect(v) {
    if (typeof v === "string") v.split(".").forEach((s) => /_|\d/.test(s) && isNaN(s) && names.add(s));
    else if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === "object") Object.values(v).forEach(collect);
  })([RULES.fields, RULES.paging.hasNext]);
  const literals = [...RULES.responses.pathPrefixes, ...RULES.responses.pathContains, ...RULES.responses.bodyPrefixes];
  assert.ok(names.has("play_count") && names.has("has_next_page"), "the scan sees the usual suspects");
  for (const rel of ["lib/extract.js", "page/interceptor.js", "page/collector.js"]) {
    const src = code(rel);
    for (const n of names) assert.ok(!new RegExp("\\b" + n + "\\b").test(src), rel + " names " + n);
    for (const l of literals) {
      assert.ok(!src.includes('"' + l) && !src.toLowerCase().includes("/" + l.toLowerCase() + "/"), rel + " has " + l);
    }
  }
});

test("nothing handed over: the built-in copy, recorded as a warning, still reads today's reels", async () => {
  const w = loadPage(REELS_TAB, { rules: null });
  assert.equal(w.__IG_SORTER_RULES_INFO__.source, "builtin");
  assert.match(w.__IG_SORTER_RULES_INFO__.warning, /built-in/);
  for (const b of bodies(fixture("synthetic-reels-tab.json"))) await respond(w, b.url, b.text);
  assert.equal(w.__IG_SORTER_BUFFER__.length, 12);
  assert.equal(w.__IG_SORTER_PAGEINFO__.hasNextPage, false);
});

test("a malformed part is filled from the built-in copy; the rest is used as handed over", () => {
  const r = bundledRules();
  r.version = 42;
  r.fields.views = "play_count"; // not a list
  r.fields.likes = []; // empty
  r.limits.timeLimitMs = -1;
  delete r.paging;
  const w = loadPage(REELS_TAB, { rules: r });
  const info = w.__IG_SORTER_RULES_INFO__;
  assert.equal(info.source, "content");
  assert.equal(info.version, 42);
  assert.match(info.warning, /fields\.views/);
  assert.match(info.warning, /fields\.likes/);
  assert.match(info.warning, /limits\.timeLimitMs/);
  assert.match(info.warning, /paging/);
  const got = plain(w.__IG_SORTER_RULES__);
  const small = builtIn();
  assert.deepEqual(got.fields.views, small.fields.views);
  assert.deepEqual(got.paging, small.paging);
  assert.equal(got.limits.timeLimitMs, small.limits.timeLimitMs);
  assert.deepEqual(got.fields.comments, RULES.fields.comments, "untouched parts are as handed over");
  assert.equal(got.version, 42);
});

test("the rules drive extraction: a new alias is all it takes", async () => {
  const body = JSON.stringify({
    data: { feed: { items: [{ code: "SYNnew00001", user: { username: "demo.creator" }, media_type: 2, brand_new_views: 777 }], page_info: { has_next_page: true } } }
  });
  const before = loadPage(REELS_TAB);
  await respond(before, "/api/graphql", body);
  assert.equal(before.__IG_SORTER_BUFFER__.length, 0, "unknown to the bundled rules");

  const r = bundledRules();
  r.fields.views.push("brand_new_views");
  const after = loadPage(REELS_TAB, { rules: r });
  await respond(after, "/api/graphql", body);
  assert.equal(after.__IG_SORTER_BUFFER__.length, 1);
  assert.equal(after.__IG_SORTER_BUFFER__[0].views, 777);
});

test("the rules drive the address filter", async () => {
  const text = bodies(fixture("synthetic-reels-tab.json"))[0].text;
  const r = bundledRules();
  r.responses.pathPrefixes = ["/v2/"];
  r.responses.pathContains = ["reelsdata"];
  for (const [url, n] of [["/api/graphql", 0], ["/v2/anything", 4], ["/x/ReelsData/y", 4]]) {
    const w = loadPage(REELS_TAB, { rules: r });
    await respond(w, url, text);
    assert.equal(w.__IG_SORTER_BUFFER__.length, n, url);
  }
});

test("the rules drive the stop limits", async () => {
  const r = bundledRules();
  r.limits.scrollsWithoutReels = 3;
  const w = loadPage(REELS_TAB, {
    rules: r,
    job: { sortBy: "views", limit: 100 },
    onScroll: (w) => {
      w.__IG_SORTER_RESPONSES__++;
      w.__IG_SORTER_BUFFER__.push(reel("other.studio"));
    }
  });
  const res = await result(w);
  assert.equal(res.reason, "no_reels");
  assert.ok(w.scrolls >= 2 && w.scrolls <= 4, "scrolls: " + w.scrolls);
  assert.equal(res.rules.source, "content");
  assert.equal(res.rules.version, RULES.version);
});

test("the sort result says when it ran on the built-in copy", async () => {
  const w = loadPage(REELS_TAB, {
    rules: null,
    job: { sortBy: "views", limit: 4 },
    onScroll: (w) => {
      for (let i = 0; i < 4; i++) w.__IG_SORTER_BUFFER__.push(reel("demo.creator"));
    }
  });
  const res = await result(w);
  assert.equal(res.reason, "complete");
  assert.equal(res.rules.source, "builtin");
  assert.match(res.rules.warning, /built-in/);
});
