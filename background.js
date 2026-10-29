// background.js — service worker.
// Holds the transcription pipeline. This has to live here rather than in the
// content script: under MV3 a content script's fetch is bound by the *page's*
// CORS rules, so it cannot read the Instagram CDN or reach the Sortcut API. The
// service worker runs at the extension origin and uses host_permissions instead.
//
// The video is still downloaded here, with the user's own Instagram session;
// only the file goes to Sortcut, which transcribes (and romanises) it with Groq.

importScripts("lib/config.js", "lib/auth.js");

chrome.runtime.onInstalled.addListener(function () {
  console.log("[GridSorter] installed");
});

// The public web client's app id. Not a secret and not rotated — every
// instagram.com page sends it as a constant header.
var IG_APP_ID = "936619743392459";

// Same "smallest rendition wins" rule as lib/extract.js:videoUrlOf. Duplicated
// rather than shared because that file is a page-world script that assigns to
// `window`, which doesn't exist in a service worker.
function smallestRendition(versions) {
  if (!Array.isArray(versions)) return null;
  var best = null;
  var bestPx = Infinity;
  versions.forEach(function (v) {
    if (!v || typeof v.url !== "string") return;
    var px = (v.width || 1e9) * (v.height || 1e9);
    if (px < bestPx) {
      bestPx = px;
      best = v.url;
    }
  });
  return best;
}

// Instagram's grid queries return thumbnails and counts but never a playable
// file, so the URL has to be asked for per-post at click time. This is a plain
// REST path with no doc_id or query_hash in it, which is the part of rule 1
// that actually matters — nothing here breaks when Instagram rotates its
// GraphQL ids. It rides the user's existing session cookies.
async function resolveVideoUrl(pk, code) {
  if (!pk) {
    throw new Error("No media id for this post. Re-run the sort and try again.");
  }

  var res;
  try {
    res = await fetch("https://www.instagram.com/api/v1/media/" + pk + "/info/", {
      credentials: "include",
      headers: { "x-ig-app-id": IG_APP_ID }
    });
  } catch (e) {
    throw new Error("Couldn't reach Instagram to look up the video.");
  }

  if (res.status === 401 || res.status === 403) {
    throw new Error("Instagram refused the lookup. Make sure you're logged in.");
  }
  if (res.status === 429) {
    throw new Error("Instagram is rate limiting. Wait a minute and try again.");
  }
  if (!res.ok) {
    throw new Error("Video lookup failed (HTTP " + res.status + ").");
  }

  var json = await res.json().catch(function () { return null; });
  // A logged-out or challenged session often still answers 200, with a login
  // page or a bare {message, status: "fail"} instead of the media. That is a
  // refused lookup, not a post without video, and must not be reported as one.
  if (!json || !Array.isArray(json.items) || !json.items.length) {
    var why = json && typeof json.message === "string" ? json.message : "";
    var err = new Error(
      "Instagram didn't return this reel's video details" +
      (why ? " (" + why + ")" : json ? "" : " (HTTP " + res.status + ", not JSON)") +
      ". Make sure you're logged in to Instagram, then try again."
    );
    err.detail = "media info " + res.status + (res.redirected ? " redirected to " + res.url : "");
    throw err;
  }
  var item = json.items[0];
  var url = smallestRendition(item.video_versions);

  if (!url) {
    throw new Error(
      "No video track on this post" + (code ? " (" + code + ")" : "") +
      ". Photo posts and carousels can't be transcribed."
    );
  }
  return url;
}

// Thrown before the upload, so before /submit, which is where the credit is
// charged. Sizes are decimal MB, the same unit MAX_BYTES is in.
// TEMPORARY wording for the Groq free tier — update when moving to Developer (~99 MB).
// Whole MB unless rounding would put the size at or under the limit
// ("about 24 MB, over our 24 MB limit"); then one decimal place.
function tooBig(bytes) {
  var mb = bytes / 1e6;
  var limit = Math.round(MAX_BYTES / 1e6);
  var size = Math.round(mb) <= limit ? mb.toFixed(1) : String(Math.round(mb));
  return (
    "This reel can't be transcribed \u2014 it's about " + size +
    " MB, over our current " + limit + " MB limit. No credit was used."
  );
}

