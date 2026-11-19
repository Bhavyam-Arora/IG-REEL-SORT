// scripts/release.js — `npm run release`. Builds dist/sortcut-<version>.zip
// for the Chrome Web Store from the repo as it is (the prod build).
//
// Refuses if anything in the build points at dev (api-dev, execute-api, the
// sortcut-dev bucket, ENV = "dev") or the prod API/hosts are missing. Drops the
// manifest "key" from the zip only: the Web Store rejects it, and the repo
// keeps it so unpacked copies keep the pinned extension ID.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { DIST, PROD_API, PROD_HOSTS, stage, devHits } = require("./build");

const STAGE = path.join(DIST, "release");

function refuse(why) {
  console.error("release: REFUSED — " + why);
  process.exit(1);
}

const files = stage(STAGE, (f, text) => {
  if (f !== "manifest.json") return text;
  const m = JSON.parse(text);
  delete m.key;
  return JSON.stringify(m, null, 2) + "\n";
});

const hits = devHits(STAGE, files);
if (hits.length) refuse("points at dev:\n  " + hits.join("\n  "));

const manifest = JSON.parse(fs.readFileSync(path.join(STAGE, "manifest.json"), "utf8"));
const config = fs.readFileSync(path.join(STAGE, "lib/config.js"), "utf8");
if ("key" in manifest) refuse('manifest still has "key"');
if (!config.includes('var API_BASE = "' + PROD_API + '";')) refuse("lib/config.js API_BASE is not " + PROD_API);
for (const h of PROD_HOSTS) {
  if (!manifest.host_permissions.includes(h)) refuse("manifest host_permissions lacks " + h);
}

// Every file the manifest names must be in the build.
const named = [manifest.background.service_worker, manifest.action.default_popup]
  .concat(Object.values(manifest.icons), Object.values(manifest.action.default_icon))
  .concat(...manifest.content_scripts.map((c) => (c.js || []).concat(c.css || [])))
  .concat(...manifest.web_accessible_resources.map((w) => w.resources));
const missing = [...new Set(named)].filter((f) => !files.includes(f));
if (missing.length) refuse("manifest names files not in the build: " + missing.join(", "));

const zip = path.join(DIST, "sortcut-" + manifest.version + ".zip");
fs.rmSync(zip, { force: true });
execFileSync("zip", ["-q", "-X", "-r", zip, "."], { cwd: STAGE });
fs.rmSync(STAGE, { recursive: true, force: true });

const listed = execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" }).split("\n").filter((l) => l && !l.endsWith("/"));
console.log("Built " + path.relative(process.cwd(), zip) + " (" + manifest.version + ", " + listed.length + " files, " +
  Math.round(fs.statSync(zip).size / 1024) + " KB):");
listed.sort().forEach((f) => console.log("  " + f));
