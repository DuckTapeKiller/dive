const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
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
  assert.strictEqual(legacyConfig.embedding.dimensions, 256);
  assert.strictEqual(legacyConfig.search.keywordEnabled, false);
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
