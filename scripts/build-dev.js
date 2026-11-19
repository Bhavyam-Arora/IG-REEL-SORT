// scripts/build-dev.js — `npm run build:dev`. Writes a dev copy of the
// extension to dist/dev (git-ignored): the dev API_BASE and the dev API +
// upload bucket hosts, everything else as in the repo. The manifest "key"
// stays, so the dev copy has the same extension ID (and Google sign-in works).
// Load dist/dev unpacked to test against dev; rerun after every change.

const path = require("path");
const { DIST, PROD_API, PROD_HOSTS, DEV_API, DEV_HOSTS, stage, replaceOnce } = require("./build");

const OUT = path.join(DIST, "dev");

stage(OUT, (f, text) => {
  if (f === "lib/config.js") {
    text = replaceOnce(text, 'var ENV = "prod";', 'var ENV = "dev";', f);
    text = replaceOnce(text, '"' + PROD_API + '"', '"' + DEV_API + '"', f);
  }
  if (f === "manifest.json") {
    PROD_HOSTS.forEach((h, i) => (text = replaceOnce(text, '"' + h + '"', '"' + DEV_HOSTS[i] + '"', f)));
  }
  return text;
});

console.log("Dev build written to " + path.relative(process.cwd(), OUT) + "/ (API " + DEV_API + ")");
console.log("Load it unpacked from chrome://extensions. Remove the repo's unpacked copy first: they share an ID.");
