# Grid Sorter for Instagram

Sorts an Instagram profile's reels by views, likes, comments, or outlier score,
and exports the data to CSV, JSON or Excel. Sorting runs locally in the browser;
transcription (Pro) runs through Sortcut.

## Free and Pro

| | Free (signed out, or no Pro plan) | Pro (`pro_monthly` / `pro_yearly`) |
|---|---|---|
| Reels sorted | up to 50 per sort, of any age | any depth |
| Sort by | views, likes, comments | those, plus the three outlier scores |
| Export CSV / JSON / Excel | yes, no sign-in needed | yes |
| Transcribe | no | yes |

The plan comes from `/v1/me` (cached 60 s). One function, `isPro()` in
`lib/auth.js`, answers for every feature; the popup and the page ask the
service worker. The last plan seen is kept in `chrome.storage.local` under
`lastPlan` with the time it was seen: when Sortcut can't be reached (no network,
or a 5xx), that plan holds for 24 hours, then it's Free. Signed out, a session
that can't be refreshed, or any other refusal is Free. The Free cap is
`FREE_MAX_REELS` in `lib/config.js`.

On Free, Pro's choices stay in the popup's menus, greyed out, labelled
"— Pro", and can't be picked: the three outlier sorts under Rank by, and 100,
200, 300 and All under Depth (Free picks 25 or 50; it starts on 50, Pro on
100). When the plan changes (sign-in, sign-out, the plan loading) the menus
update at once, and a choice the plan no longer allows falls back: an outlier
sort to the same metric unscored, a depth to 50. The popup's only upgrade
prompt is the "Upgrade to Pro" link in the Account section, shown to anyone not
on Pro.

- **Free cap.** A Free sort keeps at most 50 reels, of any age; there is no
  date range. The popup sends the cap
  with the job and the collector enforces it whatever depth arrives, so it
  doesn't rest on the Depth menu alone.
- **Transcribe.** Signed in on Free, a Transcribe click opens an Upgrade
  dialog on the page. Signed out, it's the sign-in dialog first, and if the
  account then isn't Pro, the Upgrade dialog follows. The backend enforces the
  plan regardless (402); the dialog is only so the answer is clear.

