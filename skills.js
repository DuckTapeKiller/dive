const https = require("https");
const { executePluginSkill } = require("./plugins.js");
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
    const lang =
      String(language || "en")
        .toLowerCase()
        .slice(0, 2) || "en";
    const wikiBase = `https://${lang}.wikipedia.org`;
    const searchUrl = `${wikiBase}/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=5&format=json&origin=*`;
    const searchData = await fetchJson(searchUrl);
    const searchArr = searchData?.query?.search || [];
    if (searchArr.length === 0)
      return `No Wikipedia results found for "${query}".`;

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

    let output = `## Wikipedia: ${pageTitle}\n\n`;
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

// ---- Web search. Uses the cloud API keys the user already saved (OpenAI /
// Anthropic / Google) for high-quality provider search, and always falls back
// to keyless DuckDuckGo scraping. Each returns [{ title, url, snippet }]. ----

// DuckDuckGo HTML scrape (no key). Primary html endpoint + lite fallback.
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

// Run the best available backend: whichever cloud key the user has saved
// (OpenAI, then Anthropic, then Google), else keyless DuckDuckGo.
async function runWebSearch(query, limit, cloudKeys = {}) {
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
  return { provider: "duckduckgo", results };
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
// reader pipeline the web_scraper skill uses (Jina Reader, then a Wayback
// Machine snapshot as a last resort).
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
      /Search Britannica|Click here to search|Subscribe|Login|Ask the Chatbot|Games & Quizzes|References & Edit History|Quick Facts|ProCon|verify using Britannica articles/i.test(
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
    // Primary finder: Britannica's own search page through the reader proxy
    // (Britannica 403s direct fetches; the proxy bypasses that) — results are
    // relevance-ranked by Britannica itself and independent of any search
    // engine's rate limits.
    let articleUrl = "";
    try {
      const searchPage = await readUrlContent(
        `https://www.britannica.com/search?query=${encodeURIComponent(query)}`,
        20000,
      );
      if (searchPage.ok) {
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
        articleUrl = exact || containing[0] || links[0] || "";
      }
    } catch {
      /* fall through to web search */
    }
    // Fallback finder: web search restricted to britannica.com.
    if (!articleUrl) {
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
      if (article) articleUrl = article.url.split("#")[0].split("?")[0];
    }
    if (!articleUrl) {
      return `No Britannica article found for "${query}".`;
    }
    const read = await readUrlContent(articleUrl, 6000);
    if (read.ok) {
      const text = cleanBritannicaMarkdown(read.text);
      if (text.length > 120) {
        return `## Britannica: "${query}"\n\n${text}\n\n<!-- ${articleUrl} -->`;
      }
    }
    // Last resort: a Wayback Machine snapshot of the same article.
    try {
      const wb = await fetchJson(
        `http://archive.org/wayback/available?url=${encodeURIComponent(articleUrl)}`,
      );
      const snap = wb?.archived_snapshots?.closest;
      if (snap?.available && snap.url) {
        const wbRead = await readUrlContent(snap.url, 6000);
        if (wbRead.ok) {
          const text = cleanBritannicaMarkdown(wbRead.text);
          if (text.length > 120) {
            return `## Britannica: "${query}"\n\n${text}\n\n<!-- ${articleUrl} (via Wayback snapshot) -->`;
          }
        }
      }
    } catch {
      /* wayback is best-effort */
    }
    return `Britannica article found but its content could not be read: ${articleUrl}`;
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
async function readUrlContent(url, maxChars = 6000) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "Invalid URL." };
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { ok: false, error: "Only http and https URLs are allowed." };
  }
  const h = parsed.hostname.toLowerCase();
  const BLOCKED_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
  const PRIVATE_RANGES = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/;
  if (BLOCKED_HOSTS.has(h) || PRIVATE_RANGES.test(h)) {
    return {
      ok: false,
      error: "Access to local or private network addresses is not allowed.",
    };
  }
  // 1) Jina Reader (clean markdown, no key). Falls through on JSON error.
  try {
    const md = await fetchHtml(`https://r.jina.ai/${url}`, {
      headers: { "X-Return-Format": "markdown" },
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
        text:
          clean.length > maxChars
            ? clean.slice(0, maxChars) + "\n\n... [TRUNCATED]"
            : clean,
      };
    }
  } catch {
    /* fall back to a direct fetch + extraction below */
  }
  // 2) Direct fetch + main-content extraction.
  try {
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
    if (!text) return { ok: false, error: "No readable text found." };
    return {
      ok: true,
      text:
        text.length > maxChars
          ? text.slice(0, maxChars) + "... [TRUNCATED]"
          : text,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
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
  { query, queries, max_sources = 6 },
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
    // Read all chosen pages concurrently, with generous per-source content.
    const reads = await Promise.all(
      picked.map(async (r) => {
        const c = await readUrlContent(r.url, 4500);
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

// Notes live as individual Markdown files in DATA_DIR/notes. The skill
// targets the note currently open in the Notes panel (DATA_DIR/notes/.active),
// falling back to "Notes", so "add this to my notes" lands where the user is
// looking. The legacy single-note notes.json is read as a last resort.
function resolveActiveNoteFile(DATA_DIR) {
  const notesDir = path.join(DATA_DIR, "notes");
  let name = "";
  try {
    name = fs
      .readFileSync(path.join(notesDir, ".active"), "utf8")
      .trim()
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
  } catch {
    name = "";
  }
  if (!name) name = "Notes";
  const filePath = path.join(notesDir, `${name}.md`);
  if (!filePath.startsWith(notesDir + path.sep)) {
    return {
      notesDir,
      name: "Notes",
      filePath: path.join(notesDir, "Notes.md"),
    };
  }
  return { notesDir, name, filePath };
}

async function executeLocalNotes({ action, content }, DATA_DIR) {
  const { notesDir, name, filePath } = resolveActiveNoteFile(DATA_DIR);
  let currentText = "";
  try {
    if (fs.existsSync(filePath)) {
      currentText = fs.readFileSync(filePath, "utf8");
    } else {
      // Legacy fallback: the old single-note blob.
      const legacyFile = path.join(DATA_DIR, "notes.json");
      if (fs.existsSync(legacyFile)) {
        const raw = JSON.parse(fs.readFileSync(legacyFile, "utf8"));
        currentText = raw.text || "";
      }
    }
  } catch (e) {}

  if (action === "read") {
    return currentText
      ? `[Note: ${name}]\n\n${currentText}`
      : "Your notes are currently empty.";
  } else if (action === "append") {
    if (!content) return "Error: Content is required for append action.";
    const newText = currentText ? `${currentText}\n\n${content}` : content;
    fs.mkdirSync(notesDir, { recursive: true });
    fs.writeFileSync(filePath, newText, "utf8");
    return `Successfully appended to your note "${name}".`;
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
        "Looks up a single Wikipedia article summary. Use ONLY when the user explicitly asks for Wikipedia. For general factual, biographical, or research questions, use deep_research instead (it reads Wikipedia AND several other independent sources in one step).",
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
      name: "book_search",
      description:
        "Searches a net of book providers (Open Library, Google Books, Goodreads, StoryGraph, and configured Hardcover/LibraryThing/Calibre) in parallel for book metadata, merges the results and returns a ready-made markdown table plus description and sources. Use for any question about a book's publication details, editions or metadata. The query can be a title, an author, or an ISBN. IMPORTANT: this tool's output is already formatted for the user — reproduce the returned markdown table (and description) VERBATIM in your reply; do not paraphrase it into prose.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Book title, author name, or ISBN (10 or 13 digits)",
          },
          language: {
            type: "string",
            description: "Optional 2-letter language preference, e.g. 'es'",
          },
          provider: {
            type: "string",
            description:
              "Optional: restrict to one source (openlibrary, google, goodreads, storygraph, hardcover, librarything, calibre)",
          },
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
        "Quick web search that returns a numbered list of results (title, snippet, URL). Use for a single lookup. For any 'who/what is', biographical, or research question that needs a THOROUGH answer, use the deep_research skill instead. Never repeat the same query twice.",
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
      name: "deep_research",
      description:
        "PREFERRED for any factual, biographical, current-events, or 'who/what is X' question. In ONE call it searches the web across multiple angles and reads several independent sources (different websites), returning their full content plus every source URL. For thorough coverage, pass 'queries' with 2-4 VARIED angles (different phrasing and scope), e.g. ['Dean Benedetti biography', 'Dean Benedetti Charlie Parker recordings', 'Dean Benedetti jazz history'] — not one query. After it returns, write a comprehensive, multi-paragraph answer that synthesizes ALL the sources.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "A single research topic/question. Prefer 'queries' with multiple angles for thorough research.",
          },
          queries: {
            type: "array",
            items: { type: "string" },
            description:
              "2-4 varied search angles (different phrasing/scope) for broad coverage. Preferred over a single query.",
          },
          max_sources: {
            type: "number",
            description: "How many sources to read (4-8, default 6).",
          },
        },
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

// ============================================================================
// BOOK SEARCH — port of the global-book-search Obsidian plugin (same author).
// A net of providers searched in parallel, results grouped by work, editions
// scored, fields merged with per-field source priority and conflict notes,
// then mutually enriched (missing description/cover/pages filled from the
// other sources). Keyless: Open Library, Google Books, Goodreads, StoryGraph.
// Config-gated (book-search.json in the data dir): Hardcover token,
// LibraryThing Talpa token, Calibre server, Google API key.
// ============================================================================

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

// --- Providers -------------------------------------------------------------

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

// --- Orchestration ----------------------------------------------------------

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
      return await executeBritannica(args, context);
    case "book_search":
      return await executeBookSearch(args, context);
    case "wiktionary":
      return await executeWiktionary(args);
    case "deep_etymology":
      return await executeDeepEtymology(args);
    case "duckduckgo":
      return await executeDuckDuckGo(args, context);
    case "deep_research":
      return await executeDeepResearch(args, context);
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
      // Plugin skills (loaded from ~/dive/plugins) take precedence over the
      // UI-defined custom skills; executePluginSkill returns null when no
      // plugin registered this name.
      const pluginResult = await executePluginSkill(name, args, context);
      if (pluginResult !== null) return pluginResult;
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
