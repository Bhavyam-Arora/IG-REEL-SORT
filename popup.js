// popup.js
var $ = function (id) { return document.getElementById(id); };

function setStatus(text, tone) {
  var el = $("status");
  el.textContent = text || "";
  el.hidden = !text;
  el.classList.remove("good", "bad");
  if (tone) el.classList.add(tone);
}

function working(on) {
  $("ranks").classList.toggle("working", !!on);
  $("go").disabled = !!on;
}

function exportsEnabled(on) {
  $("csv").disabled = !on;
  $("json").disabled = !on;
  $("xlsx").disabled = !on;
  $("sheets").disabled = !on;
}

// ---- Plan ----
// The worker decides (isPro in lib/auth.js); the popup only shows what it
// says. Until it answers, treat this as Free: the sort click asks again anyway.
// Free sees Pro's choices in both menus, greyed out, marked Pro, and can't pick
// them.
var PRO_SORTS = { outlier: 1, outlierLikes: 1, outlierComments: 1 };
// Where a Pro-only sort lands on Free: the same metric, without the score.
var FREE_SORT = { outlier: "views", outlierLikes: "likes", outlierComments: "comments" };
// freeMaxReels is the worker's FREE_MAX_REELS; this is it until it answers.
var plan = { pro: false, freeMaxReels: 50 };

// Pro's default depth is the one popup.html selects. Free's is the deepest it
// may choose. Either only until the depth is picked by hand.
var PRO_LIMIT = $("limit").value;
var limitPicked = false;

$("limit").addEventListener("change", function () { limitPicked = true; });

// cb gets the worker's answer, or null when it didn't give one.
function getPlan(cb) {
  chrome.runtime.sendMessage({ type: "plan" }, function (res) {
    cb(chrome.runtime.lastError || !res || !res.ok ? null : res.plan);
  });
}

function freeDepth(value) {
  return value !== "all" && parseInt(value, 10) <= plan.freeMaxReels;
}

// Grey out, and mark, what this plan can't choose.
function lockOptions(select, freeOk) {
  select.querySelectorAll("option").forEach(function (o) {
    if (!o.hasAttribute("data-label")) o.setAttribute("data-label", o.textContent);
    var locked = !plan.pro && !freeOk(o.value);
    o.disabled = locked;
    o.textContent = o.getAttribute("data-label") + (locked ? " \u2014 Pro" : "");
  });
}

function deepestFreeLimit() {
  var best = null;
  $("limit").querySelectorAll("option").forEach(function (o) {
    if (freeDepth(o.value)) best = o.value;
  });
  return best;
}

// Run on every plan answer: sign-in, sign-out, the plan loading. A choice the
// plan no longer allows falls back to one it does.
function applyPlan(p) {
  plan = {
    pro: !!p.pro,
    freeMaxReels: p.freeMaxReels || plan.freeMaxReels
  };
  lockOptions($("sortBy"), function (v) { return !PRO_SORTS[v]; });
  lockOptions($("limit"), freeDepth);

  if (!plan.pro && PRO_SORTS[$("sortBy").value]) $("sortBy").value = FREE_SORT[$("sortBy").value];
  if (!limitPicked) $("limit").value = plan.pro ? PRO_LIMIT : deepestFreeLimit();
  else if (!plan.pro && !freeDepth($("limit").value)) $("limit").value = deepestFreeLimit();

  $("upgrade").hidden = plan.pro;
}

applyPlan(plan);

function activeTab(cb) {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    cb(tabs && tabs[0]);
  });
}

function send(tabId, msg, cb) {
  chrome.tabs.sendMessage(tabId, msg, function (res) {
    if (chrome.runtime.lastError) {
      cb(null, chrome.runtime.lastError.message);
      return;
    }
    cb(res, null);
  });
}

// ---- Where sorting is allowed ----
// Only a profile's Reels tab. lib/extract.js holds the check so the popup and
// the page scripts can't disagree about it.
var pageKind = window.__IG_SORTER_REELS__.pageKind;

// The reels-tab owner of the active tab, or null. Set on open.
var here = null;

function wrongPageMessage(kind) {
  return kind === "profileGrid"
    ? "Sortcut sorts reels only. Open this profile's Reels tab, then sort."
    : "Open an Instagram profile's Reels tab to sort.";
}

function showPage(url) {
  var kind = pageKind(url);
  here = kind.kind === "reelsTab" ? kind.owner : null;
  $("pageNote").textContent = here ? "" : wrongPageMessage(kind.kind);
  $("pageNote").hidden = !!here;
  return kind;
}

// ---- Sort state ----
// content.js keeps the run's state in storage, so it survives the popup
// closing. Each state is stamped with the tab, profile and page load it
// belongs to, and shows only on that same page: never another tab's run,
// another profile's, or one from before the page last loaded. The worker and
// content.js clear it when that page goes.
//
// Running, it shows progress. Finished, it shows nothing unless something went
// wrong on this page: the sorted grid is the result.
//
// A "running" state that's stopped updating is a run that died without saying
// so (the collector checks in every scroll); it shows nothing and doesn't hold
// the Sort button.
var STALE_MS = 90 * 1000;

