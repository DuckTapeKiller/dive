const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  buildLibraryContext,
  collectSourceFiles,
  detectLanguageHint,
  indexLibrary,
  normalizeConfig,
  searchLibrary,
  searchLibraryFiles,
  splitQueryForRetrieval,
} = require("../library/store");
const defaultConfig = require("../library/config.default.json");

test("default Books source indexes EPUB files only", () => {
  const books = defaultConfig.sources.find((source) => source.name === "Books");
  assert.ok(books);
  assert.deepStrictEqual(books.extensions, [".epub"]);
});

test("old Books source default is normalized to EPUB only", () => {
  const config = normalizeConfig({
    ...defaultConfig,
    sources: [
      {
        name: "Books",
        type: "book",
        path: "~/Libros",
        extensions: [".epub", ".txt"],
      },
      {
        name: "Notes",
        type: "note",
        path: "~/Notes",
        extensions: [".md", ".txt"],
      },
    ],
  });

  assert.deepStrictEqual(config.sources[0].extensions, [".epub"]);
  assert.deepStrictEqual(config.sources[1].extensions, [".md", ".txt"]);
});

test("legacy chunk defaults are upgraded to compact defaults", () => {
  const legacyConfig = normalizeConfig({
    ...defaultConfig,
    chunking: {
      targetChars: 1800,
      overlapChars: 220,
      minChars: 120,
      maxChars: 2800,
    },
  });
  const previousDefaultConfig = normalizeConfig({
    ...defaultConfig,
    chunking: {
      targetChars: 4200,
      overlapChars: 120,
      minChars: 300,
      maxChars: 6500,
    },
  });

  const compactDefaults = {
    targetChars: 2400,
    overlapChars: 0,
    minChars: 300,
    maxChars: 3200,
  };
  assert.deepStrictEqual(legacyConfig.chunking, compactDefaults);
  assert.deepStrictEqual(previousDefaultConfig.chunking, compactDefaults);
  assert.strictEqual(legacyConfig.embedding.dimensions, 0);
  assert.strictEqual(legacyConfig.embedding.quantization, "int8");
  assert.strictEqual(legacyConfig.search.keywordEnabled, false);
});

test("chat integration defaults to 20 passages and 30000 context chars", () => {
  const config = normalizeConfig({});
  assert.strictEqual(config.chatIntegration.limit, 20);
  assert.strictEqual(config.chatIntegration.maxContextChars, 30000);
});

test("legacy chat integration defaults are upgraded to new defaults", () => {
  const legacyConfig = normalizeConfig({
    ...defaultConfig,
    chatIntegration: {
      enabled: true,
      limit: 5,
      maxContextChars: 12000,
      includeSourcePaths: true,
    },
  });
  assert.strictEqual(legacyConfig.chatIntegration.limit, 20);
  assert.strictEqual(legacyConfig.chatIntegration.maxContextChars, 30000);
  assert.strictEqual(legacyConfig.chatIntegration.enabled, true);

  const customConfig = normalizeConfig({
    ...defaultConfig,
    chatIntegration: {
      enabled: true,
      limit: 8,
      maxContextChars: 12000,
      includeSourcePaths: false,
    },
  });
  assert.strictEqual(customConfig.chatIntegration.limit, 8);
  assert.strictEqual(customConfig.chatIntegration.maxContextChars, 12000);
});

test("database chat enable setting is independent per mode", () => {
  const explicitConfig = normalizeConfig({
    ...defaultConfig,
    chatIntegration: {
      enabled: true,
      limit: 8,
      maxContextChars: 16000,
      includeSourcePaths: true,
    },
    chatModes: {
      ollama: { enabled: true },
      pi: { enabled: false },
      cloud: { enabled: true },
    },
  });

  assert.strictEqual(explicitConfig.chatModes.ollama.enabled, true);
  assert.strictEqual(explicitConfig.chatModes.pi.enabled, false);
  assert.strictEqual(explicitConfig.chatModes.cloud.enabled, true);
  assert.strictEqual(explicitConfig.chatIntegration.limit, 8);

  const legacyBaseConfig = { ...defaultConfig };
  delete legacyBaseConfig.chatModes;
  const legacyConfig = normalizeConfig({
    ...legacyBaseConfig,
    chatIntegration: {
      enabled: true,
      limit: 8,
      maxContextChars: 16000,
      includeSourcePaths: true,
    },
  });
  assert.deepStrictEqual(
    Object.fromEntries(
      Object.entries(legacyConfig.chatModes).map(([key, value]) => [
        key,
        value.enabled,
      ]),
    ),
    { ollama: true, pi: true, cloud: true },
  );
});