async function fetchVideo(url) {
  var res;
  try {
    res = await fetch(url, { credentials: "omit" });
  } catch (e) {
    throw new Error("Couldn't download the video from Instagram. Check your connection and try again.");
  }
  if (!res.ok) {
    // The URL is normally looked up fresh on this same click, so a refusal
    // here is rarely an expired link. The status is what makes it reportable.
    if (res.status === 403 || res.status === 410) {
      throw new Error(
        "Instagram's video server refused the download (HTTP " + res.status +
        "). Reload Instagram and try again."
      );
    }
    throw new Error("Couldn't download the video (HTTP " + res.status + ").");
  }
  // Bail on the header rather than pulling down 40MB just to reject it.
  var declared = parseInt(res.headers.get("content-length") || "", 10);
  if (isFinite(declared) && declared > MAX_BYTES) {
    res.body && res.body.cancel && res.body.cancel();
    throw new Error(tooBig(declared));
  }

  var buf = await res.arrayBuffer();
  if (!buf.byteLength) throw new Error("The downloaded video was empty.");
  // Checked again because a chunked response carries no content-length.
  if (buf.byteLength > MAX_BYTES) throw new Error(tooBig(buf.byteLength));
  return buf;
}

// ---- Sortcut transcription jobs ----

var POLL_FIRST_MS = 2000;
var POLL_MAX_MS = 5000;
// The job carries on server side after this; a later click finds it again
// through the same reel's job instead of starting (and charging) a new one.
var GIVE_UP_MS = 10 * 60 * 1000;

