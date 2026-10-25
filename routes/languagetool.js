// LanguageTool domain: grammar and spelling checks for Dive's own text boxes.
// The page cannot reach the LanguageTool server itself (the CSP allows only
// this origin), so every check goes through here. Settings, the personal
// dictionary and the disabled rules live in DATA_DIR/languagetool.json.
const fs = require("fs");
const path = require("path");

const DEFAULT_SERVER_URL = "http://localhost:8010";
const TEXT_MAX_CHARS = 200000;
const CHECK_TIMEOUT_MS = 20000;
const STATUS_TIMEOUT_MS = 4000;
const LIST_MAX = 5000;
// Paragraphs shorter than this (a heading, a one-line item) are checked with
// the next one: language detection needs a sentence or two to be reliable.
const BLOCK_MIN_CHARS = 60;
const BLOCK_CONCURRENCY = 4;
const CACHE_MAX_ENTRIES = 1000;

function defaultLanguageToolSettings() {
  return {
    enabled: false,
    serverUrl: DEFAULT_SERVER_URL,
    language: "auto",
    preferredVariants: "en-GB,es-ES",
    // Who underlines misspelt words: "languagetool", "system" (the
    // operating system's spellchecker, LanguageTool keeps grammar and style)
    // or "both".
    spelling: "languagetool",
    dictionary: [],
    disabledRules: [],
  };
}

const SPELLING_OWNERS = new Set(["languagetool", "system", "both"]);

// LanguageTool's dictionary spellers, the rules the system spellchecker
// stands in for. issueType "misspelling" is wider: it also covers rules such
// as a/an, which no system spellchecker catches.
function isSpellerRule(ruleId) {
  return /^MORFOLOGIK_RULE_|^HUNSPELL_|SPELLER_RULE$|^FR_SPELLING_RULE$/.test(
    ruleId,
  );
}

// Accepts the server root with or without /v2 and a trailing slash; anything
// that is not plain http(s) falls back to the default.
function normalizeServerUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) return DEFAULT_SERVER_URL;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return DEFAULT_SERVER_URL;
    }
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "").replace(/\/v2$/, "");
  } catch (_e) {
    return DEFAULT_SERVER_URL;
  }
}

function cleanList(raw, pattern) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const value = item.trim();
    if (value && value.length <= 100 && pattern.test(value)) seen.add(value);
    if (seen.size >= LIST_MAX) break;
  }
  return [...seen];
}

function sanitizeLanguageToolSettings(rawInput) {
  const defaults = defaultLanguageToolSettings();
  const raw =
    rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
      ? rawInput
      : {};
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : defaults.enabled,
    serverUrl:
      raw.serverUrl === undefined
        ? defaults.serverUrl
        : normalizeServerUrl(raw.serverUrl),
    language:
      typeof raw.language === "string" &&
      /^(auto|[a-z]{2,3}(-[A-Za-z0-9]{2,8})*)$/.test(raw.language)
        ? raw.language
        : defaults.language,
    preferredVariants:
      typeof raw.preferredVariants === "string"
        ? raw.preferredVariants
            .split(",")
            .map((v) => v.trim())
            .filter((v) => /^[a-z]{2,3}-[A-Za-z0-9]{2,8}$/.test(v))
            .join(",")
        : defaults.preferredVariants,
    spelling: SPELLING_OWNERS.has(raw.spelling)
      ? raw.spelling
      : defaults.spelling,
    dictionary: cleanList(raw.dictionary, /^[^\s]+$/u),
    disabledRules: cleanList(raw.disabledRules, /^[A-Za-z0-9_]+$/),
  };
}

