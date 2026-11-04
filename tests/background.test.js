// background.js's transcription pipeline against a stub network: the size
// check before any upload, signed-out handling, the error wording, and the
// plan (isPro) every Pro-only feature asks.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const S3 = "https://bucket.test/upload";
const CDN = "https://scontent.cdninstagram.com/v/reel.mp4";
const ME = "amazonaws.com/v1/me";
const HOUR = 3600e3;
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));

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
  const local = Object.assign({}, opts.local);
  const session = {};
  if (opts.signedIn !== false) {
    local.auth = { accessToken: "a", refreshToken: "r", accessExpiresAt: Date.now() + 3600e3 };
  }
  // The remote rules were checked a moment ago, so a worker start fetches
  // nothing, unless a test wants the check due.
  if (!opts.rulesDue && !("rulesLastCheckedAt" in local)) local.rulesLastCheckedAt = Date.now();
  const calls = [];
  const warnings = [];
  const pings = [];
  const intervals = new Set();
  let onMessage = null;
  const lifecycle = { installed: [], startup: [] };
  let onRemoved = null;
  const area = (store) => ({
    get: async (k) => (typeof k === "string" ? { [k]: store[k] } : Object.assign({}, k, store)),
    set: async (o) => Object.assign(store, o),
    remove: async (k) => [].concat(k).forEach((key) => delete store[key])
  });
  const w = {
    console: { log() {}, warn: (...a) => warnings.push(a.join(" ")) },
    chrome: {
      runtime: {
        onInstalled: { addListener: (fn) => lifecycle.installed.push(fn) },
        onStartup: { addListener: (fn) => lifecycle.startup.push(fn) },
        onMessage: { addListener: (fn) => (onMessage = fn) },
        getManifest: () => ({ version: opts.extensionVersion || MANIFEST.version }),
        getPlatformInfo: async () => (pings.push(Date.now()), { os: "mac" })
      },
      storage: { local: area(local), session: area(session) },
      identity: {
        getRedirectURL: () => "https://test.chromiumapp.org/",
        launchWebAuthFlow: async () => {
          calls.push("launchWebAuthFlow");
          throw new Error("closed");
        }
      },
      tabs: { sendMessage: async () => {}, onRemoved: { addListener: (fn) => (onRemoved = fn) } }
    },
    fetch: async (url, init) => {
      calls.push(url);
      for (const k of Object.keys(opts.routes || {})) {
        if (url.indexOf(k) !== -1) return opts.routes[k](url, init);
      }
      throw new Error("unexpected fetch " + url);
    },
    FormData, Blob, URL, URLSearchParams, crypto, atob, TextEncoder, AbortController,
    setTimeout, clearTimeout,
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
    local,
    session,
    calls,
    warnings,
    pings,
    intervals,
    run: (code) => vm.runInContext(code, w),
    send: (msg) =>
      new Promise((resolve) => onMessage(msg, { tab: { id: 1 }, frameId: 0 }, resolve)),
    closeTab: (tabId) => onRemoved(tabId),
    // Chrome waking the worker for runtime.onInstalled / onStartup.
    installed: (reason) => lifecycle.installed.forEach((fn) => fn({ reason })),
    startup: () => lifecycle.startup.forEach((fn) => fn())
  };
}

const POST = { code: "ABC123", pk: "111" };

const me = (plan) => () => res(200, { body: { email: "test@example.com", plan } });

