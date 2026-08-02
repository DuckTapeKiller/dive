function hostTitleFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
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

  if (["wikipedia", "britannica", "wiktionary"].includes(name)) {
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
