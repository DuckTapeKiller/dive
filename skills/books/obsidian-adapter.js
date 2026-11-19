"use strict";

// What Global Book Search's search code expects from Obsidian, provided in
// Node so the bundled copy (global-book-search.js, built by
// scripts/build-book-sources.mjs) runs inside Dive unchanged.
//
// The plugin talks to the network through Obsidian's `requestUrl` and reads
// pages with the browser's `DOMParser`. Here `requestUrl` is Node's fetch
// behind Dive's own SSRF guard, every redirect hop included, and `DOMParser`
// comes from linkedom. Anything else the plugin's modules import from
// "obsidian" (settings-tab classes and the like, which book search never
// calls) resolves to an inert stub.

const { DOMParser: LinkedomParser } = require("linkedom");
const {
  assertUrlAllowed,
  MAX_REDIRECTS,
  REQUEST_TIMEOUT_MS,
} = require("../sandbox.js");

let fetchImpl = (...args) => fetch(...args);
let locale = "en";
// Origins the user configured themselves (their Calibre content server, which
// normally runs on this machine). Those may be private addresses; nothing
// else may.
const trustedOrigins = new Set();

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

async function guard(url) {
  if (trustedOrigins.has(originOf(url))) return;
  const error = await assertUrlAllowed(url);
  if (error) throw new Error(error);
}

function headersObject(headers) {
  const out = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

// Obsidian's requestUrl: { url, method, headers, body, contentType, throw } in,
// { status, headers, text, json, arrayBuffer } out. Like Obsidian's, it throws
// on a status of 400 or more unless `throw: false` is passed.
async function requestUrl(param) {
  const req = typeof param === "string" ? { url: param } : param || {};
  const headers = { ...(req.headers || {}) };
  if (
    req.contentType &&
    !Object.keys(headers).some((k) => k.toLowerCase() === "content-type")
  ) {
    headers["Content-Type"] = req.contentType;
  }
  let method = String(req.method || "GET").toUpperCase();
  let body = req.body;
  let url = String(req.url || "");
  let response = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await guard(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS * 2);
    timer.unref?.();
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : body,
        redirect: "manual",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      url = new URL(location, url).toString();
      if (response.status === 303 || method === "POST") {
        method = "GET";
        body = undefined;
      }
      continue;
    }
    break;
  }
  if (response.status >= 300 && response.status < 400) {
    throw new Error("Too many redirects");
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const text = buffer.toString("utf8");
  const result = {
    status: response.status,
    headers: headersObject(response.headers),
    text,
    arrayBuffer: buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ),
    get json() {
      return JSON.parse(text);
    },
  };
  if (req.throw !== false && response.status >= 400) {
    throw Object.assign(
      new Error(`Request failed, status ${response.status}`),
      {
        status: response.status,
        headers: result.headers,
        text,
      },
    );
  }
  return result;
}

// A browser's DOMParser always builds <html><head><body>, whatever text it is
// given; linkedom leaves documentElement null for a fragment or for JSON, and
// the plugin's parsers then throw on document.body. Such text is wrapped the
// way a browser would treat it.
class DOMParser {
  parseFromString(text, type = "text/html") {
    const parser = new LinkedomParser();
    const source = String(text ?? "");
    const doc = parser.parseFromString(source, type);
    const root = doc.documentElement;
    if (
      type !== "text/html" ||
      String(root?.tagName).toUpperCase() === "HTML"
    ) {
      return doc;
    }
    return parser.parseFromString(
      `<!DOCTYPE html><html><head></head><body>${source}</body></html>`,
      type,
    );
  }
}

// Obsidian's on-screen notices. In a chat there is no screen to put them on;
// whatever they say reaches the model through the tool's own report.
class Notice {
  constructor(message) {
    this.message = String(message ?? "");
  }
  setMessage(message) {
    this.message = String(message ?? "");
    return this;
  }
  hide() {}
}

// The plugin asks moment only for the reader's locale.
function moment() {
  return { format: () => new Date().toISOString().slice(0, 10) };
}
moment.locale = () => locale;

const windowShim = {
  setTimeout: (...args) => setTimeout(...args),
  clearTimeout: (...args) => clearTimeout(...args),
  moment,
};

const api = {
  requestUrl,
  Notice,
  moment,
  normalizePath: (p) => String(p ?? "").replace(/\\/g, "/"),
  // Dive is not Obsidian, so no Obsidian version check can fail.
  requireApiVersion: () => true,
  setIcon: () => {},
};

const stubs = new Map();
// A Proxy so that any other name imported from "obsidian" exists. These names
// (PluginSettingTab, Modal, Setting…) belong to the plugin's interface, which
// Dive never builds; a class they can extend is all they need. `then` and
// `__esModule` stay undefined so the module is never mistaken for a promise or
// an ES module namespace.
const obsidian = new Proxy(api, {
  get(target, key) {
    if (key in target) return target[key];
    if (typeof key !== "string" || key === "then" || key === "__esModule") {
      return undefined;
    }
    if (!stubs.has(key)) stubs.set(key, class {});
    return stubs.get(key);
  },
});

module.exports = {
  obsidian,
  DOMParser,
  window: windowShim,
  // Test and wrapper hooks.
  setFetch(fn) {
    fetchImpl = typeof fn === "function" ? fn : (...args) => fetch(...args);
  },
  setLocale(value) {
    locale = String(value || "en");
  },
  trustOrigin(url) {
    trustedOrigins.clear();
    const origin = originOf(url);
    if (origin) trustedOrigins.add(origin);
  },
};
