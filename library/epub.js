const path = require("path");
const yauzl = require("yauzl");
const cheerio = require("cheerio");

const MAX_ENTRY_BYTES = 50 * 1024 * 1024;
const XHTML_MEDIA_TYPES = new Set([
  "application/xhtml+xml",
  "text/html",
  "application/x-dtbook+xml",
]);
const BLOCK_SELECTOR = [
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "blockquote",
  "li",
  "pre",
].join(",");

function openZip(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(
      filePath,
      {
        autoClose: false,
        decodeStrings: true,
        lazyEntries: true,
        strictFileNames: false,
        validateEntrySizes: true,
      },
      (error, zipfile) => {
        if (error) reject(error);
        else resolve(zipfile);
      },
    );
  });
}

function collectEntries(zipfile) {
  return new Promise((resolve, reject) => {
    const entries = new Map();
    zipfile.once("error", reject);
    zipfile.on("entry", (entry) => {
      const normalizedName = normalizeZipPath(entry.fileName);
      if (normalizedName && !normalizedName.endsWith("/")) {
        entries.set(normalizedName, entry);
      }
      zipfile.readEntry();
    });
    zipfile.once("end", () => resolve(entries));
    zipfile.readEntry();
  });
}

function readEntryBuffer(zipfile, entry) {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      const chunks = [];
      let total = 0;
      stream.on("data", (chunk) => {
        total += chunk.length;
        if (total > MAX_ENTRY_BYTES) {
          stream.destroy(new Error("EPUB entry exceeded the safety limit."));
          return;
        }
        chunks.push(chunk);
      });
      stream.on("error", reject);
      stream.on("end", () => resolve(Buffer.concat(chunks)));
    });
  });
}

async function readEntryText(zipfile, entries, entryPath) {
  const normalizedPath = normalizeZipPath(entryPath);
  const entry = entries.get(normalizedPath);
  if (!entry) {
    throw new Error(`EPUB entry not found: ${normalizedPath}`);
  }
  const buffer = await readEntryBuffer(zipfile, entry);
  return buffer.toString("utf8").replace(/^\uFEFF/, "");
}

function normalizeZipPath(value) {
  const raw = String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  if (!raw) return "";
  const normalized = path.posix.normalize(raw);
  if (normalized === "." || normalized.startsWith("../")) return "";
  return normalized;
}

function decodeHref(href) {
  const withoutFragment = String(href || "").split("#")[0];
  try {
    return decodeURIComponent(withoutFragment);
  } catch (_error) {
    return withoutFragment;
  }
}

function resolveZipPath(baseDir, href) {
  return normalizeZipPath(path.posix.join(baseDir || "", decodeHref(href)));
}

function localName(element) {
  return String(element?.tagName || element?.name || "")
    .toLowerCase()
    .split(":")
    .pop();
}

function getAttr(element, names) {
  const attrs = element?.attribs || {};
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  for (const [key, value] of Object.entries(attrs)) {
    if (wanted.has(key.toLowerCase())) return value;
  }
  return "";
}

function findByLocalName($, name) {
  const wanted = String(name || "").toLowerCase();
  const matches = [];
  $("*").each((_, element) => {
    if (localName(element) === wanted) matches.push(element);
  });
  return matches;
}

function firstTextByLocalName($, name) {
  return textsByLocalName($, name)[0] || "";
}

function textsByLocalName($, name) {
  return findByLocalName($, name)
    .map((element) => normalizeInlineText($(element).text()))
    .filter(Boolean);
}

function loadXml(xml) {
  return cheerio.load(xml, {
    lowerCaseAttributeNames: false,
    lowerCaseTags: false,
    xmlMode: true,
  });
}

function parseContainerXml(containerXml) {
  const $ = loadXml(containerXml);
  const rootfile = findByLocalName($, "rootfile")[0];
  const fullPath = getAttr(rootfile, ["full-path"]);
  if (!fullPath) throw new Error("EPUB container.xml has no rootfile path.");
  return normalizeZipPath(fullPath);
}

