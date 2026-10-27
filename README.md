# Grid Sorter for Instagram

Sorts an Instagram profile's posts or reels by views, likes, comments, or
outlier score, and exports the data to CSV/JSON. Sorting runs locally in the
browser; transcription (Pro) runs through Sortcut.

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

Transcription is a **Sortcut Pro** feature and runs through Sortcut. Sign in
with Google under **Account** in the popup, or just click Transcribe: the
sign-in window opens on first use. Sign-in asks Google only for your name and
email address. The popup then shows your plan and, on Pro, how many transcripts
you've used and when they reset (200 a month on Pro Monthly, 3,000 a year on Pro
Yearly). Free accounts can sort and export but not transcribe; plans are at
[sortcut.co/pricing](https://sortcut.co/pricing.html). A reel you've recently
transcribed comes back instantly without using another transcript.

Two things to know:

- **Stay logged in.** Instagram's grid responses carry thumbnails and counts but
  no playable video, so the file is looked up per-post when you click, using
  your existing session. Logged out, the lookup is refused.
- **This is the one feature that leaves your machine.** Reels you transcribe
  are sent to Sortcut and Groq to be transcribed, and deleted after processing.
  Everything else — sorting, scoring, exporting — is still entirely local.

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
| `background.js` | worker | Instagram video lookup + download, Sortcut API calls for transcription |
| `lib/config.js` | worker | Environment settings |
| `lib/auth.js` | worker | Google sign-in, tokens, API helper |
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
4. Sorting and exports never touch any server — they run entirely in the
   browser. Only transcription goes through Sortcut's server, which holds the
   one Groq key and checks your plan.
5. Read-only. Never like, follow, comment, or post.

## Not affiliated with or endorsed by Instagram or Meta.
