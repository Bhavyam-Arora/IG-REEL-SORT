// content.js on a stand-in Instagram page: what the sorted view hides and
// restores, the failure card, the sign-in and Upgrade dialogs, and the files
// the exports produce.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { createDocument, settle } = require("./dom");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");

// A reels tab shaped like Instagram's: the grid, its spinner and a later
// section below it inside <main>, the footer after that, and a portal for
// Instagram's dialogs at the end of <body>.
function loadContent(opts) {
  opts = opts || {};
  const { document, MutationObserver } = createDocument();
  const reelLinks = (n) =>
    Array.from({ length: n }, (_, i) => ["a", { href: "/demo/reel/IG" + i + "/" }]);

  document.body.appendChild(
    document.build([
      "div", { id: "mount" },
      ["nav", { id: "nav" }],
      ["main", { role: "main", id: "main" },
        ["div", { id: "section" },
          ["header", { id: "header" }],
          ["div", { id: "tabs" }],
          ["div", { id: "panel" },
            ["div", { id: "grid", style: "display: flex; flex-direction: column" },
              // opts.thumbs: the grid's link hrefs instead, all in the first row.
              ["div", { id: "row1" }, ...(opts.thumbs ? opts.thumbs.map((href) => ["a", { href }]) : reelLinks(4))],
              ["div", { id: "row2" }, ...(opts.thumbs ? [] : reelLinks(4))]],
            ["div", { id: "spinner" }]],
          ["div", { id: "below", style: "display: block" }]],
        ["footer", { id: "footer" }]]
    ])
  );
  document.body.appendChild(document.build(["div", { id: "portal" }]));

  const store = Object.assign({}, opts.store);
  let job = opts.job ? JSON.stringify(opts.job) : null;
  const sent = [];
  const loads = [];
  const rulesAsks = [];
  const proAsks = [];
  const ticks = [];
  const opened = [];
  const files = [];
  const unanswered = [];
  const timers = [];
  const logged = [];
  const listeners = { message: [], runtime: [] };
  const chrome = {
    runtime: {
      lastError: undefined,
      getURL: (p) => "chrome-extension://test/" + p,
      getManifest: () => ({ version: "test" }),
      sendMessage(msg, cb) {
        // Every page load tells the worker; the worker answers with the tab.
        if (msg.type === "pageLoad") {
          loads.push(msg);
          if (cb) cb({ ok: true, tabId: opts.tabId === undefined ? 7 : opts.tabId });
          return;
        }
        // The results header asks whether to show Similar accounts: opts.pro
        // is the worker's answer, Free unless a test says otherwise.
        if (msg.type === "isPro") {
          proAsks.push(msg);
          if (cb) cb(opts.proReply !== undefined ? opts.proReply : { ok: true, pro: !!opts.pro });
          return;
        }
        // No rules in storage: content.js asks the worker. The answer is
        // opts.rulesReply, or held until the test gives one with answerRules.
        if (msg.type === "getRules") {
          rulesAsks.push(cb);
          if (opts.rulesReply !== undefined) cb(opts.rulesReply);
          return;
        }
        sent.push(msg);
        const reply = opts.onMessage ? opts.onMessage(msg, sent) : undefined;
        if (!cb) return;
        if (reply !== undefined) cb(reply);
        else unanswered.push({ msg, cb });
      },
      onMessage: { addListener: (fn) => listeners.runtime.push(fn) }
    },
    storage: {
      local: {
        get(defaults, cb) { cb(Object.assign({}, defaults, store)); },
        // opts.storageError makes every write fail the way Chrome reports it.
        set(o, cb) {
          if (opts.storageError) {
            chrome.runtime.lastError = { message: opts.storageError };
            if (cb) cb();
            chrome.runtime.lastError = undefined;
            return;
          }
          Object.assign(store, o);
          if (cb) cb();
        },
        remove(k, cb) {
          [].concat(k).forEach((key) => delete store[key]);
          if (cb) cb();
        }
      },
      onChanged: { addListener() {} }
    }
  };

  const w = {
    document,
    MutationObserver,
    chrome,
    console: { log: (...a) => logged.push(a.join(" ")), warn: (...a) => logged.push("WARN " + a.join(" ")) },
    location: { href: "https://www.instagram.com/demo/reels/", pathname: "/demo/reels/", reload() {} },
    sessionStorage: {
      getItem: (k) => (k === "igSorterJob" ? job : null),
      setItem: (k, v) => { if (k === "igSorterJob") job = v; },
      removeItem: (k) => { if (k === "igSorterJob") job = null; }
    },
    // The profile watcher's tick, run by the test with page.tick().
    setInterval: (fn) => (ticks.push(fn), ticks.length),
    // Held, not run: the 4s return-to-idle timer and the download cleanup
    // never need to fire; a test fires the ones it cares about by delay.
    setTimeout: (fn, ms) => (timers.push({ fn, ms }), timers.length),
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = () => {}; },
    TextEncoder,
    // Every download: the anchor content.js clicks names the file.
    Blob: class {
      constructor(parts, o) {
        this.parts = parts;
        this.type = o && o.type;
      }
    },
    URL: {
      createObjectURL: (blob) => (files.push({ blob }), "blob:" + files.length),
      revokeObjectURL() {}
    },
    open: (...args) => opened.push(args),
    addEventListener(type, fn) { if (type === "message") listeners.message.push(fn); },
    postMessage() {}
  };
  Object.assign(w, opts.window); // extra page globals a test wants
  w.window = w;
  vm.createContext(w);
  vm.runInContext(SOURCE, w, { filename: "content.js" });

  const self = vm.runInContext("window", w);
  // The file from the latest download: { name, type, data }.
  const lastFile = () => {
    const f = files[files.length - 1];
    const a = document.querySelectorAll("a").filter((x) => x.href === "blob:" + files.length).pop();
    const part = f.blob.parts[0];
    return { name: a && a.download, type: f.blob.type, data: part };
  };

  return {
    document,
    store,
    sent,
    loads,
    job: () => (job ? JSON.parse(job) : null),
    // Instagram moving to another page without loading one.
    go(pathname) {
      w.location.pathname = pathname;
      w.location.href = "https://www.instagram.com" + pathname;
      ticks.forEach((fn) => fn());
    },
    opened,
    lastFile,
    $: (id) => document.getElementById(id),
    rulesAsks,
    proAsks,
    logged,
    answerRules: (reply) => rulesAsks.forEach((cb) => cb(reply)),
    // Fire the held timers set with this delay.
    fireTimers: (ms) => timers.filter((t) => t.ms === ms).forEach((t) => t.fn()),
    // Answer a message the test held back.
    answer(type, reply) {
      const i = unanswered.findIndex((u) => u.msg.type === type);
      unanswered.splice(i, 1)[0].cb(reply);
    },
    // A finished sort, as collector.js posts it.
    result(posts, extra) {
      for (const fn of listeners.message) {
        fn({
          source: self,
          data: Object.assign({
            source: "ig-sorter", type: "result", posts, sortBy: "views",
            ranked: posts.length, median: null, reason: "complete", total: posts.length
          }, extra)
        });
      }
    },
    // Any other message from the page world, e.g. the collector's progress.
    post(data) {
      for (const fn of listeners.message) fn({ source: self, data: Object.assign({ source: "ig-sorter" }, data) });
    },
    // A message from the popup.
    popup(msg) {
      let reply;
      for (const fn of listeners.runtime) fn(msg, {}, (r) => (reply = r));
      return reply;
    }
  };
}

const posts = [1, 2, 3].map((n) => ({
  code: "R" + n, pk: String(n), url: "https://www.instagram.com/p/R" + n + "/",
  views: 1000 * n, likes: n, comments: n, isVideo: true, createdAt: "2026-10-01T00:00:00Z"
}));

const display = (el) => el.style.getPropertyValue("display");

test("sorted view: only our grid and Instagram's footer below the profile header", async () => {
  const page = loadContent();
  page.result(posts);
  const { $ } = page;

  assert.ok($("ig-sorter-wrap"), "sorted grid placed");
  assert.equal($("ig-sorter-wrap").nextElementSibling, $("grid"));
  for (const id of ["grid", "spinner", "below"]) assert.equal(display($(id)), "none", id);
  for (const id of ["header", "tabs", "footer", "nav", "portal", "main"]) {
    assert.notEqual(display($(id)), "none", id);
  }
});

test("sorted view: skeletons and grid rows Instagram adds later are hidden as they arrive", async () => {
  const page = loadContent();
  page.result(posts);
  const { $, document } = page;

  const skeleton = $("panel").appendChild(document.build(["div", { id: "skeleton" }]));
  const chunk = $("section").appendChild(document.build(["div", { id: "chunk" }, ["a", { href: "/demo/reel/X/" }]]));
  // React writing the grid's style back.
  $("grid").style.display = "flex";
  await settle();

  assert.equal(display(skeleton), "none");
  assert.equal(display(chunk), "none");
  assert.equal(display($("grid")), "none");
  assert.notEqual(display($("footer")), "none");
});

test("restore: every hidden node gets back exactly the display it had", async () => {
  for (const how of ["page button", "popup"]) {
    const page = loadContent();
    page.result(posts);
    const { $, document } = page;
    const skeleton = $("panel").appendChild(document.build(["div", { id: "skeleton" }]));
    await settle();

    if (how === "popup") page.popup({ type: "restore" });
    else $("ig-sorter-wrap").querySelector("button").click();

    assert.equal($("ig-sorter-wrap"), null, how);
    assert.equal(display($("grid")), "flex", how);
    assert.equal($("grid").style.getPropertyPriority("display"), "", how);
    assert.equal(display($("below")), "block", how);
    assert.equal(display($("spinner")), "", how);
    assert.equal(display(skeleton), "", how);
    assert.equal(document.querySelectorAll("[data-ig-sorter-hidden]").length, 0, how);

    // Instagram's own additions after a restore are left alone.
    const later = $("panel").appendChild(document.build(["div", { id: "later" }]));
    await settle();
    assert.equal(display(later), "", how);
  }
});

test("failure: a red-tinted card with today's words, and the same words in storage for the popup", () => {
  const text = "This reel can't be transcribed — it's about 31 MB, over our current 24 MB limit. No credit was used.";
  const page = loadContent({
    onMessage: (msg) => (msg.type === "transcribe" ? { ok: false, error: text } : undefined)
  });
  page.result(posts);

  const btn = page.document.querySelectorAll(".igs-tx")[1];
  btn.click();

  const card = page.document.querySelector(".igs-result");
  assert.ok(card, "card shown");
  assert.ok(card.classList.contains("is-bad"), "red-tinted");
  assert.equal(card.querySelector("h2").textContent, "Couldn't transcribe");
  assert.equal(card.querySelector(".igs-result-msg").textContent, text);
  assert.equal(card.querySelector(".igs-result-sub").textContent, "R2");
  assert.ok(btn.classList.contains("is-error"), "the tile says so too");
  assert.equal(page.store.transcribeStatus.text, text);
  assert.equal(page.store.transcribeStatus.ok, false);
  assert.equal(page.store.transcribeStatus.code, "R2");
  assert.equal(page.$("ig-sorter-tx-progress"), null, "the pill goes when the job does");

  card.querySelector(".igs-x").click();
  assert.equal(page.document.querySelector(".igs-result"), null, "dismissed");

  // Tried again: a fresh card.
  btn.click();
  assert.equal(page.document.querySelectorAll(".igs-result").length, 1);
});

