"use strict";

// book_search: Global Book Search's own search code, run inside Dive.
//
// global-book-search.js is the plugin's search layer, compiled by
// scripts/build-book-sources.mjs. This file is the part that belongs to Dive:
// it turns Dive's book-search settings into the plugin's, runs one search the
// way the plugin's global search does — every source at once, grouped by work,
// then the chosen edition looked up by ISBN in every other source to fill what
// the first one lacked — and writes the result for the model.
//
// The plugin does not need to be installed, and Dive never reads its settings:
// keys, tokens and the StoryGraph login come from Settings → TOOLS → BOOK
// SEARCH PROVIDERS (DATA_DIR/book-search.json).

const fs = require("fs");
const path = require("path");
const gbs = require("./global-book-search.js");
const adapter = require("./obsidian-adapter.js");

const LABELS = gbs.GLOBAL_SEARCH_SOURCE_LABELS;
const SOURCE_IDS = [
  "goodreads",
  "storygraph",
  "google",
  "openlibrary",
  "hardcover",
  "librarything",
  "calibre",
];

// Why a source gave nothing, in words the user can act on. The plugin's own
// short reasons ("sign-in needed", "quota used up") say what happened; these
// add where in Dive to fix it.
const SETTINGS_PLACE = "Settings → TOOLS → BOOK SEARCH PROVIDERS";
const SETUP_HINTS = {
  "sign-in needed": `add your StoryGraph login in ${SETTINGS_PLACE}`,
  "login not accepted": `the StoryGraph login has probably expired; copy fresh cookies into ${SETTINGS_PLACE}`,
  "quota used up": `Google's shared free quota is used up for today; a free Google Books API key in ${SETTINGS_PLACE} gives you your own`,
};

// Time limits for a search in one source. The plugin's global search gives
// each source 8–12 seconds, but asking a single source has no limit of its own,
// and Open Library alone took over a minute on a slow day.
const SINGLE_SOURCE_SEARCH_MS = 20000;
const SINGLE_SOURCE_DETAILS_MS = 15000;

function withinTime(ms, run) {
  let timer;
  return Promise.race([
    Promise.resolve().then(run),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`no answer within ${ms / 1000} seconds`)),
        ms,
      );
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

