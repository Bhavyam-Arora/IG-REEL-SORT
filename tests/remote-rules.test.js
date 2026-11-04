// lib/remote-rules.js: whether a reply from GET /v1/rules may replace the
// rules we have. The real v3 reply verifies against the pinned public key;
// everything else is signed here with a throwaway key, so each test fails on
// the one check it is about and not on the signature.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { bundledRules } = require("./harness");

const ROOT = path.join(__dirname, "..");
const V3 = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/rules-v3-response.json"), "utf8"));
const OURS = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).version;
const clone = (x) => JSON.parse(JSON.stringify(x));

// The checker as the worker loads it, optionally pinned to another key.
function loadChecker(jwk) {
  const ctx = { crypto, atob, TextEncoder, JSON, Math, Number, Object, Array, Uint8Array };
  vm.createContext(ctx);
  for (const f of ["lib/rules-public-key.js", "lib/remote-rules.js"]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx, { filename: f });
  }
  if (jwk) ctx.RULES_PUBLIC_KEY_JWK = jwk;
  return ctx;
}

// The backend's canonical form (scripts/admin/rules-common.mjs), written out
// again here so the extension's copy is checked against it, not against itself.
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}
const signed = (r) =>
  canonical({ version: r.version, rules: r.rules, minExtensionVersion: r.minExtensionVersion ?? null, notice: r.notice ?? null });

let testKey;
async function testSigner() {
  if (!testKey) {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    testKey = { privateKey: pair.privateKey, jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } };
  }
  return testKey;
}

// A reply like the real one, changed by edit(), signed with the test key.
async function reply(edit) {
  const { privateKey } = await testSigner();
  const r = clone(V3);
  if (edit) edit(r);
  delete r.signature;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, new TextEncoder().encode(signed(r)));
  r.signature = Buffer.from(sig).toString("base64");
  return r;
}

const HAVE = { builtinVersion: 2, storedVersion: 2, extensionVersion: OURS };

async function judge(r, have, jwk) {
  const c = loadChecker(jwk === undefined ? (await testSigner()).jwk : jwk);
  return c.judgeRemoteRules(r, Object.assign({}, HAVE, have), crypto.subtle);
}

// ---- Signature ----

test("the real v3 reply verifies against the built-in public key, and is used", async () => {
  const c = loadChecker();
  assert.equal(await c.verifyRulesSignature(V3, crypto.subtle), true);
  const v = await c.judgeRemoteRules(clone(V3), HAVE, crypto.subtle);
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.version, 3);
  assert.equal(v.rules.source, "remote");
  assert.ok(!("notice" in v.rules), "v3 has no notice");
});

test("the canonical JSON matches the backend's form byte for byte", () => {
  const c = loadChecker();
  assert.equal(c.rulesSignedPayload(V3), signed(V3));
  assert.equal(c.rulesSignedPayload({ version: 1, rules: { b: [1, { d: 1, c: "x" }], a: null } }),
    '{"minExtensionVersion":null,"notice":null,"rules":{"a":null,"b":[1,{"c":"x","d":1}]},"version":1}');
});

test("v3's rules are the built-in lib/rules.js, version aside", () => {
  const ours = bundledRules();
  const theirs = clone(V3.rules);
  delete ours.version;
  delete theirs.version;
  assert.equal(canonical(theirs), canonical(ours));
});

test("changing any one value in the rules fails the signature check", async () => {
  const c = loadChecker();
  const edits = [
    (r) => (r.rules.limits.timeLimitMs = 180001),
    (r) => (r.rules.fields.views[0] = "view_count"),
    (r) => r.rules.skipKeys.pop(),
    (r) => (r.version = 4),
    (r) => (r.rules.version = 4),
    (r) => (r.notice = "Hello"),
    (r) => (r.minExtensionVersion = "0.1.0"),
    (r) => (r.signature = r.signature.replace(/^./, (ch) => (ch === "A" ? "B" : "A"))),
    (r) => (r.signature = "not base64!"),
    (r) => delete r.signature
  ];
  for (const edit of edits) {
    const r = clone(V3);
    edit(r);
    assert.equal(await c.verifyRulesSignature(r, crypto.subtle), false, String(edit));
    const v = await c.judgeRemoteRules(r, HAVE, crypto.subtle);
    assert.deepEqual([v.ok, v.reason], [false, "bad signature"], String(edit));
  }
});

