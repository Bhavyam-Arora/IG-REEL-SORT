// popup.js on the real popup.html: what Free and Pro see, and what each can
// start. The worker and the tab are stubs; the plan is whatever a test says.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { createDocument } = require("./dom");

const ROOT = path.join(__dirname, "..");
const REELS_TAB = "https://www.instagram.com/demo.creator/reels/";
const PRICING = "https://sortcut.co/pricing.html";

const ENTITIES = { middot: "·", amp: "&", lt: "<", gt: ">", quot: '"', mdash: "—" };
const VOID = new Set(["meta", "link", "br", "input", "img"]);

// Just enough of an HTML parser for popup.html: elements, attributes and text.
// Scripts are left out; the test runs them itself.
function loadHTML(document, html) {
  const body = html.replace(/<!--[\s\S]*?-->/g, "").split(/<body[^>]*>/)[1].split("</body>")[0];
  const stack = [document.body];
  const text = (s) => s.replace(/&(\w+);/g, (m, e) => ENTITIES[e] || m).replace(/\s+/g, " ");
  for (const [, close, tag, attrs, words] of body.matchAll(/<(\/?)(\w+)([^>]*)>|([^<]+)/g)) {
    const top = stack[stack.length - 1];
    if (words !== undefined) {
      if (words.trim()) top._text += text(words);
    } else if (close) {
      if (tag !== "script") stack.pop();
    } else {
      const el = document.createElement(tag);
      for (const [, k, v] of attrs.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) el.setAttribute(k, v ?? "");
      top.appendChild(el);
      if (!VOID.has(tag) && tag !== "script") stack.push(el);
    }
  }
}

// opts.pro / opts.signedIn: the plan the worker answers with; change them
// mid-test with p.setPlan(). opts.ping: the page's answer to "ping".
function loadPopup(opts) {
  opts = Object.assign({ ping: { ok: true, have: 0, sorted: false, loadId: "L1" } }, opts);
  const { document } = createDocument();
  loadHTML(document, fs.readFileSync(path.join(ROOT, "popup.html"), "utf8"));

  const store = Object.assign({}, opts.store);
  const sessionStore = Object.assign({}, opts.session);
  const toTab = [];
  const toWorker = [];
  const changed = [];
  const plan = () => ({
    plan: opts.pro ? "pro_monthly" : "none", pro: !!opts.pro, freeMaxReels: 50
  });
  const account = () => {
    const signedIn = opts.signedIn !== false;
    return Object.assign(
      { signedIn, me: signedIn ? { email: "test@example.com", plan: plan().plan, quota: opts.quota } : undefined },
      plan()
    );
  };
  const chrome = {
    runtime: {
      lastError: undefined,
      sendMessage(msg, cb) {
        toWorker.push(msg);
        if (msg.type === "plan") cb(opts.workerDown ? undefined : { ok: true, plan: plan() });
        if (["account", "signIn", "signOut"].includes(msg.type)) cb({ ok: true, account: account() });
        // The export's outcome comes through session storage, not this answer.
        if (msg.type === "sheetsExport") cb({ ok: true });
      }
    },
    tabs: {
      query: (q, cb) => cb([{ id: 7, url: opts.url || REELS_TAB }]),
      sendMessage(id, msg, cb) {
        toTab.push(msg);
        cb(msg.type === "ping" ? opts.ping : { ok: true });
      }
    },
    storage: {
      local: {
        get: (defaults, cb) => cb(Object.assign({}, defaults, store)),
        remove() {}
      },
      session: {
        get: (defaults, cb) => cb(Object.assign({}, defaults, sessionStore))
      },
      onChanged: { addListener: (fn) => changed.push(fn) }
    }
  };

  const w = { document, chrome, console: { log() {}, warn() {} } };
  w.window = w;
  vm.createContext(w);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "lib/extract.js"), "utf8"), w);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "popup.js"), "utf8"), w);

  const $ = (id) => document.getElementById(id);
  const options = (id) => $(id).querySelectorAll("option");
  return {
    $,
    toTab,
    toWorker,
    starts: () => toTab.filter((m) => m.type === "startSort"),
    choose(id, value) {
      $(id).value = value;
      $(id).dispatchEvent({ type: "change" });
    },
    links: (href) => document.querySelectorAll("a").filter((a) => a.href === href),
    labels: (id) => options(id).map((o) => o.textContent.trim()),
    locked: (id) => options(id).filter((o) => o.disabled).map((o) => o.value),
    setPlan(o) { Object.assign(opts, o); },
    setPing(o) { opts.ping = Object.assign({}, opts.ping, o); },
    // A sortState write, as content.js makes it.
    state(s) {
      for (const fn of changed) fn({ sortState: { newValue: s } }, "local");
    },
    // A sheetsExport write, as the worker makes it.
    sheets(s) {
      for (const fn of changed) fn({ sheetsExport: { newValue: s } }, "session");
    },
    status: () => ($("status").hidden ? null : $("status").textContent),
    text: () => document.body.textContent
  };
}

