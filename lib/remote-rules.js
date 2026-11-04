// lib/remote-rules.js — decides whether a reply from GET {API_BASE}/v1/rules
// may replace the rules we have. Loaded into the service worker only, after
// lib/rules-public-key.js. No storage and no network here: background.js
// fetches the reply and stores what this accepts.
//
// A reply is used only if all of these hold:
//   - its signature verifies against RULES_PUBLIC_KEY_JWK;
//   - its rules pass the strict schema below (lib/rules.js's keys and types,
//     nothing else, every value in range);
//   - its version is higher than the built-in copy and anything stored;
//   - this build is at least its minExtensionVersion.
// Anything else is thrown away and the current rules stay.

// Bytes of reply read at most. v3 is ~1.9 KB; the backend refuses to publish
// rules over 32 KB.
var REMOTE_RULES_MAX_TEXT = 64 * 1024;
var REMOTE_RULES_MAX_LIST = 32;
var REMOTE_RULES_MAX_STRING = 128;
var REMOTE_RULES_NOTICE_MAX = 200;

// ---- Signature ----

// The signed message, rebuilt exactly as the backend's
// scripts/admin/rules-common.mjs signs it: canonical JSON of
// { version, rules, minExtensionVersion, notice }, every object's keys sorted
// (JS default sort) at every depth, arrays in order, no whitespace, values as
// JSON.stringify writes them, an absent minExtensionVersion or notice as null.
function rulesCanonicalJson(value) {
  if (Array.isArray(value)) return "[" + value.map(rulesCanonicalJson).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map(function (k) {
      return JSON.stringify(k) + ":" + rulesCanonicalJson(value[k]);
    }).join(",") + "}";
  }
  return JSON.stringify(value);
}

function rulesSignedPayload(reply) {
  return rulesCanonicalJson({
    version: reply.version,
    rules: reply.rules,
    minExtensionVersion: reply.minExtensionVersion == null ? null : reply.minExtensionVersion,
    notice: reply.notice == null ? null : reply.notice
  });
}

