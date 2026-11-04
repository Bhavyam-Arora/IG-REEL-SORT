// The interceptor: which endpoints it reads, what it buffers, and what it lets
// change hasNextPage.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, respond, fixture, bodies, bundledRules } = require("./harness");

const REELS_TAB = "https://www.instagram.com/demo.creator/reels/";
const reelsTab = bodies(fixture("synthetic-reels-tab.json"));
const noise = bodies(fixture("synthetic-inbox-highlights.json"));
const collab = bodies(fixture("synthetic-collab.json"));

const buffered = (w) => w.__IG_SORTER_BUFFER__.map((p) => p.code);

test("address filter: any /api/ or graphql path on Instagram, including ones never seen", async () => {
  for (const url of [
    "/api/graphql",
    "https://www.instagram.com/api/graphql",
    "/graphql/query",
    "/api/v1/clips/user/",
    "/api/v1/feed/user/9000000001/",
    "/api/v1/feed/timeline/", // read now; only the target's reels in it would be kept
    "/api/v7/creator/reels_feed/",
    "/some/new/GraphQL/endpoint",
    "https://i.instagram.com/api/v1/clips/user/"
  ]) {
    const w = loadPage(REELS_TAB);
    await respond(w, url, reelsTab[0].text);
    assert.equal(buffered(w).length, 4, url);
  }
});

test("address filter: other paths and other hosts are never read", async () => {
  for (const url of [
    "/ajax/bz",
    "/accounts/edit/",
    "https://www.example.com/api/graphql",
    "https://instagram.com.example.com/api/graphql",
    "https://static.cdninstagram.com/api/x.json"
  ]) {
    const w = loadPage(REELS_TAB);
    await respond(w, url, reelsTab[0].text);
    assert.equal(buffered(w).length, 0, url);
    assert.equal(w.__IG_SORTER_RESPONSES__, 0, url);
  }
});

test("other people's reels from the timeline are counted and dropped, never kept", async () => {
  const w = loadPage("https://www.instagram.com/other.studio/reels/");
  await respond(w, "/api/v1/feed/timeline/", reelsTab[0].text);
  assert.equal(buffered(w).length, 0);
  assert.equal(w.__IG_SORTER_STATS__.foreign, 4);
  assert.equal(w.__IG_SORTER_PAGEINFO__.hasNextPage, true);
});

test("a list holding mostly others' reels can't end collection, even with one of ours in it", async () => {
  const w = loadPage(REELS_TAB);
  const json = JSON.parse(reelsTab[2].text); // the last page: has_next_page false
  const edges = json.data.fetch__XDTUserDict.clips_connection.edges;
  edges.slice(1).forEach((e) => (e.node.media.user.username = "other.studio"));
  await respond(w, "/api/v1/feed/timeline/", JSON.stringify(json));
  assert.equal(buffered(w).length, 1, "our reel is kept");
  assert.equal(w.__IG_SORTER_PAGEINFO__.hasNextPage, true, "but the list isn't ours");
});

test("bodies: too big is skipped and counted, before or after reading", async () => {
  const small = Object.assign(bundledRules(), {});
  small.responses.maxBodyChars = 1000;
  const w = loadPage(REELS_TAB, { rules: small });
  await respond(w, "/api/graphql", reelsTab[0].text);
  assert.equal(buffered(w).length, 0);
  assert.equal(w.__IG_SORTER_STATS__.tooLarge, 1);

  // The declared size alone is enough to skip it unread.
  const w2 = loadPage(REELS_TAB);
  await respond(w2, "/api/graphql", reelsTab[0].text, { "content-length": "9000000" });
  assert.equal(buffered(w2).length, 0);
  assert.equal(w2.__IG_SORTER_STATS__.tooLarge, 1);
});

test("bodies: not JSON is counted, not read", async () => {
  const w = loadPage(REELS_TAB);
  await respond(w, "/api/graphql", "<html>login</html>");
  await respond(w, "/api/graphql", "for (;;);");
  assert.equal(w.__IG_SORTER_STATS__.unparsable, 2);
  assert.equal(w.__IG_SORTER_RESPONSES__, 0);
});