// The active tab, and the page load its content script answered from.
var page = { tabId: null, loadId: null };

function onThisPage(s) {
  return !!(s && here && s.tabId === page.tabId && s.loadId === page.loadId && s.profile === here);
}

function showSortState(s) {
  if (!onThisPage(s)) {
    setStatus("");
    working(false);
    return;
  }
  var running = s.status === "running" && Date.now() - (s.updatedAt || 0) <= STALE_MS;
  working(running);
  if (running) setStatus(s.message);
  else setStatus(s.warning || "", "bad");
}

// Asks the page which load it is and whether it has sorted reels. Without an
// answer (it's mid-reload, or has no content script) nothing changes.
function pingPage(cb) {
  send(page.tabId, { type: "ping" }, function (res) {
    if (res) {
      page.loadId = res.loadId || null;
      exportsEnabled(res.have > 0);
      $("restore").hidden = !res.sorted;
    }
    cb();
  });
}

// Asked again on every change: a sort reloads the page, which makes it a new
// load, and a finished one has reels to export.
function followSortState(s) {
  if (!here) {
    showSortState(null);
    return;
  }
  pingPage(function () { showSortState(s); });
}

// On open: say straight away whether this page can be sorted, then show this
// page's run, if it has one.
activeTab(function (tab) {
  page.tabId = tab ? tab.id : null;
  showPage(tab && tab.url);
  chrome.storage.local.get({ sortState: null }, function (o) {
    followSortState(o.sortState);
  });
});

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== "local" || !changes.sortState) return;
  followSortState(changes.sortState.newValue);
});

$("go").addEventListener("click", function () {
  activeTab(function (tab) {
    // Re-checked on click: the tab may have moved since the popup opened.
    // Anywhere but a Reels tab, nothing is reloaded or scrolled.
    page.tabId = tab ? tab.id : null;
    var kind = showPage(tab && tab.url);
    if (!tab || kind.kind !== "reelsTab") return;

    // Asked fresh: the plan may have changed since the popup opened.
    getPlan(function (p) {
      // Without an answer there's no telling what this run may reach.
      if (!p) {
        setStatus("Extension worker unavailable \u2014 reload the extension.", "bad");
        return;
      }
      // Moves any choice the plan doesn't allow back to one it does.
      applyPlan(p);
      var sortBy = $("sortBy").value;

      working(true);
      exportsEnabled(false);
      setStatus("");

      // "all" travels as a string; the collector turns it into an open-ended
      // run that stops when the profile runs out of reels.
      var limitRaw = $("limit").value;
      var limit = limitRaw === "all" ? "all" : parseInt(limitRaw, 10);

      send(
        tab.id,
        // maxReels caps a Free run at so many reels; Pro has no cap. tabId
        // ties the run to this tab.
        {
          type: "startSort",
          sortBy: sortBy,
          limit: limit,
          maxReels: plan.pro ? null : plan.freeMaxReels,
          tabId: tab.id
        },
        function (res, err) {
          if (err) {
            working(false);
            setStatus("Reload the Instagram tab, then try again.", "bad");
          }
        }
      );
    });
  });
});

// ---- Transcription ----
// content.js keeps the latest outcome in storage, word for word what the page
// showed on the reel, because clicking a tile on the page closes the popup
// before the result comes back. Older than this, it's no longer news.
var TX_FRESH_MS = 30 * 60 * 1000;

function showTranscribeStatus(t) {
  var el = $("txStatus");
  var show = !!(t && t.text && Date.now() - (t.at || 0) < TX_FRESH_MS);
  el.textContent = show ? t.text : "";
  el.hidden = !show;
  el.classList.toggle("good", show && t.ok === true);
  el.classList.toggle("bad", show && t.ok !== true);
}

chrome.storage.local.get({ transcribeStatus: null }, function (o) {
  showTranscribeStatus(o.transcribeStatus);
});

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== "local" || !changes.transcribeStatus) return;
  var t = changes.transcribeStatus.newValue;
  showTranscribeStatus(t);
  // One more credit used.
  if (t && t.ok) accountCall("account");
});

function doExport(kind) {
  activeTab(function (tab) {
    send(tab.id, { type: "export", kind: kind }, function (res, err) {
      // The download is the confirmation; only a failure says anything.
      if (err || !res || !res.ok) setStatus("Nothing to export on this page. Run a sort first.", "bad");
    });
  });
}

$("csv").addEventListener("click", function () { doExport("csv"); });
$("json").addEventListener("click", function () { doExport("json"); });
$("xlsx").addEventListener("click", function () { doExport("xlsx"); });

// ---- Google Sheets ----
// The worker runs the export, Google's window included, because that window
// closes the popup. It keeps the export's progress and outcome in session
// storage for the tab it came from; the popup shows it for that tab only.
var SHEETS_TEXT = {
  waiting: "Waiting for Google\u2026",
  uploading: "Exporting to Google Sheets\u2026",
  done: "Opened in Google Sheets."
};

