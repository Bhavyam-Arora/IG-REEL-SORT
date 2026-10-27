// content.js on a stand-in Instagram page: what the sorted view hides and
// restores, the failure card, and the signed-out sign-in dialog.
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

  const store = {};
  const sent = [];
  const unanswered = [];
  const listeners = { message: [], runtime: [] };
  const chrome = {
    runtime: {
      lastError: undefined,
      getURL: (p) => "chrome-extension://test/" + p,
      getManifest: () => ({ version: "test" }),
      sendMessage(msg, cb) {
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
        set(o) { Object.assign(store, o); }
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
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    // The 4s return-to-idle timer and the download cleanup never need to fire.
    setTimeout: () => 0,
    Blob: class {},
    URL: { createObjectURL: () => "blob:test", revokeObjectURL() {} },
    addEventListener(type, fn) { if (type === "message") listeners.message.push(fn); },
    postMessage() {}
  };
  w.window = w;
  vm.createContext(w);
  vm.runInContext(SOURCE, w, { filename: "content.js" });

  const self = vm.runInContext("window", w);
  return {
    document,
    store,
    sent,
    $: (id) => document.getElementById(id),
    // Answer a message the test held back.
    answer(type, reply) {
      const i = unanswered.findIndex((u) => u.msg.type === type);
      unanswered.splice(i, 1)[0].cb(reply);
    },
    // A finished sort, as collector.js posts it.
    result(posts) {
      for (const fn of listeners.message) {
        fn({
          source: self,
          data: {
            source: "ig-sorter", type: "result", posts, sortBy: "views",
            ranked: posts.length, median: null, reason: "complete", total: posts.length
          }
        });
      }
    },
    // A message from the popup.
    popup(msg) {
      for (const fn of listeners.runtime) fn(msg, {}, () => {});
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
