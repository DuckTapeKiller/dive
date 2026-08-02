"use strict";

// Everything that answers a question from the web: the encyclopaedia and
// dictionary skills, web search across its providers, page fetching and text
// extraction, academic search, and book search.
//
// book_search lives here rather than in its own module because it is a web
// search consumer — it shares the fetch stack, the provider settings and the
// user-agent rotation with the research skills. Splitting it out would have
// created 25 cross-module edges for a single skill.
//
// All outbound requests go through skills/sandbox.js, which blocks local and
// private addresses.
//
// Moved out of skills.js unchanged.

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");
const zlib = require("zlib");
const cheerio = require("cheerio");
const { TextDecoder } = require("util");
const {
  MAX_REDIRECTS,
  REQUEST_TIMEOUT_MS,
  assertUrlAllowed,
  urlGuardError,
  resolveWorkspacePath,
} = require("./sandbox.js");

// Rotating browser User-Agents. Scrapers (DuckDuckGo, reader proxies) throttle
// a fixed UA quickly; varying it per request keeps keyless search working.
const WEB_UAS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
];

const pickWebUa = () => WEB_UAS[Math.floor(Math.random() * WEB_UAS.length)];

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, redirectsLeft = MAX_REDIRECTS) {
  const guardError = await assertUrlAllowed(url);
  if (guardError) throw new Error(guardError);
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(
      url,
      { headers: { "User-Agent": "Ollama-Pi-Chat/1.0" } },
      (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          if (redirectsLeft <= 0)
            return reject(new Error("Too many redirects"));
          const next = new URL(res.headers.location, url).toString();
          return fetchJson(next, redirectsLeft - 1)
            .then(resolve)
            .catch(reject);
        }
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            resolve(data);
          }
        });
      },
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy());
    req.on("error", reject);
  });
}

async function fetchText(url, redirectsLeft = MAX_REDIRECTS) {
  const guardError = await assertUrlAllowed(url);
  if (guardError) throw new Error(guardError);
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(
      url,
      { headers: { "User-Agent": "Mozilla/5.0" } },
      (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          if (redirectsLeft <= 0)
            return reject(new Error("Too many redirects"));
          const next = new URL(res.headers.location, url).toString();
          return fetchText(next, redirectsLeft - 1)
            .then(resolve)
            .catch(reject);
        }
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(data));
      },
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy());
    req.on("error", reject);
  });
}

// Browser-like fetch that transparently decompresses gzip/deflate/br, follows
// redirects, and supports POST. Used for real search-engine + reader endpoints
// that reject bare clients or always compress their responses.
async function fetchHtml(url, options = {}, redirectsLeft = MAX_REDIRECTS) {
  const guardError = await assertUrlAllowed(url);
  if (guardError) throw new Error(guardError);
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.request(
      url,
      {
        method: options.method || "GET",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Accept-Encoding": "gzip, deflate, br",
          ...(options.headers || {}),
        },
      },
      (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          if (redirectsLeft <= 0)
            return reject(new Error("Too many redirects"));
          const next = new URL(res.headers.location, url).toString();
          return fetchHtml(next, options, redirectsLeft - 1)
            .then(resolve)
            .catch(reject);
        }
        if (options.failOnHttpError && res.statusCode >= 400) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const enc = String(res.headers["content-encoding"] || "").toLowerCase();
        let stream = res;
        if (enc === "gzip") stream = res.pipe(zlib.createGunzip());
        else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
        else if (enc === "br") stream = res.pipe(zlib.createBrotliDecompress());
        const chunks = [];
        stream.on("data", (c) => chunks.push(c));
        stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        stream.on("error", reject);
      },
    );
    req.setTimeout(options.timeout || REQUEST_TIMEOUT_MS, () =>
      req.destroy(new Error("Request timed out")),
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// SSRF-guarded binary download (for PDFs etc.). Follows redirects manually,
// re-checking the guard on every hop — the built-in global fetch() cannot do
// this because it auto-follows redirects before we can inspect the target.
async function fetchBinaryGuarded(
  url,
  { timeout = 45000, redirectsLeft = MAX_REDIRECTS } = {},
) {
  const guardError = await assertUrlAllowed(url);
  if (guardError) throw new Error(guardError);
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(
      url,
      { headers: { "User-Agent": "Mozilla/5.0" } },
      (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          if (redirectsLeft <= 0)
            return reject(new Error("Too many redirects"));
          const next = new URL(res.headers.location, url).toString();
          return fetchBinaryGuarded(next, {
            timeout,
            redirectsLeft: redirectsLeft - 1,
          })
            .then(resolve)
            .catch(reject);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      },
    );
    req.setTimeout(timeout, () => req.destroy(new Error("Request timed out")));
    req.on("error", reject);
  });
}

// Decode DuckDuckGo's redirect wrapper (//duckduckgo.com/l/?uddg=<encoded>).
function decodeDdgHref(href) {
  if (!href) return "";
  try {
    let h = href.startsWith("//") ? "https:" + href : href;
    const u = new URL(h);
    const uddg = u.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : h;
  } catch {
    return href;
  }
}

// Wikipedia editions consulted (in order) when the requested language has no
// exact title match — some articles exist only in another edition (e.g. the
// poet Luis Carlos López is on es.wikipedia but not en.wikipedia, whose fuzzy
// search returns a different person entirely).
const WIKI_FALLBACK_LANGS = ["en", "es"];

// Accent- and case-insensitive comparison key, so "Luis Carlos Lopez"
// matches the article title "Luis Carlos López".
const wikiTitleKey = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

async function searchWikipedia(lang, query) {
  const searchUrl = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=5&format=json&origin=*`;
  const searchData = await fetchJson(searchUrl);
  return searchData?.query?.search || [];
}

async function executeWikipedia({ query, language = "en" }) {
  try {
    const primary =
      String(language || "en")
        .toLowerCase()
        .slice(0, 2) || "en";
    const chain = [...new Set([primary, ...WIKI_FALLBACK_LANGS])];
    const wanted = wikiTitleKey(query);
    const isExact = (r) => wikiTitleKey(r.title) === wanted;
    // An exact title match always beats a fuzzy top hit, wherever it ranks.
    const promoteExact = (arr) => {
      const i = arr.findIndex(isExact);
      return i > 0 ? [arr[i], ...arr.slice(0, i), ...arr.slice(i + 1)] : arr;
    };

    let lang = primary;
    let searchArr = promoteExact(await searchWikipedia(primary, query));
    // No exact match in the primary edition: consult the other editions and
    // prefer one that titles an article exactly as queried.
    if (!searchArr.some(isExact)) {
      for (const alt of chain.slice(1)) {
        try {
          const altArr = await searchWikipedia(alt, query);
          const exact = altArr.find(isExact);
          if (exact) {
            lang = alt;
            searchArr = promoteExact(altArr);
            break;
          }
          if (!searchArr.length && altArr.length) {
            lang = alt;
            searchArr = altArr;
          }
        } catch {
          /* edition unreachable — keep what we already have */
        }
      }
    }
    if (searchArr.length === 0)
      return `No Wikipedia results found for "${query}" (checked: ${chain.map((l) => `${l}.wikipedia.org`).join(", ")}).`;

    const wikiBase = `https://${lang}.wikipedia.org`;
    const pageTitle = searchArr[0].title;
    // Full plaintext article extract (intro + body), capped below — far more
    // substance than the one-paragraph REST summary. The API omits images
    // and tables, returning clean text.
    const extractUrl = `${wikiBase}/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&titles=${encodeURIComponent(pageTitle)}&format=json&origin=*`;
    const extractData = await fetchJson(extractUrl);
    const pages = extractData?.query?.pages || {};
    const firstPage = Object.values(pages)[0] || {};
    let text = String(firstPage.extract || "").trim();
    const MAX_CHARS = 7000;
    if (text.length > MAX_CHARS) {
      const cut = text.slice(0, MAX_CHARS);
      const breakAt = Math.max(
        cut.lastIndexOf("\n"),
        cut.lastIndexOf(". ") + 1,
      );
      text =
        cut.slice(0, breakAt > 200 ? breakAt : MAX_CHARS) +
        "\n\n[... article truncated ...]";
    }

    let output = `## Wikipedia${lang !== primary ? ` (${lang})` : ""}: ${pageTitle}\n\n`;
    if (lang !== primary) {
      output += `_No exact match on ${primary}.wikipedia.org; this article is from ${lang}.wikipedia.org._\n\n`;
    }
    if (text) {
      output += `${text}\n\n`;
    } else {
      // Fallback: the REST summary (some pages return empty extracts).
      const summaryUrl = `${wikiBase}/api/rest_v1/page/summary/${encodeURIComponent(pageTitle.replace(/ /g, "_"))}`;
      const summaryData = await fetchJson(summaryUrl);
      if (summaryData.extract) {
        output += `**Summary:** ${summaryData.extract}\n\n`;
      }
    }
    const others = searchArr
      .slice(1)
      .map((r) => r.title)
      .filter(Boolean);
    if (others.length) {
      output += `Other matching articles (re-query by exact title if needed): ${others.join(" | ")}\n`;
    }
    output += `\n<!-- ${wikiBase}/wiki/${encodeURIComponent(pageTitle.replace(/ /g, "_"))} -->`;
    return output;
  } catch (e) {
    return `Wikipedia Error: ${e.message}`;
  }
}

async function executeWiktionary({ word, language = "en" }) {
  try {
    const url = `https://${language}.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(word)}`;
    const data = await fetchJson(url);
    if (data.title === "Not found")
      return `No dictionary entry found for "${word}".`;

    let output = `## Definitions for "${word}"\n`;
    const langs = Object.keys(data);
    for (const lang of langs) {
      if (!Array.isArray(data[lang])) continue;
      output += `\n**Language: ${lang}**\n`;
      data[lang].forEach((part) => {
        output += `*Part of speech: ${part.partOfSpeech}*\n`;
        part.definitions.forEach((def) => {
          const text = (def.definition || "").replace(/<[^>]*>?/gm, "");
          output += `- ${text}\n`;
        });
      });
    }
    output += `\n<!-- https://${language}.wiktionary.org/wiki/${encodeURIComponent(word)} -->`;
    return output || `No clear definition found.`;
  } catch (e) {
    return `Wiktionary Error: ${e.message}`;
  }
}

