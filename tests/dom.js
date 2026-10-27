// tests/dom.js — the smallest DOM content.js needs to run in a Node vm: a
// tree, inline styles with priorities, attributes, simple selectors (no
// combinators), bubbling events, and a MutationObserver for childList and
// attribute changes. No dependencies.

function kebab(k) {
  return k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
}

function makeStyle(el) {
  const props = new Map();
  const api = {
    setProperty(k, v, priority) {
      if (v === "" || v === null || v === undefined) return api.removeProperty(k);
      props.set(k, { value: String(v), priority: priority || "" });
      el._changed("style");
    },
    removeProperty(k) {
      if (props.delete(k)) el._changed("style");
    },
    getPropertyValue(k) {
      return props.has(k) ? props.get(k).value : "";
    },
    getPropertyPriority(k) {
      return props.has(k) ? props.get(k).priority : "";
    },
    get cssText() {
      return [...props].map(([k, p]) => k + ": " + p.value + (p.priority ? " !" + p.priority : "") + ";").join(" ");
    },
    set cssText(text) {
      props.clear();
      String(text).split(";").forEach((decl) => {
        const i = decl.indexOf(":");
        if (i < 0) return;
        let v = decl.slice(i + 1).trim();
        let priority = "";
        if (/!important$/.test(v)) {
          priority = "important";
          v = v.replace(/\s*!important$/, "");
        }
        props.set(decl.slice(0, i).trim(), { value: v, priority });
      });
      el._changed("style");
    }
  };
  return new Proxy(api, {
    get(t, k) {
      if (k in t) return t[k];
      return typeof k === "string" ? t.getPropertyValue(kebab(k)) : undefined;
    },
    set(t, k, v) {
      if (k === "cssText") t.cssText = v;
      else t.setProperty(kebab(k), v);
      return true;
    }
  });
}

const TOKEN = /([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:([*^$]?=)"([^"]*)")?\]/g;

function parse(selector) {
  return selector.split(",").map((part) => {
    const c = { tag: null, id: null, classes: [], attrs: [] };
    for (const m of part.trim().matchAll(TOKEN)) {
      if (m[1]) c.tag = m[1].toUpperCase();
      else if (m[2]) c.id = m[2];
      else if (m[3]) c.classes.push(m[3]);
      else c.attrs.push({ name: m[4], op: m[5], value: m[6] });
    }
    return c;
  });
}

function matchesOne(el, c) {
  if (c.tag && el.tagName !== c.tag) return false;
  if (c.id && el.id !== c.id) return false;
  for (const cls of c.classes) if (!el.classList.contains(cls)) return false;
  for (const a of c.attrs) {
    if (!el.hasAttribute(a.name)) return false;
    const v = el.getAttribute(a.name);
    if (a.op === "=" && v !== a.value) return false;
    if (a.op === "*=" && v.indexOf(a.value) === -1) return false;
  }
  return true;
}