Upgrade links go to [sortcut.co/pricing](https://sortcut.co/pricing.html).

## Reels tab only

Sortcut sorts **reels only**, in every sort mode, and only on a profile's Reels
tab: `https://www.instagram.com/<username>/reels/`. Anywhere else — the
profile's main grid, a single reel, Instagram's own Reels feed, home, explore —
the popup says so as soon as it opens, and **Sort** does nothing.

A reel counts as the profile's when the profile posted it or is credited as a
collaborator on it (`coauthor_producers`).

## Outlier score (Pro)

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
exports as `outlierScore`.

## Export

CSV, JSON and Excel (`.xlsx`), for everyone, no sign-in. Files are named after
the profile (`<username>-sorted.csv`, `.json`, `.xlsx`) and are written in the
page; nothing is uploaded.

Excel has the CSV's columns in the CSV's order, on one sheet ("Reels") with the
header row frozen. Cells are typed: views, likes, comments and `outlierScore`
(two decimals) are numbers, `createdAt` is a date (UTC), `isVideo` is a boolean,
and the code, link and caption are text. The `.xlsx` is written by a small
built-in writer in `content.js` (a stored zip of the few XML parts a workbook
needs): no library and no dependency.

## Depth and stopping

25, 50, 100, 200, 300, or **All reels**. A run always ends on its own:

- the requested number of reels is reached, or Instagram reports no more;
- Instagram keeps answering but none of it is this profile's reels for ~10
  scrolls. The popup warns "No reels found. This profile may not have any
  reels, or Instagram may have changed something." — or, when reels did arrive
  but none named an author, "Couldn't read reels — Instagram may have changed
  something.";
- reels stop arriving for ~25 scrolls;
- the time limit: 3 minutes for a fixed depth, 10 minutes for All reels.

Whatever stopped it, the reels collected so far are sorted and shown. The
popup has no summary of a finished sort: the sorted grid is the result. Its
status area shows only progress while a sort runs on the current page, and
warnings about the current page: the wrong page, no reels found or couldn't
read reels, a metric Instagram isn't sending, stopped by the time limit, or the
sorted grid couldn't be placed. Export is enabled only when the current page
has sorted reels.

The run's state is kept in `chrome.storage.local` under `sortState`, stamped
with the tab id, the profile and the page load it belongs to. The popup shows
it only on that same page, never another tab's or profile's. The worker clears
it when that tab loads a new page (other than the reload a sort starts with)
or closes; content.js clears it, with the sorted grid, when the tab moves to
another profile (opening a post or reel over the profile doesn't count).

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
carries on by itself on Pro; on Free an Upgrade dialog opens instead. Sign-in asks Google only for your name and
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

It reads every JSON response on instagram.com under `/api/` or any path
containing `graphql`, not a fixed list of endpoints: Instagram moves its data
between addresses on its own. Bodies behind a `for (;;);` prefix and bodies
holding several JSON objects are unwrapped; very large ones are skipped and
counted.

Posts are matched by shape (a shortcode plus at least one engagement number),
and every field is looked up through a list of aliases, so renames and moved
containers do not blind it. Those responses also carry the inbox, highlights,
the timeline and suggested reels, so only the target profile's reels (owner or
collaborator) are kept; everything else is dropped on the spot, DMs are never
read at all, and only a list made up mostly of the profile's reels decides
whether there's a next page.

### Rules (`lib/rules.js`)

Every Instagram-specific name lives in `lib/rules.js` and nowhere else: which
responses to read, the aliases for each value, the paging flags, and the stop
limits. It is plain JSON-compatible data with a `version`; bump it on every
change. The worker writes it to `chrome.storage.local.rules` on install and
update (including Reload on `chrome://extensions`), on browser startup, and
whenever it wakes. `content.js` hands the stored copy to the page scripts as
JSON on the injected `lib/extract.js` element; if none is stored it asks the
worker (`getRules`), which writes it and sends it back, and injects with that
(waiting at most 1 second). Anything missing or malformed falls back to a small
built-in copy in `lib/extract.js`, and the sort records that as a warning
(`sortState.rulesWarning` and the health log's `rules` / `rulesWarning`).

### Why a sort failed

Every failed or partial sort stores reason codes in `sortState.codes`, and the
popup shows the words for them:

| Code | Shown to the user |
|---|---|
| `no_responses` | Instagram didn't send anything while we scrolled — check your connection, reload the page and try again. |
| `responses_but_no_reels` | No reels found. This profile may not have any reels, or Instagram may have changed something. |
| `reels_but_none_from_profile` | Couldn't read reels — Instagram may have changed something. |
| `profile_has_no_reels` | This profile hasn't posted any reels. |
| `stopped_time_limit` | Stopped at the 3-minute time limit — sorted the N reels collected by then. |
| `reels_missing_metric` | Instagram isn't sending views right now — try sorting by likes or comments. |
| `wrong_page` | Open an Instagram profile's Reels tab to sort. |

The last two kinds still hand back a full sorted grid.

## Health log

Every sort, empty or not, adds one entry to `chrome.storage.local.health`,
newest first; the last 50 are kept. It stays on this machine. To read it, open
the service worker's console (`chrome://extensions` → Sortcut → **service
worker**) and run:

```
sortLog()
```

It prints a table and returns the entries. Each holds counts and the profile
name only (no reels, captions, links or tokens):

| Field | Meaning |
|---|---|
| `at`, `profile`, `plan`, `mode`, `depth` | when, whose Reels tab, Free or Pro, Rank by, Depth as asked |
| `kept` / `seen` | reels in the sorted grid / the profile's reels collected |
| `overDepth` | collected but past the depth asked for |
| `notProfile` | other accounts' reels seen and dropped |
| `noAuthor` | reels seen that named no author, dropped |
| `duplicates` | the profile's reels sent again, kept once |
| `unranked` | kept, but without the metric (missing or 0), shown after the ranked ones |
| `pages` / `responses` | responses holding the profile's reels / all responses read |
| `stop` | what ended collection: `complete`, `end`, `stalled`, `timeout`, `no_reels`, `navigated`, `wrong_page` |
| `codes` | reason codes (see "Why a sort failed") |
| `seconds`, `rules`, `rulesWarning` | how long it ran; which rules it ran on |

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
`window` and run them against `tests/fixtures/`: the extractor, the address
filter, ownership (including collab reels), the reels-tab URL check, the rules
and their fallback, and the collector's stop rules and reason codes, including
the Free 50-reel cap.

Every fixture runs through the whole pipeline (filter → unwrap → extract →
ownership → paging, optionally a full sort) and must match its
`NAME.expected.json` (format at the top of `tests/fixtures.test.js`). To add a
sample, drop `NAME.json` and `NAME.expected.json` into `tests/fixtures/`;
nothing else changes.
`content.js` runs on a stand-in Instagram page (`tests/dom.js`, a minimal DOM)
for what the sorted view hides and restores, the failure card, the sign-in and
Upgrade dialogs, and the Excel file (unzipped, CRC-checked, and its sheet XML
read back cell by cell). `popup.js` runs on the real `popup.html` for what Free
and Pro can start. `background.js` runs against a stub network for the size
check, signed-out handling, error wording, and the plan rules (including the
24-hour last-known plan). Real samples, and their expected files, are
gitignored and run only where they are present.

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
| `content.js` | isolated | Injects page scripts, renders grid, exports (CSV, JSON, Excel), dialogs |
| `background.js` | worker | Instagram video lookup + download, Sortcut API calls for transcription |
| `lib/config.js` | worker | Environment settings, `FREE_MAX_REELS` |
| `lib/auth.js` | worker | Google sign-in, tokens, API helper, `isPro()` |
| `lib/rules.js` | worker | Data only: every Instagram name, address and stop limit |
| `lib/extract.js` | page, popup | Rules handover and fallback; extraction; reels-tab URL check and ownership |
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
   one Groq key and checks your plan. The one other call is the plan lookup
   (`/v1/me`), made only when signed in, which sends nothing about what you
   sort.
5. Read-only. Never like, follow, comment, or post.

## Not affiliated with or endorsed by Instagram or Meta.
