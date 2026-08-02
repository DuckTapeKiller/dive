function hostTitleFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function sourceTitleFromRecord(value) {
  return String(value || "")
    .replace(/^\[([^\]]+)\]\([^)]*\)$/, "$1")
    .replace(/^[*_`]+|[*_`]+$/g, "")
    .trim();
}

// Research skills return a deliberately small, explicit manifest: a numbered
// title followed immediately by its URL. Do not scan the rest of the fetched
// article text, which may contain unrelated links.
function extractImmediateNumberedUrlRecords(text, add) {
  const lines = String(text || "").split(/\r?\n/);
  for (let i = 0; i + 1 < lines.length; i += 1) {
    const title = lines[i].match(/^\s*\d+\.\s+(.+?)\s*$/);
    const url = lines[i + 1].match(/^\s*URL:\s*(https?:\/\/\S+)/i);
    if (title && url) add(sourceTitleFromRecord(title[1]), url[1]);
  }
}

// Academic-search, fetch-paper, and DuckDuckGo records may include author,
// DOI, abstract, or snippet lines between the numbered title and URL. Keep the
// current record only until its first explicit URL, and reset at section
// boundaries so page prose is never treated as a source manifest.
function extractDeepResearchManifest(text, add) {
  const lines = String(text || "").split(/\r?\n/);
  const marker = lines.findIndex((line) =>
    /^\s*#{1,6}\s+(?:verified\s+)?source\s+manifest\s*$/i.test(line),
  );
  if (marker < 0) return false;
  for (let i = marker + 1; i + 1 < lines.length; i += 1) {
    if (/^\s*#{1,6}\s+/.test(lines[i])) break;
    const title = lines[i].match(/^\s*\d+\.\s+(.+?)\s*$/);
    const url = lines[i + 1].match(/^\s*URL:\s*(https?:\/\/\S+)/i);
    if (title && url) add(sourceTitleFromRecord(title[1]), url[1]);
  }
  return true;
}

function extractNumberedUrlRecords(text, add) {
  let title = "";
  for (const line of String(text || "").split(/\r?\n/)) {
    const numbered = line.match(/^\s*\d+\.\s+(.+?)\s*$/);
    if (numbered) {
      title = sourceTitleFromRecord(numbered[1]);
      continue;
    }
    if (/^\s*(?:#{1,6}\s+|---+\s*$)/.test(line)) {
      title = "";
      continue;
    }
    const url = line.match(/^\s*URL:\s*(https?:\/\/\S+)/i);
    if (title && url) {
      add(title, url[1]);
      title = "";
    }
  }
}

function extractWebSources(toolName, argsObj, resultText) {
  const name = String(toolName || "");
  const text = String(resultText || "");
  const sources = [];
  const seen = new Set();

  const add = (title, url) => {
    const clean = String(url || "")
      .trim()
      .replace(/[),.;]+$/, "");
    if (!/^https?:\/\//i.test(clean) || seen.has(clean)) return;
    seen.add(clean);
    sources.push({
      title: String(title || hostTitleFromUrl(clean)).slice(0, 140),
      url: clean.slice(0, 4000),
    });
  };

  if (name === "web_search") {
    let inSources = false;
    let lastTitle = "";
    for (const line of text.split("\n")) {
      const heading = line
        .replace(/[#*_]/g, "")
        .replace(/:/g, "")
        .trim()
        .toLowerCase();
      if (["source", "sources", "fuente", "fuentes"].includes(heading)) {
        inSources = true;
        lastTitle = "";
        continue;
      }
      if (/^\s*#{1,6}\s+/.test(line)) {
        inSources = false;
        lastTitle = "";
      }
      if (!inSources) continue;

      const numbered = line.match(/^\s*\d+\.\s*(.+?)\s*$/);
      if (numbered) {
        lastTitle = numbered[1].replace(/^\[([^\]]+)\]\([^)]*\)$/, "$1").trim();
        const inline = numbered[1].match(/\((https?:\/\/[^)]+)\)/i);
        if (inline) add(lastTitle, inline[1]);
        continue;
      }
      const url = line.match(/^\s*(?:URL:\s*)?(https?:\/\/\S+)/i);
      if (url) {
        add(lastTitle, url[1]);
        lastTitle = "";
      }
    }

    // Some providers omit a Sources heading and return citation links inline.
    if (!sources.length) {
      const links = /\[([^\]]{1,200})\]\((https?:\/\/[^)\s]+)\)/gi;
      let match;
      while ((match = links.exec(text)) !== null) {
        add(match[1], match[2]);
        if (sources.length >= 50) break;
      }
    }
  }

  if (name === "deep_research") {
    // New dossiers isolate the manifest before any untrusted page prose. Keep
    // the old immediate-record fallback for historical conversation renders.
    if (!extractDeepResearchManifest(text, add)) {
      extractImmediateNumberedUrlRecords(text, add);
    }
  }

  if (["academic_search", "fetch_paper", "duckduckgo"].includes(name)) {
    extractNumberedUrlRecords(text, add);
  }

  if (
    [
      "wikipedia",
      "britannica",
      "larousse",
      "scholarpedia",
      "wiktionary",
    ].includes(name)
  ) {
    const comments = /<!--[\s]*((?:https?:\/\/\S+?))[\s]*-->/gi;
    let match;
    while ((match = comments.exec(text)) !== null) {
      add(hostTitleFromUrl(match[1]), match[1]);
      if (sources.length >= 50) break;
    }
  }

  // fetch_content is allowed to expose only the pages explicitly requested by
  // the tool call. Never scan fetched page text: page chrome can contain
  // unrelated payment, account, or advertising links.
  if (name === "fetch_content") {
    const requested = Array.isArray(argsObj?.urls)
      ? argsObj.urls
      : argsObj?.url
        ? [argsObj.url]
        : [];
    requested.forEach((url) => add(hostTitleFromUrl(url), url));
  }

  if (name === "web_scraper" && argsObj?.url) {
    add(hostTitleFromUrl(argsObj.url), argsObj.url);
  }

  if (name === "book_search") {
    const labels = {
      openlibrary: "Open Library",
      google: "Google Books",
      goodreads: "Goodreads",
      storygraph: "StoryGraph",
      hardcover: "Hardcover",
      librarything: "LibraryThing",
      calibre: "Calibre",
    };
    const scope = text.match(/<!--\s*sources:([\s\S]*?)-->/i)?.[1] || text;
    const links = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/gi;
    let match;
    while ((match = links.exec(scope)) !== null) {
      add(labels[match[1]] || match[1], match[2]);
      if (sources.length >= 50) break;
    }
  }

  return sources.slice(0, 50);
}

module.exports = { extractWebSources, hostTitleFromUrl };