function createDocument() {
  const observers = new Set();
  let scheduled = false;

  function deliver() {
    scheduled = false;
    for (const o of observers) {
      if (!o.queue.length) continue;
      const records = o.queue.splice(0);
      o.cb(records, o);
    }
  }

  function notify(record) {
    for (const o of observers) {
      for (const { target, options } of o.targets) {
        if (target !== record.target) continue;
        const wanted =
          record.type === "childList"
            ? options.childList
            : options.attributes &&
              (!options.attributeFilter || options.attributeFilter.includes(record.attributeName));
        if (wanted) o.queue.push(record);
      }
    }
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(deliver);
    }
  }

  class MutationObserver {
    constructor(cb) {
      this.cb = cb;
      this.targets = [];
      this.queue = [];
    }
    observe(target, options) {
      this.targets.push({ target, options });
      observers.add(this);
    }
    disconnect() {
      this.targets = [];
      this.queue = [];
      observers.delete(this);
    }
  }

  class Element {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.parentElement = null;
      this._attrs = new Map();
      this._text = "";
      this._listeners = [];
      this.style = makeStyle(this);
      const self = this;
      this.classList = {
        contains: (c) => self.className.split(/\s+/).includes(c),
        add: (...cs) => cs.forEach((c) => !self.classList.contains(c) && (self.className = (self.className + " " + c).trim())),
        remove: (...cs) => (self.className = self.className.split(/\s+/).filter((x) => !cs.includes(x)).join(" ")),
        toggle: (c, on) => (on === undefined ? !self.classList.contains(c) : on) ? self.classList.add(c) : self.classList.remove(c)
      };
    }
    _changed(name) {
      notify({ type: "attributes", target: this, attributeName: name });
    }
    get parentNode() { return this.parentElement; }
    get firstChild() { return this.children[0] || null; }
    get id() { return this.getAttribute("id") || ""; }
    set id(v) { this.setAttribute("id", v); }
    get className() { return this.getAttribute("class") || ""; }
    set className(v) { this.setAttribute("class", v); }
    get href() { return this.getAttribute("href") || ""; }
    set href(v) { this.setAttribute("href", v); }
    get title() { return this.getAttribute("title") || ""; }
    set title(v) { this.setAttribute("title", v); }
    get hidden() { return this.hasAttribute("hidden"); }
    set hidden(v) { v ? this.setAttribute("hidden", "") : this.removeAttribute("hidden"); }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
    set textContent(v) {
      this.children.slice().forEach((c) => c.remove());
      this._text = String(v);
    }
    get isConnected() {
      let n = this;
      while (n.parentElement) n = n.parentElement;
      return n === doc.documentElement;
    }
    get nextElementSibling() {
      if (!this.parentElement) return null;
      const sibs = this.parentElement.children;
      return sibs[sibs.indexOf(this) + 1] || null;
    }
    setAttribute(k, v) {
      if (k === "style") this.style.cssText = v;
      else this._attrs.set(k, String(v));
      this._changed(k);
    }
    getAttribute(k) {
      if (k === "style") return this.style.cssText;
      return this._attrs.has(k) ? this._attrs.get(k) : null;
    }
    hasAttribute(k) { return this._attrs.has(k); }
    removeAttribute(k) {
      if (this._attrs.delete(k)) this._changed(k);
    }
    appendChild(c) { return this.insertBefore(c, null); }
    insertBefore(c, ref) {
      if (c.parentElement) c.parentElement.removeChild(c);
      const i = ref ? this.children.indexOf(ref) : -1;
      if (i < 0) this.children.push(c);
      else this.children.splice(i, 0, c);
      c.parentElement = this;
      notify({ type: "childList", target: this });
      return c;
    }
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      c.parentElement = null;
      notify({ type: "childList", target: this });
      return c;
    }
    remove() {
      if (this.parentElement) this.parentElement.removeChild(this);
    }
    contains(n) {
      for (; n; n = n.parentElement) if (n === this) return true;
      return false;
    }
    matches(sel) { return parse(sel).some((c) => matchesOne(this, c)); }
    closest(sel) {
      for (let n = this; n; n = n.parentElement) if (n.matches(sel)) return n;
      return null;
    }
    querySelectorAll(sel) {
      const cs = parse(sel);
      const out = [];
      (function walk(n) {
        for (const c of n.children) {
          if (cs.some((x) => matchesOne(c, x))) out.push(c);
          walk(c);
        }
      })(this);
      return out;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    addEventListener(type, fn, capture) { this._listeners.push({ type, fn, capture: !!capture }); }
    removeEventListener(type, fn, capture) {
      this._listeners = this._listeners.filter((l) => !(l.type === type && l.fn === fn && l.capture === !!capture));
    }
    dispatchEvent(ev) { return dispatch(this, ev); }
    click() { return dispatch(this, { type: "click" }); }
    focus() { doc.activeElement = this; }
  }

  // Capture on the document first, then bubble from the target up.
  function dispatch(target, init) {
    let stopped = false;
    const ev = Object.assign({}, init, {
      target,
      defaultPrevented: false,
      preventDefault() { ev.defaultPrevented = true; },
      stopPropagation() { stopped = true; }
    });
    const fire = (node, capture) => {
      node._listeners
        .filter((l) => l.type === ev.type && l.capture === capture)
        .forEach((l) => l.fn.call(node, ev));
    };
    fire(doc, true);
    for (let n = target; n && !stopped; n = n.parentElement) fire(n, false);
    if (!stopped) fire(doc, false);
    return !ev.defaultPrevented;
  }

  const doc = {
    _listeners: [],
    activeElement: null,
    createElement: (tag) => new Element(tag),
    createElementNS: (ns, tag) => new Element(tag),
    getElementById: (id) => doc.documentElement.querySelector("#" + id),
    querySelector: (sel) => doc.documentElement.querySelector(sel),
    querySelectorAll: (sel) => doc.documentElement.querySelectorAll(sel),
    addEventListener: Element.prototype.addEventListener,
    removeEventListener: Element.prototype.removeEventListener,
    dispatchEvent: (ev) => dispatch(doc.activeElement || doc.body, ev)
  };
  doc.documentElement = new Element("html");
  doc.head = doc.documentElement.appendChild(new Element("head"));
  doc.body = doc.documentElement.appendChild(new Element("body"));

  // Build a tree from [tag, attrs, ...children] arrays.
  doc.build = function build(spec) {
    const [tag, attrs, ...kids] = spec;
    const el = new Element(tag);
    for (const k in attrs || {}) el.setAttribute(k, attrs[k]);
    kids.forEach((k) => el.appendChild(build(k)));
    return el;
  };

  return { document: doc, MutationObserver };
}

// Let queued MutationObserver callbacks run.
function settle() {
  return new Promise((r) => setImmediate(r));
}

module.exports = { createDocument, settle };
