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
