// popup.js
var $ = function (id) { return document.getElementById(id); };

function setStatus(text, tone) {
  var el = $("status");
  el.textContent = text;
  el.classList.remove("good", "bad");
  if (tone) el.classList.add(tone);
}

function working(on) {
  $("ranks").classList.toggle("working", !!on);
  $("go").disabled = !!on;
}

// Which metric each sort ranks on. The views-based ones carry the reels-only
// caveat; the likes and comments outliers work on any post.
var SORT_FIELD = {
  views: "views",
  outlier: "views",
  likes: "likes",
  outlierLikes: "likes",
  comments: "comments",
  outlierComments: "comments"
};

var IS_OUTLIER = { outlier: 1, outlierLikes: 1, outlierComments: 1 };

function isViewBased(sortBy) {
  return SORT_FIELD[sortBy] === "views";
}

function fmtNum(n) {
  if (n === null || n === undefined) return "—";
  if (n >= 1000000) return (n / 1000000).toFixed(n >= 10000000 ? 0 : 1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(n >= 100000 ? 0 : 1) + "K";
  return String(n);
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

// On open, ask the page whether it already has sorted results.
activeTab(function (tab) {
  if (!tab || !tab.url || tab.url.indexOf("instagram.com") === -1) {
    setStatus("Open an Instagram profile to begin.");
    return;
  }
  send(tab.id, { type: "ping" }, function (res) {
    if (res && res.have > 0) {
      setStatus(res.have + " posts ready. Export below.", "good");
      $("csv").disabled = false;
      $("json").disabled = false;
      $("restore").hidden = false;
    }
  });
});

$("go").addEventListener("click", function () {
  activeTab(function (tab) {
    if (!tab || !tab.url || tab.url.indexOf("instagram.com") === -1) {
      setStatus("Open an Instagram profile first.", "bad");
      return;
    }
    var sortBy = $("sortBy").value;
    if (isViewBased(sortBy) && tab.url.indexOf("/reels") === -1) {
      setStatus("Tip: views only exist on the Reels tab. Sorting anyway.", null);
    } else {
      setStatus("Reloading and collecting\u2026");
    }
    working(true);
    $("csv").disabled = true;
    $("json").disabled = true;

    // "all" travels as a string; the collector turns it into an open-ended run
    // that stops when the profile runs out of posts.
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

chrome.runtime.onMessage.addListener(function (msg) {
  if (msg.type === "sortProgress") {
    working(true);
    // An "all posts" run has no target to count towards.
    setStatus(
      "Collected " + msg.collected +
      (msg.target ? " of " + msg.target : "") + "\u2026"
    );
  }
  if (msg.type === "sortDone") {
    working(false);
    if (!msg.count) {
      setStatus(
        "Captured nothing. Intercepted " + (msg.hits || 0) +
        " responses. Try the Reels tab or a public profile.",
        "bad"
      );
      return;
    }
    var note = "";
    var rest = msg.count - msg.ranked;
    var metric = SORT_FIELD[msg.sortBy] || msg.sortBy;
    if (typeof msg.ranked === "number" && rest > 0) {
      note = " " + msg.ranked + " have " + metric + ", " + rest + " don't.";
    }
    if (IS_OUTLIER[msg.sortBy] && msg.median) {
      note += " Median " + fmtNum(Math.round(msg.median)) + " " + metric + ".";
    }
    if (msg.target && msg.count < msg.target) {
      // Short of the requested depth means the profile ran out of posts, not
      // that the metric filtered any out \u2014 worth distinguishing.
      note += " Profile only had " + msg.total + " posts.";
    }
    setStatus(
      "Sorted " + msg.count + " of " + msg.total + " collected." + note +
      (msg.rendered ? "" : " Grid not found \u2014 export still works."),
      "good"
    );
    $("csv").disabled = false;
    $("json").disabled = false;
    $("restore").hidden = false;
  }
  if (msg.type === "sortError") {
    working(false);
    setStatus("Couldn't find the grid on this page.", "bad");
  }
  // The tile shows its own success state, so the popup only needs to surface
  // the failure reason — which is too long to fit on a tile.
  if (msg.type === "transcribeError") {
    setStatus(msg.error || "Transcription failed.", "bad");
  }
  if (msg.type === "transcribeDone") {
    setStatus("Transcript saved (" + (msg.language || "unknown") + ").", "good");
    // One more credit used.
    accountCall("account");
  }
});

function doExport(kind) {
  activeTab(function (tab) {
    send(tab.id, { type: "export", kind: kind }, function (res, err) {
      if (err || !res || !res.ok) {
        setStatus("Nothing to export yet. Run a sort first.", "bad");
        return;
      }
      setStatus("Exported " + res.count + " posts as " + kind.toUpperCase() + ".", "good");
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

$("restore").addEventListener("click", function () {
  activeTab(function (tab) {
    send(tab.id, { type: "restore" }, function () {
      setStatus("Original grid restored.");
      $("restore").hidden = true;
    });
  });
});
