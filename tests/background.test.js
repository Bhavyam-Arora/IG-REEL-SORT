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
  const logs = [];
  const pings = [];
  const created = []; // chrome.tabs.create urls
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
    console: { log: (...a) => logs.push(a.join(" ")), warn: (...a) => warnings.push(a.join(" ")) },
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
      tabs: {
        sendMessage: async () => {},
        onRemoved: { addListener: (fn) => (onRemoved = fn) },
        create: async (o) => (created.push(o.url), { id: 9 })
      }
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
    logs,
    pings,
    created,
    intervals,
    run: (code) => vm.runInContext(code, w),
    send: (msg) =>
      new Promise((resolve) => onMessage(msg, { tab: { id: 1 }, frameId: 0 }, resolve)),
    // A message from the popup (no tab). Resolves to undefined when the worker
    // doesn't answer at all.
    fromPopup: (msg) =>
      new Promise((resolve) => {
        if (onMessage(msg, { id: "test", url: "chrome-extension://test/popup.html" }, resolve) !== true) resolve(undefined);
      }),
    // The same message from a tab: a content script, or a page that got one to send it.
    fromTab: (msg) =>
      new Promise((resolve) => {
        if (onMessage(msg, { tab: { id: 1 }, frameId: 0 }, resolve) !== true) resolve(undefined);
      }),
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
  sw.run("POLL_FAST_MS = 1;");
  const r = await sw.send({ type: "transcribe", post: POST });
  assert.equal(r.ok, true, r.error);
  assert.ok(sw.calls.includes(S3));
  assert.ok(sw.calls.indexOf(S3) < sw.calls.findIndex((u) => /submit/.test(u)), "upload before submit");
});

test("timing: one console line per job and a transcribe entry in the health log, without the reel code", async () => {
  const sw = loadWorker({
    local: { health: [{ type: "sort", profile: "demo" }] },
    routes: routes(() => res(200, { buffer: { byteLength: 14_200_000 } }))
  });
  sw.run("POLL_FAST_MS = 1;");
  const r = await sw.send({ type: "transcribe", post: POST });
  assert.equal(r.ok, true, r.error);
  await new Promise((done) => setTimeout(done, 5));
  const line = sw.logs.find((l) => l.startsWith("[Sortcut] transcribe ABC123: "));
  assert.match(line, /^\[Sortcut\] transcribe ABC123: video \(fallback: no manifest\) · size 14\.2 MB · lookup \d+\.\ds · download \d+\.\ds · upload \d+\.\ds · submit \d+\.\ds · server wait \d+\.\ds \(queued \d+\.\ds, 1 poll\) · total \d+\.\ds$/);
  const [entry, older] = sw.local.health;
  assert.equal(older.type, "sort", "the sort entry is kept, after the new one");
  assert.equal(entry.type, "transcribe");
  assert.equal(entry.outcome, "done");
  assert.equal(entry.source, "video");
  assert.equal(entry.fallback, "no manifest");
  assert.equal(entry.bytes, 14_200_000);
  assert.equal(entry.polls, 1);
  for (const k of ["lookupMs", "downloadMs", "uploadMs", "submitMs", "waitMs", "queuedMs", "totalMs"]) {
    assert.equal(typeof entry[k], "number", k);
  }
  assert.ok(!JSON.stringify(entry).includes("ABC123"), "no reel code stored");
});

test("timing: a failed job is logged as failed", async () => {
  const sw = loadWorker({ routes: routes(() => res(200, { headers: { "content-length": "31400000" } })) });
  const r = await sw.send({ type: "transcribe", post: POST });
  assert.equal(r.ok, false);
  await new Promise((done) => setTimeout(done, 5));
  assert.match(sw.logs.find((l) => l.startsWith("[Sortcut] transcribe")), /· total \d+\.\ds · failed$/);
  assert.equal(sw.local.health[0].outcome, "failed");
  assert.equal(sw.local.health[0].bytes, null);
});

// ---- Audio-only download ----

const AUDIO_LO = "https://scontent.cdninstagram.com/v/audio-48k.mp4?a=1&b=2";
const AUDIO_HI = "https://scontent.cdninstagram.com/v/audio-96k.mp4";
const xml = (s) => s.replace(/&/g, "&amp;");
const VIDEO_SET =
  '<AdaptationSet contentType="video"><Representation bandwidth="400000" mimeType="video/mp4">' +
  "<BaseURL>https://scontent.cdninstagram.com/v/video-only.mp4</BaseURL></Representation></AdaptationSet>";
const audioSet = (reps) => '<AdaptationSet contentType="audio">' + reps + "</AdaptationSet>";
const audioRep = (bw, url) =>
  '<Representation bandwidth="' + bw + '" mimeType="audio/mp4" codecs="mp4a.40.5">' +
  '<AudioChannelConfiguration value="2"/>' + (url ? "<BaseURL>" + xml(url) + "</BaseURL>" : "") +
  '<SegmentBase indexRange="0-1"><Initialization range="0-1"/></SegmentBase></Representation>';
const mpd = (...sets) => '<?xml version="1.0"?><MPD><Period>' + sets.join("") + "</Period></MPD>";
const FULL_MPD = mpd(VIDEO_SET, audioSet(audioRep(96000, AUDIO_HI) + audioRep(48000, AUDIO_LO)));

// routes() with a media info answer that carries `manifest`, and the audio
// files answering with `audio`.
function audioRoutes(manifest, audio) {
  const r = routes(() => res(200, { buffer: { byteLength: 14_200_000 } }));
  r["/api/v1/media/111/info/"] = () =>
    res(200, { body: { items: [{ video_versions: [{ url: CDN, width: 480, height: 854 }], video_dash_manifest: manifest }] } });
  r["/v/audio-"] = audio || (() => res(200, { buffer: { byteLength: 1_300_000 } }));
  return r;
}

