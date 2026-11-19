// lib/config.js — build settings, loaded into the service worker with
// importScripts. Nothing here is secret: the client ID is public by design and
// there is no client secret anywhere in the extension.
//
// The repo is the prod build. `npm run build:dev` writes a dev copy to dist/dev
// with the dev API_BASE and the dev host_permissions (the API host and the
// upload bucket) swapped together: the worker can only reach hosts the manifest
// lists, so one without the other fails every call. `npm run release` refuses
// to package anything that still points at dev.

var ENV = "prod";

var API_BASE = "https://api.sortcut.co";

var GOOGLE_CLIENT_ID =
  "900131383830-6g9skhqht8tpn31njt6jshdd40debpu3.apps.googleusercontent.com";

// Decimal bytes, not MiB. Must equal the backend's MAX_UPLOAD_BYTES: the
// presigned upload is capped there, so a larger number here only moves the
// failure to after a wasted download.
var MAX_BYTES = 24_000_000;

// Upgrade opens the dashboard's checkout here, with a one-time handoff code
// in the URL fragment (never sent to a server). The page preselects Monthly
// and lets the user switch; no plan or price lives in the extension.
var CHECKOUT_URL = "https://accounts.sortcut.co/checkout";

// The most reels a Free sort keeps, of any age, whatever depth is asked for.
// The collector enforces it too, not just the popup's Depth menu. Pro has no
// cap.
var FREE_MAX_REELS = 50;
