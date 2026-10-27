// background.js's transcription pipeline against a stub network: the size
// check before any upload, signed-out handling, and the error wording.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const S3 = "https://bucket.test/upload";
const CDN = "https://scontent.cdninstagram.com/v/reel.mp4";

function res(status, opts) {
  opts = opts || {};
  const headers = opts.headers || {};
  return {
    status,
    ok: status >= 200 && status < 300,
    redirected: false,
    url: "",
    headers: { get: (k) => (k.toLowerCase() in headers ? headers[k.toLowerCase()] : null) },
    json: async () => (typeof opts.body === "string" ? JSON.parse(opts.body) : opts.body),
    text: async () => (typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body)),
    arrayBuffer: async () => opts.buffer || new ArrayBuffer(0),
    body: { cancel() {} }
  };
}

// routes: url substring -> function returning a response.
function loadWorker(opts) {
  opts = opts || {};
  const local = {};
  if (opts.signedIn !== false) {
    local.auth = { accessToken: "a", refreshToken: "r", accessExpiresAt: Date.now() + 3600e3 };
  }
  const calls = [];
  const warnings = [];
  const pings = [];
  const intervals = new Set();
  let onMessage = null;
  const area = (store) => ({
    get: async (k) => (typeof k === "string" ? { [k]: store[k] } : Object.assign({}, k, store)),
    set: async (o) => Object.assign(store, o),
    remove: async (k) => delete store[k]
  });
  const w = {
    console: { log() {}, warn: (...a) => warnings.push(a.join(" ")) },
    chrome: {
      runtime: {
        onInstalled: { addListener() {} },
        onMessage: { addListener: (fn) => (onMessage = fn) },
        getPlatformInfo: async () => (pings.push(Date.now()), { os: "mac" })
      },
      storage: { local: area(local), session: area({}) },
      identity: {
        getRedirectURL: () => "https://test.chromiumapp.org/",
        launchWebAuthFlow: async () => {
          calls.push("launchWebAuthFlow");
          throw new Error("closed");
        }
      },
      tabs: { sendMessage: async () => {} }
    },
    fetch: async (url, init) => {
      calls.push(url);
      for (const k of Object.keys(opts.routes || {})) {
        if (url.indexOf(k) !== -1) return opts.routes[k](url, init);
      }
      throw new Error("unexpected fetch " + url);
    },
    FormData, Blob, URL, URLSearchParams, crypto,
    setTimeout,
    setInterval: (fn, ms) => {
      const t = setInterval(fn, ms);
      intervals.add(t);
      return t;
    },
    clearInterval: (t) => {
      intervals.delete(t);
      clearInterval(t);
    }
  };
  w.self = w;
  w.importScripts = (...files) => {
    for (const f of files) vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), w, { filename: f });
  };
  vm.createContext(w);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "background.js"), "utf8"), w, { filename: "background.js" });

  return {
    calls,
    warnings,
    pings,
    intervals,
    run: (code) => vm.runInContext(code, w),
    send: (msg) =>
      new Promise((resolve) => onMessage(msg, { tab: { id: 1 }, frameId: 0 }, resolve))
  };
}

const POST = { code: "ABC123", pk: "111" };

// A reel that isn't cached: the job wants its file.
function routes(cdn) {
  return {
    "/v1/transcriptions": (url) => {
      if (/submit$/.test(url)) return res(200, { body: { status: "queued" } });
      if (/\/j1$/.test(url)) return res(200, { body: { status: "done", text: "hello", language: "en" } });
      return res(200, { body: { jobId: "j1", status: "awaiting_upload", upload: { url: S3, fields: { key: "k" } } } });
    },
    "/api/v1/media/111/info/": () =>
      res(200, { body: { items: [{ video_versions: [{ url: CDN, width: 480, height: 854 }] }] } }),
    [CDN]: cdn,
    [S3]: () => res(204)
  };
}

const neverUploaded = (calls) =>
  assert.ok(!calls.some((u) => u === S3 || /submit/.test(u)), "no upload and no submit: " + calls.join(", "));

test("too big by Content-Length: refused before any upload, with the size and MAX_BYTES", async () => {
  const sw = loadWorker({ routes: routes(() => res(200, { headers: { "content-length": "31400000" } })) });
  const r = await sw.send({ type: "transcribe", post: POST });
  assert.equal(r.ok, false);
  assert.equal(
    r.error,
    "This reel can't be transcribed — it's about 31 MB, over our current 24 MB limit. No credit was used."
  );
  neverUploaded(sw.calls);
  assert.ok(sw.warnings.some((l) => l.includes("ABC123") && l.includes("31 MB")), "logged in the worker console");
});

test("too big by downloaded size, when there's no Content-Length", async () => {
  const sw = loadWorker({ routes: routes(() => res(200, { buffer: { byteLength: 25_600_000 } })) });
  const r = await sw.send({ type: "transcribe", post: POST });
  assert.equal(
    r.error,
    "This reel can't be transcribed — it's about 26 MB, over our current 24 MB limit. No credit was used."
  );
  neverUploaded(sw.calls);
});

test("the limit in the message is MAX_BYTES, not a fixed 24", async () => {
  const sw = loadWorker({ routes: routes(() => res(200, { headers: { "content-length": "120000000" } })) });
  sw.run("MAX_BYTES = 99_000_000;");
  const r = await sw.send({ type: "transcribe", post: POST });
  assert.match(r.error, /about 120 MB, over our current 99 MB limit\. No credit was used\.$/);
});