const settle = () => new Promise((done) => setTimeout(done, 5));

async function transcribeWith(manifest, audio, post) {
  const sw = loadWorker({ routes: audioRoutes(manifest, audio) });
  sw.run("POLL_FAST_MS = 1;");
  const r = await sw.send({ type: "transcribe", post: post || POST });
  assert.equal(r.ok, true, r.error);
  await settle();
  return { sw, entry: sw.local.health[0], line: sw.logs.find((l) => l.startsWith("[Sortcut] transcribe")) };
}

const downloads = (calls) => calls.filter((u) => /cdninstagram/.test(u));

test("audio: the lowest-bandwidth audio Representation is downloaded and uploaded, not the video", async () => {
  const { sw, entry, line } = await transcribeWith(FULL_MPD);
  assert.deepEqual(downloads(sw.calls), [AUDIO_LO], "the &amp; in the BaseURL is decoded");
  assert.ok(sw.calls.indexOf(AUDIO_LO) < sw.calls.indexOf(S3), "downloaded before the upload");
  assert.equal(entry.source, "audio");
  assert.equal(entry.fallback, null);
  assert.equal(entry.bytes, 1_300_000);
  assert.match(line, /^\[Sortcut\] transcribe ABC123: audio · size 1\.3 MB · /);
});

test("audio: uploaded under the same name and type as the video", async () => {
  let file = null;
  const r = audioRoutes(FULL_MPD, () => res(200, { buffer: new ArrayBuffer(8) }));
  r[S3] = (url, init) => ((file = init.body.get("file")), res(204));
  const sw = loadWorker({ routes: r });
  sw.run("POLL_FAST_MS = 1;");
  assert.equal((await sw.send({ type: "transcribe", post: POST })).ok, true);
  assert.equal(file.name, "ABC123.mp4");
  assert.equal(file.type, "video/mp4");
  assert.equal(file.size, 8);
});

test("audio: a set marked audio by mimeType alone counts, and a self-closing Representation has no BaseURL", async () => {
  const set = '<AdaptationSet mimeType="audio/mp4"><Representation bandwidth="1" mimeType="audio/mp4"/>' +
    audioRep(64000, AUDIO_HI).replace(' mimeType="audio/mp4"', "") + "</AdaptationSet>";
  const { sw, entry } = await transcribeWith(mpd(VIDEO_SET, set));
  assert.deepEqual(downloads(sw.calls), [AUDIO_HI]);
  assert.equal(entry.source, "audio");
});

for (const [name, manifest, reason] of [
  ["no audio track", mpd(VIDEO_SET), "no audio track"],
  ["an audio track without a BaseURL", mpd(VIDEO_SET, audioSet(audioRep(48000, null))), "no BaseURL"],
  ["an audio BaseURL off the allowed CDN hosts", mpd(audioSet(audioRep(48000, "https://audio.example.com/a.mp4"))), "audio host not allowed"],
  ["no manifest at all", null, "no manifest"],
  ["a manifest that isn't an MPD", "not xml", "no audio track"]
]) {
  test("fallback to the video: " + name, async () => {
    const { sw, entry, line } = await transcribeWith(manifest);
    assert.deepEqual(downloads(sw.calls), [CDN]);
    assert.equal(entry.source, "video");
    assert.equal(entry.fallback, reason);
    assert.ok(line.startsWith("[Sortcut] transcribe ABC123: video (fallback: " + reason + ") · size 14.2 MB · "), line);
  });
}

for (const [name, audio] of [
  ["refused (403)", () => res(403)],
  ["unreachable", () => { throw new TypeError("Failed to fetch"); }],
  ["empty", () => res(200, { buffer: { byteLength: 0 } })],
  ["over MAX_BYTES", () => res(200, { headers: { "content-length": "30000000" } })]
]) {
  test("fallback to the video: the audio download is " + name, async () => {
    const { sw, entry } = await transcribeWith(FULL_MPD, audio);
    assert.deepEqual(downloads(sw.calls), [AUDIO_LO, CDN]);
    assert.equal(entry.source, "video");
    assert.equal(entry.fallback, "audio download failed");
    assert.equal(entry.bytes, 14_200_000);
  });
}

test("fallback: a too-big video after the audio failed is refused before any upload, no credit used", async () => {
  const r = audioRoutes(FULL_MPD, () => res(403));
  r[CDN] = () => res(200, { headers: { "content-length": "31400000" } });
  const sw = loadWorker({ routes: r });
  const out = await sw.send({ type: "transcribe", post: POST });
  assert.equal(out.ok, false);
  assert.equal(out.error, "This reel can't be transcribed — it's about 31 MB, over our current 24 MB limit. No credit was used.");
  neverUploaded(sw.calls);
});

test("a post that already has a video link still looks up the audio, and keeps its link if the lookup fails", async () => {
  const withLink = Object.assign({}, POST, { videoUrl: CDN });
  const { sw, entry } = await transcribeWith(FULL_MPD, null, withLink);
  assert.ok(sw.calls.some((u) => /media\/111\/info/.test(u)));
  assert.equal(entry.source, "audio");

  const r = audioRoutes(FULL_MPD);
  r["/api/v1/media/111/info/"] = () => res(500);
  const sw2 = loadWorker({ routes: r });
  sw2.run("POLL_FAST_MS = 1;");
  assert.equal((await sw2.send({ type: "transcribe", post: withLink })).ok, true);
  await settle();
  assert.deepEqual(downloads(sw2.calls), [CDN]);
  assert.equal(sw2.local.health[0].fallback, "lookup failed");
});

