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
  var item = json && json.items && json.items[0];
  var url = item && smallestRendition(item.video_versions);

  if (!url) {
    throw new Error(
      "No video track on this post" + (code ? " (" + code + ")" : "") +
      ". Photo posts and carousels can't be transcribed."
    );
  }
  return url;
}

function tooBig(bytes) {
  return (
    "This video is " + Math.round(bytes / 1e6) + "MB, over the " +
    MAX_BYTES / 1e6 + "MB upload limit. Long videos can't be transcribed in one piece."
  );
}

async function fetchVideo(url) {
  var res = await fetch(url, { credentials: "omit" });
  if (!res.ok) {
    // A signed CDN URL that has aged out is by far the most common failure,
    // and it is fixable by re-running the sort — so say that rather than
    // surfacing a bare status code.
    if (res.status === 403 || res.status === 410) {
      throw new Error("This video link has expired. Re-run the sort and try again.");
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

var UPLOAD_FAILED = "The upload didn't go through. Please try again.";

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
  if (res.status === 409 || res.status === 413) return UPLOAD_FAILED;
  return msg || "Something went wrong (HTTP " + res.status + "). Please try again.";
}

function failedText(job) {
  var msg = job.error || "This transcription did not finish. Please try again.";
  if (job.refunded === true && !/credit was returned/i.test(msg)) {
    msg += " Your credit was returned.";
  }
  return msg;
}

// Same shape content.js has always downloaded as .txt.
function transcriptOf(job) {
  var text = (job.text || "").trim();
  if (!text) throw new Error("No speech was detected in this video.");
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
    throw new Error(UPLOAD_FAILED);
  }
  if (!res.ok) throw new Error(UPLOAD_FAILED);
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
    if (!res.ok) throw new Error(errorText(res));

    var job = res.data || {};
    if (job.status === "done") return transcriptOf(job);
    if (job.status === "failed") throw new Error(failedText(job));
    status = job.status;
  }
}

async function run(post, tell) {
  if (!post || !post.code) throw new Error("No post data. Re-run the sort and try again.");

  // The Transcribe click is the user gesture that lets the Google window open.
  if (!(await getAuth())) {
    tell("Sign in to Sortcut in the window that opened…");
    await signIn();
  }

  tell("Transcribing…");
  var res = await api("/v1/transcriptions", { method: "POST", body: { reelCode: post.code } });
  if (!res.ok) throw new Error(errorText(res));
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
    var buf = await fetchVideo(url);
    await upload(job.upload, buf, post.code);

    var sub = await api("/v1/transcriptions/" + encodeURIComponent(job.jobId) + "/submit", {
      method: "POST"
    });
    if (!sub.ok) throw new Error(errorText(sub));
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

async function account() {
  if (!(await getAuth())) return { signedIn: false };
  try {
    return { signedIn: true, me: await getMe() };
  } catch (e) {
    if (e.signedOut) return { signedIn: false, error: e.message };
    return { signedIn: true, me: null, error: e.message };
  }
}

function reply(promise, sendResponse, wrap) {
  promise.then(
    function (r) {
      sendResponse(wrap(r));
    },
    function (err) {
      sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
    }
  );
  return true; // keep the channel open for the async reply
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg) return false;
  if (msg.type === "transcribe") {
    var tell = progressTo(sender, msg.post && msg.post.code);
    return reply(run(msg.post, tell), sendResponse, function (r) {
      return { ok: true, result: r };
    });
  }
  // From the popup. Sign-in runs here rather than in the popup because the
  // Google window takes focus and closes the popup mid-flow.
  var asAccount = function (a) { return { ok: true, account: a }; };
  if (msg.type === "account") return reply(account(), sendResponse, asAccount);
  if (msg.type === "signIn") return reply(signIn().then(account), sendResponse, asAccount);
  if (msg.type === "signOut") return reply(signOut().then(account), sendResponse, asAccount);
  return false;
});