// Parse a DuckDuckGo results page (html or lite endpoint) into a list of
// { title, url, snippet }. Ads and internal DDG links are skipped.
function parseDdgResults($, limit) {
  const results = [];
  // Modern html.duckduckgo.com layout.
  $(".result").each((_, el) => {
    if (results.length >= limit) return;
    const node = $(el);
    if (node.hasClass("result--ad") || node.hasClass("result--no-result"))
      return;
    const a = node.find("a.result__a").first();
    const title = a.text().replace(/\s+/g, " ").trim();
    const url = decodeDdgHref(a.attr("href"));
    const snippet = node
      .find(".result__snippet")
      .first()
      .text()
      .replace(/\s+/g, " ")
      .trim();
    if (title && /^https?:\/\//i.test(url) && !/duckduckgo\.com\//i.test(url)) {
      results.push({ title, url, snippet });
    }
  });
  // Fallback: lite.duckduckgo.com table layout.
  if (!results.length) {
    $("a.result-link").each((_, el) => {
      if (results.length >= limit) return;
      const a = $(el);
      const title = a.text().replace(/\s+/g, " ").trim();
      const url = decodeDdgHref(a.attr("href"));
      const snippet = a
        .closest("tr")
        .nextAll("tr")
        .find(".result-snippet")
        .first()
        .text()
        .replace(/\s+/g, " ")
        .trim();
      if (
        title &&
        /^https?:\/\//i.test(url) &&
        !/duckduckgo\.com\//i.test(url)
      ) {
        results.push({ title, url, snippet });
      }
    });
  }
  return results;
}

// DuckDuckGo HTML scrape (no key). Primary html endpoint + lite fallback.
async function searchDuckDuckGo(query, limit) {
  // DuckDuckGo's GET endpoints return an "anomaly" bot page, but the POST form
  // (the one the site itself submits) returns real results. Try POST on both
  // endpoints, rotating the UA, before giving up.
  const body = `q=${encodeURIComponent(query)}`;
  const attempts = [
    {
      url: "https://html.duckduckgo.com/html/",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    },
    {
      url: "https://lite.duckduckgo.com/lite/",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    },
  ];
  for (const attempt of attempts) {
    try {
      const html = await fetchHtml(attempt.url, {
        method: "POST",
        headers: { "User-Agent": pickWebUa(), ...attempt.headers },
        body,
      });
      const results = parseDdgResults(cheerio.load(html), limit);
      if (results.length) return results;
    } catch {
      /* try the next endpoint */
    }
    await sleepMs(250);
  }
  return [];
}

// Keyless last-resort: turn a query into source URLs via the Wikipedia search
// API (always available, no key). Not a general web search, but it guarantees
// the research skills get relevant, citable sources when scraping is blocked.
async function searchWikipediaFallback(query, limit) {
  try {
    const data = await fetchJson(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
        query,
      )}&srlimit=${Math.max(1, Math.min(limit, 10))}&format=json&origin=*`,
    );
    const hits = data?.query?.search || [];
    return hits.map((h) => ({
      title: h.title,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(
        String(h.title).replace(/ /g, "_"),
      )}`,
      snippet: String(h.snippet || "").replace(/<[^>]+>/g, ""),
    }));
  } catch {
    return [];
  }
}

// OpenAI web search (chat completions + web_search_options). Result URLs come
// from the message annotations (url_citation).
async function searchOpenAI(query, limit, apiKey) {
  const res = await fetchHtml("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini-search-preview",
      web_search_options: {},
      messages: [
        {
          role: "user",
          content: `Search the web for: ${query}. List the most relevant sources.`,
        },
      ],
    }),
    timeout: 30000,
  });
  const data = JSON.parse(res);
  const msg = data.choices?.[0]?.message || {};
  const annotations = Array.isArray(msg.annotations) ? msg.annotations : [];
  const out = [];
  const seen = new Set();
  for (const a of annotations) {
    const c = a?.url_citation || a;
    const url = String(c?.url || "").trim();
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({ title: String(c?.title || url).trim(), url, snippet: "" });
    if (out.length >= limit) break;
  }
  return out;
}

// Anthropic web search tool. Result URLs come from web_search_tool_result blocks.
async function searchAnthropic(query, limit, apiKey) {
  const res = await fetchHtml("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-3-5-haiku-latest",
      max_tokens: 1024,
      messages: [{ role: "user", content: `Search the web for: ${query}` }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
    }),
    timeout: 30000,
  });
  const data = JSON.parse(res);
  const blocks = Array.isArray(data.content) ? data.content : [];
  const out = [];
  const seen = new Set();
  for (const b of blocks) {
    const items =
      b?.type === "web_search_tool_result" && Array.isArray(b.content)
        ? b.content
        : [];
    for (const it of items) {
      const url = String(it?.url || "").trim();
      if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
      seen.add(url);
      out.push({ title: String(it?.title || url).trim(), url, snippet: "" });
      if (out.length >= limit) break;
    }
  }
  return out;
}

// Google Gemini search grounding. Result URLs come from groundingChunks.
async function searchGemini(query, limit, apiKey) {
  const res = await fetchHtml(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `Search the web for: ${query}` }] }],
        tools: [{ google_search: {} }],
      }),
      timeout: 30000,
    },
  );
  const data = JSON.parse(res);
  const chunks = data.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const out = [];
  const seen = new Set();
  for (const ch of chunks) {
    const url = String(ch?.web?.uri || "").trim();
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({ title: String(ch?.web?.title || url).trim(), url, snippet: "" });
    if (out.length >= limit) break;
  }
  return out;
}

// Dedicated search APIs configured in ~/dive/web-search-settings.json.
// All optional: they only run when the user has saved a key/URL there.
const WEB_SEARCH_SETTINGS_FILE = path.join(
  os.homedir(),
  "dive",
  "web-search-settings.json",
);

let webSearchSettingsCache = { at: 0, value: {} };

function loadWebSearchSettings() {
  if (Date.now() - webSearchSettingsCache.at < 30000) {
    return webSearchSettingsCache.value;
  }
  let value = {};
  try {
    value = JSON.parse(fs.readFileSync(WEB_SEARCH_SETTINGS_FILE, "utf8"));
  } catch {
    /* absent or invalid — providers simply stay dormant */
  }
  webSearchSettingsCache = { at: Date.now(), value };
  return value;
}

async function searchTavily(query, limit, apiKey) {
  const res = await fetchHtml("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query, max_results: limit }),
    timeout: 20000,
  });
  const data = JSON.parse(res);
  return (data.results || [])
    .filter((r) => /^https?:\/\//i.test(String(r.url || "")))
    .slice(0, limit)
    .map((r) => ({
      title: String(r.title || r.url).trim(),
      url: String(r.url).trim(),
      snippet: String(r.content || "").slice(0, 300),
    }));
}

async function searchBrave(query, limit, apiKey) {
  const res = await fetchHtml(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`,
    {
      headers: { Accept: "application/json", "X-Subscription-Token": apiKey },
      timeout: 20000,
    },
  );
  const data = JSON.parse(res);
  return (data.web?.results || [])
    .filter((r) => /^https?:\/\//i.test(String(r.url || "")))
    .slice(0, limit)
    .map((r) => ({
      title: String(r.title || r.url).trim(),
      url: String(r.url).trim(),
      snippet: String(r.description || "")
        .replace(/<[^>]+>/g, "")
        .slice(0, 300),
    }));
}

async function searchSearxng(query, limit, baseUrl) {
  const base = String(baseUrl).replace(/\/+$/, "");
  const res = await fetchHtml(
    `${base}/search?q=${encodeURIComponent(query)}&format=json`,
    { timeout: 20000 },
  );
  const data = JSON.parse(res);
  return (data.results || [])
    .filter((r) => /^https?:\/\//i.test(String(r.url || "")))
    .slice(0, limit)
    .map((r) => ({
      title: String(r.title || r.url).trim(),
      url: String(r.url).trim(),
      snippet: String(r.content || "").slice(0, 300),
    }));
}

// Run the best available backend: a dedicated search API if configured in
// web-search-settings.json (Tavily, Brave, SearXNG), then whichever cloud key
// the user has saved (OpenAI, then Anthropic, then Google), else keyless
// DuckDuckGo.
async function runWebSearch(query, limit, cloudKeys = {}) {
  const settings = loadWebSearchSettings();
  const wanted = String(settings.provider || "auto").toLowerCase();
  const dedicated = [
    ["tavily", settings.tavilyKey, searchTavily],
    ["brave", settings.braveKey, searchBrave],
    ["searxng", settings.searxngUrl, searchSearxng],
  ];
  for (const [name, credential, fn] of dedicated) {
    if (!credential || !String(credential).trim()) continue;
    if (wanted !== "auto" && wanted !== name) continue;
    try {
      const results = await fn(query, limit, String(credential).trim());
      if (results && results.length) return { provider: name, results };
    } catch {
      /* try the next backend */
    }
  }
  const providers = [
    ["openai", cloudKeys.openai, searchOpenAI],
    ["anthropic", cloudKeys.anthropic, searchAnthropic],
    ["google", cloudKeys.google, searchGemini],
  ];
  for (const [name, key, fn] of providers) {
    if (!key) continue;
    try {
      const results = await fn(query, limit, key);
      if (results && results.length) return { provider: name, results };
    } catch {
      /* try the next backend */
    }
  }
  const results = await searchDuckDuckGo(query, limit);
  if (results.length) return { provider: "duckduckgo", results };
  // Everything above is blocked/keyless-unavailable: return citable Wikipedia
  // sources so the research skills still have something to read.
  const wiki = await searchWikipediaFallback(query, limit);
  return { provider: wiki.length ? "wikipedia" : "duckduckgo", results: wiki };
}

async function executeDuckDuckGo({ query, max_results = 6 }, context = {}) {
  const limit = Math.max(1, Math.min(Number(max_results) || 6, 10));
  const cloudKeys = (context && context.cloudKeys) || {};
  try {
    // 1) Best available backend (saved cloud key, else DuckDuckGo).
    const { provider, results } = await runWebSearch(query, limit, cloudKeys);

    // 2) Best-effort instant answer (definitions / entities) as a header.
    let instant = "";
    try {
      const data = await fetchJson(
        `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
      );
      if (data && typeof data === "object") {
        const ans = (data.Abstract || data.Answer || data.Definition || "")
          .toString()
          .trim();
        if (ans) {
          instant = `**Instant answer:** ${ans}`;
          if (data.AbstractURL) instant += ` (${data.AbstractURL})`;
          instant += "\n\n";
        }
      }
    } catch {
      /* instant answer is optional */
    }

    if (!results.length) {
      return (
        instant +
        `No web results found for "${query}". Try different or more specific keywords.`
      ).trim();
    }

    let output = `## Web search results for "${query}" (via ${provider})\n\n${instant}`;
    results.forEach((r, i) => {
      output += `${i + 1}. ${r.title}\n   ${r.snippet || "(no snippet)"}\n   URL: ${r.url}\n\n`;
    });
    output +=
      "Next step: choose the single most relevant URL above and call the " +
      "web_scraper skill with it to read the full page, then answer. Do NOT " +
      "run this same search again.";
    return output.trim();
  } catch (e) {
    return `Web Search Error: ${e.message}`;
  }
}