const OUTLIERS = ["outlier", "outlierLikes", "outlierComments"];
const DEEP = ["100", "200", "300", "all"];
// A state for the page the popup is on: tab 7, its reels tab, page load L1.
const here = (s) =>
  Object.assign({ tabId: 7, loadId: "L1", profile: "demo.creator", updatedAt: Date.now() }, s);

// ---- Free: Pro's choices visible, disabled ----

test("Free: the outlier sorts are greyed out, marked Pro, and can't be chosen", () => {
  const p = loadPopup({ pro: false });
  assert.deepEqual(p.labels("sortBy"), [
    "Views",
    "Outlier score · views — Pro",
    "Likes",
    "Outlier score · likes — Pro",
    "Comments",
    "Outlier score · comments — Pro"
  ]);
  assert.deepEqual(p.locked("sortBy"), OUTLIERS);
});

test("Free: depth is 25 or 50 reels, default 50; deeper is greyed out and marked Pro", () => {
  const p = loadPopup({ pro: false });
  assert.deepEqual(p.labels("limit"), [
    "25 reels · fast",
    "50 reels",
    "100 reels — Pro",
    "200 reels — Pro",
    "300 reels · slow — Pro",
    "All reels · slowest — Pro"
  ]);
  assert.deepEqual(p.locked("limit"), DEEP);
  assert.equal(p.$("limit").value, "50");
});

test("Free: no Pro notes anywhere but the one Upgrade link in Account", () => {
  for (const signedIn of [true, false]) {
    const p = loadPopup({ pro: false, signedIn });
    assert.equal(p.$("proNote"), null);
    assert.equal(p.$("rangeNote"), null);
    p.choose("sortBy", "likes");
    const links = p.links(PRICING);
    assert.equal(links.length, 1);
    assert.equal(links[0].id, "upgrade");
    assert.equal(links[0].textContent.trim(), "Upgrade to Pro");
    assert.equal(links[0].hidden, false, signedIn ? "signed in" : "signed out");
    assert.ok(links[0].parentElement.classList.contains("account"));
  }
});

test("Free: a sort starts capped at 50 reels, with no date range", () => {
  for (const mode of ["views", "likes", "comments"]) {
    for (const limit of ["25", "50"]) {
      const p = loadPopup({ pro: false });
      p.choose("sortBy", mode);
      p.choose("limit", limit);
      p.$("go").click();
      assert.deepEqual({ ...p.starts()[0] }, {
        type: "startSort", sortBy: mode, limit: Number(limit), maxReels: 50, tabId: 7
      });
    }
  }
});

// ---- Pro: everything ----