// The status (and S3's error code, when it sends one) is kept in the text: a
// bare "didn't go through" can't be told apart from any other failure in a report.
function uploadFailed(detail) {
  return "The upload didn't go through" + (detail ? " (" + detail + ")" : "") + ". Please try again.";
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function serverMessage(res) {
  return res.data && typeof res.data.error === "string" ? res.data.error : "";
}

// Short, plain messages for the tile and popup. The backend's 402 body carries
// only a sentence, so the two cases are told apart by its wording.
function errorText(res) {
  var msg = serverMessage(res);
  if (res.status === 402) {
    if (/used all/i.test(msg)) return "You've used all your transcripts for this period.";
    if (/Sortcut Pro/i.test(msg)) return "Transcription is part of Sortcut Pro.";
    return msg || "Transcription is part of Sortcut Pro.";
  }
  if (res.status === 429) return msg || "Too many transcriptions at once. Try again shortly.";
  if (res.status === 409 || res.status === 413) return uploadFailed("HTTP " + res.status);
  return msg || "Something went wrong (HTTP " + res.status + "). Please try again.";
}

var NEEDS_PRO = "Transcription is part of Sortcut Pro.";

// The page answers this one with its Upgrade dialog rather than a failure card.
function needsProError() {
  var err = new Error(NEEDS_PRO);
  err.needsPro = true;
  return err;
}

// A refused call. The backend has the last word on the plan: a 402 that isn't
// about used-up transcripts means the account isn't Pro, whatever we last saw.
function apiError(res) {
  if (res.status === 402 && !/used all/i.test(serverMessage(res))) return needsProError();
  return new Error(errorText(res));
}

// The backend refunds a no-speech failure, so it gets its own plain wording.
var NO_SPEECH = "No speech was detected in this reel. No credit was used.";

function failedText(job) {
  if (/no speech/i.test(job.error || "")) return NO_SPEECH;
  var msg = job.error || "This transcription did not finish. Please try again.";
  if (job.refunded === true && !/credit was returned/i.test(msg)) {
    msg += " Your credit was returned.";
  }
  return msg;
}

// Same shape content.js has always downloaded as .txt.
function transcriptOf(job) {
  var text = (job.text || "").trim();
  if (!text) throw new Error(NO_SPEECH);
  return {
    text: text,
    original: job.original || null,
    language: job.language || "unknown",
    romanised: !!job.original
  };
}

// Presigned POST: the signed policy fields first, the file last, because S3
// ignores any field that comes after the file. The URL and fields are signed
// credentials in all but name, so they are never logged either.
async function upload(link, buf, code) {
  var form = new FormData();
  Object.keys(link.fields || {}).forEach(function (k) {
    form.append(k, link.fields[k]);
  });
  form.append("file", new Blob([buf], { type: "video/mp4" }), code + ".mp4");

  var res;
  try {
    res = await fetch(link.url, { method: "POST", body: form });
  } catch (e) {
    throw new Error(uploadFailed("no response"));
  }
  if (!res.ok) {
    // S3 answers with an XML <Error>; its <Code> (EntityTooLarge, AccessDenied,
    // …) names the cause and carries nothing secret.
    var xml = await res.text().catch(function () { return ""; });
    var s3Code = (/<Code>([^<]{1,64})<\/Code>/.exec(xml) || [])[1];
    throw new Error(uploadFailed("HTTP " + res.status + (s3Code ? ", " + s3Code : "")));
  }
}

// A worker that makes no extension API call for ~30 s can be stopped, and a
// fetch in flight doesn't count. The download and the S3 upload are plain
// fetches that can outlast that, so tick a cheap runtime call until they end.
var KEEPALIVE_MS = 20 * 1000;

async function keepAlive(work) {
  var timer = setInterval(function () {
    chrome.runtime.getPlatformInfo().catch(function () {});
  }, KEEPALIVE_MS);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

// Every pass reads storage (inside api) and may message the tab; both are
// extension API calls, which is what keeps an MV3 worker from idling out
// during a long wait.
async function waitForJob(jobId, status, tell) {
  var giveUpAt = Date.now() + GIVE_UP_MS;
  var delay = POLL_FIRST_MS;
  for (;;) {
    tell(status === "queued" ? "Waiting in queue…" : "Transcribing…");
    if (Date.now() + delay > giveUpAt) {
      throw new Error("Still processing — click again later to fetch it.");
    }
    await sleep(delay);
    delay = Math.min(POLL_MAX_MS, delay * 1.25);

    var res;
    try {
      res = await api("/v1/transcriptions/" + encodeURIComponent(jobId));
    } catch (e) {
      if (e.signedOut) throw e;
      continue; // a dropped poll costs nothing; the job carries on
    }
    if (res.status >= 500) continue;
    if (!res.ok) throw apiError(res);

    var job = res.data || {};
    if (job.status === "done") return transcriptOf(job);
    if (job.status === "failed") throw new Error(failedText(job));
    status = job.status;
  }
}

async function run(post, tell) {
  if (!post || !post.code) throw new Error("No post data. Re-run the sort and try again.");

  // Signed out: the page shows its own sign-in dialog, and the Google window
  // opens only from that dialog's button (pageSignIn below), never straight
  // from a Transcribe click.
  if (!(await getAuth())) throw signedOutError("You need to be signed in first.");
  // Signed in on Free: the page shows its Upgrade dialog. Checked here only so
  // the answer is clear and immediate; the backend enforces it regardless.
  if (!(await isPro())) throw needsProError();

  tell("Transcribing…");
  var res = await api("/v1/transcriptions", { method: "POST", body: { reelCode: post.code } });
  if (!res.ok) throw apiError(res);
  var job = res.data || {};

  // Transcribed before and still cached: free, and no download at all.
  if (job.status === "done") return transcriptOf(job);
  if (!job.jobId) throw new Error("Something went wrong on our side. Please try again.");

  // Only a job that is waiting for its file gets an upload link. Anything
  // already queued or processing skips straight to waiting.
  if (job.upload) {
    tell("Uploading…");
    // Normally null — grid payloads don't carry a rendition — so this almost
    // always falls through to the on-demand lookup.
    var url = post.videoUrl || (await resolveVideoUrl(post.pk, post.code));
    await keepAlive(async function () {
      var buf = await fetchVideo(url);
      await upload(job.upload, buf, post.code);
    });

    var sub = await api("/v1/transcriptions/" + encodeURIComponent(job.jobId) + "/submit", {
      method: "POST"
    });
    if (!sub.ok) throw apiError(sub);
    // The credit is charged at submit, so the popup's usage line is now stale.
    await clearMeCache();
    // Keep polling the job this click created; only its status comes from
    // /submit, whose body isn't relied on to echo the id back.
    job = { jobId: job.jobId, status: (sub.data && sub.data.status) || job.status };
  }

  return waitForJob(job.jobId, job.status, tell);
}

// Status lines for the tile that asked, while its job waits on the server.
function progressTo(sender, code) {
  var last = null;
  return function (label) {
    if (!sender.tab || label === last) return;
    last = label;
    chrome.tabs
      .sendMessage(
        sender.tab.id,
        { type: "transcribeProgress", code: code, label: label },
        { frameId: sender.frameId }
      )
      .catch(function () {}); // tab closed or navigated: nothing to update
  };
}

// What the plan unlocks, for the popup and the page. Free sorts reach back
// FREE_DAYS; Pro has the full history, the outlier sorts and transcription.
async function planInfo() {
  var plan = await currentPlan();
  return { plan: plan, pro: PRO_PLANS[plan] === 1, freeDays: FREE_DAYS, freeMaxReels: FREE_MAX_REELS };
}

// ---- Sort state ----
// content.js stamps the popup's sort state with the tab and page load it
// belongs to. Only this side knows a tab's id, and only this side hears a tab
// close, so ending the state on a new page load or a closed tab happens here.
async function dropSortState(tabId, keepLoad) {
  var s = (await chrome.storage.local.get({ sortState: null })).sortState;
  if (s && s.tabId === tabId && s.loadId !== keepLoad) await chrome.storage.local.remove("sortState");
}

chrome.tabs.onRemoved.addListener(function (tabId) {
  dropSortState(tabId, null).catch(function () {});
});

// ---- Export to Google Sheets ----
// The CSV export's text, uploaded to the user's Drive with the instruction to
// convert it into a Google Sheet: one multipart request, no Sheets API, and
// the data never passes through Sortcut (decisions.md §12).
//
// The export, and then its outcome, is kept in session storage under the tab
// it came from. The popup closes as soon as Google's window takes focus, so
// this record is what carries the export across that window, and what the
// popup shows when it's opened again.
var SHEETS_KEY = "sheetsExport"; // chrome.storage.session: { status, tabId, at, message?, csvFallback? }
var DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";

function sheetsState(s) {
  return chrome.storage.session.set({ [SHEETS_KEY]: Object.assign({ at: Date.now() }, s) });
}

// A failure the user can still get their data out of, as a CSV download.
function sheetsFailed(message) {
  var err = new Error(message);
  err.csvFallback = true;
  return err;
}

// The sorted reels live on the Instagram tab; signing in never reloads it.
async function sheetCsv(tabId) {
  var r;
  try {
    r = await chrome.tabs.sendMessage(tabId, { type: "sheetsCsv" });
  } catch (e) {
    throw new Error("Open the Instagram tab you sorted, then try again.");
  }
  if (!r || !r.ok || typeof r.csv !== "string") {
    throw new Error("Nothing to export on this page. Run a sort first.");
  }
  return r;
}

function localDate() {
  var d = new Date();
  var two = function (n) { return (n < 10 ? "0" : "") + n; };
  return d.getFullYear() + "-" + two(d.getMonth() + 1) + "-" + two(d.getDate());
}

// Returns { status, id } for any answer; throws only when there was none.
async function uploadSheet(token, name, csv) {
  var boundary = "sortcut-" + crypto.randomUUID();
  var meta = { name: name, mimeType: "application/vnd.google-apps.spreadsheet" };
  var body =
    "--" + boundary + "\r\n" +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    JSON.stringify(meta) + "\r\n" +
    "--" + boundary + "\r\n" +
    "Content-Type: text/csv; charset=UTF-8\r\n\r\n" +
    csv + "\r\n" +
    "--" + boundary + "--";
  var res;
  try {
    res = await fetch(DRIVE_UPLOAD, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "multipart/related; boundary=" + boundary
      },
      body: body
    });
  } catch (e) {
    throw sheetsFailed("Couldn't reach Google Drive. Check your connection and try again.");
  }
  var data = await res.json().catch(function () { return null; });
  return { status: res.status, id: res.ok && data && typeof data.id === "string" ? data.id : null };
}

