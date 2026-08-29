# Grid Sorter for Instagram

Sorts an Instagram profile's posts or reels by views, likes, comments, date, or
outlier score, and exports the data to CSV/JSON. Everything runs locally in the
browser.

## Outlier score

Ranks reels by views, then labels each one with how far it beat the profile's
own typical reel: `views ÷ median views` across the reels in the run. A profile
whose median reel does 7.5K views gets a `333x` badge on the reel that did 2.5M.

The median is taken over the reels in the result set that actually have views —
posts with none would pull the baseline toward zero. Badges only appear above
`1x`; below-median reels are left unlabelled. The score is included in CSV/JSON
exports as `outlierScore`.

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
| `lib/extract.js` | page | Shape-based post extraction |
| `page/interceptor.js` | page | XHR + fetch response hooks |
| `page/collector.js` | page | Scroll loop, sort, handoff |
| `popup.*` | — | UI |

## Rules that must not be broken

1. Never build a request to Instagram. No `doc_id`, no `query_hash`.
2. Trigger loading only by scrolling. Keep the 900ms delay.
3. Match data by shape, not by name.
4. Everything stays local. No server, no analytics.
5. Read-only. Never like, follow, comment, or post.

## Not affiliated with or endorsed by Instagram or Meta.