function showSheets(s) {
  var show = !!(s && s.tabId === page.tabId && Date.now() - (s.at || 0) < TX_FRESH_MS);
  var failed = show && s.status === "failed";
  var text = !show ? "" : failed ? s.message : SHEETS_TEXT[s.status] || "";
  $("sheetsStatus").textContent = text;
  $("sheetsStatus").hidden = !text;
  $("sheetsStatus").classList.toggle("good", show && s.status === "done");
  $("sheetsStatus").classList.toggle("bad", failed);
  $("sheetsCsv").hidden = !(failed && s.csvFallback);
}

// On open: an export started before the popup last closed, if it's this tab's.
activeTab(function (tab) {
  page.tabId = tab ? tab.id : null;
  chrome.storage.session.get({ sheetsExport: null }, function (o) {
    showSheets(o.sheetsExport);
  });
});

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area === "session" && changes.sheetsExport) showSheets(changes.sheetsExport.newValue);
});

$("sheets").addEventListener("click", function () {
  activeTab(function (tab) {
    if (!tab) return;
    chrome.runtime.sendMessage({ type: "sheetsExport", tabId: tab.id }, function (res) {
      // Any answer at all is shown from storage; only silence needs words here.
      if (chrome.runtime.lastError || !res) {
        setStatus("Extension worker unavailable \u2014 reload the extension.", "bad");
      }
    });
  });
});

$("sheetsCsv").addEventListener("click", function () { doExport("csv"); });

// ---- Account ----
// Left over from bring-your-own-key: transcription now runs on Sortcut's key,
// server side, so a stored one is just a secret sitting in storage.
chrome.storage.local.remove("groqKey");

var PLAN_LABEL = { none: "Free", pro_monthly: "Pro Monthly", pro_yearly: "Pro Yearly" };

// periodEnd is UTC midnight; read in local time it can show as the day before.
function fmtDate(iso) {
  var d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, {
    day: "numeric", month: "short", year: "numeric", timeZone: "UTC"
  });
}

// 3,000 rather than 3000. Always commas: the rest of the popup is English.
function fmtCount(n) {
  return typeof n === "number" && isFinite(n) ? n.toLocaleString("en-US") : String(n);
}

function accountNote(text) {
  $("accountNote").textContent = text || "";
  $("accountNote").hidden = !text;
}

function renderAccount(a) {
  var signedIn = !!(a && a.signedIn);
  $("signedOut").hidden = signedIn;
  $("signedIn").hidden = !signedIn;
  accountNote(a && a.error);
  applyPlan(a || {});
  if (!signedIn) return;

  var me = a.me || {};
  var pro = !!a.pro;
  $("email").textContent = me.email || "";
  // a.plan is the worker's answer, which outlasts /v1/me being unreachable.
  $("plan").textContent = PLAN_LABEL[a.plan] || "Free";

  var q = me.quota;
  var usage = "";
  if (pro && q) {
    var resets = fmtDate(q.periodEnd || me.periodEnd);
    usage = fmtCount(q.used) + " of " + fmtCount(q.limit) + " transcripts used" +
      (resets ? " \u00b7 resets " + resets : "");
  }
  $("usage").textContent = usage;
  $("usage").hidden = !usage;
}

// The worker owns sign-in and every backend call; the popup only asks it.
function accountCall(type) {
  chrome.runtime.sendMessage({ type: type }, function (res) {
    $("signIn").disabled = false;
    $("signIn").textContent = "Sign in with Google";
    $("signOut").disabled = false;
    if (chrome.runtime.lastError || !res) {
      accountNote("Extension worker unavailable \u2014 reload the extension.");
      return;
    }
    if (!res.ok) {
      accountNote(res.error);
      return;
    }
    renderAccount(res.account);
  });
}

accountCall("account");

$("signIn").addEventListener("click", function () {
  $("signIn").disabled = true;
  $("signIn").textContent = "Signing in\u2026";
  accountNote("");
  accountCall("signIn");
});

$("signOut").addEventListener("click", function () {
  $("signOut").disabled = true;
  accountCall("signOut");
});

// Sign-in started from a tile, or a session that ended, while the popup is open.
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area === "local" && changes.auth) accountCall("account");
});

// ---- Developer capture ----
// Hidden unless storage has devCapture: true (see README). Downloads the last
// raw GraphQL bodies the interceptor saw in this tab. The file is saved
// locally; nothing is sent anywhere.
chrome.storage.local.get({ devCapture: false }, function (o) {
  $("debugSample").hidden = o.devCapture !== true;
});

$("debugSample").addEventListener("click", function () {
  activeTab(function (tab) {
    if (!tab || !tab.url || tab.url.indexOf("instagram.com") === -1) {
      setStatus("Open the Instagram tab you sorted first.", "bad");
      return;
    }
    send(tab.id, { type: "debugSample" }, function (res, err) {
      if (err || !res || !res.ok) {
        setStatus((res && res.error) || "Reload the Instagram tab, then try again.", "bad");
        return;
      }
      setStatus("Debug sample saved (" + res.bodies + " GraphQL bodies).", "good");
    });
  });
});

$("restore").addEventListener("click", function () {
  activeTab(function (tab) {
    send(tab.id, { type: "restore" }, function () {
      $("restore").hidden = true;
    });
  });
});
