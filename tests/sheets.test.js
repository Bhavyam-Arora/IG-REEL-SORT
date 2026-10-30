// Export to Google Sheets, in background.js and lib/auth.js, against a fake
// Google (the auth window), a fake Drive, a fake Sortcut backend and a fake
// Instagram tab: one window when signed out, only the Drive permission when
// signed in, cancel, 401 → new token → one retry, the CSV fallback, the export
// carried across Google's window, and where the Google token may never go.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const DRIVE = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const API = "amazonaws.com";
const IG_TAB = 42;
const CSV = '"code","url","views"\r\n"AAA","https://www.instagram.com/p/AAA/","2500"';
const SIGNED_IN = { accessToken: "sortcut-a", refreshToken: "sortcut-r", accessExpiresAt: Date.now() + 3600e3 };

function res(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

// Google's answer to one auth request: the redirect, carrying back the state
// it was sent. tokens: what it grants this time.
function granted(url, tokens) {
  const q = new URL(url).searchParams;
  const f = new URLSearchParams({
    access_token: tokens.access,
    token_type: "Bearer",
    expires_in: "3599",
    scope: tokens.scope || "openid email profile " + DRIVE_SCOPE,
    state: q.get("state")
  });
  if (tokens.id) f.set("id_token", tokens.id);
  return "https://test.chromiumapp.org/#" + f.toString();
}

// opts.google(details, n): the auth window, returning a redirect or throwing.
// opts.drive(init, n): Drive's answer to the nth upload.
function loadWorker(opts) {
  opts = opts || {};
  const local = Object.assign({}, opts.local);
  const session = Object.assign({}, opts.session);
  const windows = []; // every launchWebAuthFlow: { url, params, interactive }
  const fetches = []; // every request: { url, init }
  const toTabs = [];
  const created = [];
  const reloads = [];
  const logs = [];
  let onMessage = null;
  const area = (store) => ({
    get: async (k) => (typeof k === "string" ? { [k]: store[k] } : Object.assign({}, k, store)),
    set: async (o) => Object.assign(store, JSON.parse(JSON.stringify(o))),
    remove: async (k) => [].concat(k).forEach((key) => delete store[key])
  });
  const log = (...a) => logs.push(a.map(String).join(" "));
  let drives = 0;
  const w = {
    console: { log, warn: log, error: log, info: log, debug: log },
    chrome: {
      runtime: {
        onInstalled: { addListener() {} },
        onStartup: { addListener() {} },
        onMessage: { addListener: (fn) => (onMessage = fn) },
        getPlatformInfo: async () => ({ os: "mac" })
      },
      storage: { local: area(local), session: area(session) },
      identity: {
        getRedirectURL: () => "https://test.chromiumapp.org/",
        launchWebAuthFlow: async (details) => {
          const params = Object.fromEntries(new URL(details.url).searchParams);
          windows.push({ url: details.url, params, interactive: details.interactive });
          if (!opts.google) throw new Error("The user did not approve access.");
          return opts.google(details, windows.length);
        }
      },
      tabs: {
        sendMessage: async (tabId, msg) => {
          toTabs.push({ tabId, msg });
          if (msg.type === "sheetsCsv" && tabId === IG_TAB) {
            return { ok: true, csv: CSV, username: "demo.creator", count: 1 };
          }
          throw new Error("Could not establish connection.");
        },
        create: async (o) => created.push(o.url),
        reload: async (tabId) => reloads.push(tabId),
        onRemoved: { addListener() {} }
      }
    },
    fetch: async (url, init) => {
      fetches.push({ url, init: init || {} });
      if (url === DRIVE) {
        drives++;
        return opts.drive ? opts.drive(init, drives) : res(200, { id: "SHEET1" });
      }
      if (url.indexOf(API + "/v1/auth/google") !== -1) {
        return res(200, { accessToken: "sortcut-a", refreshToken: "sortcut-r", expiresIn: 3600 });
      }
      if (url.indexOf(API + "/v1/me") !== -1) {
        return res(200, { email: "test@example.com", plan: "none" });
      }
      if (url.indexOf(API + "/v1/auth/logout") !== -1) return res(204);
      throw new Error("unexpected fetch " + url);
    },
    URL, URLSearchParams, crypto, setTimeout, setInterval, clearInterval
  };
  w.self = w;
  w.importScripts = (...files) => {
    for (const f of files) vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), w, { filename: f });
  };
  vm.createContext(w);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "background.js"), "utf8"), w, { filename: "background.js" });

  const send = (msg) => new Promise((resolve) => onMessage(msg, {}, resolve));
  return {
    local, session, windows, fetches, toTabs, created, reloads, logs,
    send,
    // The popup's click: { type: "sheetsExport", tabId } for the Instagram tab.
    exportSheet: (tabId) => send({ type: "sheetsExport", tabId: tabId === undefined ? IG_TAB : tabId }),
    drives: () => fetches.filter((f) => f.url === DRIVE),
    backend: () => fetches.filter((f) => f.url.indexOf(API) !== -1)
  };
}

