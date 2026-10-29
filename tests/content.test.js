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
              ["div", { id: "row1" }, ...reelLinks(4)],
              ["div", { id: "row2" }, ...reelLinks(4)]],
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
  const ticks = [];
  const opened = [];
  const files = [];
  const unanswered = [];
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
        set(o) { Object.assign(store, o); },
        remove(k) { [].concat(k).forEach((key) => delete store[key]); }
      },
      onChanged: { addListener() {} }
    }
  };

  const w = {
    document,
    MutationObserver,
    chrome,
    console: { log() {}, warn() {} },
    location: { href: "https://www.instagram.com/demo/reels/", pathname: "/demo/reels/", reload() {} },
    sessionStorage: {
      getItem: (k) => (k === "igSorterJob" ? job : null),
      setItem: (k, v) => { if (k === "igSorterJob") job = v; },
      removeItem: (k) => { if (k === "igSorterJob") job = null; }
    },
    // The profile watcher's tick, run by the test with page.tick().
    setInterval: (fn) => (ticks.push(fn), ticks.length),
    // The 4s return-to-idle timer and the download cleanup never need to fire.
    setTimeout: () => 0,
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

test("failure: a dismissible card on the reel and the same words in storage for the popup", () => {
  const text = "This reel can't be transcribed — it's about 31 MB, over our current 24 MB limit. No credit was used.";
  const page = loadContent({
    onMessage: (msg) => (msg.type === "transcribe" ? { ok: false, error: text } : undefined)
  });
  page.result(posts);

  const btn = page.document.querySelectorAll(".igs-tx")[1];
  btn.click();

  const cell = btn.parentElement.parentElement;
  const card = cell.querySelector(".igs-card");
  assert.ok(card, "card shown");
  assert.equal(card.querySelector(".igs-card-msg").textContent, text);
  assert.equal(page.store.transcribeStatus.text, text);
  assert.equal(page.store.transcribeStatus.ok, false);
  assert.equal(page.store.transcribeStatus.code, "R2");
  // Only that reel.
  assert.equal(page.document.querySelectorAll(".igs-card").length, 1);

  card.querySelector(".igs-x").click();
  assert.equal(cell.querySelector(".igs-card"), null, "dismissed");

  // A retry clears an old card before it starts.
  btn.click();
  assert.equal(page.document.querySelectorAll(".igs-card").length, 1);
});

test("failure: a worker that never answers still gets a card", () => {
  const page = loadContent({ onMessage: () => null });
  page.result(posts);
  page.document.querySelector(".igs-tx").click();
  const card = page.document.querySelector(".igs-card");
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
  assert.equal(page.document.querySelector(".igs-card"), null, "signed out isn't a failure card");
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
  assert.equal(page.document.querySelector(".igs-modal"), null, "dialog closed");
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
  assert.equal(page.document.querySelector(".igs-card"), null);
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
  assert.equal(page.document.querySelector(".igs-card"), null, "not a failure card");
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
  assert.equal(page.document.querySelector(".igs-card"), null);
});

// ---- Free: the sorted grid says it's the recent reels ----

test("a Free run's grid says how far back it reaches", () => {
  const page = loadContent();
  page.result(posts, { days: 50 });
  assert.match(page.$("ig-sorter-wrap").textContent, /· last 50 days/);
  assert.equal(page.store.sortState.days, 50);
});

// ---- Sort state: no summary, only warnings, tied to this page ----

test("a finished sort leaves no summary for the popup, only that it's done", () => {
  for (const reason of ["complete", "end", "past_range", "stalled"]) {
    const page = loadContent();
    page.result(posts, { days: 50, reason });
    assert.equal(page.store.sortState.warning, null, reason);
    assert.equal(page.store.sortState.message, undefined, reason);
    assert.equal(page.store.sortState.count, 3);
  }
});

test("a Free run with only older reels warns that none were recent, not that Instagram broke", () => {
  for (const reason of ["past_range", "end", "stalled", "timeout"]) {
    const page = loadContent();
    page.result([], { days: 50, reason, seen: 4, total: 0 });
    assert.equal(page.store.sortState.warning, "No reels from the last 50 days.", reason);
  }
});

test("warnings: couldn't read reels, and the time limit", () => {
  const unread = loadContent();
  unread.result([], { reason: "no_reels", unreadable: 5, total: 0 });
  assert.equal(unread.store.sortState.warning, "Couldn't read reels — Instagram may have changed something.");

  const late = loadContent();
  late.result(posts, { reason: "timeout", limitMs: 3 * 60 * 1000 });
  assert.equal(late.store.sortState.status, "stopped");
  assert.equal(late.store.sortState.warning, "Stopped at the 3-minute time limit — sorted the 3 reels collected by then.");
});

test("startSort: the state and the job carry the tab, the profile and this page load", () => {
  const page = loadContent();
  page.popup({ type: "startSort", sortBy: "views", limit: 300, days: 50, maxReels: 50, tabId: 7 });
  const s = page.store.sortState;
  assert.equal(s.tabId, 7);
  assert.equal(s.profile, "demo");
  assert.equal(s.loadId, page.popup({ type: "ping" }).loadId);
  assert.equal(s.target, 50, "Free's cap, not the 300 asked for");
  assert.deepEqual({ ...page.job() }, { sortBy: "views", limit: 50, days: 50, maxReels: 50, tabId: 7 });
});

test("startSort on Pro: no cap, no range", () => {
  const page = loadContent();
  page.popup({ type: "startSort", sortBy: "views", limit: "all", days: null, maxReels: null, tabId: 7 });
  assert.deepEqual({ ...page.job() }, { sortBy: "views", limit: "all", days: null, maxReels: null, tabId: 7 });
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
    job: { sortBy: "views", limit: 50, days: 50, maxReels: 50, tabId: 7 }
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