test("failure: a worker that never answers still gets a card", () => {
  const page = loadContent({ onMessage: () => null });
  page.result(posts);
  page.document.querySelector(".igs-tx").click();
  const card = page.document.querySelector(".igs-result");
  assert.match(card.textContent, /Extension worker unavailable/);
  assert.match(page.store.transcribeStatus.text, /Extension worker unavailable/);
});

const SIGNED_OUT = { ok: false, signedOut: true, error: "You need to be signed in first." };

test("signed out: the dialog opens first, and Google only from its button", () => {
  let signIn = { ok: false, error: "Sign-in was cancelled." };
  const page = loadContent({
    onMessage: (msg, sent) => {
      if (msg.type === "pageSignIn") return signIn;
      if (msg.type === "transcribe") {
        return sent.some((m) => m.type === "pageSignIn" && signIn.ok)
          ? { ok: false, error: "after sign-in" }
          : SIGNED_OUT;
      }
    }
  });
  page.result(posts);
  const btn = page.document.querySelector(".igs-tx");
  btn.click();

  const dialog = page.document.querySelector(".igs-dialog");
  assert.ok(dialog, "dialog shown");
  assert.equal(dialog.getAttribute("role"), "dialog");
  assert.equal(dialog.querySelector("h2").textContent, "Sign in to transcribe");
  assert.equal(dialog.querySelector("#igs-dialog-text").textContent, "You need to be signed in first.");
  const go = dialog.querySelector(".igs-btn");
  assert.equal(go.textContent, "Sign in with Google");
  assert.ok(dialog.querySelector(".igs-x"), "close button");
  assert.equal(page.document.querySelector(".igs-result"), null, "signed out isn't a failure card");
  assert.deepEqual(page.sent.map((m) => m.type), ["transcribe"], "Google not opened yet");

  // Google's window closed.
  go.click();
  const err = dialog.querySelector(".igs-dialog-err");
  assert.equal(err.hidden, false);
  assert.equal(err.textContent, "Sign-in was cancelled.");
  assert.ok(page.document.querySelector(".igs-dialog"), "dialog stays for another try");

  // Signed in: the dialog goes and the same reel is transcribed.
  signIn = { ok: true };
  go.click();
  assert.equal(page.$("igs-dialog-title"), null, "dialog closed");
  assert.match(page.document.querySelector(".igs-result").textContent, /after sign-in/, "this time it was tried");
  assert.deepEqual(page.sent.map((m) => m.type), ["transcribe", "pageSignIn", "pageSignIn", "transcribe"]);
  assert.equal(page.sent[3].post.code, "R1");
});

test("signed out: closing the dialog (× or Escape) does nothing else", () => {
  const page = loadContent({ onMessage: (msg) => (msg.type === "transcribe" ? SIGNED_OUT : undefined) });
  page.result(posts);
  const btn = page.document.querySelector(".igs-tx");

  btn.click();
  page.document.querySelector(".igs-dialog").querySelector(".igs-x").click();
  assert.equal(page.document.querySelector(".igs-modal"), null);

  btn.click();
  page.document.dispatchEvent({ type: "keydown", key: "Escape" });
  assert.equal(page.document.querySelector(".igs-modal"), null);

  assert.deepEqual(page.sent.map((m) => m.type), ["transcribe", "transcribe"]);
  assert.equal(page.document.querySelector(".igs-result"), null);
  assert.equal(btn.disabled, false);
});

test("signed out: closed while Google's window is up, the sign-in doesn't start a transcription", () => {
  const page = loadContent({ onMessage: (msg) => (msg.type === "transcribe" ? SIGNED_OUT : undefined) });
  page.result(posts);
  page.document.querySelector(".igs-tx").click();
  const dialog = page.document.querySelector(".igs-dialog");

  dialog.querySelector(".igs-btn").click();
  dialog.querySelector(".igs-x").click();
  page.answer("pageSignIn", { ok: true });

  assert.equal(page.document.querySelector(".igs-modal"), null);
  assert.deepEqual(page.sent.map((m) => m.type), ["transcribe", "pageSignIn"]);
});

// ---- Free: the Upgrade dialog ----

const PRICING = "https://sortcut.co/pricing.html";
const NEEDS_PRO = { ok: false, needsPro: true, error: "Transcription is part of Sortcut Pro." };

test("signed in on Free: the Upgrade dialog, which opens the pricing page", () => {
  const page = loadContent({ onMessage: (msg) => (msg.type === "transcribe" ? NEEDS_PRO : undefined) });
  page.result(posts);
  const btn = page.document.querySelector(".igs-tx");
  btn.click();

  const dialog = page.document.querySelector(".igs-dialog");
  assert.ok(dialog, "dialog shown");
  assert.equal(dialog.getAttribute("role"), "dialog");
  assert.equal(dialog.querySelector("#igs-dialog-text").textContent, "Transcription is part of Sortcut Pro.");
  const go = dialog.querySelector(".igs-btn");
  assert.equal(go.textContent, "Upgrade to Pro");
  assert.ok(dialog.querySelector(".igs-x"), "close button");
  assert.equal(page.document.querySelector(".igs-result"), null, "not a failure card");
  assert.equal(page.store.transcribeStatus, undefined, "nor a failure in the popup");
  assert.equal(btn.disabled, false);

  go.click();
  assert.deepEqual(page.opened, [[PRICING, "_blank", "noopener"]]);
  assert.equal(page.document.querySelector(".igs-modal"), null, "closed after opening the page");
  assert.deepEqual(page.sent.map((m) => m.type), ["transcribe"]);
});

test("signed in on Free: × closes the Upgrade dialog and opens nothing", () => {
  const page = loadContent({ onMessage: (msg) => (msg.type === "transcribe" ? NEEDS_PRO : undefined) });
  page.result(posts);
  page.document.querySelector(".igs-tx").click();
  page.document.querySelector(".igs-dialog").querySelector(".igs-x").click();
  assert.equal(page.document.querySelector(".igs-modal"), null);
  assert.deepEqual(page.opened, []);
});

test("signed out, then signs in to a Free account: the Upgrade dialog instead of a transcript", () => {
  let signedIn = false;
  const page = loadContent({
    onMessage: (msg) => {
      if (msg.type === "pageSignIn") return (signedIn = true), { ok: true };
      if (msg.type === "transcribe") return signedIn ? NEEDS_PRO : SIGNED_OUT;
    }
  });
  page.result(posts);
  page.document.querySelector(".igs-tx").click();
  assert.equal(page.document.querySelector("#igs-dialog-title").textContent, "Sign in to transcribe");

  page.document.querySelector(".igs-dialog").querySelector(".igs-btn").click();
  const dialog = page.document.querySelector(".igs-dialog");
  assert.ok(dialog, "a dialog is up");
  assert.equal(dialog.querySelector(".igs-btn").textContent, "Upgrade to Pro");
  assert.equal(page.document.querySelectorAll(".igs-modal").length, 1, "only the one");
  assert.deepEqual(page.sent.map((m) => m.type), ["transcribe", "pageSignIn", "transcribe"]);
  assert.equal(page.document.querySelector(".igs-result"), null);
});

// ---- Free: no date range anywhere ----

test("the sort state keeps the run's counts, for telling why it stopped where it did", () => {
  const page = loadContent();
  page.result(posts, {
    reason: "stalled", responses: 30, hits: 3, unreadable: 2, hasNextPage: true,
    stats: { reels: 40, foreign: 12, emptyReelsLists: 0, tooLarge: 0, unparsable: 0 }
  });
  assert.equal(page.store.sortState.reason, "stalled");
  assert.deepEqual(JSON.parse(JSON.stringify(page.store.sortState.counts)), {
    responses: 30, hits: 3, reels: 40, foreign: 12, unreadable: 2, hasNextPage: true
  });
});

test("a sorted grid names no date range, and the state carries none", () => {
  const page = loadContent();
  page.result(posts, { reason: "complete" });
  assert.doesNotMatch(page.$("ig-sorter-wrap").textContent, /last \d+ days/);
  assert.equal("days" in page.store.sortState, false);
});

// ---- Sort state: no summary, only warnings, tied to this page ----

test("a finished sort leaves no summary for the popup, only that it's done", () => {
  for (const reason of ["complete", "end", "stalled"]) {
    const page = loadContent();
    page.result(posts, { reason });
    assert.equal(page.store.sortState.warning, null, reason);
    assert.equal(page.store.sortState.message, undefined, reason);
    assert.equal(page.store.sortState.count, 3);
  }
});

// Every reason code the collector can send, and the words the popup shows.
const SAID = {
  no_responses:
    "Instagram didn't send anything while we scrolled — check your connection, reload the page and try again.",
  responses_but_no_reels:
    "No reels found. This profile may not have any reels, or Instagram may have changed something.",
  reels_but_none_from_profile: "Couldn't read reels — Instagram may have changed something.",
  profile_has_no_reels: "This profile hasn't posted any reels.",
  wrong_page: "Open an Instagram profile's Reels tab to sort."
};

test("every empty-sort reason code is stored and put into words", () => {
  for (const [code, words] of Object.entries(SAID)) {
    const page = loadContent();
    page.result([], { reason: "no_reels", total: 0, codes: [code] });
    const st = page.store.sortState;
    assert.equal(st.status, "stopped", code);
    assert.deepEqual(st.codes, [code]);
    assert.equal(st.warning, words, code);
  }
});

test("an empty sort without a code still says something", () => {
  const page = loadContent();
  page.result([], { reason: "no_reels", total: 0 });
  assert.equal(page.store.sortState.warning, SAID.responses_but_no_reels);
});

