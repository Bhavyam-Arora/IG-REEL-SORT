// lib/rules.js — DATA ONLY. Every Instagram-specific name the extension reads
// a response by lives here: which responses to read, what each value is called,
// where the "more pages" flag is, and when a sort gives up. No other file may
// hard-code any of it.
//
// Keep it plain JSON (no functions, no RegExps, no Infinity) and bump `version`
// on every change: a copy fetched from our server will be able to replace this
// object, and the higher version wins.
//
// The service worker loads this file and mirrors it into
// chrome.storage.local.rules. content.js hands that copy to the page scripts on
// the <script> element it injects (the page can't load this file itself
// without the manifest listing it). lib/extract.js resolves it and fills any
// missing or malformed part from its own small built-in copy.
//
// Field paths are dot-separated and may index arrays ("a.0.b"). Every list is
// tried in order and the first usable value wins.

var SORTCUT_RULES = {
  version: 2,

  // Which responses are read. Any JSON response on one of these hosts (or a
  // subdomain) whose path starts with a prefix or contains one of the words.
  // Matching is case-insensitive. The post-finder, not the address, decides
  // what's kept: everything that isn't the target profile's reel is dropped.
  responses: {
    hosts: ["instagram.com"],
    pathPrefixes: ["/api/"],
    pathContains: ["graphql"],
    // Anti-hijacking junk Instagram may put before the JSON.
    bodyPrefixes: ["for (;;);", "for(;;);", "while(1);", ")]}'"],
    // Characters. A Reels-tab page is ~10K and a grid page ~70K; anything this
    // big is not a page of reels and parsing it would stall the tab.
    maxBodyChars: 5000000
  },

  // Never look inside an object under a key containing one of these words
  // (case-insensitive). DMs and notifications carry reels too, sometimes the
  // profile's own, and none of it is ever ours to read.
  skipKeys: ["inbox", "thread", "message", "notification"],

  fields: {
    code: ["code", "shortcode"],
    pk: ["pk", "id"],
    owner: [
      "user.username",
      "owner.username",
      "owner.user.username",
      "caption.user.username",
      "author.username",
      "creator.username"
    ],
    // Lists of collaborator users; every list found is read.
    coauthors: ["coauthor_producers", "coauthors", "collaborators"],
    coauthorName: ["username", "user.username"],
    views: ["play_count", "ig_play_count", "video_play_count", "view_count", "video_view_count"],
    likes: ["like_count", "edge_liked_by.count", "edge_media_preview_like.count", "likes.count"],
    comments: [
      "comment_count",
      "edge_media_to_comment.count",
      "edge_media_to_parent_comment.count",
      "comments.count"
    ],
    // Unix seconds. Without one, the date is read from the pk.
    date: ["taken_at", "taken_at_timestamp", "taken_at_seconds"],
    videoDuration: ["video_duration", "duration", "video_length"],
    caption: [
      "caption.text",
      "edge_media_to_caption.edges.0.node.text",
      "caption_text"
    ],
    thumbnail: [
      "image_versions2.candidates.0.url",
      "display_url",
      "display_uri",
      "thumbnail_src",
      "thumbnail_url"
    ],
    // The playable file: a list of renditions (smallest wins), else one URL.
    videoVersions: ["video_versions"],
    renditionUrl: ["url"],
    renditionWidth: ["width"],
    renditionHeight: ["height"],
    videoUrl: ["video_url"],
    // Is it a video at all.
    mediaType: ["media_type"],
    isVideo: ["is_video"],
    productType: ["product_type"]
  },
  videoMediaTypes: [2],
  videoProductTypes: ["clips", "igtv"],

  // A media pk carries its creation time in its upper bits, offset from this.
  pkEpochMs: 1314220021721,

  paging: {
    // Read on the object holding the list. Only a list made up mostly of the
    // target's reels may change "has more".
    hasNext: [
      "page_info.has_next_page",
      "paging_info.more_available",
      "more_available",
      "has_next_page",
      "has_more"
    ],
    // An empty, finished list under a key containing one of these words is
    // the profile saying it has no reels.
    reelsListKeys: ["clips", "reels"]
  },

  // When a sort stops on its own. Every sort ends and hands back what it has.
  limits: {
    // Scrolls during which Instagram answered but sent none of the profile's reels.
    scrollsWithoutReels: 10,
    // Scrolls in a row that brought no new reels.
    scrollsWithoutNewReels: 25,
    timeLimitMs: 180000,
    // "All reels" has no count to stop at, so it gets longer.
    timeLimitAllMs: 600000
  }
};
