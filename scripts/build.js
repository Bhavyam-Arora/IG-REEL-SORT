// scripts/build.js — what goes into a build, and the dev overrides. Shared by
// build-dev.js and release.js. No dependencies.
//
// The repo itself is the prod build. A build is an allowlist: only the files
// the extension loads, never tests, fixtures, docs, scripts or dotfiles, and
// never anything git-ignored (real Instagram samples, debug downloads).

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");

const FILES = ["manifest.json", "background.js", "content.js", "popup.html", "popup.css", "popup.js"];
const DIRS = ["icons", "lib", "page"];

const PROD_API = "https://api.sortcut.co";
const PROD_HOSTS = [
  "https://api.sortcut.co/*",
  "https://sortcut-prod-audio-417731043728.s3.ap-southeast-2.amazonaws.com/*"
];
const DEV_API = "https://uc7bn8aln5.execute-api.ap-southeast-2.amazonaws.com";
const DEV_HOSTS = [
  "https://uc7bn8aln5.execute-api.ap-southeast-2.amazonaws.com/*",
  "https://sortcut-dev-audio-590854469967.s3.ap-southeast-2.amazonaws.com/*"
];

// Anything matching one of these points at dev and must never ship.
const DEV_MARKERS = [/api-dev/i, /execute-api/i, /sortcut-dev/i, /\bENV\s*=\s*["']dev["']/];

function walk(rel) {
  return fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })
    .filter((e) => !e.name.startsWith("."))
    .flatMap((e) => {
      const r = rel + "/" + e.name;
      return e.isDirectory() ? walk(r) : [r];
    });
}

function ignored(files) {
  try {
    return execFileSync("git", ["check-ignore", "--stdin"], { cwd: ROOT, input: files.join("\n"), encoding: "utf8" })
      .split("\n").filter(Boolean);
  } catch (e) {
    if (e.status === 1) return []; // none ignored
    throw e;
  }
}

// The files in a build, relative to the repo root.
function buildFiles() {
  const files = FILES.concat(...DIRS.map(walk)).sort();
  const skip = new Set(ignored(files));
  return files.filter((f) => !skip.has(f));
}

// Copies the build's files into dir (emptied first), letting edit(rel, text)
// rewrite text files on the way. Returns the copied paths.
function stage(dir, edit) {
  fs.rmSync(dir, { recursive: true, force: true });
  const files = buildFiles();
  for (const f of files) {
    const to = path.join(dir, f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const from = path.join(ROOT, f);
    if (/\.(js|json|html|css)$/.test(f)) {
      const text = fs.readFileSync(from, "utf8");
      fs.writeFileSync(to, edit ? edit(f, text) : text);
    } else {
      fs.copyFileSync(from, to);
    }
  }
  return files;
}

// Replaces exactly one occurrence of from with to, or throws: if the source
// file changes shape, the build stops instead of shipping it unedited.
function replaceOnce(text, from, to, where) {
  const n = text.split(from).length - 1;
  if (n !== 1) throw new Error(where + ": expected exactly one " + JSON.stringify(from) + ", found " + n);
  return text.replace(from, () => to);
}

// Every dev marker in the staged files, as "file: match".
function devHits(dir, files) {
  const hits = [];
  for (const f of files) {
    if (!/\.(js|json|html|css)$/.test(f)) continue;
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    for (const re of DEV_MARKERS) {
      const m = text.match(re);
      if (m) hits.push(f + ": " + m[0]);
    }
  }
  return hits;
}

module.exports = {
  ROOT, DIST, PROD_API, PROD_HOSTS, DEV_API, DEV_HOSTS,
  buildFiles, stage, replaceOnce, devHits
};