test("the CDN hosts the audio may come from are all in manifest.json's host_permissions", () => {
  const sw = loadWorker();
  const suffixes = JSON.parse(sw.run("JSON.stringify(CDN_HOST_SUFFIXES)"));
  assert.ok(suffixes.length);
  for (const h of suffixes) assert.ok(MANIFEST.host_permissions.includes("https://*" + h + "/*"), h);
});

// ---- Poll schedule ----

test("poll schedule: every 1 s for the first 20 s, then every 2 s", () => {
  const sw = loadWorker();
  assert.deepEqual(
    [0, 1000, 19_999, 20_000, 60_000, 599_000].map((ms) => sw.run("pollDelay(" + ms + ")")),
    [1000, 1000, 1000, 2000, 2000, 2000]
  );
});

// A clock that only moves when the worker sleeps, so the delays it asks for
// are the schedule.
function fakeClock(sw) {
  sw.run(`
    var fakeNow = Date.now();
    Date.now = function () { return fakeNow; };
    var slept = [];
    sleep = function (ms) { slept.push(ms); fakeNow += ms; return Promise.resolve(); };
  `);
  return () => JSON.parse(sw.run("JSON.stringify(slept)"));
}

test("poll schedule: the delays a long job actually waits", async () => {
  let polls = 0;
  const r = routes(() => res(200, { buffer: { byteLength: 5_000_000 } }));
  const base = r["/v1/transcriptions"];
  r["/v1/transcriptions"] = (url) =>
    /\/j1$/.test(url) && ++polls < 25 ? res(200, { body: { status: "processing" } }) : base(url);
  const sw = loadWorker({ routes: r });
  const slept = fakeClock(sw);
  assert.equal((await sw.send({ type: "transcribe", post: POST })).ok, true);
  assert.deepEqual(slept(), [...Array(20).fill(1000), ...Array(5).fill(2000)]);
});

test("poll schedule: still gives up after 10 minutes", async () => {
  const r = routes(() => res(200, { buffer: { byteLength: 5_000_000 } }));
  const base = r["/v1/transcriptions"];
  r["/v1/transcriptions"] = (url) => (/\/j1$/.test(url) ? res(200, { body: { status: "processing" } }) : base(url));
  const sw = loadWorker({ routes: r });
  const slept = fakeClock(sw);
  const out = await sw.send({ type: "transcribe", post: POST });
  assert.equal(out.ok, false);
  assert.equal(out.error, "Still processing — click again later to fetch it.");
  const waited = slept().reduce((a, b) => a + b, 0);
  assert.ok(waited <= 10 * 60e3 && waited > 10 * 60e3 - 2000, String(waited));
  assert.equal(slept().length, 20 + (10 * 60e3 - 20e3) / 2000);
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
  sw.run("POLL_FAST_MS = 1;");
  const r = await sw.send({ type: "transcribe", post: POST });
  assert.equal(r.error, "No speech was detected in this reel. No credit was used.");
});

test("a done job with no text says no credit was used", async () => {
  const r0 = routes(() => res(200, { buffer: { byteLength: 5_000_000 } }));
  const base = r0["/v1/transcriptions"];
  r0["/v1/transcriptions"] = (url) =>
    /\/j1$/.test(url) ? res(200, { body: { status: "done", text: "  " } }) : base(url);
  const sw = loadWorker({ routes: r0 });
  sw.run("POLL_FAST_MS = 1;");
  const r = await sw.send({ type: "transcribe", post: POST });
  assert.equal(r.error, "No speech was detected in this reel. No credit was used.");
});