test("partial sorts: the time limit, and a metric Instagram isn't sending", () => {
  const late = loadContent();
  late.result(posts, { reason: "timeout", limitMs: 3 * 60 * 1000, codes: ["stopped_time_limit"] });
  assert.equal(late.store.sortState.status, "stopped");
  assert.deepEqual(late.store.sortState.codes, ["stopped_time_limit"]);
  assert.equal(late.store.sortState.warning, "Stopped at the 3-minute time limit — sorted the 3 reels collected by then.");

  const noViews = loadContent();
  noViews.result(posts, {
    reason: "end", codes: ["reels_missing_metric"], missingMetric: "views", alternatives: ["likes", "comments"]
  });
  assert.equal(noViews.store.sortState.status, "done", "the sort still finished");
  assert.equal(noViews.store.sortState.count, 3, "and the grid has every reel");
  assert.equal(
    noViews.store.sortState.warning,
    "Instagram isn't sending views right now — try sorting by likes or comments."
  );

  const nothingElse = loadContent();
  nothingElse.result(posts, { reason: "end", codes: ["reels_missing_metric"], missingMetric: "likes", alternatives: [] });
  assert.equal(nothingElse.store.sortState.warning, "Instagram isn't sending likes right now.");

  const both = loadContent();
  both.result(posts, {
    reason: "timeout", limitMs: 10 * 60 * 1000, codes: ["stopped_time_limit", "reels_missing_metric"],
    missingMetric: "comments", alternatives: ["views"]
  });
  assert.deepEqual(both.store.sortState.codes, ["stopped_time_limit", "reels_missing_metric"]);
  assert.equal(
    both.store.sortState.warning,
    "Stopped at the 10-minute time limit — sorted the 3 reels collected by then. " +
      "Instagram isn't sending comments right now — try sorting by views."
  );
});

// What the page got: the injected scripts, in order, and the rules on extract.js.
function injected(page) {
  const scripts = page.document.querySelectorAll("script");
  const attr = scripts.length ? scripts[0].getAttribute("data-sortcut-rules") : null;
  return {
    paths: scripts.map((s) => s.src.replace("chrome-extension://test/", "")),
    rules: attr === null ? null : JSON.parse(attr)
  };
}
const ALL_SCRIPTS = ["lib/extract.js", "page/interceptor.js", "page/collector.js"];
const RULES = { version: 7, fields: { views: ["play_count"] } };

test("rules: handed to extract.js on its script element, straight from storage", () => {
  const page = loadContent({ store: { rules: RULES } });
  assert.deepEqual(injected(page), { paths: ALL_SCRIPTS, rules: RULES });
  assert.equal(page.rulesAsks.length, 0, "the worker isn't asked");
  assert.equal(page.document.querySelectorAll("script")[1].getAttribute("data-sortcut-rules"), null);
});

// The reload case: the extension was reloaded (or installed, or updated) and
// its worker hasn't run since, so storage has every other key but no rules.
const AFTER_RELOAD = { auth: {}, health: [], lastPlan: {}, lastRun: {}, sortState: null, transcribeStatus: {} };

test("rules, after a reload: none stored, so the worker is asked and its copy is handed over", () => {
  const page = loadContent({ store: Object.assign({}, AFTER_RELOAD) });
  assert.equal(page.rulesAsks.length, 1, "asked once");
  assert.deepEqual(injected(page).paths, [], "nothing injected while waiting");

  page.answerRules({ ok: true, rules: RULES });
  assert.deepEqual(injected(page), { paths: ALL_SCRIPTS, rules: RULES });

  // The fallback timer firing afterwards changes nothing.
  page.fireTimers(1000);
  assert.equal(page.document.querySelectorAll("script").length, 3);
});

test("rules, after a reload: a stored copy without a version counts as none", () => {
  const page = loadContent({ store: { rules: { fields: {} } }, rulesReply: { ok: true, rules: RULES } });
  assert.equal(page.rulesAsks.length, 1);
  assert.deepEqual(injected(page), { paths: ALL_SCRIPTS, rules: RULES });
});

test("rules, after a reload: a worker that doesn't answer in time doesn't hold the page up", () => {
  const page = loadContent({ store: Object.assign({}, AFTER_RELOAD) });
  page.fireTimers(1000);
  assert.deepEqual(injected(page), { paths: ALL_SCRIPTS, rules: null }, "built-in copy, which the sort records");
  // A late answer can't inject a second set.
  page.answerRules({ ok: true, rules: RULES });
  assert.equal(page.document.querySelectorAll("script").length, 3);
});

test("rules, after a reload: a worker error means the built-in copy, at once", () => {
  for (const reply of [{ ok: false, error: "x" }, { ok: true, rules: null }, null]) {
    const page = loadContent({ store: Object.assign({}, AFTER_RELOAD), rulesReply: reply });
    assert.deepEqual(injected(page), { paths: ALL_SCRIPTS, rules: null }, JSON.stringify(reply));
  }
});

test("rules: a sort on the built-in copy is recorded, not shown", () => {
  const page = loadContent();
  page.result(posts, { reason: "end", rules: { source: "builtin", version: 0, warning: "No rules were handed over; sorted with the built-in copy." } });
  assert.equal(page.store.sortState.warning, null);
  assert.equal(page.store.sortState.rulesWarning, "No rules were handed over; sorted with the built-in copy.");
  assert.equal(page.store.health[0].rules, "builtin v0");
  assert.equal(page.store.health[0].rulesWarning, "No rules were handed over; sorted with the built-in copy.");
});

test("startSort: the state and the job carry the tab, the profile and this page load", () => {
  const page = loadContent();
  page.popup({ type: "startSort", sortBy: "views", limit: 300, maxReels: 50, tabId: 7 });
  const s = page.store.sortState;
  assert.equal(s.tabId, 7);
  assert.equal(s.profile, "demo");
  assert.equal(s.loadId, page.popup({ type: "ping" }).loadId);
  assert.equal(s.target, 50, "Free's cap, not the 300 asked for");
  assert.deepEqual({ ...page.job() }, { sortBy: "views", limit: 50, maxReels: 50, tabId: 7, plan: "free" });
});

test("startSort on Pro: no cap", () => {
  const page = loadContent();
  page.popup({ type: "startSort", sortBy: "views", limit: "all", maxReels: null, tabId: 7 });
  assert.deepEqual({ ...page.job() }, { sortBy: "views", limit: "all", maxReels: null, tabId: 7, plan: "pro" });
});

test("page load: a plain load asks the worker to end this tab's old state", () => {
  const page = loadContent();
  assert.equal(page.loads.length, 1);
  assert.equal(page.loads[0].keep, false);
  assert.equal(page.loads[0].loadId, page.popup({ type: "ping" }).loadId);
});

test("page load: the reload a sort started re-stamps the state with this load", () => {
  const old = { status: "running", tabId: 7, loadId: "before", profile: "demo", message: "Reloading…" };
  const page = loadContent({
    store: { sortState: old },
    job: { sortBy: "views", limit: 50, maxReels: 50, tabId: 7 }
  });
  assert.equal(page.loads[0].keep, true);
  const s = page.store.sortState;
  assert.equal(s.status, "running");
  assert.equal(s.tabId, 7);
  assert.equal(s.profile, "demo");
  assert.equal(s.loadId, page.popup({ type: "ping" }).loadId);
  assert.notEqual(s.loadId, "before");
});

test("leaving the profile ends the sort: grid, exports and popup state", () => {
  const page = loadContent({ job: { sortBy: "views", limit: 50, tabId: 7 } });
  page.result(posts);
  assert.ok(page.$("ig-sorter-wrap"));
  assert.equal(page.popup({ type: "ping" }).have, 3);

  page.go("/demo/reel/IG1/");
  assert.ok(page.$("ig-sorter-wrap"), "opening a reel over the profile isn't leaving it");
  page.go("/demo/");
  assert.ok(page.store.sortState, "nor is the same profile's grid");

  page.go("/someone.else/reels/");
  assert.equal(page.$("ig-sorter-wrap"), null);
  assert.equal(page.popup({ type: "ping" }).have, 0);
  assert.equal(page.store.sortState, undefined);
});

test("leaving the profile doesn't end a newer run's state", () => {
  const page = loadContent({ job: { sortBy: "views", limit: 50, tabId: 7 } });
  page.result(posts);
  page.store.sortState = { status: "running", tabId: 9, loadId: "elsewhere", profile: "x" };
  page.go("/someone.else/");
  assert.equal(page.store.sortState.loadId, "elsewhere");
});

test("a run that ends after its tab moved to another profile leaves nothing behind", () => {
  const page = loadContent({ job: { sortBy: "views", limit: 50, tabId: 7 } });
  page.go("/someone.else/reels/");
  page.result(posts, { reason: "navigated" });
  assert.equal(page.popup({ type: "ping" }).have, 0);
  assert.equal(page.store.sortState, undefined);
});

// ---- Excel export ----

const zlib = require("zlib");

// Read a zip's entries through its central directory, checking every CRC.
function unzip(buf) {
  buf = Buffer.from(buf.buffer, buf.byteOffset, buf.length);
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, "end of central directory");
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(at), 0x02014b50, "central directory entry");
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const skip = nameLen + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLen);
    assert.equal(buf.readUInt32LE(local), 0x04034b50, "local header for " + name);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
    assert.equal(zlib.crc32(data), crc, "CRC of " + name);
    out[name] = data.toString("utf8");
    at += 46 + skip;
  }
  return out;
}

// Every tag closed, in order. Enough to catch broken markup, not a validator.
function assertWellFormed(xml, name) {
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"'), name + ": XML declaration");
  const stack = [];
  for (const [, close, tag, selfClose] of xml.matchAll(/<(\/?)([A-Za-z_][\w:.-]*)[^>]*?(\/?)>/g)) {
    if (close) assert.equal(stack.pop(), tag, name + ": </" + tag + ">");
    else if (!selfClose) stack.push(tag);
  }
  assert.deepEqual(stack, [], name + ": unclosed tags");
  assert.doesNotMatch(xml, /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/, name + ": control characters");
}

const unescapeXml = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

// rows[r][col] = { s, t, v } from the sheet's XML.
function readSheet(xml) {
  const rows = {};
  for (const [, r, body] of xml.matchAll(/<row r="(\d+)">(.*?)<\/row>/g)) {
    rows[r] = {};
    for (const [, attrs, inner] of body.matchAll(/<c ([^>]*)>(.*?)<\/c>/g)) {
      const attr = (k) => (new RegExp(k + '="([^"]*)"').exec(attrs) || [])[1];
      const col = attr("r").replace(/\d+$/, "");
      const v = /<v>(.*?)<\/v>/.exec(inner);
      const t = /<t[^>]*>(.*?)<\/t>/s.exec(inner);
      rows[r][col] = { s: attr("s"), t: attr("t"), v: v ? v[1] : unescapeXml(t[1]) };
    }
  }
  return rows;
}

const scored = [
  {
    code: "AAA", url: "https://www.instagram.com/p/AAA/", views: 2500000, likes: 120000,
    comments: 4100, outlierScore: 333.3333, createdAt: "2026-09-14T18:05:09.000Z", isVideo: true,
    caption: 'Tom & "Jerry" <3 \u0007 \u{1F525} Hindi: नमस्ते', videoUrl: "https://cdn.test/v.mp4"
  },
  {
    code: "BBB", url: "https://www.instagram.com/p/BBB/", views: null, likes: 75, comments: 0,
    outlierScore: null, createdAt: "2026-08-30T00:00:00.000Z", isVideo: true, caption: ""
  }
];