const held = (token, expiresAt) => ({ googleDrive: { accessToken: token, expiresAt } });

function localDate() {
  const d = new Date();
  const two = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + two(d.getMonth() + 1) + "-" + two(d.getDate());
}

// The upload's two parts, as Drive would read them.
function multipart(init) {
  const boundary = /boundary=(.+)$/.exec(init.headers["Content-Type"])[1];
  const parts = init.body.split("--" + boundary).slice(1, -1).map((p) => {
    const [head, ...rest] = p.replace(/^\r\n/, "").split("\r\n\r\n");
    return { head, body: rest.join("\r\n\r\n").replace(/\r\n$/, "") };
  });
  assert.ok(init.body.endsWith("--" + boundary + "--"), "closing boundary");
  return parts;
}

async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

test("signed out: one Google window signs in to Sortcut and grants Drive, then the sheet opens", async () => {
  const sw = loadWorker({ google: (d) => granted(d.url, { access: "G-ACCESS-1", id: "ID-TOKEN" }) });
  const r = await sw.exportSheet();

  assert.deepEqual({ ...r }, { ok: true, url: "https://docs.google.com/spreadsheets/d/SHEET1/edit" });
  assert.equal(sw.windows.length, 1, "one window");
  const w = sw.windows[0];
  assert.equal(w.interactive, true);
  assert.equal(w.params.response_type, "token id_token");
  assert.equal(w.params.scope, "openid email profile " + DRIVE_SCOPE, "no other scopes");
  assert.equal(w.params.include_granted_scopes, "true");
  assert.equal(w.params.redirect_uri, "https://test.chromiumapp.org/");
  assert.ok(w.params.client_id && w.params.nonce && w.params.state);
  assert.equal(w.params.login_hint, undefined);

  // Signed in to Sortcut with the same ID token and nonce, as normal sign-in does.
  const signIn = sw.backend().find((f) => /\/v1\/auth\/google$/.test(f.url));
  assert.deepEqual(JSON.parse(signIn.init.body), { idToken: "ID-TOKEN", nonce: w.params.nonce, client: "extension" });
  assert.equal(sw.local.auth.accessToken, "sortcut-a");

  // One multipart upload that Google converts into a Sheet.
  assert.equal(sw.drives().length, 1);
  const up = sw.drives()[0].init;
  assert.equal(up.method, "POST");
  assert.equal(up.headers.Authorization, "Bearer G-ACCESS-1");
  assert.match(up.headers["Content-Type"], /^multipart\/related; boundary=/);
  const [meta, csv] = multipart(up);
  assert.match(meta.head, /^Content-Type: application\/json/);
  assert.deepEqual(JSON.parse(meta.body), {
    name: "@demo.creator reels · Sortcut · " + localDate(),
    mimeType: "application/vnd.google-apps.spreadsheet"
  });
  assert.match(csv.head, /^Content-Type: text\/csv/);
  assert.equal(csv.body, CSV);

  assert.deepEqual(sw.created, ["https://docs.google.com/spreadsheets/d/SHEET1/edit"]);
  assert.equal(sw.session.sheetsExport.status, "done");
  assert.deepEqual(sw.reloads, [], "the Instagram tab is never reloaded");
});

test("ordinary sign-in never asks for Drive", async () => {
  const sw = loadWorker({
    google: (d) => "https://test.chromiumapp.org/#id_token=ID&state=" + new URL(d.url).searchParams.get("state")
  });
  await sw.send({ type: "signIn" });
  assert.equal(sw.windows.length, 1);
  assert.equal(sw.windows[0].params.scope, "openid email profile");
  assert.doesNotMatch(sw.windows[0].url, /drive/);
});