function loadBookConfig(dataDir) {
  try {
    if (!dataDir) return {};
    const file = path.join(dataDir, "book-search.json");
    if (!fs.existsSync(file)) return {};
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// Dive's settings, in the plugin's names. Everything else (the field-by-field
// source order above all) is the plugin's own default.
function pluginSettings(config, language) {
  const text = (key) => String(config?.[key] || "").trim();
  return {
    ...gbs.DEFAULT_SETTINGS,
    apiKey: text("googleApiKey"),
    hardcoverApiToken: text("hardcoverToken"),
    librarythingApiKey: text("librarythingToken"),
    calibreServerUrl: text("calibreServerUrl").replace(/\/+$/, ""),
    calibreLibraryId: text("calibreLibraryId"),
    storygraphSessionCookie: text("storygraphSessionCookie"),
    storygraphRememberToken: text("storygraphRememberToken"),
    localePreference: language ? String(language).slice(0, 2) : "default",
  };
}

// An ISBN-10 or ISBN-13 the query consists of (hyphens and spaces allowed),
// or "".
function detectIsbn(query) {
  const compact = String(query || "")
    .replace(/^isbn[:\s]*/i, "")
    .replace(/[\s-]/g, "")
    .toUpperCase();
  if (/^97[89]\d{10}$/.test(compact)) return compact;
  if (/^\d{9}[\dX]$/.test(compact)) return compact;
  return "";
}

const fold = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// The work the query most likely means. The plugin lets the reader pick from
// the list; a tool call has to pick itself, so: the closest title (and author,
// when the query names one), then the work most sources agree on, then the one
// with an ISBN, which is what lets the other sources be asked about it.
function rankWorks(works, query) {
  const q = fold(query);
  const score = (work) => {
    const title = fold(work.title);
    const author = fold(work.author);
    let s = 0;
    if (title && q === title) s += 6;
    else if (title && q.includes(title)) s += 4;
    else if (title && title.includes(q)) s += 2;
    if (author && q.includes(author)) s += 2;
    else if (
      author &&
      author.split(" ").some((w) => w.length > 3 && q.includes(w))
    ) {
      s += 1;
    }
    s += Math.min((work._sourceIds || []).length, 4) * 0.5;
    if (work.isbn13 || work.isbn10) s += 0.25;
    return s;
  };
  return works
    .map((work, index) => ({ work, index, s: score(work) }))
    .sort((a, b) => b.s - a.s || a.index - b.index)
    .map((x) => x.work);
}

const ROWS = [
  ["Title", "title"],
  ["Subtitle", "subtitle"],
  ["Original title", "originalTitle"],
  ["Author(s)", (b) => (b.authors || []).join(", ") || b.author],
  ["Translator", "translator"],
  ["Narrator", "narrator"],
  [
    "Series",
    (b) =>
      b.series
        ? `${b.series}${b.seriesNumber ? ` #${b.seriesNumber}` : ""}`
        : "",
  ],
  ["ISBN-13", "isbn13"],
  ["ISBN-10", "isbn10"],
  ["ASIN", "asin"],
  ["Publisher", "publisher"],
  ["Published", "publishDate"],
  ["First published", "firstPublishDate"],
  ["Pages", "totalPage"],
  ["Format", "format"],
  ["Language", "language"],
  ["Original language", "originalLanguage"],
  ["Genres", (b) => b.categories || b.category],
  ["Moods", "moods"],
  ["Pace", "pace"],
  ["Characters", "characters"],
  ["Places", "places"],
  ["Events", "events"],
  ["First words", "firstWords"],
  ["Last words", "lastWords"],
  ["Dedication", "dedication"],
  ["Related films", "relatedMovies"],
];

const cell = (value) =>
  String(value)
    .replace(/\|/g, "/")
    .replace(/\s*\n\s*/g, " ")
    .trim();

function describeOutcomes(outcomes) {
  const failed = Object.entries(outcomes).filter(
    ([, o]) => o.outcome === "failed",
  );
  if (!failed.length) return "";
  const parts = failed.map(([id, o]) => {
    const label = LABELS[id] || id;
    const hint = SETUP_HINTS[o.reason];
    return o.reason
      ? `${label} (${o.reason}${hint ? `: ${hint}` : ""})`
      : `${label} (no answer)`;
  });
  return `_Sources unavailable this run: ${parts.join("; ")}_`;
}

function formatResult({
  book,
  sources,
  conflicts,
  others,
  outcomes,
  primaryId,
}) {
  let out = `## ${book.title || "Untitled"}\n\n| Field | Value |\n|---|---|\n`;
  // Goodreads gives a print edition's ISBN-10 as its ASIN, and an original
  // title can be the title itself; neither says anything new.
  const redundant = {
    asin: (v) => v === book.isbn10,
    originalTitle: (v) => fold(v) === fold(book.title),
  };
  for (const [label, key] of ROWS) {
    const value = typeof key === "function" ? key(book) : book[key];
    if (value === undefined || value === null || !String(value).trim()) {
      continue;
    }
    if (typeof key === "string" && redundant[key]?.(value)) continue;
    out += `| ${label} | ${cell(value)} |\n`;
  }
  const description = String(book.description || "").trim();
  if (description) {
    out += `\n**Description:** ${description.length > 1200 ? `${description.slice(0, 1200)}…` : description}\n`;
  }
  if (book.coverUrl) out += `\n[Cover](${book.coverUrl})\n`;
  const links = [];
  if (book.link) links.push(`[${primaryId || "source"}](${book.link})`);
  if (book.seriesLink)
    links.push(`[${primaryId || "source"}](${book.seriesLink})`);
  if (links.length) {
    // In an HTML comment: the server turns these into source pills, and the
    // reply itself must not repeat them.
    out += `\n<!-- sources: ${links.join(" ")} -->\n`;
  }
  if (sources?.length) out += `\n_Details from: ${sources.join(", ")}_\n`;
  if (conflicts?.length) {
    const lines = conflicts.map((c) => {
      const values = (c.values || [])
        .map(
          (v) =>
            `${cell(Array.isArray(v.value) ? v.value.join(", ") : v.value)} (${v.source})`,
        )
        .join(" vs ");
      return `${c.label || c.fieldName}: ${values}`;
    });
    out += `\n**Sources disagree on** ${lines.join("; ")}\n`;
  }
  if (others?.length) {
    out += `\n**Other matches** (search again to pick one): ${others
      .map((w) => `${w.title}${w.author ? ` (${w.author})` : ""}`)
      .join(" | ")}\n`;
  }
  const unavailable = describeOutcomes(outcomes || {});
  if (unavailable) out += `\n${unavailable}\n`;
  out +=
    "\n[Instruction to the assistant: present the markdown table, description and Cover link above VERBATIM in your reply — do not convert them to prose, do not expand the cover into a bare URL, and do not list the sources (they are shown to the user as pills automatically). Mention any unavailable source and its fix only if the user asks why something is missing.]";
  return out.trim();
}

async function executeBookSearch(
  { query, language = "", provider = "" } = {},
  context = {},
) {
  const text = String(query || "").trim();
  if (!text) return "Book Search Error: no title, author or ISBN given.";
  try {
    const config = loadBookConfig(context.dataDir);
    const settings = pluginSettings(config, language);
    adapter.setLocale(
      settings.localePreference === "default"
        ? "en"
        : settings.localePreference,
    );
    // The user's own Calibre server usually runs on this machine, which the
    // SSRF guard would refuse; that one address is let through, nothing else.
    adapter.trustOrigin(settings.calibreServerUrl);

    const wanted = String(provider || "")
      .toLowerCase()
      .trim();
    if (wanted && !SOURCE_IDS.includes(wanted)) {
      return `Book Search Error: unknown provider "${provider}". Use one of: ${SOURCE_IDS.join(", ")}.`;
    }

    const isbn = detectIsbn(text);
    // An ISBN names one edition: ask every source about it and merge.
    if (isbn && !wanted) {
      const result = await gbs.enrichFromIsbn(isbn, settings);
      if (!result?.book?.title || result.book.title === isbn) {
        return `No book found for ISBN ${isbn}.`;
      }
      return formatResult({ ...result, primaryId: "" });
    }

    // One source only: the plugin fills a note from that source alone, so
    // this does the same — no merging with the others.
    if (wanted) {
      const api = gbs.factoryServiceProvider(settings, wanted);
      let books;
      try {
        books = await withinTime(SINGLE_SOURCE_SEARCH_MS, () =>
          api.getByQuery(text, {
            locale: settings.localePreference,
          }),
        );
      } catch (error) {
        const reason =
          error instanceof gbs.ProviderBlockedError ? error.shortReason : "";
        const hint = SETUP_HINTS[reason];
        return `Book Search Error: ${LABELS[wanted] || wanted} ${reason ? `refused the search (${reason}${hint ? `: ${hint}` : ""})` : `failed: ${error?.message || error}`}.`;
      }
      if (!books?.length)
        return `No book found for "${text}" on ${LABELS[wanted] || wanted}.`;
      const [best, ...rest] = rankWorks(books, text);
      let book = best;
      if (api.getBook) {
        try {
          book = await withinTime(SINGLE_SOURCE_DETAILS_MS, () =>
            api.getBook(best),
          );
        } catch {
          /* the search result is still worth showing */
        }
      }
      return formatResult({
        book,
        sources: [LABELS[wanted] || wanted],
        conflicts: [],
        others: rest.slice(0, 3),
        outcomes: {},
        primaryId: wanted,
      });
    }

    // Every source at once, as the plugin's global search does.
    const outcomes = {};
    const works = await gbs.globalSearch(text, settings, {
      includeCalibre: Boolean(settings.calibreServerUrl),
      onSourceDone: (id, outcome, reason) => {
        outcomes[id] = { outcome, reason: reason || "" };
      },
    });
    if (!works?.length) {
      const unavailable = describeOutcomes(outcomes);
      return `No book found for "${text}".${unavailable ? `\n\n${unavailable}` : ""}`;
    }
    const [best, ...rest] = rankWorks(works, text);
    const enriched = await gbs.enrichBookByISBN(best, settings);
    return formatResult({
      book: enriched.book,
      sources: enriched.sources,
      conflicts: enriched.conflicts,
      others: rest.slice(0, 3),
      outcomes,
      primaryId: (best._sourceIds || [])[0] || "",
    });
  } catch (e) {
    return `Book Search Error: ${e?.message || e}`;
  }
}

module.exports = {
  executeBookSearch,
  pluginSettings,
  detectIsbn,
  rankWorks,
  formatResult,
  loadBookConfig,
  SOURCE_IDS,
};