test("Reels-tab pages: every reel buffered, hasNextPage follows the reels list", async () => {
  const w = loadPage(REELS_TAB);
  await respond(w, "/api/graphql", reelsTab[0].text);
  await respond(w, "/api/graphql", reelsTab[1].text);
  assert.equal(w.__IG_SORTER_PAGEINFO__.hasNextPage, true);
  await respond(w, "/api/graphql", reelsTab[2].text);
  assert.equal(buffered(w).length, 12);
  assert.equal(new Set(buffered(w)).size, 12);
  assert.equal(w.__IG_SORTER_PAGEINFO__.hasNextPage, false, "last page ends it");
  assert.equal(w.__IG_SORTER_HITS__, 3);
});

test("inbox / highlights / suggested reels yield 0 and never touch hasNextPage", async () => {
  const w = loadPage(REELS_TAB);
  for (const b of noise) await respond(w, b.url, b.text);
  assert.equal(buffered(w).length, 0);
  assert.equal(w.__IG_SORTER_PAGEINFO__.hasNextPage, true);
  assert.equal(w.__IG_SORTER_RESPONSES__, 3, "they still count as responses");
  assert.equal(w.__IG_SORTER_HITS__, 0);

  // Interleaved with real pages, they still can't end collection.
  await respond(w, "/api/graphql", reelsTab[0].text);
  for (const b of noise) await respond(w, b.url, b.text);
  assert.equal(w.__IG_SORTER_PAGEINFO__.hasNextPage, true);
  assert.equal(buffered(w).length, 4);
});

test("reels that name no author count as unreadable; others' reels and noise don't", async () => {
  const w = loadPage(REELS_TAB);
  for (const b of noise) await respond(w, b.url, b.text);
  await respond(w, "/api/graphql", collab[0].text);
  assert.equal(w.__IG_SORTER_UNREADABLE__, 0);

  // What a reels-tab page would look like if Instagram stopped sending the author.
  const json = JSON.parse(reelsTab[0].text);
  for (const e of json.data.fetch__XDTUserDict.clips_connection.edges) {
    delete e.node.media.user;
    e.node.media.coauthor_producers = [];
  }
  await respond(w, "/api/graphql", JSON.stringify(json));
  assert.equal(w.__IG_SORTER_UNREADABLE__, 4);
  assert.equal(w.__IG_SORTER_BUFFER__.length, 3, "only the collab fixture's reels");
});

test("only the target's reels are buffered; collab kept, others and photos dropped", async () => {
  const w = loadPage(REELS_TAB);
  await respond(w, "/api/graphql", collab[0].text);
  const codes = buffered(w);
  assert.equal(codes.length, 3);
  assert.ok(codes.includes("SYNcollab01"));
  assert.ok(!codes.includes("SYNforeign1"));
  assert.ok(!codes.includes("SYNphoto001"));
});

test("nothing is collected off a Reels tab", async () => {
  for (const href of [
    "https://www.instagram.com/demo.creator/",
    "https://www.instagram.com/reels/",
    "https://www.instagram.com/reel/SYNreel0001/",
    "https://www.instagram.com/"
  ]) {
    const w = loadPage(href);
    await respond(w, "/api/graphql", reelsTab[2].text);
    assert.equal(buffered(w).length, 0, href);
    assert.equal(w.__IG_SORTER_PAGEINFO__.hasNextPage, true, href);
  }
});

test("another profile's Reels tab doesn't collect demo.creator's reels", async () => {
  const w = loadPage("https://www.instagram.com/other.studio/reels/");
  await respond(w, "/api/graphql", reelsTab[2].text);
  assert.equal(buffered(w).length, 0);
  assert.equal(w.__IG_SORTER_PAGEINFO__.hasNextPage, true);
});

test("developer capture: off by default, captures only once switched on", async () => {
  const w = loadPage(REELS_TAB);
  const samples = () => w.messages.filter((m) => m.type === "debugSample");
  const ask = () => w.deliver({ source: "ig-sorter-debug", type: "debugSampleRequest" });

  await respond(w, "/api/graphql", reelsTab[0].text);
  ask();
  assert.equal(samples().length, 0, "off: a request gets no answer");

  w.deliver({ source: "ig-sorter-debug", type: "devCapture", on: true });
  ask();
  assert.equal(samples().length, 1);
  assert.equal(samples()[0].sample.graphqlBodies.length, 0, "nothing from before it was on");

  await respond(w, "/api/graphql", reelsTab[1].text);
  ask();
  assert.equal(samples()[1].sample.graphqlBodies.length, 1);

  // Off again: answers stop and what was held is dropped.
  w.deliver({ source: "ig-sorter-debug", type: "devCapture", on: false });
  ask();
  assert.equal(samples().length, 2);
});