// A reel that isn't cached: the job wants its file. The account is Pro.
function routes(cdn) {
  return {
    [ME]: me("pro_monthly"),
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

// ---- Plan ----

const plan = async (sw) => (await sw.send({ type: "plan" })).plan;
const offline = () => {
  throw new Error("offline");
};

test("plan: signed out is Free, and /v1/me isn't asked", async () => {
  const sw = loadWorker({ signedIn: false, routes: { [ME]: me("pro_yearly") } });
  assert.deepEqual({ ...(await plan(sw)) }, { plan: "none", pro: false, freeMaxReels: 50 });
  assert.deepEqual(sw.calls, []);
});

test("plan: signed in, from /v1/me, and remembered with the time", async () => {
  for (const [p, pro] of [["pro_monthly", true], ["pro_yearly", true], ["none", false]]) {
    const sw = loadWorker({ routes: { [ME]: me(p) } });
    const before = Date.now();
    assert.equal((await plan(sw)).pro, pro, p);
    assert.equal(sw.local.lastPlan.plan, p);
    assert.ok(sw.local.lastPlan.at >= before);
  }
});

test("plan: Sortcut unreachable keeps the last known plan for 24 hours", async () => {
  for (const down of [offline, () => res(503, { body: { error: "down" } })]) {
    const recent = loadWorker({
      routes: { [ME]: down },
      local: { lastPlan: { plan: "pro_yearly", at: Date.now() - 23 * HOUR } }
    });
    assert.equal((await plan(recent)).pro, true, "23 hours old: still Pro");

    const stale = loadWorker({
      routes: { [ME]: down },
      local: { lastPlan: { plan: "pro_yearly", at: Date.now() - 25 * HOUR } }
    });
    assert.equal((await plan(stale)).pro, false, "25 hours old: Free");

    const never = loadWorker({ routes: { [ME]: down } });
    assert.equal((await plan(never)).pro, false, "nothing known: Free");
  }
});

test("plan: a 401 that can't be refreshed is Free, and forgets the last plan", async () => {
  const sw = loadWorker({
    routes: {
      [ME]: () => res(401),
      "/v1/auth/refresh": () => res(401, { body: { error: "expired" } })
    },
    local: { lastPlan: { plan: "pro_monthly", at: Date.now() - HOUR } }
  });
  assert.equal((await plan(sw)).pro, false);
  assert.equal(sw.local.auth, undefined, "signed out");
  assert.equal(sw.local.lastPlan, undefined);
});

test("plan: a refusal that isn't an outage doesn't fall back to the last plan", async () => {
  const sw = loadWorker({
    routes: { [ME]: () => res(403, { body: { error: "Account suspended." } }) },
    local: { lastPlan: { plan: "pro_monthly", at: Date.now() - HOUR } }
  });
  assert.equal((await plan(sw)).pro, false);
});

test("plan: the popup's account answer carries the same plan", async () => {
  const sw = loadWorker({
    routes: { [ME]: offline },
    local: { lastPlan: { plan: "pro_monthly", at: Date.now() - HOUR } }
  });
  const r = await sw.send({ type: "account" });
  assert.equal(r.account.signedIn, true);
  assert.equal(r.account.me, null);
  assert.equal(r.account.pro, true);
  assert.equal(r.account.plan, "pro_monthly");
});

// ---- Sort state: one tab, one page load ----

const STATE = { status: "done", tabId: 1, loadId: "L1", profile: "demo.creator" };

test("sort state: a new page load in its tab ends it", async () => {
  const sw = loadWorker({ local: { sortState: { ...STATE } } });
  assert.deepEqual({ ...(await sw.send({ type: "pageLoad", loadId: "L2" })) }, { ok: true, tabId: 1 });
  assert.equal(sw.local.sortState, undefined);
});

test("sort state: the reload a sort starts with keeps it", async () => {
  const sw = loadWorker({ local: { sortState: { ...STATE, status: "running" } } });
  await sw.send({ type: "pageLoad", loadId: "L2", keep: true });
  assert.equal(sw.local.sortState.status, "running");
});

test("sort state: another tab's load or close leaves it alone", async () => {
  const sw = loadWorker({ local: { sortState: { ...STATE, tabId: 9 } } });
  await sw.send({ type: "pageLoad", loadId: "L2" });
  sw.closeTab(1);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sw.local.sortState.tabId, 9);
});

test("sort state: closing its tab ends it", async () => {
  const sw = loadWorker({ local: { sortState: { ...STATE } } });
  sw.closeTab(1);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sw.local.sortState, undefined);
});

// ---- Transcribe on Free ----

