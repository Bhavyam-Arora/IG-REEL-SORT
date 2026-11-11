// background.js — service worker.
// Holds the transcription pipeline. This has to live here rather than in the
// content script: under MV3 a content script's fetch is bound by the *page's*
// CORS rules, so it cannot read the Instagram CDN or reach the Sortcut API. The
// service worker runs at the extension origin and uses host_permissions instead.
//
// The video is still downloaded here, with the user's own Instagram session;
// only the file goes to Sortcut, which transcribes (and romanises) it with Groq.

importScripts("lib/config.js", "lib/auth.js", "lib/rules.js", "lib/rules-public-key.js", "lib/remote-rules.js");

// The health log, from this worker's DevTools console (chrome://extensions →
// Sortcut → service worker): sortLog() prints the last 50 sorts, newest first,
// as a table and returns them. content.js writes them to
// chrome.storage.local.health; they stay on this machine. A function
// declaration, so it's a global from the moment this script is parsed,
// whatever runs after it.
async function sortLog() {
  var list = (await chrome.storage.local.get({ health: [] })).health || [];
  console.table(
    list.map(function (e) {
      return Object.assign({}, e, { codes: (e.codes || []).join(" ") });
    })
  );
  return list;
}
self.sortLog = sortLog;
// Entries kept, shared with content.js's LOG_MAX.
var HEALTH_MAX = 50;
console.log("[GridSorter] worker started \u2014 run sortLog() to see the health log");

// Same content, whatever the key order: chrome.storage hands objects back with
// their keys sorted, so a plain JSON.stringify comparison never matches.
function sameJson(a, b) {
  function canon(v) {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === "object") {
      var out = {};
      Object.keys(v).sort().forEach(function (k) { out[k] = canon(v[k]); });
      return out;
    }
    return v;
  }
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

// content.js hands the page scripts the rules from storage (it can't read
// lib/rules.js itself), so the bundled copy has to be there. An MV3 worker only
// runs when an event wakes it, so the copy is written on every occasion that
// does: install and update (which includes Reload on chrome://extensions),
// browser startup, any other wake-up, and on request — content.js asks with
// getRules whenever it finds none and uses the reply. A stored copy with a
// higher version is newer than this build's and stays.
//
// Resolves to the rules now in storage (the bundled copy if storage fails).
// Writes queue behind each other, so a wake-up that fires several events at
// once (start-up plus onInstalled) writes once.
var rulesQueue = Promise.resolve();
function mirrorRules(why) {
  rulesQueue = rulesQueue.then(function () {
    return writeRules(why);
  });
  return rulesQueue;
}

async function writeRules(why) {
  try {
    var stored = (await chrome.storage.local.get({ rules: null })).rules;
    if (stored && typeof stored.version === "number" && stored.version > SORTCUT_RULES.version) return stored;
    if (!sameJson(stored, SORTCUT_RULES)) {
      await chrome.storage.local.set({ rules: SORTCUT_RULES });
      console.log("[GridSorter] rules v" + SORTCUT_RULES.version + " stored (" + why + ")");
    }
  } catch (e) {
    console.warn("[GridSorter] couldn't store the rules (" + why + ")", e);
  }
  return SORTCUT_RULES;
}

// ---- Remote rules ----
// Newer rules may come from GET {API_BASE}/v1/rules, signed on the admin's
// Mac. lib/remote-rules.js decides whether a reply is used; this fetches it
// and stores an accepted copy where the bundled one lives
// (chrome.storage.local.rules, marked source "remote"), so content.js and the
// page scripts pick it up on the next page load unchanged.
//
// Checked at most once an hour, on every occasion that wakes the worker
// (install and update, browser startup, any other wake-up) and before each
// sort, without alarms: rulesLastCheckedAt in storage says when the last check
// began, whatever came of it. The backend has no "no change" reply yet, so the
// full rules come back each time; ?have= tells it what we hold. A failed,
// slow, unverified or older reply keeps the current rules, quietly: one line
// in this worker's console says why.
var RULES_URL = API_BASE + "/v1/rules";
var RULES_CHECK_EVERY_MS = 60 * 60 * 1000;
var RULES_FETCH_TIMEOUT_MS = 8000;

var rulesCheck = null; // the check in flight, so a wake-up that fires several events checks once
function checkRemoteRules(why) {
  if (!rulesCheck) {
    rulesCheck = runRulesCheck(why).finally(function () {
      rulesCheck = null;
    });
  }
  return rulesCheck;
}

