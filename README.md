# Grid Sorter for Instagram

Sorts an Instagram profile's reels by views, likes, comments, or outlier score,
and exports the data to CSV/JSON. Sorting runs locally in the browser;
transcription (Pro) runs through Sortcut.

## Reels tab only

Sortcut sorts **reels only**, in every sort mode, and only on a profile's Reels
tab: `https://www.instagram.com/<username>/reels/`. Anywhere else — the
profile's main grid, a single reel, Instagram's own Reels feed, home, explore —
the popup says so as soon as it opens, and **Sort** does nothing.

A reel counts as the profile's when the profile posted it or is credited as a
collaborator on it (`coauthor_producers`).

## Outlier score

Ranks reels by a metric, then labels each one with how far it beat the profile's
own typical reel: `metric ÷ median metric` across the reels in the run. A profile
whose median reel does 7.5K views gets a `333x` badge on the reel that did 2.5M.

Three variants, one per metric:

| Sort | Baseline |
|---|---|
| Outlier score · views | median views |
| Outlier score · likes | median likes |
| Outlier score · comments | median comments |

The median is taken over the reels in the result set that actually carry the
metric — reels with none would pull the baseline toward zero. Badges only appear
above `1x`; below-median reels are left unlabelled. The score is included in
CSV/JSON exports as `outlierScore`.

## Depth and stopping

25, 50, 100, 200, 300, or **All reels**. A run always ends on its own:

- the requested number of reels is reached, or Instagram reports no more;
- Instagram keeps answering but none of it is this profile's reels for ~10
  scrolls. The popup says "No reels found. This profile may not have any
  reels, or Instagram may have changed something." — or, when reels did arrive
  but none named an author, "Couldn't read reels — Instagram may have changed
  something.";
- reels stop arriving for ~25 scrolls;
- the time limit: 3 minutes for a fixed depth, 10 minutes for All reels.

Whatever stopped it, the reels collected so far are sorted and shown, and the
popup says why it stopped. If most reels lack the chosen metric (Instagram hides
some counts), the popup says so rather than quietly listing them last.

The run's state (running with progress, done, or stopped with a reason) is kept
in `chrome.storage.local` under `sortState`, so the popup shows it whenever it
opens, and follows it live while open.

## Transcribe

Every video tile in the sorted grid carries a **Transcribe** button. It
downloads that reel's audio, transcribes it, and saves a `.txt` next to your
other exports.

Hindi comes back as **Hinglish** — Latin script, the way people actually type
it — with the original Devanagari kept at the bottom of the file. English reels
come back as-is. Language is detected automatically; you don't pick one.

Transcription is a **Sortcut Pro** feature and runs through Sortcut. Sign in
with Google under **Account** in the popup, or just click Transcribe: signed
out, a "Sign in to transcribe" dialog opens on the page, and its **Sign in with
Google** button opens Google. Once you're signed in, that reel's transcription
carries on by itself. Sign-in asks Google only for your name and
email address. The popup then shows your plan and, on Pro, how many transcripts
you've used and when they reset (200 a month on Pro Monthly, 3,000 a year on Pro
Yearly). Free accounts can sort and export but not transcribe; plans are at
[sortcut.co/pricing](https://sortcut.co/pricing.html). A reel you've recently
transcribed comes back instantly without using another transcript.

When a transcription fails, the reason appears on a card over that reel,
which stays until you dismiss it, and the same words appear in the popup for
30 minutes. The service-worker console (`chrome://extensions` → Sortcut →
**service worker**) logs each failure as `[GridSorter] transcription failed`,
with the reel's code and any detail too technical for the card.

Reels over the upload limit (`MAX_BYTES` in `lib/config.js`, currently 24 MB)
are refused before anything is uploaded, so no transcript is used.

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
Instagram's GraphQL traffic also carries the inbox, highlights and suggested
reels, so only the target profile's reels are kept, and only the list that held
them decides whether there's a next page.

## Developer capture

A hidden tool for diagnosing breakage: it keeps the last few raw GraphQL
responses the tab received and saves them to a local JSON file. It is **off by
default**; when off, nothing is captured and the popup's **Save debug sample**
button is hidden. Captured data never leaves your machine.

To turn it on:

1. `chrome://extensions` → Sortcut → click **service worker** to open its
   DevTools console.
2. Run `chrome.storage.local.set({ devCapture: true })`
3. Reload the Instagram tab (capture starts with the next responses), reproduce
   the problem, then click **Save debug sample** in the popup.

To turn it off: `chrome.storage.local.remove("devCapture")`.

Samples contain whatever Instagram sent, including your own account's data.
Never commit one as-is: `tests/fixtures/*-api-graphql-*.json` is gitignored for
that reason. Committed fixtures are synthetic.

## Tests

```
npm test        # or: node --test tests/*.test.js
```

No dependencies. The tests load the page scripts into a Node `vm` with a stub
`window` and run them against `tests/fixtures/`: the extractor, the endpoint
filter, ownership (including collab reels), the reels-tab URL check, and the
collector's stop rules. `content.js` runs on a stand-in Instagram page
(`tests/dom.js`, a minimal DOM) for what the sorted view hides and restores,
the failure card and the sign-in dialog; `background.js` runs against a stub
network for the size check, signed-out handling and error wording. Tests against real samples run only when those
(gitignored) files are present, and are skipped otherwise.

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
| `lib/extract.js` | page, popup | Shape-based extraction; reels-tab URL check and ownership |
| `page/interceptor.js` | page | XHR + fetch response hooks |
| `page/collector.js` | page | Scroll loop, stop rules, sort, handoff |
| `popup.*` | — | UI |
| `tests/` | node | `node --test` suite and synthetic fixtures |

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