test("already signed in: the window asks only for Drive, hinted with their email, no second sign-in", async () => {
  const sw = loadWorker({
    local: { auth: SIGNED_IN },
    google: (d) => granted(d.url, { access: "G-ACCESS-1", id: "ID-TOKEN" })
  });
  const r = await sw.exportSheet();
  assert.equal(r.ok, true);
  assert.equal(sw.windows.length, 1);
  assert.equal(sw.windows[0].params.login_hint, "test@example.com");
  assert.equal(sw.windows[0].params.prompt, undefined, "no account chooser");
  assert.ok(!sw.backend().some((f) => /auth\/google/.test(f.url)), "no Sortcut sign-in call");

  // The next export, while the token is good, opens no window at all.
  await sw.exportSheet();
  assert.equal(sw.windows.length, 1);
  assert.equal(sw.drives().length, 2);
});

test("expired token: a silent refresh first, and no window when it works", async () => {
  const sw = loadWorker({
    local: { auth: SIGNED_IN },
    session: held("G-OLD", Date.now() - 1000),
    google: (d) => granted(d.url, { access: "G-NEW" })
  });
  const r = await sw.exportSheet();
  assert.equal(r.ok, true);
  assert.deepEqual(sw.windows.map((w) => [w.interactive, w.params.prompt]), [[false, "none"]]);
  assert.equal(sw.windows[0].params.login_hint, "test@example.com");
  assert.equal(sw.drives()[0].init.headers.Authorization, "Bearer G-NEW");
});

test("expired token and the silent refresh fails: then, and only then, the window", async () => {
  const sw = loadWorker({
    local: { auth: SIGNED_IN },
    session: held("G-OLD", Date.now() - 1000),
    google: (d) => {
      if (!d.interactive) throw new Error("User interaction required.");
      return granted(d.url, { access: "G-NEW" });
    }
  });
  const r = await sw.exportSheet();
  assert.equal(r.ok, true);
  assert.deepEqual(sw.windows.map((w) => w.interactive), [false, true]);
  assert.equal(sw.drives()[0].init.headers.Authorization, "Bearer G-NEW");
});

test("cancelled window: the sign-in message, nothing uploaded, nothing signed in, no CSV offer", async () => {
  const msg = "Sign in to export to Google Sheets. CSV and Excel work without signing in.";
  for (const google of [
    undefined, // window closed
    (d) => "https://test.chromiumapp.org/#error=access_denied&state=" + new URL(d.url).searchParams.get("state")
  ]) {
    const sw = loadWorker({ google });
    const r = await sw.exportSheet();
    assert.equal(r.ok, false);
    assert.equal(r.error, msg);
    assert.equal(sw.drives().length, 0);
    assert.deepEqual(sw.created, []);
    assert.equal(sw.local.auth, undefined);
    assert.equal(sw.session.sheetsExport.status, "failed");
    assert.equal(sw.session.sheetsExport.message, msg);
    assert.equal(sw.session.sheetsExport.csvFallback, false);
  }
});

test("Drive permission unticked on Google's screen: signed in, but says the permission is needed", async () => {
  const sw = loadWorker({
    google: (d) => granted(d.url, { access: "G-ACCESS-1", id: "ID-TOKEN", scope: "openid email profile" })
  });
  const r = await sw.exportSheet();
  assert.equal(r.ok, false);
  assert.match(r.error, /permission to create the sheet in your Google Drive/);
  assert.equal(sw.drives().length, 0);
  assert.equal(sw.session.googleDrive, undefined, "a token without drive.file isn't kept");
  assert.equal(sw.local.auth.accessToken, "sortcut-a");
});

test("Drive says 401: a new token, then one retry that succeeds", async () => {
  const sw = loadWorker({
    local: { auth: SIGNED_IN },
    session: held("G-OLD", Date.now() + 3600e3),
    google: (d) => granted(d.url, { access: "G-NEW" }),
    drive: (init, n) => (n === 1 ? res(401, { error: { code: 401 } }) : res(200, { id: "SHEET2" }))
  });
  const r = await sw.exportSheet();
  assert.equal(r.ok, true);
  assert.deepEqual(sw.drives().map((f) => f.init.headers.Authorization), ["Bearer G-OLD", "Bearer G-NEW"]);
  assert.deepEqual(sw.windows.map((w) => w.interactive), [false], "silent first");
  assert.deepEqual(sw.created, ["https://docs.google.com/spreadsheets/d/SHEET2/edit"]);
});