// Britannica bot-blocks direct scraping (403 with TLS fingerprinting on both
// the search page and article pages), so the skill finds the article through
// web search restricted to britannica.com and reads it through the same
// reader pipeline the web_scraper skill uses, archive-first (Wayback Machine
// snapshot, then Jina Reader, then a direct fetch).
function cleanBritannicaMarkdown(markdown) {
  const lines = String(markdown || "").split("\n");
  const kept = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^\[?!\[/.test(line)) continue; // images
    if (/^\[[^\]]*\]\([^)]*\)$/.test(line)) continue; // link-only lines
    if (/^(Title:|URL Source:|Published Time:|Markdown Content:)/.test(line)) {
      continue;
    }
    if (
      /Search Britannica|Click here to search|Subscribe|Login|Ask the Chatbot|Games & Quizzes|References & Edit History|Quick Facts|ProCon|verify using Britannica articles|editors will review|Select Citation Style|citation style rules/i.test(
        line,
      )
    ) {
      continue;
    }
    const linkStripped = line.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
    const wordCount = linkStripped.split(/\s+/).filter(Boolean).length;
    if (wordCount < 8 && !/^#/.test(linkStripped)) continue; // nav crumbs
    kept.push(linkStripped);
    if (kept.length >= 18) break;
  }
  return kept.join("\n\n");
}

async function executeBritannica({ query }, context = {}) {
  try {
    const cloudKeys = (context && context.cloudKeys) || {};
    const ARTICLE_URL_RE =
      /https:\/\/www\.britannica\.com\/(?:biography|topic|place|science|art|event|animal|plant|technology|sports|story|summary)\/[A-Za-z0-9%_-]+/g;
    // Article finders, cheapest and most reliable first. Each returns a list
    // of candidate URLs; every candidate is verified by actually reading it,
    // because any single finder can lie (Wikidata IDs get vandalized, search
    // engines rate-limit, Britannica's own search page bot-blocks).
    const finders = [
      // 1) Wikidata stores each entity's Britannica article ID (P1417), so
      // the URL resolves without touching Britannica or any rate-limited
      // search engine.
      async () => {
        const found = await fetchJson(
          `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(query)}&language=en&format=json&limit=5`,
        );
        const urls = [];
        for (const hit of ((found && found.search) || []).slice(0, 5)) {
          if (urls.length >= 2) break;
          const claims = await fetchJson(
            `https://www.wikidata.org/w/api.php?action=wbgetclaims&entity=${encodeURIComponent(hit.id)}&property=P1417&format=json`,
          );
          const id = claims?.claims?.P1417?.[0]?.mainsnak?.datavalue?.value;
          if (
            typeof id === "string" &&
            /^[a-z-]+(?:\/[A-Za-z0-9%_.-]+)+$/i.test(id)
          ) {
            urls.push(`https://www.britannica.com/${id}`);
          }
        }
        return urls;
      },
      // 2) Slug probe: Britannica article URLs are /<category>/<slug>; the
      // Wayback availability API canonicalizes case, so one probe per
      // category finds an exact-title article even when Wikidata has no
      // mapping and every search engine is blocked or rate-limited.
      async () => {
        const slug = query.trim().replace(/\s+/g, "-");
        if (!/^[A-Za-z0-9-]{2,80}$/.test(slug)) return [];
        const categories = [
          "biography",
          "topic",
          "science",
          "place",
          "art",
          "event",
          "animal",
          "plant",
          "technology",
          "sports",
          "story",
        ];
        const probes = await Promise.allSettled(
          categories.map((cat) =>
            fetchJson(
              `http://archive.org/wayback/available?url=${encodeURIComponent(`https://www.britannica.com/${cat}/${slug}`)}`,
            ),
          ),
        );
        const urls = [];
        for (const p of probes) {
          const snap =
            p.status === "fulfilled" && p.value?.archived_snapshots?.closest;
          if (snap && snap.available && snap.url) {
            // The snapshot URL ends with the canonical Britannica URL,
            // correct casing included.
            const m = String(snap.url).match(
              /https?:\/\/www\.britannica\.com\/.+$/,
            );
            if (m) urls.push(m[0].replace(/^http:/, "https:"));
          }
        }
        return urls.slice(0, 2);
      },
      // 3) Britannica's own search page through the reader pipeline —
      // results are relevance-ranked by Britannica itself.
      async () => {
        const searchPage = await readUrlContent(
          `https://www.britannica.com/search?query=${encodeURIComponent(query)}`,
          20000,
        );
        if (!searchPage.ok) return [];
        const links = searchPage.text.match(ARTICLE_URL_RE) || [];
        const words = query.toLowerCase().split(/\s+/).filter(Boolean);
        const slugOf = (link) =>
          link.toLowerCase().split("/").pop().replace(/%20/g, "-");
        // Preference order: exact slug match for the query ("Robert Graves"
        // -> /Robert-Graves), then the shortest slug containing every query
        // word, then Britannica's own first result.
        const exact = links.find((l) => slugOf(l) === words.join("-"));
        const containing = links
          .filter((l) => words.every((w) => slugOf(l).includes(w)))
          .sort((a, b) => slugOf(a).length - slugOf(b).length);
        return [exact, containing[0], links[0]].filter(Boolean);
      },
      // 4) Web search restricted to britannica.com.
      async () => {
        let { results } = await runWebSearch(
          `site:britannica.com ${query}`,
          6,
          cloudKeys,
        );
        if (!results || !results.length) {
          const retry = await runWebSearch(`${query} britannica`, 8, cloudKeys);
          results = (retry.results || []).filter((r) =>
            /britannica\.com\//i.test(r.url || ""),
          );
        }
        const article = (results || []).find((r) =>
          ARTICLE_URL_RE.test(String(r.url || "")),
        );
        return article ? [article.url.split("#")[0].split("?")[0]] : [];
      },
    ];
    // Britannica hard-blocks every live reader (Cloudflare challenge on
    // direct fetches, recurring abuse-blocks on Jina), so read each candidate
    // archive-first: Wayback snapshot, then the Jina→direct chain. Stop at
    // the first candidate that yields real article text; cap the attempts so
    // a run of bad candidates can't stall the skill.
    let articleUrl = "";
    const tried = new Set();
    for (const finder of finders) {
      if (tried.size >= 4) break;
      let candidates = [];
      try {
        candidates = await finder();
      } catch {
        continue; // finder unavailable — try the next one
      }
      for (const url of candidates) {
        if (tried.has(url) || tried.size >= 4) continue;
        tried.add(url);
        if (!articleUrl) articleUrl = url;
        const read = await readUrlContent(url, 6000, { archiveFirst: true });
        if (read.ok) {
          const text = cleanBritannicaMarkdown(read.text);
          if (text.length > 120) {
            return `## Britannica: "${query}"\n\n${text}\n\n<!-- ${url} -->`;
          }
        }
      }
    }
    // Britannica actively blocks scraping and every reader can be down at once.
    // Rather than fail, fall back to Wikipedia so the user still gets a
    // sourced encyclopedic answer — clearly labelled so the source is honest.
    const wiki = await executeWikipedia({ query });
    if (
      typeof wiki === "string" &&
      !/^No Wikipedia|Wikipedia Error/.test(wiki)
    ) {
      const note = articleUrl
        ? `Britannica's article (${articleUrl}) could not be read right now (it blocks scraping), so this answer is from Wikipedia instead:`
        : `No Britannica article was reachable for "${query}", so this answer is from Wikipedia instead:`;
      return `${note}\n\n${wiki}`;
    }
    return articleUrl
      ? `Britannica article found but its content could not be read (Britannica blocks scraping and all readers were unavailable): ${articleUrl}`
      : `No Britannica article found for "${query}".`;
  } catch (e) {
    return `Britannica Error: ${e.message}`;
  }
}

async function executeFactCheck({ claim, language = "en" }, context = {}) {
  const wiki = await executeWikipedia({ query: claim, language });
  const brit = await executeBritannica({ query: claim }, context);
  const ddg = await executeDuckDuckGo({ query: claim }, context);
  return `### Wikipedia findings:\n${wiki}\n\n### Britannica findings:\n${brit}\n\n### Web search findings:\n${ddg}`;
}

// Read a URL's main content as clean text. SSRF-guarded. Tries Jina Reader for
// LLM-ready markdown, then a direct fetch + boilerplate strip. Returns
// { ok, text } or { ok:false, error }. Shared by web_scraper and deep_research.
function truncateText(text, maxChars, marker) {
  return text.length > maxChars ? text.slice(0, maxChars) + marker : text;
}

// Bot walls (Cloudflare et al.) can serve an interstitial challenge page with
// a 2xx status; its extracted text must never be mistaken for article content.
const CHALLENGE_PAGE_RE =
  /just a moment|enable javascript and cookies|verifying you are human|attention required|checking your browser/i;

function extractMainText(html) {
  const $ = cheerio.load(html);
  $("script, style, noscript, nav, header, footer, aside, form, svg").remove();
  const container = $("article").first().length
    ? $("article").first()
    : $("main").first().length
      ? $("main").first()
      : $("body");
  // Keep block boundaries as newlines — downstream line-based cleaners (e.g.
  // cleanBritannicaMarkdown) drop nav-crumb lines, so collapsing a whole page
  // into one line would let a single junk phrase discard the entire article.
  const blocks = container
    .find("p, h1, h2, h3, h4")
    .map((_, el) => $(el).text().replace(/\s+/g, " ").trim())
    .get()
    .filter(Boolean);
  const blockText = blocks.join("\n");
  if (blockText.length > 150) return blockText;
  return container.text().replace(/\s+/g, " ").trim();
}

// Wayback Machine snapshot reader (retry on 429 with backoff). Reliable for
// sites that hard-block live scraping, e.g. Britannica. Returns { ok, text }
// or null when no usable snapshot exists.
async function readViaWayback(url, maxChars) {
  const candidates = [];
  try {
    const wb = await fetchJson(
      `http://archive.org/wayback/available?url=${encodeURIComponent(url)}`,
    );
    const snap = wb?.archived_snapshots?.closest;
    if (snap?.available && snap.url) candidates.push(snap.url);
  } catch {
    /* availability API is optional */
  }
  // The /web/2/ form redirects to the newest snapshot, so it works even when
  // the availability API is down or lagging.
  candidates.push(`https://web.archive.org/web/2/${url}`);
  for (const snapUrl of candidates) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const html = await fetchHtml(snapUrl, {
          headers: { "User-Agent": pickWebUa() },
          timeout: 20000,
          failOnHttpError: true,
        });
        const text = extractMainText(html);
        if (text.length > 150 && !CHALLENGE_PAGE_RE.test(text.slice(0, 400))) {
          return {
            ok: true,
            text: truncateText(text, maxChars, "... [TRUNCATED]"),
          };
        }
        break; // fetched fine but no usable text — try the next candidate
      } catch (e) {
        // Retry once only on rate-limiting or a timeout; a 404 (URL never
        // archived) won't improve on retry, so move on immediately.
        if (attempt === 0 && /429|timed out/i.test(String(e?.message))) {
          await sleepMs(1200);
          continue;
        }
        break;
      }
    }
  }
  return null;
}