test("signed in on Free: needsPro, before any transcription call", async () => {
  const r0 = routes(() => res(200, { buffer: { byteLength: 5_000_000 } }));
  r0[ME] = me("none");
  const sw = loadWorker({ routes: r0 });
  const r = await sw.send({ type: "transcribe", post: POST });
  assert.equal(r.ok, false);
  assert.equal(r.needsPro, true);
  assert.equal(r.signedOut, false);
  assert.equal(r.error, "Transcription is part of Sortcut Pro.");
  assert.ok(!sw.calls.some((u) => /transcriptions/.test(u)), sw.calls.join(", "));
  assert.equal(sw.warnings.length, 0, "not logged as a failure");
});

test("a backend 402 for the plan is needsPro too; used-up transcripts are not", async () => {
  for (const [msg, needsPro] of [
    ["Transcription is part of Sortcut Pro.", true],
    ["You've used all 200 transcripts for this period.", false]
  ]) {
    const r0 = routes(() => res(200));
    r0["/v1/transcriptions"] = () => res(402, { body: { error: msg } });
    const sw = loadWorker({ routes: r0 });
    const r = await sw.send({ type: "transcribe", post: POST });
    assert.equal(r.ok, false);
    assert.equal(r.needsPro, needsPro, msg);
  }
});

// ---- Rules ----
// content.js reads the rules from storage, so the worker puts lib/rules.js there.

const settled = () => new Promise((r) => setTimeout(r, 5));

test("rules: the bundled copy is mirrored into storage when the worker starts", async () => {
  const sw = loadWorker();
  await settled();
  const bundled = JSON.parse(JSON.stringify(sw.run("SORTCUT_RULES")));
  assert.deepEqual(JSON.parse(JSON.stringify(sw.local.rules)), bundled);
});

test("rules: an older or different stored copy is replaced; a newer one stays", async () => {
  const old = loadWorker({ local: { rules: { version: 0, fields: {} } } });
  await settled();
  assert.equal(old.local.rules.version, old.run("SORTCUT_RULES.version"));
  assert.ok(Array.isArray(old.local.rules.fields.views));

  const newer = { version: 9999, fields: { views: ["from_the_server"] } };
  const kept = loadWorker({ local: { rules: newer } });
  await settled();
  assert.deepEqual(kept.local.rules, newer);
});

// The reload case seen in real Chrome: the extension reloaded, storage holding
// every other key but no rules. Each way the worker is woken writes them.
const AFTER_RELOAD = { health: [], lastPlan: {}, lastRun: {}, sortState: null, transcribeStatus: {} };

test("rules, after a reload: install/update and browser startup each write them", async () => {
  for (const wake of [(sw) => sw.installed("update"), (sw) => sw.installed("install"), (sw) => sw.startup()]) {
    const sw = loadWorker({ local: Object.assign({}, AFTER_RELOAD) });
    await settled();
    delete sw.local.rules; // as if the worker's first start never got to write them
    wake(sw);
    await settled();
    assert.equal(sw.local.rules && sw.local.rules.version, sw.run("SORTCUT_RULES.version"), String(wake));
    assert.deepEqual(Object.keys(sw.local).sort(), ["auth", "rulesLastCheckedAt", ...Object.keys(AFTER_RELOAD), "rules"].sort(), "nothing else touched");
  }
});

test("rules, after a reload: content.js asks, and gets them back as they're written", async () => {
  const sw = loadWorker({ local: Object.assign({}, AFTER_RELOAD) });
  await settled();
  delete sw.local.rules;
  const r = await sw.send({ type: "getRules" });
  assert.equal(r.ok, true);
  const bundled = JSON.parse(JSON.stringify(sw.run("SORTCUT_RULES")));
  assert.deepEqual(JSON.parse(JSON.stringify(r.rules)), bundled);
  assert.deepEqual(JSON.parse(JSON.stringify(sw.local.rules)), bundled);
});

test("rules: asked while a newer copy is stored, the newer copy is the answer", async () => {
  const newer = { version: 9999, fields: { views: ["from_the_server"] } };
  const sw = loadWorker({ local: { rules: newer } });
  const r = await sw.send({ type: "getRules" });
  assert.deepEqual(JSON.parse(JSON.stringify(r.rules)), newer);
  assert.deepEqual(sw.local.rules, newer);
});

