const assert = require("assert");
const test = require("node:test");

const { extractWebSources } = require("../routes/web-sources.js");

test("extracts web-search source entries for bottom pills", () => {
  const sources = extractWebSources(
    "web_search",
    {},
    [
      "**Sources:**",
      "1. The First Source",
      "   https://example.com/article",
      "2. The Second Source",
      "   https://example.org/report",
    ].join("\n"),
  );
  assert.deepStrictEqual(sources, [
    { title: "The First Source", url: "https://example.com/article" },
    { title: "The Second Source", url: "https://example.org/report" },
  ]);
});

test("does not turn fetched page chrome into payment or account sources", () => {
  const sources = extractWebSources(
    "fetch_content",
    { urls: ["https://www.washingtonpost.com/article"] },
    "![paypal](https://www.washingtonpost.com/subscribe/payment/paypal.svg)",
  );
  assert.deepStrictEqual(sources, [
    {
      title: "washingtonpost.com",
      url: "https://www.washingtonpost.com/article",
    },
  ]);
});

test("extracts only the explicit deep-research source manifest", () => {
  const sources = extractWebSources(
    "deep_research",
    {},
    [
      '## Deep research — "topic" (2 sources)',
      "",
      "1. First Source",
      "   URL: https://example.com/article",
      "",
      "Article text contains URL: https://unrelated.example/payment",
      "---",
      "2. Second Source",
      "   URL: https://example.org/report",
      "",
      "More fetched article text.",
    ].join("\n"),
  );
  assert.deepStrictEqual(sources, [
    { title: "First Source", url: "https://example.com/article" },
    { title: "Second Source", url: "https://example.org/report" },
  ]);
});

test("deep-research manifest never scans numbered links inside evidence", () => {
  const sources = extractWebSources(
    "deep_research",
    {},
    [
      "### Verified source manifest",
      "1. Verified source",
      "   URL: https://example.com/verified",
      "",
      "### Evidence excerpts",
      "SOURCE 1: Verified source",
      "1. Unrelated page link",
      "URL: https://unrelated.example/payment",
    ].join("\n"),
  );
  assert.deepStrictEqual(sources, [
    { title: "Verified source", url: "https://example.com/verified" },
  ]);
});

test("extracts the explicit Larousse article comment", () => {
  const sources = extractWebSources(
    "larousse",
    {},
    "## Larousse: Marie Curie\n\nArticle text.\n\n<!-- https://www.larousse.fr/encyclopedie/personnage/Marie_Curie/123456 -->",
  );
  assert.deepStrictEqual(sources, [
    {
      title: "larousse.fr",
      url: "https://www.larousse.fr/encyclopedie/personnage/Marie_Curie/123456",
    },
  ]);
});

test("extracts the explicit Scholarpedia article comment", () => {
  const sources = extractWebSources(
    "scholarpedia",
    {},
    "## Scholarpedia: Neural networks\n\nArticle text.\n\n<!-- https://www.scholarpedia.org/article/Neural_network -->",
  );
  assert.deepStrictEqual(sources, [
    {
      title: "scholarpedia.org",
      url: "https://www.scholarpedia.org/article/Neural_network",
    },
  ]);
});

test("extracts landing URLs from academic-search and fetch-paper records", () => {
  const academic = extractWebSources(
    "academic_search",
    {},
    [
      '## Academic search: "topic" (1 papers)',
      "",
      "1. A Paper",
      "   Author One (2024) — Journal",
      "   DOI: 10.1234/example",
      "   URL: https://papers.example.org/landing",
      "   PDF: https://papers.example.org/paper.pdf",
    ].join("\n"),
  );
  const paper = extractWebSources(
    "fetch_paper",
    {},
    [
      "## Paper",
      "",
      "1. A Paper",
      "   Author One (2024) — Journal",
      "   URL: https://papers.example.org/landing",
      "   PDF: https://papers.example.org/paper.pdf",
      "",
      "### Content",
      "Paper text.",
    ].join("\n"),
  );
  assert.deepStrictEqual(academic, [
    { title: "A Paper", url: "https://papers.example.org/landing" },
  ]);
  assert.deepStrictEqual(paper, [
    { title: "A Paper", url: "https://papers.example.org/landing" },
  ]);
});

test("extracts numbered DuckDuckGo skill results", () => {
  const sources = extractWebSources(
    "duckduckgo",
    {},
    [
      '## Web search results for "topic"',
      "",
      "1. First result",
      "   A short snippet.",
      "   URL: https://example.com/first",
      "",
      "2. Second result",
      "   Another snippet.",
      "   URL: https://example.org/second",
    ].join("\n"),
  );
  assert.deepStrictEqual(sources, [
    { title: "First result", url: "https://example.com/first" },
    { title: "Second result", url: "https://example.org/second" },
  ]);
});

test("the manifest survives an extra line between a title and its URL", () => {
  // Archived sources carry an "Original URL:" line, and a future field would
  // otherwise make every pill disappear without warning.
  const sources = extractWebSources(
    "deep_research",
    {},
    [
      "### Verified source manifest",
      "1. Archived Source",
      "   Retrieved: 2019-04-02 via Wayback Machine",
      "   URL: https://web.archive.org/web/2019/https://example.com/a",
      "   Original URL: https://example.com/a",
      "2. Plain Source",
      "   URL: https://example.org/b",
      "",
      "### Evidence excerpts",
      "3. Not a source",
      "   URL: https://example.net/should-not-appear",
    ].join("\n"),
  );
  assert.deepStrictEqual(sources, [
    {
      title: "Archived Source",
      url: "https://web.archive.org/web/2019/https://example.com/a",
    },
    { title: "Plain Source", url: "https://example.org/b" },
  ]);
});