async function readUrlContent(
  url,
  maxChars = 6000,
  { archiveFirst = false } = {},
) {
  const guardError = urlGuardError(url);
  if (guardError) return { ok: false, error: guardError };
  // For domains known to hard-block every live reader (pass archiveFirst),
  // the Wayback snapshot is the most reliable source — try it before burning
  // ~40s on doomed Jina retries and a direct fetch.
  if (archiveFirst) {
    const archived = await readViaWayback(url, maxChars);
    if (archived) return archived;
  }
  // 1) Jina Reader (clean markdown, no key). Retry once — it rate-limits
  // ("AbuseAlleviationError") under bursts but usually recovers after a pause.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const md = await fetchHtml(`https://r.jina.ai/${url}`, {
        headers: { "X-Return-Format": "markdown", "User-Agent": pickWebUa() },
        timeout: 20000,
      });
      const clean = (md || "").trim();
      const looksValid =
        clean.length > 200 &&
        !clean.startsWith("{") &&
        !/^(error|failed)\b/i.test(clean);
      if (looksValid) {
        return {
          ok: true,
          text: truncateText(clean, maxChars, "\n\n... [TRUNCATED]"),
        };
      }
    } catch {
      /* fall through to retry / next strategy */
    }
    if (attempt === 0) await sleepMs(600);
  }
  // 2) Direct fetch + main-content extraction (rotating UA). Must fail on
  // HTTP errors and challenge pages, or a bot wall's block page would count
  // as success and mask the Wayback strategy below.
  try {
    const html = await fetchHtml(url, {
      headers: { "User-Agent": pickWebUa() },
      failOnHttpError: true,
    });
    const text = extractMainText(html);
    if (text.length > 150 && !CHALLENGE_PAGE_RE.test(text.slice(0, 400))) {
      return {
        ok: true,
        text: truncateText(text, maxChars, "... [TRUNCATED]"),
      };
    }
  } catch {
    /* fall through to the Wayback strategy */
  }
  // 3) Wayback Machine snapshot (unless it was already tried first).
  if (!archiveFirst) {
    const archived = await readViaWayback(url, maxChars);
    if (archived) return archived;
  }
  return {
    ok: false,
    error: "All readers failed (live block + proxy/archive unavailable).",
  };
}

async function executeWebScraper({ url }) {
  const r = await readUrlContent(url, 6000);
  return r.ok ? r.text : `Web Scraper Error: ${r.error}`;
}

// One-shot, multi-angle, multi-source research (no API keys). Searches the web
// across every angle the model provides (or a single query), merges and
// de-duplicates results, reads several independent (distinct-domain) pages in
// parallel, and returns a consolidated digest so the model can synthesize a
// thorough answer without chaining many calls. Every source URL becomes a pill.
async function executeDeepResearch(
  { query, queries, max_sources = 6, academic = false },
  context = {},
) {
  // Accept a single query or several varied angles (preferred for coverage).
  const angles = [];
  if (Array.isArray(queries)) {
    for (const q of queries) {
      if (typeof q === "string" && q.trim()) angles.push(q.trim());
    }
  }
  if (typeof query === "string" && query.trim()) angles.unshift(query.trim());
  const uniqAngles = [...new Set(angles)].slice(0, 4);
  if (!uniqAngles.length) return "Deep Research Error: no query provided.";

  const target = Math.max(4, Math.min(Number(max_sources) || 6, 8));
  const cloudKeys = (context && context.cloudKeys) || {};
  const domainOf = (u) => {
    try {
      return new URL(u).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  };
  try {
    // Search each angle and merge results, de-duplicating by URL. Space the
    // requests slightly so DuckDuckGo does not rate-limit the burst.
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const merged = [];
    const seenUrls = new Set();
    // Academic mode: seed the pool with scholarly results (OpenAlex, Crossref,
    // arXiv, Semantic Scholar, PubMed) so peer-reviewed sources are read
    // alongside the general web.
    if (academic) {
      try {
        const papers = await runAcademicSearch(uniqAngles[0], 6, {});
        for (const p of papers) {
          const url = p.landingUrl || p.pdfUrl;
          if (url && !seenUrls.has(url)) {
            seenUrls.add(url);
            merged.push({ title: p.title, url, snippet: p.abstract || "" });
          }
        }
      } catch {
        /* scholarly seeding is best-effort */
      }
    }
    for (let i = 0; i < uniqAngles.length; i += 1) {
      if (i > 0) await sleep(400);
      const { results } = await runWebSearch(uniqAngles[i], 8, cloudKeys);
      for (const r of results) {
        if (r.url && !seenUrls.has(r.url)) {
          seenUrls.add(r.url);
          merged.push(r);
        }
      }
    }
    // Academic mode prefers authoritative domains when picking what to read.
    if (academic) {
      const scholarly =
        /(\.edu|\.gov|\.ac\.[a-z]{2}|arxiv\.org|doi\.org|nature\.com|science\.org|sciencedirect\.com|springer\.com|wiley\.com|jstor\.org|pubmed|ncbi\.nlm\.nih\.gov|semanticscholar\.org|openalex\.org|plos\.org|frontiersin\.org|oup\.com|cambridge\.org|tandfonline\.com)/i;
      merged.sort(
        (a, b) =>
          (scholarly.test(b.url) ? 1 : 0) - (scholarly.test(a.url) ? 1 : 0),
      );
    }
    if (!merged.length) {
      // Web search unavailable (rate-limited/blocked/offline): fall back to
      // encyclopedias AUTOMATICALLY so the model never sees a bare "no
      // results" it could loop on. The topic is the first (primary) angle.
      const topic = uniqAngles[0];
      const [wiki, brit] = await Promise.all([
        executeWikipedia({ query: topic }),
        executeBritannica({ query: topic }),
      ]);
      return (
        `## Deep research: "${topic}" (web search unavailable — encyclopedia fallback)\n\n` +
        `Live web search returned nothing (it may be temporarily rate-limited), ` +
        `so the following encyclopedia results were retrieved instead. Answer ` +
        `the user's question from them. Do NOT call deep_research again for ` +
        `this topic.\n\n### Wikipedia\n\n${wiki}\n\n### Britannica\n\n${brit}`
      );
    }
    // Prefer breadth: one result per distinct domain first, then top up.
    const picked = [];
    const seenDomains = new Set();
    for (const r of merged) {
      const d = domainOf(r.url);
      if (!d || seenDomains.has(d)) continue;
      seenDomains.add(d);
      picked.push(r);
      if (picked.length >= target) break;
    }
    for (const r of merged) {
      if (picked.length >= target) break;
      if (!picked.includes(r)) picked.push(r);
    }
    // Read all chosen pages concurrently, with generous per-source content
    // and a larger budget for the top-ranked three.
    const reads = await Promise.all(
      picked.map(async (r, i) => {
        const c = await readUrlContent(r.url, i < 3 ? 7000 : 4500);
        return {
          title: r.title,
          url: r.url,
          content: c.ok ? c.text : `(could not read this page: ${c.error})`,
        };
      }),
    );
    let out = `## Deep research — ${uniqAngles
      .map((a) => `"${a}"`)
      .join(", ")} (${reads.length} sources)\n\n`;
    reads.forEach((r, i) => {
      out += `${i + 1}. ${r.title}\n   URL: ${r.url}\n\n${r.content}\n\n---\n\n`;
    });
    out +=
      `You now have ${reads.length} independent sources above. Write a ` +
      `COMPREHENSIVE, well-structured answer for the user that synthesizes ` +
      `ALL of them — several detailed paragraphs, NOT a three-line summary. ` +
      `Cover background, key facts, context, and significance; integrate ` +
      `information across sources, prefer facts confirmed by more than one, ` +
      `and note any disagreements. Do NOT write source links or a references ` +
      `section (the app shows sources as pills). Do not call this skill again ` +
      `for the same topic.`;
    return out.trim();
  } catch (e) {
    return `Deep Research Error: ${e.message}`;
  }
}

// OpenAlex ships abstracts as an inverted index ({word: [positions]}) to
// dodge publisher restrictions; rebuild the plain text from the positions.
function reconstructOpenAlexAbstract(invertedIndex) {
  if (!invertedIndex || typeof invertedIndex !== "object") return "";
  const words = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    if (!Array.isArray(positions)) continue;
    for (const pos of positions) {
      if (Number.isInteger(pos) && pos >= 0 && pos < 10000) words[pos] = word;
    }
  }
  return words.filter(Boolean).join(" ").trim();
}

function normalizeDoi(raw) {
  const value = String(raw || "")
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .replace(/^doi:/i, "")
    .toLowerCase();
  return /^10\.\S+\/\S+/.test(value) ? value : "";
}

function normalizeTitleKey(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .slice(0, 120);
}

function formatAuthorList(names, max = 6) {
  const list = (names || []).filter(Boolean);
  if (!list.length) return "Unknown authors";
  if (list.length <= max) return list.join(", ");
  return `${list.slice(0, max).join(", ")} et al.`;
}