test("Pro: every choice enabled, unmarked, depth default unchanged", () => {
  const p = loadPopup({ pro: true });
  assert.deepEqual(p.locked("sortBy"), []);
  assert.deepEqual(p.locked("limit"), []);
  assert.ok(p.labels("sortBy").concat(p.labels("limit")).every((l) => !/Pro/.test(l)));
  assert.equal(p.$("limit").value, "100");
  assert.equal(p.$("upgrade").hidden, true);
});

test("Pro: every sort and depth starts, with no cap", () => {
  for (const mode of ["views", "likes", "comments", ...OUTLIERS]) {
    const p = loadPopup({ pro: true });
    p.choose("sortBy", mode);
    p.choose("limit", "all");
    p.$("go").click();
    assert.deepEqual({ ...p.starts()[0] }, {
      type: "startSort", sortBy: mode, limit: "all", maxReels: null, tabId: 7
    });
  }
});

// ---- Plan changes ----

test("signing out of Pro: the menus lock at once, and Pro choices fall back", () => {
  const p = loadPopup({ pro: true });
  p.choose("sortBy", "outlierLikes");
  p.choose("limit", "300");
  p.setPlan({ pro: false, signedIn: false });
  p.$("signOut").click();
  assert.deepEqual(p.locked("sortBy"), OUTLIERS);
  assert.deepEqual(p.locked("limit"), DEEP);
  assert.equal(p.$("sortBy").value, "likes", "the same metric, unscored");
  assert.equal(p.$("limit").value, "50");
  assert.equal(p.$("upgrade").hidden, false);
});

test("signing in to Pro: everything unlocks, and an untouched depth takes Pro's default", () => {
  const p = loadPopup({ pro: false, signedIn: false });
  assert.equal(p.$("limit").value, "50");
  p.setPlan({ pro: true, signedIn: true });
  p.$("signIn").click();
  assert.deepEqual(p.locked("limit"), []);
  assert.equal(p.$("limit").value, "100");
  assert.equal(p.$("upgrade").hidden, true);
});

test("signing in to Pro keeps a depth picked by hand", () => {
  const p = loadPopup({ pro: false, signedIn: false });
  p.choose("limit", "25");
  p.setPlan({ pro: true, signedIn: true });
  p.$("signIn").click();
  assert.equal(p.$("limit").value, "25");
});

test("a plan that lapses before Sort is clicked: the run uses allowed choices", () => {
  const p = loadPopup({ pro: true });
  p.choose("sortBy", "outlier");
  p.choose("limit", "all");
  p.setPlan({ pro: false });
  p.$("go").click();
  assert.deepEqual({ ...p.starts()[0] }, {
    type: "startSort", sortBy: "views", limit: 50, maxReels: 50, tabId: 7
  });
});

test("worker not answering: no sort starts, rather than one with no range", () => {
  const p = loadPopup({ pro: false, workerDown: true });
  p.$("go").click();
  assert.deepEqual(p.starts(), []);
  assert.match(p.status(), /Extension worker unavailable/);
});

// ---- Status: progress and warnings for this page only ----

test("a finished sort shows no summary, Free or Pro", () => {
  for (const pro of [false, true]) {
    const p = loadPopup({
      pro,
      ping: { ok: true, have: 13, sorted: true, loadId: "L1" },
      store: { sortState: here({ status: "done", count: 13, warning: null }) }
    });
    assert.equal(p.status(), null);
    assert.doesNotMatch(p.text(), /Sorted|last 50 days|full history/);
    assert.equal(p.$("csv").disabled, false, "but its reels export");
  }
});

test("a running sort on this page shows its progress and holds the Sort button", () => {
  const p = loadPopup({
    store: { sortState: here({ status: "running", message: "Collecting reels… 12 of 50 so far." }) }
  });
  assert.equal(p.status(), "Collecting reels… 12 of 50 so far.");
  assert.equal(p.$("go").disabled, true);
});

