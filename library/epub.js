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
  const raw = String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
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

  return {
    title,
    author,
    chapters: dedupeChapterItems(spine),
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
  return foldText(text).replace(/^#+\s*/, "").trim();
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
  if (/^(titivillus|armandathos)\s+\d{1,2}\.\d{1,2}\.\d{2,4}$/.test(normalized)) {
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
        (author && new RegExp(`^${escapeRegExp(author)},?\\s+\\d{4}$`).test(comparable)))
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

function extractHtmlText(html) {
  const $ = cheerio.load(String(html || ""), {
    decodeEntities: true,
    xmlMode: false,
  });
  $(
    "script, style, nav, head, svg, img, audio, video, object, iframe",
  ).remove();

  const blocks = [];
  $(BLOCK_SELECTOR).each((_, element) => {
    const tag = localName(element);
    const text = normalizeInlineText($(element).text());
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
    const chapterTexts = [];
    const warnings = [];

    for (const chapter of opf.chapters) {
      try {
        const chapterHtml = await readEntryText(zipfile, entries, chapter.path);
        const chapterText = extractHtmlText(chapterHtml);
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
};