// Markdown that is not prose is handed to LanguageTool as markup, so it is
// skipped but offsets still point into the original text. Inline code and
// bare URLs read as a neutral word ("0"), the way the Obsidian plugin does,
// so the sentence around them stays whole.
function buildAnnotation(text) {
  const taken = new Uint8Array(text.length);
  const ranges = [];
  const add = (from, to, interpretAs) => {
    if (to <= from) return;
    for (let i = from; i < to; i++) if (taken[i]) return;
    taken.fill(1, from, to);
    ranges.push({ from, to, interpretAs });
  };
  const each = (regex, fn) => {
    for (const m of text.matchAll(regex)) fn(m);
  };

  each(/^(`{3,}|~{3,})[^\n]*(?:\n[\s\S]*?(?:\n\1[^\n]*(?=\n|$)|$))/gm, (m) =>
    add(m.index, m.index + m[0].length, "\n\n"),
  );
  each(/(`+)(?!`)[^\n]*?[^`]\1(?!`)/g, (m) =>
    add(m.index, m.index + m[0].length, "0"),
  );
  // [label](target): the brackets and the target are markup, the label prose.
  each(/!?\[([^\]\n]*)\]\(([^)\s]*)(?:\s+"[^"\n]*")?\)/g, (m) => {
    const labelStart = m.index + m[0].indexOf("[") + 1;
    const labelEnd = labelStart + m[1].length;
    if (m[0].startsWith("!") || !m[1].trim()) {
      add(m.index, m.index + m[0].length, "0");
      return;
    }
    add(m.index, labelStart);
    add(labelEnd, m.index + m[0].length);
  });
  each(/<https?:\/\/[^>\s]+>|\bhttps?:\/\/[^\s<>"'«»“”]+/g, (m) => {
    const url = m[0].replace(/[.,;:!?)\]]+$/, "");
    add(m.index, m.index + url.length, "0");
  });
  each(/<\/?[A-Za-z][^<>\n]*>/g, (m) => add(m.index, m.index + m[0].length));
  each(/^[ \t]*(?:>[ \t]?)+/gm, (m) => add(m.index, m.index + m[0].length));
  each(/^[ \t]*#{1,6}[ \t]+/gm, (m) => add(m.index, m.index + m[0].length));
  each(/^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, (m) =>
    add(m.index, m.index + m[0].length),
  );
  // Indentation is layout, not a doubled space.
  each(/^[ \t]+(?=\S)/gm, (m) => add(m.index, m.index + m[0].length));
  // Emphasis markers that open before or close after a word, never the
  // underscore inside snake_case.
  each(
    /(?<![\p{L}\p{N}*_~])[*_~]{1,3}(?=[^\s*_~])|(?<=[^\s*_~])[*_~]{1,3}(?![\p{L}\p{N}*_~])/gu,
    (m) => add(m.index, m.index + m[0].length),
  );

  if (!ranges.length) return null;
  ranges.sort((a, b) => a.from - b.from);
  const annotation = [];
  let cursor = 0;
  for (const r of ranges) {
    if (r.from > cursor) annotation.push({ text: text.slice(cursor, r.from) });
    const markup = { markup: text.slice(r.from, r.to) };
    if (r.interpretAs) markup.interpretAs = r.interpretAs;
    annotation.push(markup);
    cursor = r.to;
  }
  if (cursor < text.length) annotation.push({ text: text.slice(cursor) });
  return { annotation };
}

// Splits the text into paragraphs, [from, to) offset pairs, at blank lines
// outside fenced code. Each paragraph is checked on its own, so a note that
// mixes languages gets each paragraph read in its own language, and only the
// paragraphs that changed since the last check go to LanguageTool again.
function splitBlocks(text) {
  const blocks = [];
  let blockStart = -1;
  let fence = null;
  let pos = 0;
  for (const line of text.split("\n")) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (
        fenceMatch &&
        fenceMatch[1][0] === fence[0] &&
        fenceMatch[1].length >= fence.length
      ) {
        fence = null;
      }
    } else if (fenceMatch) {
      fence = fenceMatch[1];
    }
    const blank = !fence && !fenceMatch && !line.trim();
    if (blank) {
      if (blockStart >= 0) blocks.push([blockStart, pos - 1]);
      blockStart = -1;
    } else if (blockStart < 0) {
      blockStart = pos;
    }
    pos += line.length + 1;
  }
  if (blockStart >= 0) blocks.push([blockStart, text.length]);

  const merged = [];
  for (const block of blocks) {
    const last = merged[merged.length - 1];
    if (last && text.slice(last[0], last[1]).trim().length < BLOCK_MIN_CHARS) {
      last[1] = block[1];
    } else {
      merged.push([...block]);
    }
  }
  // A short last paragraph has nothing after it to join, so it joins the one
  // before.
  const last = merged[merged.length - 1];
  if (
    merged.length > 1 &&
    text.slice(last[0], last[1]).trim().length < BLOCK_MIN_CHARS
  ) {
    merged.pop();
    merged[merged.length - 1][1] = last[1];
  }
  return merged;
}

function trimMatch(match, text) {
  const offset = Number(match.offset);
  const length = Number(match.length);
  return {
    offset,
    length,
    text: text.slice(offset, offset + length),
    message: String(match.message || ""),
    shortMessage: String(match.shortMessage || ""),
    replacements: (Array.isArray(match.replacements) ? match.replacements : [])
      .map((r) => (r && typeof r.value === "string" ? r.value : null))
      .filter((v) => v !== null)
      .slice(0, 6),
    ruleId: String(match.rule?.id || ""),
    ruleDescription: String(match.rule?.description || ""),
    issueType: String(match.rule?.issueType || ""),
    category: String(match.rule?.category?.name || ""),
  };
}

function isMisspelling(match) {
  return match.issueType === "misspelling";
}

module.exports = function createLanguageToolDomain(deps) {
  const { DATA_DIR, parseJsonBody } = deps;
  const SETTINGS_FILE = path.join(DATA_DIR, "languagetool.json");

  function loadSettings() {
    try {
      if (fs.existsSync(SETTINGS_FILE)) {
        return sanitizeLanguageToolSettings(
          JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")),
        );
      }
    } catch (e) {
      console.warn("Failed to load LanguageTool settings:", e.message || e);
    }
    return defaultLanguageToolSettings();
  }

  function saveSettings(next) {
    const sanitized = sanitizeLanguageToolSettings(next);
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(sanitized, null, 2));
    return sanitized;
  }

  async function callServer(settings, fields, timeoutMs) {
    const body = new URLSearchParams(fields);
    const res = await fetch(`${settings.serverUrl}/v2/check`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      const error = new Error(
        `LanguageTool answered ${res.status}${detail ? `: ${detail}` : ""}`,
      );
      error.statusCode = 502;
      throw error;
    }
    return res.json();
  }

  function unreachable(settings, e) {
    if (e.statusCode) return e;
    const error = new Error(
      `LanguageTool is not reachable at ${settings.serverUrl} (${e.name === "TimeoutError" ? "timed out" : e.cause?.code || e.message})`,
    );
    error.statusCode = 502;
    return error;
  }

  // Results per paragraph, keyed by everything that shapes them. Map order
  // is insertion order, so re-inserting on use keeps it least-recently-used.
  const cache = new Map();

  async function checkBlock(settings, language, blockText) {
    const key = JSON.stringify([
      settings.serverUrl,
      language,
      settings.preferredVariants,
      settings.disabledRules,
      blockText,
    ]);
    if (cache.has(key)) {
      const hit = cache.get(key);
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    const fields = { language };
    if (language === "auto" && settings.preferredVariants) {
      fields.preferredVariants = settings.preferredVariants;
    }
    if (settings.disabledRules.length) {
      fields.disabledRules = settings.disabledRules.join(",");
    }
    const data = buildAnnotation(blockText);
    if (data) fields.data = JSON.stringify(data);
    else fields.text = blockText;

    let result;
    try {
      result = await callServer(settings, fields, CHECK_TIMEOUT_MS);
    } catch (e) {
      throw unreachable(settings, e);
    }
    const detected = result?.language?.detectedLanguage || result?.language;
    const blockLanguage = detected
      ? { code: String(detected.code || ""), name: String(detected.name || "") }
      : null;
    const matches = (Array.isArray(result?.matches) ? result.matches : [])
      .map((m) => ({ ...trimMatch(m, blockText), language: blockLanguage }))
      .filter(
        (m) =>
          Number.isInteger(m.offset) &&
          Number.isInteger(m.length) &&
          m.length > 0 &&
          m.offset + m.length <= blockText.length,
      );
    const entry = { language: blockLanguage, matches };
    cache.set(key, entry);
    if (cache.size > CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
    return entry;
  }

  async function check(body) {
    const settings = loadSettings();
    const text = typeof body?.text === "string" ? body.text : "";
    if (text.length > TEXT_MAX_CHARS) {
      const error = new Error("Text is too long to check.");
      error.statusCode = 413;
      throw error;
    }
    if (!text.trim()) return { language: null, matches: [] };
    const language =
      typeof body.language === "string" && body.language
        ? sanitizeLanguageToolSettings({ language: body.language }).language
        : settings.language;

    const blocks = splitBlocks(text);
    const results = new Array(blocks.length);
    let next = 0;
    const worker = async () => {
      while (next < blocks.length) {
        const i = next++;
        const [from, to] = blocks[i];
        results[i] = await checkBlock(settings, language, text.slice(from, to));
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(BLOCK_CONCURRENCY, blocks.length) },
        worker,
      ),
    );

    const dictionary = new Set(settings.dictionary);
    const matches = [];
    // The language of the longest paragraph stands for the whole text.
    let main = null;
    let mainLength = -1;
    results.forEach((result, i) => {
      const [from, to] = blocks[i];
      if (to - from > mainLength && result.language) {
        main = result.language;
        mainLength = to - from;
      }
      for (const m of result.matches) {
        if (isMisspelling(m) && dictionary.has(m.text)) continue;
        if (settings.spelling === "system" && isSpellerRule(m.ruleId)) continue;
        matches.push({ ...m, offset: m.offset + from });
      }
    });
    return { language: main, matches };
  }

  async function status() {
    const settings = loadSettings();
    try {
      const result = await callServer(
        settings,
        { language: "en-GB", text: "Test." },
        STATUS_TIMEOUT_MS,
      );
      const software = result?.software || {};
      return {
        ok: true,
        serverUrl: settings.serverUrl,
        name: String(software.name || "LanguageTool"),
        version: String(software.version || ""),
      };
    } catch (e) {
      return {
        ok: false,
        serverUrl: settings.serverUrl,
        error: unreachable(settings, e).message,
      };
    }
  }

  function addToList(key, value) {
    const settings = loadSettings();
    if (typeof value !== "string" || !value.trim()) {
      const error = new Error("A value is required.");
      error.statusCode = 400;
      throw error;
    }
    return saveSettings({ ...settings, [key]: [...settings[key], value] });
  }

  async function handleRequest(ctx) {
    const { req, urlPath, send } = ctx;
    if (!urlPath.startsWith("/api/languagetool/")) return false;

    try {
      if (req.method === "GET" && urlPath === "/api/languagetool/settings") {
        send(200, { settings: loadSettings() });
        return true;
      }
      if (req.method === "POST" && urlPath === "/api/languagetool/settings") {
        const body = await parseJsonBody(req);
        const incoming =
          body?.settings && typeof body.settings === "object"
            ? body.settings
            : body;
        send(200, {
          settings: saveSettings({ ...loadSettings(), ...incoming }),
        });
        return true;
      }
      if (req.method === "GET" && urlPath === "/api/languagetool/status") {
        send(200, await status());
        return true;
      }
      if (req.method === "POST" && urlPath === "/api/languagetool/check") {
        send(200, await check(await parseJsonBody(req)));
        return true;
      }
      if (req.method === "POST" && urlPath === "/api/languagetool/dictionary") {
        const body = await parseJsonBody(req);
        send(200, { settings: addToList("dictionary", body?.word) });
        return true;
      }
      if (
        req.method === "POST" &&
        urlPath === "/api/languagetool/disabled-rules"
      ) {
        const body = await parseJsonBody(req);
        send(200, { settings: addToList("disabledRules", body?.ruleId) });
        return true;
      }
    } catch (e) {
      send(e.statusCode || 500, { error: e.message });
      return true;
    }
    return false;
  }

  return { handleRequest, loadSettings };
};

module.exports.buildAnnotation = buildAnnotation;
module.exports.splitBlocks = splitBlocks;
module.exports.sanitizeLanguageToolSettings = sanitizeLanguageToolSettings;
module.exports.normalizeServerUrl = normalizeServerUrl;