test("keeps the worker alive during the download and upload, then stops", async () => {
  const slow = (r) => new Promise((resolve) => setTimeout(() => resolve(r), 30));
  const r0 = routes(() => slow(res(200, { buffer: { byteLength: 5_000_000 } })));
  r0[S3] = () => slow(res(204));
  const sw = loadWorker({ routes: r0 });
  sw.run("POLL_FAST_MS = 1; KEEPALIVE_MS = 5;");
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

// ---- Backend refusals, by code (decisions.md §13) ----

// The refusal on job creation, or on /submit after a successful upload.
async function refused(status, body, at) {
  const r0 = routes(() => res(200, { buffer: { byteLength: 5_000_000 } }));
  const ok = r0["/v1/transcriptions"];
  r0["/v1/transcriptions"] = (url) =>
    (at === "submit" ? /submit$/.test(url) : !/submit$/.test(url)) ? res(status, { body }) : ok(url);
  const sw = loadWorker({ routes: r0 });
  const r = await sw.send({ type: "transcribe", post: POST });
  assert.equal(r.ok, false);
  return r;
}

test("code not_pro: the Upgrade dialog, on create or submit, whatever the message says", async () => {
  for (const at of ["create", "submit"]) {
    const r = await refused(402, { error: "You've used all 200 transcripts.", code: "not_pro" }, at);
    assert.equal(r.needsPro, true, at);
    assert.equal(r.error, "Transcription is part of Sortcut Pro.", at);
  }
});

test("code quota_exhausted: used up, resets on renewal; not the Upgrade dialog", async () => {
  for (const at of ["create", "submit"]) {
    const r = await refused(402, { error: "Transcription is part of Sortcut Pro.", code: "quota_exhausted" }, at);
    assert.equal(r.needsPro, false, at);
    assert.equal(r.error, "You've used all your transcriptions for this period. They reset when your plan renews.", at);
  }
});

test("code quota_missing: not ready yet, with the support address", async () => {
  const r = await refused(402, { error: "Something about quota.", code: "quota_missing" });
  assert.equal(r.needsPro, false);
  assert.equal(r.error, "Your transcriptions for this period aren't ready yet. Try again shortly, or write to support@sortcut.co.");
});

test("code too_many_running: up to 3 at once", async () => {
  const r = await refused(429, { error: "Up to 3 transcriptions can run at once.", code: "too_many_running" });
  assert.equal(r.needsPro, false);
  assert.equal(r.error, "Up to 3 transcriptions can run at once. Wait for one to finish.");
});

test("code hourly_limit: says when to try again, in local time", async () => {
  const retryAt = "2026-11-05T15:45:00Z";
  const r = await refused(429, { error: "Hourly limit reached.", code: "hourly_limit", retryAt }, "submit");
  const local = new Date(retryAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  assert.equal(r.error, "Hourly limit reached — try again after " + local + ".");
  assert.ok(!r.error.includes(retryAt), "not the raw ISO time");
});

test("code hourly_limit without a readable retryAt: the server's message", async () => {
  for (const retryAt of [undefined, "soon"]) {
    const r = await refused(429, { error: "Hourly limit reached. Try again later.", code: "hourly_limit", retryAt }, "submit");
    assert.equal(r.error, "Hourly limit reached. Try again later.", String(retryAt));
  }
});

test("a 429 with no code (API Gateway's throttle): Sortcut is busy", async () => {
  const r = await refused(429, { message: "Too Many Requests" });
  assert.equal(r.needsPro, false);
  assert.equal(r.error, "Sortcut is busy — try again in a minute.");
});

test("an unknown or missing code: the server's message, never matched by wording", async () => {
  for (const [status, body] of [
    [402, { error: "Transcription is part of Sortcut Pro." }],
    [402, { error: "You've used all 200 transcripts for this period.", code: "something_new" }],
    [429, { error: "Slow down a little.", code: "something_new" }]
  ]) {
    const r = await refused(status, body);
    assert.equal(r.needsPro, false, JSON.stringify(body));
    assert.equal(r.error, body.error, JSON.stringify(body));
  }
  const bare = await refused(402, {});
  assert.equal(bare.error, "Something went wrong (HTTP 402). Please try again.");
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

// ---- Error reports ----

const REPORTS = "/v1/reports";
// POST /v1/reports's rules (sortcut-backend src/shared/config.js REPORT_FIELDS):
// exactly these fields, each valid, nothing else.
const REPORT_SPEC = {
  reason: (v) => ["no_responses", "responses_but_no_reels", "reels_but_none_from_profile", "reels_missing_metric"].includes(v),
  extensionVersion: (v) => typeof v === "string" && /^\d{1,5}(\.\d{1,5}){0,3}$/.test(v) && v.split(".").every((p) => +p <= 65535),
  rulesVersion: (v) => Number.isInteger(v) && v >= 0 && v <= 1e9,
  rulesSource: (v) => ["builtin", "remote"].includes(v),
  browser: (v) => ["chrome", "edge", "brave", "arc", "other"].includes(v),
  browserMajor: (v) => Number.isInteger(v) && v >= 0 && v <= 1000,
  responsesSeen: (v) => Number.isInteger(v) && v >= 0 && v <= 10000,
  postsFound: (v) => Number.isInteger(v) && v >= 0 && v <= 10000,
  scrolls: (v) => Number.isInteger(v) && v >= 0 && v <= 1000,
  durationMs: (v) => Number.isInteger(v) && v >= 0 && v <= 600000
};
function assertValidReport(body) {
  assert.deepEqual(Object.keys(body).sort(), Object.keys(REPORT_SPEC).sort());
  for (const [k, ok] of Object.entries(REPORT_SPEC)) assert.ok(ok(body[k]), k + ": " + JSON.stringify(body[k]));
}

// An offer as content.js puts it in the sort state.
const offer = (o) => Object.assign({
  id: "L1", reason: "responses_but_no_reels", rulesSource: "builtin", rulesVersion: 2,
  responsesSeen: 14, postsFound: 0, scrolls: 11, durationMs: 31234, arc: false
}, o);

const CHROME_NAV = {
  userAgent: "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  userAgentData: { brands: [{ brand: "Google Chrome", version: "141" }, { brand: "Chromium", version: "141" }, { brand: "Not_A Brand", version: "24" }] }
};

// A signed-in worker whose /v1/reports answers with `route` (202 by default).
function reportWorker(opts) {
  opts = opts || {};
  const sent = [];
  const sw = loadWorker({
    local: opts.local,
    routes: Object.assign({ [ME]: me("pro_monthly") }, {
      [REPORTS]: (url, init) => (sent.push({ url, init }), opts.route ? opts.route(url, init) : res(202, { body: "" }))
    })
  });
  sw.local.auth = { accessToken: "ACCESS-SECRET", refreshToken: "REFRESH-SECRET", accessExpiresAt: Date.now() + HOUR };
  sw.run("self.navigator = " + JSON.stringify(opts.navigator || CHROME_NAV));
  sw.reports = sent;
  return sw;
}

test("report: the preview is exactly the 10 fields the backend accepts, and sends nothing", async () => {
  const sw = reportWorker();
  const r = await sw.fromPopup({ type: "reportPreview", offer: offer() });
  assert.equal(r.ok, true);
  assert.equal(r.allowed, true);
  assertValidReport(r.report);
  assert.deepEqual({ ...r.report }, {
    reason: "responses_but_no_reels", extensionVersion: MANIFEST.version, rulesVersion: 2, rulesSource: "builtin",
    browser: "chrome", browserMajor: 141, responsesSeen: 14, postsFound: 0, scrolls: 11, durationMs: 31234
  });
  assert.equal(sw.reports.length, 0, "a preview is never a send");
  assert.equal(sw.local.reportLimits, undefined, "nor counted");
});

test("report: Send posts exactly the previewed fields, no auth header and no cookies, signed in or not", async () => {
  const sw = reportWorker();
  // Extra keys an offer might carry never reach the report.
  const o = offer({ profile: "demo.creator", url: "https://www.instagram.com/demo.creator/reels/", userId: "g_123", token: "ACCESS-SECRET" });
  const preview = (await sw.fromPopup({ type: "reportPreview", offer: o })).report;
  const r = await sw.fromPopup({ type: "sendReport", offer: o });
  assert.deepEqual({ ...r }, { ok: true, sent: true });
  assert.equal(sw.reports.length, 1);
  const { url, init } = sw.reports[0];
  assert.match(url, /^https:\/\/[^/]+\/v1\/reports$/);
  assert.equal(init.method, "POST");
  assert.equal(init.credentials, "omit");
  assert.deepEqual(Object.keys(init.headers).map((h) => h.toLowerCase()), ["content-type"]);
  assert.equal(init.headers["Content-Type"], "application/json");
  const body = JSON.parse(init.body);
  assertValidReport(body);
  assert.deepEqual(body, JSON.parse(JSON.stringify(preview)), "what's shown is what's sent");
  assert.doesNotMatch(init.body, /demo|instagram|g_123|SECRET|token|profile|url/i);
  assert.ok(init.body.length <= 2048, "inside the backend's 2 KB");
});

test("report: nothing is sent without the click, and never on a tab's say-so", async () => {
  const sw = reportWorker();
  await sw.run("rulesQueue");
  assert.equal(sw.reports.length, 0, "not on worker start");
  assert.equal(await sw.fromTab({ type: "sendReport", offer: offer() }), undefined);
  assert.equal(await sw.fromTab({ type: "reportPreview", offer: offer() }), undefined);
  assert.equal(sw.reports.length, 0);
});

test("report: only the four reasons; anything else is neither offered nor sent", async () => {
  const sw = reportWorker();
  for (const reason of ["wrong_page", "profile_has_no_reels", "stopped_time_limit", "navigated", undefined]) {
    const r = await sw.fromPopup({ type: "reportPreview", offer: offer({ reason }) });
    assert.equal(r.allowed, false, String(reason));
    assert.equal(r.report, null);
    await sw.fromPopup({ type: "sendReport", offer: offer({ reason }) });
  }
  assert.equal(await sw.fromPopup({ type: "reportPreview" }).then((r) => r.allowed), false, "no offer at all");
  assert.equal(sw.reports.length, 0);
});

test("report: counts past the backend's ranges are capped, never sent out of range", async () => {
  const sw = reportWorker();
  const r = await sw.fromPopup({
    type: "reportPreview",
    offer: offer({ responsesSeen: 25000, postsFound: -3, scrolls: 1400.6, durationMs: 3600000, rulesVersion: "x" })
  });
  assertValidReport(r.report);
  assert.equal(r.report.responsesSeen, 10000);
  assert.equal(r.report.postsFound, 0);
  assert.equal(r.report.scrolls, 1000);
  assert.equal(r.report.durationMs, 600000);
  assert.equal(r.report.rulesVersion, 0);
});

test("report limits: one per reason per day, then the question isn't asked", async () => {
  const sw = reportWorker();
  await sw.fromPopup({ type: "sendReport", offer: offer({ id: "L1" }) });
  const again = await sw.fromPopup({ type: "reportPreview", offer: offer({ id: "L2" }) });
  assert.equal(again.allowed, false);
  assert.equal(again.report, null);
  assert.deepEqual({ ...(await sw.fromPopup({ type: "sendReport", offer: offer({ id: "L2" }) })) }, { ok: true, sent: false });
  assert.equal(sw.reports.length, 1);
  // Another reason the same day is still fine.
  assert.equal((await sw.fromPopup({ type: "reportPreview", offer: offer({ id: "L3", reason: "no_responses" }) })).allowed, true);
});

test("report limits: three a day in all, and a new day starts again", async () => {
  const sw = reportWorker();
  const reasons = ["no_responses", "responses_but_no_reels", "reels_but_none_from_profile"];
  for (const [i, reason] of reasons.entries()) await sw.fromPopup({ type: "sendReport", offer: offer({ id: "L" + i, reason }) });
  assert.equal(sw.reports.length, 3);
  const fourth = offer({ id: "L9", reason: "reels_missing_metric" });
  assert.equal((await sw.fromPopup({ type: "reportPreview", offer: fourth })).allowed, false);
  await sw.fromPopup({ type: "sendReport", offer: fourth });
  assert.equal(sw.reports.length, 3);
  assert.equal(sw.local.reportLimits.total, 3);

  // Kept in local storage, by local day: yesterday's counts don't hold today back.
  sw.local.reportLimits = { ...sw.local.reportLimits, day: "2000-01-01" };
  assert.equal((await sw.fromPopup({ type: "reportPreview", offer: fourth })).allowed, true);
  await sw.fromPopup({ type: "sendReport", offer: fourth });
  assert.equal(sw.reports.length, 4);
  assert.equal(sw.local.reportLimits.total, 1);
});

test("report: an offer is answered once; No thanks sends nothing and doesn't ask again", async () => {
  const sw = reportWorker();
  assert.deepEqual({ ...(await sw.fromPopup({ type: "declineReport", offer: offer({ id: "L1" }) })) }, { ok: true });
  assert.equal((await sw.fromPopup({ type: "reportPreview", offer: offer({ id: "L1" }) })).allowed, false);
  assert.equal(sw.reports.length, 0);
  assert.equal(sw.local.reportLimits, undefined, "declining isn't counted against the limits");
  // A sent one isn't offered again either, and a second click doesn't send twice.
  await sw.fromPopup({ type: "sendReport", offer: offer({ id: "L2", reason: "no_responses" }) });
  await sw.fromPopup({ type: "sendReport", offer: offer({ id: "L2", reason: "no_responses" }) });
  assert.equal(sw.reports.length, 1);
});

test("report: a failed, refused or slow send is silent and never retried", async () => {
  const down = reportWorker({ route: () => { throw new TypeError("Failed to fetch"); } });
  assert.deepEqual({ ...(await down.fromPopup({ type: "sendReport", offer: offer() })) }, { ok: true, sent: true });
  assert.equal(down.reports.length, 1);
  assert.deepEqual(down.warnings, []);

  const refused = reportWorker({ route: () => res(400, { body: { error: "bad" } }) });
  assert.equal((await refused.fromPopup({ type: "sendReport", offer: offer() })).ok, true);
  assert.equal(refused.reports.length, 1);

  const hang = (url, init) =>
    new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
  const slow = reportWorker({ route: hang });
  assert.equal(slow.run("REPORT_TIMEOUT_MS"), 8000);
  slow.run("REPORT_TIMEOUT_MS = 20");
  assert.deepEqual({ ...(await slow.fromPopup({ type: "sendReport", offer: offer() })) }, { ok: true, sent: true });
  assert.equal(slow.reports.length, 1);
  assert.equal(slow.local.reportLimits.total, 1, "a failed send still counts toward the day's limits");
});

test("report: the browser, named the backend's way, with its major version", async () => {
  const ua = (s) => "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) " + s;
  const cases = [
    ["chrome", 141, CHROME_NAV, false],
    ["edge", 140, { userAgent: ua("Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0"),
      userAgentData: { brands: [{ brand: "Microsoft Edge", version: "140" }, { brand: "Chromium", version: "140" }] } }, false],
    ["edge", 139, { userAgent: ua("Chrome/139.0.0.0 Safari/537.36 Edg/139.0.0.0") }, false],
    ["brave", 141, { userAgent: ua("Chrome/141.0.0.0 Safari/537.36"),
      userAgentData: { brands: [{ brand: "Brave", version: "141" }, { brand: "Chromium", version: "141" }] } }, false],
    ["brave", 141, { userAgent: ua("Chrome/141.0.0.0 Safari/537.36"), brave: {},
      userAgentData: { brands: [{ brand: "Chromium", version: "141" }] } }, false],
    ["arc", 141, CHROME_NAV, true],
    ["other", 141, { userAgent: ua("Chrome/141.0.0.0 Safari/537.36"),
      userAgentData: { brands: [{ brand: "Chromium", version: "141" }, { brand: "Opera", version: "125" }] } }, false],
    ["other", 141, { userAgent: ua("Chrome/141.0.0.0 Safari/537.36") }, false],
    ["other", 0, {}, false]
  ];
  for (const [browser, major, navigator, arc] of cases) {
    const sw = reportWorker({ navigator });
    const r = (await sw.fromPopup({ type: "reportPreview", offer: offer({ arc }) })).report;
    assert.equal(r.browser, browser, JSON.stringify(navigator));
    assert.equal(r.browserMajor, major, JSON.stringify(navigator));
    assertValidReport(r);
  }
});

// ---- Similar accounts (GET /v1/directory) ----

const DIR_URL = "amazonaws.com/v1/directory";
const DIRECTORY = {
  version: 3,
  niches: [{ name: "Fitness", count: 2, filters: [{ name: "Yoga", count: 1 }, { name: "Strength", count: 1 }] }],
  accounts: [
    { niche: "Fitness", username: "amy_yoga", fullName: "Amy Lee", filter: "Yoga", topics: "morning flows" },
    { niche: "Fitness", username: "zoe.lifts", fullName: "Zoe Park", filter: "Strength", topics: "form tips" }
  ]
};

// Objects from the worker's vm, compared as plain data.
const plain = (x) => JSON.parse(JSON.stringify(x));

// A Pro account whose /v1/directory answers with dir(url) — each URL asked is
// kept in asked.
function directoryWorker(dir, opts) {
  opts = opts || {};
  const asked = [];
  const sw = loadWorker(Object.assign({}, opts, {
    routes: Object.assign({
      [ME]: me("pro_monthly"),
      [DIR_URL]: (url, init) => (asked.push({ url, auth: init.headers.Authorization }), dir(url))
    }, opts.routes)
  }));
  sw.asked = asked;
  return sw;
}

test("directory: fetched with the sign-in, then kept with its version and time", async () => {
  const sw = directoryWorker(() => res(200, { body: DIRECTORY }));
  const r = await sw.send({ type: "directory" });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(plain(r.directory), DIRECTORY);
  assert.deepEqual(sw.asked.map((a) => a.url), ["https://uc7bn8aln5.execute-api.ap-southeast-2.amazonaws.com/v1/directory"]);
  assert.equal(sw.asked[0].auth, "Bearer a");
  assert.equal(sw.local.directory.version, 3);
  assert.deepEqual(plain(sw.local.directory.data), DIRECTORY);
  assert.ok(Date.now() - sw.local.directory.at < 1000);
});

test("directory: within 6 hours the kept copy is used and nothing is fetched", async () => {
  const sw = directoryWorker(() => res(200, { body: DIRECTORY }), {
    local: { directory: { version: 3, data: DIRECTORY, at: Date.now() - 5.9 * HOUR } }
  });
  const r = await sw.send({ type: "directory" });
  assert.deepEqual(plain(r.directory), DIRECTORY);
  assert.deepEqual(sw.asked, []);
});

test("directory: older than 6 hours, ?have= the kept version; a 304 keeps the copy and restarts the clock", async () => {
  const sw = directoryWorker(() => res(304), {
    local: { directory: { version: 3, data: DIRECTORY, at: Date.now() - 6 * HOUR - 1 } }
  });
  const r = await sw.send({ type: "directory" });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(plain(r.directory), DIRECTORY);
  assert.match(sw.asked[0].url, /\/v1\/directory\?have=3$/);
  assert.ok(Date.now() - sw.local.directory.at < 1000, "fresh again");

  await sw.send({ type: "directory" });
  assert.equal(sw.asked.length, 1, "and not asked again for another 6 hours");
});

test("directory: a newer version replaces the kept copy", async () => {
  const v4 = Object.assign({}, DIRECTORY, { version: 4, accounts: DIRECTORY.accounts.slice(0, 1) });
  const sw = directoryWorker(() => res(200, { body: v4 }), {
    local: { directory: { version: 3, data: DIRECTORY, at: Date.now() - 7 * HOUR } }
  });
  const r = await sw.send({ type: "directory" });
  assert.equal(r.directory.version, 4);
  assert.equal(sw.local.directory.version, 4);
  assert.equal(sw.local.directory.data.accounts.length, 1);
});

test("directory: a clock set back doesn't make a copy fresh forever", async () => {
  const sw = directoryWorker(() => res(304), {
    local: { directory: { version: 3, data: DIRECTORY, at: Date.now() + 48 * HOUR } }
  });
  await sw.send({ type: "directory" });
  assert.equal(sw.asked.length, 1);
});

test("directory: 402 not_pro deletes the kept copy and asks for the Upgrade dialog", async () => {
  const sw = directoryWorker(
    () => res(402, { body: { error: "Similar accounts are part of Sortcut Pro.", code: "not_pro" } }),
    { local: { directory: { version: 3, data: DIRECTORY, at: 0 } } }
  );
  const r = await sw.send({ type: "directory" });
  assert.equal(r.ok, false);
  assert.equal(r.needsPro, true);
  assert.equal(sw.local.directory, undefined);
});

test("directory: Free per /v1/me: the kept copy goes and nothing is fetched", async () => {
  const sw = directoryWorker(() => res(200, { body: DIRECTORY }), {
    routes: { [ME]: me("free") },
    local: { directory: { version: 3, data: DIRECTORY, at: Date.now() } }
  });
  const r = await sw.send({ type: "directory" });
  assert.equal(r.needsPro, true);
  assert.deepEqual(sw.asked, []);
  assert.equal(sw.local.directory, undefined);
});

test("directory: signing out deletes the kept copy", async () => {
  const sw = directoryWorker(() => res(200, { body: DIRECTORY }), {
    routes: { "/v1/auth/logout": () => res(204) },
    local: { directory: { version: 3, data: DIRECTORY, at: Date.now() } }
  });
  const r = await sw.fromPopup({ type: "signOut" });
  assert.equal(r.ok, true, r.error);
  assert.equal(sw.local.directory, undefined);
  assert.equal(sw.local.auth, undefined);
});

test("directory: a session that can't be refreshed deletes it too", async () => {
  const sw = directoryWorker(() => res(401, { body: { error: "Please sign in again." } }), {
    routes: { "/v1/auth/refresh": () => res(401, { body: { error: "expired" } }) },
    local: { directory: { version: 3, data: DIRECTORY, at: 0 } }
  });
  const r = await sw.send({ type: "directory" });
  assert.equal(r.signedOut, true);
  assert.equal(sw.local.directory, undefined);
});

test("directory: signed out, nothing is fetched and a leftover copy goes", async () => {
  const sw = directoryWorker(() => res(200, { body: DIRECTORY }), {
    signedIn: false,
    local: { directory: { version: 3, data: DIRECTORY, at: Date.now() } }
  });
  const r = await sw.send({ type: "directory" });
  assert.equal(r.ok, false);
  assert.equal(r.signedOut, true);
  assert.equal(sw.calls.filter((u) => u.includes("/v1/")).length, 0);
  assert.equal(sw.local.directory, undefined);
});

test("directory: nothing published, or a failure, in plain words; never an HTTP code", async () => {
  const none = directoryWorker(() => res(404, { body: { error: "Not found" } }));
  assert.equal((await none.send({ type: "directory" })).error, "There are no similar accounts to show yet.");

  for (const reply of [() => res(500, { body: { error: "x" } }), () => res(200, { body: { version: "3" } })]) {
    const sw = directoryWorker(reply);
    const r = await sw.send({ type: "directory" });
    assert.equal(r.error, "Couldn't load similar accounts. Please try again.");
    assert.equal(sw.local.directory, undefined, "nothing kept");
  }
});

test("directory: an account whose username can't make a link is left out", async () => {
  const dirty = Object.assign({}, DIRECTORY, {
    accounts: DIRECTORY.accounts.concat([
      { niche: "Fitness", username: "../x", fullName: "", filter: "Yoga", topics: "" },
      { niche: "Fitness", username: "a".repeat(31), fullName: "", filter: "Yoga", topics: "" },
      { niche: "Fitness", username: 42, fullName: "", filter: "Yoga", topics: "" },
      { niche: "", username: "noniche", fullName: "", filter: "Yoga", topics: "" }
    ])
  });
  const sw = directoryWorker(() => res(200, { body: dirty }));
  const r = await sw.send({ type: "directory" });
  assert.deepEqual(plain(r.directory.accounts.map((a) => a.username)), ["amy_yoga", "zoe.lifts"]);
});

test("directory: two asks at once make one request", async () => {
  const sw = directoryWorker(() => res(200, { body: DIRECTORY }));
  const [a, b] = await Promise.all([sw.send({ type: "directory" }), sw.send({ type: "directory" })]);
  assert.equal(a.ok && b.ok, true);
  assert.equal(sw.asked.length, 1);
});

test("isPro: the page's question, answered from /v1/me", async () => {
  assert.deepEqual(plain(await directoryWorker(() => res(500)).send({ type: "isPro" })), { ok: true, pro: true });
  const free = directoryWorker(() => res(500), { routes: { [ME]: me("free") } });
  assert.deepEqual(plain(await free.send({ type: "isPro" })), { ok: true, pro: false });
  assert.deepEqual(plain(await loadWorker({ signedIn: false }).send({ type: "isPro" })), { ok: true, pro: false });
});

// ---- Upgrade: a one-time handoff code, then the dashboard's checkout ----

const HANDOFF = "amazonaws.com/v1/auth/handoff";
const CHECKOUT = "https://accounts.sortcut.co/checkout";
const CODE = "A".repeat(20) + "b-_" + "9".repeat(20); // 43 base64url characters

test("upgrade: asks for a handoff code with the access token, opens checkout with it in the fragment", async () => {
  let init = null;
  const sw = loadWorker({ routes: { [HANDOFF]: (url, i) => ((init = i), res(200, { body: { code: CODE, expiresIn: 120 } })) } });
  const before = Date.now();
  const r = await sw.fromPopup({ type: "upgrade" });
  assert.deepEqual({ ...r }, { ok: true });
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, "Bearer a");
  assert.deepEqual(sw.created, [CHECKOUT + "#code=" + CODE], "no plan, no price: the page preselects Monthly");
  assert.ok(sw.session.upgradeStartedAt >= before);
  assert.ok(!sw.logs.concat(sw.warnings).join("\n").includes(CODE), "the code is never logged");
});

test("upgrade: from the page's Upgrade dialog too", async () => {
  const sw = loadWorker({ routes: { [HANDOFF]: () => res(200, { body: { code: CODE } }) } });
  assert.equal((await sw.fromTab({ type: "upgrade" })).ok, true);
  assert.deepEqual(sw.created, [CHECKOUT + "#code=" + CODE]);
});

test("upgrade: signed out signs in first; a closed Google window opens nothing", async () => {
  const sw = loadWorker({ signedIn: false, routes: { [HANDOFF]: () => res(200, { body: { code: CODE } }) } });
  const r = await sw.fromPopup({ type: "upgrade" });
  assert.equal(r.ok, false);
  assert.equal(r.error, "Sign-in was cancelled.");
  assert.deepEqual(sw.calls, ["launchWebAuthFlow"], "no handoff asked");
  assert.deepEqual(sw.created, []);
});

test("upgrade: the backend's refusal is shown in its words; a malformed code opens nothing", async () => {
  const refused = loadWorker({
    routes: { [HANDOFF]: () => res(403, { body: { error: "This account is not active. Please contact support@sortcut.co." } }) }
  });
  const r = await refused.fromPopup({ type: "upgrade" });
  assert.equal(r.ok, false);
  assert.equal(r.error, "This account is not active. Please contact support@sortcut.co.");
  assert.deepEqual(refused.created, []);

  for (const code of ["short", "", null, CODE + "x", "A".repeat(42) + "="]) {
    const bad = loadWorker({ routes: { [HANDOFF]: () => res(200, { body: { code } }) } });
    const b = await bad.fromPopup({ type: "upgrade" });
    assert.equal(b.error, "Couldn't open checkout. Please try again.", String(code));
    assert.deepEqual(bad.created, []);
    assert.equal(bad.session.upgradeStartedAt, undefined);
  }
});

test("after Upgrade, /v1/me is asked afresh until it says Pro, then cached again", async () => {
  let current = "none";
  const sw = loadWorker({
    routes: {
      [HANDOFF]: () => res(200, { body: { code: CODE } }),
      [ME]: () => res(200, { body: { email: "test@example.com", plan: current } })
    }
  });
  const meCalls = () => sw.calls.filter((u) => u.indexOf(ME) !== -1).length;
  await plan(sw);
  await plan(sw);
  assert.equal(meCalls(), 1, "before Upgrade: cached");

  await sw.fromPopup({ type: "upgrade" });
  await plan(sw);
  await plan(sw);
  assert.equal(meCalls(), 3, "waiting for the payment: asked every time");

  current = "pro_monthly";
  assert.equal((await plan(sw)).pro, true);
  assert.equal(sw.session.upgradeStartedAt, undefined, "Pro: stop watching");
  await plan(sw);
  assert.equal(meCalls(), 4, "cached again");
});

test("after Upgrade, the watch ends after an hour, and on sign-out", async () => {
  const sw = loadWorker({ routes: { [ME]: me("none") } });
  sw.session.upgradeStartedAt = Date.now() - 61 * 60e3;
  await plan(sw);
  await plan(sw);
  assert.equal(sw.calls.filter((u) => u.indexOf(ME) !== -1).length, 1, "over an hour: cached as usual");

  const out = loadWorker({ routes: { "/v1/auth/logout": () => res(204) } });
  out.session.upgradeStartedAt = Date.now();
  await out.fromPopup({ type: "signOut" });
  assert.equal(out.session.upgradeStartedAt, undefined);
});
