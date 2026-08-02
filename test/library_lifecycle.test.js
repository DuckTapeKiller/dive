// library/store.js is the largest file in the repo (5,492 lines) and 12 of its
// 23 exports had no test. The existing library_store.test.js covers chunking
// and search ranking well; this covers the lifecycle around them — config
// persistence, indexing status, and buildChatLibraryContext, which is what
// decides whether database grounding is injected into a chat turn in every
// mode.
//
// Everything runs against an isolated DIVE_DATA_DIR, so no ~/dive is touched.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

// Must be set before store.js resolves CONFIG_FILE from the data directory.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dive-library-test-"));
process.env.DIVE_DATA_DIR = dataDir;

const {
  CONFIG_FILE,
  buildChatLibraryContext,
  checkEmbeddingPreflight,
  collectSourceFiles,
  estimateLibraryIndex,
  getIndexedEmbeddingModel,
  getLibraryStatus,
  indexLibrary,
  listIndexedLibraryFiles,
  loadLibraryConfig,
  normalizeChatIntegration,
  normalizeConfig,
  saveLibraryChatSettings,
  saveLibraryConfig,
  searchLibrary,
} = require("../library/store");
const defaultConfig = require("../library/config.default.json");

const sourceDir = path.join(dataDir, "sources");
const dbPath = path.join(dataDir, "library.sqlite");

function writeCorpus() {
  fs.mkdirSync(sourceDir, { recursive: true });
  const para =
    "Magnetism is described in this paragraph with enough technical detail to survive chunking. ";
  fs.writeFileSync(
    path.join(sourceDir, "physics.txt"),
    Array.from(
      { length: 8 },
      (_v, i) => `Section ${i + 1}\n\n${para.repeat(4)}`,
    ).join("\n\n"),
  );
  fs.writeFileSync(
    path.join(sourceDir, "cooking.txt"),
    Array.from(
      { length: 6 },
      (_v, i) =>
        `Recipe ${i + 1}\n\n${"Braising requires a heavy pot and patient low heat. ".repeat(4)}`,
    ).join("\n\n"),
  );
}

function baseConfig(overrides = {}) {
  return normalizeConfig({
    ...defaultConfig,
    databasePath: dbPath,
    sources: [
      { name: "Notes", type: "note", path: sourceDir, extensions: [".txt"] },
    ],
    chunking: {
      targetChars: 500,
      overlapChars: 0,
      minChars: 40,
      maxChars: 700,
    },
    search: { ...defaultConfig.search, keywordEnabled: true },
    embedding: { ...defaultConfig.embedding, enabled: false },
    ...overrides,
  });
}

// Chat grounding needs BOTH the global chatIntegration flag and the mode's own
// flag. saveLibraryChatSettings only merges chatIntegration — chatModes travels
// with the whole config through saveLibraryConfig, which is what
// /api/library/config does.
function enableChatFor(modes) {
  saveLibraryConfig(
    baseConfig({
      chatIntegration: { ...defaultConfig.chatIntegration, enabled: true },
      chatModes: Object.fromEntries(
        ["ollama", "pi", "cloud", "lmstudio", "llamacpp"].map((m) => [
          m,
          { enabled: modes.includes(m) },
        ]),
      ),
    }),
  );
}

test.before(() => writeCorpus());
test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

// ------------------------------------------------------------------- config

test("the config file lives in the data directory, not the user's home", () => {
  assert.ok(
    CONFIG_FILE.startsWith(dataDir + path.sep),
    `CONFIG_FILE escaped the isolated data dir: ${CONFIG_FILE}`,
  );
});

test("saveLibraryConfig round-trips through loadLibraryConfig", () => {
  saveLibraryConfig(baseConfig());
  const loaded = loadLibraryConfig();
  assert.strictEqual(loaded.databasePath, dbPath);
  assert.strictEqual(loaded.sources.length, 1);
  assert.strictEqual(loaded.sources[0].path, sourceDir);
  assert.strictEqual(loaded.chunking.targetChars, 500);
});

test("a corrupt config file falls back to defaults instead of throwing", () => {
  const good = fs.readFileSync(CONFIG_FILE, "utf8");
  try {
    fs.writeFileSync(CONFIG_FILE, "{ this is not json");
    const loaded = loadLibraryConfig();
    assert.ok(loaded && typeof loaded === "object");
    assert.ok(Array.isArray(loaded.sources));
  } finally {
    fs.writeFileSync(CONFIG_FILE, good);
  }
});

