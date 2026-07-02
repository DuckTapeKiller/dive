const https = require("https");
const http = require("http");
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");
const os = require("os");
const vm = require("vm");
const { exec } = require("child_process");
const { Worker } = require("worker_threads");
const cheerio = require("cheerio");
const { TextDecoder } = require("util");

const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 15000;

function fetchJson(url, redirectsLeft = MAX_REDIRECTS) {
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
          return fetchJson(res.headers.location, redirectsLeft - 1)
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

function fetchText(url, redirectsLeft = MAX_REDIRECTS) {
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
          return fetchText(res.headers.location, redirectsLeft - 1)
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
function fetchHtml(url, options = {}, redirectsLeft = MAX_REDIRECTS) {
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

async function executeWikipedia({ query, language = "en" }) {
  try {
    const wikiBase = `https://${language.toLowerCase().slice(0, 2)}.wikipedia.org`;
    const searchUrl = `${wikiBase}/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=1&format=json&origin=*`;
    const searchData = await fetchJson(searchUrl);
    const searchArr = searchData?.query?.search || [];
    if (searchArr.length === 0)
      return `No Wikipedia results found for "${query}".`;

    const pageTitle = searchArr[0].title;
    const summaryUrl = `${wikiBase}/api/rest_v1/page/summary/${encodeURIComponent(pageTitle.replace(/ /g, "_"))}`;
    const summaryData = await fetchJson(summaryUrl);

    let output = `## Wikipedia: ${pageTitle}\n\n`;
    if (summaryData.extract) {
      output += `**Summary:** ${summaryData.extract}\n\n`;
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

// ---- Web search providers. Each returns [{ title, url, snippet }]. ----

// DuckDuckGo HTML scrape (no API key). Primary html endpoint + lite fallback.
async function searchDuckDuckGo(query, limit) {
  let results = [];
  try {
    const html = await fetchHtml(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    );
    results = parseDdgResults(cheerio.load(html), limit);
  } catch {
    /* try the lite endpoint below */
  }
  if (!results.length) {
    try {
      const lite = await fetchHtml(
        `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
      );
      results = parseDdgResults(cheerio.load(lite), limit);
    } catch {
      /* no results */
    }
  }
  return results;
}

// Tavily: LLM-optimized search API (POST JSON, bearer key).
async function searchTavily(query, limit, apiKey) {
  const res = await fetchHtml("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      max_results: limit,
      search_depth: "basic",
    }),
    timeout: 20000,
  });
  const data = JSON.parse(res);
  return (Array.isArray(data.results) ? data.results : [])
    .slice(0, limit)
    .map((r) => ({
      title: String(r.title || r.url || "").trim(),
      url: String(r.url || "").trim(),
      snippet: String(r.content || "")
        .replace(/\s+/g, " ")
        .trim(),
    }))
    .filter((r) => /^https?:\/\//i.test(r.url));
}

// Brave Search API (GET, subscription-token header).
async function searchBrave(query, limit, apiKey) {
  const res = await fetchHtml(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`,
    {
      headers: { Accept: "application/json", "X-Subscription-Token": apiKey },
      timeout: 20000,
    },
  );
  const data = JSON.parse(res);
  return (
    (data.web && Array.isArray(data.web.results) && data.web.results) ||
    []
  )
    .slice(0, limit)
    .map((r) => ({
      title: String(r.title || r.url || "").trim(),
      url: String(r.url || "").trim(),
      snippet: String(r.description || "")
        .replace(/<[^>]*>/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    }))
    .filter((r) => /^https?:\/\//i.test(r.url));
}

// SearXNG JSON API on a user-provided instance (no key required).
async function searchSearxng(query, limit, baseUrl) {
  const root = String(baseUrl || "").replace(/\/+$/, "");
  const res = await fetchHtml(
    `${root}/search?q=${encodeURIComponent(query)}&format=json`,
    { headers: { Accept: "application/json" }, timeout: 20000 },
  );
  const data = JSON.parse(res);
  return (Array.isArray(data.results) ? data.results : [])
    .slice(0, limit)
    .map((r) => ({
      title: String(r.title || r.url || "").trim(),
      url: String(r.url || "").trim(),
      snippet: String(r.content || "")
        .replace(/\s+/g, " ")
        .trim(),
    }))
    .filter((r) => /^https?:\/\//i.test(r.url));
}

// Run the configured provider, then fall back through the chain to DuckDuckGo.
// Returns { provider, results }. A keyless/misconfigured provider is skipped.
async function runWebSearch(query, limit, cfg = {}) {
  const provider = cfg.provider || "auto";
  const order =
    provider === "auto"
      ? ["tavily", "brave", "searxng", "duckduckgo"]
      : [provider, "tavily", "brave", "searxng", "duckduckgo"];
  const seen = new Set();
  for (const p of order) {
    if (seen.has(p)) continue;
    seen.add(p);
    try {
      let results = null;
      if (p === "tavily" && cfg.tavilyKey)
        results = await searchTavily(query, limit, cfg.tavilyKey);
      else if (p === "brave" && cfg.braveKey)
        results = await searchBrave(query, limit, cfg.braveKey);
      else if (p === "searxng" && cfg.searxngUrl)
        results = await searchSearxng(query, limit, cfg.searxngUrl);
      else if (p === "duckduckgo")
        results = await searchDuckDuckGo(query, limit);
      if (results && results.length) return { provider: p, results };
    } catch {
      /* try the next provider in the chain */
    }
  }
  return { provider: "duckduckgo", results: [] };
}

async function executeDuckDuckGo({ query, max_results = 6 }, context = {}) {
  const limit = Math.max(1, Math.min(Number(max_results) || 6, 10));
  try {
    // 1) Real web results via the configured provider chain.
    const { provider, results } = await runWebSearch(
      query,
      limit,
      (context && context.webSearch) || {},
    );

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

async function executeBritannica({ query }) {
  try {
    const searchHtml = await fetchText(
      `https://www.britannica.com/search?query=${encodeURIComponent(query)}`,
    );
    const linkRegex =
      /<a[^>]*class="font-weight-bold font-18"[^>]*href="([^"]+)"/i;
    const match = searchHtml.match(linkRegex);

    if (!match) {
      return `No Britannica article found for "${query}".`;
    }

    const href = match[1];
    if (
      typeof href !== "string" ||
      !href.startsWith("/") ||
      href.startsWith("//")
    ) {
      return `No valid Britannica article link found for "${query}".`;
    }
    const articleUrl = "https://www.britannica.com" + href;
    const articleHtml = await fetchText(articleUrl);

    const pRegex = /<p[^>]*>(.*?)<\/p>/gi;
    let pMatch;
    let paragraphs = [];
    while (
      (pMatch = pRegex.exec(articleHtml)) !== null &&
      paragraphs.length < 3
    ) {
      let text = pMatch[1].replace(/<[^>]+>/g, "").trim();
      text = text
        .replace(/&#x2013;/g, "-")
        .replace(/&amp;/g, "&")
        .replace(/&#x201C;/g, '"')
        .replace(/&#x201D;/g, '"')
        .replace(/&#x2019;/g, "'");
      if (
        text.length > 100 &&
        !text.includes("editors will review") &&
        !text.includes("premium.britannica.com")
      ) {
        paragraphs.push(text);
      }
    }

    if (paragraphs.length === 0)
      return `Article found but no text extracted: ${articleUrl}`;

    return `## Britannica: "${query}"\n\n${paragraphs.join("\n\n")}\n\n<!-- ${articleUrl} -->`;
  } catch (e) {
    return `Britannica Error: ${e.message}`;
  }
}

async function executeFactCheck({ claim, language = "en" }, context = {}) {
  const wiki = await executeWikipedia({ query: claim, language });
  const brit = await executeBritannica({ query: claim });
  const ddg = await executeDuckDuckGo({ query: claim }, context);
  return `### Wikipedia findings:\n${wiki}\n\n### Britannica findings:\n${brit}\n\n### Web search findings:\n${ddg}`;
}

async function executeWebScraper({ url }) {
  try {
    // --- SSRF / local-file-read guard ---
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return "Web Scraper Error: Invalid URL.";
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return "Web Scraper Error: Only http and https URLs are allowed.";
    }
    const h = parsed.hostname.toLowerCase();
    const BLOCKED_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
    const PRIVATE_RANGES = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/;
    if (BLOCKED_HOSTS.has(h) || PRIVATE_RANGES.test(h)) {
      return "Web Scraper Error: Access to local or private network addresses is not allowed.";
    }
    // ------------------------------------
    const MAX = 6000;

    // 1) Jina Reader: returns clean, LLM-ready markdown of the main content
    // (strips nav/ads/boilerplate). No API key. Best quality for local models.
    try {
      const md = await fetchHtml(`https://r.jina.ai/${url}`, {
        headers: { "X-Return-Format": "markdown" },
        timeout: 20000,
      });
      const clean = (md || "").trim();
      // Accept only genuine reader output. Jina returns a JSON error object
      // (starting with "{") when rate-limited/blocked — fall through to a
      // direct fetch in that case instead of surfacing the error as content.
      const looksValid =
        clean.length > 200 &&
        !clean.startsWith("{") &&
        !/^(error|failed)\b/i.test(clean);
      if (looksValid) {
        return clean.length > MAX
          ? clean.slice(0, MAX) + "\n\n... [TRUNCATED]"
          : clean;
      }
    } catch {
      /* fall back to a direct fetch + extraction below */
    }

    // 2) Fallback: fetch the page directly and extract the main text, dropping
    // navigation/script/style boilerplate so the model sees the real content.
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);
    $(
      "script, style, noscript, nav, header, footer, aside, form, svg",
    ).remove();
    const container = $("article").first().length
      ? $("article").first()
      : $("main").first().length
        ? $("main").first()
        : $("body");
    const text = container.text().replace(/\s+/g, " ").trim();
    if (!text) return "No readable text found at that URL.";
    return text.length > MAX ? text.slice(0, MAX) + "... [TRUNCATED]" : text;
  } catch (e) {
    return `Web Scraper Error: ${e.message}`;
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

async function executeCalculator({ expression }) {
  try {
    if (!/^[0-9+\-*/().\s]*$/.test(expression)) {
      return "Error: Expression contains invalid characters.";
    }
    const result = vm.runInNewContext(expression, Object.create(null), {
      timeout: 1000,
    });
    return `Result: ${result}`;
  } catch (e) {
    return `Calculator Error: ${e.message}`;
  }
}

async function executeLocalNotes({ action, content }, DATA_DIR) {
  const notesFile = path.join(DATA_DIR, "notes.json");
  let currentText = "";
  try {
    if (fs.existsSync(notesFile)) {
      const raw = JSON.parse(fs.readFileSync(notesFile, "utf8"));
      currentText = raw.text || "";
    }
  } catch (e) {}

  if (action === "read") {
    return currentText ? currentText : "Your notes are currently empty.";
  } else if (action === "append") {
    if (!content) return "Error: Content is required for append action.";
    const newText = currentText ? `${currentText}\n\n${content}` : content;
    fs.writeFileSync(
      notesFile,
      JSON.stringify(
        {
          text: newText,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    return "Successfully appended to your notes.";
  }
  return "Error: Invalid action. Use 'read' or 'append'.";
}

async function executeTimeAndDate({ timezone } = {}) {
  const now = new Date();
  try {
    const timeOpts = timezone ? { timeZone: timezone } : {};
    const localTime = now.toLocaleTimeString("en-US", timeOpts);
    const localDate = now.toLocaleDateString("en-US", timeOpts);
    const dayOfWeek = now.toLocaleDateString("en-US", {
      ...timeOpts,
      weekday: "long",
    });
    return `Current time${timezone ? " in " + timezone : ""}: ${localTime}\nCurrent date: ${localDate}\nDay of the week: ${dayOfWeek}`;
  } catch (e) {
    return `Error: Invalid timezone '${timezone}'. Please use a standard IANA Time Zone string (e.g., 'Australia/Sydney', 'Europe/Paris', 'America/New_York').`;
  }
}

async function executeShellCommand({ command }) {
  console.warn(`[shell_command] Executing: ${String(command).slice(0, 200)}`);
  return new Promise((resolve) => {
    exec(
      command,
      { timeout: 5000, cwd: os.homedir() },
      (error, stdout, stderr) => {
        let output = "";
        if (stdout) output += `STDOUT:\n${stdout}\n`;
        if (stderr) output += `STDERR:\n${stderr}\n`;
        if (error) output += `ERROR:\n${error.message}\n`;
        resolve(output || "Command executed successfully with no output.");
      },
    );
  });
}

function findCustomSkill(name, dataDir) {
  if (!dataDir) return null;
  const customSkillsFile = path.join(dataDir, "custom_skills.json");
  if (!fs.existsSync(customSkillsFile)) return null;
  const skills = JSON.parse(fs.readFileSync(customSkillsFile, "utf8"));
  if (!Array.isArray(skills)) return null;
  return skills.find((skill) => skill && skill.name === name) || null;
}

function skillRequiresShellConfirmation(name, dataDir) {
  if (name === "shell_command") return true;
  try {
    return findCustomSkill(name, dataDir)?.type === "shell";
  } catch (_error) {
    return false;
  }
}

const ALL_SKILLS = [
  {
    type: "function",
    function: {
      name: "wikipedia",
      description:
        "Searches Wikipedia for factual information. Unless the user specifically asks for another source, ALWAYS check Wikipedia AND Britannica for general queries to cross-reference.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search term" },
          language: {
            type: "string",
            description: "Language code (e.g., en, es)",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "britannica",
      description:
        "Searches Encyclopedia Britannica for factual information. Unless the user specifically asks for another source, ALWAYS check Wikipedia AND Britannica for general queries to cross-reference.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search term" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wiktionary",
      description: "Looks up definitions of words in the dictionary.",
      parameters: {
        type: "object",
        properties: {
          word: { type: "string", description: "The word to define." },
          language: {
            type: "string",
            description: "Language code. Defaults to 'en'.",
          },
        },
        required: ["word"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "duckduckgo",
      description:
        "Searches the live web and returns a numbered list of results (title, snippet, URL). Use this FIRST to find current information or sources. Then pick the single most relevant URL and read it with the web_scraper skill before answering. Never repeat the same search query twice.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The web search query." },
          max_results: {
            type: "number",
            description: "How many results to return (1-10, default 6).",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "deep_etymology",
      description: `Cross-references multiple authoritative etymology and dictionary sources. Use this to determine word origins, cognates, false cognates, and false friends.
      
RULES:
1. Cognate: Same form, shared etymology (meaning doesn't matter).
2. False Cognate: Same form, NO shared etymology (meaning doesn't matter).
3. False Friend: Same form, NO shared meaning (etymology doesn't matter).

When asked about these relationships, ALWAYS query both words and explain the distinction using these rules.`,
      parameters: {
        type: "object",
        properties: {
          word: { type: "string", description: "The word to look up" },
          language: {
            type: "string",
            description: "Language code (en, es, fr)",
          },
        },
        required: ["word", "language"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fact_check",
      description:
        "Checks both Wikipedia and the web to verify a specific claim or fact.",
      parameters: {
        type: "object",
        properties: {
          claim: { type: "string", description: "The claim to verify." },
          language: {
            type: "string",
            description:
              "Language code for the search (e.g. 'en', 'es'). Defaults to 'en'.",
          },
        },
        required: ["claim"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_scraper",
      description:
        "Fetches a URL and returns its clean main text/markdown (no nav/ads). Use this after the duckduckgo skill to read a result you selected, then answer the user from what you read.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The full URL to scrape." },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calculator",
      description: "Evaluates mathematical expressions.",
      parameters: {
        type: "object",
        properties: {
          expression: {
            type: "string",
            description: "The math expression (e.g., '2 + 2 * 4').",
          },
        },
        required: ["expression"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "local_notes",
      description: "Reads or appends to your local notes file.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["read", "append"],
            description: "Action to perform.",
          },
          content: {
            type: "string",
            description: "The text to append (required if action is 'append').",
          },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "time_and_date",
      description:
        "Gets the current time, date, and day of the week. If you need the time for a specific city, you MUST provide its standard IANA Time Zone string (e.g. 'Australia/Sydney', 'Europe/Paris', 'America/New_York'). If you don't provide a timezone, it returns the user's local time.",
      parameters: {
        type: "object",
        properties: {
          timezone: {
            type: "string",
            description:
              "Optional. The IANA Time Zone string (e.g. 'Australia/Sydney').",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shell_command",
      description: "Executes a shell command on the local machine (macOS).",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute.",
          },
        },
        required: ["command"],
      },
    },
  },
];

/**
 * Runs a custom JavaScript skill in an isolated worker_threads Worker.
 *
 * SECURITY NOTE: worker_threads provides memory/CPU isolation and a hard
 * timeout, but is NOT a complete security sandbox — the worker can still
 * require Node.js built-in modules. Only execute code from sources you fully
 * trust. Do NOT run untrusted third-party custom skill code here.
 */
function runCustomJsSkill(code, args, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    // Inline worker code as a string evaluated with eval:true
    const workerSrc = `
      const { parentPort, workerData } = require('worker_threads');
      (async () => {
        const args = workerData.args;
        ${code}
      })()
        .then(result => parentPort.postMessage({ ok: true, result }))
        .catch(err => parentPort.postMessage({ ok: false, error: err.message || String(err) }));
    `;
    let worker;
    try {
      worker = new Worker(workerSrc, {
        eval: true,
        workerData: { args },
        resourceLimits: {
          maxOldGenerationSizeMb: 64,
          maxYoungGenerationSizeMb: 16,
        },
      });
    } catch (e) {
      return reject(new Error(`Failed to start worker: ${e.message}`));
    }

    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error("Custom JS skill timed out after " + timeoutMs + "ms"));
    }, timeoutMs);

    worker.on("message", ({ ok, result, error }) => {
      clearTimeout(timer);
      worker.terminate();
      if (ok) {
        resolve(
          typeof result === "object"
            ? JSON.stringify(result)
            : String(result ?? ""),
        );
      } else {
        reject(new Error(error || "Custom JS skill failed"));
      }
    });
    worker.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    worker.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0)
        reject(new Error(`Custom JS skill worker exited with code ${code}`));
    });
  });
}

async function executeSkill(toolCall, context = {}) {
  const name = toolCall.function.name;
  let args = {};
  try {
    args = JSON.parse(toolCall.function.arguments);
  } catch (e) {}

  switch (name) {
    case "wikipedia":
      return await executeWikipedia(args);
    case "britannica":
      return await executeBritannica(args);
    case "wiktionary":
      return await executeWiktionary(args);
    case "deep_etymology":
      return await executeDeepEtymology(args);
    case "duckduckgo":
      return await executeDuckDuckGo(args, context);
    case "fact_check":
      return await executeFactCheck(args, context);
    case "web_scraper":
      return await executeWebScraper(args);
    case "calculator":
      return await executeCalculator(args);
    case "local_notes":
      return await executeLocalNotes(args, context.dataDir);
    case "time_and_date":
      return await executeTimeAndDate(args);
    case "shell_command":
      if (!context.allowShellCommand) {
        return "Error: shell command execution requires explicit user confirmation.";
      }
      return await executeShellCommand(args);
    default: {
      try {
        const skill = findCustomSkill(name, context.dataDir);
        if (skill) {
          if (skill.type === "shell") {
            if (!context.allowShellCommand) {
              return "Error: shell command execution requires explicit user confirmation.";
            }
            let cmd = skill.code;
            for (const [key, value] of Object.entries(args)) {
              // Shell-escape each substituted value to prevent injection
              const escaped = "'" + String(value).replace(/'/g, "'\\''") + "'";
              cmd = cmd.replace(new RegExp(`{{${key}}}`, "g"), escaped);
            }
            return await executeShellCommand({ command: cmd });
          } else if (skill.type === "javascript") {
            // WARNING: Custom JavaScript skills run in a worker_threads Worker.
            // worker_threads provides memory/CPU isolation but is NOT a full
            // security sandbox — the worker has access to Node.js built-ins.
            // Only use custom JS skills with code you fully trust.
            return await runCustomJsSkill(skill.code, args);
          }
        }
      } catch (e) {
        return `Custom Skill Error (${name}): ${e.message}`;
      }
      return `Unknown skill: ${name}`;
    }
  }
}

module.exports = {
  ALL_SKILLS,
  executeSkill,
  skillRequiresShellConfirmation,
};