test("warnings for this page show once the sort is over", () => {
  for (const warning of [
    "This profile hasn't posted any reels.",
    "Couldn't read reels — Instagram may have changed something.",
    "Stopped at the 3-minute time limit — sorted the 87 reels collected by then."
  ]) {
    const p = loadPopup({ store: { sortState: here({ status: "stopped", count: 0, warning }) } });
    assert.equal(p.status(), warning);
    assert.ok(p.$("status").classList.contains("bad"));
    assert.equal(p.$("go").disabled, false);
  }
});

test("the wrong page says so, and shows no sort", () => {
  const p = loadPopup({
    url: "https://www.instagram.com/demo.creator/",
    store: { sortState: here({ status: "stopped", warning: "This profile hasn't posted any reels." }) }
  });
  assert.equal(p.$("pageNote").hidden, false);
  assert.match(p.$("pageNote").textContent, /Open this profile's Reels tab/);
  assert.equal(p.status(), null);
  assert.equal(p.$("csv").disabled, true);
});

test("another tab's, another profile's, or an earlier page load's sort never shows", () => {
  const running = { status: "running", message: "Collecting reels… 3 of 50 so far." };
  for (const other of [{ tabId: 8 }, { profile: "someone.else" }, { loadId: "L0" }]) {
    const p = loadPopup({ store: { sortState: here(Object.assign({}, running, other)) } });
    assert.equal(p.status(), null, JSON.stringify(other));
    assert.equal(p.$("go").disabled, false, JSON.stringify(other));
  }
});

test("a run that stopped checking in doesn't hold the Sort button", () => {
  const p = loadPopup({
    store: { sortState: here({ status: "running", message: "Collecting…", updatedAt: Date.now() - 5 * 60 * 1000 }) }
  });
  assert.equal(p.status(), null);
  assert.equal(p.$("go").disabled, false);
});

test("live: the sort's own reload is followed, and its end enables export", () => {
  const p = loadPopup({ pro: false });
  p.$("go").click();
  assert.equal(p.$("go").disabled, true);

  // content.js before the reload, then the reloaded page (a new load).
  p.state(here({ status: "running", message: "Reloading and collecting reels…" }));
  assert.equal(p.status(), "Reloading and collecting reels…");
  p.setPing({ loadId: "L2" });
  p.state(here({ loadId: "L2", status: "running", message: "Collecting reels… 20 of 50 so far." }));
  assert.equal(p.status(), "Collecting reels… 20 of 50 so far.");
  assert.equal(p.$("csv").disabled, true);

  p.setPing({ have: 50, sorted: true });
  p.state(here({ loadId: "L2", status: "done", count: 50, warning: null }));
  assert.equal(p.status(), null);
  assert.equal(p.$("go").disabled, false);
  assert.equal(p.$("csv").disabled, false);
  assert.equal(p.$("restore").hidden, false);
});

test("live: state cleared (tab left the profile) clears the popup too", () => {
  const p = loadPopup({
    ping: { ok: true, have: 13, sorted: true, loadId: "L1" },
    store: { sortState: here({ status: "stopped", count: 13, warning: "Stopped at the 3-minute time limit — sorted the 13 reels collected by then." }) }
  });
  assert.ok(p.status());
  p.setPing({ have: 0, sorted: false });
  p.state(undefined);
  assert.equal(p.status(), null);
  assert.equal(p.$("csv").disabled, true);
});

// ---- Exports ----

const EXPORTS = ["csv", "json", "xlsx", "sheets"];

test("export buttons, Google Sheets included, are enabled only when this page has sorted reels", () => {
  const none = loadPopup({ store: { sortState: here({ status: "done", count: 13, warning: null }) } });
  assert.deepEqual(EXPORTS.map((id) => none.$(id).disabled), [true, true, true, true]);
  const some = loadPopup({ ping: { ok: true, have: 13, sorted: true, loadId: "L1" } });
  assert.deepEqual(EXPORTS.map((id) => some.$(id).disabled), [false, false, false, false]);
});

test("Export Excel sits next to CSV and JSON and asks the page for an .xlsx", () => {
  const p = loadPopup({ pro: false, ping: { ok: true, have: 3, sorted: true, loadId: "L1" } });
  const buttons = p.$("csv").parentElement.querySelectorAll("button").map((b) => b.textContent.trim());
  assert.deepEqual(buttons, ["Export CSV", "Export JSON", "Export Excel", "Export to Google Sheets"]);
  p.$("xlsx").click();
  assert.deepEqual({ ...p.toTab.find((m) => m.type === "export") }, { type: "export", kind: "xlsx" });
  assert.equal(p.status(), null, "the download is the confirmation");
});

// ---- Google Sheets ----

const SHOWN = { ok: true, have: 3, sorted: true, loadId: "L1" };

test("Google Sheets: Free or Pro, the click asks the worker to export this tab", () => {
  for (const pro of [false, true]) {
    const p = loadPopup({ pro, ping: SHOWN });
    p.$("sheets").click();
    assert.deepEqual({ ...p.toWorker.find((m) => m.type === "sheetsExport") }, { type: "sheetsExport", tabId: 7 });
    assert.ok(!p.toTab.some((m) => m.type === "export"), "nothing downloaded");
  }
});

test("Google Sheets: progress and outcome show for this tab only", () => {
  const p = loadPopup({ ping: SHOWN });
  p.sheets({ status: "waiting", tabId: 7, at: Date.now() });
  assert.equal(p.$("sheetsStatus").textContent, "Waiting for Google…");
  p.sheets({ status: "uploading", tabId: 7, at: Date.now() });
  assert.equal(p.$("sheetsStatus").textContent, "Exporting to Google Sheets…");
  p.sheets({ status: "done", tabId: 7, at: Date.now() });
  assert.equal(p.$("sheetsStatus").textContent, "Opened in Google Sheets.");
  p.sheets({ status: "uploading", tabId: 8, at: Date.now() });
  assert.equal(p.$("sheetsStatus").hidden, true, "another tab's export");
});

test("Google Sheets: cancelled says CSV and Excel need no sign-in, with no CSV button", () => {
  const msg = "Sign in to export to Google Sheets. CSV and Excel work without signing in.";
  const p = loadPopup({ ping: SHOWN, session: { sheetsExport: { status: "failed", tabId: 7, at: Date.now(), message: msg } } });
  assert.equal(p.$("sheetsStatus").textContent, msg);
  assert.equal(p.$("sheetsCsv").hidden, true);
});

test("Google Sheets: a failed upload offers the CSV, which downloads from this tab", () => {
  const p = loadPopup({ ping: SHOWN });
  p.sheets({ status: "failed", tabId: 7, at: Date.now(), message: "Google Sheets didn't accept the export (HTTP 500).", csvFallback: true });
  assert.equal(p.$("sheetsStatus").hidden, false);
  assert.equal(p.$("sheetsCsv").hidden, false);
  assert.equal(p.$("sheetsCsv").textContent.trim(), "Download CSV instead");
  p.$("sheetsCsv").click();
  assert.deepEqual({ ...p.toTab.find((m) => m.type === "export") }, { type: "export", kind: "csv" });
});

test("Google Sheets: reopening the popup shows the outcome of an export it started before closing", () => {
  const p = loadPopup({ ping: SHOWN, session: { sheetsExport: { status: "done", tabId: 7, at: Date.now() } } });
  assert.equal(p.$("sheetsStatus").textContent, "Opened in Google Sheets.");
});

// ---- Account ----

test("Pro usage line: counts with thousands separators", () => {
  const p = loadPopup({
    pro: true,
    quota: { used: 1250, limit: 3000, periodEnd: "2027-10-01T00:00:00Z" }
  });
  assert.equal(p.$("usage").hidden, false);
  assert.match(p.$("usage").textContent, /^1,250 of 3,000 transcripts used · resets /);
});
