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
  isReferenceDenseChunk,
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

test("reference-dense chunks (index/bibliography/cases) dropped, prose kept", () => {
  // Alphabetical name/subject index: each entry ends in page numbers. This is
  // the real Jung "Collected Works" chunk style whose whole-document numeric
  // density was diluted below the chapter-level 0.30 threshold.
  const nameIndex = [
    'on "idées fixes," 477',
    "on obsessions, 477",
    "Java, 145, 178",
    "Jena, 287",
    "Jerusalem, 107",
    "Jews, 162, 246, 665",
    "Joachim of Flora, 678, 688&n",
    "Job, 680, 741",
    "Jones, Ernest, 399n, 485",
    "Josephus, Flavius, 107, 777",
  ].join("\n\n");
  assert.strictEqual(isReferenceDenseChunk(nameIndex), true);

  // "Cases in summary" list — page refs glued with dashes/ranges; the
  // numeric-token detector misses these, the page-ref-ending signal catches it.
  const cases = [
    "[1] Young woman whose dream illustrates sexual symbolism. — 9f",
    "[2] Schizophrenic with hallucination of the sun phallus. — 101, 157",
    "[3] Girl of 10 with mythological dreams who died a year later. —96, 229–34",
    "[4] Schizophrenic woman who painted pictures. —100–101",
    "[5] Young Frenchman whose depression began after a journey. —112–23, 166",
    "[6] Young man with compulsion neurosis. —128–30",
    "[7] Woman doctor aged 58 with a previous analyst. —139",
    "[8] Man who bought an Egyptian sculpture of a cat. —141–42",
  ].join("\n\n");
  assert.strictEqual(isReferenceDenseChunk(cases), true);

  // Bibliography entries (heading was "BIBLIOGRAFÍA CONJUNTA", an inexact title
  // the back-matter list misses) — each ends in a year/page.
  const bibliography = [
    "Alfonso X, El ajedrez de don Alfonso, Madrid, La Franco Española, 1929",
    "——, El fuero real de España, Medina del Campo, 1544.",
    "Domínguez Ortiz, Antonio, El antiguo régimen, Madrid, Alianza, 1973.",
    "Dostoyevski, Fedor M., The Diary of a Writer, Vol. II, Nueva York, 1949.",
    "Eisenberg, Daniel, Romances of Chivalry, Newark, Juan de la Cuesta, 1982.",
    "Foucault, Michel, Les mots et les choses, París, Gallimard, 1966.",
    "Spitzer, Leo, Lingüística e historia literaria, Madrid, Gredos, 1955.",
  ].join("\n\n");
  assert.strictEqual(isReferenceDenseChunk(bibliography), true);

  // Real prose — short poetic paragraphs (the El libro rojo style) and ordinary
  // narrative must NOT be flagged, even with the occasional trailing number.
  const verseProse = [
    "La fuerza originaria es el resplandor del sol que sus hijos llevan en sí.",
    "Mas, cuando el alma se sumerge en el resplandor, se vuelve inexorable.",
    "El niño divino que has comido estará en ti como una brasa ardiente.",
    "Así habló el espíritu de las profundidades, y yo escuché y temblé.",
    "En el año 1916 escribí estas palabras sin comprender del todo su sentido.",
    "El camino de lo que ha de venir se abre solo ante quien lo recorre.",
    "Y la oscuridad me envolvió como un manto, y en ella encontré la luz.",
  ].join("\n\n");
  assert.strictEqual(isReferenceDenseChunk(verseProse), false);

  // Too few paragraphs: never flag.
  assert.strictEqual(isReferenceDenseChunk("Java, 145\n\nJena, 287"), false);

  // Regression: roman-numeral chapter/section labels must NOT count as page
  // references, or novel boundary chunks and tables of contents that mix a
  // chapter list with real dialogue get wrongly dropped (Fred M. White,
  // Tocqueville, Drayton in the real library). A chunk of chapter labels plus
  // prose dialogue must be kept.
  const fictionBoundary = [
    "‘Perhaps it is selfish,’ he replied, with a great heave of his chest.",
    "‘Dear old fellow!’ Edgar said, pressing his hand warmly.",
    "The American regarded them for a moment with something like tears.",
    "And he promised.",
    "CHAPTER I",
    "CHAPTER II",
    "CHAPTER III",
    "CHAPTER IV",
    "CHAPTER V",
    "BOOK II.",
  ].join("\n\n");
  assert.strictEqual(isReferenceDenseChunk(fictionBoundary), false);
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