test("Excel: a valid .xlsx with the CSV's columns, and typed cells", () => {
  const page = loadContent();
  page.result(scored, { sortBy: "outlier", ranked: 1, median: 7500 });

  assert.deepEqual({ ...page.popup({ type: "export", kind: "csv" }) }, { ok: true, count: 2 });
  const csvHeader = page.lastFile().data.replace(/^﻿/, "").split("\r\n")[0].split(",");

  assert.deepEqual({ ...page.popup({ type: "export", kind: "xlsx" }) }, { ok: true, count: 2 });
  const file = page.lastFile();
  assert.equal(file.name, "demo-sorted.xlsx", "named like demo-sorted.csv");
  assert.equal(file.type, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(Object.prototype.toString.call(file.data), "[object Uint8Array]", "bytes");

  const parts = unzip(file.data);
  for (const name of [
    "[Content_Types].xml", "_rels/.rels", "xl/workbook.xml",
    "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml"
  ]) {
    assert.ok(name in parts, name);
    assertWellFormed(parts[name], name);
  }
  // Every part the package declares or links to is in the zip.
  for (const [, part] of parts["[Content_Types].xml"].matchAll(/PartName="\/([^"]+)"/g)) {
    assert.ok(part in parts, "content type for missing " + part);
  }
  assert.match(parts["_rels/.rels"], /Target="xl\/workbook.xml"/);
  for (const [, target] of parts["xl/_rels/workbook.xml.rels"].matchAll(/Target="([^"]+)"/g)) {
    assert.ok("xl/" + target in parts, "workbook links to missing " + target);
  }

  // Styles: 1 is the date format, 3 two decimals.
  const xfs = [...parts["xl/styles.xml"].split("<cellXfs")[1].matchAll(/<xf numFmtId="(\d+)"/g)].map((m) => m[1]);
  assert.equal(xfs[1], "164");
  assert.match(parts["xl/styles.xml"], /numFmtId="164" formatCode="yyyy-mm-dd hh:mm:ss"/);
  assert.equal(xfs[3], "2");

  const rows = readSheet(parts["xl/worksheets/sheet1.xml"]);
  assert.equal(Object.keys(rows).length, 3, "a header and one row per reel");

  // Same columns, same order as the CSV.
  const header = Object.values(rows[1]).map((c) => c.v);
  assert.deepEqual(header, csvHeader);
  assert.deepEqual(header, ["code", "url", "views", "outlierScore", "likes", "comments", "createdAt", "isVideo", "caption"]);
  const cell = (r, name) => rows[r][String.fromCharCode(65 + header.indexOf(name))];

  // Numbers are numbers.
  assert.deepEqual(cell(2, "views"), { s: undefined, t: undefined, v: "2500000" });
  assert.deepEqual(cell(2, "likes"), { s: undefined, t: undefined, v: "120000" });
  assert.deepEqual(cell(3, "comments"), { s: undefined, t: undefined, v: "0" }, "zero is a number, not blank");
  assert.deepEqual(cell(2, "outlierScore"), { s: "3", t: undefined, v: "333.33" });
  // Dates are dates: a serial day number in the date style.
  const date = cell(2, "createdAt");
  assert.equal(date.s, "1");
  assert.equal(date.t, undefined);
  assert.equal(Math.round((Number(date.v) - 25569) * 86400000), Date.parse("2026-09-14T18:05:09.000Z"));
  // Links and captions are text.
  assert.deepEqual(cell(2, "url"), { s: undefined, t: "inlineStr", v: "https://www.instagram.com/p/AAA/" });
  assert.equal(cell(2, "code").t, "inlineStr");
  assert.equal(cell(2, "caption").v, 'Tom & "Jerry" <3  \u{1F525} Hindi: नमस्ते', "control character dropped");
  assert.deepEqual(cell(2, "isVideo"), { s: undefined, t: "b", v: "1" });
  // Missing values are empty cells, not "null" or 0.
  assert.equal(cell(3, "views"), undefined);
  assert.equal(cell(3, "outlierScore"), undefined);
  assert.equal(cell(3, "caption"), undefined);
  // The signed video link stays out, as in the CSV.
  assert.doesNotMatch(parts["xl/worksheets/sheet1.xml"], /cdn\.test/);
});

test("Excel: without outlier scores, no outlierScore column, as in the CSV", () => {
  const page = loadContent();
  page.result(posts);
  page.popup({ type: "export", kind: "xlsx" });
  const rows = readSheet(unzip(page.lastFile().data)["xl/worksheets/sheet1.xml"]);
  assert.deepEqual(
    Object.values(rows[1]).map((c) => c.v),
    ["code", "url", "views", "likes", "comments", "createdAt", "isVideo", "caption"]
  );
  assert.equal(Object.keys(rows).length, 4);
});

// ---- Google Sheets ----

test("Google Sheets gets the CSV export's text, columns and order, and nothing downloads", () => {
  const page = loadContent();
  assert.deepEqual({ ...page.popup({ type: "sheetsCsv" }) }, { ok: false }, "no sort yet");

  page.result(scored, { sortBy: "outlier", ranked: 1, median: 7500 });
  page.popup({ type: "export", kind: "csv" });
  const csv = page.lastFile().data;
  const downloads = page.document.querySelectorAll("a").length;

  const r = page.popup({ type: "sheetsCsv" });
  assert.equal(r.ok, true);
  assert.equal(r.username, "demo");
  assert.equal(r.count, 2);
  assert.equal("﻿" + r.csv, csv, "the CSV download, without its BOM");
  assert.equal(page.document.querySelectorAll("a").length, downloads, "no download");
});

// ---- The health log: every sort ----

const plainJSON = (x) => JSON.parse(JSON.stringify(x));

test("health log: every sort gets one entry, with what was asked, kept, left out, and why it stopped", () => {
  const page = loadContent();
  page.result(posts, {
    sortBy: "views", depth: 50, plan: "pro", ranked: 2, total: 5, hits: 4, responses: 31, unreadable: 1,
    reason: "end", codes: ["reels_missing_metric"], elapsedMs: 12400,
    stats: { reels: 20, foreign: 13, duplicates: 2, emptyReelsLists: 0, tooLarge: 0, unparsable: 0 },
    rules: { source: "content", version: 2, warning: null }
  });
  const e = plainJSON(page.store.health[0]);
  assert.ok(Date.parse(e.at) > 0);
  delete e.at;
  assert.deepEqual(e, {
    type: "sort", profile: "demo", plan: "pro", mode: "views", depth: 50,
    kept: 3, seen: 5, overDepth: 2, notProfile: 13, noAuthor: 1, duplicates: 2, unranked: 1,
    pages: 4, responses: 31, stop: "end", codes: ["reels_missing_metric"], seconds: 12,
    rules: "content v2", rulesWarning: null
  });
});

test("health log: a sort on the server's rules says so, e.g. remote v3", () => {
  const page = loadContent();
  page.result(posts, { sortBy: "views", reason: "end", rules: { source: "remote", version: 3, warning: null } });
  assert.equal(page.store.health[0].rules, "remote v3");
});

test("health log: empty, navigated-away and date sorts are logged too", () => {
  const empty = loadContent();
  empty.result([], { reason: "timeout", total: 0, codes: ["no_responses"] });
  assert.equal(empty.store.health.length, 1);
  assert.equal(empty.store.health[0].kept, 0);
  assert.deepEqual(plainJSON(empty.store.health[0].codes), ["no_responses"]);

  const gone = loadContent();
  gone.result(posts, { reason: "navigated" });
  assert.equal(gone.store.health[0].stop, "navigated");

  const byDate = loadContent();
  byDate.result(posts, { sortBy: "date", ranked: 0 });
  assert.equal(byDate.store.health[0].unranked, 0, "a date sort ranks every reel");
});

test("health log: newest first, the last 50 kept, other keys untouched", () => {
  const old = Array.from({ length: 50 }, (_, i) => ({ type: "sort", profile: "p" + i }));
  const page = loadContent({ store: { health: old.slice(), lastRun: { count: 1 } } });
  page.result(posts, {});
  assert.equal(page.store.health.length, 50);
  assert.equal(page.store.health[0].profile, "demo");
  assert.equal(page.store.health[49].profile, "p48", "the oldest one dropped");
});

test("health log: no reels, captions, links or tokens in it", () => {
  const page = loadContent({ store: { auth: { accessToken: "SECRET-TOKEN" } } });
  page.result(
    posts.map((p) => Object.assign({}, p, { caption: "a private caption", url: "https://www.instagram.com/p/" + p.code + "/" })),
    { reason: "end" }
  );
  const text = JSON.stringify(page.store.health);
  for (const p of posts) assert.ok(!text.includes(p.code), "no reel codes");
  assert.ok(!/caption|instagram\.com|SECRET-TOKEN/.test(text), text);
});