test("the profile's reels sent again are counted as duplicates, kept once", async () => {
  const w = loadPage(REELS_TAB);
  await respond(w, "/api/graphql", reelsTab[0].text);
  await respond(w, "/api/graphql", reelsTab[0].text);
  assert.equal(buffered(w).length, 4);
  assert.equal(w.__IG_SORTER_STATS__.duplicates, 4);
});

// ---- Is the profile private? (for the error report offer only) ----

const profileReply = (user) => JSON.stringify({ data: { user: Object.assign({ pk: "9", full_name: "x" }, user) } });
const privacy = (w) => (w.__IG_SORTER_PROFILE_PRIVATE__ ? { ...w.__IG_SORTER_PROFILE_PRIVATE__ } : null);

// An Instagram XHR, answered with `text`. The harness's XHR does nothing, so
// the interceptor's load listener is run by hand.
function xhr(w, url, text) {
  const x = new w.XMLHttpRequest();
  let onLoad = null;
  x.addEventListener = (type, fn) => type === "load" && (onLoad = fn);
  x.open("POST", url);
  x.send();
  x.responseType = "";
  x.responseText = text;
  x.status = 200;
  x.getResponseHeader = () => "application/json";
  onLoad.call(x);
}

test("privacy: Instagram's profile response says public or private, for this Reels tab's owner only", async () => {
  const pub = loadPage(REELS_TAB);
  assert.equal(privacy(pub), null, "unknown until Instagram says");
  await respond(pub, "/api/graphql", profileReply({ username: "demo.creator", is_private: false }));
  assert.deepEqual(privacy(pub), { owner: "demo.creator", isPrivate: false });

  const priv = loadPage(REELS_TAB);
  await respond(priv, "/api/graphql", profileReply({ username: "Demo.Creator", is_private: true }));
  assert.deepEqual(privacy(priv), { owner: "demo.creator", isPrivate: true });

  // Another account's object, a missing flag or a flag that isn't a boolean says nothing.
  const other = loadPage(REELS_TAB);
  await respond(other, "/api/graphql", profileReply({ username: "other.studio", is_private: false }));
  await respond(other, "/api/graphql", profileReply({ username: "demo.creator" }));
  await respond(other, "/api/graphql", profileReply({ username: "demo.creator", is_private: "false" }));
  assert.equal(privacy(other), null);

  // Off a Reels tab nothing is noted.
  const grid = loadPage("https://www.instagram.com/demo.creator/");
  await respond(grid, "/api/graphql", profileReply({ username: "demo.creator", is_private: false }));
  assert.equal(privacy(grid), null);
});

test("privacy: the first answer stands, and noting it changes nothing that's collected", async () => {
  const w = loadPage(REELS_TAB);
  await respond(w, "/api/graphql", profileReply({ username: "demo.creator", is_private: false }));
  await respond(w, "/api/graphql", profileReply({ username: "demo.creator", is_private: true }));
  assert.deepEqual(privacy(w), { owner: "demo.creator", isPrivate: false });
  await respond(w, "/api/graphql", reelsTab[0].text);
  assert.equal(buffered(w).length, 4);
  assert.equal(w.__IG_SORTER_RESPONSES__, 3);
});

test("privacy: an Instagram XHR the address filter skips can still answer it, and is not otherwise read", async () => {
  const w = loadPage(REELS_TAB);
  xhr(w, "/ajax/profile_moved_here", profileReply({ username: "demo.creator", is_private: false }));
  assert.deepEqual(privacy(w), { owner: "demo.creator", isPrivate: false });
  assert.equal(w.__IG_SORTER_RESPONSES__, 0, "still not counted as a response read");
  xhr(w, "/ajax/reels_moved_here", reelsTab[0].text);
  assert.equal(buffered(w).length, 0, "and nothing from it collected");

  // Another host is never read, even for this.
  const away = loadPage(REELS_TAB);
  xhr(away, "https://www.example.com/x", profileReply({ username: "demo.creator", is_private: false }));
  assert.equal(privacy(away), null);
});