test("a reply signed by any other key is refused", async () => {
  const r = await reply((x) => (x.version = x.rules.version = 4));
  const v = await judge(r, {}, null); // null: the real pinned key
  assert.deepEqual([v.ok, v.reason], [false, "bad signature"]);
});

// ---- Versions ----

test("a lower or equal version is ignored, against the built-in and the stored copy", async () => {
  const at = (n) => reply((r) => (r.version = r.rules.version = n));
  assert.equal((await judge(await at(2), { builtinVersion: 2, storedVersion: null })).ok, false, "equal to built-in");
  assert.equal((await judge(await at(1), { builtinVersion: 2, storedVersion: 2 })).ok, false, "lower than built-in");
  assert.equal((await judge(await at(3), { storedVersion: 3 })).ok, false, "equal to stored");
  assert.equal((await judge(await at(4), { storedVersion: 5 })).ok, false, "lower than stored");
  assert.equal((await judge(await at(3), { builtinVersion: 4, storedVersion: null })).ok, false, "lower than a newer build's");
  const v = await judge(await at(6), { storedVersion: 5 });
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.version, 6);
});

test("version and rules.version must agree", async () => {
  const v = await judge(await reply((r) => (r.version = 9)));
  assert.equal(v.ok, false);
  assert.match(v.reason, /rules\.version/);
});

test("minExtensionVersion higher than ours: not used; equal or lower: used", async () => {
  const min = (m) => reply((r) => (r.minExtensionVersion = m));
  const v1 = await judge(await min("99.0"));
  assert.equal(v1.ok, false);
  assert.match(v1.reason, /needs extension 99\.0/);
  assert.equal((await judge(await min("0.2.1"), { extensionVersion: "0.2.0" })).ok, false);
  assert.equal((await judge(await min("0.2.0.1"), { extensionVersion: "0.2" })).ok, false);
  assert.equal((await judge(await min("0.2"), { extensionVersion: "0.2.0" })).ok, true);
  assert.equal((await judge(await min("0.1.9"), { extensionVersion: "0.2.0" })).ok, true);
  assert.equal((await judge(await min("0.10.0"), { extensionVersion: "0.9.0" })).ok, false, "numeric, not text, comparison");
  assert.equal((await judge(await min("one"))).ok, false, "not a version");
});

// ---- Schema ----

test("the built-in lib/rules.js passes the schema, and the schema has exactly its keys", () => {
  const c = loadChecker();
  const rules = bundledRules();
  assert.deepEqual(clone(c.checkRulesSchema(rules)), []);
  (function same(schema, value, at) {
    assert.deepEqual(Object.keys(schema).sort(), Object.keys(value).sort(), at);
    for (const k of Object.keys(schema)) {
      if (typeof schema[k].kind !== "string") same(schema[k], value[k], at + "." + k);
    }
  })(c.RULES_SCHEMA, rules, "rules");
});

async function rejected(edit, pattern) {
  const v = await judge(await reply(edit));
  assert.equal(v.ok, false, String(edit));
  assert.match(v.reason, /^schema: /, String(edit));
  if (pattern) assert.match(v.reason, pattern, String(edit));
}

test("an unknown key is rejected, at any depth", async () => {
  await rejected((r) => (r.rules.extra = ["x"]), /rules\.extra: unknown key/);
  await rejected((r) => (r.rules.fields.newThing = ["x"]), /unknown key/);
  await rejected((r) => (r.rules.limits.maxReels = 5), /unknown key/);
  await rejected((r) => (r.rules = JSON.parse(JSON.stringify(r.rules).replace("{", '{"__proto__":{"x":1},'))), /__proto__: unknown key/);
});

test("a missing key or a wrong type is rejected", async () => {
  await rejected((r) => delete r.rules.paging, /paging: missing/);
  await rejected((r) => (r.rules.fields.views = "play_count"));
  await rejected((r) => (r.rules.limits.timeLimitMs = "180000"));
  await rejected((r) => (r.rules.fields = []));
  await rejected((r) => (r.rules.videoMediaTypes = ["2"]));
});

