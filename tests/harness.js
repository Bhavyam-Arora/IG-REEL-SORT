// tests/harness.js — loads the page-world scripts into a Node vm with just
// enough of a browser around them to run. No dependencies.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const FIXTURES = path.join(__dirname, "fixtures");

function source(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

// A debug-sample-shaped fixture, or null when the file isn't there (the real
// samples are gitignored and only exist on a developer's machine).
function fixture(name) {
  const file = path.join(FIXTURES, name);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function bodies(sample) {
  return sample.graphqlBodies.map((b) => ({ url: b.url, text: b.body, json: JSON.parse(b.body) }));
}

function tick() {
  return new Promise((r) => setImmediate(r));
}

// A page at `href` with extract.js and interceptor.js loaded, and optionally
// collector.js with a sort job waiting for it.
//
// Time is fake: every setTimeout advances the page's clock by its delay and
// fires on the next tick, so a 10-minute run takes milliseconds. onScroll runs
// on each window.scrollTo, standing in for Instagram answering the scroll.
function loadPage(href, opts) {
  opts = opts || {};
  const clock = { now: Date.parse("2026-10-01T00:00:00Z") };
  const messages = [];
  const session = {};
  const listeners = [];
  if (opts.job) session.igSorterJob = JSON.stringify(opts.job);

  function XMLHttpRequest() {}
  XMLHttpRequest.prototype.open = function () {};
  XMLHttpRequest.prototype.send = function () {};
  XMLHttpRequest.prototype.addEventListener = function () {};

  const w = {
    console: { log() {}, warn() {} },
    location: { href, pathname: new URL(href).pathname },
    navigator: { userAgent: "node-test" },
    XMLHttpRequest,
    // The "network": a test passes the body it wants Instagram to return.
    fetch(input, init) {
      const text = (init && init.body) || "";
      return Promise.resolve({
        status: 200,
        headers: { get: () => "application/json" },
        clone() {
          return this;
        },
        text: () => Promise.resolve(text)
      });
    },
    CustomEvent: function (type, init) {
      this.type = type;
      this.detail = init && init.detail;
    },
    dispatchEvent() {},
    addEventListener(type, fn) {
      if (type === "message") listeners.push(fn);
    },
    // Deliver a window message as if posted by the page (or content.js).
    // Inside the vm, `window` is the context's global proxy rather than this
    // object, so that is what the scripts' `ev.source !== window` compares to.
    deliver(data) {
      const self = vm.runInContext("window", w);
      for (const fn of listeners) fn({ source: self, data });
    },
    postMessage(msg) {
      messages.push(msg);
    },
    sessionStorage: {
      getItem: (k) => (k in session ? session[k] : null),
      setItem: (k, v) => (session[k] = String(v)),
      removeItem: (k) => delete session[k]
    },
    document: { body: { scrollHeight: 1000 } },
    scrolls: 0,
    scrollTo(x, y) {
      if (y === 0) return; // back to the top at the end of a run
      w.scrolls++;
      if (opts.onScroll) opts.onScroll(w, w.scrolls);
    },
    setTimeout(fn, ms) {
      clock.now += ms || 0;
      setImmediate(fn);
    }
  };
  w.window = w;
  w.messages = messages;
  w.clock = clock;

  vm.createContext(w);
  vm.runInContext("Date.now = function () { return __clock.now; };", Object.assign(w, { __clock: clock }));
  vm.runInContext(source("lib/extract.js"), w, { filename: "lib/extract.js" });
  vm.runInContext(source("page/interceptor.js"), w, { filename: "page/interceptor.js" });
  if (opts.job) vm.runInContext(source("page/collector.js"), w, { filename: "page/collector.js" });
  return w;
}

// Hand the page a response as if Instagram had fetched `url`, and wait for the
// interceptor to finish reading it.
async function respond(w, url, text) {
  await w.fetch(url, { body: text });
  await tick();
  await tick();
}

// Run the collector until it posts its result.
async function result(w) {
  for (let i = 0; i < 100000; i++) {
    const r = w.messages.find((m) => m.source === "ig-sorter" && m.type === "result");
    if (r) return r;
    await tick();
  }
  throw new Error("collector never finished");
}

// A reel as the extractor would hand it over.
let n = 0;
function reel(owner, extra) {
  n++;
  return Object.assign(
    {
      code: "TEST" + n,
      owner,
      coauthors: [],
      isVideo: true,
      views: 1000 * n,
      likes: 10 * n,
      comments: n,
      createdAt: new Date(Date.UTC(2026, 8, 1) + n * 3600e3).toISOString()
    },
    extra
  );
}

module.exports = { loadPage, respond, result, fixture, bodies, reel, tick };
