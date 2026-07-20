const test = require("node:test");
const assert = require("node:assert");
const {
  reconstructOpenAlexAbstract,
  normalizeDoi,
  mergeAcademicResults,
} = require("../skills.js");

test("reconstructs an OpenAlex inverted-index abstract in position order", () => {
  const inverted = {
    memory: [3],
    Sleep: [0],
    working: [2],
    impairs: [1],
  };
  assert.strictEqual(
    reconstructOpenAlexAbstract(inverted),
    "Sleep impairs working memory",
  );
});

test("reconstruction tolerates repeated words and garbage input", () => {
  assert.strictEqual(
    reconstructOpenAlexAbstract({ the: [0, 2], cat: [1], mat: [3] }),
    "the cat the mat",
  );
  assert.strictEqual(reconstructOpenAlexAbstract(null), "");
  assert.strictEqual(reconstructOpenAlexAbstract("not an object"), "");
  assert.strictEqual(reconstructOpenAlexAbstract({ x: "bad" }), "");
});

test("normalizes DOI variants to a bare lowercase DOI", () => {
  assert.strictEqual(
    normalizeDoi("https://doi.org/10.1038/S41586-021-03819-2"),
    "10.1038/s41586-021-03819-2",
  );
  assert.strictEqual(normalizeDoi("doi:10.1234/AbC.5678"), "10.1234/abc.5678");
  assert.strictEqual(normalizeDoi("10.1000/xyz123"), "10.1000/xyz123");
  assert.strictEqual(normalizeDoi("not a doi"), "");
  assert.strictEqual(normalizeDoi(""), "");
});

function paper(overrides) {
  return {
    provider: "test",
    title: "A Paper",
    authors: ["A"],
    year: 2020,
    venue: "V",
    doi: "",
    citations: 0,
    abstract: "",
    pdfUrl: "",
    landingUrl: "https://example.org/a",
    ...overrides,
  };
}

test("merges duplicate DOIs across providers, keeping the richer record", () => {
  const openalex = [
    paper({ doi: "10.1/a", title: "Same Paper", citations: 100, abstract: "" }),
  ];
  const crossref = [
    paper({
      doi: "10.1/a",
      title: "Same paper",
      citations: 90,
      abstract: "The abstract.",
      pdfUrl: "https://example.org/a.pdf",
    }),
  ];
  const merged = mergeAcademicResults([openalex, crossref], 10);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].citations, 100);
  assert.strictEqual(merged[0].abstract, "The abstract.");
  assert.strictEqual(merged[0].pdfUrl, "https://example.org/a.pdf");
});

test("deduplicates DOI-less papers by normalized title and sorts by citations", () => {
  const a = [paper({ title: "Attention Is All You Need", citations: 5 })];
  const b = [
    paper({ title: "attention is all you need!", citations: 3 }),
    paper({ title: "Another Paper", citations: 50 }),
  ];
  const merged = mergeAcademicResults([a, b], 10);
  assert.strictEqual(merged.length, 2);
  assert.strictEqual(merged[0].title, "Another Paper");
});

test("respects the maxResults cap", () => {
  const many = Array.from({ length: 30 }, (_, i) =>
    paper({ title: `Paper ${i}`, citations: i }),
  );
  const merged = mergeAcademicResults([many], 7);
  assert.strictEqual(merged.length, 7);
});
