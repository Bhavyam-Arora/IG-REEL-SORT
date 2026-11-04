// lib/rules-public-key.js — the PUBLIC half of the key that signs the rules
// served at GET {API_BASE}/v1/rules. Not a secret. Copied from the backend's
// docs/rules-public-key.txt (ECDSA P-256, SHA-256). The private half never
// leaves the admin's Mac; nothing in the extension can sign.
//
// Changing this key means every rules version signed with the old one stops
// verifying, and the extension quietly keeps what it has.

var RULES_PUBLIC_KEY_JWK = {
  kty: "EC",
  crv: "P-256",
  x: "lJyk1L5AVGoRLihRjDQgp8BmwScgOGahwurq3DqMkEY",
  y: "SJPlZJeLemTI-BArguVEUDc4NBMf9P-W7l0EhBV4mnc"
};