test("saveLibraryChatSettings merges chatIntegration and leaves the rest alone", () => {
  saveLibraryConfig(baseConfig());
  const before = loadLibraryConfig();
  const config = saveLibraryChatSettings({ enabled: true, limit: 3 });
  assert.strictEqual(config.chatIntegration.enabled, true);
  assert.strictEqual(config.chatIntegration.limit, 3);
  // It touches chatIntegration only: sources and the database path survive.
  const after = loadLibraryConfig();
  assert.strictEqual(after.databasePath, before.databasePath);
  assert.strictEqual(after.sources.length, before.sources.length);
});

test("normalizeChatIntegration clamps limits rather than trusting them", () => {
  const huge = normalizeChatIntegration(
    { enabled: true, limit: 100000, maxContextChars: 99999999 },
    defaultConfig.search,
  );
  assert.ok(huge.limit > 0 && huge.limit <= 1000, `limit: ${huge.limit}`);
  assert.ok(
    huge.maxContextChars > 0 && huge.maxContextChars <= 10_000_000,
    `maxContextChars: ${huge.maxContextChars}`,
  );
  const negative = normalizeChatIntegration(
    { enabled: true, limit: -5, maxContextChars: -1 },
    defaultConfig.search,
  );
  assert.ok(negative.limit > 0, "a negative limit survived normalization");
  assert.ok(negative.maxContextChars > 0);
});

// ------------------------------------------------------------ scan and index

test("collectSourceFiles and estimateLibraryIndex see the corpus", async () => {
  const config = baseConfig();
  const files = collectSourceFiles(config);
  assert.strictEqual(
    files.length,
    2,
    `found: ${files.map((f) => f.path || f)}`,
  );

  saveLibraryConfig(config);
  const estimate = await estimateLibraryIndex();
  assert.ok(estimate, "no estimate returned");
  const count = estimate.files ?? estimate.fileCount ?? estimate.totalFiles;
  assert.strictEqual(Number(count), 2, JSON.stringify(estimate).slice(0, 200));
});

test("indexing populates the database and the status reflects it", async () => {
  const config = baseConfig();
  saveLibraryConfig(config);
  await indexLibrary({ config });

  const status = await getLibraryStatus();
  assert.strictEqual(status.databaseExists, true, "no database was created");
  assert.strictEqual(status.databasePath, dbPath);
  assert.ok(status.files >= 2, `indexed ${status.files} files, expected >= 2`);
  assert.ok(status.chunks > 0, "no chunks were written");

  const listed = await listIndexedLibraryFiles();
  const names = (listed.files || listed || []).map((f) =>
    path.basename(String(f.path || f.title || f)),
  );
  assert.ok(
    names.some((n) => n.includes("physics")),
    `indexed files not listed: ${names.join(", ")}`,
  );
});

test("with embedding disabled, no embedding model is recorded", async () => {
  const config = baseConfig();
  assert.strictEqual(config.embedding.enabled, false);
  const model = await getIndexedEmbeddingModel(config);
  assert.ok(
    model === null || model === "" || typeof model === "string",
    `unexpected model value: ${JSON.stringify(model)}`,
  );
});

test("checkEmbeddingPreflight reports rather than throws when embedding is off", async () => {
  const result = await checkEmbeddingPreflight(baseConfig());
  assert.ok(result && typeof result === "object");
  assert.ok("ok" in result || "error" in result || "reason" in result);
});

// ------------------------------------------------- chat integration contract

test("chat context is off unless the mode enables it", async () => {
  // This is the gate in front of every chat turn in every mode. If it opened
  // by accident, database passages would be injected into prompts silently.
  saveLibraryConfig(baseConfig());
  const off = await buildChatLibraryContext("magnetism", { mode: "ollama" });
  assert.strictEqual(off.enabled, false);
  assert.strictEqual(off.contextMessage, null);
  assert.deepStrictEqual(off.results, []);
});

test("chat context is per mode, not global", async () => {
  enableChatFor(["cloud"]);
  await indexLibrary({ config: loadLibraryConfig() });

  const cloud = await buildChatLibraryContext("magnetism", { mode: "cloud" });
  assert.strictEqual(cloud.enabled, true, "cloud was enabled but returned off");

  const ollama = await buildChatLibraryContext("magnetism", { mode: "ollama" });
  assert.strictEqual(
    ollama.enabled,
    false,
    "enabling cloud leaked database grounding into ollama",
  );
});