test("Drive says 403 again after the retry: no third try, and the CSV is offered", async () => {
  const sw = loadWorker({
    local: { auth: SIGNED_IN },
    session: held("G-OLD", Date.now() + 3600e3),
    google: (d) => granted(d.url, { access: "G-NEW" }),
    drive: () => res(403, { error: { code: 403 } })
  });
  const r = await sw.exportSheet();
  assert.equal(r.ok, false);
  assert.equal(sw.drives().length, 2);
  assert.equal(sw.session.sheetsExport.csvFallback, true);
  assert.deepEqual(sw.created, []);
});

test("any other upload failure: a message, and the CSV offered instead", async () => {
  for (const drive of [() => res(500, { error: {} }), () => Promise.reject(new TypeError("Failed to fetch"))]) {
    const sw = loadWorker({ local: { auth: SIGNED_IN }, session: held("G", Date.now() + 3600e3), drive });
    const r = await sw.exportSheet();
    assert.equal(r.ok, false);
    assert.equal(sw.drives().length, 1, "no retry for anything but 401/403");
    const s = sw.session.sheetsExport;
    assert.equal(s.status, "failed");
    assert.equal(s.tabId, IG_TAB);
    assert.equal(s.csvFallback, true);
    assert.match(s.message, /Google Sheets didn't accept the export \(HTTP 500\)|Couldn't reach Google Drive/);
    assert.deepEqual(sw.created, []);
  }
});

test("the pending export survives the popup closing, and runs as soon as the token arrives", async () => {
  let approve;
  const sw = loadWorker({
    google: (d) => new Promise((resolve) => (approve = () => resolve(granted(d.url, { access: "G", id: "ID" }))))
  });
  // The popup sends the click and is gone: nobody waits on the answer.
  sw.exportSheet();
  await settle();

  assert.equal(sw.windows.length, 1, "Google's window is open");
  assert.equal(sw.session.sheetsExport.status, "waiting");
  assert.equal(sw.session.sheetsExport.tabId, IG_TAB, "remembered with the tab");
  assert.equal(sw.drives().length, 0);

  // A second click from a reopened popup joins it; no second window.
  sw.exportSheet();
  await settle();
  assert.equal(sw.windows.length, 1);

  approve();
  await settle();
  assert.equal(sw.drives().length, 1, "exported without another click");
  assert.deepEqual(sw.created, ["https://docs.google.com/spreadsheets/d/SHEET1/edit"]);
  assert.equal(sw.session.sheetsExport.status, "done");
  // The data came off the Instagram tab, which was asked for it and nothing else.
  assert.deepEqual(sw.toTabs.map((t) => [t.tabId, t.msg.type]), [[IG_TAB, "sheetsCsv"]]);
  assert.deepEqual(sw.reloads, []);
});

test("a worker stopped while the export waited: the popup is told it was interrupted", async () => {
  const sw = loadWorker({ session: { sheetsExport: { status: "waiting", tabId: IG_TAB, at: Date.now() } } });
  await settle();
  assert.equal(sw.session.sheetsExport.status, "failed");
  assert.match(sw.session.sheetsExport.message, /interrupted/);
});

test("the Google access token is never in local storage, a log, or any request to Sortcut", async () => {
  const TOKENS = ["G-SECRET-1", "G-SECRET-2"];
  const sw = loadWorker({
    google: (d, n) => granted(d.url, { access: TOKENS[n - 1], id: "ID-TOKEN" }),
    drive: (init, n) => (n === 1 ? res(401, {}) : res(200, { id: "S" }))
  });
  // Signed out, so a window and a Sortcut sign-in; Drive refuses the first
  // token and a silent refresh gets the second; then the popup's account call
  // (/v1/me) and a sign-out (/v1/auth/logout).
  const r = await sw.exportSheet();
  assert.equal(r.ok, true);
  await sw.send({ type: "account" });
  assert.equal(sw.session.googleDrive.accessToken, "G-SECRET-2", "held in session storage only");
  await sw.send({ type: "signOut" });
  assert.equal(sw.session.googleDrive, undefined, "dropped at sign-out");

  const local = JSON.stringify(sw.local);
  const logs = sw.logs.join("\n");
  const backend = JSON.stringify(sw.backend());
  assert.ok(sw.backend().length >= 3, "the backend was called: " + sw.backend().map((f) => f.url));
  for (const t of TOKENS) {
    assert.ok(!local.includes(t), "local storage");
    assert.ok(!logs.includes(t), "logs");
    assert.ok(!backend.includes(t), "backend requests");
  }
  // They went to Google, and only there.
  assert.deepEqual(sw.drives().map((f) => f.init.headers.Authorization), TOKENS.map((t) => "Bearer " + t));
});
