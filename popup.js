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
  var page = pageKind(url);
  here = page.kind === "reelsTab" ? page.owner : null;
  $("pageNote").textContent = here ? "" : wrongPageMessage(page.kind);
  $("pageNote").hidden = !!here;
  return page;
}

// ---- Sort state ----
// content.js keeps the run's state in storage, so it survives the popup
// closing. A "running" state that's stopped updating belongs to a tab that was
// closed or reloaded mid-run. The collector checks in every scroll, but a
// background tab's timers can be throttled to once a minute.
var STALE_MS = 90 * 1000;

function showSortState(s) {
  if (!s) {
    setStatus(here ? "Ready to sort @" + here + "'s reels." : "");
    return;
  }
  var stale = s.status === "running" && Date.now() - (s.updatedAt || 0) > STALE_MS;
  var mine = s.profile && here && s.profile.toLowerCase() === here;
  var text = stale ? "Sort interrupted \u2014 the tab was closed or reloaded." : s.message;
  setStatus("@" + s.profile + " \u00b7 " + text, stale ? "bad" : s.tone || null);
  working(s.status === "running" && !stale && mine);
}

function readSortState() {
  chrome.storage.local.get({ sortState: null }, function (o) {
    showSortState(o.sortState);
  });
}

// On open: say straight away whether this page can be sorted, show the last
// run, and ask the page whether it already has sorted results to export.
activeTab(function (tab) {
  showPage(tab && tab.url);
  readSortState();
  if (!tab || !here) return;
  send(tab.id, { type: "ping" }, function (res) {
    if (res && res.have > 0) {
      $("csv").disabled = false;
      $("json").disabled = false;
      $("restore").hidden = false;
    }
  });
});

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== "local" || !changes.sortState) return;
  var s = changes.sortState.newValue;
  showSortState(s);
  if (s && s.status !== "running" && s.count > 0 && s.profile && s.profile.toLowerCase() === here) {
    $("csv").disabled = false;
    $("json").disabled = false;
    $("restore").hidden = false;
  }
});

$("go").addEventListener("click", function () {
  activeTab(function (tab) {
    // Re-checked on click: the tab may have moved since the popup opened.
    // Anywhere but a Reels tab, nothing is reloaded or scrolled.
    var page = showPage(tab && tab.url);
    if (!tab || page.kind !== "reelsTab") return;
    var sortBy = $("sortBy").value;
    working(true);
    $("csv").disabled = true;
    $("json").disabled = true;

    // "all" travels as a string; the collector turns it into an open-ended run
    // that stops when the profile runs out of reels.
    var limitRaw = $("limit").value;
    var limit = limitRaw === "all" ? "all" : parseInt(limitRaw, 10);

    send(
      tab.id,
      { type: "startSort", sortBy: sortBy, limit: limit },
      function (res, err) {
        if (err) {
          working(false);
          setStatus("Reload the Instagram tab, then try again.", "bad");
        }
      }
    );
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
      if (err || !res || !res.ok) {
        setStatus("Nothing to export yet. Run a sort first.", "bad");
        return;
      }
      setStatus("Exported " + res.count + " reels as " + kind.toUpperCase() + ".", "good");
    });
  });
}

$("csv").addEventListener("click", function () { doExport("csv"); });
$("json").addEventListener("click", function () { doExport("json"); });

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

function accountNote(text) {
  $("accountNote").textContent = text || "";
  $("accountNote").hidden = !text;
}

function renderAccount(a) {
  var signedIn = !!(a && a.signedIn);
  $("signedOut").hidden = signedIn;
  $("signedIn").hidden = !signedIn;
  accountNote(a && a.error);
  if (!signedIn) return;

  var me = a.me || {};
  var pro = me.plan === "pro_monthly" || me.plan === "pro_yearly";
  $("email").textContent = me.email || "";
  $("plan").textContent = a.me ? PLAN_LABEL[me.plan] || "Free" : "";
  $("upgrade").hidden = !a.me || pro;

  var q = me.quota;
  var usage = "";
  if (pro && q) {
    var resets = fmtDate(q.periodEnd || me.periodEnd);
    usage = q.used + " of " + q.limit + " transcripts used" + (resets ? " \u00b7 resets " + resets : "");
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
      setStatus("Original grid restored.");
      $("restore").hidden = true;
    });
  });
});