function stripJatsXml(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function searchOpenAlexWorks(query, limit, yearFrom, yearTo) {
  const filters = [];
  if (yearFrom) filters.push(`from_publication_date:${yearFrom}-01-01`);
  if (yearTo) filters.push(`to_publication_date:${yearTo}-12-31`);
  const filterPart = filters.length
    ? `&filter=${encodeURIComponent(filters.join(","))}`
    : "";
  const data = await fetchJson(
    `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=${limit}${filterPart}`,
  );
  return (data.results || []).map((w) => ({
    provider: "openalex",
    title: String(w.display_name || "").trim(),
    authors: (w.authorships || []).map((a) => a.author?.display_name || ""),
    year: w.publication_year || undefined,
    venue: w.primary_location?.source?.display_name || "",
    doi: normalizeDoi(w.doi),
    citations: Number(w.cited_by_count) || 0,
    abstract: reconstructOpenAlexAbstract(w.abstract_inverted_index),
    pdfUrl: w.best_oa_location?.pdf_url || w.open_access?.oa_url || "",
    landingUrl:
      w.primary_location?.landing_page_url ||
      (w.doi ? String(w.doi) : "") ||
      String(w.id || ""),
  }));
}

async function searchCrossrefWorks(query, limit, yearFrom, yearTo) {
  const filters = [];
  if (yearFrom) filters.push(`from-pub-date:${yearFrom}-01-01`);
  if (yearTo) filters.push(`until-pub-date:${yearTo}-12-31`);
  const filterPart = filters.length ? `&filter=${filters.join(",")}` : "";
  const data = await fetchJson(
    `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${limit}${filterPart}`,
  );
  return (data.message?.items || []).map((w) => ({
    provider: "crossref",
    title: String((w.title && w.title[0]) || "").trim(),
    authors: (w.author || []).map((a) =>
      [a.given, a.family].filter(Boolean).join(" "),
    ),
    year: w.issued?.["date-parts"]?.[0]?.[0] || undefined,
    venue: (w["container-title"] && w["container-title"][0]) || "",
    doi: normalizeDoi(w.DOI),
    citations: Number(w["is-referenced-by-count"]) || 0,
    abstract: stripJatsXml(w.abstract),
    pdfUrl: "",
    landingUrl: w.URL || (w.DOI ? `https://doi.org/${w.DOI}` : ""),
  }));
}

async function searchArxivWorks(query, limit) {
  const xml = await fetchHtml(
    `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&max_results=${limit}`,
    { timeout: 20000 },
  );
  const $ = cheerio.load(xml, { xmlMode: true });
  const out = [];
  $("entry").each((_, el) => {
    const entry = $(el);
    const absUrl = entry.find("id").first().text().trim();
    const published = entry.find("published").first().text().trim();
    out.push({
      provider: "arxiv",
      title: entry.find("title").first().text().replace(/\s+/g, " ").trim(),
      authors: entry
        .find("author > name")
        .map((_i, n) => $(n).text().trim())
        .get(),
      year: published ? Number(published.slice(0, 4)) : undefined,
      venue: "arXiv",
      // The Atom feed namespaces the element as <arxiv:doi>.
      doi: normalizeDoi(entry.find("doi, arxiv\\:doi").first().text()),
      citations: 0,
      abstract: entry
        .find("summary")
        .first()
        .text()
        .replace(/\s+/g, " ")
        .trim(),
      pdfUrl: absUrl.replace("/abs/", "/pdf/"),
      landingUrl: absUrl,
    });
  });
  return out;
}

async function searchSemanticScholarWorks(query, limit) {
  const data = await fetchJson(
    `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${limit}&fields=title,authors,year,venue,externalIds,citationCount,abstract,openAccessPdf,url`,
  );
  return (data.data || []).map((w) => ({
    provider: "semanticscholar",
    title: String(w.title || "").trim(),
    authors: (w.authors || []).map((a) => a.name || ""),
    year: w.year || undefined,
    venue: w.venue || "",
    doi: normalizeDoi(w.externalIds?.DOI),
    citations: Number(w.citationCount) || 0,
    abstract: String(w.abstract || "").trim(),
    pdfUrl: w.openAccessPdf?.url || "",
    landingUrl: w.url || "",
  }));
}

async function searchPubmedWorks(query, limit) {
  const search = await fetchJson(
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmax=${limit}&retmode=json`,
  );
  const ids = search.esearchresult?.idlist || [];
  if (!ids.length) return [];
  const summary = await fetchJson(
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${ids.join(",")}&retmode=json`,
  );
  const out = [];
  for (const id of ids) {
    const w = summary.result?.[id];
    if (!w) continue;
    const doi = normalizeDoi(
      (w.articleids || []).find((a) => a.idtype === "doi")?.value,
    );
    out.push({
      provider: "pubmed",
      title: String(w.title || "")
        .replace(/<[^>]+>/g, "")
        .trim(),
      authors: (w.authors || []).map((a) => a.name || ""),
      year: w.pubdate ? Number(String(w.pubdate).slice(0, 4)) : undefined,
      venue: w.fulljournalname || w.source || "",
      doi,
      citations: 0,
      abstract: "",
      pdfUrl: "",
      landingUrl: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
    });
  }
  return out;
}

const ACADEMIC_PROVIDERS = {
  openalex: searchOpenAlexWorks,
  crossref: searchCrossrefWorks,
  arxiv: searchArxivWorks,
  semanticscholar: searchSemanticScholarWorks,
  pubmed: searchPubmedWorks,
};

function mergeAcademicResults(resultLists, maxResults) {
  const merged = [];
  const seenDois = new Set();
  const seenTitles = new Set();
  // Interleave providers so no single API dominates the head of the list,
  // then let citation count settle the final order.
  const queues = resultLists.map((list) => [...list]);
  while (queues.some((q) => q.length)) {
    for (const queue of queues) {
      const item = queue.shift();
      if (!item || !item.title) continue;
      const titleKey = normalizeTitleKey(item.title);
      if (item.doi && seenDois.has(item.doi)) {
        // Duplicate across providers: keep the richer record's extras.
        const existing = merged.find((m) => m.doi === item.doi);
        if (existing) {
          if (!existing.abstract && item.abstract)
            existing.abstract = item.abstract;
          if (!existing.pdfUrl && item.pdfUrl) existing.pdfUrl = item.pdfUrl;
          existing.citations = Math.max(existing.citations, item.citations);
        }
        continue;
      }
      if (!item.doi && seenTitles.has(titleKey)) continue;
      if (item.doi) seenDois.add(item.doi);
      if (titleKey) seenTitles.add(titleKey);
      merged.push(item);
    }
  }
  merged.sort((a, b) => b.citations - a.citations);
  return merged.slice(0, maxResults);
}

// Query all (or the requested) scholarly providers in parallel. Returns the
// merged, deduplicated paper list — shared by academic_search and the
// academic flag of deep_research.
async function runAcademicSearch(query, maxResults, options = {}) {
  const wanted =
    Array.isArray(options.providers) && options.providers.length
      ? options.providers
          .map((p) => String(p).toLowerCase().trim())
          .filter((p) => ACADEMIC_PROVIDERS[p])
      : Object.keys(ACADEMIC_PROVIDERS);
  const perProvider = Math.max(3, Math.min(maxResults, 10));
  const resultLists = await Promise.all(
    wanted.map(async (name) => {
      try {
        return await ACADEMIC_PROVIDERS[name](
          query,
          perProvider,
          options.yearFrom,
          options.yearTo,
        );
      } catch {
        return []; // a slow or rate-limited provider never sinks the search
      }
    }),
  );
  let merged = mergeAcademicResults(resultLists, maxResults);
  // Provider-side year filters only exist on OpenAlex/Crossref; enforce the
  // range on the merged list so arXiv/S2/PubMed results comply too.
  if (options.yearFrom || options.yearTo) {
    merged = merged.filter((p) => {
      if (!p.year) return true;
      if (options.yearFrom && p.year < options.yearFrom) return false;
      if (options.yearTo && p.year > options.yearTo) return false;
      return true;
    });
  }
  return merged;
}

async function executeAcademicSearch({
  query,
  year_from,
  year_to,
  max_results = 12,
  providers,
}) {
  if (!query || !String(query).trim()) {
    return "Academic Search Error: no query provided.";
  }
  const limit = Math.max(3, Math.min(Number(max_results) || 12, 25));
  const yearFrom = Number(year_from) || undefined;
  const yearTo = Number(year_to) || undefined;
  try {
    const papers = await runAcademicSearch(String(query).trim(), limit, {
      yearFrom,
      yearTo,
      providers,
    });
    if (!papers.length) {
      return `No scholarly results found for "${query}". Try broader phrasing, an English translation of the query, or deep_research for general web coverage.`;
    }
    let out = `## Academic search: "${query}" (${papers.length} papers${yearFrom || yearTo ? `, ${yearFrom || ""}–${yearTo || ""}` : ""})\n\n`;
    papers.forEach((p, i) => {
      out += `${i + 1}. ${p.title}\n`;
      out += `   ${formatAuthorList(p.authors)}${p.year ? ` (${p.year})` : ""}${p.venue ? ` — ${p.venue}` : ""}\n`;
      if (p.doi) out += `   DOI: ${p.doi}\n`;
      if (p.citations) out += `   Citations: ${p.citations}\n`;
      if (p.abstract) {
        out += `   Abstract: ${p.abstract.slice(0, 500)}${p.abstract.length > 500 ? "…" : ""}\n`;
      }
      out += `   URL: ${p.landingUrl || p.pdfUrl}\n`;
      if (p.pdfUrl) out += `   PDF: ${p.pdfUrl}\n`;
      out += "\n";
    });
    out +=
      "Next step: call fetch_paper with the DOI or PDF/landing URL of the " +
      "most relevant open-access papers (the ones with a PDF line) to read " +
      "them before answering. Cite papers by author and year in your answer. " +
      "Do NOT run this same search again.";
    return out.trim();
  } catch (e) {
    return `Academic Search Error: ${e.message}`;
  }
}

// Resolve a DOI, arXiv link, or plain URL to readable paper text. Open-access
// PDF discovery goes through OpenAlex only (keyless, no email required).
async function executeFetchPaper({ url_or_doi, save = true }, context = {}) {
  const input = String(url_or_doi || "").trim();
  if (!input) return "Fetch Paper Error: no url_or_doi provided.";
  try {
    let meta = null;
    const doi = normalizeDoi(input);
    if (doi) {
      try {
        const w = await fetchJson(
          `https://api.openalex.org/works/doi:${encodeURIComponent(doi)}`,
        );
        meta = {
          title: String(w.display_name || "").trim(),
          authors: (w.authorships || []).map(
            (a) => a.author?.display_name || "",
          ),
          year: w.publication_year,
          venue: w.primary_location?.source?.display_name || "",
          doi,
          citations: Number(w.cited_by_count) || 0,
          abstract: reconstructOpenAlexAbstract(w.abstract_inverted_index),
          pdfUrl: w.best_oa_location?.pdf_url || w.open_access?.oa_url || "",
          landingUrl:
            w.primary_location?.landing_page_url || `https://doi.org/${doi}`,
        };
      } catch {
        meta = { landingUrl: `https://doi.org/${doi}`, doi };
      }
    }
    const arxivMatch = input.match(
      /arxiv\.org\/(?:abs|pdf)\/([0-9]{4}\.[0-9]{4,5}(?:v\d+)?|[a-z-]+\/[0-9]{7})/i,
    );
    const readTarget = arxivMatch
      ? `https://arxiv.org/abs/${arxivMatch[1]}`
      : meta?.landingUrl || input;
    const pdfCandidate = arxivMatch
      ? `https://arxiv.org/pdf/${arxivMatch[1]}`
      : meta?.pdfUrl || (/\.pdf(\?|$)/i.test(input) ? input : "");

    // Save the open-access PDF into the workspace sandbox when available.
    let savedLine = "";
    if (save && pdfCandidate && context.dataDir) {
      try {
        // Guarded binary fetch re-checks the SSRF guard on every redirect
        // hop (OA PDF links redirect freely across CDNs).
        const bytes = await fetchBinaryGuarded(pdfCandidate);
        if (
          bytes.length > 1000 &&
          bytes.slice(0, 5).toString("latin1").startsWith("%PDF")
        ) {
          const baseName =
            (meta?.title || arxivMatch?.[1] || "paper")
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-+|-+$/g, "")
              .slice(0, 80) || "paper";
          const rel = path.join("papers", `${baseName}.pdf`);
          const resolved = resolveWorkspacePath(context.dataDir, rel);
          if (!resolved.error) {
            fs.mkdirSync(path.dirname(resolved.target), { recursive: true });
            fs.writeFileSync(resolved.target, bytes);
            savedLine = `\nSaved PDF: workspace/${rel} (${Math.round(bytes.length / 1024)} KB)`;
          }
        }
      } catch {
        /* saving is best-effort; the text below still answers the request */
      }
    }

    // Read the paper's text: landing/abs page first (clean HTML), else the
    // abstract from metadata.
    let bodyText = "";
    const read = await readUrlContent(readTarget, 12000);
    if (read.ok) bodyText = read.text;
    else if (meta?.abstract) {
      bodyText = `(Full text unavailable — abstract only.)\n\n${meta.abstract}`;
    }
    if (!bodyText) {
      return `Fetch Paper Error: could not read ${readTarget}${read.ok ? "" : ` (${read.error})`}.`;
    }

    let out = "## Paper\n\n";
    if (meta?.title) {
      out += `1. ${meta.title}\n   ${formatAuthorList(meta.authors)}${meta.year ? ` (${meta.year})` : ""}${meta.venue ? ` — ${meta.venue}` : ""}\n`;
      if (meta.doi) out += `   DOI: ${meta.doi}\n`;
      if (meta.citations) out += `   Citations: ${meta.citations}\n`;
      out += `   URL: ${meta.landingUrl}\n`;
    } else {
      out += `1. ${readTarget}\n   URL: ${readTarget}\n`;
    }
    if (pdfCandidate) out += `   PDF: ${pdfCandidate}\n`;
    out += savedLine ? `${savedLine}\n` : "";
    out += `\n### Content\n\n${bodyText}\n\n`;
    out +=
      "Cite this paper by author and year when you use it. If you need more " +
      "papers, go back to your academic_search results instead of re-fetching " +
      "this one.";
    return out.trim();
  } catch (e) {
    return `Fetch Paper Error: ${e.message}`;
  }
}