test("a URL- or code-like string is rejected", async () => {
  const bad = [
    "https://evil.example/x",
    "javascript:alert(1)",
    "<script>",
    "function",
    "a=>b",
    "x://y",
    "a b",
    ""
  ];
  for (const s of bad) {
    await rejected((r) => (r.rules.fields.views[0] = s));
    await rejected((r) => (r.rules.skipKeys[0] = s));
  }
  await rejected((r) => (r.rules.responses.bodyPrefixes[0] = "function(){}"));
  await rejected((r) => (r.rules.responses.pathPrefixes[0] = "//evil.example/"));
  await rejected((r) => (r.rules.responses.pathPrefixes[0] = "/api/<x>"));
});

test("every host must be instagram.com or a subdomain of it", async () => {
  for (const h of ["evil.com", "instagram.com.evil.com", "notinstagram.com", "instagram.co", "localhost"]) {
    await rejected((r) => (r.rules.responses.hosts = ["instagram.com", h]), /hosts\[1\]/);
  }
  const ok = await judge(await reply((r) => (r.rules.responses.hosts = ["instagram.com", "i.instagram.com"])));
  assert.equal(ok.ok, true, ok.reason);
});

test("lists and strings are capped", async () => {
  await rejected((r) => (r.rules.skipKeys = Array.from({ length: 33 }, (_, i) => "k" + i)), /list of 1 to 32/);
  await rejected((r) => (r.rules.skipKeys = []), /list of 1 to 32/);
  await rejected((r) => (r.rules.skipKeys[0] = "a".repeat(129)), /length 129/);
  const ok = await judge(await reply((r) => (r.rules.skipKeys = Array.from({ length: 32 }, () => "a".repeat(128)))));
  assert.equal(ok.ok, true, ok.reason);
});

test("an out-of-range number is rejected", async () => {
  const cases = [
    (r) => (r.rules.limits.timeLimitMs = 0),
    (r) => (r.rules.limits.timeLimitMs = -1),
    (r) => (r.rules.limits.timeLimitAllMs = 0),
    (r) => (r.rules.limits.timeLimitMs = 1.5e6 + 0.5),
    (r) => (r.rules.limits.scrollsWithoutReels = 0),
    (r) => (r.rules.limits.scrollsWithoutReels = 201),
    (r) => (r.rules.limits.scrollsWithoutNewReels = 0),
    (r) => (r.rules.limits.scrollsWithoutNewReels = 1000),
    (r) => (r.rules.responses.maxBodyChars = 20000001),
    (r) => (r.rules.responses.maxBodyChars = 0),
    (r) => (r.rules.pkEpochMs = 0),
    (r) => (r.rules.videoMediaTypes = [-1]),
    (r) => (r.rules.videoMediaTypes = [1e9])
  ];
  for (const edit of cases) await rejected(edit, /out of range/);
  const edge = await judge(await reply((r) => {
    r.rules.limits.scrollsWithoutReels = 1;
    r.rules.limits.scrollsWithoutNewReels = 200;
    r.rules.responses.maxBodyChars = 20000000;
  }));
  assert.equal(edge.ok, true, edge.reason);
});

test("notice: plain text up to 200 characters is kept with the rules; anything else is rejected", async () => {
  const v = await judge(await reply((r) => (r.notice = "Instagram changed today; sorting may be slower until Friday.")));
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.rules.notice, "Instagram changed today; sorting may be slower until Friday.");
  assert.equal((await judge(await reply((r) => (r.notice = "x".repeat(200))))).ok, true);
  for (const n of ["x".repeat(201), "", " padded", "<b>hi</b>", "see https://evil.example", "go to evil.com now",
    "javascript:void(0)", "line\nbreak", 42, ["x"]]) {
    const bad = await judge(await reply((r) => (r.notice = n)));
    assert.equal(bad.ok, false, JSON.stringify(n));
    assert.match(bad.reason, /notice/, JSON.stringify(n));
  }
});

test("not a reply at all: refused, never thrown", async () => {
  for (const r of [null, "text", [], 3, {}]) {
    assert.equal((await judge(r)).ok, false, JSON.stringify(r));
  }
});