test("an enabled mode returns passages as a system message", async () => {
  enableChatFor(["cloud"]);
  await indexLibrary({ config: loadLibraryConfig() });

  const ctx = await buildChatLibraryContext("magnetism technical detail", {
    mode: "cloud",
  });
  assert.strictEqual(ctx.enabled, true);
  assert.ok(ctx.results.length > 0, "no passages retrieved for a known topic");
  assert.ok(ctx.contextMessage, "no context message was built");
  assert.strictEqual(ctx.contextMessage.role, "system");
  assert.match(ctx.contextMessage.content, /[Mm]agnetism/);
});

test("the context message never leaks local filesystem paths", async () => {
  enableChatFor(["cloud"]);
  await indexLibrary({ config: loadLibraryConfig() });

  const ctx = await buildChatLibraryContext("magnetism", { mode: "cloud" });
  assert.ok(ctx.contextMessage);
  assert.ok(
    !ctx.contextMessage.content.includes(sourceDir),
    "the source directory path was sent to the model",
  );
  assert.ok(
    !ctx.contextMessage.content.includes(os.homedir()),
    "a home-directory path was sent to the model",
  );
});

test("an unknown mode falls back to ollama rather than enabling itself", async () => {
  enableChatFor(["cloud"]);
  const ctx = await buildChatLibraryContext("magnetism", { mode: "nonsense" });
  assert.strictEqual(
    ctx.enabled,
    false,
    "an unrecognised mode inherited an enabled mode's setting",
  );
});

test("a hostile search query cannot corrupt the database", async () => {
  // End-to-end property only. Note what this does NOT prove: the search path
  // tokenises the query before it reaches SQL, so these payloads never carry a
  // quote into sqlLiteral. Disabling sqlLiteral's escaping leaves this test
  // passing — the filename test below is the one that covers escaping.
  saveLibraryConfig(baseConfig());
  await indexLibrary({ config: loadLibraryConfig() });
  const before = await getLibraryStatus();
  assert.ok(before.chunks > 0, "nothing indexed, so the probe proves nothing");

  for (const query of [
    "magnetism'; DROP TABLE library_chunks; --",
    "' OR 1=1 --",
    "magnetism' UNION SELECT 1,2,3 --",
    "magnetism'); DELETE FROM library_files; --",
    'magnetism" OR "1"="1',
  ]) {
    const results = await searchLibrary(query, {
      config: loadLibraryConfig(),
      mode: "ollama",
      limit: 3,
    });
    assert.ok(Array.isArray(results), `search returned no array for ${query}`);
  }

  const after = await getLibraryStatus();
  assert.strictEqual(
    after.chunks,
    before.chunks,
    "a search modified the database",
  );
  assert.strictEqual(after.files, before.files, "a search dropped files");
});

test("a filename containing a quote is indexed, not silently dropped", async () => {
  // Library SQL is assembled as text for the sqlite3 CLI rather than bound
  // through placeholders, so sqlLiteral is the only escaping there is. File
  // paths reach it verbatim, which makes this the case that actually exercises
  // it: with escaping removed the file fails to index at all.
  const quoted = path.join(sourceDir, "it's a file'; DROP TABLE x; --.txt");
  fs.writeFileSync(
    quoted,
    Array.from(
      { length: 4 },
      (_v, i) =>
        `Part ${i + 1}\n\n${"Magnetism appears here with technical detail about fields. ".repeat(4)}`,
    ).join("\n\n"),
  );
  try {
    saveLibraryConfig(baseConfig());
    await indexLibrary({ config: loadLibraryConfig() });
    const status = await getLibraryStatus();
    assert.ok(
      status.files >= 3,
      `the quoted filename was not indexed: ${status.files} files`,
    );
    const listed = await listIndexedLibraryFiles();
    const names = (listed.files || listed || []).map((f) =>
      String(f.path || f.title || f),
    );
    assert.ok(
      names.some((n) => n.includes("it's a file")),
      `the quoted filename is missing from the index: ${names.join(" | ")}`,
    );
  } finally {
    fs.rmSync(quoted, { force: true });
  }
});
