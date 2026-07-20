const https = require("https");
const {
  executePluginSkill,
  pluginSkillRequiresConfirmation,
} = require("./plugins.js");
const http = require("http");
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");
const os = require("os");
const vm = require("vm");
const { exec, execFile } = require("child_process");
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

// SSRF guard shared by web_scraper, deep_research and http_request: only
// http(s), and never local or private network addresses. Returns an error
// string, or null when the URL is safe to fetch.
function urlGuardError(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return "Invalid URL.";
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return "Only http and https URLs are allowed.";
  }
  const h = parsed.hostname.toLowerCase();
  const BLOCKED_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
  const PRIVATE_RANGES = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/;
  if (BLOCKED_HOSTS.has(h) || PRIVATE_RANGES.test(h)) {
    return "Access to local or private network addresses is not allowed.";
  }
  return null;
}

// Read a URL's main content as clean text. SSRF-guarded. Tries Jina Reader for
// LLM-ready markdown, then a direct fetch + boilerplate strip. Returns
// { ok, text } or { ok:false, error }. Shared by web_scraper and deep_research.
async function readUrlContent(url, maxChars = 6000) {
  const guardError = urlGuardError(url);
  if (guardError) return { ok: false, error: guardError };
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

// --- Academic Search Implementation ---
// Keyless federated scholarly search across OpenAlex, Crossref, arXiv,
// Semantic Scholar, and PubMed. Providers are queried in parallel and each
// failure is tolerated independently; results are merged and de-duplicated
// by DOI (then by normalized title).

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
      doi: normalizeDoi(entry.find("doi").first().text()),
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
      const guardError = urlGuardError(pdfCandidate);
      if (!guardError) {
        try {
          // Global fetch follows the redirects OA PDF links routinely use.
          const res = await fetch(pdfCandidate, {
            headers: { "User-Agent": "Mozilla/5.0" },
            signal: AbortSignal.timeout(45000),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const bytes = Buffer.from(await res.arrayBuffer());
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

async function executeShellCommand({ command, timeout_seconds, cwd }) {
  console.warn(`[shell_command] Executing: ${String(command).slice(0, 200)}`);
  const timeoutMs =
    Math.max(1, Math.min(Number(timeout_seconds) || 5, 300)) * 1000;
  let workDir = os.homedir();
  if (cwd && String(cwd).trim()) {
    const resolved = resolveAllowedPath(String(cwd).trim(), {
      allowHome: true,
    });
    if (resolved.error) return `Shell Command Error: cwd — ${resolved.error}`;
    workDir = resolved.target;
  }
  return new Promise((resolve) => {
    exec(
      command,
      { timeout: timeoutMs, cwd: workDir, maxBuffer: 8 * 1024 * 1024 },
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

// ============================================================================
// CODING & COMPUTER MANAGEMENT — code_search and git_tools are read-only and
// confined to the user-editable allowlist in ~/dive/allowed-dirs.json;
// run_python and macos_control mutate state and are confirmation-gated (see
// skillRequiresShellConfirmation). The read-only/mutating split keeps the
// name-based confirmation gate sufficient.
// ============================================================================

const ALLOWED_DIRS_FILE = path.join(os.homedir(), "dive", "allowed-dirs.json");
const CODING_SETTINGS_FILE = path.join(
  os.homedir(),
  "dive",
  "coding-settings.json",
);
const CODE_SEARCH_MAX_MATCHES = 200;
const CODE_SEARCH_MAX_FILE_BYTES = 2 * 1024 * 1024;
const CODE_SEARCH_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "build",
  ".next",
  "target",
]);

function expandHomePath(value) {
  const trimmed = String(value || "").trim();
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/"))
    return path.join(os.homedir(), trimmed.slice(2));
  return trimmed;
}

// The allowlist of directories the coding skills may read. Users edit the
// JSON directly; the workspace sandbox is always included.
function loadAllowedDirs() {
  const dirs = [path.join(os.homedir(), "dive", "workspace")];
  try {
    const raw = JSON.parse(fs.readFileSync(ALLOWED_DIRS_FILE, "utf8"));
    for (const entry of raw.directories || []) {
      const expanded = expandHomePath(entry);
      if (expanded && path.isAbsolute(expanded)) dirs.push(expanded);
    }
  } catch {
    /* no file yet — workspace-only defaults apply */
  }
  return [...new Set(dirs)];
}

// Resolve a path and verify it sits inside an allowed directory (realpath
// prefix check, so symlinks cannot escape). options.allowHome additionally
// accepts anything under the home directory (used by shell_command's cwd,
// which is already confirmation-gated).
function resolveAllowedPath(rawPath, options = {}) {
  const expanded = expandHomePath(rawPath);
  if (!path.isAbsolute(expanded)) {
    return { error: `Path must be absolute or start with ~/: ${rawPath}` };
  }
  let real;
  try {
    real = fs.realpathSync(expanded);
  } catch {
    return { error: `Path does not exist: ${expanded}` };
  }
  const roots = loadAllowedDirs();
  if (options.allowHome) roots.push(os.homedir());
  for (const root of roots) {
    let realRoot;
    try {
      realRoot = fs.realpathSync(root);
    } catch {
      continue;
    }
    if (real === realRoot || real.startsWith(realRoot + path.sep)) {
      return { target: real };
    }
  }
  return {
    error:
      `Path is outside the allowed directories. Allowed roots: ` +
      `${roots.join(", ")}. The user can add more in ~/dive/allowed-dirs.json ` +
      `({"directories": ["~/some/project"]}).`,
  };
}

function walkAllowedTree(dir, onFile, depth = 0) {
  if (depth > 12) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || CODE_SEARCH_SKIP_DIRS.has(entry.name)) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (walkAllowedTree(full, onFile, depth + 1) === false) return false;
    } else if (entry.isFile()) {
      if (onFile(full) === false) return false;
    }
  }
}

function globToRegex(glob) {
  const escaped = String(glob)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`(^|/)${escaped}$`, "i");
}

async function executeCodeSearch({
  action,
  path: targetPath,
  pattern,
  glob,
  start_line,
  end_line,
  max_results,
}) {
  const act = ["grep", "find", "read", "tree"].includes(action) ? action : null;
  if (!act) {
    return "Code Search Error: action must be grep, find, read, or tree.";
  }
  const resolved = resolveAllowedPath(targetPath || "~/dive/workspace");
  if (resolved.error) return `Code Search Error: ${resolved.error}`;
  const target = resolved.target;
  const cap = Math.max(
    1,
    Math.min(Number(max_results) || 50, CODE_SEARCH_MAX_MATCHES),
  );

  try {
    if (act === "read") {
      const stat = fs.statSync(target);
      if (!stat.isFile()) return `Code Search Error: not a file: ${target}`;
      if (stat.size > CODE_SEARCH_MAX_FILE_BYTES) {
        return `Code Search Error: file exceeds ${CODE_SEARCH_MAX_FILE_BYTES / 1024 / 1024} MB; read a line range of a smaller file.`;
      }
      const lines = fs.readFileSync(target, "utf8").split("\n");
      const from = Math.max(1, Number(start_line) || 1);
      const to = Math.min(lines.length, Number(end_line) || from + 399);
      const body = lines
        .slice(from - 1, to)
        .map((l, i) => `${String(from + i).padStart(5)}  ${l}`)
        .join("\n");
      return `## ${target} (lines ${from}-${to} of ${lines.length})\n\n${body}`;
    }

    if (act === "tree") {
      const stat = fs.statSync(target);
      if (!stat.isDirectory())
        return `Code Search Error: not a directory: ${target}`;
      const rows = [];
      const list = (dir, prefix, depth) => {
        if (depth > 3 || rows.length >= 300) return;
        let entries;
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (
            entry.name.startsWith(".") ||
            CODE_SEARCH_SKIP_DIRS.has(entry.name)
          )
            continue;
          if (rows.length >= 300) return;
          rows.push(`${prefix}${entry.name}${entry.isDirectory() ? "/" : ""}`);
          if (entry.isDirectory())
            list(path.join(dir, entry.name), prefix + "  ", depth + 1);
        }
      };
      list(target, "", 0);
      return `## ${target}\n\n${rows.join("\n") || "(empty)"}${rows.length >= 300 ? "\n… (truncated at 300 entries)" : ""}`;
    }

    if (act === "find") {
      if (!glob && !pattern) {
        return "Code Search Error: find needs a glob (e.g. '*.py' or '**/config*').";
      }
      const rx = globToRegex(glob || pattern);
      const hits = [];
      walkAllowedTree(target, (file) => {
        if (rx.test(file)) hits.push(file);
        if (hits.length >= cap) return false;
      });
      return hits.length
        ? `## find ${glob || pattern} under ${target} (${hits.length} matches)\n\n${hits.join("\n")}`
        : `No files matching ${glob || pattern} under ${target}.`;
    }

    // act === "grep"
    if (!pattern) return "Code Search Error: grep needs a pattern (regex).";
    let rx;
    try {
      rx = new RegExp(pattern, "i");
    } catch (e) {
      return `Code Search Error: invalid regex — ${e.message}`;
    }
    const fileFilter = glob ? globToRegex(glob) : null;
    const hits = [];
    const stat = fs.statSync(target);
    const scanFile = (file) => {
      if (fileFilter && !fileFilter.test(file)) return;
      let statF;
      try {
        statF = fs.statSync(file);
      } catch {
        return;
      }
      if (statF.size > CODE_SEARCH_MAX_FILE_BYTES) return;
      let content;
      try {
        content = fs.readFileSync(file, "utf8");
      } catch {
        return;
      }
      if (content.includes("\u0000")) return; // binary
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        if (rx.test(lines[i])) {
          hits.push(`${file}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          if (hits.length >= cap) return false;
        }
      }
    };
    if (stat.isFile()) scanFile(target);
    else walkAllowedTree(target, scanFile);
    return hits.length
      ? `## grep /${pattern}/ under ${target} (${hits.length} matches${hits.length >= cap ? ", capped" : ""})\n\n${hits.join("\n")}`
      : `No matches for /${pattern}/ under ${target}.`;
  } catch (e) {
    return `Code Search Error: ${e.message}`;
  }
}

// Read-only git subcommands via argv arrays — no shell, no mutation. Anything
// that writes (commit, push, checkout, …) must go through the gated
// shell_command skill instead.
const GIT_READONLY_ACTIONS = {
  status: () => ["status", "--short", "--branch"],
  log: (a) => [
    "log",
    `--max-count=${Math.max(1, Math.min(Number(a.count) || 20, 100))}`,
    "--oneline",
    "--decorate",
    ...(a.path_filter ? ["--", String(a.path_filter)] : []),
  ],
  diff: (a) => [
    "diff",
    ...(a.ref ? [String(a.ref)] : []),
    "--stat",
    "--patch",
    ...(a.path_filter ? ["--", String(a.path_filter)] : []),
  ],
  show: (a) => ["show", "--stat", "--patch", String(a.ref || "HEAD")],
  branch: () => ["branch", "--all", "--verbose"],
  blame: (a) => [
    "blame",
    ...(a.start_line && a.end_line
      ? ["-L", `${Number(a.start_line)},${Number(a.end_line)}`]
      : []),
    "--",
    String(a.path_filter || ""),
  ],
};

async function executeGitTools(args) {
  const action = GIT_READONLY_ACTIONS[args.action] ? args.action : null;
  if (!action) {
    return `Git Tools Error: action must be one of ${Object.keys(GIT_READONLY_ACTIONS).join(", ")}.`;
  }
  if (action === "blame" && !args.path_filter) {
    return "Git Tools Error: blame requires path_filter (the file to blame).";
  }
  const resolved = resolveAllowedPath(args.repo || "~/dive/workspace");
  if (resolved.error) return `Git Tools Error: ${resolved.error}`;
  // Refs and paths become argv entries, never shell text; reject option-like
  // values so they cannot be smuggled in as git flags.
  for (const field of ["ref", "path_filter"]) {
    if (args[field] && String(args[field]).startsWith("-")) {
      return `Git Tools Error: ${field} must not start with '-'.`;
    }
  }
  const gitArgs = GIT_READONLY_ACTIONS[action](args).filter(Boolean);
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", resolved.target, "--no-pager", ...gitArgs],
      { timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && !stdout) {
          resolve(
            `Git Tools Error: ${(stderr || error.message).trim().slice(0, 2000)}`,
          );
          return;
        }
        const body = String(stdout || "").slice(0, 40000);
        resolve(
          `## git ${gitArgs.join(" ")} @ ${resolved.target}\n\n${body || "(no output)"}${stderr ? `\n\nstderr:\n${String(stderr).slice(0, 1000)}` : ""}`,
        );
      },
    );
  });
}

function loadCodingSettings() {
  try {
    return JSON.parse(fs.readFileSync(CODING_SETTINGS_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function executeRunPython({ code, timeout_seconds }, dataDir) {
  if (!code || !String(code).trim()) {
    return "Run Python Error: no code provided.";
  }
  const timeoutMs =
    Math.max(1, Math.min(Number(timeout_seconds) || 30, 120)) * 1000;
  const settings = loadCodingSettings();
  let python = "python3";
  if (settings.pythonVenv) {
    const candidate = path.join(
      expandHomePath(settings.pythonVenv),
      "bin",
      "python3",
    );
    if (fs.existsSync(candidate)) python = candidate;
  }
  const runDir = path.join(
    dataDir || path.join(os.homedir(), "dive"),
    "workspace",
    ".run",
  );
  fs.mkdirSync(runDir, { recursive: true });
  const scriptPath = path.join(
    runDir,
    `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.py`,
  );
  fs.writeFileSync(scriptPath, String(code), "utf8");
  return new Promise((resolve) => {
    execFile(
      python,
      [scriptPath],
      {
        timeout: timeoutMs,
        cwd: path.dirname(runDir),
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env,
          PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ""}`,
        },
      },
      (error, stdout, stderr) => {
        fs.rmSync(scriptPath, { force: true });
        let output = "";
        if (stdout) output += `STDOUT:\n${String(stdout).slice(0, 20000)}\n`;
        if (stderr) output += `STDERR:\n${String(stderr).slice(0, 8000)}\n`;
        if (error) {
          output += error.killed
            ? `ERROR: timed out after ${timeoutMs / 1000}s\n`
            : `ERROR: exit ${error.code}\n`;
        }
        resolve(output || "Python script ran with no output.");
      },
    );
  });
}

const MACOS_CONTROL_ACTIONS = new Set([
  "run_applescript",
  "open",
  "notify",
  "list_processes",
  "kill_process",
]);

async function executeMacosControl(args) {
  const action = MACOS_CONTROL_ACTIONS.has(args.action) ? args.action : null;
  if (!action) {
    return `macOS Control Error: action must be one of ${[...MACOS_CONTROL_ACTIONS].join(", ")}.`;
  }
  const run = (cmd, argv, timeout = 30000) =>
    new Promise((resolve) => {
      execFile(
        cmd,
        argv,
        { timeout, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => {
          resolve({
            code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
            stdout: String(stdout || ""),
            stderr: String(stderr || (error && error.message) || ""),
          });
        },
      );
    });
  try {
    switch (action) {
      case "run_applescript": {
        if (!args.script || !String(args.script).trim()) {
          return "macOS Control Error: run_applescript needs script.";
        }
        const r = await run("osascript", ["-e", String(args.script)], 60000);
        return r.code === 0
          ? `AppleScript result:\n${r.stdout.trim() || "(no output)"}`
          : `AppleScript failed:\n${r.stderr.trim().slice(0, 2000)}`;
      }
      case "open": {
        const target = String(args.target || "").trim();
        if (!target) {
          return "macOS Control Error: open needs target (file path, URL, or app name).";
        }
        const argv = args.app
          ? ["-a", String(args.app), expandHomePath(target)]
          : /^[a-z]+:\/\//i.test(target)
            ? [target]
            : [expandHomePath(target)];
        const r = await run("open", argv);
        return r.code === 0
          ? `Opened ${target}${args.app ? ` with ${args.app}` : ""}.`
          : `Open failed: ${r.stderr.trim().slice(0, 1000)}`;
      }
      case "notify": {
        const message = String(args.message || "").trim();
        if (!message) return "macOS Control Error: notify needs message.";
        const esc = (s) =>
          String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        const script = `display notification "${esc(message)}" with title "${esc(args.title || "Dive")}"`;
        const r = await run("osascript", ["-e", script]);
        return r.code === 0
          ? "Notification shown."
          : `Notify failed: ${r.stderr.trim()}`;
      }
      case "list_processes": {
        const r = await run("ps", ["aux", "-r"]);
        const lines = r.stdout.split("\n");
        const filter = args.filter ? String(args.filter).toLowerCase() : "";
        const kept = filter
          ? [
              lines[0],
              ...lines.slice(1).filter((l) => l.toLowerCase().includes(filter)),
            ]
          : lines;
        return `## Processes${filter ? ` matching "${args.filter}"` : " (top CPU)"}\n\n${kept.slice(0, 40).join("\n")}`;
      }
      case "kill_process": {
        const pid = Number(args.pid);
        if (!Number.isInteger(pid) || pid <= 1) {
          return "macOS Control Error: kill_process needs a valid pid.";
        }
        const r = await run("kill", [args.force ? "-9" : "-15", String(pid)]);
        return r.code === 0
          ? `Sent ${args.force ? "SIGKILL" : "SIGTERM"} to PID ${pid}.`
          : `Kill failed: ${r.stderr.trim() || "process may not exist or belongs to another user"}`;
      }
      default:
        return "macOS Control Error: unsupported action.";
    }
  } catch (e) {
    return `macOS Control Error: ${e.message}`;
  }
}

// ============================================================================
// HTTP REQUEST — agent-grade HTTP client. Unlike web_scraper (which extracts
// readable text for humans), this returns the raw response with status code
// and headers, supports every method, custom headers, request bodies, and
// per-session cookie jars so multi-step API flows (login -> fetch) work.
// SSRF-guarded like web_scraper. In-memory jars only; nothing is persisted.
// ============================================================================

const HTTP_SESSION_JARS = new Map(); // session name -> Map(host -> Map(cookieName -> value))
const HTTP_BODY_MAX_CHARS = 8000;

function jarFor(session, host) {
  if (!HTTP_SESSION_JARS.has(session))
    HTTP_SESSION_JARS.set(session, new Map());
  const byHost = HTTP_SESSION_JARS.get(session);
  if (!byHost.has(host)) byHost.set(host, new Map());
  return byHost.get(host);
}

function storeSetCookies(jar, setCookieHeaders) {
  for (const raw of setCookieHeaders || []) {
    const pair = String(raw).split(";")[0];
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

function cookieHeaderFrom(jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

// One raw request; resolves { statusCode, headers, body } with the body
// decompressed. Does NOT follow redirects itself — the caller does, so each
// hop's Set-Cookie lands in the jar.
function rawHttpRequest(url, { method, headers, body, timeout }) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.request(url, { method, headers }, (res) => {
      const enc = String(res.headers["content-encoding"] || "").toLowerCase();
      let stream = res;
      if (enc === "gzip") stream = res.pipe(zlib.createGunzip());
      else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
      else if (enc === "br") stream = res.pipe(zlib.createBrotliDecompress());
      const chunks = [];
      stream.on("data", (c) => chunks.push(c));
      stream.on("end", () =>
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
      stream.on("error", reject);
    });
    req.setTimeout(timeout, () => req.destroy(new Error("Request timed out")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function executeHttpRequest({
  url,
  method = "GET",
  headers = {},
  body,
  timeout_ms,
  follow_redirects = true,
  session,
}) {
  try {
    const verb = String(method || "GET").toUpperCase();
    if (
      !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(
        verb,
      )
    ) {
      return `HTTP Request Error: unsupported method "${method}".`;
    }
    const timeout = Math.max(
      1000,
      Math.min(Number(timeout_ms) || REQUEST_TIMEOUT_MS, 60000),
    );
    const sessionName =
      typeof session === "string" && session.trim() ? session.trim() : "";
    let currentUrl = url;
    let payload =
      body === undefined || body === null
        ? undefined
        : typeof body === "string"
          ? body
          : JSON.stringify(body);
    let response = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const guardError = urlGuardError(currentUrl);
      if (guardError) return `HTTP Request Error: ${guardError}`;
      const host = new URL(currentUrl).hostname.toLowerCase();
      const jar = sessionName ? jarFor(sessionName, host) : null;
      const reqHeaders = {
        "User-Agent": "Dive-Agent/1.0",
        "Accept-Encoding": "gzip, deflate, br",
        ...(headers && typeof headers === "object" ? headers : {}),
      };
      if (
        payload !== undefined &&
        !("Content-Type" in reqHeaders) &&
        !("content-type" in reqHeaders)
      ) {
        reqHeaders["Content-Type"] =
          typeof body === "object" ? "application/json" : "text/plain";
      }
      if (jar && jar.size && !reqHeaders.Cookie && !reqHeaders.cookie) {
        reqHeaders.Cookie = cookieHeaderFrom(jar);
      }
      response = await rawHttpRequest(currentUrl, {
        method: verb,
        headers: reqHeaders,
        body: payload,
        timeout,
      });
      if (jar) storeSetCookies(jar, response.headers["set-cookie"]);
      const isRedirect =
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location;
      if (!isRedirect || follow_redirects === false) break;
      if (hop === MAX_REDIRECTS)
        return "HTTP Request Error: too many redirects.";
      currentUrl = new URL(response.headers.location, currentUrl).toString();
      // Per HTTP semantics, redirects after POST are re-requested as GET.
      if (verb !== "GET" && verb !== "HEAD") payload = undefined;
    }
    const shownHeaders = {};
    for (const key of [
      "content-type",
      "content-length",
      "location",
      "retry-after",
      "x-ratelimit-remaining",
      "www-authenticate",
    ]) {
      if (response.headers[key]) shownHeaders[key] = response.headers[key];
    }
    let bodyText = String(response.body || "");
    const contentType = String(response.headers["content-type"] || "");
    if (/json/i.test(contentType)) {
      try {
        bodyText = JSON.stringify(JSON.parse(bodyText), null, 2);
      } catch {
        /* leave the body as-is */
      }
    }
    if (bodyText.length > HTTP_BODY_MAX_CHARS) {
      bodyText =
        bodyText.slice(0, HTTP_BODY_MAX_CHARS) + "\n... [BODY TRUNCATED]";
    }
    let out = `HTTP ${response.statusCode} — ${verb} ${currentUrl}\n`;
    out += `Headers: ${JSON.stringify(shownHeaders)}\n`;
    if (sessionName) {
      out += `Cookie session: "${sessionName}" (cookies persist across http_request calls with this session name)\n`;
    }
    out += `\n${bodyText || "(empty body)"}`;
    return out;
  } catch (e) {
    return `HTTP Request Error: ${e.message}`;
  }
}

// ============================================================================
// RUN CODE — executes a model-written JavaScript snippet in an isolated
// worker_threads Worker with a hard timeout and memory limits. Same isolation
// caveats as custom JS skills (workers can require Node built-ins), which is
// why every call is gated behind the same explicit user confirmation as
// shell_command. Console output is captured and returned with the result.
// ============================================================================

function executeRunCode({ code, timeout_ms }) {
  const source = String(code || "");
  if (!source.trim()) {
    return Promise.resolve("Run Code Error: no code provided.");
  }
  const timeout = Math.max(1000, Math.min(Number(timeout_ms) || 15000, 60000));
  return new Promise((resolve) => {
    const workerSrc = `
      const { parentPort } = require('worker_threads');
      const logs = [];
      const fmt = (v) => {
        if (typeof v === 'string') return v;
        try { return JSON.stringify(v); } catch { return String(v); }
      };
      for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
        console[level] = (...a) => logs.push(a.map(fmt).join(' '));
      }
      (async () => {
        ${source}
      })()
        .then((result) => parentPort.postMessage({ ok: true, result, logs }))
        .catch((err) => parentPort.postMessage({
          ok: false, error: (err && err.stack) || String(err), logs,
        }));
    `;
    let worker;
    try {
      worker = new Worker(workerSrc, {
        eval: true,
        resourceLimits: {
          maxOldGenerationSizeMb: 128,
          maxYoungGenerationSizeMb: 32,
        },
      });
    } catch (e) {
      return resolve(`Run Code Error: failed to start worker: ${e.message}`);
    }
    const finish = (text) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(text);
    };
    const timer = setTimeout(
      () => finish(`Run Code Error: timed out after ${timeout}ms.`),
      timeout,
    );
    worker.on("message", ({ ok, result, logs, error }) => {
      let out = "";
      if (logs && logs.length) out += `Console output:\n${logs.join("\n")}\n\n`;
      if (ok) {
        const value =
          result === undefined
            ? ""
            : typeof result === "object"
              ? JSON.stringify(result, null, 2)
              : String(result);
        if (value) out += `Return value:\n${value}`;
        finish(
          out.trim() ||
            "Code ran successfully with no output. Use console.log or a return statement to produce output.",
        );
      } else {
        finish((out + `Error:\n${error}`).trim());
      }
    });
    worker.on("error", (err) => finish(`Run Code Error: ${err.message}`));
    worker.on("exit", (exitCode) => {
      if (exitCode !== 0)
        finish(`Run Code Error: worker exited with code ${exitCode}.`);
    });
  });
}

// ============================================================================
// FILE OPERATIONS — read/write/list/find inside a dedicated workspace folder
// (DATA_DIR/workspace). Everything is confined to that folder by a resolved-
// path check, which is why this skill does not need the shell confirmation
// gate: it can touch nothing outside its sandbox.
// ============================================================================

const FILE_READ_MAX_CHARS = 50000;
const FILE_FIND_MAX_RESULTS = 100;

function resolveWorkspacePath(dataDir, relPath) {
  const root = path.join(dataDir, "workspace");
  const target = path.resolve(root, String(relPath || "."));
  if (target !== root && !target.startsWith(root + path.sep)) {
    return {
      error: "Path escapes the workspace. Use relative paths inside it.",
    };
  }
  return { root, target };
}

function walkWorkspace(dir, root, matcher, results) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (results.length >= FILE_FIND_MAX_RESULTS) return;
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (matcher(entry.name)) {
      results.push(
        path.relative(root, full) + (entry.isDirectory() ? "/" : ""),
      );
    }
    if (entry.isDirectory()) walkWorkspace(full, root, matcher, results);
  }
}

async function executeFileOperations(
  { action, path: relPath, content, pattern },
  dataDir,
) {
  if (!dataDir) return "File Operations Error: no data directory available.";
  const resolved = resolveWorkspacePath(dataDir, relPath);
  if (resolved.error) return `File Operations Error: ${resolved.error}`;
  const { root, target } = resolved;
  const rel = path.relative(root, target) || ".";
  try {
    fs.mkdirSync(root, { recursive: true });
    switch (action) {
      case "list": {
        const entries = fs.readdirSync(target, { withFileTypes: true });
        if (!entries.length) return `Directory "${rel}" is empty.`;
        const lines = entries.map((e) => {
          if (e.isDirectory()) return `${e.name}/`;
          const size = fs.statSync(path.join(target, e.name)).size;
          return `${e.name} (${size} bytes)`;
        });
        return `Contents of workspace/${rel}:\n${lines.join("\n")}`;
      }
      case "read": {
        const text = fs.readFileSync(target, "utf8");
        return text.length > FILE_READ_MAX_CHARS
          ? text.slice(0, FILE_READ_MAX_CHARS) + "\n... [FILE TRUNCATED]"
          : text || "(empty file)";
      }
      case "write":
      case "append": {
        if (typeof content !== "string") {
          return "File Operations Error: 'content' (string) is required for write/append.";
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        if (action === "append") fs.appendFileSync(target, content, "utf8");
        else fs.writeFileSync(target, content, "utf8");
        return `${action === "append" ? "Appended to" : "Wrote"} workspace/${rel} (${content.length} chars).`;
      }
      case "delete": {
        const stat = fs.statSync(target);
        if (stat.isDirectory()) fs.rmdirSync(target);
        else fs.unlinkSync(target);
        return `Deleted workspace/${rel}.`;
      }
      case "mkdir": {
        fs.mkdirSync(target, { recursive: true });
        return `Created directory workspace/${rel}.`;
      }
      case "info": {
        const stat = fs.statSync(target);
        return (
          `workspace/${rel}: ${stat.isDirectory() ? "directory" : "file"}, ` +
          `${stat.size} bytes, modified ${stat.mtime.toISOString()}`
        );
      }
      case "find": {
        const glob = String(pattern || "*");
        const re = new RegExp(
          "^" +
            glob
              .replace(/[.+^${}()|[\]\\]/g, "\\$&")
              .replace(/\*/g, ".*")
              .replace(/\?/g, ".") +
            "$",
          "i",
        );
        const results = [];
        walkWorkspace(target, root, (name) => re.test(name), results);
        if (!results.length)
          return `No files matching "${glob}" under workspace/${rel}.`;
        let out = `Files matching "${glob}":\n${results.join("\n")}`;
        if (results.length >= FILE_FIND_MAX_RESULTS)
          out += "\n... [MORE RESULTS OMITTED]";
        return out;
      }
      default:
        return "File Operations Error: invalid action. Use list, read, write, append, delete, mkdir, info, or find.";
    }
  } catch (e) {
    if (e.code === "ENOENT")
      return `File Operations Error: "${rel}" does not exist.`;
    if (e.code === "ENOTEMPTY")
      return `File Operations Error: directory "${rel}" is not empty.`;
    return `File Operations Error: ${e.message}`;
  }
}

function findCustomSkill(name, dataDir) {
  if (!dataDir) return null;
  const customSkillsFile = path.join(dataDir, "custom_skills.json");
  if (!fs.existsSync(customSkillsFile)) return null;
  const skills = JSON.parse(fs.readFileSync(customSkillsFile, "utf8"));
  if (!Array.isArray(skills)) return null;
  return skills.find((skill) => skill && skill.name === name) || null;
}

const GATED_BUILTIN_SKILLS = new Set([
  "shell_command",
  "run_code",
  "run_python",
  "macos_control",
]);

function skillRequiresShellConfirmation(name, dataDir) {
  if (GATED_BUILTIN_SKILLS.has(name)) return true;
  try {
    if (pluginSkillRequiresConfirmation(name)) return true;
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
          academic: {
            type: "boolean",
            description:
              "Set true for scholarly topics: seeds the source pool with peer-reviewed papers (OpenAlex/Crossref/arXiv/Semantic Scholar/PubMed) and prefers .edu/.gov/journal domains.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "academic_search",
      description:
        "PREFERRED for scholarly/scientific questions: searches OpenAlex, Crossref, arXiv, Semantic Scholar, and PubMed in one keyless call and returns merged, de-duplicated papers with authors, year, venue, DOI, citation counts, abstracts, and open-access PDF links. Use for literature reviews, 'what does the research say about X', finding papers by topic/author, or verifying scientific claims. Follow up with fetch_paper on the most relevant open-access results, then answer citing authors and years.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Scholarly search query (topic, phenomenon, author, paper title). English queries get the best coverage.",
          },
          year_from: {
            type: "number",
            description: "Earliest publication year to include.",
          },
          year_to: {
            type: "number",
            description: "Latest publication year to include.",
          },
          max_results: {
            type: "number",
            description: "How many papers to return (3-25, default 12).",
          },
          providers: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional subset of providers: openalex, crossref, arxiv, semanticscholar, pubmed. Omit to query all.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_paper",
      description:
        "Fetches a scientific paper by DOI, arXiv link, or URL: resolves its metadata, reads the full text or abstract, and saves the open-access PDF into workspace/papers/ when one exists. Use after academic_search to actually read the papers you plan to cite.",
      parameters: {
        type: "object",
        properties: {
          url_or_doi: {
            type: "string",
            description:
              "A DOI (10.xxxx/...), a doi.org URL, an arXiv abs/pdf URL, or any paper landing-page/PDF URL.",
          },
          save: {
            type: "boolean",
            description:
              "Save the open-access PDF into workspace/papers/ (default true).",
          },
        },
        required: ["url_or_doi"],
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
      name: "remember_lesson",
      description:
        "Permanently saves a short lesson, correction, or preference the user taught you (e.g. formatting rules, terminology, standing instructions). The lesson is injected into your system prompt in every future conversation of the CURRENT mode only (each mode keeps independent lessons). Use when the user corrects you or says something like 'remember this' or 'from now on'.",
      parameters: {
        type: "object",
        properties: {
          lesson: {
            type: "string",
            description:
              "The lesson as one short imperative sentence, e.g. 'Always answer in Spanish unless asked otherwise.'",
          },
        },
        required: ["lesson"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_plugin",
      description:
        "Drafts a new Dive plugin (a reusable skill) for the user to review. The draft is saved DISABLED and only becomes active after the user approves it in Settings > Skills > Plugins. Use when the user asks you to build a new tool/skill/capability for the app.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Plugin name in kebab-case, e.g. 'weather-lookup'",
          },
          description: {
            type: "string",
            description: "One sentence: what the plugin does.",
          },
          code: {
            type: "string",
            description:
              "Complete CommonJS module source for index.js following the Dive plugin format: module.exports = { skills: [{ name, description, parameters, async execute(args, context) { ... } }] }. No external npm dependencies.",
          },
        },
        required: ["name", "description", "code"],
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
      description:
        "Executes a shell command on the local machine (macOS). Default timeout is 5 seconds — pass timeout_seconds for longer work (max 300). cwd sets the working directory (home or an allowed directory).",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute.",
          },
          timeout_seconds: {
            type: "number",
            description: "Timeout in seconds (default 5, max 300).",
          },
          cwd: {
            type: "string",
            description:
              "Working directory (absolute or ~/ path inside home or the allowed directories). Defaults to the home directory.",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "http_request",
      description:
        "Full-control HTTP client for calling APIs: any method, custom headers (auth tokens, API keys, Accept), request body, timeout, and optional named cookie sessions that persist across calls (login then fetch). Returns the status code, key response headers, and the raw body (JSON pretty-printed). Use this for REST/JSON APIs and endpoints that need specific headers; use web_scraper instead when you just want the readable text of a web page.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The full URL to request." },
          method: {
            type: "string",
            enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
            description: "HTTP method. Defaults to GET.",
          },
          headers: {
            type: "object",
            description:
              'Request headers, e.g. {"Authorization": "Bearer ...", "Accept": "application/json"}.',
          },
          body: {
            type: ["string", "object"],
            description:
              "Request body. Objects are sent as JSON with Content-Type application/json.",
          },
          timeout_ms: {
            type: "number",
            description: "Timeout in milliseconds (1000-60000, default 15000).",
          },
          follow_redirects: {
            type: "boolean",
            description:
              "Follow 3xx redirects (default true). Set false to inspect the redirect response itself.",
          },
          session: {
            type: "string",
            description:
              "Optional cookie-session name. Calls sharing the same name share cookies (Set-Cookie is stored and replayed), enabling login flows.",
          },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_code",
      description:
        "Executes a JavaScript (Node.js) snippet in an isolated worker and returns its console output and return value. Use it to parse or transform data, run real calculations or simulations, test logic, or format output — anything too complex for the calculator. The snippet runs inside an async function: use console.log(...) for output and 'return' for a final value; await is allowed. Each call requires the user's explicit confirmation.",
      parameters: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description:
              "The JavaScript code to run. Log results with console.log or end with a return statement.",
          },
          timeout_ms: {
            type: "number",
            description: "Timeout in milliseconds (1000-60000, default 15000).",
          },
        },
        required: ["code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_operations",
      description:
        "Reads, writes and organizes files inside a dedicated workspace folder (sandboxed; it cannot touch anything outside it). Use it to save reports or drafts, keep scratch data between steps, and read files back later. Actions: list, read, write, append, delete, mkdir, info, and find (glob pattern like '*.md'). Paths are relative to the workspace root.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "list",
              "read",
              "write",
              "append",
              "delete",
              "mkdir",
              "info",
              "find",
            ],
            description: "The operation to perform.",
          },
          path: {
            type: "string",
            description:
              "Path relative to the workspace root, e.g. 'reports/summary.md'. Defaults to the root.",
          },
          content: {
            type: "string",
            description: "Text to write (required for write/append).",
          },
          pattern: {
            type: "string",
            description: "Filename glob for find, e.g. '*.json' (default '*').",
          },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "code_search",
      description:
        "Read-only exploration of code and text files in the user's allowed directories (~/dive/workspace plus anything listed in ~/dive/allowed-dirs.json). Actions: grep (regex search across files, optional glob filter), find (locate files by glob), read (show a file with line numbers, optional start_line/end_line), tree (directory listing, 3 levels). Use this to understand a codebase before proposing changes; use file_operations to write inside the workspace and shell_command for anything else.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["grep", "find", "read", "tree"],
            description: "The operation to perform.",
          },
          path: {
            type: "string",
            description:
              "Absolute or ~/ path to the file or directory to operate on. Defaults to ~/dive/workspace.",
          },
          pattern: {
            type: "string",
            description: "Regex for grep (case-insensitive).",
          },
          glob: {
            type: "string",
            description:
              "Filename glob, e.g. '*.py' or '**/config*'. Filters grep, or is the target of find.",
          },
          start_line: {
            type: "number",
            description: "First line for read (1-based).",
          },
          end_line: { type: "number", description: "Last line for read." },
          max_results: {
            type: "number",
            description: "Cap on grep/find matches (default 50, max 200).",
          },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_tools",
      description:
        "Read-only git inspection of a repository inside the allowed directories: status, log, diff, show, branch, blame. Never modifies the repository — for commits or other mutating git commands use shell_command (which asks the user first). Use path_filter to focus log/diff/blame on one file.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["status", "log", "diff", "show", "branch", "blame"],
            description: "The git query to run.",
          },
          repo: {
            type: "string",
            description:
              "Absolute or ~/ path to the repository (must be inside the allowed directories).",
          },
          ref: {
            type: "string",
            description:
              "Commit/branch/range for diff or show, e.g. 'HEAD~3' or 'main..feature'.",
          },
          path_filter: {
            type: "string",
            description: "Restrict log/diff/blame to this file or directory.",
          },
          count: {
            type: "number",
            description: "Number of log entries (default 20, max 100).",
          },
          start_line: {
            type: "number",
            description: "First line for blame.",
          },
          end_line: { type: "number", description: "Last line for blame." },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_python",
      description:
        "Runs a Python script with the system python3 (or the venv configured in ~/dive/coding-settings.json as pythonVenv) and returns stdout/stderr. The user must approve each run. Use for data processing, calculations beyond the calculator skill, and quick scripts; the script file itself is temporary, so write any outputs you need to keep into the workspace via absolute paths or use file_operations afterwards.",
      parameters: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description: "The complete Python source to execute.",
          },
          timeout_seconds: {
            type: "number",
            description: "Execution timeout (default 30, max 120).",
          },
        },
        required: ["code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "macos_control",
      description:
        "Controls the user's Mac (each action needs user approval): run_applescript (osascript), open (file/URL/app, optional app name), notify (notification with title/message), list_processes (optional filter), kill_process (pid, optional force). Use only when the user asks to control apps, open things, or manage processes.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "run_applescript",
              "open",
              "notify",
              "list_processes",
              "kill_process",
            ],
            description: "The control action to perform.",
          },
          script: {
            type: "string",
            description: "AppleScript source for run_applescript.",
          },
          target: {
            type: "string",
            description: "File path, URL, or app name for open.",
          },
          app: {
            type: "string",
            description: "Application to open the target with.",
          },
          title: { type: "string", description: "Notification title." },
          message: { type: "string", description: "Notification message." },
          filter: {
            type: "string",
            description: "Substring filter for list_processes.",
          },
          pid: { type: "number", description: "Process id for kill_process." },
          force: {
            type: "boolean",
            description: "Use SIGKILL instead of SIGTERM.",
          },
        },
        required: ["action"],
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

// Lessons are strictly per-mode: each mode is its own ecosystem, so each
// mode has its own file in DATA_DIR/lessons and never sees another mode's
// lessons. Pi is excluded entirely — it has its own native context system
// (~/.pi/agent/AGENTS.md).
const LESSON_MODES = ["ollama", "cloud", "lmstudio", "llamacpp"];

function lessonModeKey(mode) {
  return LESSON_MODES.includes(mode) ? mode : "ollama";
}

function lessonsHeader(mode) {
  return `# ${lessonModeKey(mode)} lessons\n# One lesson per line: every non-empty line below (except "#" comments) is injected into the system prompt of every ${lessonModeKey(mode)} chat. Edit or delete freely.\n`;
}

function lessonsFilePath(dataDir, mode) {
  return path.join(dataDir, "lessons", `${lessonModeKey(mode)}-lessons.md`);
}

// Files written before v4 carried this description as a plain (non-comment)
// line; skip it so an old file never injects its own header as a lesson.
const LEGACY_LESSONS_HEADER_RE =
  /^Lines starting with "- " are injected into the system prompt/;

function readLessons(dataDir, mode) {
  try {
    const text = fs.readFileSync(lessonsFilePath(dataDir, mode), "utf8");
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter(
        (line) =>
          line && !line.startsWith("#") && !LEGACY_LESSONS_HEADER_RE.test(line),
      )
      .map((line) => (line.startsWith("- ") ? line : `- ${line}`))
      .join("\n");
  } catch {
    return "";
  }
}

// One-time migration: the old single lessons.md applied to all non-Pi modes,
// so its lessons are seeded into every mode file; the original is kept as a
// backup, never deleted.
function migrateLegacyLessons(dataDir) {
  const legacy = path.join(dataDir, "lessons.md");
  try {
    if (!fs.existsSync(legacy)) return;
    const lines = fs
      .readFileSync(legacy, "utf8")
      .split("\n")
      .filter((line) => line.trim().startsWith("- "));
    fs.mkdirSync(path.join(dataDir, "lessons"), { recursive: true });
    for (const mode of LESSON_MODES) {
      const file = lessonsFilePath(dataDir, mode);
      let current = "";
      try {
        current = fs.readFileSync(file, "utf8");
      } catch {
        current = lessonsHeader(mode);
      }
      const missing = lines.filter((line) => !current.includes(line));
      if (missing.length) {
        fs.writeFileSync(
          file,
          current.trimEnd() + "\n" + missing.join("\n") + "\n",
          "utf8",
        );
      }
    }
    fs.renameSync(legacy, `${legacy}.migrated-backup`);
    console.log(
      `[lessons] migrated ${lines.length} legacy lessons into per-mode files`,
    );
  } catch (e) {
    console.error("Lesson migration failed:", e.message || e);
  }
}

async function executeRememberLesson(args, dataDir, mode) {
  if (!dataDir) return "Error: no data directory available.";
  const modeKey = lessonModeKey(mode);
  const lesson = String(args.lesson || "")
    .trim()
    .replace(/\s+/g, " ");
  if (!lesson) return "Error: lesson text is required.";
  if (lesson.length > 500) {
    return "Error: keep lessons under 500 characters.";
  }
  const file = lessonsFilePath(dataDir, modeKey);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let current = "";
  try {
    current = fs.readFileSync(file, "utf8");
  } catch {
    current = lessonsHeader(modeKey);
  }
  const entry = `- ${lesson}`;
  if (current.includes(entry)) {
    return `Already remembered for ${modeKey}: "${lesson}"`;
  }
  fs.writeFileSync(file, current.trimEnd() + "\n" + entry + "\n", "utf8");
  return `Remembered for ${modeKey} mode: "${lesson}" — this now applies to every future ${modeKey} conversation (each mode keeps its own independent lessons). The user can edit or remove lessons in Settings > Skills > Lessons.`;
}

async function executeProposePlugin(args, dataDir) {
  if (!dataDir) return "Error: no data directory available.";
  const rawName = String(args.name || "").toLowerCase();
  const name = rawName
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!name) return "Error: a kebab-case plugin name is required.";
  const code = String(args.code || "");
  if (!code.includes("module.exports")) {
    return "Error: code must be a CommonJS module (module.exports = { skills: [...] }).";
  }
  try {
    // Syntax check without executing.
    new (require("vm").Script)(code, { filename: `${name}/index.js` });
  } catch (e) {
    return `Error: the plugin code has a syntax error: ${e.message}`;
  }
  const draftDir = path.join(dataDir, "plugin-drafts", name);
  fs.mkdirSync(draftDir, { recursive: true });
  fs.writeFileSync(
    path.join(draftDir, "plugin.json"),
    JSON.stringify(
      {
        name,
        description: String(args.description || ""),
        version: "0.1.0",
        draftedBy: "model",
        draftedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(path.join(draftDir, "index.js"), code, "utf8");
  return `Draft plugin "${name}" saved. It is NOT active. Tell the user to review and approve it under Settings > Skills > Plugins > Drafts.`;
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
    case "academic_search":
      return await executeAcademicSearch(args);
    case "fetch_paper":
      return await executeFetchPaper(args, context);
    case "fact_check":
      return await executeFactCheck(args, context);
    case "web_scraper":
      return await executeWebScraper(args);
    case "calculator":
      return await executeCalculator(args);
    case "local_notes":
      return await executeLocalNotes(args, context.dataDir);
    case "remember_lesson":
      return await executeRememberLesson(args, context.dataDir, context.mode);
    case "propose_plugin":
      return await executeProposePlugin(args, context.dataDir);
    case "time_and_date":
      return await executeTimeAndDate(args);
    case "shell_command":
      if (!context.allowShellCommand) {
        return "Error: shell command execution requires explicit user confirmation.";
      }
      return await executeShellCommand(args);
    case "http_request":
      return await executeHttpRequest(args);
    case "run_code":
      if (!context.allowShellCommand) {
        return "Error: code execution requires explicit user confirmation.";
      }
      return await executeRunCode(args);
    case "run_python":
      if (!context.allowShellCommand) {
        return "Error: Python execution requires explicit user confirmation.";
      }
      return await executeRunPython(args, context.dataDir);
    case "macos_control":
      if (!context.allowShellCommand) {
        return "Error: macOS control requires explicit user confirmation.";
      }
      return await executeMacosControl(args);
    case "code_search":
      return await executeCodeSearch(args);
    case "git_tools":
      return await executeGitTools(args);
    case "file_operations":
      return await executeFileOperations(args, context.dataDir);
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
  readLessons,
  migrateLegacyLessons,
  LESSON_MODES,
  ALL_SKILLS,
  executeSkill,
  skillRequiresShellConfirmation,
  // Exported for unit tests.
  reconstructOpenAlexAbstract,
  normalizeDoi,
  mergeAcademicResults,
  resolveAllowedPath,
  globToRegex,
};