test("per-mode search algorithm overrides are materialized and clamped", () => {
  const config = normalizeConfig({
    ...defaultConfig,
    search: { ...defaultConfig.search, rrfK: 33 },
    searchModes: {
      cloud: { rrfK: 999, metadataWeight: 2.5 },
    },
  });
  // All three modes exist and seed from the shared search settings.
  assert.strictEqual(config.searchModes.ollama.rrfK, 33);
  assert.strictEqual(config.searchModes.pi.rrfK, 33);
  // Explicit overrides are clamped to the documented ranges.
  assert.strictEqual(config.searchModes.cloud.rrfK, 100);
  assert.strictEqual(config.searchModes.cloud.metadataWeight, 2.5);
  assert.strictEqual(
    config.searchModes.cloud.maxPassagesPerSource,
    config.search.maxPassagesPerSource,
  );
});

test("searchLibrary applies per-mode search algorithm settings", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ollama-pi-chat-modes-"));
  try {
    const sourceDir = path.join(root, "sources");
    fs.mkdirSync(sourceDir);
    const paragraph =
      "El magnetismo aparece descrito en este parrafo con detalle tecnico. ";
    fs.writeFileSync(
      path.join(sourceDir, "apuntes.txt"),
      Array.from(
        { length: 10 },
        (_v, i) => `Seccion ${i + 1}\n\n${paragraph.repeat(4)}`,
      ).join("\n\n"),
    );
    const config = normalizeConfig({
      ...defaultConfig,
      databasePath: path.join(root, "library.sqlite"),
      sources: [
        { name: "Notes", type: "note", path: sourceDir, extensions: [".txt"] },
      ],
      chunking: { targetChars: 500, overlapChars: 0, minChars: 40, maxChars: 700 },
      search: { ...defaultConfig.search, keywordEnabled: true },
      searchModes: {
        ollama: { maxPassagesPerSource: 1 },
        cloud: { maxPassagesPerSource: 5 },
      },
      embedding: { ...defaultConfig.embedding, enabled: false },
    });

    try {
      await indexLibrary({ config, compact: false });
    } catch (error) {
      if (/sqlite3 was not found|contentless_delete/i.test(error.message)) {
        t.skip(error.message);
        return;
      }
      throw error;
    }

    const ollamaResults = await searchLibrary("magnetismo", {
      config,
      mode: "ollama",
      limit: 5,
    });
    const cloudResults = await searchLibrary("magnetismo", {
      config,
      mode: "cloud",
      limit: 5,
    });
    assert.strictEqual(ollamaResults.length, 1);
    assert.ok(cloudResults.length > ollamaResults.length);

    // Unknown or missing mode falls back to the shared search settings.
    const sharedResults = await searchLibrary("magnetismo", {
      config,
      limit: 5,
    });
    assert.ok(sharedResults.length > 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("book filter restricts search results to the selected files", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ollama-pi-chat-filter-"));
  try {
    const sourceDir = path.join(root, "sources");
    fs.mkdirSync(sourceDir);
    fs.writeFileSync(
      path.join(sourceDir, "Libro Alfa.txt"),
      "El magnetismo aparece en el libro alfa con explicaciones extensas. ".repeat(
        8,
      ),
    );
    fs.writeFileSync(
      path.join(sourceDir, "Libro Beta.txt"),
      "El magnetismo se estudia en el libro beta desde otra perspectiva. ".repeat(
        8,
      ),
    );
    const config = normalizeConfig({
      ...defaultConfig,
      databasePath: path.join(root, "library.sqlite"),
      sources: [
        { name: "Notes", type: "note", path: sourceDir, extensions: [".txt"] },
      ],
      search: { ...defaultConfig.search, keywordEnabled: true },
      embedding: { ...defaultConfig.embedding, enabled: false },
    });

    try {
      await indexLibrary({ config, compact: false });
    } catch (error) {
      if (/sqlite3 was not found|contentless_delete/i.test(error.message)) {
        t.skip(error.message);
        return;
      }
      throw error;
    }

    const files = await searchLibraryFiles("libro", { config });
    assert.strictEqual(files.length, 2);
    assert.ok(files.every((file) => Number.isInteger(file.id) && file.id > 0));
    const alfa = files.find((file) => file.path.endsWith("Libro Alfa.txt"));
    assert.ok(alfa);

    const unfiltered = await searchLibrary("magnetismo", { config, limit: 5 });
    assert.ok(
      new Set(unfiltered.map((result) => result.path)).size === 2,
      "both files should match without a filter",
    );

    const filtered = await searchLibrary("magnetismo", {
      config,
      limit: 5,
      fileIds: [alfa.id],
    });
    assert.ok(filtered.length > 0);
    assert.ok(
      filtered.every((result) => result.path.endsWith("Libro Alfa.txt")),
      "filtered results must come only from the selected book",
    );

    // Invalid ids are ignored entirely (no filter applied).
    const sloppy = await searchLibrary("magnetismo", {
      config,
      limit: 5,
      fileIds: ["nonsense", -4, null],
    });
    assert.ok(new Set(sloppy.map((result) => result.path)).size === 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("splitQueryForRetrieval extracts quoted span and outside instruction", () => {
  const ascii = splitQueryForRetrieval(
    '"Toads stomach Robert Burton" I want to know the story',
  );
  // Case is preserved so the embedding model receives the original text.
  assert.strictEqual(ascii.retrievalQuery, "Toads stomach Robert Burton");
  assert.strictEqual(ascii.userInstruction, "I want to know the story");
  assert.strictEqual(ascii.hasQuotedScope, true);

  // Smart curly quotes are also recognized.
  const curly = splitQueryForRetrieval(
    "I want to know the story in “Anatomy of Melancholy” of a man",
  );
  assert.strictEqual(curly.retrievalQuery, "Anatomy of Melancholy");
  assert.match(curly.userInstruction, /I want to know the story/);
  assert.strictEqual(curly.hasQuotedScope, true);

  // No quotes: behaviour unchanged (whole query is retrieval, no instruction).
  const plain = splitQueryForRetrieval("Toads stomach Robert Burton");
  assert.strictEqual(plain.retrievalQuery, "Toads stomach Robert Burton");
  assert.strictEqual(plain.userInstruction, "");
  assert.strictEqual(plain.hasQuotedScope, false);

  // Whitespace-only quotes degrade to the default path.
  const empty = splitQueryForRetrieval('Tell me " " about the story');
  assert.strictEqual(empty.hasQuotedScope, false);
  assert.strictEqual(empty.userInstruction, "");
});

test("quote-restricted search filters retrieval to the quoted scope only", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ollama-pi-chat-quote-"));
  try {
    const sourceDir = path.join(root, "sources");
    fs.mkdirSync(sourceDir);
    // The body of the unrelated file contains the instructional verbiage; if
    // the whole sentence were used for retrieval it would dominate.
    fs.writeFileSync(
      path.join(sourceDir, "guia-de-busqueda.txt"),
      "I want to know the story of how to use this library. ".repeat(20),
    );
    // The relevant file matches the quoted scope only.
    fs.writeFileSync(
      path.join(sourceDir, "anatomy-of-melancholy.txt"),
      "Robert Burton describes a man who believes he has toads in his stomach. ".repeat(
        10,
      ),
    );
    const config = normalizeConfig({
      ...defaultConfig,
      databasePath: path.join(root, "library.sqlite"),
      sources: [
        { name: "Notes", type: "note", path: sourceDir, extensions: [".txt"] },
      ],
      search: { ...defaultConfig.search, keywordEnabled: true },
      embedding: { ...defaultConfig.embedding, enabled: false },
    });

    try {
      await indexLibrary({ config, compact: false });
    } catch (error) {
      if (/sqlite3 was not found|contentless_delete/i.test(error.message)) {
        t.skip(error.message);
        return;
      }
      throw error;
    }

    const quoted = await searchLibrary(
      '"Toads stomach Robert Burton" I want to know the story',
      { config, limit: 5 },
    );
    assert.ok(quoted.length > 0);
    assert.ok(
      quoted.every((result) =>
        result.path.endsWith("anatomy-of-melancholy.txt"),
      ),
      "quoted scope must keep instructional file out of results",
    );

    // Without quotes, the original whole-query behaviour applies.
    const unquoted = await searchLibrary(
      "I want to know the story Robert Burton toads",
      { config, limit: 5 },
    );
    assert.ok(
      unquoted.some((result) =>
        result.path.endsWith("anatomy-of-melancholy.txt"),
      ),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("quoted multilingual search preserves semantic hits without hardcoded aliases", async (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "ollama-pi-chat-semantic-quotes-"),
  );
  try {
    const sourceDir = path.join(root, "sources");
    fs.mkdirSync(sourceDir);
    fs.writeFileSync(
      path.join(sourceDir, "literal-but-wrong.txt"),
      "Catalog entry: the red illness. Maria Zambrano appears in an unrelated bibliography list. ".repeat(
        12,
      ),
    );
    fs.writeFileSync(
      path.join(sourceDir, "generic-background.txt"),
      "This note explains academic method, quotations, and library search behaviour without discussing the topic. ".repeat(
        20,
      ),
    );
    const config = normalizeConfig({
      ...defaultConfig,
      databasePath: path.join(root, "library.sqlite"),
      sources: [
        { name: "Notes", type: "note", path: sourceDir, extensions: [".txt"] },
      ],
      chunking: { targetChars: 900, overlapChars: 0, minChars: 80, maxChars: 1200 },
      search: {
        ...defaultConfig.search,
        keywordEnabled: true,
        semanticWeight: 12,
        keywordWeight: 0.2,
        metadataWeight: 0.1,
        sourceWeight: 0.1,
        contentKeywordBonus: 0.02,
        metadataKeywordBonus: 0.01,
      },
      embedding: { ...defaultConfig.embedding, enabled: false },
    });

    try {
      await indexLibrary({ config, compact: false });
    } catch (error) {
      if (/sqlite3 was not found|contentless_delete/i.test(error.message)) {
        t.skip(error.message);
        return;
      }
      throw error;
    }

    const semanticSpanishResult = {
      chunkId: 900001,
      title: "Ensayo sobre Maria Zambrano",
      author: "Investigadora",
      path: "/semantic/maria-red-illness.txt",
      sourceType: "note",
      heading: "La enfermedad roja",
      text: "Maria Zambrano describe la enfermedad roja como una imagen de crisis interior y de revelacion filosofica.",
      snippet: "",
      score: 0,
      kind: "semantic",
    };

    const results = await searchLibrary(
      'What did "the red illness” mean in “María Zambrano”?',
      { config, limit: 5, semanticResults: [semanticSpanishResult] },
    );
    assert.ok(results.length > 0);
    assert.ok(
      results[0].path.endsWith("maria-red-illness.txt"),
      `semantic multilingual result should survive quote filtering and rank first, got ${results[0].path}`,
    );
    assert.ok(
      results.some((result) => result.path.endsWith("literal-but-wrong.txt")),
      "literal quote matches should remain available but not replace semantic meaning",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("semantic bridge promotes answer-bearing multilingual passages", async (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "ollama-pi-chat-semantic-bridge-"),
  );
  try {
    const sourceDir = path.join(root, "sources");
    fs.mkdirSync(sourceDir);
    fs.writeFileSync(
      path.join(sourceDir, "leyes-nuevas-date.txt"),
      [
        "LAS LEYES NUEVAS DE INDIAS",
        "",
        "Las Leyes Nuevas de Indias fueron promulgadas por Carlos V en Barcelona el 20 de noviembre de 1542.",
        "La participacion de los dominicos y, en especial, de Bartolome de las Casas en la genesis de esta legislacion fue decisiva.",
        "Las Casas propuso abolir las encomiendas, tratar a los indigenas como vasallos de la Corona y suspender las guerras de conquista.",
      ].join("\n\n"),
    );
    fs.writeFileSync(
      path.join(sourceDir, "contexto-las-casas.txt"),
      "Bartolome de las Casas fue obispo de Chiapas y critico la violencia colonial en las Indias. ".repeat(
        18,
      ),
    );
    const config = normalizeConfig({
      ...defaultConfig,
      databasePath: path.join(root, "library.sqlite"),
      sources: [
        { name: "Notes", type: "note", path: sourceDir, extensions: [".txt"] },
      ],
      chunking: { targetChars: 900, overlapChars: 0, minChars: 80, maxChars: 1200 },
      search: {
        ...defaultConfig.search,
        keywordEnabled: true,
        semanticWeight: 1,
        keywordWeight: 0.2,
        metadataWeight: 0.1,
        sourceWeight: 0.1,
      },
      embedding: { ...defaultConfig.embedding, enabled: false },
    });

    try {
      await indexLibrary({ config, compact: false });
    } catch (error) {
      if (/sqlite3 was not found|contentless_delete/i.test(error.message)) {
        t.skip(error.message);
        return;
      }
      throw error;
    }

    const semanticNeighbor = {
      chunkId: 910001,
      title: "Bartolome de las Casas",
      author: "Bernat Hernandez",
      path: "/semantic/las-casas-context.txt",
      sourceType: "book",
      heading: "LAS CASAS, OBISPO DE CHIAPAS",
      text: "La funesta acogida de las Leyes Nuevas puso en cuestion el sistema de las Indias. Bartolome de las Casas defendia la evangelizacion pacifica y rechazaba la conquista militar.",
      snippet: "",
      score: 0,
      kind: "semantic",
    };

    const results = await searchLibrary(
      'When were the "Laws of the Indies” established, and what was the opinion of “Bartolomé de las Casas” on the matter?',
      { config, limit: 5, semanticResults: [semanticNeighbor] },
    );

    assert.ok(results.length > 0);
    assert.ok(
      results[0].path.endsWith("leyes-nuevas-date.txt"),
      `semantic bridge should rank the date/opinion passage first, got ${results[0].path}`,
    );
    assert.match(results[0].text, /20 de noviembre de 1542/);
    assert.match(results[0].text, /abolir las encomiendas/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("strict bilingual facets retrieve entity-topic evidence", async (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "ollama-pi-chat-strict-facets-"),
  );
  try {
    const sourceDir = path.join(root, "sources");
    fs.mkdirSync(sourceDir);
    fs.writeFileSync(
      path.join(sourceDir, "Gill Sans - ensayo.txt"),
      "Eric Gill fue un tipografo britanico asociado a Gill Sans. Este pasaje menciona acusaciones de bestialismo y zoofilia en relacion con su biografia. ".repeat(
        8,
      ),
    );
    fs.writeFileSync(
      path.join(sourceDir, "Historia de la zoofilia.txt"),
      "La zoofilia aparece aqui como tema general de historia natural y clasificacion juridica. ".repeat(
        10,
      ),
    );
    fs.writeFileSync(
      path.join(sourceDir, "El extranjero - Albert Camus.txt"),
      "En la novela, Meursault mato al arabe en la playa bajo el sol. El pasaje se centra en Meursault y el arabe. ".repeat(
        8,
      ),
    );
    fs.writeFileSync(
      path.join(sourceDir, "Historia arabe.txt"),
      "Este libro trata de historia arabe, cultura arabe y politica arabe en terminos generales. ".repeat(
        12,
      ),
    );
    fs.writeFileSync(
      path.join(sourceDir, "Biblioteca - Apolodoro.txt"),
      "Durante el reinado de Creonte, Hera envio a la Esfinge, hija de Equidna y Tifon. Apolodoro conserva esta version en la Biblioteca. ".repeat(
        8,
      ),
    );
    fs.writeFileSync(
      path.join(sourceDir, "La Esfinge egipcia.txt"),
      "La esfinge egipcia aparece como monumento y simbolo, sin la version de Apolodoro. ".repeat(
        12,
      ),
    );
    fs.writeFileSync(
      path.join(sourceDir, "Francis Bacon - Wisdom of the Ancients.txt"),
      "Francis Bacon interpreta la Sphinx como una figura de la ciencia y del enigma. In this chapter, Bacon treats the Sphinx as a mythic image of knowledge. ".repeat(
        8,
      ),
    );
    fs.writeFileSync(
      path.join(sourceDir, "La esfinge en Poe.txt"),
      "Este texto menciona la esfinge en una narracion moderna, pero no discute a Francis Bacon. ".repeat(
        12,
      ),
    );
    const config = normalizeConfig({
      ...defaultConfig,
      databasePath: path.join(root, "library.sqlite"),
      sources: [
        { name: "Books", type: "book", path: sourceDir, extensions: [".txt"] },
      ],
      chunking: { targetChars: 700, overlapChars: 0, minChars: 80, maxChars: 1000 },
      search: {
        ...defaultConfig.search,
        keywordEnabled: true,
        maxPassagesPerSource: 5,
      },
      embedding: { ...defaultConfig.embedding, enabled: false },
    });

    try {
      await indexLibrary({ config, compact: false });
    } catch (error) {
      if (/sqlite3 was not found|contentless_delete/i.test(error.message)) {
        t.skip(error.message);
        return;
      }
      throw error;
    }

    const gill = await searchLibrary("typographer who practised zoophilia", {
      config,
      limit: 3,
    });
    assert.match(gill[0].title, /Gill Sans/);

    const meursault = await searchLibrary("Why did Mersault kill an arab?", {
      config,
      limit: 3,
    });
    assert.match(meursault[0].title, /extranjero/i);

    const apollodorus = await searchLibrary(
      "origin of the Sphinx according to Apollodorus",
      { config, limit: 3 },
    );
    assert.match(apollodorus[0].title, /Biblioteca/);
    assert.match(apollodorus[0].text, /Esfinge/);

    const baconEnglish = await searchLibrary(
      "What did Francis Bacon think about the Sphinx",
      { config, limit: 3 },
    );
    assert.match(baconEnglish[0].title, /Francis Bacon/);

    const baconSpanish = await searchLibrary(
      "Qué opinaba Francis Bacon sobre la esfinge",
      { config, limit: 3 },
    );
    assert.match(baconSpanish[0].title, /Francis Bacon/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("guillemets are treated as quote scope", () => {
  const scoped = splitQueryForRetrieval(
    "Que significa «the red illness» segun «María Zambrano»",
  );
  assert.strictEqual(
    scoped.retrievalQuery,
    "the red illness María Zambrano",
  );
  assert.strictEqual(scoped.hasQuotedScope, true);
});

test("detectLanguageHint recognises Spanish and English", () => {
  assert.strictEqual(
    detectLanguageHint("¿Qué dijo Freud sobre el incesto?"),
    "es",
  );
  assert.strictEqual(
    detectLanguageHint("Los heroes de la mitologia clasica"),
    "es",
  );
  assert.strictEqual(
    detectLanguageHint("What did Freud say about incest?"),
    "en",
  );
  // Single proper-noun queries with no stop words are unknown.
  assert.strictEqual(detectLanguageHint("Nijinsky"), "");
});

test("cross-lingual hits are not buried by same-language bonus stacking", async (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "ollama-pi-chat-bilingual-"),
  );
  try {
    const sourceDir = path.join(root, "sources");
    fs.mkdirSync(sourceDir);
    // English book — its title and chunk text both contain the query terms,
    // so before the fix it would stack a large same-language bonus.
    fs.writeFileSync(
      path.join(sourceDir, "The Magnetism of Iron.txt"),
      "The magnetism of iron has been studied by scientists for centuries. ".repeat(
        12,
      ),
    );
    // Spanish book — its title is in Spanish; the chunk explains the same
    // concept. Vector search would surface it; the bonus stage used to bury
    // it. With the Tier 1 fix the same-language bonus is damped 4x so the
    // Spanish book stays in the top-3.
    fs.writeFileSync(
      path.join(sourceDir, "El magnetismo del hierro.txt"),
      "El magnetismo del hierro ha sido estudiado por cientificos durante siglos. ".repeat(
        12,
      ),
    );
    const config = normalizeConfig({
      ...defaultConfig,
      databasePath: path.join(root, "library.sqlite"),
      sources: [
        { name: "Notes", type: "note", path: sourceDir, extensions: [".txt"] },
      ],
      search: { ...defaultConfig.search, keywordEnabled: true },
      embedding: { ...defaultConfig.embedding, enabled: false },
    });

    try {
      await indexLibrary({ config, compact: false });
    } catch (error) {
      if (/sqlite3 was not found|contentless_delete/i.test(error.message)) {
        t.skip(error.message);
        return;
      }
      throw error;
    }

    // English query against the bilingual library — both books should
    // appear, not just the English one.
    const english = await searchLibrary(
      "What is the magnetism of iron and how was it studied?",
      { config, limit: 5 },
    );
    const englishPaths = new Set(english.map((r) => r.path));
    assert.ok(
      englishPaths.size >= 2,
      `English query should surface both files, got: ${[...englishPaths].join(", ")}`,
    );

    // Symmetric: a Spanish query should not bury the English file either.
    const spanish = await searchLibrary(
      "¿Qué se sabe del magnetismo del hierro y cómo se ha estudiado?",
      { config, limit: 5 },
    );
    const spanishPaths = new Set(spanish.map((r) => r.path));
    assert.ok(
      spanishPaths.size >= 2,
      `Spanish query should surface both files, got: ${[...spanishPaths].join(", ")}`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("search algorithm settings are normalized and persisted in config", () => {
  const config = normalizeConfig({
    ...defaultConfig,
    search: {
      ...defaultConfig.search,
      rrfK: "12",
      semanticWeight: "2.5",
      keywordWeight: "0.4",
      metadataWeight: "0.7",
      sourceWeight: "1.9",
      contentKeywordBonus: "0.33",
      metadataKeywordBonus: "0.11",
      maxPassagesPerSource: "9",
    },
  });

  assert.strictEqual(config.search.rrfK, 12);
  assert.strictEqual(config.search.semanticWeight, 2.5);
  assert.strictEqual(config.search.keywordWeight, 0.4);
  assert.strictEqual(config.search.metadataWeight, 0.7);
  assert.strictEqual(config.search.sourceWeight, 1.9);
  assert.strictEqual(config.search.contentKeywordBonus, 0.33);
  assert.strictEqual(config.search.metadataKeywordBonus, 0.11);
  assert.strictEqual(config.search.maxPassagesPerSource, 9);
});

test("library context does not expose local paths or bracket citation instructions", () => {
  const context = buildLibraryContext(
    [
      {
        title: "The Outsider",
        author: "Colin Wilson",
        path: "/Users/sample-user/Libros/Colin Wilson/The Outsider (5126)/The Outsider - Colin Wilson.epub",
        heading: "The Attempt to Gain Control",
        text: "Madame Nijinsky consulted a psychiatrist.",
      },
    ],
    { includeSourcePaths: true },
  );

  assert.match(context, /Work: The Outsider by Colin Wilson/);
  assert.doesNotMatch(context, /\/Users\/sample-user/);
  assert.doesNotMatch(context, /\[1\]/);
  assert.doesNotMatch(context, /Cite retrieved passages/i);
  assert.match(context, /local library has priority/i);
  assert.match(context, /do not call external tools/i);
  assert.match(context, /Every factual claim drawn from these passages/i);
  assert.match(context, /According to Apolodoro's Biblioteca/i);
});

test("source collection skips Calibre sidecar files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ollama-pi-chat-store-"));
  try {
    fs.writeFileSync(path.join(root, "Book.epub"), "");
    fs.writeFileSync(path.join(root, "metadata.opf"), "");
    fs.writeFileSync(path.join(root, "cover.jpg"), "");
    fs.writeFileSync(path.join(root, "note.md"), "");

    const files = collectSourceFiles({
      sources: [
        {
          name: "Test",
          type: "book",
          path: root,
          extensions: [".epub", ".opf", ".jpg", ".md"],
        },
      ],
    });

    assert.deepStrictEqual(
      files.map((file) => path.basename(file.path)).sort(),
      ["Book.epub", "note.md"],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("compact keyword index returns decompressed passage text", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ollama-pi-chat-index-"));
  try {
    const sourceDir = path.join(root, "sources");
    fs.mkdirSync(sourceDir);
    fs.writeFileSync(
      path.join(sourceDir, "note.txt"),
      "Alpha concept appears here.\n\nBeta concept appears later.",
    );
    const config = normalizeConfig({
      ...defaultConfig,
      databasePath: path.join(root, "library.sqlite"),
      sources: [
        {
          name: "Notes",
          type: "note",
          path: sourceDir,
          extensions: [".txt"],
        },
      ],
      search: {
        ...defaultConfig.search,
        keywordEnabled: true,
      },
      embedding: {
        ...defaultConfig.embedding,
        enabled: false,
      },
    });

    try {
      await indexLibrary({ config, compact: false });
    } catch (error) {
      if (/sqlite3 was not found|contentless_delete/i.test(error.message)) {
        t.skip(error.message);
        return;
      }
      throw error;
    }

    const results = await searchLibrary("alpha", { config, limit: 1 });
    assert.strictEqual(results.length, 1);
    assert.match(results[0].text, /Alpha concept appears here/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("source-aware search can deep-scan a named indexed work", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ollama-pi-chat-source-"));
  try {
    const sourceDir = path.join(root, "sources");
    fs.mkdirSync(sourceDir);
    fs.writeFileSync(
      path.join(sourceDir, "Biblioteca - Apolodoro.txt"),
      [
        "Apolodoro escribe una Biblioteca con diferentes comentarios e introducciones.",
        "Apolodoro es mencionado muchas veces en esta introduccion. ".repeat(
          12,
        ),
        "",
        "Apolodoro y su Biblioteca son tratados por Focio en esta seccion preliminar.",
        "Estos parrafos son comentario editorial y no contienen la respuesta. ".repeat(
          12,
        ),
        "",
        "Apolodoro transmite otro relato genealogico de heroes.",
        "Estos parrafos tampoco contienen la palabra clave de la pregunta. ".repeat(
          12,
        ),
        "",
        "Durante el reinado de Creonte, Hera envio a la Esfinge, hija de Equidna y Tifon.",
        "La Esfinge planteaba un enigma a los tebanos.",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(sourceDir, "El mensaje oculto de la Esfinge.txt"),
      "Este libro trata de la esfinge egipcia y teorias modernas.",
    );
    const config = normalizeConfig({
      ...defaultConfig,
      databasePath: path.join(root, "library.sqlite"),
      sources: [
        {
          name: "Books",
          type: "book",
          path: sourceDir,
          extensions: [".txt"],
        },
      ],
      search: {
        ...defaultConfig.search,
        keywordEnabled: false,
      },
      chunking: {
        targetChars: 500,
        overlapChars: 0,
        minChars: 50,
        maxChars: 700,
      },
      embedding: {
        ...defaultConfig.embedding,
        enabled: false,
      },
    });

    await indexLibrary({ config, compact: false });
    const results = await searchLibrary(
      "cual es el origen de la esfinge segun Apolodoro",
      { config, limit: 1 },
    );
    assert.strictEqual(results.length, 1);
    assert.match(results[0].title, /Biblioteca/);
    assert.match(results[0].text, /Hera envio a la Esfinge/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("academic concept search prioritizes subject and variant evidence", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "ollama-pi-chat-concept-"),
  );
  try {
    const sourceDir = path.join(root, "sources");
    fs.mkdirSync(sourceDir);
    fs.writeFileSync(
      path.join(sourceDir, "Biblioteca - Apolodoro.txt"),
      [
        "Durante el reinado de Creonte, Hera envio a la Esfinge, hija de Equidna y Tifon.",
        "La Esfinge planteaba un enigma a los tebanos.",
        "",
        "Notas. Sobre la Esfinge hay versiones distintas.",
        "Hesiodo dice que la Esfinge era hija de Equidna y el perro Orto.",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(sourceDir, "Logica - Aristoteles.txt"),
      "Todos los posibles origenes de una demostracion son tratados aqui, pero no se habla del monstruo tebano.",
    );
    fs.writeFileSync(
      path.join(sourceDir, "Mencion casual de la Esfinge.txt"),
      "La esfinge aparece como ejemplo casual, sin genealogia ni variantes.",
    );
    const config = normalizeConfig({
      ...defaultConfig,
      databasePath: path.join(root, "library.sqlite"),
      sources: [
        {
          name: "Books",
          type: "book",
          path: sourceDir,
          extensions: [".txt"],
        },
      ],
      search: {
        ...defaultConfig.search,
        keywordEnabled: true,
      },
      chunking: {
        targetChars: 500,
        overlapChars: 0,
        minChars: 50,
        maxChars: 700,
      },
      embedding: {
        ...defaultConfig.embedding,
        enabled: false,
      },
    });

    await indexLibrary({ config, compact: false });
    const results = await searchLibrary(
      "Cuáles son todos los posibles orígenes de la esfinge",
      { config, limit: 3 },
    );
    assert.ok(results.length >= 1);
    assert.match(results[0].title, /Biblioteca/);
    assert.match(
      results.map((result) => result.text).join("\n"),
      /Hesiodo|Equidna/,
    );
    assert.doesNotMatch(results[0].title, /Logica/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("library context asks for academic synthesis", () => {
  const context = buildLibraryContext(
    [
      {
        title: "Biblioteca",
        author: "Apolodoro",
        heading: "Notas",
        text: "Hesiodo dice que la Esfinge era hija de Equidna y el perro Orto.",
      },
    ],
    {},
  );

  assert.match(context, /academic researcher/i);
  assert.match(context, /main accounts from variants/i);
  assert.match(context, /skinny one-line extraction/i);
});
