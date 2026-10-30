// lib/config.js — build settings, loaded into the service worker with
// importScripts. Nothing here is secret: the client ID is public by design and
// there is no client secret anywhere in the extension.
//
// A prod build must change API_BASE and the manifest's host_permissions
// together (the API host and the upload bucket). The worker can only reach
// hosts the manifest lists, so one without the other fails every call.

var ENV = "dev";

var API_BASE = "https://uc7bn8aln5.execute-api.ap-southeast-2.amazonaws.com";

var GOOGLE_CLIENT_ID =
  "900131383830-6g9skhqht8tpn31njt6jshdd40debpu3.apps.googleusercontent.com";

// Decimal bytes, not MiB. Must equal the backend's MAX_UPLOAD_BYTES: the
// presigned upload is capped there, so a larger number here only moves the
// failure to after a wasted download.
var MAX_BYTES = 24_000_000;

// The most reels a Free sort keeps, of any age, whatever depth is asked for.
// The collector enforces it too, not just the popup's Depth menu. Pro has no
// cap.
var FREE_MAX_REELS = 50;
