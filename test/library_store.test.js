const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  buildLibraryContext,
  collectSourceFiles,
  indexLibrary,
  normalizeConfig,
  searchLibrary,
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

test("library context does not expose local paths or bracket citation instructions", () => {
  const context = buildLibraryContext(
    [
      {
        title: "The Outsider",
        author: "Colin Wilson",
        path: "/Users/orlandoeb/Libros/Colin Wilson/The Outsider (5126)/The Outsider - Colin Wilson.epub",
        heading: "The Attempt to Gain Control",
        text: "Madame Nijinsky consulted a psychiatrist.",
      },
    ],
    { includeSourcePaths: true },
  );

  assert.match(context, /Work: The Outsider by Colin Wilson/);
  assert.doesNotMatch(context, /\/Users\/orlandoeb/);
  assert.doesNotMatch(context, /\[1\]/);
  assert.doesNotMatch(context, /Cite retrieved passages/i);
  assert.match(context, /local library has priority/i);
  assert.match(context, /do not call external tools/i);
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
