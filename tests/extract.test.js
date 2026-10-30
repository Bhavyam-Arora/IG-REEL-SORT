// Extractor, reels-tab URL check and ownership, against the synthetic fixtures.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, fixture, bodies } = require("./harness");

const w = loadPage("https://www.instagram.com/demo.creator/reels/");
const extract = w.__IG_SORTER_EXTRACT__;
const { pageKind, reelsTabOwner, ownsReel, isTargetReel } = w.__IG_SORTER_REELS__;
// Objects from the vm have its prototypes; compare as plain JSON.
const plain = (x) => JSON.parse(JSON.stringify(x));

test("reels-tab URL check accepts only /<username>/reels/", () => {
  const yes = [
    "https://www.instagram.com/demo.creator/reels/",
    "https://www.instagram.com/demo.creator/reels",
    "https://www.instagram.com/Demo.Creator/reels/?hl=en",
    "https://www.instagram.com/demo_creator/reels/#top"
  ];
  for (const u of yes) assert.equal(reelsTabOwner(u), u.includes("demo_") ? "demo_creator" : "demo.creator", u);

  const no = [
    "https://www.instagram.com/demo.creator/", // the profile's main grid
    "https://www.instagram.com/demo.creator", // same, no slash
    "https://www.instagram.com/reel/SYNreel0001/", // a single reel
    "https://www.instagram.com/demo.creator/reel/SYNreel0001/", // a single reel, profile-scoped
    "https://www.instagram.com/reels/", // Instagram's own reels feed
    "https://www.instagram.com/reels/SYNreel0001/",
    "https://www.instagram.com/", // home
    "https://www.instagram.com/explore/",
    "https://www.instagram.com/explore/search/",
    "https://www.instagram.com/explore/reels/",
    "https://www.instagram.com/p/SYNreel0001/",
    "https://www.instagram.com/demo.creator/tagged/",
    "https://www.instagram.com/demo.creator/reels/extra/",
    "http://www.instagram.com/demo.creator/reels/", // not https
    "https://instagram.com/demo.creator/reels/", // not www
    "https://www.instagram.com.example.com/demo.creator/reels/",
    "https://example.com/demo.creator/reels/",
    "",
    undefined
  ];
  for (const u of no) assert.equal(reelsTabOwner(u), null, String(u));
});

test("pageKind tells the profile grid apart from everywhere else", () => {
  assert.deepEqual(plain(pageKind("https://www.instagram.com/demo.creator/")), {
    kind: "profileGrid",
    owner: "demo.creator"
  });
  assert.deepEqual(plain(pageKind("https://www.instagram.com/demo.creator/?igsh=x")), {
    kind: "profileGrid",
    owner: "demo.creator"
  });
  for (const u of [
    "https://www.instagram.com/",
    "https://www.instagram.com/explore/",
    "https://www.instagram.com/reels/",
    "https://www.instagram.com/reel/SYNreel0001/",
    "https://www.instagram.com/direct/inbox/",
    "chrome://extensions/"
  ]) {
    assert.equal(pageKind(u).kind, "other", u);
  }
});

test("extractor reads every reel on a Reels-tab page, with views", () => {
  const sample = fixture("synthetic-reels-tab.json");
  const codes = new Set();
  for (const b of bodies(sample)) {
    const out = extract(b.json);
    assert.equal(out.posts.length, 4);
    for (const p of out.posts) {
      assert.equal(p.owner, "demo.creator");
      assert.equal(p.isVideo, true);
      assert.ok(p.views > 0, p.code + " has views");
      assert.ok(p.likes > 0 && p.comments > 0);
      assert.ok(p.createdAt.startsWith("2026-09"), "date recovered from pk: " + p.createdAt);
      codes.add(p.code);
    }
    // The page's list, with its posts filed under it.
    assert.equal(out.pages.length, 1);
    assert.equal(out.pages[0].codes.length, 4);
  }
  assert.equal(codes.size, 12);
});

test("ownership: the owner, or a collaborator in coauthor_producers", () => {
  const [b] = bodies(fixture("synthetic-collab.json"));
  const posts = extract(b.json).posts;
  const byCode = Object.fromEntries(posts.map((p) => [p.code, p]));

  const collab = byCode.SYNcollab01;
  assert.equal(collab.owner, "other.studio");
  assert.deepEqual(plain(collab.coauthors), ["demo.creator"]);
  assert.equal(ownsReel(collab, "demo.creator"), true);
  assert.equal(ownsReel(collab, "DEMO.CREATOR"), true, "usernames compare case-insensitively");
  assert.equal(ownsReel(collab, "other.studio"), true);

  assert.equal(ownsReel(byCode.SYNforeign1, "demo.creator"), false);
  assert.equal(ownsReel(byCode.SYNforeign1, "friend.account"), true);

  // A post that names nobody can't be attributed to the target.
  assert.equal(ownsReel({ code: "x", owner: null, coauthors: [] }, "demo.creator"), false);

  const kept = posts.filter((p) => isTargetReel(p, "demo.creator")).map((p) => p.code);
  assert.equal(kept.length, 3);
  assert.ok(kept.includes("SYNcollab01"), "collab reel kept");
  assert.ok(!kept.includes("SYNforeign1"), "someone else's reel dropped");
  assert.ok(!kept.includes("SYNphoto001"), "photo dropped: reels only");
});

test("inbox, highlights and suggested reels hold none of the target's reels", () => {
  for (const b of bodies(fixture("synthetic-inbox-highlights.json"))) {
    const out = extract(b.json);
    assert.equal(out.posts.filter((p) => isTargetReel(p, "demo.creator")).length, 0);
    if (b.json.data.xdt_get_inbox_threads) {
      // DMs are never read at all: no posts, no flags.
      assert.equal(out.posts.length, 0);
      assert.equal(out.pages.length, 0);
    } else {
      // The others do carry a "no next page" flag — the trap the interceptor
      // must avoid.
      assert.equal(out.hasNextPage, false);
    }
  }
});
