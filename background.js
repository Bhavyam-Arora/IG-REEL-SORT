// background.js — service worker.
// Holds the transcription pipeline. This has to live here rather than in the
// content script: under MV3 a content script's fetch is bound by the *page's*
// CORS rules, so it cannot read the Instagram CDN or reach Groq. The service
// worker runs at the extension origin and uses host_permissions instead.

chrome.runtime.onInstalled.addListener(function () {
  console.log("[GridSorter] installed");
});

var GROQ = "https://api.groq.com/openai/v1";
var STT_MODEL = "whisper-large-v3-turbo";
// Groq retired llama-3.3-70b-versatile for free/dev tiers on 2026-08-16 and
// names this as its replacement. Only used to romanise non-Latin transcripts.
var TEXT_MODEL = "openai/gpt-oss-120b";

// Groq caps uploads at 25MB on the free tier. We already request the smallest
// rendition, so hitting this means a genuinely long video rather than a big
// one, and there is no smaller file to fall back to.
var MAX_BYTES = 24 * 1024 * 1024;

function getKey() {
  return new Promise(function (resolve) {
    chrome.storage.local.get({ groqKey: "" }, function (o) {
      resolve((o.groqKey || "").trim());
    });
  });
}

// True when the text contains any character outside Latin script. Written as
// what we ALLOW — ASCII, Latin-1, Latin Extended-A/B, plus the punctuation and
// currency blocks Whisper sprinkles in — rather than as a list of the scripts
// we expect. Devanagari is the case in hand, but an Urdu or Tamil reel should
// take the same path without anyone having to add its range here.
function hasNonLatin(s) {
  return /[^\u0000-\u024F\u2000-\u206F\u20A0-\u20CF]/.test(s || "");
}

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
    "This video is " + Math.round(bytes / 1048576) + "MB, over Groq's 25MB " +
    "upload limit. Long videos can't be transcribed in one piece."
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

async function transcribe(key, buf, code) {
  var form = new FormData();
  form.append("file", new Blob([buf], { type: "video/mp4" }), code + ".mp4");
  form.append("model", STT_MODEL);
  // verbose_json is what carries the detected language, which decides whether
  // the romanisation pass runs at all.
  form.append("response_format", "verbose_json");
  form.append("temperature", "0");

  var res = await fetch(GROQ + "/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: "Bearer " + key },
    body: form
  });

  if (!res.ok) {
    var detail = await res.text().catch(function () { return ""; });
    if (res.status === 401) throw new Error("Groq rejected the API key.");
    if (res.status === 429) throw new Error("Groq rate limit hit. Wait a moment and retry.");
    throw new Error("Transcription failed (HTTP " + res.status + "). " + detail.slice(0, 200));
  }

  var data = await res.json();
  return { text: (data.text || "").trim(), language: data.language || "unknown" };
}

// Whisper transcribes Hindi into Devanagari, but the requested output is
// Hinglish. A plain character table can't do this: Devanagari carries an
// inherent vowel that Hindi drops in speech, so "बताता" transliterates to
// "bataataa" mechanically when the word is actually read "batata". Getting the
// schwa deletion right needs to know the word, so this is a model's job.
async function romanise(key, text) {
  var res = await fetch(GROQ + "/chat/completions", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + key,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: TEXT_MODEL,
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "You romanise transcripts into Latin script. Output the SAME words " +
            "in the way people actually type them casually online (Hinglish): " +
            "'main aaj aapko batata hoon', never Devanagari and never a " +
            "scholarly scheme with diacritics. Do not translate, summarise, " +
            "reorder, or add anything. Leave words already in Latin script " +
            "untouched. Reply with the converted text and nothing else."
        },
        { role: "user", content: text }
      ]
    })
  });

  // Romanisation is a nice-to-have on top of a transcript we already have.
  // If it fails, returning the native script beats failing the whole job.
  if (!res.ok) return null;
  var data = await res.json().catch(function () { return null; });
  try {
    var out = data.choices[0].message.content.trim();
    return out || null;
  } catch (e) {
    return null;
  }
}

async function run(post) {
  var key = await getKey();
  if (!key) throw new Error("Add your Groq API key in the extension popup first.");
  if (!post) throw new Error("No post data. Re-run the sort and try again.");

  // Normally null — grid payloads don't carry a rendition — so this almost
  // always falls through to the on-demand lookup.
  var url = post.videoUrl || (await resolveVideoUrl(post.pk, post.code));
  var buf = await fetchVideo(url);
  var result = await transcribe(key, buf, post.code || "reel");
  if (!result.text) throw new Error("No speech was detected in this video.");

  var romanised = null;
  if (result.language !== "english" && result.language !== "en" && hasNonLatin(result.text)) {
    romanised = await romanise(key, result.text);
  }

  return {
    text: romanised || result.text,
    original: romanised ? result.text : null,
    language: result.language,
    romanised: !!romanised
  };
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg && msg.type === "transcribe") {
    run(msg.post).then(
      function (r) {
        sendResponse({ ok: true, result: r });
      },
      function (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    );
    return true; // keep the channel open for the async reply
  }
  return false;
});
