const test = require("node:test");
const assert = require("node:assert");
const {
  cleanEpubText,
  extractHtmlText,
  parseContainerXml,
  parseOpf,
  parseOpfMetadata,
  isBackMatterTitle,
  isIndexLikeSection,
} = require("../library/epub");

test("back-matter section titles are matched exactly, not by substring", () => {
  // EN + ES back-matter titles excluded (foldText strips accents/case).
  for (const t of [
    "Index",
    "INDEX",
    "Bibliography",
    "Bibliografía",
    "Índice analítico",
    "Table of Contents",
    "Linguistic Abbreviations",
    "Copyright Page",
  ]) {
    assert.strictEqual(isBackMatterTitle(t), true, t);
  }
  // Real content titles that merely contain a back-matter word must be kept.
  for (const t of [
    "The Content of the Psychoses",
    "Index Librorum and the Inquisition", // essay, not an index
    "A Bibliography of Dreams as Literature",
    "",
  ]) {
    assert.strictEqual(isBackMatterTitle(t), false, t);
  }
});

test("index-like sections detected by numeric-token density, prose kept", () => {
  // Volume+page reference index (the unlabeled "The Collected Works" style).
  const indexPage = Array.from(
    { length: 80 },
    (_v, i) => `term${i}, 11 ${i}n, 354n; 12 ${i + 9}, 209, 336n`,
  ).join("\n\n");
  assert.strictEqual(isIndexLikeSection(indexPage), true);

  // Classic "name, 12, 34, 56" index.
  const classicIndex = Array.from(
    { length: 80 },
    (_v, i) => `Author ${i}, ${i}&n, ${i + 100}, ${i + 205}`,
  ).join("\n\n");
  assert.strictEqual(isIndexLikeSection(classicIndex), true);

  // Real prose with an occasional inline citation must NOT be flagged.
  const prose =
    "In his 1921 paper Jung argued that the unconscious compensates the " +
    "conscious attitude. Depression, he held, is a lowering of psychic " +
    "energy that withdraws libido from the outer world and turns it inward, " +
    "where it activates the archetypal contents of the collective psyche. ".repeat(
      12,
    );
  assert.strictEqual(isIndexLikeSection(prose), false);
});

test("EPUB container parser finds OPF rootfile", () => {
  const opfPath = parseContainerXml(`<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);

  assert.strictEqual(opfPath, "OEBPS/content.opf");
});

test("EPUB OPF parser follows spine order and skips nav", () => {
  const parsed = parseOpf(
    `<?xml version="1.0"?>
<package xmlns:dc="http://purl.org/dc/elements/1.1/">
  <metadata>
    <dc:title>Test Book</dc:title>
    <dc:creator>Test Author</dc:creator>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c2" href="chapters/two.xhtml" media-type="application/xhtml+xml"/>
    <item id="c1" href="chapters/one.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
    <itemref idref="nav"/>
    <itemref idref="c2"/>
  </spine>
</package>`,
    "OEBPS/content.opf",
  );

  assert.strictEqual(parsed.title, "Test Book");
  assert.strictEqual(parsed.author, "Test Author");
  assert.deepStrictEqual(
    parsed.chapters.map((chapter) => chapter.path),
    ["OEBPS/chapters/one.xhtml", "OEBPS/chapters/two.xhtml"],
  );
});

test("EPUB OPF metadata parser joins multiple authors", () => {
  const metadata = parseOpfMetadata(`<?xml version="1.0"?>
<package xmlns:dc="http://purl.org/dc/elements/1.1/">
  <metadata>
    <dc:title>Dos soledades</dc:title>
    <dc:creator>Gabriel Garcia Marquez</dc:creator>
    <dc:creator>Mario Vargas Llosa</dc:creator>
  </metadata>
</package>`);

  assert.deepStrictEqual(metadata, {
    title: "Dos soledades",
    author: "Gabriel Garcia Marquez, Mario Vargas Llosa",
  });
});


test("EPUB HTML extraction preserves headings and paragraphs", () => {
  const text = extractHtmlText(`<!doctype html>
<html>
  <head><title>Ignored</title><style>.x{}</style></head>
  <body>
    <nav>Contents</nav>
    <h1>Chapter One</h1>
    <p>First paragraph with <em>inline</em> emphasis.</p>
    <blockquote>Quoted passage.</blockquote>
    <ul><li>List item</li></ul>
  </body>
</html>`);

  assert.strictEqual(
    text,
    "# Chapter One\n\nFirst paragraph with inline emphasis.\n\nQuoted passage.\n\nList item",
  );
});

test("EPUB cleanup removes title-page boilerplate", () => {
  const cleaned = cleanEpubText(
    [
      "Antonio Tabucchi",
      "# La gastritis de Platon",
      "ePub r1.0",
      "Titivillus 20.09.17",
      "Titulo original: La gastrite di Platone",
      "Antonio Tabucchi, 1998",
      "Editor digital: Titivillus",
      "A la querida memoria de Leonardo Sciascia",
      "# Primer capitulo",
      "Texto real del libro.",
    ].join("\n\n"),
    { title: "La gastritis de Platon", author: "Antonio Tabucchi" },
  );

  assert.strictEqual(
    cleaned,
    "A la querida memoria de Leonardo Sciascia\n\n# Primer capitulo\n\nTexto real del libro.",
  );
});