test("under the limit: uploaded, then submitted", async () => {
  const sw = loadWorker({ routes: routes(() => res(200, { buffer: { byteLength: 5_000_000 } })) });
  sw.run("POLL_FIRST_MS = 1;");
  const r = await sw.send({ type: "transcribe", post: POST });
  assert.equal(r.ok, true, r.error);
  assert.ok(sw.calls.includes(S3));
  assert.ok(sw.calls.indexOf(S3) < sw.calls.findIndex((u) => /submit/.test(u)), "upload before submit");
});

test("signed out: says so, and opens no Google window and calls nothing", async () => {
  const sw = loadWorker({ signedIn: false });
  const r = await sw.send({ type: "transcribe", post: POST });
  assert.equal(r.ok, false);
  assert.equal(r.signedOut, true);
  assert.deepEqual(sw.calls, []);
});

test("pageSignIn: a closed Google window comes back as 'Sign-in was cancelled.'", async () => {
  const sw = loadWorker({ signedIn: false });
  const r = await sw.send({ type: "pageSignIn" });
  assert.deepEqual(sw.calls, ["launchWebAuthFlow"]);
  assert.equal(r.ok, false);
  assert.equal(r.error, "Sign-in was cancelled.");
});

test("a lookup answered with a login page isn't reported as a photo post", async () => {
  const r0 = routes(() => res(200));
  r0["/api/v1/media/111/info/"] = () => res(200, { body: "<!DOCTYPE html><html>login</html>" });
  const sw = loadWorker({ routes: r0 });
  const r = await sw.send({ type: "transcribe", post: POST });
  assert.match(r.error, /^Instagram didn't return this reel's video details \(HTTP 200, not JSON\)/);
  assert.doesNotMatch(r.error, /Photo posts/);
});

test("a refused upload says how S3 refused it", async () => {
  const r0 = routes(() => res(200, { buffer: { byteLength: 5_000_000 } }));
  r0[S3] = () => res(400, { body: "<Error><Code>EntityTooLarge</Code><Message>x</Message></Error>" });
  const sw = loadWorker({ routes: r0 });
  const r = await sw.send({ type: "transcribe", post: POST });
  assert.equal(r.error, "The upload didn't go through (HTTP 400, EntityTooLarge). Please try again.");
  assert.ok(!sw.calls.some((u) => /submit/.test(u)));
});

test("just over the limit: one decimal place, so the size never reads as the limit", async () => {
  const sw = loadWorker({ routes: routes(() => res(200, { headers: { "content-length": "24480000" } })) });
  const r = await sw.send({ type: "transcribe", post: POST });
  assert.equal(
    r.error,
    "This reel can't be transcribed — it's about 24.5 MB, over our current 24 MB limit. No credit was used."
  );
});

test("a failed no-speech job says no credit was used", async () => {
  const r0 = routes(() => res(200, { buffer: { byteLength: 5_000_000 } }));
  const base = r0["/v1/transcriptions"];
  r0["/v1/transcriptions"] = (url) =>
    /\/j1$/.test(url)
      ? res(200, { body: { status: "failed", error: "No speech detected.", refunded: true } })
      : base(url);
  const sw = loadWorker({ routes: r0 });
  sw.run("POLL_FIRST_MS = 1;");
  const r = await sw.send({ type: "transcribe", post: POST });
  assert.equal(r.error, "No speech was detected in this reel. No credit was used.");
});

test("a done job with no text says no credit was used", async () => {
  const r0 = routes(() => res(200, { buffer: { byteLength: 5_000_000 } }));
  const base = r0["/v1/transcriptions"];
  r0["/v1/transcriptions"] = (url) =>
    /\/j1$/.test(url) ? res(200, { body: { status: "done", text: "  " } }) : base(url);
  const sw = loadWorker({ routes: r0 });
  sw.run("POLL_FIRST_MS = 1;");
  const r = await sw.send({ type: "transcribe", post: POST });
  assert.equal(r.error, "No speech was detected in this reel. No credit was used.");
});

test("keeps the worker alive during the download and upload, then stops", async () => {
  const slow = (r) => new Promise((resolve) => setTimeout(() => resolve(r), 30));
  const r0 = routes(() => slow(res(200, { buffer: { byteLength: 5_000_000 } })));
  r0[S3] = () => slow(res(204));
  const sw = loadWorker({ routes: r0 });
  sw.run("POLL_FIRST_MS = 1; KEEPALIVE_MS = 5;");
  const r = await sw.send({ type: "transcribe", post: POST });
  assert.equal(r.ok, true, r.error);
  assert.ok(sw.pings.length > 0, "pinged chrome.runtime while transferring");
  assert.equal(sw.intervals.size, 0, "keep-alive cleared");
  const n = sw.pings.length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(sw.pings.length, n, "no pings after the transfer");
});

test("keep-alive stops when the download fails too", async () => {
  const sw = loadWorker({ routes: routes(() => res(200, { headers: { "content-length": "31400000" } })) });
  sw.run("KEEPALIVE_MS = 5;");
  const r = await sw.send({ type: "transcribe", post: POST });
  assert.equal(r.ok, false);
  assert.equal(sw.intervals.size, 0, "keep-alive cleared");
});
