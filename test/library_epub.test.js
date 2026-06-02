const test = require("node:test");
const assert = require("node:assert");
const {
  cleanEpubText,
  extractHtmlText,
  parseContainerXml,
  parseOpf,
  parseOpfMetadata,
} = require("../library/epub");

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
