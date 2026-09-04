# Grid Sorter for Instagram

Sorts an Instagram profile's posts or reels by views, likes, comments, or
outlier score, and exports the data to CSV/JSON. Everything runs locally in the
browser.

## Outlier score

Ranks posts by a metric, then labels each one with how far it beat the profile's
own typical post: `metric ÷ median metric` across the posts in the run. A profile
whose median reel does 7.5K views gets a `333x` badge on the reel that did 2.5M.

Three variants, one per metric:

| Sort | Baseline | Applies to |
|---|---|---|
| Outlier score · views | median views | reels only |
| Outlier score · likes | median likes | any post |
| Outlier score · comments | median comments | any post |

The median is taken over the posts in the result set that actually carry the
metric — posts with none would pull the baseline toward zero. Badges only appear
above `1x`; below-median posts are left unlabelled. The score is included in
CSV/JSON exports as `outlierScore`.

## Depth

25, 50, 100, 200, 300, or **All posts**. An all-posts run has no count to stop
at, so it scrolls until Instagram reports no next page or the feed stalls.

## Transcribe

Every video tile in the sorted grid carries a **Transcribe** button. It
downloads that reel's audio, transcribes it, and saves a `.txt` next to your
other exports.

Hindi comes back as **Hinglish** — Latin script, the way people actually type
it — with the original Devanagari kept at the bottom of the file. English reels
come back as-is. Language is detected automatically; you don't pick one.

Set up: paste a [Groq](https://console.groq.com/keys) API key into
**Transcription** in the popup. The free tier covers roughly 2,000 clips a day;
paid is about $0.04 per hour of audio, so a 30-second reel costs well under a
hundredth of a cent.

Two things to know:

- **Stay logged in.** Instagram's grid responses carry thumbnails and counts but
  no playable video, so the file is looked up per-post when you click, using
  your existing session. Logged out, the lookup is refused.
- **This is the one feature that leaves your machine.** The audio goes to Groq
  to be transcribed. Everything else — sorting, scoring, exporting — is still
  entirely local.

## How it works

Passive response interception. A page-world script wraps `XMLHttpRequest` and
`fetch` and reads the JSON responses Instagram is already fetching for itself.
It never constructs its own API request, so it is unaffected when Instagram
rotates the `doc_id` on its GraphQL queries.

Posts are matched by shape (a shortcode plus at least one engagement number)
rather than by exact field name, so internal field renames do not blind it.

## Install (unpacked)

1. Chrome address bar: `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** (top left)
4. Select this folder

After any code change, click the reload arrow on the extension card.

## Files

| File | World | Purpose |
|---|---|---|
| `manifest.json` | — | Permissions and wiring |
| `content.js` | isolated | Injects page scripts, renders grid, exports |
| `background.js` | worker | Transcription: CDN fetch + Groq calls |
| `lib/extract.js` | page | Shape-based post extraction |
| `page/interceptor.js` | page | XHR + fetch response hooks |
| `page/collector.js` | page | Scroll loop, sort, handoff |
| `popup.*` | — | UI |

## Rules that must not be broken

1. Never build a request that depends on a rotating id. No `doc_id`, no
   `query_hash` — those change without notice and are what break scrapers.
   Collection stays purely passive. Transcription is the one exception and is
   allowed two calls, both only on an explicit click: a per-post lookup at
   `/api/v1/media/<pk>/info/` (a stable REST path with no ids in it) and the
   signed CDN URL that returns.
2. Trigger loading only by scrolling. Keep the 900ms delay.
3. Match data by shape, not by name.
4. Nothing leaves the browser except audio the user explicitly sends to be
   transcribed. No analytics, no telemetry, no server of our own — ever.
5. Read-only. Never like, follow, comment, or post.

## Not affiliated with or endorsed by Instagram or Meta.