// Resolves to what happened: "fresh" (checked within the hour), "unreachable",
// "accepted", "kept", "failed", or why the reply was refused.
async function runRulesCheck(why) {
  try {
    var now = Date.now();
    var last = (await chrome.storage.local.get({ rulesLastCheckedAt: 0 })).rulesLastCheckedAt;
    // A time ahead of the clock (the clock was set back) doesn't hold checks off.
    if (typeof last === "number" && last <= now && now - last < RULES_CHECK_EVERY_MS) return "fresh";
    await chrome.storage.local.set({ rulesLastCheckedAt: now });

    var current = await mirrorRules(why);
    var reply = await fetchRemoteRules(current.version);
    if (!reply) {
      console.log("[GridSorter] remote rules: unreachable, keeping v" + current.version + " (" + why + ")");
      return "unreachable";
    }
    var verdict = await judgeRemoteRules(reply, {
      builtinVersion: SORTCUT_RULES.version,
      storedVersion: current.version,
      extensionVersion: chrome.runtime.getManifest().version
    }, crypto.subtle);
    if (!verdict.ok) {
      console.log("[GridSorter] remote rules: not used, " + verdict.reason + " (" + why + ")");
      return verdict.reason;
    }
    return await storeRemoteRules(verdict, why);
  } catch (e) {
    console.warn("[GridSorter] remote rules: check failed (" + why + ")", e);
    return "failed";
  }
}

// The reply as parsed JSON, or null on any network error, timeout, non-200
// or oversized body.
async function fetchRemoteRules(haveVersion) {
  var ctl = new AbortController();
  var timer = setTimeout(function () { ctl.abort(); }, RULES_FETCH_TIMEOUT_MS);
  try {
    var res = await fetch(RULES_URL + "?have=" + encodeURIComponent(haveVersion), {
      credentials: "omit",
      signal: ctl.signal
    });
    if (res.status !== 200) return null;
    if (Number(res.headers.get("content-length")) > REMOTE_RULES_MAX_TEXT) return null;
    var text = await res.text();
    if (text.length > REMOTE_RULES_MAX_TEXT) return null;
    return JSON.parse(text);
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Queued behind the bundled copy's writes, so neither overwrites the other; a
// copy stored meanwhile that is as new or newer stays. Like mirrorRules, the
// queue resolves to the rules now in storage. Resolves to "accepted", "kept"
// or "failed".
function storeRemoteRules(verdict, why) {
  var outcome = "failed";
  rulesQueue = rulesQueue.then(async function () {
    try {
      var stored = (await chrome.storage.local.get({ rules: null })).rules;
      if (stored && typeof stored.version === "number" && stored.version >= verdict.version) {
        outcome = "kept";
        return stored;
      }
      await chrome.storage.local.set({ rules: verdict.rules });
      console.log("[GridSorter] remote rules v" + verdict.version + " stored (" + why + ")");
      outcome = "accepted";
      return verdict.rules;
    } catch (e) {
      console.warn("[GridSorter] couldn't store the remote rules (" + why + ")", e);
      return SORTCUT_RULES;
    }
  });
  return rulesQueue.then(function () {
    return outcome;
  });
}

chrome.runtime.onInstalled.addListener(function (details) {
  console.log("[GridSorter] installed (" + (details && details.reason) + ")");
  mirrorRules("installed");
  checkRemoteRules("installed");
});

chrome.runtime.onStartup.addListener(function () {
  mirrorRules("startup");
  checkRemoteRules("startup");
});

mirrorRules("worker start");
checkRemoteRules("worker start");

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

// The CDN hosts manifest.json's host_permissions cover. An audio link on any
// other host is passed over for the video, never fetched.
var CDN_HOST_SUFFIXES = [".cdninstagram.com", ".fbcdn.net"];

function onAllowedCdn(url) {
  try {
    var u = new URL(url);
    return u.protocol === "https:" && CDN_HOST_SUFFIXES.some(function (h) {
      return u.hostname.slice(-h.length) === h;
    });
  } catch (e) {
    return false;
  }
}

function xmlText(s) {
  return s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos));/gi, function (m, dec, hex, name) {
    if (dec) return String.fromCodePoint(+dec);
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[name.toLowerCase()];
  });
}

function xmlAttr(tag, name) {
  var m = new RegExp("\\s" + name + '="([^"]*)"').exec(tag);
  return m ? xmlText(m[1]) : null;
}