function parseOpf(opfXml, opfPath) {
  const $ = loadXml(opfXml);
  const baseDir = path.posix.dirname(opfPath);
  const metadata = parseOpfMetadata(opfXml);
  const { title, author } = metadata;
  const manifest = new Map();

  for (const item of findByLocalName($, "item")) {
    const id = getAttr(item, ["id"]);
    const href = getAttr(item, ["href"]);
    if (!id || !href) continue;
    const mediaType = getAttr(item, ["media-type"]).toLowerCase();
    const properties = getAttr(item, ["properties"]).toLowerCase();
    const hrefPath = resolveZipPath(baseDir === "." ? "" : baseDir, href);
    manifest.set(id, {
      id,
      href,
      path: hrefPath,
      mediaType,
      properties,
    });
  }

  const spine = [];
  for (const itemref of findByLocalName($, "itemref")) {
    const idref = getAttr(itemref, ["idref"]);
    const linear = getAttr(itemref, ["linear"]).toLowerCase();
    const item = manifest.get(idref);
    if (!item || linear === "no") continue;
    if (isReadableManifestItem(item)) spine.push(item);
  }

  if (!spine.length) {
    for (const item of manifest.values()) {
      if (isReadableManifestItem(item)) spine.push(item);
    }
    spine.sort((a, b) => a.path.localeCompare(b.path));
  }

  // Locate the navigation documents so the extractor can map spine files to
  // their section titles and drop back-matter (index, bibliography, TOC).
  let navPath = "";
  let ncxPath = "";
  for (const item of manifest.values()) {
    if (!navPath && item.properties.split(/\s+/).includes("nav")) {
      navPath = item.path;
    }
    if (
      !ncxPath &&
      (item.mediaType === "application/x-dtbncx+xml" ||
        path.posix.extname(item.path).toLowerCase() === ".ncx")
    ) {
      ncxPath = item.path;
    }
  }

  return {
    title,
    author,
    chapters: dedupeChapterItems(spine),
    navPath,
    ncxPath,
  };
}

function parseOpfMetadata(opfXml) {
  const $ = loadXml(opfXml);
  const title = firstTextByLocalName($, "title");
  const authors = Array.from(new Set(textsByLocalName($, "creator")));
  return {
    title,
    author: authors.join(", "),
  };
}

function isReadableManifestItem(item) {
  if (!item?.path) return false;
  if (item.properties.split(/\s+/).includes("nav")) return false;
  const extension = path.posix.extname(item.path).toLowerCase();
  return (
    XHTML_MEDIA_TYPES.has(item.mediaType) ||
    extension === ".xhtml" ||
    extension === ".html" ||
    extension === ".htm"
  );
}

function dedupeChapterItems(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    if (seen.has(item.path)) continue;
    seen.add(item.path);
    result.push(item);
  }
  return result;
}

function normalizeInlineText(text) {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t\r\n]+/g, " ")
    .trim();
}