async function runSheetsExport(tabId) {
  await sheetsState({ status: "waiting", tabId: tabId });
  var token = await driveToken(false);

  // The export pending across Google's window: run it now the token is here.
  var pending = (await chrome.storage.session.get(SHEETS_KEY))[SHEETS_KEY];
  if (pending && typeof pending.tabId === "number") tabId = pending.tabId;
  await sheetsState({ status: "uploading", tabId: tabId });

  var page = await sheetCsv(tabId);
  var name = "@" + page.username + " reels \u00b7 Sortcut \u00b7 " + localDate();
  var up = await keepAlive(function () { return uploadSheet(token, name, page.csv); });
  // Expired, or the permission was taken back: a new token once, then once more.
  if (up.status === 401 || up.status === 403) {
    token = await driveToken(true);
    up = await keepAlive(function () { return uploadSheet(token, name, page.csv); });
  }
  if (!up.id) {
    throw sheetsFailed("Google Sheets didn't accept the export (HTTP " + up.status + ").");
  }

  var url = "https://docs.google.com/spreadsheets/d/" + encodeURIComponent(up.id) + "/edit";
  await chrome.tabs.create({ url: url });
  await sheetsState({ status: "done", tabId: tabId });
  return url;
}

// One export at a time: a second click while Google's window is open joins
// the first rather than opening another.
var exportingSheet = null;