// The reel's audio on its own, out of video_dash_manifest (an MPD, as a
// string): the lowest-bandwidth audio Representation's BaseURL, which is a
// whole playable .mp4 of just the sound — a small fraction of the video's
// bytes, and the words are the same. Regexes rather than DOMParser, which a
// service worker doesn't have. { url } or { reason } for the timing line.
function audioTrackOf(manifest) {
  if (typeof manifest !== "string" || !manifest) return { reason: "no manifest" };
  var sawAudio = false;
  var best = null;
  var bestBw = Infinity;
  (manifest.match(/<AdaptationSet\b[\s\S]*?<\/AdaptationSet>/g) || []).forEach(function (set) {
    var head = /<AdaptationSet\b[^>]*>/.exec(set)[0];
    var setIsAudio = xmlAttr(head, "contentType") === "audio" || /^audio\//.test(xmlAttr(head, "mimeType") || "");
    (set.match(/<Representation\b[^>]*?(?:\/>|>[\s\S]*?<\/Representation>)/g) || []).forEach(function (r) {
      var rHead = /<Representation\b[^>]*>/.exec(r)[0];
      if (!setIsAudio && !/^audio\//.test(xmlAttr(rHead, "mimeType") || "")) return;
      sawAudio = true;
      var base = /<BaseURL>([^<]+)<\/BaseURL>/.exec(r);
      var url = base ? xmlText(base[1]).trim() : "";
      if (!/^https:\/\//.test(url)) return;
      var bw = parseInt(xmlAttr(rHead, "bandwidth") || "", 10);
      if (!isFinite(bw)) bw = Infinity;
      if (!best || bw < bestBw) {
        best = url;
        bestBw = bw;
      }
    });
  });
  if (!sawAudio) return { reason: "no audio track" };
  if (!best) return { reason: "no BaseURL" };
  if (!onAllowedCdn(best)) return { reason: "audio host not allowed" };
  return { url: best };
}

// Instagram's grid queries return thumbnails and counts but never the DASH
// manifest, so the files have to be asked for per-post at click time. This is
// a plain REST path with no doc_id or query_hash in it, which is the part of
// rule 1 that actually matters — nothing here breaks when Instagram rotates
// its GraphQL ids. It rides the user's existing session cookies.
// { video, audio: { url } | { reason } }.
async function lookupMedia(pk, code) {
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
  return { video: url, audio: audioTrackOf(item.video_dash_manifest) };
}

// A post that already carries a video link (the grid had one) still asks for
// the manifest, for the audio; if that lookup fails, the link it has will do.
async function findMedia(post) {
  if (!post.videoUrl) return lookupMedia(post.pk, post.code);
  if (!post.pk) return { video: post.videoUrl, audio: { reason: "no media id" } };
  try {
    return await lookupMedia(post.pk, post.code);
  } catch (e) {
    return { video: post.videoUrl, audio: { reason: "lookup failed" } };
  }
}

// The audio when there is one, else (or if it won't download) the video, as
// before. Both go through fetchVideo's size checks.
async function fetchMedia(media, t) {
  if (media.audio.url) {
    try {
      var buf = await fetchVideo(media.audio.url);
      t.source = "audio";
      return buf;
    } catch (e) {
      console.warn("[Sortcut] audio download failed, using the video —", e && e.message ? e.message : e);
      media.audio = { reason: "audio download failed" };
    }
  }
  t.source = "video";
  t.fallback = media.audio.reason;
  return fetchVideo(media.video);
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

// Every second for the first 20 s of the wait, when most jobs finish, then
// every 2 s.
var POLL_FAST_MS = 1000;
var POLL_FAST_FOR_MS = 20 * 1000;
var POLL_SLOW_MS = 2000;
// The job carries on server side after this; a later click finds it again
// through the same reel's job instead of starting (and charging) a new one.
var GIVE_UP_MS = 10 * 60 * 1000;

// The status (and S3's error code, when it sends one) is kept in the text: a
// bare "didn't go through" can't be told apart from any other failure in a report.
function uploadFailed(detail) {
  return "The upload didn't go through" + (detail ? " (" + detail + ")" : "") + ". Please try again.";
}

function pollDelay(waitedMs) {
  return waitedMs < POLL_FAST_FOR_MS ? POLL_FAST_MS : POLL_SLOW_MS;
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function serverMessage(res) {
  return res.data && typeof res.data.error === "string" ? res.data.error : "";
}

// The backend's stable name for a refusal (decisions.md §13). The wording of
// its "error" sentence may change; this may not.
function serverCode(res) {
  return res.data && typeof res.data.code === "string" ? res.data.code : "";
}

// "3:45 PM" in the user's own clock, or "" when the time can't be read.
function localTime(iso) {
  var d = new Date(iso);
  if (typeof iso !== "string" || isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// Short, plain messages for the tile and popup, chosen by the backend's code.
// not_pro never gets here: apiError turns it into the Upgrade dialog.
function errorText(res) {
  var msg = serverMessage(res);
  switch (serverCode(res)) {
    case "quota_exhausted":
      return "You've used all your transcriptions for this period. They reset when your plan renews.";
    case "quota_missing":
      return "Your transcriptions for this period aren't ready yet. Try again shortly, or write to support@sortcut.co.";
    case "too_many_running":
      return "Up to 3 transcriptions can run at once. Wait for one to finish.";
    case "hourly_limit":
      var at = localTime(res.data.retryAt);
      if (at) return "Hourly limit reached — try again after " + at + ".";
      break;
    case "":
      // API Gateway's own throttle, which carries no code and no "error".
      if (res.status === 429) return "Sortcut is busy — try again in a minute.";
  }
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

// A refused call. The backend has the last word on the plan: not_pro means the
// account isn't Pro, whatever we last saw.
function apiError(res) {
  if (serverCode(res) === "not_pro") return needsProError();
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
async function waitForJob(jobId, status, tell, t) {
  var giveUpAt = Date.now() + GIVE_UP_MS;
  t.waitFrom = Date.now();
  for (;;) {
    var delay = pollDelay(Date.now() - t.waitFrom);
    tell(status === "queued" ? "Waiting in queue…" : "Transcribing…");
    if (Date.now() + delay > giveUpAt) {
      throw new Error("Still processing — click again later to fetch it.");
    }
    await sleep(delay);

    var res;
    t.polls++;
    try {
      res = await api("/v1/transcriptions/" + encodeURIComponent(jobId));
    } catch (e) {
      if (e.signedOut) throw e;
      continue; // a dropped poll costs nothing; the job carries on
    }
    if (res.status >= 500) continue;
    if (!res.ok) throw apiError(res);

    var job = res.data || {};
    // First poll that found it out of the queue: splits the wait into queue
    // time and Groq time, to within one poll interval.
    if (job.status !== "queued" && t.queuedMs === null) t.queuedMs = Date.now() - t.waitFrom;
    if (job.status === "done") return transcriptOf(job);
    if (job.status === "failed") throw new Error(failedText(job));
    status = job.status;
  }
}

async function run(post, tell, t) {
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
  if (job.status === "done") {
    t.cached = true;
    return transcriptOf(job);
  }
  if (!job.jobId) throw new Error("Something went wrong on our side. Please try again.");

  // Only a job that is waiting for its file gets an upload link. Anything
  // already queued or processing skips straight to waiting.
  if (job.upload) {
    tell("Downloading reel…");
    var at = Date.now();
    var media = await findMedia(post);
    t.lookupMs = Date.now() - at;
    await keepAlive(async function () {
      at = Date.now();
      var buf = await fetchMedia(media, t);
      t.downloadMs = Date.now() - at;
      t.bytes = buf.byteLength;
      tell("Uploading…");
      at = Date.now();
      await upload(job.upload, buf, post.code);
      t.uploadMs = Date.now() - at;
    });

    at = Date.now();
    var sub = await api("/v1/transcriptions/" + encodeURIComponent(job.jobId) + "/submit", {
      method: "POST"
    });
    t.submitMs = Date.now() - at;
    if (!sub.ok) throw apiError(sub);
    // The credit is charged at submit, so the popup's usage line is now stale.
    await clearMeCache();
    // Keep polling the job this click created; only its status comes from
    // /submit, whose body isn't relied on to echo the id back.
    job = { jobId: job.jobId, status: (sub.data && sub.data.status) || job.status };
  }

  return waitForJob(job.jobId, job.status, tell, t);
}

// ---- Transcription timing ----
// Where a transcription's time goes, one line per job in this worker's
// console and one "transcribe" entry in the health log (the same list
// sortLog() prints). Durations, the file size and the outcome only: the reel
// code is in the console line, never in the stored entry.
function newTiming() {
  return {
    start: Date.now(), cached: false, source: null, fallback: null, bytes: null, lookupMs: null, downloadMs: null,
    uploadMs: null, submitMs: null, waitFrom: null, queuedMs: null, polls: 0
  };
}

function secs(ms) {
  return (ms / 1000).toFixed(1) + "s";
}

async function logTiming(code, t, outcome) {
  var totalMs = Date.now() - t.start;
  var waitMs = t.waitFrom === null ? null : Date.now() - t.waitFrom;
  var parts = [];
  if (t.cached) parts.push("cached");
  if (t.source === "audio") parts.push("audio");
  if (t.source === "video") parts.push("video (fallback" + (t.fallback ? ": " + t.fallback : "") + ")");
  if (t.bytes !== null) parts.push("size " + (t.bytes / 1e6).toFixed(1) + " MB");
  if (t.lookupMs !== null) parts.push("lookup " + secs(t.lookupMs));
  if (t.downloadMs !== null) parts.push("download " + secs(t.downloadMs));
  if (t.uploadMs !== null) parts.push("upload " + secs(t.uploadMs));
  if (t.submitMs !== null) parts.push("submit " + secs(t.submitMs));
  if (waitMs !== null) {
    parts.push("server wait " + secs(waitMs) + " (" +
      (t.queuedMs === null ? "" : "queued " + secs(t.queuedMs) + ", ") +
      t.polls + " poll" + (t.polls === 1 ? "" : "s") + ")");
  }
  parts.push("total " + secs(totalMs));
  if (outcome !== "done") parts.push(outcome);
  console.log("[Sortcut] transcribe " + code + ": " + parts.join(" \u00b7 "));

  var entry = {
    type: "transcribe",
    at: new Date(t.start).toISOString(),
    outcome: outcome,
    cached: t.cached,
    source: t.source,
    fallback: t.fallback,
    bytes: t.bytes,
    lookupMs: t.lookupMs,
    downloadMs: t.downloadMs,
    uploadMs: t.uploadMs,
    submitMs: t.submitMs,
    waitMs: waitMs,
    queuedMs: t.queuedMs,
    polls: t.polls,
    totalMs: totalMs
  };
  try {
    var list = (await chrome.storage.local.get({ health: [] })).health;
    list = (Array.isArray(list) ? list : []).slice(0, HEALTH_MAX - 1);
    list.unshift(entry);
    await chrome.storage.local.set({ health: list });
  } catch (e) {
    console.warn("[Sortcut] health log: couldn't save this transcription \u2014", e && e.message ? e.message : e);
  }
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

// What the plan unlocks, for the popup and the page. Free sorts up to
// FREE_MAX_REELS reels of any age; Pro has unlimited depth, the outlier sorts
// and transcription.
async function planInfo() {
  var plan = await currentPlan();
  return { plan: plan, pro: PRO_PLANS[plan] === 1, freeMaxReels: FREE_MAX_REELS };
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

// ---- Error reports ----
// After a sort that failed in a way that may mean Instagram changed
// something, the popup asks whether to send an anonymous error report.
// content.js decides when it may ask (the sort state's `report`); this side
// builds the report, keeps the daily limits, and sends it, only when the user
// clicks Send report. Nothing here is ever sent on its own.
//
// The report is exactly the 10 fields POST /v1/reports accepts and nothing
// else: no profile, URL, reel, user id, email or token. It goes without the
// sign-in (no Authorization header) and without cookies, signed in or not. A
// failed or slow send is dropped quietly, never retried.
//
// Limits, per local day, in chrome.storage.local.reportLimits: one report per
// reason and three in all. At a limit the question isn't asked at all. Each
// offer is answered once (sent or declined, reportAnswered), so reopening the
// popup doesn't ask again.
var REPORT_URL = API_BASE + "/v1/reports";
var REPORT_TIMEOUT_MS = 8000;
// The backend's REPORT_REASONS: the codes worth a report. Others are never sent.
var REPORT_REASONS = ["no_responses", "responses_but_no_reels", "reels_but_none_from_profile", "reels_missing_metric"];
var REPORT_PER_REASON_PER_DAY = 1;
var REPORT_PER_DAY = 3;
var REPORT_ANSWERED_MAX = 20;
// The backend's ranges for each count (REPORT_FIELDS); values past them are capped.
var REPORT_MAX = {
  rulesVersion: 1000000000, browserMajor: 1000, responsesSeen: 10000, postsFound: 10000,
  scrolls: 1000, durationMs: 600000
};

function boundedInt(v, max) {
  var n = Math.round(Number(v));
  return isFinite(n) ? Math.min(max, Math.max(0, n)) : 0;
}

// Which browser this is, as the backend names them, and its major version.
// Edge and Brave name themselves in the user-agent brands (Brave also has
// navigator.brave); Arc doesn't, so content.js looks for its page theme
// (arcHint). Plain Chrome names itself "Google Chrome". Anything else, or no
// brands at all, is "other".
function browserInfo(arcHint) {
  var nav = self.navigator || {};
  var brands = (nav.userAgentData && Array.isArray(nav.userAgentData.brands)) ? nav.userAgentData.brands : [];
  var ua = String(nav.userAgent || "");
  var brand = function (name) {
    var b = brands.find(function (x) { return x && x.brand === name; });
    return b ? b.version : null;
  };
  var uaMajor = function (re) {
    var m = ua.match(re);
    return m ? m[1] : null;
  };
  var chromium = brand("Chromium") || uaMajor(/Chrome\/(\d+)/);
  var name = "other";
  var major = chromium;
  if (brand("Microsoft Edge") || /\bEdg\//.test(ua)) {
    name = "edge";
    major = brand("Microsoft Edge") || uaMajor(/\bEdg\/(\d+)/) || chromium;
  } else if (brand("Brave") || nav.brave) {
    name = "brave";
    major = brand("Brave") || chromium;
  } else if (arcHint === true) {
    name = "arc";
  } else if (brand("Google Chrome")) {
    name = "chrome";
    major = brand("Google Chrome");
  }
  return { browser: name, browserMajor: boundedInt(parseInt(major, 10), REPORT_MAX.browserMajor) };
}

// The report for an offer from the sort state, field for field what is sent,
// or null when the offer isn't one a report may be sent for.
function reportBody(offer) {
  if (!offer || typeof offer !== "object" || REPORT_REASONS.indexOf(offer.reason) === -1) return null;
  var version = chrome.runtime.getManifest().version;
  if (!/^\d{1,5}(\.\d{1,5}){0,3}$/.test(version)) return null;
  var b = browserInfo(offer.arc);
  return {
    reason: offer.reason,
    extensionVersion: version,
    rulesVersion: boundedInt(offer.rulesVersion, REPORT_MAX.rulesVersion),
    rulesSource: offer.rulesSource === "remote" ? "remote" : "builtin",
    browser: b.browser,
    browserMajor: b.browserMajor,
    responsesSeen: boundedInt(offer.responsesSeen, REPORT_MAX.responsesSeen),
    postsFound: boundedInt(offer.postsFound, REPORT_MAX.postsFound),
    scrolls: boundedInt(offer.scrolls, REPORT_MAX.scrolls),
    durationMs: boundedInt(offer.durationMs, REPORT_MAX.durationMs)
  };
}

// Today's counts; a new day starts from nothing.
async function reportLimits() {
  var o = await chrome.storage.local.get({ reportLimits: null, reportAnswered: [] });
  var l = o.reportLimits;
  var today = localDate();
  if (!l || l.day !== today || typeof l.reasons !== "object" || !l.reasons) l = { day: today, total: 0, reasons: {} };
  return { limits: l, answered: Array.isArray(o.reportAnswered) ? o.reportAnswered : [] };
}

async function reportAllowed(body, id) {
  if (!body) return false;
  var s = await reportLimits();
  if (id && s.answered.indexOf(id) !== -1) return false;
  return (s.limits.total || 0) < REPORT_PER_DAY && (s.limits.reasons[body.reason] || 0) < REPORT_PER_REASON_PER_DAY;
}

async function markAnswered(id, sentReason) {
  var s = await reportLimits();
  var set = {};
  if (id) set.reportAnswered = [id].concat(s.answered.filter(function (x) { return x !== id; })).slice(0, REPORT_ANSWERED_MAX);
  if (sentReason) {
    s.limits.total = (s.limits.total || 0) + 1;
    s.limits.reasons[sentReason] = (s.limits.reasons[sentReason] || 0) + 1;
    set.reportLimits = s.limits;
  }
  await chrome.storage.local.set(set);
}

// What the popup shows before asking: whether it may ask, and the report.
async function previewReport(offer) {
  var body = reportBody(offer);
  var allowed = await reportAllowed(body, offer && offer.id);
  return { allowed: allowed, report: allowed ? body : null };
}

// The user clicked Send report. Counted against the limits before sending,
// whatever comes of it. Resolves to whether a send was attempted; a failure is
// only logged here, and the popup thanks the user either way.
async function sendReport(offer) {
  var body = reportBody(offer);
  if (!(await reportAllowed(body, offer && offer.id))) return false;
  await markAnswered(offer.id, body.reason);
  var ctl = new AbortController();
  var timer = setTimeout(function () { ctl.abort(); }, REPORT_TIMEOUT_MS);
  try {
    var res = await fetch(REPORT_URL, {
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal
    });
    if (res.status !== 202) console.log("[GridSorter] error report: not accepted (HTTP " + res.status + ")");
  } catch (e) {
    console.log("[GridSorter] error report: not sent (" + (e && e.message ? e.message : e) + ")");
  } finally {
    clearTimeout(timer);
  }
  return true;
}

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

// ---- Similar accounts ----
// The curated list of creators by niche (decisions.md §14), Pro only: GET
// /v1/directory answers 401 signed out and 402 not_pro on Free. The reply is
// kept in chrome.storage.local (DIRECTORY_KEY, lib/auth.js) as
// { version, data, at }. The page asks for it when its panel opens; a copy
// younger than DIRECTORY_REFRESH_MS is used as it is, an older one is checked
// with ?have=, which costs a 304 and no body while it's still the live
// version. Signing out (clearAuth) and a not_pro answer delete it, and it's
// only handed to a signed-in Pro account.
//
// Display text only, and untrusted: content.js renders every field with
// textContent, and builds links only from a username that passed
// DIRECTORY_USERNAME here.
var DIRECTORY_PATH = "/v1/directory";
var DIRECTORY_REFRESH_MS = 6 * 60 * 60 * 1000;
var DIRECTORY_USERNAME = /^[A-Za-z0-9._]{1,30}$/;
var DIRECTORY_TEXT_MAX = 300;
var DIRECTORY_FAILED = "Couldn't load similar accounts. Please try again.";
var DIRECTORY_NONE = "There are no similar accounts to show yet.";
var DIRECTORY_NEEDS_PRO = "Similar accounts is part of Sortcut Pro.";

function directoryNeedsPro() {
  var err = new Error(DIRECTORY_NEEDS_PRO);
  err.needsPro = true;
  return err;
}

function directoryText(v) {
  return typeof v === "string" ? v.trim().slice(0, DIRECTORY_TEXT_MAX) : "";
}

function directoryCount(v) {
  return Number.isInteger(v) && v >= 0 ? v : 0;
}

// The fields the panel shows, from a 200 reply, or null when it isn't a
// directory. An account without a valid username or a niche is left out.
function cleanDirectory(d) {
  if (!d || typeof d !== "object" || !Number.isInteger(d.version)) return null;
  if (!Array.isArray(d.niches) || !Array.isArray(d.accounts)) return null;
  var niches = d.niches.filter(function (n) {
    return n && directoryText(n.name);
  }).map(function (n) {
    return {
      name: directoryText(n.name),
      count: directoryCount(n.count),
      filters: (Array.isArray(n.filters) ? n.filters : []).filter(function (f) {
        return f && directoryText(f.name);
      }).map(function (f) {
        return { name: directoryText(f.name), count: directoryCount(f.count) };
      })
    };
  });
  var accounts = d.accounts.filter(function (a) {
    return a && typeof a.username === "string" && DIRECTORY_USERNAME.test(a.username) && directoryText(a.niche);
  }).map(function (a) {
    return {
      niche: directoryText(a.niche),
      username: a.username,
      fullName: directoryText(a.fullName),
      filter: directoryText(a.filter),
      topics: directoryText(a.topics)
    };
  });
  return { version: d.version, niches: niches, accounts: accounts };
}

function dropDirectory() {
  return chrome.storage.local.remove(DIRECTORY_KEY);
}

// One load at a time: the panel opened in two tabs asks once.
var directoryLoad = null;
function loadDirectory() {
  if (!directoryLoad) {
    directoryLoad = fetchDirectory().finally(function () {
      directoryLoad = null;
    });
  }
  return directoryLoad;
}

async function fetchDirectory() {
  if (!(await getAuth())) {
    await dropDirectory();
    throw signedOutError();
  }
  // The server is the real check on every fetch; this one keeps a cached copy
  // from outliving the plan it was downloaded on.
  if (!(await isPro())) {
    await dropDirectory();
    throw directoryNeedsPro();
  }

  var now = Date.now();
  var cached = (await chrome.storage.local.get({ [DIRECTORY_KEY]: null }))[DIRECTORY_KEY];
  var held = cached && cached.data && Number.isInteger(cached.data.version) ? cached : null;
  // A time ahead of the clock (the clock was set back) doesn't count as fresh.
  if (held && typeof held.at === "number" && held.at <= now && now - held.at < DIRECTORY_REFRESH_MS) {
    return held.data;
  }

  var res = await api(DIRECTORY_PATH + (held ? "?have=" + encodeURIComponent(held.data.version) : ""));
  if (res.status === 304 && held) {
    await chrome.storage.local.set({ [DIRECTORY_KEY]: { version: held.data.version, data: held.data, at: now } });
    return held.data;
  }
  if (serverCode(res) === "not_pro") {
    await dropDirectory();
    throw directoryNeedsPro();
  }
  if (res.status === 404) throw new Error(DIRECTORY_NONE);
  var data = res.status === 200 ? cleanDirectory(res.data) : null;
  if (!data) {
    console.warn("[GridSorter] similar accounts: not loaded (HTTP " + res.status + ")");
    throw new Error(DIRECTORY_FAILED);
  }
  await chrome.storage.local.set({ [DIRECTORY_KEY]: { version: data.version, data: data, at: now } });
  return data;
}

// ---- Upgrade ----
// The one Upgrade button, in the popup and in the page's Upgrade dialog
// (decisions.md §16 C9). Signs in first if needed, asks the backend for a
// one-time handoff code, and opens the dashboard's checkout with it in the URL
// fragment, so the page is signed in as this user without a second Google
// sign-in. The code lives 2 minutes and works once; it's never stored or logged.
var HANDOFF_CODE = /^[A-Za-z0-9_-]{43}$/;
var CHECKOUT_FAILED = "Couldn't open checkout. Please try again.";

async function startUpgrade() {
  if (!(await getAuth())) await signIn();
  var res = await api("/v1/auth/handoff", { method: "POST" });
  if (!res.ok) throw new Error((res.data && res.data.error) || CHECKOUT_FAILED);
  var code = res.data && res.data.code;
  if (typeof code !== "string" || !HANDOFF_CODE.test(code)) throw new Error(CHECKOUT_FAILED);
  await chrome.storage.session.set({ [UPGRADE_KEY]: Date.now() });
  await chrome.tabs.create({ url: CHECKOUT_URL + "#code=" + code });
}

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
    var timing = newTiming();
    var job = run(msg.post, tell, timing).then(function (r) {
      logTiming(code, timing, "done");
      return r;
    }, function (err) {
      if (!(err && (err.signedOut || err.needsPro))) {
        console.warn("[GridSorter] transcription failed", code, "—", err && err.message,
          err && err.detail ? "(" + err.detail + ")" : "");
        logTiming(code, timing, "failed");
      }
      throw err;
    });
    return reply(job, sendResponse, function (r) {
      return { ok: true, result: r };
    });
  }
  // From the page's sign-in dialog. Unlike the popup's signIn it doesn't load
  // /v1/me afterwards: the transcription it was opened for is the next call.
  // content.js found no rules in storage: write them and hand them back.
  if (msg.type === "getRules") {
    return reply(mirrorRules("asked"), sendResponse, function (rules) {
      return { ok: true, rules: rules };
    });
  }
  if (msg.type === "pageSignIn") {
    return reply(signIn(), sendResponse, function () { return { ok: true }; });
  }
  // The results header asks whether to show Similar accounts; the panel asks
  // for the list when it opens.
  if (msg.type === "isPro") {
    return reply(isPro(), sendResponse, function (pro) { return { ok: true, pro: pro }; });
  }
  if (msg.type === "directory") {
    return reply(loadDirectory(), sendResponse, function (d) { return { ok: true, directory: d }; });
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
    // The popup asks just before every sort (and on opening). The check runs
    // alongside; anything it accepts applies from the next page load.
    checkRemoteRules("sort");
    return reply(planInfo(), sendResponse, function (p) { return { ok: true, plan: p }; });
  }
  if (msg.type === "signIn") return reply(signIn().then(account), sendResponse, asAccount);
  // From the popup's Upgrade link or the page's Upgrade dialog.
  if (msg.type === "upgrade") {
    return reply(startUpgrade(), sendResponse, function () { return { ok: true }; });
  }
  // Answered when the sheet is open, or failed. The popup has usually closed
  // by then; it reads the outcome from session storage instead.
  if (msg.type === "sheetsExport") {
    return reply(exportToSheets(msg.tabId), sendResponse, function (url) { return { ok: true, url: url }; });
  }
  if (msg.type === "signOut") return reply(signOut().then(account), sendResponse, asAccount);
  // Error reports: from the popup only, never a tab, so no page can send one.
  // sendReport is the user's click on Send report.
  if (msg.type === "reportPreview" || msg.type === "sendReport" || msg.type === "declineReport") {
    if (sender && sender.tab) return false;
    if (msg.type === "reportPreview") {
      return reply(previewReport(msg.offer), sendResponse, function (p) {
        return { ok: true, allowed: p.allowed, report: p.report };
      });
    }
    if (msg.type === "sendReport") {
      return reply(sendReport(msg.offer), sendResponse, function (sent) { return { ok: true, sent: sent }; });
    }
    return reply(markAnswered(msg.offer && msg.offer.id, null), sendResponse, function () { return { ok: true }; });
  }
  return false;
});
