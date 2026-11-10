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
  const pendingSends = [];
  const plan = () => ({
    plan: opts.pro ? "pro_monthly" : "none", pro: !!opts.pro, freeMaxReels: 50
  });
  const account = () => {
    const signedIn = opts.signedIn !== false;
    return Object.assign(
      {
        signedIn,
        me: signedIn
          ? Object.assign({ email: "test@example.com", plan: plan().plan, quota: opts.quota }, opts.me)
          : undefined
      },
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
        // Error reports: opts.reportPreview answers the preview (none: the
        // worker is silent). A send is answered only when the test says, with
        // p.answerSend().
        if (msg.type === "reportPreview" && opts.reportPreview) cb(opts.reportPreview(msg));
        if (msg.type === "sendReport") pendingSends.push(cb);
        if (msg.type === "declineReport") cb({ ok: true });
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
    answerSend: (reply) => pendingSends.splice(0).forEach((cb) => cb(reply)),
    click: (id) => $(id).dispatchEvent({ type: "click" }),
    key: (key) => document.dispatchEvent({ type: "keydown", key }),
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

// ---- The signed rules' notice ----

test("rules notice: a remote copy's notice is a small line; none otherwise", () => {
  const notice = "Instagram changed today; sorting may be slower.";
  const p = loadPopup({ store: { rules: { version: 3, source: "remote", notice } } });
  assert.equal(p.$("rulesNotice").hidden, false);
  assert.equal(p.$("rulesNotice").textContent, notice);

  for (const rules of [null, { version: 3, source: "remote" }, { version: 2, notice: "not from the server" }]) {
    const q = loadPopup({ store: { rules } });
    assert.equal(q.$("rulesNotice").hidden, true, JSON.stringify(rules));
  }
});

test("rules notice: set as text, never as markup", () => {
  const src = fs.readFileSync(path.join(ROOT, "popup.js"), "utf8");
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(src), "popup.js writes no HTML");
  const p = loadPopup({ store: { rules: { version: 3, source: "remote", notice: "<b>hi</b>" } } });
  assert.equal(p.$("rulesNotice").textContent, "<b>hi</b>");
  assert.equal(p.$("rulesNotice").querySelectorAll("b").length, 0);
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

test("avatar: the first letter of the name, uppercase; the email's when there's no name", () => {
  const initial = (me) => loadPopup({ me }).$("avatar").textContent;
  assert.equal(initial({ name: "bhavya Arora", email: "kc@example.com" }), "B");
  assert.equal(initial({ name: "  Émile", email: "kc@example.com" }), "É");
  assert.equal(initial({ email: "kartik@example.com" }), "K");
  assert.equal(initial({ name: "", email: "zed@example.com" }), "Z");
  assert.equal(initial({ name: null, email: "9lives@example.com" }), "9");
  assert.equal(initial({ email: "" }), "?");
});

test("account: no footer line; signed in is the avatar alone, signed out a small Sign in button", () => {
  const inP = loadPopup({ pro: true });
  assert.equal(inP.$("plan"), null, "no plan name line");
  assert.equal(inP.$("signedIn").hidden, false);
  assert.equal(inP.$("signIn").hidden, true);
  assert.equal(inP.$("acctMenu").hidden, true, "menu closed until clicked");
  assert.ok(!/test@example\.com/.test(inP.text().replace(inP.$("acctMenu").textContent, "")),
    "the email shows only in the menu");
  assert.equal(inP.$("planPill").textContent, "Pro");
  assert.match(inP.text(), /Sorting runs entirely in your browser/);
  assert.match(inP.text(), /Reels you transcribe are sent to Sortcut and our transcription provider \(Groq\) to create the text, then deleted\./,
    "the transcription data notice");

  const out = loadPopup({ signedIn: false });
  assert.equal(out.$("signedIn").hidden, true);
  assert.equal(out.$("signIn").hidden, false);
  assert.equal(out.$("signIn").textContent, "Sign in");
  assert.ok(out.$("signIn").classList.contains("secondary"));
  out.click("signIn");
  assert.ok(out.toWorker.some((m) => m.type === "signIn"), "the existing sign-in");
});

test("avatar menu: email, Pro usage, Manage account and Sign out; closes on outside click and Esc", () => {
  const p = loadPopup({ pro: true, quota: { used: 12, limit: 200, periodEnd: "2026-11-24T00:00:00Z" } });
  const menu = p.$("acctMenu");
  p.click("avatar");
  assert.equal(menu.hidden, false);
  assert.equal(p.$("avatar").getAttribute("aria-expanded"), "true");
  assert.equal(p.$("email").textContent, "test@example.com");
  // The date in the browser's own locale, as before.
  assert.match(p.$("usage").textContent, /^12 of 200 transcripts used · resets (24 Nov|Nov 24),? 2026$/);
  const manage = p.$("manage");
  assert.equal(manage.href, "https://accounts.sortcut.co");
  assert.equal(manage.getAttribute("target"), "_blank");
  assert.equal(manage.textContent, "Manage account");
  assert.equal(p.$("signOut").textContent, "Sign out");

  // A click inside stays open; outside closes.
  p.click("email");
  assert.equal(menu.hidden, false);
  p.click("go");
  assert.equal(menu.hidden, true);
  assert.equal(p.$("avatar").getAttribute("aria-expanded"), "false");

  p.click("avatar");
  p.click("avatar");
  assert.equal(menu.hidden, true, "the avatar toggles it");
  p.click("avatar");
  p.key("Escape");
  assert.equal(menu.hidden, true);

  // Sign out: the existing action, and the menu and avatar go.
  p.click("avatar");
  p.setPlan({ pro: false, signedIn: false });
  p.click("signOut");
  assert.ok(p.toWorker.some((m) => m.type === "signOut"));
  assert.equal(menu.hidden, true);
  assert.equal(p.$("signedIn").hidden, true);
  assert.equal(p.$("signIn").hidden, false);
});

test("avatar menu: Free has no usage line", () => {
  const p = loadPopup({ pro: false, quota: { used: 1, limit: 5, periodEnd: "2026-11-24T00:00:00Z" } });
  p.click("avatar");
  assert.equal(p.$("usage").hidden, true);
  assert.equal(p.$("email").textContent, "test@example.com");
});

test("transcription: a finished transcript never shows in the popup; a failure still does", () => {
  const at = Date.now();
  const ready = loadPopup({ store: { transcribeStatus: { ok: true, code: "R1", text: "Transcript ready (English).", at } } });
  assert.equal(ready.$("txStatus").hidden, true);
  assert.doesNotMatch(ready.text(), /Transcript ready/);
  // Nor on another page.
  const elsewhere = loadPopup({
    url: "https://www.instagram.com/",
    store: { transcribeStatus: { ok: true, code: "R1", text: "Transcript ready (English).", at } }
  });
  assert.doesNotMatch(elsewhere.text(), /Transcript ready/);

  const failed = loadPopup({ store: { transcribeStatus: { ok: false, code: "R1", text: "Transcription failed.", at } } });
  assert.equal(failed.$("txStatus").hidden, false);
  assert.equal(failed.$("txStatus").textContent, "Transcription failed.");
  assert.ok(failed.$("txStatus").classList.contains("bad"));
});

test("Pro usage line: counts with thousands separators", () => {
  const p = loadPopup({
    pro: true,
    quota: { used: 1250, limit: 3000, periodEnd: "2027-10-01T00:00:00Z" }
  });
  assert.equal(p.$("usage").hidden, false);
  assert.match(p.$("usage").textContent, /^1,250 of 3,000 transcripts used · resets /);
});

// ---- Error report ----

const OFFER = {
  id: "L1", reason: "reels_but_none_from_profile", rulesSource: "builtin", rulesVersion: 2,
  responsesSeen: 14, postsFound: 0, scrolls: 11, durationMs: 31234, arc: false
};
const REPORT = {
  reason: "reels_but_none_from_profile", extensionVersion: "0.2.0", rulesVersion: 2, rulesSource: "builtin",
  browser: "chrome", browserMajor: 141, responsesSeen: 14, postsFound: 0, scrolls: 11, durationMs: 31234
};
const FAILED = here({
  status: "stopped", count: 0, codes: ["reels_but_none_from_profile"],
  warning: "Couldn't read reels — Instagram may have changed something.", report: OFFER
});
const allow = () => ({ ok: true, allowed: true, report: REPORT });
const reportSends = (p) => p.toWorker.filter((m) => m.type === "sendReport");

test("report: a failed sort the worker allows asks, joined to the failure card, and sends nothing yet", () => {
  const p = loadPopup({ store: { sortState: FAILED }, reportPreview: allow });
  assert.equal(p.status(), FAILED.warning, "the failure itself still shows");
  assert.equal(p.$("report").hidden, false);
  assert.ok(p.$("status").classList.contains("has-report"));
  const text = p.$("report").textContent.replace(/\s+/g, " ");
  assert.match(text, /Sort didn't work — Instagram may have changed something\./);
  assert.match(text, /Send an anonymous error report\? It only includes the error type, version numbers and browser — no profile names or data\./);
  assert.equal(p.$("reportSend").textContent.trim(), "Send report");
  assert.equal(p.$("reportNo").textContent.trim(), "No thanks");
  assert.equal(p.$("reportThanks").hidden, true);
  assert.doesNotMatch(text, /always/i, "no always-send option");
  const preview = p.toWorker.find((m) => m.type === "reportPreview");
  assert.deepEqual(preview.offer, OFFER);
  assert.equal(reportSends(p).length, 0, "nothing sent without the click");
});

test("report: What's sent? shows the exact report as text, before anything is sent", () => {
  const p = loadPopup({ store: { sortState: FAILED }, reportPreview: allow });
  assert.equal(p.$("reportBody").hidden, true);
  p.click("reportWhat");
  assert.equal(p.$("reportBody").hidden, false);
  assert.equal(p.$("reportWhat").getAttribute("aria-expanded"), "true");
  assert.deepEqual(JSON.parse(p.$("reportBody").textContent), REPORT);
  assert.equal(reportSends(p).length, 0);
  p.click("reportWhat");
  assert.equal(p.$("reportBody").hidden, true);
});

test("report: Send report sends once through the worker, then thanks the user", () => {
  const p = loadPopup({ store: { sortState: FAILED }, reportPreview: allow });
  p.click("reportSend");
  assert.equal(reportSends(p).length, 1);
  assert.deepEqual(reportSends(p)[0].offer, OFFER);
  assert.equal(p.$("reportSend").disabled, true, "no second click while it sends");
  assert.equal(p.$("reportNo").disabled, true);
  p.answerSend({ ok: true, sent: true });
  assert.equal(p.$("reportAsk").hidden, true);
  assert.equal(p.$("reportThanks").hidden, false);
  assert.equal(p.$("reportThanks").textContent.trim(), "Thanks — report sent.");
});

test("report: a send that fails, or a worker that answers nothing useful, still thanks quietly", () => {
  for (const reply of [{ ok: false, error: "x" }, undefined]) {
    const p = loadPopup({ store: { sortState: FAILED }, reportPreview: allow });
    p.click("reportSend");
    p.answerSend(reply);
    assert.equal(p.$("reportThanks").hidden, false);
    assert.doesNotMatch(p.text(), /couldn't send|not sent|failed/i);
    assert.equal(p.status(), FAILED.warning, "the card says nothing more");
  }
});

test("report: No thanks hides it, tells the worker, and sends nothing", () => {
  const p = loadPopup({ store: { sortState: FAILED }, reportPreview: allow });
  p.click("reportNo");
  assert.equal(p.$("report").hidden, true);
  assert.ok(!p.$("status").classList.contains("has-report"));
  assert.deepEqual(p.toWorker.filter((m) => m.type === "declineReport").map((m) => m.offer.id), ["L1"]);
  assert.equal(reportSends(p).length, 0);
  assert.equal(p.status(), FAILED.warning);
});

test("report: not asked when the worker says no (a daily limit, or already answered) or doesn't answer", () => {
  for (const reportPreview of [() => ({ ok: true, allowed: false, report: null }), () => undefined, null]) {
    const p = loadPopup({ store: { sortState: FAILED }, reportPreview });
    assert.equal(p.$("report").hidden, true);
    assert.equal(p.status(), FAILED.warning);
  }
});

test("report: never asked without an offer, while running, off this page or off a Reels tab", () => {
  const states = {
    "no offer": here({ status: "stopped", warning: "This profile hasn't posted any reels.", report: null }),
    success: here({ status: "done", count: 13, warning: null }),
    running: here({ status: "running", message: "Collecting reels…", report: OFFER }),
    "another tab": Object.assign({}, FAILED, { tabId: 9 }),
    "another profile": Object.assign({}, FAILED, { profile: "other.studio" })
  };
  for (const [name, sortState] of Object.entries(states)) {
    const p = loadPopup({ store: { sortState }, reportPreview: allow });
    assert.equal(p.$("report").hidden, true, name);
    assert.ok(!p.toWorker.some((m) => m.type === "reportPreview"), name + ": not even previewed");
  }
  const grid = loadPopup({ url: "https://www.instagram.com/demo.creator/", store: { sortState: FAILED }, reportPreview: allow });
  assert.equal(grid.$("report").hidden, true, "profile grid, not the Reels tab");
});

test("report: a new sort starting takes the question away", () => {
  const p = loadPopup({ store: { sortState: FAILED }, reportPreview: allow });
  assert.equal(p.$("report").hidden, false);
  p.setPing({ loadId: "L2" });
  p.state(here({ loadId: "L2", status: "running", message: "Collecting reels…" }));
  assert.equal(p.$("report").hidden, true);
});

// ---- The Sort by list, the depth segments and the plan pill ----
// They only show the two menus above and pick in them.

const rows = (p, id) => p.$(id).querySelectorAll("button");
const row = (p, id, value) => rows(p, id).find((b) => b.getAttribute("data-value") === value);
const checked = (p, id) => rows(p, id).filter((b) => b.getAttribute("aria-checked") === "true").map((b) => b.getAttribute("data-value"));

test("list: Views, Likes, Comments, then the outlier sorts; Free's Pro rows locked, Pro's open", () => {
  const free = loadPopup({ pro: false });
  assert.deepEqual(rows(free, "sortList").map((b) => b.getAttribute("data-value")),
    ["views", "likes", "comments", ...OUTLIERS]);
  assert.deepEqual(rows(free, "sortList").filter((b) => b.disabled).map((b) => b.getAttribute("data-value")), OUTLIERS);
  assert.deepEqual(checked(free, "sortList"), ["views"]);
  assert.deepEqual(rows(free, "limitSeg").filter((b) => b.disabled).map((b) => b.getAttribute("data-value")), DEEP);
  assert.deepEqual(checked(free, "limitSeg"), ["50"]);
  assert.equal(free.$("planPill").textContent, "Free");
  assert.ok(!free.$("planPill").classList.contains("pro"));

  const pro = loadPopup({ pro: true });
  assert.ok(rows(pro, "sortList").concat(rows(pro, "limitSeg")).every((b) => !b.disabled));
  assert.deepEqual(checked(pro, "limitSeg"), ["100"]);
  assert.equal(pro.$("planPill").textContent, "Pro");
  assert.ok(pro.$("planPill").classList.contains("pro"));
});

test("list: a click picks in the menu, and that is what the sort starts with", () => {
  const p = loadPopup({ pro: true });
  row(p, "sortList", "outlierComments").click();
  row(p, "limitSeg", "300").click();
  assert.equal(p.$("sortBy").value, "outlierComments");
  assert.deepEqual(checked(p, "sortList"), ["outlierComments"]);
  assert.deepEqual(checked(p, "limitSeg"), ["300"]);
  assert.equal(p.$("limitHint").textContent, "300 reels · slow");
  p.$("go").click();
  assert.deepEqual({ ...p.starts()[0] }, {
    type: "startSort", sortBy: "outlierComments", limit: 300, maxReels: null, tabId: 7
  });
});

test("list: on Free a locked row or segment can't be picked", () => {
  const p = loadPopup({ pro: false });
  row(p, "sortList", "outlier").click();
  row(p, "limitSeg", "all").click();
  assert.equal(p.$("sortBy").value, "views");
  assert.equal(p.$("limit").value, "50");
  assert.deepEqual(checked(p, "sortList"), ["views"]);
});

test("segments: a depth clicked counts as picked by hand, kept when signing in to Pro", () => {
  const p = loadPopup({ pro: false, signedIn: false });
  row(p, "limitSeg", "25").click();
  p.setPlan({ pro: true, signedIn: true });
  p.$("signIn").click();
  assert.equal(p.$("limit").value, "25");
  assert.deepEqual(checked(p, "limitSeg"), ["25"]);
});

test("list: a plan change that moves a choice moves the check with it", () => {
  const p = loadPopup({ pro: true });
  row(p, "sortList", "outlierLikes").click();
  p.setPlan({ pro: false, signedIn: false });
  p.$("signOut").click();
  assert.deepEqual(checked(p, "sortList"), ["likes"]);
  assert.deepEqual(checked(p, "limitSeg"), ["50"]);
  assert.equal(p.$("planPill").textContent, "Free");
});