// ---- Remote rules ----
// The worker fetches GET /v1/rules at most once an hour and stores a reply
// lib/remote-rules.js accepts (tests/remote-rules.test.js has the checks).

const V3_TEXT = fs.readFileSync(path.join(__dirname, "fixtures/rules-v3-response.json"), "utf8");
const RULES_ROUTE = "amazonaws.com/v1/rules";
const v3 = () => res(200, { body: V3_TEXT });
const rulesCalls = (sw) => sw.calls.filter((u) => u.indexOf(RULES_ROUTE) !== -1);
const bundledVersion = (sw) => sw.run("SORTCUT_RULES.version");
const clone = (x) => JSON.parse(JSON.stringify(x));

test("remote rules: a due check fetches v3, verifies it and stores it as remote", async () => {
  const sw = loadWorker({ rulesDue: true, routes: { [RULES_ROUTE]: v3 } });
  assert.equal(await sw.run('checkRemoteRules("test")'), "accepted");
  assert.equal(sw.local.rules.version, 3);
  assert.equal(sw.local.rules.source, "remote");
  assert.deepEqual(clone(sw.local.rules.fields.views), JSON.parse(V3_TEXT).rules.fields.views);
  assert.ok(Math.abs(sw.local.rulesLastCheckedAt - Date.now()) < 5000);
  // It asked once, saying what it had, and sent no cookies.
  assert.deepEqual(rulesCalls(sw), [sw.run("API_BASE") + "/v1/rules?have=" + bundledVersion(sw)]);
  // content.js asking now gets the remote copy.
  const r = await sw.send({ type: "getRules" });
  assert.equal(r.rules.source, "remote");
  assert.equal(r.rules.version, 3);
});

test("remote rules: at most once an hour, whatever wakes the worker", async () => {
  const sw = loadWorker({ rulesDue: true, routes: { [RULES_ROUTE]: v3 } });
  await sw.run('checkRemoteRules("test")');
  sw.installed("update");
  sw.startup();
  await sw.send({ type: "plan" });
  assert.equal(await sw.run('checkRemoteRules("again")'), "fresh");
  assert.equal(rulesCalls(sw).length, 1);

  // An hour on, the next wake-up checks again: v3 is what's stored, so it stays.
  sw.local.rulesLastCheckedAt -= HOUR;
  assert.equal(await sw.run('checkRemoteRules("later")'), "v3 is not newer than v3");
  assert.equal(rulesCalls(sw).length, 2);
  assert.equal(sw.local.rules.version, 3);
});

test("remote rules: install, startup, worker start and a sort each check when due", async () => {
  const wakes = {
    "worker start": () => {},
    installed: (sw) => sw.installed("install"),
    startup: (sw) => sw.startup(),
    sort: (sw) => sw.send({ type: "plan" })
  };
  for (const [name, wake] of Object.entries(wakes)) {
    const sw = loadWorker({ rulesDue: true, routes: { [RULES_ROUTE]: v3, [ME]: me("none") } });
    if (name !== "worker start") {
      await sw.run("rulesCheck"); // let the worker-start check finish, then make it due again
      sw.local.rulesLastCheckedAt = 0;
      delete sw.local.rules;
    }
    await wake(sw);
    await sw.run("rulesCheck");
    await settled();
    assert.equal(sw.local.rules && sw.local.rules.source, "remote", name);
  }
});