// --- Deep Etymology Implementation ---
async function fetchArrayBuffer(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
        const data = [];
        res.on("data", (chunk) => data.push(chunk));
        res.on("end", () => resolve(Buffer.concat(data)));
      })
      .on("error", reject);
  });
}

function cleanEtymText(text) {
  return text.replace(/\s+/g, " ").trim();
}

async function fetchWiktionaryWiki(word, langCode) {
  try {
    const url = `https://${langCode}.wiktionary.org/wiki/${encodeURIComponent(word)}`;
    const html = await fetchText(url);
    const $ = cheerio.load(html);
    const etymHeader = $(
      "#Étymologie, #Etymologie, #Etimología, #Etymology, #Etymology_1",
    ).first();
    if (!etymHeader.length) return null;
    let etymologyText = "";
    let nextElement = etymHeader.parent().next();
    while (
      nextElement.length &&
      !["h2", "h3"].includes(nextElement.get(0).tagName.toLowerCase())
    ) {
      etymologyText += nextElement.text().trim() + "\n";
      nextElement = nextElement.next();
    }
    return cleanEtymText(etymologyText) || null;
  } catch (error) {
    return null;
  }
}

async function fetchEtymonline(word) {
  try {
    const searchUrl = `https://www.etymonline.com/search?q=${encodeURIComponent(word)}`;
    const html = await fetchText(searchUrl);
    const $ = cheerio.load(html);
    const path = $('a[href^="/word/"]:not(.crossreference):not(.link)')
      .first()
      .attr("href");
    if (!path) return null;
    const termHtml = await fetchText("https://www.etymonline.com" + path);
    const $term = cheerio.load(termHtml);
    const def = $term("section.-mt-4.-mb-2.lg\\:-mb-2 > p")
      .map((_i, pEl) => $term(pEl).text())
      .get()
      .join("\n\n")
      .trim();
    return def || null;
  } catch (e) {
    return null;
  }
}

async function fetchDPD(word) {
  try {
    const url = `https://www.rae.es/dpd/${encodeURIComponent(word)}`;
    const doc = await fetchText(url);
    const $ = cheerio.load(doc);
    let etym = null;
    $("section").each((_i, section) => {
      const header = $(section).find("h2").text().trim().toLowerCase();
      if (header === "etimología")
        etym = $(section)
          .text()
          .replace(/^etimología\s*/i, "")
          .trim();
    });
    if (etym) return cleanEtymText(etym);
    const firstSenseP = $("p[data-heading='sense']").first().text().trim();
    if (firstSenseP) return cleanEtymText(firstSenseP);
    return null;
  } catch (e) {
    return null;
  }
}

async function fetchDLE(word) {
  try {
    const url = `https://dle.rae.es/${encodeURIComponent(word)}`;
    const doc = await fetchText(url);
    const $ = cheerio.load(doc);
    const etimDiv = $("section.c-section div.n2.c-text-intro").first();
    if (etimDiv.length) return cleanEtymText(etimDiv.text());
    return null;
  } catch (e) {
    return null;
  }
}

async function fetchDeChile(word) {
  try {
    const url = `https://etimologias.dechile.net/?${encodeURIComponent(word)}`;
    const buffer = await fetchArrayBuffer(url);
    const text = new TextDecoder("windows-1252").decode(new Uint8Array(buffer));
    const $ = cheerio.load(text);
    let targetH3 = null;
    $("h3").each((_i, h3) => {
      if ($(h3).text().trim().toLowerCase() === word.toLowerCase())
        targetH3 = $(h3);
    });
    if (!targetH3) return null;
    let etymologyTexts = [];
    let sibling = targetH3.next();
    while (sibling.length && sibling.get(0).tagName.toLowerCase() === "p") {
      const siblingText = sibling.text().trim();
      if (siblingText) etymologyTexts.push(cleanEtymText(siblingText));
      sibling = sibling.next();
    }
    return etymologyTexts.join("\n\n") || null;
  } catch (e) {
    return null;
  }
}

async function fetchCNRTL(word) {
  try {
    const url = `https://www.cnrtl.fr/etymologie/${encodeURIComponent(word)}`;
    const doc = await fetchText(url);
    const $ = cheerio.load(doc);
    const etymologyDiv = $("div.tlf_cvedette + b");
    if (!etymologyDiv.length) return null;
    let etymologyText = "";
    let currentElement = etymologyDiv.parent();
    while (
      currentElement.length &&
      currentElement.attr("id") !== "contentbox"
    ) {
      etymologyText += currentElement.text().trim() + "\n";
      currentElement = currentElement.next();
    }
    return cleanEtymText(etymologyText) || null;
  } catch (e) {
    return null;
  }
}

async function executeDeepEtymology({ word, language }) {
  let results = [];
  const lang = language.toLowerCase();

  if (lang === "en" || lang.startsWith("en-")) {
    const [etym, wikt] = await Promise.all([
      fetchEtymonline(word),
      fetchWiktionaryWiki(word, "en"),
    ]);
    if (etym) results.push(`**Etymonline:** ${etym}`);
    if (wikt) results.push(`**Wiktionary (en):** ${wikt}`);
  } else if (lang === "es" || lang.startsWith("es-")) {
    const [dpd, dle, dechile, wikt] = await Promise.all([
      fetchDPD(word),
      fetchDLE(word),
      fetchDeChile(word),
      fetchWiktionaryWiki(word, "es"),
    ]);
    if (dpd) results.push(`**DPD (RAE):** ${dpd}`);
    if (dle) results.push(`**DLE (RAE):** ${dle}`);
    if (dechile) results.push(`**DeChile:** ${dechile}`);
    if (wikt) results.push(`**Wiktionary (es):** ${wikt}`);
  } else if (lang === "fr" || lang.startsWith("fr-")) {
    const [cnrtl, wikt] = await Promise.all([
      fetchCNRTL(word),
      fetchWiktionaryWiki(word, "fr"),
    ]);
    if (cnrtl) results.push(`**CNRTL:** ${cnrtl}`);
    if (wikt) results.push(`**Wiktionary (fr):** ${wikt}`);
  }

  if (results.length === 0) {
    return `No etymology data found for "${word}" in language "${language}".`;
  }

  return (
    `### Etymology & Meaning for "${word}" (${language})\n\n` +
    results.join("\n\n")
  );
}

const BOOK_PROVIDER_TIMEOUT_MS = 9000;

const BOOK_SCRAPER_TIMEOUT_MS = 13000;

function bookSearchConfig(context) {
  try {
    const dataDir = context && context.dataDir;
    if (!dataDir) return {};
    const file = path.join(dataDir, "book-search.json");
    if (!fs.existsSync(file)) return {};
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_e) {
    return {};
  }
}

function withBookTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const t = setTimeout(
        () => reject(new Error(`${label} timed out after ${ms}ms`)),
        ms,
      );
      if (t.unref) t.unref();
    }),
  ]);
}