function rulesBase64Bytes(s) {
  if (typeof s !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  try {
    var bin = atob(s);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch (e) {
    return null;
  }
}

// ECDSA P-256 / SHA-256 over the UTF-8 bytes of the signed message. The
// signature is base64 of raw r||s (64 bytes), WebCrypto's own format.
async function verifyRulesSignature(reply, subtle) {
  var sig = rulesBase64Bytes(reply && reply.signature);
  if (!sig || sig.length !== 64) return false;
  try {
    var key = await subtle.importKey("jwk", RULES_PUBLIC_KEY_JWK, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    var data = new TextEncoder().encode(rulesSignedPayload(reply));
    return await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, data);
  } catch (e) {
    return false;
  }
}

// ---- Schema ----

// Every kind of string a rules list may hold. None admits ":", "<", ">", a
// backslash or "//". Written so no pattern can backtrack badly.
var RULES_STRING_KINDS = {
  fieldPath: /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/, // "a.0.b"
  word: /^[A-Za-z0-9_]+$/,
  host: /^[a-z0-9-]+(\.[a-z0-9-]+)+$/,
  pathPrefix: /^\/([A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]*$/, // "/api/"
  bodyPrefix: /^[A-Za-z0-9 ();[\]{}']+$/ // "for (;;);", ")]}'"
};
// Belt and braces on top of the patterns, for every string.
var RULES_LOOKS_LIKE_CODE = /:\/\/|<|javascript:|function|=>/i;
var RULES_ALLOWED_HOST = "instagram.com";

function rulesList(of) { return { kind: "list", of: of }; }
function rulesInt(min, max) { return { kind: "int", min: min, max: max }; }

// lib/rules.js, key for key. Every key is required and no other is accepted.
// A leaf has a `kind`; anything else is a nested object.
var RULES_SCHEMA = {
  version: rulesInt(1, 1e9),
  responses: {
    hosts: rulesList("host"),
    pathPrefixes: rulesList("pathPrefix"),
    pathContains: rulesList("word"),
    bodyPrefixes: rulesList("bodyPrefix"),
    maxBodyChars: rulesInt(10000, 20000000)
  },
  skipKeys: rulesList("word"),
  fields: {
    code: rulesList("fieldPath"),
    pk: rulesList("fieldPath"),
    owner: rulesList("fieldPath"),
    coauthors: rulesList("fieldPath"),
    coauthorName: rulesList("fieldPath"),
    views: rulesList("fieldPath"),
    likes: rulesList("fieldPath"),
    comments: rulesList("fieldPath"),
    date: rulesList("fieldPath"),
    videoDuration: rulesList("fieldPath"),
    caption: rulesList("fieldPath"),
    thumbnail: rulesList("fieldPath"),
    videoVersions: rulesList("fieldPath"),
    renditionUrl: rulesList("fieldPath"),
    renditionWidth: rulesList("fieldPath"),
    renditionHeight: rulesList("fieldPath"),
    videoUrl: rulesList("fieldPath"),
    mediaType: rulesList("fieldPath"),
    isVideo: rulesList("fieldPath"),
    productType: rulesList("fieldPath")
  },
  videoMediaTypes: { kind: "intList", min: 0, max: 100 },
  videoProductTypes: rulesList("word"),
  pkEpochMs: rulesInt(1000000000000, 2000000000000),
  paging: {
    hasNext: rulesList("fieldPath"),
    reelsListKeys: rulesList("word")
  },
  limits: {
    scrollsWithoutReels: rulesInt(1, 200),
    scrollsWithoutNewReels: rulesInt(1, 200),
    timeLimitMs: rulesInt(10000, 3600000),
    timeLimitAllMs: rulesInt(10000, 3600000)
  }
};

function rulesHas(o, k) {
  return Object.prototype.hasOwnProperty.call(o, k);
}

function rulesIntIn(n, spec) {
  return Number.isSafeInteger(n) && n >= spec.min && n <= spec.max;
}

function checkRulesString(s, kind, at, errors) {
  if (typeof s !== "string") return errors.push(at + ": not a string");
  if (s.length === 0 || s.length > REMOTE_RULES_MAX_STRING) return errors.push(at + ": length " + s.length);
  if (RULES_LOOKS_LIKE_CODE.test(s) || !RULES_STRING_KINDS[kind].test(s)) return errors.push(at + ": not a " + kind);
  if (kind === "host" && s !== RULES_ALLOWED_HOST && !s.endsWith("." + RULES_ALLOWED_HOST)) {
    errors.push(at + ": host not allowed");
  }
}

function checkRulesLeaf(value, spec, at, errors) {
  if (spec.kind === "int") {
    if (!rulesIntIn(value, spec)) errors.push(at + ": out of range");
    return;
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > REMOTE_RULES_MAX_LIST) {
    errors.push(at + ": must be a list of 1 to " + REMOTE_RULES_MAX_LIST);
    return;
  }
  value.forEach(function (item, i) {
    if (spec.kind === "intList") {
      if (!rulesIntIn(item, spec)) errors.push(at + "[" + i + "]: out of range");
    } else {
      checkRulesString(item, spec.of, at + "[" + i + "]", errors);
    }
  });
}

function checkRulesShape(value, schema, at, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return errors.push(at + ": not an object");
  Object.keys(value).forEach(function (k) {
    if (!rulesHas(schema, k)) errors.push(at + "." + k + ": unknown key");
  });
  Object.keys(schema).forEach(function (k) {
    var spec = schema[k];
    if (!rulesHas(value, k)) errors.push(at + "." + k + ": missing");
    else if (typeof spec.kind === "string") checkRulesLeaf(value[k], spec, at + "." + k, errors);
    else checkRulesShape(value[k], spec, at + "." + k, errors);
  });
}

// The problems with a rules object, or [] when it passes.
function checkRulesSchema(rules) {
  var errors = [];
  checkRulesShape(rules, RULES_SCHEMA, "rules", errors);
  return errors;
}

// Plain text, 1 to 200 characters, or absent (null). No control characters,
// markup or links: the backend's publish check, plus "javascript:". Words
// like "function" are allowed here, as the backend allows them, so a notice
// it published can't silently hold back the rules it came with.
function checkRulesNotice(notice) {
  if (notice == null) return null;
  if (typeof notice !== "string") return "notice: not a string";
  if (notice.length === 0 || notice.length > REMOTE_RULES_NOTICE_MAX || notice.trim() !== notice) {
    return "notice: must be 1 to " + REMOTE_RULES_NOTICE_MAX + " characters, trimmed";
  }
  if (
    /[\u0000-\u001f\u007f-\u009f<>\\]/.test(notice) ||
    /:\/\/|javascript:/i.test(notice) ||
    /www\.|\b[a-z0-9-]+\.(com|co|net|org|io|app|me|ly|in|link|xyz)\b/i.test(notice)
  ) {
    return "notice: not plain text";
  }
  return null;
}

// ---- Versions ----

// A Chrome extension version ("0.3.0"): 1 to 4 integers, each 0-65535.
function parseExtensionVersion(v) {
  if (typeof v !== "string" || !/^\d{1,5}(\.\d{1,5}){0,3}$/.test(v)) return null;
  var parts = v.split(".").map(Number);
  return parts.every(function (n) { return n <= 65535; }) ? parts : null;
}

// < 0, 0 or > 0, as a is older than, the same as, or newer than b.
function compareExtensionVersions(a, b) {
  for (var i = 0; i < 4; i++) {
    var d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}

// ---- The decision ----

// have: { builtinVersion, storedVersion (or null), extensionVersion }.
// Resolves to { ok: true, version, rules } — rules being what to store, the
// signed rules plus source "remote" and the notice — or { ok: false, reason }.
async function judgeRemoteRules(reply, have, subtle) {
  if (!reply || typeof reply !== "object" || Array.isArray(reply)) return { ok: false, reason: "not a rules reply" };
  if (!(await verifyRulesSignature(reply, subtle))) return { ok: false, reason: "bad signature" };

  var errors = checkRulesSchema(reply.rules);
  var noticeError = checkRulesNotice(reply.notice);
  if (noticeError) errors.push(noticeError);
  if (reply.minExtensionVersion != null && !parseExtensionVersion(reply.minExtensionVersion)) {
    errors.push("minExtensionVersion: not a version");
  }
  if (!errors.length && reply.rules.version !== reply.version) errors.push("rules.version: differs from version");
  if (errors.length) return { ok: false, reason: "schema: " + errors.slice(0, 5).join("; ") };

  var best = Math.max(have.builtinVersion, have.storedVersion == null ? 0 : have.storedVersion);
  if (!(reply.version > best)) return { ok: false, reason: "v" + reply.version + " is not newer than v" + best };

  if (reply.minExtensionVersion != null) {
    var ours = parseExtensionVersion(have.extensionVersion);
    if (!ours || compareExtensionVersions(ours, parseExtensionVersion(reply.minExtensionVersion)) < 0) {
      return { ok: false, reason: "needs extension " + reply.minExtensionVersion + ", this is " + have.extensionVersion };
    }
  }

  var rules = JSON.parse(JSON.stringify(reply.rules));
  rules.source = "remote";
  if (reply.notice != null) rules.notice = reply.notice;
  return { ok: true, version: reply.version, rules: rules };
}