test("remote rules: a network failure keeps the current rules", async () => {
  const down = () => {
    throw new TypeError("Failed to fetch");
  };
  const sw = loadWorker({ rulesDue: true, routes: { [RULES_ROUTE]: down } });
  assert.equal(await sw.run('checkRemoteRules("test")'), "unreachable");
  assert.equal(sw.local.rules.version, bundledVersion(sw));
  assert.equal(sw.local.rules.source, undefined);

  // And a stored remote copy stays through a failure, a 500 and a junk body.
  const stored = Object.assign(JSON.parse(V3_TEXT).rules, { source: "remote" });
  for (const route of [down, () => res(500, { body: "{}" }), () => res(200, { body: "<html>" })]) {
    const kept = loadWorker({ rulesDue: true, local: { rules: clone(stored) }, routes: { [RULES_ROUTE]: route } });
    assert.equal(await kept.run('checkRemoteRules("test")'), "unreachable");
    assert.deepEqual(clone(kept.local.rules), stored);
  }
});

test("remote rules: a reply slower than the timeout keeps the current rules", async () => {
  const hang = (url, init) =>
    new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
  const sw = loadWorker({ routes: { [RULES_ROUTE]: hang } });
  assert.equal(sw.run("RULES_FETCH_TIMEOUT_MS"), 8000);
  await sw.run("rulesCheck"); // the worker-start check: not due
  sw.run("RULES_FETCH_TIMEOUT_MS = 20");
  sw.local.rulesLastCheckedAt = 0;
  assert.equal(await sw.run('checkRemoteRules("test")'), "unreachable");
  assert.equal(sw.local.rules.version, bundledVersion(sw));
});

test("remote rules: a tampered reply is thrown away", async () => {
  const bad = JSON.parse(V3_TEXT);
  bad.rules.limits.timeLimitMs = 3600000;
  const sw = loadWorker({ rulesDue: true, routes: { [RULES_ROUTE]: () => res(200, { body: JSON.stringify(bad) }) } });
  assert.equal(await sw.run('checkRemoteRules("test")'), "bad signature");
  assert.equal(sw.local.rules.version, bundledVersion(sw));
});

test("remote rules: v3 sets no minimum extension version, so even an old build uses it", async () => {
  const sw = loadWorker({ rulesDue: true, extensionVersion: "0.0.1", routes: { [RULES_ROUTE]: v3 } });
  assert.equal(await sw.run('checkRemoteRules("test")'), "accepted", "no minimum: any build may use it");
});

test("remote rules: a build whose own rules are newer replaces a stored remote copy", async () => {
  const stored = Object.assign(JSON.parse(V3_TEXT).rules, { source: "remote" });
  const sw = loadWorker({ local: { rules: clone(stored) } });
  sw.run("SORTCUT_RULES.version = 4");
  sw.installed("update");
  await settled();
  assert.equal(sw.local.rules.version, 4);
  assert.equal(sw.local.rules.source, undefined);
});

// ---- The health log ----

test("sortLog(): the health log, newest first, printed and returned", async () => {
  const health = [{ type: "sort", profile: "demo", kept: 25, codes: ["stopped_time_limit"] }, { type: "sort", profile: "b", codes: [] }];
  const sw = loadWorker({ local: { health } });
  const tables = [];
  sw.run("console").table = (rows) => tables.push(rows);
  const list = await sw.run("sortLog()");
  assert.deepEqual(JSON.parse(JSON.stringify(list)), health);
  assert.equal(tables.length, 1);
  assert.equal(tables[0][0].codes, "stopped_time_limit", "codes flattened for the table");
});

test("sortLog is a global the moment the worker script runs, and the worker says so", () => {
  const sw = loadWorker();
  assert.equal(sw.run("typeof sortLog"), "function");
  assert.equal(sw.run("self.sortLog === sortLog"), true);
});

test("rules: a stored copy with the same content in another key order isn't rewritten", async () => {
  const sw0 = loadWorker();
  await settled();
  const reordered = (function flip(v) {
    if (Array.isArray(v)) return v.map(flip);
    if (v && typeof v === "object") {
      const out = {};
      Object.keys(v).reverse().forEach((k) => (out[k] = flip(v[k])));
      return out;
    }
    return v;
  })(JSON.parse(JSON.stringify(sw0.local.rules)));
  const sw = loadWorker({ local: { rules: reordered } });
  await settled();
  sw.installed("update");
  await settled();
  assert.equal(sw.local.rules, reordered, "the stored object is the one that was there");
});