function normalizeWorkKey(str) {
  return String(str || "")
    .toLowerCase()
    .trim()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Ported verbatim from the plugin's edition_score.ts.
function scoreBookCandidate(book) {
  let score = 0;
  if (book.isbn13) score += 20;
  if (book.isbn10) score += 15;
  if (book.publisher) score += 10;
  const pages =
    typeof book.totalPage === "number"
      ? book.totalPage
      : parseInt(book.totalPage || "", 10) || 0;
  if (pages) score += 12;
  if (book.coverUrl) score += 10;
  if (book.publishDate) score += 6;
  if (book.categories) score += 6;
  if (book.description) score += 4;
  if (book.title) score += 2;
  if (book.author) score += 2;
  return score;
}

function detectIsbn(query) {
  const compact = String(query || "").replace(/[-\s]/g, "");
  if (/^\d{13}$/.test(compact) || /^\d{9}[\dXx]$/.test(compact)) {
    return compact.toUpperCase();
  }
  return "";
}

function pickIsbns(values) {
  let isbn10 = "";
  let isbn13 = "";
  for (const value of values || []) {
    const digits = String(value || "").replace(/[^\dXx]/g, "");
    if (digits.length === 13 && !isbn13) isbn13 = digits;
    else if (digits.length === 10 && !isbn10) isbn10 = digits;
  }
  return { isbn10, isbn13 };
}

async function bookOpenLibrary(query, isbn) {
  const url = isbn
    ? `https://openlibrary.org/search.json?q=isbn:${encodeURIComponent(isbn)}&limit=5`
    : `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=5`;
  const fields =
    "&fields=key,title,author_name,isbn,first_publish_year,publisher,number_of_pages_median,language,cover_i,subject";
  const data = await fetchJson(url + fields);
  return (data?.docs || []).slice(0, 5).map((doc) => {
    const { isbn10, isbn13 } = pickIsbns(doc.isbn || []);
    return {
      title: doc.title || "",
      author: (doc.author_name || [])[0] || "",
      authors: doc.author_name || [],
      coverUrl: doc.cover_i
        ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`
        : "",
      link: doc.key ? `https://openlibrary.org${doc.key}` : "",
      isbn10,
      isbn13,
      publisher: (doc.publisher || [])[0] || "",
      publishDate: doc.first_publish_year ? String(doc.first_publish_year) : "",
      totalPage: doc.number_of_pages_median || "",
      categories: (doc.subject || []).slice(0, 5).join(", "),
      language: (doc.language || [])[0] || "",
      _workKey: doc.key || "",
    };
  });
}

async function bookOpenLibraryDescription(workKey) {
  if (!workKey) return "";
  try {
    const work = await fetchJson(`https://openlibrary.org${workKey}.json`);
    const d = work?.description;
    return typeof d === "string" ? d : d?.value || "";
  } catch (_e) {
    return "";
  }
}

async function bookGoogle(query, isbn, config, language) {
  const q = isbn ? `isbn:${isbn}` : query;
  let url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=5&printType=books`;
  if (language)
    url += `&langRestrict=${encodeURIComponent(language.slice(0, 2))}`;
  if (config.googleApiKey)
    url += `&key=${encodeURIComponent(config.googleApiKey)}`;
  const data = await fetchJson(url);
  if (data?.error) throw new Error(data.error.message || "Google Books error");
  return (data?.items || []).slice(0, 5).map((item) => {
    const v = item.volumeInfo || {};
    const ids = v.industryIdentifiers || [];
    const find = (type) =>
      (ids.find((i) => i.type === type) || {}).identifier || "";
    return {
      title: v.title || "",
      author: (v.authors || [])[0] || "",
      authors: v.authors || [],
      coverUrl: (v.imageLinks?.thumbnail || "").replace(/^http:/, "https:"),
      link: v.canonicalVolumeLink || v.infoLink || "",
      isbn10: find("ISBN_10"),
      isbn13: find("ISBN_13"),
      description: v.description || "",
      publisher: v.publisher || "",
      publishDate: v.publishedDate || "",
      totalPage: v.pageCount || "",
      categories: (v.categories || []).join(", "),
      language: v.language || "",
    };
  });
}

// Goodreads search bot-challenges plain fetches, so the finder goes through
// web search / the reader proxy; the book PAGE itself answers direct fetches
// and carries a __NEXT_DATA__ JSON blob with the full record.
async function bookGoodreadsFindUrl(query, context) {
  try {
    const { results } = await runWebSearch(
      `site:goodreads.com/book/show ${query}`,
      5,
      (context && context.cloudKeys) || {},
    );
    const hit = (results || []).find((r) =>
      /goodreads\.com\/book\/show\//i.test(r.url || ""),
    );
    if (hit) return hit.url.split("?")[0];
  } catch (_e) {
    /* fall through */
  }
  try {
    const proxied = await readUrlContent(
      `https://www.goodreads.com/search?q=${encodeURIComponent(query)}`,
      20000,
    );
    if (proxied.ok) {
      const m = proxied.text.match(
        /https:\/\/www\.goodreads\.com\/book\/show\/[A-Za-z0-9._-]+/,
      );
      if (m) return m[0];
    }
  } catch (_e) {
    /* no goodreads result */
  }
  return "";
}

function bookGoodreadsParseNextData(html) {
  const $ = cheerio.load(html);
  const raw = $("#__NEXT_DATA__").text() || "";
  if (!raw) return null;
  let json;
  try {
    json = JSON.parse(raw);
  } catch (_e) {
    return null;
  }
  const apollo = json?.props?.pageProps?.apolloState || {};
  let book = null;
  const contributors = {};
  for (const [key, value] of Object.entries(apollo)) {
    if (!value || typeof value !== "object") continue;
    if (key.startsWith("Contributor:") && value.name) {
      contributors[key] = value.name;
    }
    if (value.__typename === "Book" && value.title && value.details) {
      if (!book || (value.description && !book.description)) book = value;
    }
  }
  if (!book) return null;
  const details = book.details || {};
  const primary = (book.primaryContributorEdge || {}).node || {};
  const authorName =
    primary.name ||
    contributors[(primary.__ref || "").trim()] ||
    Object.values(contributors)[0] ||
    "";
  const genres = (book.bookGenres || [])
    .map((g) => g?.genre?.name)
    .filter(Boolean)
    .join(", ");
  const year = details.publicationTime
    ? String(new Date(details.publicationTime).getUTCFullYear())
    : "";
  return {
    title: book.titleComplete || book.title || "",
    author: authorName,
    authors: authorName ? [authorName] : [],
    coverUrl: book.imageUrl || "",
    link: book.webUrl || "",
    isbn10: details.isbn || "",
    isbn13: details.isbn13 || "",
    description: String(book.description || "").replace(/<[^>]+>/g, ""),
    publisher: details.publisher || "",
    publishDate: year,
    totalPage: details.numPages || "",
    categories: genres,
    language: details.language?.name || "",
  };
}

async function bookGoodreads(query, isbn, context) {
  const url = await bookGoodreadsFindUrl(isbn || query, context);
  if (!url) return [];
  const html = await fetchHtml(url, { timeout: BOOK_SCRAPER_TIMEOUT_MS });
  const book = bookGoodreadsParseNextData(html);
  return book ? [book] : [];
}

async function bookStoryGraph(query) {
  const html = await fetchHtml(
    `https://app.thestorygraph.com/browse?search_term=${encodeURIComponent(query)}`,
    { timeout: BOOK_SCRAPER_TIMEOUT_MS },
  );
  const $ = cheerio.load(html);
  const books = [];
  $(".book-pane").each((_, el) => {
    if (books.length >= 3) return;
    const node = $(el);
    const linkEl = node.find('a[href^="/books/"]').first();
    const href = linkEl.attr("href") || "";
    const img = node.find("img").first();
    const text = node.text().replace(/\s+/g, " ").trim();
    const title = (img.attr("alt") || "").replace(/ by .*$/, "").trim();
    const authorMatch = (img.attr("alt") || "").match(/ by (.+)$/);
    if (!title || !href) return;
    books.push({
      title,
      author: authorMatch ? authorMatch[1].trim() : "",
      authors: authorMatch ? [authorMatch[1].trim()] : [],
      coverUrl: img.attr("src") || "",
      link: `https://app.thestorygraph.com${href.split("?")[0]}`,
      totalPage: (text.match(/(\d+)\s+pages/) || [])[1] || "",
    });
  });
  if (
    !books.length &&
    /you need to sign in|sign in to continue/i.test($.text())
  ) {
    throw new Error("StoryGraph requires sign-in for this request");
  }
  return books;
}

async function bookHardcover(query, config) {
  const token = String(config.hardcoverToken || "").trim();
  if (!token) return [];
  const auth = /^bearer /i.test(token) ? token : `Bearer ${token}`;
  const body = JSON.stringify({
    query: `query SearchBooks($query: String!) {
      search(query: $query, query_type: "Book", per_page: 5, page: 1) { results }
    }`,
    variables: { query },
  });
  const res = await fetchHtml("https://api.hardcover.app/v1/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: auth,
    },
    body,
    timeout: BOOK_PROVIDER_TIMEOUT_MS,
  });
  const json = JSON.parse(res);
  const hits = json?.data?.search?.results?.hits || [];
  return hits.slice(0, 5).map((h) => {
    const doc = h.document || h;
    const { isbn10, isbn13 } = pickIsbns(doc.isbns || []);
    return {
      title: doc.title || "",
      author: (doc.author_names || [])[0] || "",
      authors: doc.author_names || [],
      coverUrl: doc.image?.url || "",
      link: doc.slug ? `https://hardcover.app/books/${doc.slug}` : "",
      isbn10,
      isbn13,
      publishDate: doc.release_year ? String(doc.release_year) : "",
      totalPage: doc.pages || "",
      categories: (doc.genres || []).slice(0, 5).join(", "),
    };
  });
}

async function bookLibraryThing(query, config) {
  const token = String(config.librarythingToken || "").trim();
  if (!token) return [];
  const url = `https://www.librarything.com/api/talpa.php?search=${encodeURIComponent(query)}&token=${encodeURIComponent(token)}&limit=5&responseType=json`;
  const data = await fetchJson(url);
  const items = data?.resultlist || data?.results || [];
  return (Array.isArray(items) ? items : []).slice(0, 5).map((item) => {
    const isbns = item.isbns || item.isbn || [];
    const { isbn10, isbn13 } = pickIsbns(
      Array.isArray(isbns) ? isbns : [isbns],
    );
    return {
      title: item.title || "",
      author: item.author || "",
      authors: item.author ? [item.author] : [],
      coverUrl:
        isbn13 || isbn10
          ? `https://covers.openlibrary.org/b/isbn/${isbn13 || isbn10}-L.jpg`
          : "",
      link: item.work_id
        ? `https://www.librarything.com/work/${item.work_id}`
        : "",
      isbn10,
      isbn13,
    };
  });
}

async function bookCalibre(query, config) {
  const server = String(config.calibreServerUrl || "")
    .trim()
    .replace(/\/$/, "");
  if (!server) return [];
  const libraryId = encodeURIComponent(config.calibreLibraryId || "");
  const search = await fetchJson(
    `${server}/ajax/search?query=${encodeURIComponent(query)}&num=5${libraryId ? `&library_id=${libraryId}` : ""}`,
  );
  const ids = (search?.book_ids || []).slice(0, 5);
  if (!ids.length) return [];
  const detail = await fetchJson(
    `${server}/ajax/books?ids=${ids.join(",")}${libraryId ? `&library_id=${libraryId}` : ""}`,
  );
  return ids
    .map((id) => detail?.[id])
    .filter(Boolean)
    .map((b) => {
      const identifiers = b.identifiers || {};
      const { isbn10, isbn13 } = pickIsbns([identifiers.isbn || ""]);
      return {
        title: b.title || "",
        author: (b.authors || [])[0] || "",
        authors: b.authors || [],
        coverUrl: "",
        link: `${server}/#book_id=${encodeURIComponent(String(b.application_id || ""))}`,
        isbn10,
        isbn13,
        publisher: b.publisher || "",
        publishDate: (b.pubdate || "").slice(0, 10),
        language: (b.languages || [])[0] || "",
        series: b.series || "",
        seriesNumber: b.series_index || "",
        categories: (b.tags || []).slice(0, 6).join(", "),
        description: String(b.comments || "").replace(/<[^>]+>/g, ""),
      };
    });
}