test("health log: the tab's console says whether each sort was saved", () => {
  const ok = loadContent();
  ok.result(posts, { reason: "end" });
  assert.ok(ok.logged.some((l) => /health log: sort saved \(3 reels, stop: end; 1 entries\)/.test(l)), ok.logged.join("\n"));

  const broken = loadContent({ storageError: "QUOTA_BYTES quota exceeded" });
  broken.result(posts, { reason: "end" });
  assert.ok(
    broken.logged.some((l) => /^WARN .*health log: couldn't save this sort .*QUOTA_BYTES/.test(l)),
    broken.logged.join("\n")
  );
  assert.equal(broken.store.health, undefined);
});

// ---- Error report offer ----

const REPORTABLE = ["no_responses", "responses_but_no_reels", "reels_but_none_from_profile", "reels_missing_metric"];
// A failed sort on a public profile, as collector.js posts it.
const failed = (code, extra) =>
  Object.assign({
    reason: "no_reels", total: 0, codes: [code], profilePrivate: false, responses: 14, scrolls: 11,
    elapsedMs: 31234, rules: { source: "content", version: 2, warning: null }
  }, extra);

test("report offer: made for each of the four codes on a public profile, with counts and versions only", () => {
  for (const code of REPORTABLE) {
    const page = loadContent();
    const withReels = code === "reels_missing_metric";
    page.result(withReels ? posts : [], failed(code, withReels ? { reason: "end", total: 3 } : {}));
    const offer = { ...page.store.sortState.report };
    assert.equal(typeof offer.id, "string", code);
    assert.equal(offer.id, page.store.sortState.loadId, "one offer per page load");
    delete offer.id;
    assert.deepEqual(offer, {
      reason: code, rulesSource: "builtin", rulesVersion: 2, responsesSeen: 14,
      postsFound: withReels ? 3 : 0, scrolls: 11, durationMs: 31234, arc: false
    }, code);
    assert.doesNotMatch(JSON.stringify(offer), /demo|instagram|R1/, "no profile, URL or reel");
  }
});

test("report offer: remote rules say so; the built-in fallback is version 0", () => {
  const remote = loadContent();
  remote.result([], failed("no_responses", { rules: { source: "remote", version: 3 } }));
  assert.equal(remote.store.sortState.report.rulesSource, "remote");
  assert.equal(remote.store.sortState.report.rulesVersion, 3);
  const fallback = loadContent();
  fallback.result([], failed("no_responses", { rules: { source: "builtin", version: 0 } }));
  assert.equal(fallback.store.sortState.report.rulesSource, "builtin");
  assert.equal(fallback.store.sortState.report.rulesVersion, 0);
  const none = loadContent();
  none.result([], failed("no_responses", { rules: null }));
  assert.equal(none.store.sortState.report.rulesVersion, 0);
});

// The profile's own reel thumbnails as Instagram links them, and others'.
const THUMBS = ["/demo/reel/A1/", "/demo/reel/A2/", "/demo/reel/A3/"];
const offered = (opts, extra) => {
  const page = loadContent(opts);
  page.result([], failed("responses_but_no_reels", extra));
  assert.ok(page.store.sortState.warning, "the failure itself always shows");
  return page.store.sortState.report;
};

test("report offer: is_private missing + the profile's thumbnails visible → offered", () => {
  for (const profilePrivate of [null, undefined]) {
    assert.ok(offered({ thumbs: THUMBS }, { profilePrivate }), String(profilePrivate));
  }
  // Absolute links, the /p/ and bare /reel/ forms, count too.
  assert.ok(offered({ thumbs: ["https://www.instagram.com/demo/reel/B1/", "/demo/p/B2/", "/reel/B3/"] }, { profilePrivate: null }));
});

test("report offer: is_private missing + no thumbnails, too few, or not the profile's → not offered", () => {
  const cases = {
    none: [],
    "two only": THUMBS.slice(0, 2),
    "the same reel three times": ["/demo/reel/A1/", "/demo/reel/A1/", "/demo/reel/A1/"],
    "another profile's": ["/other/reel/A1/", "/other/reel/A2/", "/other/reel/A3/"],
    "not reels": ["/demo/", "/demo/tagged/", "/explore/"]
  };
  for (const [name, thumbs] of Object.entries(cases)) {
    assert.equal(offered({ thumbs }, { profilePrivate: null }), null, name);
  }
});

test("report offer: is_private true → not offered, with or without thumbnails", () => {
  assert.equal(offered({ thumbs: [] }, { profilePrivate: true }), null);
  assert.equal(offered({ thumbs: THUMBS }, { profilePrivate: true }), null);
});

test("report offer: is_private false is enough on its own; anything but a boolean counts as unknown", () => {
  assert.ok(offered({ thumbs: [] }, { profilePrivate: false }));
  for (const profilePrivate of ["false", 0]) {
    assert.equal(offered({ thumbs: [] }, { profilePrivate }), null, String(profilePrivate));
  }
});

test("report offer: an empty profile is never offered, thumbnails or not", () => {
  for (const profilePrivate of [false, null]) {
    const page = loadContent({ thumbs: THUMBS });
    page.result([], failed("profile_has_no_reels", { profilePrivate }));
    assert.equal(page.store.sortState.report, null, String(profilePrivate));
  }
});

// ---- devForceFailure (testing the error report) ----

test("devForceFailure: off by default, a sort is left as it came", () => {
  const page = loadContent();
  page.result(posts, { reason: "complete", codes: [], profilePrivate: false });
  assert.equal(page.store.sortState.status, "done");
  assert.deepEqual(page.store.sortState.codes, []);
  assert.equal(page.store.sortState.report, null);
  assert.ok(page.$("ig-sorter-wrap"));
});

test("devForceFailure: the next sort ends with the code, offers the report, and the switch clears after one use", () => {
  const page = loadContent({ store: { devForceFailure: "reels_but_none_from_profile" } });
  page.result(posts, { reason: "complete", codes: [], profilePrivate: false, responses: 9, scrolls: 4 });
  const st = page.store.sortState;
  assert.equal(st.status, "stopped");
  assert.deepEqual([...st.codes], ["reels_but_none_from_profile"]);
  assert.equal(st.warning, "Couldn't read reels — Instagram may have changed something.");
  assert.equal(st.report.reason, "reels_but_none_from_profile");
  assert.equal(st.report.responsesSeen, 9, "the normal collection's own counts");
  assert.equal(page.$("ig-sorter-wrap"), null, "no sorted grid, as a real failure would have none");
  assert.ok(!("devForceFailure" in page.store), "removed from storage");
  assert.deepEqual([...page.store.health[0].codes], ["reels_but_none_from_profile"], "the health log records what was shown");
  // A plain log, so Chrome's Errors page doesn't list it as a bug.
  assert.ok(page.logged.some((l) => /^\[GridSorter\] devForceFailure: this sort ends with reels_but_none_from_profile/.test(l)), page.logged.join("\n"));
  assert.ok(!page.logged.some((l) => /^WARN .*devForceFailure/.test(l)), page.logged.join("\n"));

  // The next result on the same page is left alone.
  page.result(posts, { reason: "complete", codes: [], profilePrivate: false });
  assert.deepEqual(page.store.sortState.codes, []);
  assert.equal(page.store.sortState.report, null);
});

test("devForceFailure: a missing metric keeps the sorted grid and names the sort's metric", () => {
  const page = loadContent({ store: { devForceFailure: "reels_missing_metric" } });
  page.result(posts, { reason: "end", codes: [], sortBy: "likes", profilePrivate: false });
  assert.equal(page.store.sortState.warning, "Instagram isn't sending likes right now.");
  assert.equal(page.store.sortState.report.reason, "reels_missing_metric");
  assert.ok(page.$("ig-sorter-wrap"));
  assert.ok(!("devForceFailure" in page.store));
});

test("devForceFailure: any other value does nothing and stays; a run that never collected doesn't use it up", () => {
  for (const value of ["wrong_page", "profile_has_no_reels", true, "NO_RESPONSES"]) {
    const page = loadContent({ store: { devForceFailure: value } });
    page.result(posts, { reason: "complete", codes: [], profilePrivate: false });
    assert.deepEqual(page.store.sortState.codes, [], String(value));
    assert.equal(page.store.devForceFailure, value);
  }
  const page = loadContent({ store: { devForceFailure: "no_responses" } });
  page.result([], { reason: "wrong_page", codes: ["wrong_page"], total: 0 });
  assert.deepEqual(page.store.sortState.codes, ["wrong_page"]);
  assert.equal(page.store.devForceFailure, "no_responses", "still armed for the real sort");
});

test("report offer: never after success, a cancelled run, a plan limit, the wrong page or an empty profile", () => {
  const cases = {
    success: [posts, { reason: "complete", codes: [], profilePrivate: false }],
    "Free cap reached": [posts, { reason: "complete", codes: [], plan: "free", profilePrivate: false }],
    "left the Reels tab": [[], failed("no_responses", { reason: "navigated", codes: [] })],
    "left mid-run with a code": [[], failed("no_responses", { reason: "navigated" })],
    "wrong page": [[], failed("wrong_page", { reason: "wrong_page" })],
    "empty profile": [[], failed("profile_has_no_reels")],
    "time limit only": [posts, { reason: "timeout", codes: ["stopped_time_limit"], profilePrivate: false }]
  };
  for (const [name, [list, extra]] of Object.entries(cases)) {
    const page = loadContent();
    page.result(list, extra);
    assert.equal(page.store.sortState.report, null, name);
  }
});

test("report offer: a time-limited sort missing its metric is offered for the metric", () => {
  const page = loadContent();
  page.result(posts, failed("stopped_time_limit", {
    reason: "timeout", total: 3, codes: ["stopped_time_limit", "reels_missing_metric"]
  }));
  assert.equal(page.store.sortState.report.reason, "reels_missing_metric");
});

test("report offer: Arc is recognised by its page theme, for the worker to name it", () => {
  const style = (v) => () => ({ getPropertyValue: (k) => (k === "--arc-palette-title" ? v : "") });
  const arc = loadContent({ window: { getComputedStyle: style("#1d1d1f") } });
  arc.result([], failed("no_responses"));
  assert.equal(arc.store.sortState.report.arc, true);
  const chrome = loadContent({ window: { getComputedStyle: style("") } });
  chrome.result([], failed("no_responses"));
  assert.equal(chrome.store.sortState.report.arc, false);
});

test("report offer: the health log still keeps the profile name locally, and the offer never does", () => {
  const page = loadContent();
  page.result([], failed("no_responses"));
  assert.equal(page.store.health[0].profile, "demo");
  assert.ok(!("profile" in page.store.sortState.report));
});

// ---- On-page design: theme, progress pill, results header ----

// A page whose <body> and <html> have these computed backgrounds.
const themed = (body, html) => ({
  window: {
    getComputedStyle: (n) => ({
      backgroundColor: n.tagName === "BODY" ? body : html,
      getPropertyValue: () => ""
    })
  }
});

test("theme: the sorted view and dialogs follow Instagram's light or dark background", () => {
  const cases = [
    [{}, "light"], // nothing readable
    [themed("rgb(255, 255, 255)", "rgba(0, 0, 0, 0)"), "light"],
    [themed("rgb(0, 0, 0)", "rgba(0, 0, 0, 0)"), "dark"],
    [themed("rgb(18, 18, 18)", "rgb(255, 255, 255)"), "dark"],
    // A transparent body shows the root's background.
    [themed("rgba(0, 0, 0, 0)", "rgb(0, 0, 0)"), "dark"],
    [themed("transparent", "rgb(250, 250, 250)"), "light"]
  ];
  for (const [opts, want] of cases) {
    const page = loadContent(Object.assign({ onMessage: (m) => (m.type === "transcribe" ? { ok: false, needsPro: true } : undefined) }, opts));
    page.result(posts);
    const wrap = page.$("ig-sorter-wrap");
    assert.ok(wrap.hasAttribute("data-sortcut"), "the tokens apply under it");
    assert.equal(wrap.getAttribute("data-theme"), want, JSON.stringify(opts.window && opts.window.getComputedStyle({ tagName: "BODY" })));
    page.document.querySelector(".igs-tx").click();
    assert.equal(page.document.querySelector(".igs-modal").getAttribute("data-theme"), want);
  }
});

test("progress: the reload a sort started shows the pill at once, and the grid dims behind it", () => {
  const page = loadContent({ job: { sortBy: "views", limit: 100, tabId: 7 } });
  const pill = page.$("ig-sorter-progress");
  assert.ok(pill, "pill up before the first progress message");
  assert.match(pill.textContent, /^Collecting reels — don't scroll$/);
  assert.equal(page.$("grid").getAttribute("data-ig-sorter-dim"), "1");
  assert.equal(pill.querySelector(".igs-bar").querySelector("i").style.width, "0%");
});

test("progress: the collector's count and target move the pill; All reels has no target", () => {
  const page = loadContent({ job: { sortBy: "views", limit: 100, tabId: 7 } });
  page.post({ type: "progress", sortBy: "views", collected: 44, target: 100 });
  const pill = page.$("ig-sorter-progress");
  assert.equal(pill.textContent, "Collecting reels — don't scroll · 44 found");
  assert.equal(pill.querySelector(".igs-bar").querySelector("i").style.width, "44%");
  assert.equal(page.store.sortState.message, "Collecting reels… 44 of 100 so far.", "the popup's words unchanged");

  page.post({ type: "progress", sortBy: "views", collected: 120, target: null });
  assert.match(pill.textContent, /· 120 found$/);
  assert.ok(pill.querySelector(".igs-bar").classList.contains("is-open"));
  assert.equal(page.document.querySelectorAll("#ig-sorter-progress").length, 1, "one pill");
});

test("progress: the result takes the pill and the dimming away, sorted or not", () => {
  for (const got of [posts, []]) {
    const page = loadContent({ job: { sortBy: "views", limit: 100, tabId: 7 } });
    page.post({ type: "progress", sortBy: "views", collected: 3, target: 100 });
    page.result(got, got.length ? {} : { codes: ["no_responses"] });
    assert.equal(page.$("ig-sorter-progress"), null);
    assert.equal(page.document.querySelectorAll("[data-ig-sorter-dim]").length, 0);
  }
});

test("progress: leaving the profile mid-run takes the pill away", () => {
  const page = loadContent({ job: { sortBy: "views", limit: 100, tabId: 7 } });
  page.go("/someone.else/");
  assert.equal(page.$("ig-sorter-progress"), null);
  assert.equal(page.$("grid").hasAttribute("data-ig-sorter-dim"), false);
});

test("results header: the title names the sort; the median shows only for outlier sorts", () => {
  const head = (page) => ({
    title: page.document.querySelector(".igs-title").textContent,
    sub: page.document.querySelector(".igs-sub").textContent
  });
  const views = loadContent();
  views.result(posts);
  assert.deepEqual(head(views), { title: "Top reels by views", sub: "3 reels" });

  const likes = loadContent();
  likes.result(posts, { sortBy: "likes", ranked: 2 });
  assert.deepEqual(head(likes), { title: "Top reels by likes", sub: "3 reels · 1 with no likes" });

  const scored = posts.map((p, i) => Object.assign({}, p, { outlierScore: [4.2, 1, 0.5][i] }));
  const out = loadContent();
  out.result(scored, { sortBy: "outlier", median: 12400 });
  assert.deepEqual(head(out), { title: "Outlier reels by views", sub: "3 reels · median 12.4K views" });
  assert.deepEqual(out.document.querySelectorAll(".igs-score").map((b) => b.textContent), ["4.2x"], "above the median only");
  assert.ok(out.document.querySelector(".igs-cell").classList.contains("igs-top"), "#1 gets the ring");
  assert.equal(out.document.querySelectorAll(".igs-top").length, 1);
});

test("results header: Export offers the popup's four exports, through the same functions", () => {
  const page = loadContent({ onMessage: (m) => (m.type === "sheetsExport" ? { ok: true, url: "x" } : undefined) });
  page.result(posts);
  const menu = page.document.querySelector(".igs-menu");
  const toggle = page.document.querySelector("[aria-haspopup]");
  assert.equal(toggle.textContent, "Export");
  assert.equal(menu.hidden, true);
  toggle.click();
  assert.equal(menu.hidden, false);
  const items = menu.querySelectorAll(".igs-menu-item");
  assert.deepEqual(items.map((b) => b.textContent), ["CSV", "JSON", "Excel", "Google Sheets"]);

  items[0].click();
  assert.equal(page.lastFile().name, "demo-sorted.csv");
  assert.equal(menu.hidden, true, "a pick closes the menu");
  items[2].click();
  assert.equal(page.lastFile().name, "demo-sorted.xlsx");

  items[3].click();
  assert.deepEqual({ ...page.sent.find((m) => m.type === "sheetsExport") }, { type: "sheetsExport", tabId: 7 });
  assert.equal(page.document.querySelector(".igs-note").textContent, "Opened in Google Sheets.");
});

test("results header: a Sheets export the worker refuses says why", () => {
  const error = "Sign in to export to Google Sheets. CSV and Excel work without signing in.";
  const page = loadContent({ onMessage: (m) => (m.type === "sheetsExport" ? { ok: false, error } : undefined) });
  page.result(posts);
  page.document.querySelector(".igs-menu").querySelectorAll(".igs-menu-item")[3].click();
  const note = page.document.querySelector(".igs-note");
  assert.equal(note.textContent, error);
  assert.ok(note.classList.contains("is-bad"));
});


// ---- Transcription on the page: the pill, then the result card ----

const HINDI = {
  text: "Namaste doston, aaj hum baat karenge",
  original: "नमस्ते दोस्तों, आज हम बात करेंगे",
  language: "hi",
  romanised: true
};
const ENGLISH = { text: "Hello everyone", original: null, language: "en", romanised: false };
// Every download so far: the anchors content.js clicked (kept, since the
// cleanup timer is held).
const downloads = (page) => page.document.querySelectorAll("a").filter((a) => a.download);
// A page whose worker holds every transcription until the test answers it.
const holding = (opts) => loadContent(Object.assign({ onMessage: () => undefined }, opts));
const step = (page) => page.$("ig-sorter-tx-progress").querySelector(".igs-tx-step").textContent;
const sortedGrid = (page) => page.document.querySelector(".igs-grid");

test("transcribing: the sort's pill and dimmed grid, with the worker's current step", () => {
  const page = holding();
  page.result(posts);
  const btn = page.document.querySelector(".igs-tx");
  btn.click();

  const pill = page.$("ig-sorter-tx-progress");
  assert.ok(pill, "pill up");
  assert.ok(pill.classList.contains("igs-pill"), "the sort's pill");
  assert.ok(pill.hasAttribute("data-sortcut"));
  assert.equal(step(page), "Transcribing…");
  assert.ok(pill.querySelector(".igs-bar").classList.contains("is-open"), "a thin moving bar");
  assert.equal(sortedGrid(page).getAttribute("data-ig-sorter-dim"), "1", "the grid dims behind it");
  assert.ok(btn.classList.contains("is-busy"));

  for (const label of ["Downloading reel…", "Uploading…", "Waiting in queue…", "Transcribing…"]) {
    page.popup({ type: "transcribeProgress", code: "R1", label });
    assert.equal(step(page), label);
    assert.equal(btn.getAttribute("aria-label"), label);
  }
  assert.equal(page.document.querySelectorAll("#ig-sorter-tx-progress").length, 1, "one pill");
});

test("transcribing: no Keep browsing; the pill stays until the last job ends", () => {
  const page = holding();
  page.result(posts);
  const [first, second] = page.document.querySelectorAll(".igs-tx");
  first.click();
  const pill = page.$("ig-sorter-tx-progress");
  assert.equal(pill.querySelectorAll("button").length, 0, "no way to wave it off");
  assert.doesNotMatch(pill.textContent, /Keep browsing/);

  second.click();
  assert.match(pill.textContent, /· 2 reels/);
  page.answer("transcribe", { ok: true, result: ENGLISH }); // R1
  assert.ok(page.$("ig-sorter-tx-progress"), "R2 still running");
  assert.equal(sortedGrid(page).getAttribute("data-ig-sorter-dim"), "1");
  assert.ok(first.classList.contains("is-done"));
  assert.ok(second.classList.contains("is-busy"));

  page.answer("transcribe", { ok: true, result: ENGLISH }); // R2
  assert.equal(page.$("ig-sorter-tx-progress"), null);
  assert.equal(sortedGrid(page).hasAttribute("data-ig-sorter-dim"), false);
});

test("transcript ready: a result card, and nothing downloads without a click", () => {
  const page = holding();
  page.result(posts);
  const btn = page.document.querySelector(".igs-tx");
  btn.click();
  page.answer("transcribe", { ok: true, result: HINDI });

  assert.equal(downloads(page).length, 0, "no automatic download");
  assert.equal(page.$("ig-sorter-tx-progress"), null, "the pill goes");
  assert.equal(sortedGrid(page).hasAttribute("data-ig-sorter-dim"), false);

  const card = page.document.querySelector(".igs-result");
  assert.ok(card, "card shown");
  assert.ok(!card.classList.contains("is-bad"));
  assert.equal(card.getAttribute("role"), "dialog");
  assert.equal(card.querySelector("h2").textContent, "Transcript");
  assert.equal(card.querySelector(".igs-result-sub").textContent, "R1 · Hindi → Hinglish");
  const panes = card.querySelector(".igs-tx-panes");
  const [main, original] = panes.querySelectorAll(".igs-tx-pane");
  assert.equal(main.querySelector(".igs-tx-text").textContent, HINDI.text);
  assert.equal(main.hidden, false);
  assert.equal(original.querySelector(".igs-tx-text").textContent, HINDI.original);
  assert.equal(original.hidden, true, "the original script waits for its toggle");
  assert.ok(!panes.classList.contains("is-split"));
  assert.ok(!card.classList.contains("is-wide"));

  // Shown beside the transcript, not under it: two columns, a wider card.
  const toggle = card.querySelector(".igs-link");
  assert.equal(toggle.textContent, "Show original script");
  toggle.click();
  assert.equal(original.hidden, false);
  assert.ok(panes.classList.contains("is-split"), "side by side");
  assert.ok(card.classList.contains("is-wide"));
  assert.deepEqual(panes.querySelectorAll(".igs-pane-label").map((l) => l.textContent), ["Hinglish", "Original script"]);
  assert.equal(toggle.textContent, "Hide original script");
  toggle.click();
  assert.equal(original.hidden, true);
  assert.ok(!panes.classList.contains("is-split"));
  assert.ok(!card.classList.contains("is-wide"));
  assert.equal(downloads(page).length, 0, "still nothing downloaded");
  assert.equal(page.store.transcribeStatus.ok, true);
  assert.equal(page.store.transcribeStatus.text, "Transcript ready (Hindi → Hinglish).");

  // Closing without downloading downloads nothing.
  card.querySelector(".igs-x").click();
  assert.equal(page.document.querySelector(".igs-result"), null);
  assert.equal(downloads(page).length, 0);
});

test("transcript ready: Download .txt saves the same file as before", () => {
  const page = holding();
  page.result(posts);
  page.document.querySelector(".igs-tx").click();
  page.answer("transcribe", { ok: true, result: HINDI });

  const buttons = page.document.querySelector(".igs-result-actions").querySelectorAll("button");
  assert.deepEqual(buttons.map((b) => b.textContent), ["Copy text", "Download .txt"]);
  buttons[1].click();
  assert.equal(downloads(page).length, 1);
  const f = page.lastFile();
  assert.equal(f.name, "demo-R1.txt");
  assert.equal(f.type, "text/plain");
  const lines = f.data.split("\n");
  assert.deepEqual(lines.slice(0, 4), [
    "Instagram transcript",
    "URL:       https://www.instagram.com/p/R1/",
    "Posted:    2026-10-01T00:00:00Z",
    "Language:  hi (romanised to Latin script)"
  ]);
  assert.match(lines[4], /^Generated: \d{4}-\d\d-\d\dT[\d:.]+Z$/);
  assert.deepEqual(lines.slice(5), [
    "", HINDI.text, "", "--- original script ---", "", HINDI.original, ""
  ]);
  assert.ok(page.document.querySelector(".igs-result"), "the card stays open");
});

test("transcript ready: Copy text copies the transcript and says Copied ✓ for 2 seconds", async () => {
  const copied = [];
  const page = holding({
    window: { navigator: { clipboard: { writeText: (t) => (copied.push(t), Promise.resolve()) } } }
  });
  page.result(posts);
  page.document.querySelector(".igs-tx").click();
  page.answer("transcribe", { ok: true, result: HINDI });

  const copy = page.document.querySelector(".igs-result-actions").querySelector(".igs-primary");
  copy.click();
  await settle();
  assert.deepEqual(copied, [HINDI.text], "the main transcript, not the original");
  assert.equal(copy.textContent, "Copied ✓");
  page.fireTimers(2000);
  assert.equal(copy.textContent, "Copy text");
  assert.equal(downloads(page).length, 0);
});

test("transcript ready: no original, no toggle; the language alone when not romanised", () => {
  const page = holding();
  page.result(posts);
  page.document.querySelector(".igs-tx").click();
  page.answer("transcribe", { ok: true, result: ENGLISH });
  const card = page.document.querySelector(".igs-result");
  assert.equal(card.querySelector(".igs-result-sub").textContent, "R1 · English");
  assert.equal(card.querySelector(".igs-link"), null);
  assert.equal(card.querySelectorAll(".igs-tx-text").length, 1);
});

test("result card: Escape closes it", () => {
  const page = holding();
  page.result(posts);
  const btn = page.document.querySelector(".igs-tx");
  btn.click();
  page.answer("transcribe", { ok: true, result: ENGLISH });
  assert.ok(page.document.querySelector(".igs-result"));
  page.document.dispatchEvent({ type: "keydown", key: "Escape" });
  assert.equal(page.document.querySelector(".igs-result"), null);
  assert.equal(page.document.activeElement, btn, "focus back on the reel's button");
});

test("several transcriptions: each opens its own card when it finishes, one at a time", () => {
  const page = holding();
  page.result(posts);
  const [a, b, c] = page.document.querySelectorAll(".igs-tx");
  a.click();
  b.click();
  c.click();
  assert.match(page.$("ig-sorter-tx-progress").textContent, /· 3 reels/);

  page.answer("transcribe", { ok: true, result: ENGLISH }); // R1
  page.answer("transcribe", { ok: false, error: "No speech was detected in this reel. No credit was used." }); // R2
  assert.match(page.$("ig-sorter-tx-progress").textContent, /^Transcribing…/, "R3 still running");
  const cards = () => page.document.querySelectorAll(".igs-result");
  assert.equal(cards().length, 1, "one card at a time");
  assert.equal(cards()[0].querySelector(".igs-result-sub").textContent, "R1 · English");

  page.answer("transcribe", { ok: true, result: HINDI }); // R3
  assert.equal(page.$("ig-sorter-tx-progress"), null);

  cards()[0].querySelector(".igs-x").click();
  assert.equal(cards().length, 1);
  assert.ok(cards()[0].classList.contains("is-bad"), "then R2's failure");
  assert.match(cards()[0].textContent, /No speech was detected/);

  page.document.dispatchEvent({ type: "keydown", key: "Escape" });
  assert.equal(cards()[0].querySelector(".igs-result-sub").textContent, "R3 · Hindi → Hinglish");
  cards()[0].querySelector(".igs-x").click();
  assert.equal(cards().length, 0);
  assert.equal(downloads(page).length, 0, "and none of them downloaded anything");
});

// ---- Similar accounts (Pro) ----

const DIRECTORY = {
  version: 3,
  niches: [
    { name: "Fitness", count: 4, filters: [{ name: "Yoga", count: 2 }, { name: "Strength", count: 2 }] },
    { name: "Food", count: 2, filters: [{ name: "Vegan", count: 2 }] }
  ],
  accounts: [
    { niche: "Fitness", username: "zoe.lifts", fullName: "Zoe Park", filter: "Strength", topics: "powerlifting, form tips" },
    // The profile the test page is on (/demo/reels/).
    { niche: "Fitness", username: "Demo", fullName: "Demo Self", filter: "Yoga", topics: "stretching" },
    { niche: "Fitness", username: "amy_yoga", fullName: "Amy Lee", filter: "Yoga", topics: "morning flows" },
    { niche: "Fitness", username: "Bob.Strong", fullName: "", filter: "Strength", topics: "deadlifts" },
    { niche: "Food", username: "vegchef", fullName: "Veg Chef", filter: "Vegan", topics: "meal prep" },
    { niche: "Food", username: "plantplate", fullName: "Plant Plate", filter: "Vegan", topics: "yoga snacks" }
  ]
};

// A Pro page with a sorted grid. The panel's directory request is held for
// the test to answer unless opts.directory gives the reply.
function proPage(opts) {
  opts = opts || {};
  const page = loadContent(Object.assign({
    pro: true,
    onMessage: (msg) => (msg.type === "directory" ? opts.directory : undefined)
  }, opts));
  page.result(posts);
  return page;
}

function openPanel(page) {
  page.document.querySelector(".igs-similar").click();
  return panel(page);
}

// The panel's closed shadow root, or null when it's not open.
function panel(page) {
  const host = page.$("ig-sorter-similar");
  return host ? host._shadowRoot : null;
}

const listed = (root) => root.querySelectorAll(".user").map((n) => n.textContent);
const chipsOf = (root) =>
  root.querySelectorAll(".chip").map((c) => [c.textContent, c.getAttribute("aria-pressed")]);
const typeInto = (input, value) => {
  input.value = value;
  input.dispatchEvent({ type: "input" });
};
const choose = (select, value) => {
  select.value = value;
  select.dispatchEvent({ type: "change" });
};

test("similar accounts: no button on Free or signed out; the worker's word decides", () => {
  const free = loadContent();
  free.result(posts);
  assert.equal(free.proAsks.length, 1, "asked once, with the header");
  assert.equal(free.document.querySelector(".igs-similar"), null);

  const signedOut = loadContent({ proReply: { ok: false, signedOut: true, error: "Your session has ended." } });
  signedOut.result(posts);
  assert.equal(signedOut.document.querySelector(".igs-similar"), null);

  const noWorker = loadContent({ proReply: null });
  noWorker.result(posts);
  assert.equal(noWorker.document.querySelector(".igs-similar"), null);
});

test("similar accounts: on Pro, a secondary button with a people icon, left of Restore original", () => {
  const page = proPage();
  const actions = page.document.querySelector(".igs-actions");
  const [first, second] = actions.children;
  assert.ok(first.classList.contains("igs-similar"));
  assert.ok(first.classList.contains("igs-ghost"), "secondary, like Restore");
  assert.equal(first.textContent, "Similar accounts");
  assert.ok(first.querySelector("svg"), "icon");
  assert.equal(second.textContent, "Restore original");
  assert.deepEqual(page.sent.map((m) => m.type), [], "the list isn't fetched until the panel opens");
});

test("similar accounts: loading skeleton, then this profile's niche, A to Z, without this profile", () => {
  const page = proPage();
  const root = openPanel(page);
  const host = page.$("ig-sorter-similar");
  assert.ok(host.hasAttribute("data-sortcut"), "the tokens reach in from the host");
  assert.equal(host.getAttribute("data-theme"), "light");
  assert.equal(root.mode, "closed");
  assert.equal(page.document.querySelector(".drawer"), null, "nothing of it in the page's own DOM");
  assert.equal(root.querySelector(".drawer").getAttribute("role"), "dialog");
  assert.equal(root.querySelector("h2").textContent, "Similar accounts");
  assert.ok(root.querySelectorAll(".sk").length > 0, "skeleton while loading");
  assert.equal(root.querySelector(".controls").hidden, true);
  assert.deepEqual(page.sent.map((m) => m.type), ["directory"]);

  page.answer("directory", { ok: true, directory: DIRECTORY });
  assert.equal(root.querySelectorAll(".sk").length, 0);
  const select = root.querySelector("select");
  assert.equal(select.value, "Fitness", "the niche of @demo, the profile this page is on");
  assert.deepEqual(select.querySelectorAll("option").map((o) => o.textContent), ["Fitness (3)", "Food (2)"]);
  assert.deepEqual(chipsOf(root), [["All3", "true"], ["Yoga1", "false"], ["Strength2", "false"]]);
  assert.deepEqual(listed(root), ["@amy_yoga", "@Bob.Strong", "@zoe.lifts"]);
  assert.equal(root.querySelector(".count").textContent, "3 accounts");

  const [amy, bob] = root.querySelectorAll(".card");
  assert.equal(amy.querySelector(".avatar").textContent, "A", "first letter of the full name");
  assert.equal(bob.querySelector(".avatar").textContent, "B", "else of the username");
  assert.equal(amy.querySelector(".name").textContent, "Amy Lee");
  assert.equal(bob.querySelector(".name"), null, "no empty name line");
  assert.equal(amy.querySelector(".tag").textContent, "Yoga");
  assert.equal(amy.querySelector(".topics").textContent, "morning flows");
  assert.deepEqual(amy.querySelectorAll("button").map((b) => b.textContent), ["Open profile", "Sort reels"]);
});

test("similar accounts: filter chips, the search, and another niche", () => {
  const page = proPage({ directory: { ok: true, directory: DIRECTORY } });
  const root = openPanel(page);
  const input = root.querySelector("input");

  root.querySelectorAll(".chip")[2].click(); // Strength
  assert.deepEqual(chipsOf(root).map((c) => c[1]), ["false", "false", "true"]);
  assert.deepEqual(listed(root), ["@Bob.Strong", "@zoe.lifts"]);
  assert.equal(root.querySelector(".count").textContent, "2 accounts");

  typeInto(input, "FORM");
  assert.deepEqual(listed(root), ["@zoe.lifts"], "topics, ignoring case");
  assert.equal(root.querySelector(".count").textContent, "1 account");
  typeInto(input, "bob.");
  assert.deepEqual(listed(root), ["@Bob.Strong"], "username");

  root.querySelectorAll(".chip")[0].click(); // All
  typeInto(input, "amy lee");
  assert.deepEqual(listed(root), ["@amy_yoga"], "full name");
  typeInto(input, "@zoe");
  assert.deepEqual(listed(root), ["@zoe.lifts"], "a leading @ is ignored");
  typeInto(input, "demo");
  assert.deepEqual(listed(root), [], "this profile never shows, even searched for");
  assert.equal(root.querySelector(".state").textContent, "No accounts match");
  assert.equal(root.querySelector(".count").textContent, "0 accounts");

  typeInto(input, "");
  choose(root.querySelector("select"), "Food");
  assert.deepEqual(chipsOf(root), [["All2", "true"], ["Vegan2", "false"]], "the chip goes back to All");
  assert.deepEqual(listed(root), ["@plantplate", "@vegchef"]);
  assert.equal(page.store.similarNiche, "Food", "remembered");
  typeInto(input, "yoga");
  assert.deepEqual(listed(root), ["@plantplate"], "only within the niche");
});

test("similar accounts: elsewhere, the last niche chosen, else the first", () => {
  const at = (pathname, store) => {
    const page = proPage({
      directory: { ok: true, directory: DIRECTORY },
      store,
      window: { location: { href: "https://www.instagram.com" + pathname, pathname, reload() {} } }
    });
    return openPanel(page).querySelector("select").value;
  };
  assert.equal(at("/someone/reels/", { similarNiche: "Food" }), "Food");
  assert.equal(at("/someone/reels/", {}), "Fitness");
  assert.equal(at("/someone/reels/", { similarNiche: "Gone" }), "Fitness", "a niche no longer listed");
  assert.equal(at("/demo/reels/", { similarNiche: "Food" }), "Fitness", "this profile's niche comes first");
  assert.equal(at("/vegchef/reels/", {}), "Food");
});

test("similar accounts: each avatar's colour comes from its username, the same every time", () => {
  const colours = () => {
    const page = proPage({ directory: { ok: true, directory: DIRECTORY } });
    return openPanel(page).querySelectorAll(".avatar").map((a) => a.style.getPropertyValue("background"));
  };
  const first = colours();
  assert.deepEqual(colours(), first);
  first.forEach((c) => assert.match(c, /^#[0-9A-F]{6}$/i));
});

test("similar accounts: untrusted text stays text, and a username unfit for a link isn't listed", () => {
  const evil = {
    version: 1,
    niches: [{ name: "X", count: 3, filters: [{ name: "Y", count: 3 }] }],
    accounts: [
      { niche: "X", username: "ok_user", fullName: "<img src=x onerror=alert(1)>", filter: "Y", topics: "<b>hi</b>" },
      { niche: "X", username: "../evil", fullName: "Evil", filter: "Y", topics: "" },
      { niche: "X", username: "a b", fullName: "Space", filter: "Y", topics: "" }
    ]
  };
  const page = proPage({ directory: { ok: true, directory: evil } });
  const root = openPanel(page);
  assert.deepEqual(listed(root), ["@ok_user"]);
  const card = root.querySelector(".card");
  assert.equal(card.querySelector(".name").textContent, "<img src=x onerror=alert(1)>");
  assert.equal(card.querySelectorAll("img").length, 0);
  assert.equal(card.querySelector(".topics").textContent, "<b>hi</b>");
});

test("similar accounts: Open profile opens a new tab", () => {
  const page = proPage({ directory: { ok: true, directory: DIRECTORY } });
  const root = openPanel(page);
  root.querySelectorAll(".card")[2].querySelectorAll("button")[0].click(); // zoe.lifts
  assert.deepEqual(page.opened, [["https://www.instagram.com/zoe.lifts/", "_blank", "noopener"]]);
  assert.equal(page.store.pendingSort, undefined, "no sort for a plain open");
});

test("similar accounts: Sort reels leaves this page's sort and depth for the new Reels tab, for 60 s", () => {
  const job = { sortBy: "outlierLikes", limit: 200, maxReels: null, tabId: 7, plan: "pro" };
  const page = proPage({ job, directory: { ok: true, directory: DIRECTORY } });
  const root = openPanel(page);
  const before = Date.now();
  root.querySelectorAll(".card")[1].querySelectorAll("button")[1].click(); // Bob.Strong
  const p = page.store.pendingSort;
  assert.deepEqual(
    { username: p.username, sortBy: p.sortBy, limit: p.limit, maxReels: p.maxReels },
    { username: "bob.strong", sortBy: "outlierLikes", limit: 200, maxReels: null }
  );
  assert.ok(p.expiresAt >= before + 60000 && p.expiresAt <= Date.now() + 60000, "expires in 60 s");
  assert.deepEqual(page.opened, [["https://www.instagram.com/Bob.Strong/reels/", "_blank", "noopener"]]);
});

test("similar accounts: closed by ×, Escape or a click beside it, focus back on the button", () => {
  const page = proPage({ directory: { ok: true, directory: DIRECTORY } });
  const btn = page.document.querySelector(".igs-similar");

  openPanel(page).querySelector(".igs-x").click();
  assert.equal(panel(page), null);
  assert.equal(page.document.activeElement, btn);

  openPanel(page);
  page.document.dispatchEvent({ type: "keydown", key: "Escape" });
  assert.equal(panel(page), null);

  openPanel(page).querySelector(".scrim").click();
  assert.equal(panel(page), null);

  openPanel(page);
  page.document.querySelectorAll(".igs-ghost").find((b) => b.textContent === "Restore original").click();
  assert.equal(panel(page), null, "Restore original closes it too");
});

test("similar accounts: a failed fetch says so in plain words, and Retry tries again", () => {
  const page = proPage();
  const root = openPanel(page);
  page.answer("directory", { ok: false, error: "Couldn't reach Sortcut. Check your connection and try again." });
  const state = root.querySelector(".state");
  assert.ok(state.classList.contains("is-bad"));
  assert.match(state.textContent, /^Couldn't reach Sortcut\. Check your connection and try again\.Retry$/);
  assert.equal(root.querySelector(".controls").hidden, true);

  state.querySelector("button").click();
  assert.ok(root.querySelectorAll(".sk").length > 0, "loading again");
  assert.deepEqual(page.sent.map((m) => m.type), ["directory", "directory"]);
  page.answer("directory", { ok: true, directory: DIRECTORY });
  assert.deepEqual(listed(root), ["@amy_yoga", "@Bob.Strong", "@zoe.lifts"]);

  const noWorker = proPage({ directory: null });
  assert.match(openPanel(noWorker).querySelector(".state").textContent, /Extension worker unavailable/);
});

test("similar accounts: not Pro after all (402), the panel closes for the Upgrade dialog", () => {
  const page = proPage({ directory: { ok: false, needsPro: true, error: "Similar accounts is part of Sortcut Pro." } });
  openPanel(page);
  assert.equal(panel(page), null, "closed");
  const dialog = page.document.querySelector(".igs-dialog");
  assert.ok(dialog, "the Upgrade dialog");
  assert.equal(dialog.querySelector("#igs-dialog-text").textContent, "Similar accounts is part of Sortcut Pro.");
  assert.equal(dialog.querySelector(".igs-btn").textContent, "Upgrade to Pro");
  assert.equal(page.document.querySelector(".igs-similar"), null, "and the button goes");
  dialog.querySelector(".igs-btn").click();
  assert.deepEqual(page.opened, [[PRICING, "_blank", "noopener"]]);
});

// ---- The pending sort, in the tab Sort reels opened ----

function reelsTab(pathname, pendingSort) {
  let reloads = 0;
  const page = loadContent({
    store: pendingSort === undefined ? {} : { pendingSort },
    window: {
      location: { href: "https://www.instagram.com" + pathname, pathname, reload() { reloads++; } }
    }
  });
  page.reloads = () => reloads;
  return page;
}

const pending = (extra) =>
  Object.assign({ username: "zoe.lifts", sortBy: "likes", limit: 50, maxReels: null, expiresAt: Date.now() + 30000 }, extra);

test("pending sort: the right profile's Reels tab starts it, once", () => {
  const page = reelsTab("/Zoe.Lifts/reels/", pending());
  assert.equal(page.reloads(), 1, "reloaded to arm the interceptor, as a popup sort does");
  assert.deepEqual(page.job(), { sortBy: "likes", limit: 50, maxReels: null, tabId: 7, plan: "pro" });
  assert.equal(page.store.pendingSort, undefined, "used up");
  assert.equal(page.store.sortState.status, "running");

  const again = reelsTab("/zoe.lifts/reels/", page.store.pendingSort);
  assert.equal(again.reloads(), 0, "a second load finds nothing to start");
  assert.equal(again.job(), null);
});

test("pending sort: another profile, or not the Reels tab, leaves it for its own tab", () => {
  for (const path of ["/someone/reels/", "/zoe.lifts/", "/zoe.lifts/reel/ABC/", "/zoe.lifts.x/reels/"]) {
    const p = pending();
    const page = reelsTab(path, p);
    assert.equal(page.reloads(), 0, path);
    assert.equal(page.job(), null, path);
    assert.deepEqual(page.store.pendingSort, p, path + " keeps it");
  }
});

test("pending sort: expires after 60 s; one set further ahead than that counts as expired", () => {
  for (const expiresAt of [Date.now() - 1, Date.now() + 120000, "soon", undefined]) {
    const page = reelsTab("/zoe.lifts/reels/", pending({ expiresAt }));
    assert.equal(page.reloads(), 0, String(expiresAt));
    assert.equal(page.job(), null);
    assert.equal(page.store.pendingSort, undefined, "dropped");
  }
});

test("pending sort: an unknown sort or depth is dropped, never run", () => {
  for (const bad of [{ sortBy: "followers" }, { limit: 0 }, { limit: "lots" }]) {
    const page = reelsTab("/zoe.lifts/reels/", pending(bad));
    assert.equal(page.reloads(), 0, JSON.stringify(bad));
    assert.equal(page.store.pendingSort, undefined);
  }
});

test("pending sort: a load that is already a sort's reload doesn't take one", () => {
  let reloads = 0;
  const page = loadContent({
    store: { pendingSort: pending({ username: "demo" }) },
    job: { sortBy: "views", limit: 100, maxReels: null, tabId: 7, plan: "pro" },
    window: { location: { href: "https://www.instagram.com/demo/reels/", pathname: "/demo/reels/", reload() { reloads++; } } }
  });
  assert.equal(reloads, 0);
  assert.equal(page.job().sortBy, "views");
  assert.ok(page.store.pendingSort, "left alone");
});