function exportToSheets(tabId) {
  if (!exportingSheet) {
    exportingSheet = runSheetsExport(tabId)
      .catch(async function (err) {
        await sheetsState({
          status: "failed",
          tabId: tabId,
          message: err && err.message ? err.message : String(err),
          csvFallback: !!(err && err.csvFallback)
        });
        throw err;
      })
      .finally(function () {
        exportingSheet = null;
      });
  }
  return exportingSheet;
}

// A worker that starts up can't be the one waiting on Google: an export left
// waiting or uploading belonged to a worker that was stopped mid-way.
chrome.storage.session.get(SHEETS_KEY).then(function (o) {
  var s = o && o[SHEETS_KEY];
  if (exportingSheet || !s || (s.status !== "waiting" && s.status !== "uploading")) return;
  return sheetsState({
    status: "failed",
    tabId: s.tabId,
    message: "The export to Google Sheets was interrupted. Please try again.",
    csvFallback: true
  });
}).catch(function () {});

async function account() {
  var a;
  if (!(await getAuth())) {
    a = { signedIn: false };
  } else {
    try {
      a = { signedIn: true, me: await getMe() };
    } catch (e) {
      a = e.signedOut
        ? { signedIn: false, error: e.message }
        : { signedIn: true, me: null, error: e.message };
    }
  }
  // When getMe answered, it's cached, so this costs no second request.
  return Object.assign(a, await planInfo());
}

function reply(promise, sendResponse, wrap) {
  promise.then(
    function (r) {
      sendResponse(wrap(r));
    },
    function (err) {
      sendResponse({
        ok: false,
        error: err && err.message ? err.message : String(err),
        signedOut: !!(err && err.signedOut),
        needsPro: !!(err && err.needsPro)
      });
    }
  );
  return true; // keep the channel open for the async reply
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg) return false;
  if (msg.type === "transcribe") {
    var code = msg.post && msg.post.code;
    var tell = progressTo(sender, code);
    // The one place every transcription failure passes through, so this is
    // where the service-worker console shows it, with any detail that doesn't
    // belong in the on-page text.
    var job = run(msg.post, tell).catch(function (err) {
      if (!(err && (err.signedOut || err.needsPro))) {
        console.warn("[GridSorter] transcription failed", code, "—", err && err.message,
          err && err.detail ? "(" + err.detail + ")" : "");
      }
      throw err;
    });
    return reply(job, sendResponse, function (r) {
      return { ok: true, result: r };
    });
  }
  // From the page's sign-in dialog. Unlike the popup's signIn it doesn't load
  // /v1/me afterwards: the transcription it was opened for is the next call.
  if (msg.type === "pageSignIn") {
    return reply(signIn(), sendResponse, function () { return { ok: true }; });
  }
  // Every page load in an Instagram tab. A load that carries on a sort the
  // popup just started (keep) re-stamps the state itself; any other load ends
  // the one the tab had.
  if (msg.type === "pageLoad") {
    var tabId = sender.tab ? sender.tab.id : null;
    var done = msg.keep || tabId === null ? Promise.resolve() : dropSortState(tabId, msg.loadId);
    return reply(done, sendResponse, function () { return { ok: true, tabId: tabId }; });
  }
  // From the popup. Sign-in runs here rather than in the popup because the
  // Google window takes focus and closes the popup mid-flow.
  var asAccount = function (a) { return { ok: true, account: a }; };
  if (msg.type === "account") return reply(account(), sendResponse, asAccount);
  if (msg.type === "plan") {
    return reply(planInfo(), sendResponse, function (p) { return { ok: true, plan: p }; });
  }
  if (msg.type === "signIn") return reply(signIn().then(account), sendResponse, asAccount);
  // Answered when the sheet is open, or failed. The popup has usually closed
  // by then; it reads the outcome from session storage instead.
  if (msg.type === "sheetsExport") {
    return reply(exportToSheets(msg.tabId), sendResponse, function (url) { return { ok: true, url: url }; });
  }
  if (msg.type === "signOut") return reply(signOut().then(account), sendResponse, asAccount);
  return false;
});