function foldText(text) {
  return normalizeInlineText(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function normalizeMetadataComparable(text) {
  return foldText(text)
    .replace(/^#+\s*/, "")
    .trim();
}

function isLikelyNavigationText(text) {
  const normalized = foldText(text);
  return (
    normalized === "contents" ||
    normalized === "table of contents" ||
    normalized === "indice" ||
    normalized === "indice de contenido" ||
    normalized === "previous" ||
    normalized === "next" ||
    normalized === "back" ||
    normalized === "cover" ||
    normalized === "cubierta" ||
    normalized === "portada" ||
    normalized === "contraportada" ||
    normalized === "copyright" ||
    normalized === "title page"
  );
}

function isBoilerplateText(text) {
  const normalized = foldText(text);
  if (!normalized) return true;
  if (isLikelyNavigationText(normalized)) return true;
  if (/^epub(?: base)?\s+r?\d+(?:\.\d+)*(?:\s+\S+)?$/.test(normalized)) {
    return true;
  }
  if (
    /^(titivillus|armandathos)\s+\d{1,2}\.\d{1,2}\.\d{2,4}$/.test(normalized)
  ) {
    return true;
  }
  if (/^indice de contenido\b/.test(normalized)) return true;
  if (/^todos los derechos reservados\b/.test(normalized)) return true;
  if (/^copyright\b/.test(normalized)) return true;
  if (/^isbn(?:\s|:)/.test(normalized)) return true;
  if (/^deposito legal(?:\s|:)/.test(normalized)) return true;
  if (/\bdirector de la coleccion\b/.test(normalized)) return true;
  if (/^descubrir la filosofia\s*-\s*\d+$/.test(normalized)) return true;
  return /^(titulo original|traduccion|editor digital|diseno de cubierta|diseno de portada|diseno y maquetacion|ilustracion de portada|ilustraciones|imagen de cubierta|cubierta|maquetacion|correccion|editorial|coleccion):/.test(
    normalized,
  );
}

function cleanEpubText(text, metadata = {}) {
  const title = normalizeMetadataComparable(metadata.title || "");
  const author = normalizeMetadataComparable(metadata.author || "");
  const paragraphs = String(text || "")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const cleaned = [];
  for (let index = 0; index < paragraphs.length; index += 1) {
    const paragraph = paragraphs[index];
    const comparable = normalizeMetadataComparable(paragraph);
    if (isBoilerplateText(paragraph)) continue;
    if (
      index < 80 &&
      comparable &&
      (comparable === title ||
        comparable === author ||
        (author &&
          new RegExp(`^${escapeRegExp(author)},?\\s+\\d{4}$`).test(comparable)))
    ) {
      continue;
    }
    cleaned.push(paragraph);
  }
  return cleaned.join("\n\n");
}

function escapeRegExp(text) {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractHtmlTextWithMode(html, xmlMode) {
  const $ = cheerio.load(html, {
    decodeEntities: true,
    xmlMode,
  });
  $(
    "script, style, nav, head, svg, img, audio, video, object, iframe",
  ).remove();

  const blocks = [];
  $(BLOCK_SELECTOR).each((_, element) => {
    const tag = localName(element);
    const $element = $(element);
    // Each element contributes only its OWN text. Containers like
    // <blockquote><p>..</p></blockquote> or <li><p>..</p></li> must not repeat
    // their nested blocks' text: every matching descendant is visited by this
    // loop itself, so taking the full subtree text here would emit the same
    // paragraph once per nesting level (measured: 14% duplicated paragraphs in
    // real EPUBs with quotation-heavy markup).
    let text;
    if ($element.find(BLOCK_SELECTOR).length > 0) {
      const clone = $element.clone();
      clone.find(BLOCK_SELECTOR).remove();
      text = normalizeInlineText(clone.text());
    } else {
      text = normalizeInlineText($element.text());
    }
    if (!text || isBoilerplateText(text)) return;
    if (/^h[1-6]$/.test(tag)) {
      blocks.push(`# ${text}`);
    } else {
      blocks.push(text);
    }
  });

  if (!blocks.length) {
    const bodyText = normalizeInlineText($("body").text() || $.root().text());
    if (bodyText && !isBoilerplateText(bodyText)) blocks.push(bodyText);
  }

  return blocks.join("\n\n");
}

function extractHtmlText(html) {
  const source = String(html || "");
  // Parse as HTML first. If that yields nothing, retry in XML mode: many EPUBs
  // ship well-formed XHTML with self-closing tags like <title/> or <a id=".."/>,
  // which the HTML parser mishandles (a self-closing <title/> is treated as
  // rcdata and swallows the rest of the document), producing empty text.
  const htmlText = extractHtmlTextWithMode(source, false);
  if (htmlText) return htmlText;
  return extractHtmlTextWithMode(source, true);
}

// Section titles (normalized via foldText: accent-stripped, lowercased) that
// mark non-content back/front matter. Matched EXACTLY — never as a substring —
// so real titles like "The Content of the Psychoses" are never excluded.
const BACK_MATTER_TITLES = new Set([
  // English
  "index",
  "bibliography",
  "references",
  "abbreviations",
  "linguistic abbreviations",
  "list of abbreviations",
  "contents",
  "table of contents",
  "detailed table of contents",
  "series contents",
  "copyright",
  "copyright page",
  "title page",
  "half title page",
  // Spanish (foldText removes accents: índice -> indice, etc.)
  "indice",
  "indice analitico",
  "indice onomastico",
  "indice de materias",
  "indice de nombres",
  "indice tematico",
  "bibliografia",
  "referencias",
  "abreviaturas",
  "sumario",
  "contenido",
  "creditos",
  "derechos de autor",
  "portada",
  "pagina de titulo",
]);

function isBackMatterTitle(title) {
  if (!title) return false;
  return BACK_MATTER_TITLES.has(foldText(title));
}

// Content-based detector for alphabetical INDEX pages that carry no nav title
// (e.g. the Jung "The Collected Works" set has ~130 such unlabeled index
// files). Index pages are dominated by page/volume reference tokens
// ("25&n,", "154n;", "764"), regardless of layout — a format-agnostic signal
// that also handles the volume+page+semicolon style. Threshold chosen from
// measured data on real books: prose sections top out around a 0.19 numeric-
// token ratio, index sections sit at 0.40-0.75; 0.30 is the safe gap. Min
// token count avoids flagging short number-y fragments. Deliberately
// conservative so ordinary prose is never misclassified.
function isIndexLikeSection(text) {
  const tokens = String(text || "").match(/\S+/g) || [];
  if (tokens.length < 150) return false;
  let numericTokens = 0;
  for (const token of tokens) {
    if (/^[\d(]?\d[\d.,;:&nf()–-]*$/i.test(token)) numericTokens += 1;
  }
  return numericTokens / tokens.length >= 0.3;
}

// A paragraph that ends in a page/volume reference: an ARABIC number, possibly
// with an "f"/"ff"/"n"/"&n" suffix and joined into dash-ranges or comma-lists
// (e.g. "145, 178", "70f", "688&n", "112–23, 166"). This is how alphabetical
// indexes, bibliographies and "cases in summary" lists terminate every entry.
// Roman numerals are deliberately NOT accepted: chapter/section labels like
// "CHAPTER II", "BOOK I.", "IDEA III" or "AMOUR V" are roman and would
// otherwise make table-of-contents and novel boundary chunks look index-like.
const PAGE_REF_END =
  /(?:[—–-]\s*)?\d+(?:&?[a-z]{1,2})?(?:\s*[,;–—-]\s*\d+(?:&?[a-z]{1,2})?)*\.?\s*$/i;

function referenceEntryFraction(text) {
  const paras = String(text || "")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paras.length < 6) return 0;
  let hits = 0;
  for (const para of paras) {
    if (para.length <= 200 && PAGE_REF_END.test(para)) hits += 1;
  }
  return hits / paras.length;
}

// Per-chunk detector for index / bibliography / case-list back matter. Each
// such entry is one short paragraph ending in a page reference, whereas prose
// paragraphs end in sentence punctuation — so the fraction of page-ref-ending
// paragraphs separates them cleanly. Measured on 1500 real prose chunks: 96%
// sit below 0.20 and the only chunks at or above 0.70 were actual
// bibliographies; real index chunks measure 0.83-0.97. The highest genuine
// prose outlier (a verse passage) was 0.65, so 0.70 is the safe gap. Unlike the
// chapter-level numeric-density test, this runs after chunking and so catches
// index pages whose whole-document density is diluted below the 0.30 line.
function isReferenceDenseChunk(text) {
  return referenceEntryFraction(text) >= 0.7;
}

// Map spine-file path -> section title, using only whole-file navigation
// entries (hrefs/srcs WITHOUT a #fragment). Fragment entries are sub-sections
// and would mislabel a shared file, so they are ignored. Handles both the
// EPUB3 nav document (<a href>) and the EPUB2 NCX (<navPoint>).
function parseNavTitleMap(xml, docPath) {
  const map = new Map();
  if (!xml) return map;
  let $;
  try {
    $ = loadXml(xml);
  } catch (_error) {
    return map;
  }
  const baseDir = path.posix.dirname(docPath || "");
  for (const anchor of findByLocalName($, "a")) {
    const href = getAttr(anchor, ["href"]);
    if (!href || href.includes("#")) continue;
    const target = resolveZipPath(baseDir === "." ? "" : baseDir, href);
    const title = normalizeInlineText($(anchor).text());
    if (target && title && !map.has(target)) map.set(target, title);
  }
  return map;
}

function parseNcxTitleMap(xml, docPath) {
  const map = new Map();
  if (!xml) return map;
  let $;
  try {
    $ = loadXml(xml);
  } catch (_error) {
    return map;
  }
  const baseDir = path.posix.dirname(docPath || "");
  for (const navPoint of findByLocalName($, "navpoint")) {
    let src = "";
    let title = "";
    $(navPoint)
      .find("*")
      .each((_index, element) => {
        const ln = localName(element);
        if (!src && ln === "content") src = getAttr(element, ["src"]);
        if (!title && ln === "text") {
          title = normalizeInlineText($(element).text());
        }
      });
    if (!src || src.includes("#")) continue;
    const target = resolveZipPath(baseDir === "." ? "" : baseDir, src);
    if (target && title && !map.has(target)) map.set(target, title);
  }
  return map;
}

async function buildBackMatterPaths(zipfile, entries, opf) {
  let titleMap = new Map();
  if (opf.navPath) {
    try {
      const navXml = await readEntryText(zipfile, entries, opf.navPath);
      titleMap = parseNavTitleMap(navXml, opf.navPath);
    } catch (_error) {
      titleMap = new Map();
    }
  }
  if (!titleMap.size && opf.ncxPath) {
    try {
      const ncxXml = await readEntryText(zipfile, entries, opf.ncxPath);
      titleMap = parseNcxTitleMap(ncxXml, opf.ncxPath);
    } catch (_error) {
      titleMap = new Map();
    }
  }
  const paths = new Set();
  for (const [filePath, title] of titleMap) {
    if (isBackMatterTitle(title)) paths.add(filePath);
  }
  return paths;
}

async function extractEpub(filePath) {
  const zipfile = await openZip(filePath);
  try {
    const entries = await collectEntries(zipfile);
    const containerXml = await readEntryText(
      zipfile,
      entries,
      "META-INF/container.xml",
    );
    const opfPath = parseContainerXml(containerXml);
    const opfXml = await readEntryText(zipfile, entries, opfPath);
    const opf = parseOpf(opfXml, opfPath);
    const backMatterPaths = await buildBackMatterPaths(zipfile, entries, opf);
    const chapterTexts = [];
    const warnings = [];
    const skippedSections = [];

    for (const chapter of opf.chapters) {
      if (backMatterPaths.has(chapter.path)) {
        skippedSections.push(chapter.path);
        continue;
      }
      try {
        const chapterHtml = await readEntryText(zipfile, entries, chapter.path);
        const chapterText = extractHtmlText(chapterHtml);
        if (chapterText && isIndexLikeSection(chapterText)) {
          skippedSections.push(chapter.path);
          continue;
        }
        if (chapterText) chapterTexts.push(chapterText);
      } catch (error) {
        warnings.push(`${chapter.path}: ${error.message}`);
      }
    }

    if (!chapterTexts.length) {
      throw new Error("EPUB did not contain extractable spine text.");
    }

    return {
      title: opf.title,
      author: opf.author,
      text: cleanEpubText(chapterTexts.join("\n\n"), {
        title: opf.title,
        author: opf.author,
      }),
      chapterCount: chapterTexts.length,
      skippedSections,
      warnings,
    };
  } finally {
    zipfile.close();
  }
}

module.exports = {
  extractEpub,
  extractHtmlText,
  cleanEpubText,
  parseContainerXml,
  parseOpf,
  parseOpfMetadata,
  isBackMatterTitle,
  isIndexLikeSection,
  isReferenceDenseChunk,
};