const BOOK_FIELD_PRIORITY = {
  title: ["goodreads", "google", "openlibrary", "hardcover", "calibre"],
  author: ["goodreads", "google", "openlibrary", "hardcover", "calibre"],
  description: ["goodreads", "google", "calibre", "openlibrary"],
  publisher: ["google", "openlibrary", "goodreads", "hardcover", "calibre"],
  publishDate: ["google", "openlibrary", "goodreads", "hardcover", "calibre"],
  totalPage: ["google", "goodreads", "openlibrary", "hardcover", "storygraph"],
  categories: ["goodreads", "google", "openlibrary", "hardcover", "calibre"],
  coverUrl: ["goodreads", "google", "openlibrary", "hardcover", "storygraph"],
  language: ["google", "goodreads", "openlibrary", "calibre"],
  series: ["calibre", "goodreads"],
};

function mergeBooks(candidates) {
  const merged = {};
  const conflicts = [];
  const sources = candidates.map((c) => c._src);
  const fields = new Set();
  candidates.forEach((c) => Object.keys(c).forEach((k) => fields.add(k)));
  for (const field of fields) {
    if (field.startsWith("_")) continue;
    const order = BOOK_FIELD_PRIORITY[field] || sources;
    const holders = candidates.filter((c) => {
      const v = c[field];
      return Array.isArray(v)
        ? v.length
        : v !== undefined && v !== null && String(v).trim() !== "";
    });
    if (!holders.length) continue;
    holders.sort(
      (a, b) =>
        (order.indexOf(a._src) + 1 || 99) - (order.indexOf(b._src) + 1 || 99),
    );
    merged[field] = holders[0][field];
    if (["totalPage", "publisher", "publishDate"].includes(field)) {
      const distinct = [
        ...new Set(holders.map((h) => String(h[field]).trim())),
      ];
      if (distinct.length > 1) {
        conflicts.push(
          `${field}: ` +
            holders
              .slice(0, 3)
              .map((h) => `${h[field]} (${h._src})`)
              .join(" vs "),
        );
      }
    }
  }
  return { merged, conflicts };
}

async function executeBookSearch(
  { query, language = "", provider = "" },
  context = {},
) {
  try {
    const config = bookSearchConfig(context);
    const isbn = detectIsbn(query);
    const wanted = String(provider || "")
      .toLowerCase()
      .trim();
    const providers = [
      { id: "openlibrary", run: () => bookOpenLibrary(query, isbn) },
      { id: "google", run: () => bookGoogle(query, isbn, config, language) },
      { id: "goodreads", run: () => bookGoodreads(query, isbn, context) },
      { id: "storygraph", run: () => bookStoryGraph(query) },
      { id: "hardcover", run: () => bookHardcover(query, config) },
      { id: "librarything", run: () => bookLibraryThing(query, config) },
      { id: "calibre", run: () => bookCalibre(query, config) },
    ].filter((p) => !wanted || p.id === wanted);

    const outcomes = await Promise.allSettled(
      providers.map((p) =>
        withBookTimeout(
          p.run(),
          p.id === "goodreads" || p.id === "storygraph"
            ? BOOK_SCRAPER_TIMEOUT_MS
            : BOOK_PROVIDER_TIMEOUT_MS,
          p.id,
        ).then((books) => (books || []).map((b) => ({ ...b, _src: p.id }))),
      ),
    );

    const all = [];
    const unavailable = [];
    outcomes.forEach((o, i) => {
      if (o.status === "fulfilled") all.push(...o.value);
      else unavailable.push(providers[i].id);
    });
    if (!all.length) {
      return `No book found for "${query}".${unavailable.length ? ` (Sources unavailable: ${unavailable.join(", ")})` : ""}`;
    }

    // Group by work (normalized title|author), exactly like the plugin.
    const workMap = new Map();
    for (const book of all) {
      const groupTitle = normalizeWorkKey(
        String(book.title || "").replace(/\s*[([][^)\]]*[)\]]\s*$/, ""),
      );
      const key = `${groupTitle}|${normalizeWorkKey(book.author)}`;
      if (!workMap.has(key)) workMap.set(key, []);
      workMap.get(key).push(book);
    }
    // Rank works: source coverage first, then best edition score, with a
    // preference for titles containing the query terms.
    const queryNorm = normalizeWorkKey(isbn ? "" : query);
    const ranked = [...workMap.values()].sort((a, b) => {
      const cover = (list) => new Set(list.map((x) => x._src)).size;
      const relevance = (list) =>
        queryNorm &&
        normalizeWorkKey(list[0].title) &&
        queryNorm.includes(normalizeWorkKey(list[0].title))
          ? 1
          : 0;
      const best = (list) => Math.max(...list.map(scoreBookCandidate));
      return (
        relevance(b) - relevance(a) || cover(b) - cover(a) || best(b) - best(a)
      );
    });
    const workBooks = ranked[0];
    const { merged, conflicts } = mergeBooks(workBooks);
    // ISBNs describe an edition, not a work: take them from the strongest
    // edition rather than by per-field source priority.
    const queriedEdition = isbn
      ? workBooks.find((b) => b.isbn13 === isbn || b.isbn10 === isbn)
      : null;
    const bestEdition =
      queriedEdition ||
      [...workBooks].sort(
        (a, b) => scoreBookCandidate(b) - scoreBookCandidate(a),
      )[0];
    if (bestEdition) {
      if (bestEdition.isbn13) merged.isbn13 = bestEdition.isbn13;
      if (bestEdition.isbn10) merged.isbn10 = bestEdition.isbn10;
    }
    if (isbn && !merged.isbn13 && !merged.isbn10) {
      if (isbn.length === 13) merged.isbn13 = isbn;
      else merged.isbn10 = isbn;
    }

    // Mutual enrichment: fill missing description from Open Library's work
    // record; fill missing cover from the ISBN cover CDN.
    if (!merged.description) {
      const ol = workBooks.find((b) => b._src === "openlibrary" && b._workKey);
      if (ol)
        merged.description = await bookOpenLibraryDescription(ol._workKey);
    }
    if (!merged.coverUrl && (merged.isbn13 || merged.isbn10)) {
      merged.coverUrl = `https://covers.openlibrary.org/b/isbn/${merged.isbn13 || merged.isbn10}-L.jpg`;
    }

    // Output: markdown table + description + editions + sources.
    const rows = [
      ["Title", merged.title],
      ["Author(s)", (merged.authors || []).join(", ") || merged.author],
      ["ISBN-13", merged.isbn13],
      ["ISBN-10", merged.isbn10],
      ["Publisher", merged.publisher],
      ["Published", merged.publishDate],
      ["Pages", merged.totalPage],
      ["Categories", merged.categories],
      [
        "Series",
        merged.series
          ? `${merged.series}${merged.seriesNumber ? ` #${merged.seriesNumber}` : ""}`
          : "",
      ],
      ["Language", merged.language],
    ].filter(([, v]) => v !== undefined && String(v || "").trim() !== "");

    let out = `## ${merged.title}\n\n`;
    out += "| Field | Value |\n|---|---|\n";
    rows.forEach(([k, v]) => {
      out += `| ${k} | ${String(v).replace(/\|/g, "/").replace(/\n/g, " ")} |\n`;
    });
    if (merged.description) {
      const desc = String(merged.description).trim();
      out += `\n**Description:** ${desc.length > 900 ? desc.slice(0, 900) + "…" : desc}\n`;
    }
    if (merged.coverUrl) out += `\n[Cover](${merged.coverUrl})\n`;
    const links = workBooks
      .filter((b) => b.link)
      .map((b) => `[${b._src}](${b.link})`);
    if (links.length) {
      // Inside an HTML comment: the server extracts these into source pills;
      // the reply text itself must not repeat them.
      out += `\n<!-- sources: ${links.join(" ")} -->\n`;
    }
    if (conflicts.length) {
      out += `\n**Source disagreements:** ${conflicts.join("; ")}\n`;
    }
    const otherWorks = ranked
      .slice(1, 4)
      .map((list) => `${list[0].title} (${list[0].author})`)
      .filter(Boolean);
    if (otherWorks.length) {
      out += `\n**Other matches** (re-query to pick one): ${otherWorks.join(" | ")}\n`;
    }
    if (unavailable.length) {
      out += `\n_Sources unavailable this run: ${unavailable.join(", ")}_\n`;
    }
    out +=
      "\n[Instruction to the assistant: present the markdown table, description and Cover link above VERBATIM in your reply — do not convert them to prose, do not expand the cover into a bare URL, and do not list the sources (they are shown to the user as pills automatically).]";
    return out.trim();
  } catch (e) {
    return `Book Search Error: ${e.message}`;
  }
}

module.exports = {
  executeWikipedia,
  executeWiktionary,
  executeBritannica,
  executeDuckDuckGo,
  executeFactCheck,
  executeWebScraper,
  executeDeepResearch,
  executeAcademicSearch,
  executeFetchPaper,
  executeDeepEtymology,
  executeBookSearch,
  WIKI_FALLBACK_LANGS,
  wikiTitleKey,
  searchWikipedia,
  fetchJson,
  readUrlContent,
  runWebSearch,
  cleanBritannicaMarkdown,
  runAcademicSearch,
  formatAuthorList,
  normalizeDoi,
  reconstructOpenAlexAbstract,
  fetchBinaryGuarded,
  fetchEtymonline,
  fetchWiktionaryWiki,
  fetchDPD,
  fetchDLE,
  fetchDeChile,
  fetchCNRTL,
  bookSearchConfig,
  detectIsbn,
  bookOpenLibrary,
  bookGoogle,
  bookGoodreads,
  bookStoryGraph,
  bookHardcover,
  bookLibraryThing,
  bookCalibre,
  withBookTimeout,
  BOOK_SCRAPER_TIMEOUT_MS,
  BOOK_PROVIDER_TIMEOUT_MS,
  normalizeWorkKey,
  scoreBookCandidate,
  mergeBooks,
  bookOpenLibraryDescription,
  readViaWayback,
  fetchHtml,
  pickWebUa,
  truncateText,
  sleepMs,
  extractMainText,
  CHALLENGE_PAGE_RE,
  loadWebSearchSettings,
  searchTavily,
  searchBrave,
  searchSearxng,
  searchOpenAI,
  searchAnthropic,
  searchGemini,
  searchDuckDuckGo,
  searchWikipediaFallback,
  ACADEMIC_PROVIDERS,
  mergeAcademicResults,
  fetchText,
  cleanEtymText,
  fetchArrayBuffer,
  pickIsbns,
  bookGoodreadsFindUrl,
  bookGoodreadsParseNextData,
  BOOK_FIELD_PRIORITY,
  WEB_UAS,
  webSearchSettingsCache,
  WEB_SEARCH_SETTINGS_FILE,
  parseDdgResults,
  searchOpenAlexWorks,
  searchCrossrefWorks,
  searchArxivWorks,
  searchSemanticScholarWorks,
  searchPubmedWorks,
  normalizeTitleKey,
  decodeDdgHref,
  stripJatsXml,
};
