const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const zlib = require("zlib");
const { execFile, spawn, spawnSync } = require("child_process");
const { extractEpub, parseOpfMetadata } = require("./epub");

const DATA_DIR = path.join(os.homedir(), "dive");
const CONFIG_FILE = path.join(DATA_DIR, "library-config.json");
const DEFAULT_CONFIG_FILE = path.join(__dirname, "config.default.json");
const SCHEMA_FILE = path.join(__dirname, "schema.sql");
const SQLITE_TIMEOUT_MS = 120000;
const SQLITE_MAX_BUFFER = 64 * 1024 * 1024;
const EMBEDDING_RETRY_ATTEMPTS = 3;
const EMBEDDING_RETRY_BASE_DELAY_MS = 500;
const EMBEDDING_DOCUMENT_MAX_CHARS = 1200;
const DEFAULT_HYBRID_CANDIDATE_LIMIT = 80;
const DEFAULT_RRF_K = 60;
const DEFAULT_METADATA_CAP = 0.45;
const DEFAULT_SOURCE_HINT_CAP = 0.75;
const SOURCE_SKIP_DIRS = new Set([
  ".git",
  ".obsidian",
  ".trash",
  "node_modules",
  "dist",
  "release",
]);
const SOURCE_SKIP_FILES = new Set([
  "cover.jpg",
  "cover.jpeg",
  "cover.png",
  "cover.webp",
  "metadata.opf",
]);
const MIN_EPUB_TEXT_CHARS = 800;
const MIN_EPUB_PARAGRAPHS = 3;
const SEARCH_STOP_WORDS = new Set([
  "about",
  "according",
  "algo",
  "al",
  "algun",
  "alguna",
  "algunas",
  "algunos",
  "and",
  "book",
  "books",
  "busca",
  "causa",
  "causas",
  "cause",
  "causes",
  "cual",
  "cuales",
  "cuando",
  "cuanto",
  "cuantos",
  "como",
  "de",
  "del",
  "dime",
  "diferente",
  "diferentes",
  "donde",
  "el",
  "en",
  "era",
  "eran",
  "es",
  "esa",
  "ese",
  "eso",
  "esta",
  "este",
  "from",
  "fue",
  "fueron",
  "how",
  "la",
  "las",
  "libro",
  "los",
  "mi",
  "mis",
  "obra",
  "obras",
  "origin",
  "origins",
  "origen",
  "origenes",
  "para",
  "por",
  "que",
  "quien",
  "quienes",
  "se",
  "ser",
  "segun",
  "son",
  "sobre",
  "su",
  "sus",
  "that",
  "the",
  "this",
  "toda",
  "todas",
  "todo",
  "todos",
  "un",
  "una",
  "unas",
  "unos",
  "all",
  "possible",
  "posible",
  "posibles",
  "various",
  "what",
  "where",
  "who",
  "why",
]);

const QUERY_CONCEPTS = [
  {
    name: "genealogy",
    triggers: [
      "genealogia",
      "genealogias",
      "genealogico",
      "genealogica",
      "descendencia",
      "linaje",
      "parentage",
      "genealogy",
      "lineage",
    ],
    expansions: [
      "genealogia",
      "descendencia",
      "linaje",
      "hija",
      "hijo",
      "hijas",
      "hijos",
      "padre",
      "madre",
      "padres",
      "progenitores",
      "parentage",
      "lineage",
      "daughter",
      "father",
      "mother",
      "parents",
    ],
  },
  {
    name: "origin",
    triggers: [
      "origen",
      "origenes",
      "procedencia",
      "nacimiento",
      "origin",
      "origins",
      "source",
    ],
    expansions: [
      "origen",
      "origenes",
      "procedencia",
      "nacimiento",
      "descendencia",
      "linaje",
      "hija",
      "hijo",
      "origin",
      "origins",
      "parentage",
      "lineage",
    ],
  },
  {
    name: "variants",
    triggers: [
      "variante",
      "variantes",
      "version",
      "versiones",
      "tradicion",
      "tradiciones",
      "posible",
      "posibles",
      "todo",
      "todos",
      "toda",
      "todas",
      "variant",
      "variants",
      "version",
      "versions",
      "tradition",
      "traditions",
      "possible",
      "all",
    ],
    expansions: [
      "variante",
      "variantes",
      "version",
      "versiones",
      "tradicion",
      "tradiciones",
      "distinta",
      "distintas",
      "variant",
      "variants",
      "version",
      "versions",
      "tradition",
      "traditions",
    ],
  },
];

let cachedSqlitePath = null;
let cachedSqliteExtensionPath = null;
const sqliteInfoCache = new Map();

function readEmbeddedAsset(assetName) {
  try {
    const sea = require("node:sea");
    if (sea.isSea()) return sea.getAsset(assetName, "utf8");
  } catch (_error) {}
  return null;
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function expandHome(value) {
  if (typeof value !== "string") return "";
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function loadDefaultConfig() {
  const embedded = readEmbeddedAsset("library/config.default.json");
  if (typeof embedded === "string") return JSON.parse(embedded);
  return JSON.parse(fs.readFileSync(DEFAULT_CONFIG_FILE, "utf8"));
}

function mergeConfig(base, override) {
  const next = {
    ...base,
    ...(override || {}),
    chunking: { ...base.chunking, ...(override?.chunking || {}) },
    search: { ...base.search, ...(override?.search || {}) },
    embedding: { ...base.embedding, ...(override?.embedding || {}) },
    chatIntegration: {
      ...base.chatIntegration,
      ...(override?.chatIntegration || {}),
    },
    watch: { ...base.watch, ...(override?.watch || {}) },
  };
  next.sources = Array.isArray(override?.sources)
    ? override.sources
    : base.sources;
  return next;
}

function normalizeExtensions(extensions) {
  if (!Array.isArray(extensions)) return [".txt"];
  const normalized = extensions
    .map((extension) =>
      String(extension || "")
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean)
    .map((extension) =>
      extension.startsWith(".") ? extension : `.${extension}`,
    );
  return normalized.length ? Array.from(new Set(normalized)) : [".txt"];
}

function hasExactExtensions(extensions, expected) {
  if (extensions.length !== expected.length) return false;
  const extensionSet = new Set(extensions);
  return expected.every((extension) => extensionSet.has(extension));
}

function normalizeSourceExtensions(source, sourcePath, extensions) {
  const oldDefaultBooksPath = path.normalize(path.join(os.homedir(), "Libros"));
  const isOldBooksDefault =
    source.name === "Books" &&
    source.type === "book" &&
    path.normalize(sourcePath) === oldDefaultBooksPath &&
    hasExactExtensions(extensions, [".epub", ".txt"]);
  return isOldBooksDefault ? [".epub"] : extensions;
}

function normalizeChatIntegration(raw, searchConfig = {}) {
  const maxLimit = clampNumber(searchConfig.maxLimit, 1, 50, 50);
  return {
    enabled: raw?.enabled === true,
    limit: clampNumber(raw?.limit, 1, maxLimit, 5),
    maxContextChars: clampNumber(raw?.maxContextChars, 1000, 50000, 12000),
    includeSourcePaths: raw?.includeSourcePaths !== false,
  };
}

function normalizeVectorQuantization(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return normalized === "float" || normalized === "float32"
    ? "float32"
    : "int8";
}

function normalizeConfig(rawConfig) {
  const defaults = loadDefaultConfig();
  const merged = mergeConfig(defaults, rawConfig || {});
  const databasePath = expandHome(
    typeof merged.databasePath === "string"
      ? merged.databasePath
      : defaults.databasePath,
  );
  const rawSearchMaxLimit = Number(merged.search?.maxLimit);
  const usesLegacySearchMaxLimit =
    rawSearchMaxLimit === 20 && Number(defaults.search?.maxLimit) === 50;
  const search = {
    keywordEnabled: merged.search?.keywordEnabled === true,
    defaultLimit: clampNumber(merged.search?.defaultLimit, 1, 50, 5),
    maxLimit: usesLegacySearchMaxLimit
      ? 50
      : clampNumber(merged.search?.maxLimit, 1, 50, 50),
    maxContextChars: clampNumber(
      merged.search?.maxContextChars,
      1000,
      50000,
      12000,
    ),
    rrfK: clampNumber(merged.search?.rrfK, 1, 100, 60),
    semanticWeight: clampNumber(merged.search?.semanticWeight, 0, 3, 1.0),
    keywordWeight: clampNumber(merged.search?.keywordWeight, 0, 3, 1.1),
    metadataWeight: clampNumber(merged.search?.metadataWeight, 0, 3, 0.8),
    sourceWeight: clampNumber(merged.search?.sourceWeight, 0, 3, 1.2),
    contentKeywordBonus: clampNumber(merged.search?.contentKeywordBonus, 0, 1, 0.16),
    metadataKeywordBonus: clampNumber(merged.search?.metadataKeywordBonus, 0, 1, 0.06),
  };
  const rawChunking = merged.chunking || {};
  const usesLegacyChunkDefaults =
    (Number(rawChunking.targetChars) === 1800 &&
      Number(rawChunking.overlapChars) === 220 &&
      Number(rawChunking.minChars) === 120 &&
      Number(rawChunking.maxChars) === 2800) ||
    (Number(rawChunking.targetChars) === 4200 &&
      Number(rawChunking.overlapChars) === 120 &&
      Number(rawChunking.minChars) === 300 &&
      Number(rawChunking.maxChars) === 6500);
  const chunkingSource = usesLegacyChunkDefaults ? {} : rawChunking;
  const chunking = {
    targetChars: clampNumber(chunkingSource.targetChars, 500, 10000, 2400),
    overlapChars: clampNumber(chunkingSource.overlapChars, 0, 2000, 0),
    minChars: clampNumber(chunkingSource.minChars, 20, 2000, 300),
    maxChars: clampNumber(chunkingSource.maxChars, 500, 20000, 3200),
  };
  const sources = (Array.isArray(merged.sources) ? merged.sources : [])
    .map((source, index) => {
      const rawSourcePath = String(source?.path || "").trim();
      const unescapedPath = rawSourcePath.replace(/\\([\s~()\[\]{}*?])/g, "$1");
      const sourcePath = expandHome(unescapedPath);
      const sourceName = String(source?.name || `Source ${index + 1}`).trim();
      const sourceType =
        String(source?.type || "document").trim() || "document";
      const extensions = normalizeExtensions(source?.extensions);
      return {
        name: sourceName,
        type: sourceType,
        path: sourcePath,
        extensions: normalizeSourceExtensions(
          { name: sourceName, type: sourceType },
          sourcePath,
          extensions,
        ),
      };
    })
    .filter((source) => source.path);
  const embedding = {
    enabled: merged.embedding?.enabled === true,
    model:
      String(merged.embedding?.model || "").trim() || defaults.embedding.model,
    ollamaBaseUrl:
      String(merged.embedding?.ollamaBaseUrl || "").trim() ||
      defaults.embedding.ollamaBaseUrl,
    batchSize: clampNumber(merged.embedding?.batchSize, 1, 64, 16),
    dimensions: clampNumber(merged.embedding?.dimensions, 0, 4096, 0),
    quantization: normalizeVectorQuantization(merged.embedding?.quantization),
    sqliteVecExtensionPath: expandHome(
      String(merged.embedding?.sqliteVecExtensionPath || "").trim(),
    ),
  };
  const watch = {
    enabled: merged.watch?.enabled === true,
    debounceMs: clampNumber(merged.watch?.debounceMs, 250, 60000, 2000),
    rescanIntervalMs: clampNumber(
      merged.watch?.rescanIntervalMs,
      5000,
      3600000,
      60000,
    ),
  };

  return {
    version: 1,
    databasePath,
    sources,
    chunking,
    search,
    embedding,
    chatIntegration: normalizeChatIntegration(merged.chatIntegration, search),
    watch,
  };
}

function ensureConfigFile() {
  ensureDataDir();
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(loadDefaultConfig(), null, 2));
  }
}

function loadLibraryConfig() {
  ensureConfigFile();
  try {
    return normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")));
  } catch (_error) {
    return normalizeConfig(loadDefaultConfig());
  }
}

function saveLibraryConfig(nextConfig) {
  ensureDataDir();
  const current = loadLibraryConfig();
  const normalized = normalizeConfig(mergeConfig(current, nextConfig || {}));
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(normalized, null, 2));
  return normalized;
}

function saveLibraryChatSettings(rawSettings) {
  const current = loadLibraryConfig();
  const chatIntegration = normalizeChatIntegration(
    {
      ...current.chatIntegration,
      ...(rawSettings || {}),
    },
    current.search,
  );
  return saveLibraryConfig({ ...current, chatIntegration });
}

function sqliteCandidatePaths() {
  const platformCandidates =
    process.platform === "darwin"
      ? [
          "/opt/homebrew/opt/sqlite/bin/sqlite3",
          "/usr/local/opt/sqlite/bin/sqlite3",
          "/opt/homebrew/bin/sqlite3",
          "/usr/local/bin/sqlite3",
          "/usr/bin/sqlite3",
          "sqlite3",
        ]
      : process.platform === "win32"
        ? ["sqlite3.exe", "sqlite3"]
        : [
            "/usr/local/bin/sqlite3",
            "/usr/bin/sqlite3",
            "/bin/sqlite3",
            "sqlite3",
          ];
  const candidates = [process.env.SQLITE3_PATH, ...platformCandidates].filter(
    Boolean,
  );
  return Array.from(new Set(candidates));
}

function sqliteInstallHint() {
  if (process.platform === "darwin") {
    return "Install Homebrew SQLite or set SQLITE3_PATH to a sqlite3 binary that was not built with OMIT_LOAD_EXTENSION.";
  }
  if (process.platform === "win32") {
    return "Install the SQLite command-line tools for Windows and set SQLITE3_PATH to sqlite3.exe.";
  }
  return "Install the sqlite3 package for your Linux distribution or set SQLITE3_PATH to a compatible sqlite3 binary.";
}

function inspectSqlitePath(candidate) {
  if (sqliteInfoCache.has(candidate)) return sqliteInfoCache.get(candidate);
  const versionResult = spawnSync(candidate, ["-version"], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (versionResult.status !== 0) {
    const unavailable = { available: false, path: candidate };
    sqliteInfoCache.set(candidate, unavailable);
    return unavailable;
  }
  const compileResult = spawnSync(
    candidate,
    [":memory:", "PRAGMA compile_options;"],
    {
      encoding: "utf8",
      timeout: 5000,
    },
  );
  const compileOptions =
    compileResult.status === 0 ? String(compileResult.stdout || "") : "";
  const info = {
    available: true,
    path: candidate,
    version: String(versionResult.stdout || "").trim(),
    supportsLoadExtension: !/\bOMIT_LOAD_EXTENSION\b/.test(compileOptions),
  };
  sqliteInfoCache.set(candidate, info);
  return info;
}

function findSqlitePath(options = {}) {
  const requireLoadExtension = options.requireLoadExtension === true;
  if (requireLoadExtension && cachedSqliteExtensionPath) {
    return cachedSqliteExtensionPath;
  }
  if (!requireLoadExtension && cachedSqlitePath) return cachedSqlitePath;

  for (const candidate of sqliteCandidatePaths()) {
    const info = inspectSqlitePath(candidate);
    if (!info.available) continue;
    if (requireLoadExtension && !info.supportsLoadExtension) {
      continue;
    }
    if (requireLoadExtension) cachedSqliteExtensionPath = candidate;
    else cachedSqlitePath = candidate;
    return candidate;
  }
  return null;
}

function requireSqlitePath(options = {}) {
  const sqlitePath = findSqlitePath(options);
  if (!sqlitePath) {
    if (options.requireLoadExtension === true) {
      throw new Error(
        `Semantic search requires a SQLite binary with loadable extension support. ${sqliteInstallHint()}`,
      );
    }
    throw new Error(`sqlite3 was not found. ${sqliteInstallHint()}`);
  }
  return sqlitePath;
}

function quoteDotPath(filePath) {
  return `"${String(filePath).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function extensionLoadCommand(extensionPath) {
  if (!extensionPath) return "";
  return `.load ${quoteDotPath(extensionPath)}\n`;
}

function runSqliteScript(dbPath, script, options = {}) {
  const sqlitePath = requireSqlitePath({
    requireLoadExtension: Boolean(options.loadExtensionPath),
  });
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const prefix =
    ".bail on\n.timeout 5000\n" +
    extensionLoadCommand(options.loadExtensionPath) +
    (options.json ? ".mode json\n" : "");
  return new Promise((resolve, reject) => {
    const child = spawn(sqlitePath, [dbPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("sqlite3 timed out."));
    }, options.timeoutMs || SQLITE_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > SQLITE_MAX_BUFFER) {
        child.kill("SIGTERM");
        reject(new Error("sqlite3 output exceeded the safety limit."));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(
          new Error((stderr || `sqlite3 exited with code ${code}`).trim()),
        );
      }
    });
    child.stdin.end(`${prefix}${script}\n`);
  });
}

function runSqliteJson(dbPath, sql, options = {}) {
  if (options.loadExtensionPath) {
    return runSqliteScript(dbPath, sql, { ...options, json: true }).then(
      parseSqliteJson,
    );
  }
  const sqlitePath = requireSqlitePath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  return new Promise((resolve, reject) => {
    execFile(
      sqlitePath,
      ["-cmd", ".timeout 5000", "-json", dbPath, sql],
      {
        encoding: "utf8",
        timeout: SQLITE_TIMEOUT_MS,
        maxBuffer: SQLITE_MAX_BUFFER,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error((stderr || error.message).trim()));
          return;
        }
        try {
          resolve(parseSqliteJson(stdout));
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
  });
}

function parseSqliteJson(stdout) {
  const trimmed = String(stdout || "").trim();
  if (!trimmed) return [];
  return JSON.parse(trimmed);
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value)
    .replace(/\u0000/g, "")
    .replace(/'/g, "''")}'`;
}

function sqlInteger(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? String(parsed) : String(fallback);
}

function sqlBlob(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return "NULL";
  return `X'${buffer.toString("hex")}'`;
}

function compressChunkText(text) {
  const raw = Buffer.from(String(text || ""), "utf8");
  return {
    encoding: "deflate",
    rawBytes: raw.length,
    compressed: zlib.deflateSync(raw, { level: 6 }),
  };
}

function decompressChunkText(row) {
  const fallback = String(row?.text || "");
  const encoding = String(row?.textEncoding || row?.text_encoding || "plain");
  const hex = String(row?.textCompressedHex || row?.text_compressed_hex || "");
  if (!hex || encoding === "plain") return fallback;
  try {
    const compressed = Buffer.from(hex, "hex");
    if (encoding === "deflate")
      return zlib.inflateSync(compressed).toString("utf8");
  } catch (_error) {
    return fallback;
  }
  return fallback;
}

async function initDatabase(config = loadLibraryConfig()) {
  const embeddedSchema = readEmbeddedAsset("library/schema.sql");
  const schema =
    typeof embeddedSchema === "string"
      ? embeddedSchema
      : fs.readFileSync(SCHEMA_FILE, "utf8");
  await runSqliteScript(config.databasePath, schema);
  await ensureTableColumn(
    config.databasePath,
    "library_files",
    "author",
    "TEXT",
  );
  await ensureTableColumn(
    config.databasePath,
    "library_files",
    "index_signature",
    "TEXT NOT NULL DEFAULT ''",
  );
  await ensureTableColumn(
    config.databasePath,
    "library_chunks",
    "text_compressed",
    "BLOB",
  );
  await ensureTableColumn(
    config.databasePath,
    "library_chunks",
    "text_encoding",
    "TEXT NOT NULL DEFAULT 'plain'",
  );
  await ensureTableColumn(
    config.databasePath,
    "library_chunks",
    "text_size",
    "INTEGER NOT NULL DEFAULT 0",
  );
  await migrateLegacyEmbeddingTable(config.databasePath);
  await ensureKeywordIndexState(config);
}

async function ensureTableColumn(dbPath, tableName, columnName, columnType) {
  const rows = await runSqliteJson(dbPath, `PRAGMA table_info(${tableName});`);
  const exists = rows.some((row) => row.name === columnName);
  if (!exists) {
    await runSqliteScript(
      dbPath,
      `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType};`,
    );
  }
}

async function migrateLegacyEmbeddingTable(dbPath) {
  const rows = await runSqliteJson(
    dbPath,
    "PRAGMA table_info(library_embeddings);",
  );
  const hasLegacyJson = rows.some((row) => row.name === "embedding_json");
  if (!hasLegacyJson) return;
  await runSqliteScript(
    dbPath,
    `PRAGMA foreign_keys = OFF;
BEGIN;
CREATE TABLE IF NOT EXISTS library_embeddings_next (
  chunk_id INTEGER PRIMARY KEY REFERENCES library_chunks(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR REPLACE INTO library_embeddings_next(chunk_id, model, dimensions, created_at)
SELECT chunk_id, model, dimensions, created_at
FROM library_embeddings
WHERE chunk_id IN (SELECT id FROM library_chunks);
DROP TABLE library_embeddings;
ALTER TABLE library_embeddings_next RENAME TO library_embeddings;
COMMIT;
PRAGMA foreign_keys = ON;
CREATE INDEX IF NOT EXISTS library_embeddings_model_idx ON library_embeddings(model);`,
  );
}

async function ensureKeywordIndexState(config) {
  const dropLegacySql = `DROP TRIGGER IF EXISTS library_chunks_ai;
DROP TRIGGER IF EXISTS library_chunks_ad;
DROP TRIGGER IF EXISTS library_chunks_au;
DROP VIEW IF EXISTS library_chunks_fts_source;`;
  if (config.search?.keywordEnabled !== true) {
    await runSqliteScript(
      config.databasePath,
      `${dropLegacySql}
DROP TABLE IF EXISTS library_chunks_fts;`,
    );
    return;
  }

  let shouldCreate = true;
  try {
    const rows = await runSqliteJson(
      config.databasePath,
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'library_chunks_fts';",
    );
    const ftsSql = String(rows[0]?.sql || "");
    shouldCreate =
      !ftsSql ||
      !/content\s*=\s*''/i.test(ftsSql) ||
      !/contentless_delete\s*=\s*1/i.test(ftsSql) ||
      /columnsize\s*=\s*0/i.test(ftsSql) ||
      !/detail\s*=\s*none/i.test(ftsSql);
  } catch (_error) {}

  const resetSql = shouldCreate
    ? "DROP TABLE IF EXISTS library_chunks_fts;"
    : "";
  await runSqliteScript(
    config.databasePath,
    `${dropLegacySql}
${resetSql}
CREATE VIRTUAL TABLE IF NOT EXISTS library_chunks_fts USING fts5(
  title,
  heading,
  text,
  content='',
  contentless_delete=1,
  detail=none,
  tokenize='unicode61 remove_diacritics 2'
);`,
  );
}

async function getFileKeywordGaps(config, filePath) {
  if (config.search?.keywordEnabled !== true) return { chunks: 0, missing: 0 };
  const rows = await runSqliteJson(
    config.databasePath,
    `SELECT
  COUNT(c.id) AS chunks,
  COALESCE(SUM(CASE WHEN fts.rowid IS NULL THEN 1 ELSE 0 END), 0) AS missing
FROM library_chunks c
JOIN library_files f ON f.id = c.file_id
LEFT JOIN library_chunks_fts fts ON fts.rowid = c.id
WHERE f.path = ${sqlLiteral(filePath)};`,
  );
  return {
    chunks: Math.max(0, Number(rows[0]?.chunks || 0)),
    missing: Math.max(0, Number(rows[0]?.missing || 0)),
  };
}

async function syncKeywordIndexForFile(config, filePath) {
  if (config.search?.keywordEnabled !== true) return 0;
  const rows = await runSqliteJson(
    config.databasePath,
    `SELECT
  c.id AS chunkId,
  f.title AS title,
  c.heading AS heading,
  c.text AS text,
  hex(c.text_compressed) AS textCompressedHex,
  c.text_encoding AS textEncoding
FROM library_chunks c
JOIN library_files f ON f.id = c.file_id
WHERE f.path = ${sqlLiteral(filePath)}
ORDER BY c.chunk_index;`,
  );
  const insertSql = rows
    .map((row) => {
      const text = decompressChunkText(row);
      return `INSERT OR REPLACE INTO library_chunks_fts(rowid, title, heading, text)
VALUES (${sqlInteger(row.chunkId)}, ${sqlLiteral(row.title || "")}, ${sqlLiteral(row.heading || "")}, ${sqlLiteral(text)});`;
    })
    .join("\n");
  await runSqliteScript(
    config.databasePath,
    `BEGIN;
DELETE FROM library_chunks_fts
WHERE rowid IN (
  SELECT c.id
  FROM library_chunks c
  JOIN library_files f ON f.id = c.file_id
  WHERE f.path = ${sqlLiteral(filePath)}
);
${insertSql}
COMMIT;`,
  );
  return rows.length;
}

function isVectorSearchConfigured(config) {
  return Boolean(
    config.embedding?.enabled === true &&
    config.embedding.sqliteVecExtensionPath &&
    fs.existsSync(config.embedding.sqliteVecExtensionPath) &&
    findSqlitePath({ requireLoadExtension: true }),
  );
}

function vectorStorageMode(config) {
  return normalizeVectorQuantization(config.embedding?.quantization);
}

function vectorColumnType(config, dimensions) {
  const prefix = vectorStorageMode(config) === "int8" ? "int8" : "float";
  return `${prefix}[${sqlInteger(dimensions, 0)}]`;
}

function vectorSqlExpression(config, vectorJson) {
  const literal = sqlLiteral(vectorJson);
  if (vectorStorageMode(config) === "int8") {
    return `vec_quantize_int8(vec_f32(${literal}), 'unit')`;
  }
  return literal;
}

async function ensureVectorTable(config, dimensions) {
  if (!isVectorSearchConfigured(config)) return false;
  const dimensionText = sqlInteger(dimensions, 0);
  if (dimensionText === "0") return false;
  const existingRows = await runSqliteJson(
    config.databasePath,
    "SELECT key, value FROM library_vector_meta WHERE key IN ('dimensions', 'model', 'quantization');",
  );
  const existingMeta = Object.fromEntries(
    existingRows.map((row) => [row.key, row.value]),
  );
  const existingDimensions = existingMeta.dimensions;
  const existingModel = existingMeta.model;
  const existingQuantization = existingMeta.quantization || "float32";
  const quantization = vectorStorageMode(config);
  const shouldReset =
    (existingDimensions && existingDimensions !== dimensionText) ||
    (existingModel && existingModel !== config.embedding.model) ||
    (existingQuantization && existingQuantization !== quantization);
  const resetSql = shouldReset
    ? "DROP TABLE IF EXISTS library_chunks_vec;\nDELETE FROM library_vector_meta WHERE key IN ('dimensions', 'model', 'quantization');\nDELETE FROM library_embeddings;\n"
    : "";
  await runSqliteScript(
    config.databasePath,
    `${resetSql}
CREATE VIRTUAL TABLE IF NOT EXISTS library_chunks_vec USING vec0(
  chunk_id INTEGER PRIMARY KEY,
  embedding ${vectorColumnType(config, dimensionText)}
);
INSERT OR REPLACE INTO library_vector_meta(key, value) VALUES ('dimensions', ${sqlLiteral(dimensionText)});
INSERT OR REPLACE INTO library_vector_meta(key, value) VALUES ('model', ${sqlLiteral(config.embedding.model)});
INSERT OR REPLACE INTO library_vector_meta(key, value) VALUES ('quantization', ${sqlLiteral(quantization)});
`,
    { loadExtensionPath: config.embedding.sqliteVecExtensionPath },
  );
  return true;
}

async function pruneVectorTable(config) {
  if (!isVectorSearchConfigured(config)) return;
  try {
    await runSqliteScript(
      config.databasePath,
      "DELETE FROM library_chunks_vec WHERE chunk_id NOT IN (SELECT id FROM library_chunks);",
      { loadExtensionPath: config.embedding.sqliteVecExtensionPath },
    );
  } catch (_error) {}
}

async function deleteVectorRowsForFile(config, filePath) {
  if (!isVectorSearchConfigured(config)) return;
  try {
    await runSqliteScript(
      config.databasePath,
      `DELETE FROM library_chunks_vec
WHERE chunk_id IN (
  SELECT c.id
  FROM library_chunks c
  JOIN library_files f ON f.id = c.file_id
  WHERE f.path = ${sqlLiteral(filePath)}
);`,
      { loadExtensionPath: config.embedding.sqliteVecExtensionPath },
    );
  } catch (_error) {}
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function hashJson(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function buildIndexSignature(config) {
  return hashJson({
    schema: 4,
    extractor: "epub-cleanup-v2",
    storage: {
      textEncoding: "deflate",
    },
    chunking: {
      targetChars: config.chunking.targetChars,
      overlapChars: config.chunking.overlapChars,
      minChars: config.chunking.minChars,
      maxChars: config.chunking.maxChars,
    },
  });
}

function createCancelledError() {
  const error = new Error("Library indexing was cancelled.");
  error.cancelled = true;
  return error;
}

function assertNotCancelled(options) {
  if (typeof options.shouldCancel === "function" && options.shouldCancel()) {
    throw createCancelledError();
  }
}

function fileTitle(filePath) {
  return path.basename(filePath, path.extname(filePath)).replace(/[_-]+/g, " ");
}

function cleanParagraph(text) {
  return String(text || "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function isBoilerplateParagraph(paragraph) {
  const normalized = paragraph.toLowerCase().replace(/\s+/g, " ").trim();
  return (
    normalized === "contents" ||
    normalized === "table of contents" ||
    normalized === "copyright" ||
    normalized === "cover" ||
    normalized === "title page"
  );
}

function stripFrontmatter(text) {
  return String(text || "").replace(/^---\n[\s\S]*?\n---\n?/, "");
}

function paragraphsWithLineNumbers(text) {
  const normalized = stripFrontmatter(text)
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "");
  const lines = normalized.split("\n");
  const paragraphs = [];
  let buffer = [];
  let startLine = 1;

  function flush(endLine) {
    if (!buffer.length) return;
    const raw = buffer.join("\n");
    const clean = cleanParagraph(raw);
    if (clean && !isBoilerplateParagraph(clean)) {
      paragraphs.push({ text: clean, startLine, endLine });
    }
    buffer = [];
  }

  lines.forEach((line, index) => {
    if (!line.trim()) {
      flush(index);
      startLine = index + 2;
      return;
    }
    if (!buffer.length) startLine = index + 1;
    buffer.push(line);
  });
  flush(lines.length);
  return paragraphs;
}

function detectHeading(paragraph) {
  const text = paragraph.text.trim();
  const markdownHeading = text.match(/^#{1,6}\s+(.{1,120})$/);
  if (markdownHeading) return markdownHeading[1].trim();
  const chapterHeading = text.match(
    /^(chapter|part|book|section)\s+[\wivxlcdm.-]+(?:\s*[:.-]\s*.+)?$/i,
  );
  if (chapterHeading && text.length <= 120) return text;
  if (/^[A-Z0-9 ,.'":;!?-]{4,90}$/.test(text) && text.length <= 90) {
    return text;
  }
  return "";
}

function estimateTokens(text) {
  return Math.ceil(String(text || "").length / 4);
}

function buildChunks(text, chunking) {
  const paragraphs = paragraphsWithLineNumbers(text);
  const chunks = [];
  let activeHeading = "";
  let current = [];
  let currentChars = 0;

  function overlapParagraphs(items) {
    const overlap = [];
    let chars = 0;
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (chars + item.text.length > chunking.overlapChars && overlap.length) {
        break;
      }
      overlap.unshift(item);
      chars += item.text.length;
    }
    return overlap;
  }

  function flush() {
    if (!current.length) return;
    const joined = current
      .map((item) => item.text)
      .join("\n\n")
      .trim();
    if (joined.length >= chunking.minChars || !chunks.length) {
      chunks.push({
        chunkIndex: chunks.length,
        heading: activeHeading,
        text: joined.slice(0, chunking.maxChars),
        tokenEstimate: estimateTokens(joined),
        startLine: current[0].startLine,
        endLine: current[current.length - 1].endLine,
      });
    }
    current = overlapParagraphs(current);
    currentChars = current.reduce((sum, item) => sum + item.text.length, 0);
  }

  for (const paragraph of paragraphs) {
    const heading = detectHeading(paragraph);
    if (heading) activeHeading = heading;
    const nextSize = paragraph.text.length + (current.length ? 2 : 0);
    if (
      current.length &&
      currentChars + nextSize > chunking.targetChars &&
      currentChars >= chunking.minChars
    ) {
      flush();
    }
    current.push(paragraph);
    currentChars += nextSize;
    if (currentChars >= chunking.maxChars) flush();
  }
  flush();
  return chunks;
}

function collectSourceFiles(config) {
  const files = [];
  for (const source of config.sources) {
    if (!fs.existsSync(source.path)) {
      console.warn(`[Library] Source path not found: ${source.path}`);
      continue;
    }
    const root = fs.realpathSync(source.path);
    const stack = [root];
    const extensionSet = new Set(source.extensions);
    while (stack.length) {
      const current = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch (error) {
        console.warn(`[Library] Could not read directory ${current}: ${error.message}`);
        continue;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".") && entry.name !== ".notes") continue;
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (!SOURCE_SKIP_DIRS.has(entry.name.toLowerCase()))
            stack.push(fullPath);
          continue;
        }
        if (!entry.isFile()) continue;
        if (SOURCE_SKIP_FILES.has(entry.name.toLowerCase())) continue;
        if (extensionSet.has(path.extname(entry.name).toLowerCase())) {
          files.push({ path: fullPath, source });
        }
      }
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

async function getExistingFile(config, filePath) {
  const rows = await runSqliteJson(
    config.databasePath,
    `SELECT
  id,
  size_bytes AS sizeBytes,
  mtime_ms AS mtimeMs,
  sha256,
  index_signature AS indexSignature,
  chunk_count AS chunkCount
FROM library_files
WHERE path = ${sqlLiteral(filePath)}
LIMIT 1;`,
  );
  return rows[0] || null;
}

function existingFileCanBeReused(existing, stat, indexSignature) {
  if (!existing) return false;
  const unchanged =
    Number(existing.sizeBytes) === stat.size &&
    Number(existing.mtimeMs) === Math.round(stat.mtimeMs);
  if (!unchanged) return false;
  if (existing.indexSignature === indexSignature) return true;
  return Boolean(
    existing.indexSignature && Number(existing.chunkCount || 0) > 0,
  );
}

function createDocumentSkipError(message) {
  const error = new Error(message);
  error.skipDocument = true;
  return error;
}

function isDocumentSkipError(error) {
  return (
    error?.skipDocument === true ||
    /EPUB did not contain extractable spine text/i.test(error?.message || "")
  );
}

function countParagraphBlocks(text) {
  return String(text || "")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean).length;
}

function assertReadableEpubText(filePath, text) {
  const compactChars = String(text || "")
    .replace(/\s+/g, " ")
    .trim().length;
  const paragraphCount = countParagraphBlocks(text);
  if (
    compactChars < MIN_EPUB_TEXT_CHARS ||
    paragraphCount < MIN_EPUB_PARAGRAPHS
  ) {
    throw createDocumentSkipError(
      `EPUB has too little extractable text after cleanup (${compactChars} chars, ${paragraphCount} paragraphs): ${path.basename(filePath)}`,
    );
  }
}

function readCalibreMetadataFallback(filePath) {
  const metadataPath = path.join(path.dirname(filePath), "metadata.opf");
  if (!fs.existsSync(metadataPath))
    return { title: "", author: "", warning: "" };
  try {
    const metadata = parseOpfMetadata(fs.readFileSync(metadataPath, "utf8"));
    return {
      title: metadata.title || "",
      author: metadata.author || "",
      warning: "",
    };
  } catch (error) {
    return {
      title: "",
      author: "",
      warning: `Could not read metadata.opf fallback: ${error.message}`,
    };
  }
}

async function readLibraryDocument(file) {
  const extension = path.extname(file.path).toLowerCase();
  if (extension === ".epub") {
    const epub = await extractEpub(file.path);
    const fallback = readCalibreMetadataFallback(file.path);
    assertReadableEpubText(file.path, epub.text);
    return {
      title: epub.title || fallback.title || fileTitle(file.path),
      author: epub.author || fallback.author || "",
      text: epub.text,
      warnings: [
        ...(epub.warnings || []),
        ...(fallback.warning ? [fallback.warning] : []),
      ],
      format: "epub",
    };
  }

  const text = fs.readFileSync(file.path, "utf8");
  return {
    title: fileTitle(file.path),
    author: "",
    text,
    warnings: [],
    format: extension.replace(/^\./, "") || "text",
  };
}

async function upsertFileChunks(
  config,
  file,
  document,
  fileHash,
  stat,
  chunks,
  indexSignature,
) {
  const storedChunks = chunks.map((chunk) => ({
    ...chunk,
    storedText: compressChunkText(chunk.text),
  }));
  const chunkSql = storedChunks
    .map(
      (chunk) => `INSERT INTO library_chunks(
  file_id,
  chunk_index,
  heading,
  text,
  text_compressed,
  text_encoding,
  text_size,
  token_estimate,
  start_line,
  end_line
) VALUES (
  (SELECT id FROM library_files WHERE path = ${sqlLiteral(file.path)}),
  ${sqlInteger(chunk.chunkIndex)},
  ${sqlLiteral(chunk.heading)},
  '',
  ${sqlBlob(chunk.storedText.compressed)},
  ${sqlLiteral(chunk.storedText.encoding)},
  ${sqlInteger(chunk.storedText.rawBytes)},
  ${sqlInteger(chunk.tokenEstimate)},
  ${sqlInteger(chunk.startLine, "NULL")},
  ${sqlInteger(chunk.endLine, "NULL")}
);`,
    )
    .join("\n");
  const ftsSql =
    config.search?.keywordEnabled === true
      ? storedChunks
          .map(
            (
              chunk,
            ) => `INSERT INTO library_chunks_fts(rowid, title, heading, text)
VALUES (
  (SELECT c.id
   FROM library_chunks c
   JOIN library_files f ON f.id = c.file_id
   WHERE f.path = ${sqlLiteral(file.path)} AND c.chunk_index = ${sqlInteger(chunk.chunkIndex)}
   LIMIT 1),
  ${sqlLiteral(document.title || fileTitle(file.path))},
  ${sqlLiteral(chunk.heading)},
  ${sqlLiteral(chunk.text)}
);`,
          )
          .join("\n")
      : "";
  await deleteVectorRowsForFile(config, file.path);
  await runSqliteScript(
    config.databasePath,
    `PRAGMA foreign_keys = ON;
BEGIN;
${
  config.search?.keywordEnabled === true
    ? `DELETE FROM library_chunks_fts
WHERE rowid IN (
  SELECT c.id
  FROM library_chunks c
  JOIN library_files f ON f.id = c.file_id
  WHERE f.path = ${sqlLiteral(file.path)}
);`
    : ""
}
DELETE FROM library_files WHERE path = ${sqlLiteral(file.path)};
INSERT INTO library_files(
  source_name,
  source_type,
  path,
  title,
  author,
  size_bytes,
  mtime_ms,
  sha256,
  index_signature,
  indexed_at,
  chunk_count
) VALUES (
  ${sqlLiteral(file.source.name)},
  ${sqlLiteral(file.source.type)},
  ${sqlLiteral(file.path)},
  ${sqlLiteral(document.title || fileTitle(file.path))},
  ${sqlLiteral(document.author || "")},
  ${sqlInteger(stat.size)},
  ${sqlInteger(Math.round(stat.mtimeMs))},
  ${sqlLiteral(fileHash)},
  ${sqlLiteral(indexSignature)},
  CURRENT_TIMESTAMP,
  ${sqlInteger(chunks.length)}
);
${chunkSql}
${ftsSql}
COMMIT;`,
  );
  return {
    textBytes: storedChunks.reduce(
      (sum, chunk) => sum + chunk.storedText.rawBytes,
      0,
    ),
    compressedBytes: storedChunks.reduce(
      (sum, chunk) => sum + chunk.storedText.compressed.length,
      0,
    ),
  };
}

function normalizeOllamaBaseUrl(baseUrl) {
  return String(baseUrl || "http://127.0.0.1:11434").replace(/\/+$/, "");
}

function embeddingModelProfile(model) {
  const normalized = String(model || "").toLowerCase();
  if (normalized.includes("nomic-embed-text")) {
    return {
      queryPrefix: "search_query: ",
      documentPrefix: "search_document: ",
      nativeDimensions: 768,
    };
  }
  if (normalized.includes("mxbai")) {
    return {
      queryPrefix: "Represent this sentence for searching relevant passages: ",
      documentPrefix: "",
      nativeDimensions: 1024,
    };
  }
  if (normalized.includes("bge-m3")) {
    return { queryPrefix: "", documentPrefix: "", nativeDimensions: 1024 };
  }
  return { queryPrefix: "", documentPrefix: "", nativeDimensions: 768 };
}

function compactDocumentEmbeddingText(text) {
  const cleanText = String(text || "");
  if (cleanText.length <= EMBEDDING_DOCUMENT_MAX_CHARS) return cleanText;
  const separator = "\n\n...\n\n";
  const budget = Math.max(100, EMBEDDING_DOCUMENT_MAX_CHARS - separator.length);
  const headChars = Math.ceil(budget / 2);
  const tailChars = Math.floor(budget / 2);
  return `${cleanText.slice(0, headChars)}${separator}${cleanText.slice(-tailChars)}`;
}

function formatEmbeddingInput(config, text, purpose) {
  const cleanText =
    purpose === "document"
      ? compactDocumentEmbeddingText(text)
      : String(text || "");
  const profile = embeddingModelProfile(config.embedding.model);
  const prefix =
    purpose === "query" ? profile.queryPrefix : profile.documentPrefix;
  return `${prefix}${cleanText}`;
}

function normalizeVector(vector, dimensions) {
  if (!Array.isArray(vector)) return [];
  const numeric = vector
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
  const desiredDimensions = Number(dimensions) || 0;
  const trimmed =
    desiredDimensions > 0 && numeric.length > desiredDimensions
      ? numeric.slice(0, desiredDimensions)
      : numeric;
  const length = Math.sqrt(
    trimmed.reduce((sum, value) => sum + value * value, 0),
  );
  if (!length) return trimmed;
  return trimmed.map((value) => value / length);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readOllamaError(response) {
  let body = "";
  try {
    body = await response.text();
  } catch (_error) {}
  if (!body) return "";
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed?.error === "string") return parsed.error;
  } catch (_error) {}
  return body.slice(0, 500);
}

function formatOllamaHttpError(status, detail) {
  return detail
    ? `Ollama embedding request failed (${status}): ${detail}`
    : `Ollama embedding request failed (${status}).`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function embedTexts(config, texts, purpose = "document") {
  const baseUrl = normalizeOllamaBaseUrl(config.embedding.ollamaBaseUrl);
  const model = config.embedding.model;
  const inputs = texts.map((text) =>
    formatEmbeddingInput(config, text, purpose),
  );
  const requestedDimensions = Math.max(
    0,
    Number(config.embedding.dimensions || 0),
  );
  const body = { model, input: inputs };
  if (requestedDimensions > 0) body.dimensions = requestedDimensions;
  const embedResponse = await fetchWithTimeout(`${baseUrl}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (embedResponse.ok) {
    const payload = await embedResponse.json();
    if (Array.isArray(payload.embeddings)) {
      return payload.embeddings.map((vector) =>
        normalizeVector(vector, config.embedding.dimensions),
      );
    }
  }
  const embedError = await readOllamaError(embedResponse);
  if (embedResponse.status !== 404 && embedResponse.status !== 405) {
    throw new Error(formatOllamaHttpError(embedResponse.status, embedError));
  }

  const embeddings = [];
  for (const text of inputs) {
    const legacyResponse = await fetchWithTimeout(`${baseUrl}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: text }),
    });
    if (!legacyResponse.ok) {
      const legacyError = await readOllamaError(legacyResponse);
      throw new Error(
        formatOllamaHttpError(legacyResponse.status, legacyError || embedError),
      );
    }
    const payload = await legacyResponse.json();
    if (!Array.isArray(payload.embedding)) {
      throw new Error("Ollama embedding response did not include a vector.");
    }
    embeddings.push(
      normalizeVector(payload.embedding, config.embedding.dimensions),
    );
  }
  return embeddings;
}

function emitEmbeddingIssue(options, issue) {
  if (typeof options.onError !== "function") return;
  options.onError({
    kind: "embedding_error",
    timestamp: new Date().toISOString(),
    ...issue,
  });
}

async function embedAndStoreBatch(config, batch) {
  const vectors = await embedTexts(
    config,
    batch.map((row) => decompressChunkText(row)),
    "document",
  );
  const firstVector = vectors.find((vector) => Array.isArray(vector));
  const dimensions = firstVector?.length || 0;
  const vectorTableReady = await ensureVectorTable(config, dimensions);
  const insertSql = vectors
    .map((vector, vectorIndex) => {
      const chunkId = batch[vectorIndex].id;
      const vectorJson = JSON.stringify(vector);
      const commonSql = `INSERT OR REPLACE INTO library_embeddings(chunk_id, model, dimensions, created_at)
VALUES (${sqlInteger(chunkId)}, ${sqlLiteral(config.embedding.model)}, ${sqlInteger(vector.length)}, CURRENT_TIMESTAMP);`;
      if (!vectorTableReady) return commonSql;
      return `${commonSql}
INSERT OR REPLACE INTO library_chunks_vec(chunk_id, embedding)
VALUES (${sqlInteger(chunkId)}, ${vectorSqlExpression(config, vectorJson)});`;
    })
    .join("\n");
  await runSqliteScript(config.databasePath, `BEGIN;\n${insertSql}\nCOMMIT;`, {
    loadExtensionPath: vectorTableReady
      ? config.embedding.sqliteVecExtensionPath
      : "",
  });
  return vectors.length;
}

async function embedBatchWithRetries(config, batch, options, meta = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= EMBEDDING_RETRY_ATTEMPTS; attempt += 1) {
    assertNotCancelled(options);
    try {
      const embedded = await embedAndStoreBatch(config, batch);
      return { embedded, errors: 0, errorMessage: "" };
    } catch (error) {
      lastError = error;
      if (attempt < EMBEDDING_RETRY_ATTEMPTS) {
        await sleep(EMBEDDING_RETRY_BASE_DELAY_MS * attempt);
      }
    }
  }

  if (batch.length > 1) {
    let embedded = 0;
    let errors = 0;
    let errorMessage = lastError?.message || "";
    for (const row of batch) {
      const result = await embedBatchWithRetries(config, [row], options, {
        ...meta,
        batchSize: 1,
        chunkIds: [row.id],
      });
      embedded += result.embedded;
      errors += result.errors;
      errorMessage = result.errorMessage || errorMessage;
    }
    return { embedded, errors, errorMessage };
  }

  const errorMessage = lastError?.message || "Unknown embedding error.";
  emitEmbeddingIssue(options, {
    filePath: meta.filePath || "",
    batchStart: meta.batchStart || 0,
    batchSize: batch.length,
    chunkIds: batch.map((row) => row.id),
    error: errorMessage,
  });
  console.warn(
    `Embedding failed for ${meta.filePath || "unknown file"}: ${errorMessage}`,
  );
  return { embedded: 0, errors: batch.length, errorMessage };
}

async function embedFileChunks(config, filePath, options = {}) {
  if (config.embedding.enabled !== true || options.embeddingReady !== true) {
    return { embedded: 0, errors: 0 };
  }
  const expectedDimensions = Math.max(
    0,
    Number(options.dimensions || config.embedding.dimensions || 0),
  );
  const vectorTableConfigured = isVectorSearchConfigured(config);
  const missingEmbeddingFilter =
    options.onlyMissing === true
      ? vectorTableConfigured
        ? `AND (
  NOT EXISTS (
    SELECT 1
    FROM library_embeddings e
    WHERE e.chunk_id = c.id
      AND e.model = ${sqlLiteral(config.embedding.model)}
      AND e.dimensions = ${sqlInteger(expectedDimensions)}
  )
  OR NOT EXISTS (
    SELECT 1
    FROM library_chunks_vec v
    WHERE v.chunk_id = c.id
  )
)`
        : `AND NOT EXISTS (
  SELECT 1
  FROM library_embeddings e
  WHERE e.chunk_id = c.id
    AND e.model = ${sqlLiteral(config.embedding.model)}
    AND e.dimensions = ${sqlInteger(expectedDimensions)}
)`
      : "";
  const rows = await runSqliteJson(
    config.databasePath,
    `SELECT
  c.id,
  c.text,
  hex(c.text_compressed) AS textCompressedHex,
  c.text_encoding AS textEncoding
FROM library_chunks c
JOIN library_files f ON f.id = c.file_id
WHERE f.path = ${sqlLiteral(filePath)}
${missingEmbeddingFilter}
ORDER BY c.chunk_index;`,
    vectorTableConfigured && options.onlyMissing === true
      ? { loadExtensionPath: config.embedding.sqliteVecExtensionPath }
      : {},
  );
  let embedded = 0;
  let errors = 0;
  for (
    let index = 0;
    index < rows.length;
    index += config.embedding.batchSize
  ) {
    assertNotCancelled(options);
    const batch = rows.slice(index, index + config.embedding.batchSize);
    const result = await embedBatchWithRetries(config, batch, options, {
      filePath,
      batchStart: index,
      batchSize: batch.length,
      chunkIds: batch.map((row) => row.id),
    });
    embedded += result.embedded;
    errors += result.errors;
    if (typeof options.onBatch === "function") {
      options.onBatch({
        embeddedDelta: result.embedded,
        errorsDelta: result.errors,
        errorMessage: result.errorMessage,
      });
    }
  }
  return { embedded, errors };
}

async function getFileEmbeddingGaps(config, filePath, dimensions) {
  if (config.embedding.enabled !== true) {
    return { chunks: 0, missing: 0 };
  }
  const expectedDimensions = Math.max(
    0,
    Number(dimensions || config.embedding.dimensions || 0),
  );
  const vectorTableConfigured = isVectorSearchConfigured(config);
  const rows = await runSqliteJson(
    config.databasePath,
    `SELECT
  COUNT(c.id) AS chunks,
  COALESCE(SUM(CASE WHEN e.chunk_id IS NULL${vectorTableConfigured ? " OR v.chunk_id IS NULL" : ""} THEN 1 ELSE 0 END), 0) AS missing
FROM library_chunks c
JOIN library_files f ON f.id = c.file_id
LEFT JOIN library_embeddings e
  ON e.chunk_id = c.id
 AND e.model = ${sqlLiteral(config.embedding.model)}
 AND e.dimensions = ${sqlInteger(expectedDimensions)}
${
  vectorTableConfigured
    ? `LEFT JOIN library_chunks_vec v
  ON v.chunk_id = c.id
`
    : ""
}WHERE f.path = ${sqlLiteral(filePath)};`,
    vectorTableConfigured
      ? { loadExtensionPath: config.embedding.sqliteVecExtensionPath }
      : {},
  );
  return {
    chunks: Math.max(0, Number(rows[0]?.chunks || 0)),
    missing: Math.max(0, Number(rows[0]?.missing || 0)),
  };
}

async function pruneMissingFiles(config, livePaths) {
  const rows = await runSqliteJson(
    config.databasePath,
    "SELECT path FROM library_files ORDER BY path;",
  );
  const live = new Set(livePaths);
  const missing = rows
    .map((row) => row.path)
    .filter((filePath) => !live.has(filePath) && !fs.existsSync(filePath));
  if (!missing.length) return 0;
  const deleteSql = missing
    .map(
      (filePath) =>
        `${
          config.search?.keywordEnabled === true
            ? `DELETE FROM library_chunks_fts
WHERE rowid IN (
  SELECT c.id
  FROM library_chunks c
  JOIN library_files f ON f.id = c.file_id
  WHERE f.path = ${sqlLiteral(filePath)}
);`
            : ""
        }
DELETE FROM library_files WHERE path = ${sqlLiteral(filePath)};`,
    )
    .join("\n");
  for (const filePath of missing) {
    await deleteVectorRowsForFile(config, filePath);
  }
  await runSqliteScript(
    config.databasePath,
    `PRAGMA foreign_keys = ON;\nBEGIN;\n${deleteSql}\nCOMMIT;`,
  );
  await pruneVectorTable(config);
  return missing.length;
}

function summarizeIndexProgress(stats, updates = {}) {
  const scanned = Number(stats.scanned || 0);
  const processed = Number(stats.processed || 0);
  const chunks = Number(stats.chunks || 0);
  const embedded = Number(stats.embedded || 0);
  const embeddingsSkipped = Number(stats.embeddingsSkipped || 0);
  const embeddingErrors = Number(stats.embeddingErrors || 0);
  const phase = updates.phase || "indexing";
  const percent =
    phase === "completed"
      ? 100
      : scanned > 0
        ? Math.min(99, Math.floor((processed / scanned) * 100))
        : 0;
  return {
    phase,
    percent,
    scanned,
    processed,
    currentFile: updates.currentFile || null,
    currentFileIndex: updates.currentFileIndex || 0,
    indexed: Number(stats.indexed || 0),
    skipped: Number(stats.skipped || 0),
    pruned: Number(stats.pruned || 0),
    chunks,
    textBytes: Number(stats.textBytes || 0),
    compressedBytes: Number(stats.compressedBytes || 0),
    embedded,
    embeddingsSkipped,
    embeddingErrors,
    embeddingPending: Math.max(
      0,
      chunks - embedded - embeddingsSkipped - embeddingErrors,
    ),
    warnings: Array.isArray(stats.warnings) ? stats.warnings.length : 0,
    skippedDocuments: Array.isArray(stats.skippedDocuments)
      ? stats.skippedDocuments.length
      : 0,
    errors: Array.isArray(stats.errors) ? stats.errors.length : 0,
    recentErrors: Array.isArray(stats.recentErrors)
      ? stats.recentErrors.slice(-5)
      : [],
    embeddingPreflightError: stats.embeddingPreflightError || "",
    embeddingReady: stats.embeddingReady === true,
    estimatedFinalBytes:
      processed > 0
        ? Math.round(
            ((Number(stats.compressedBytes || 0) +
              chunks *
                Math.max(0, Number(stats.embeddingDimensions || 0)) *
                Math.max(1, Number(stats.vectorBytesPerDimension || 4))) /
              processed) *
              scanned,
          )
        : 0,
    ...updates,
  };
}

function emitIndexProgress(options, stats, updates = {}) {
  if (typeof options.onProgress !== "function") return;
  options.onProgress(summarizeIndexProgress(stats, updates));
}

function recordIndexIssue(stats, options, issue) {
  const entry = {
    timestamp: new Date().toISOString(),
    ...issue,
  };
  stats.recentErrors.push(entry);
  stats.recentErrors = stats.recentErrors.slice(-10);
  if (typeof options.onError === "function") {
    options.onError(entry);
  }
  return entry;
}

async function checkEmbeddingPreflight(config) {
  if (config.embedding.enabled !== true) {
    return { ready: false, error: "" };
  }
  if (!config.embedding.sqliteVecExtensionPath) {
    return {
      ready: false,
      error:
        "sqlite-vec extension path is not configured. Semantic embeddings were skipped.",
    };
  }
  if (!fs.existsSync(config.embedding.sqliteVecExtensionPath)) {
    return {
      ready: false,
      error: `sqlite-vec extension was not found at ${config.embedding.sqliteVecExtensionPath}. Semantic embeddings were skipped.`,
    };
  }
  const extensionSqlitePath = findSqlitePath({ requireLoadExtension: true });
  if (!extensionSqlitePath) {
    return {
      ready: false,
      error: `Semantic search requires SQLite with loadable extension support. ${sqliteInstallHint()}`,
    };
  }
  try {
    const vectors = await embedTexts(config, ["embedding preflight"], "query");
    const firstVector = vectors.find((vector) => Array.isArray(vector));
    if (!firstVector?.length) {
      return {
        ready: false,
        error: "Embedding model returned no vector during preflight.",
      };
    }
    await ensureVectorTable(config, firstVector.length);
    return { ready: true, dimensions: firstVector.length, error: "" };
  } catch (error) {
    return {
      ready: false,
      error: `Embedding preflight failed: ${error.message}`,
    };
  }
}

async function compactDatabase(config) {
  await runSqliteScript(
    config.databasePath,
    `PRAGMA wal_checkpoint(TRUNCATE);
VACUUM;
PRAGMA optimize;`,
    { timeoutMs: 15 * 60 * 1000 },
  );
}

function sampleSourceFiles(files, sampleLimit) {
  const limit = clampNumber(sampleLimit, 1, 1000, 150);
  if (files.length <= limit) return files;
  const sampled = [];
  const seen = new Set();
  const step = files.length / limit;
  for (let index = 0; index < limit; index += 1) {
    const file = files[Math.floor(index * step)];
    if (file && !seen.has(file.path)) {
      sampled.push(file);
      seen.add(file.path);
    }
  }
  return sampled;
}

function summarizeChunkStorage(chunks) {
  return chunks.reduce(
    (summary, chunk) => {
      const stored = compressChunkText(chunk.text);
      summary.textBytes += stored.rawBytes;
      summary.compressedBytes += stored.compressed.length;
      return summary;
    },
    { textBytes: 0, compressedBytes: 0 },
  );
}

function estimatedEmbeddingDimensions(config) {
  const configured = Math.max(0, Number(config.embedding?.dimensions || 0));
  if (configured > 0) return configured;
  return embeddingModelProfile(config.embedding?.model).nativeDimensions || 768;
}

function vectorBytesPerDimension(config) {
  return vectorStorageMode(config) === "int8" ? 1 : 4;
}

async function estimateLibraryIndex(options = {}) {
  const config = options.config || loadLibraryConfig();
  const files = collectSourceFiles(config);
  const sampleFiles = sampleSourceFiles(files, options.sampleLimit || 150);
  const sample = {
    files: 0,
    chunks: 0,
    textBytes: 0,
    compressedBytes: 0,
    errors: [],
    skippedDocuments: [],
    outliers: [],
  };

  for (const file of sampleFiles) {
    try {
      const document = await readLibraryDocument(file);
      const chunks = buildChunks(document.text, config.chunking);
      const storage = summarizeChunkStorage(chunks);
      sample.files += 1;
      sample.chunks += chunks.length;
      sample.textBytes += storage.textBytes;
      sample.compressedBytes += storage.compressedBytes;
      sample.outliers.push({
        path: file.path,
        title: document.title || fileTitle(file.path),
        chunks: chunks.length,
        textBytes: storage.textBytes,
        compressedBytes: storage.compressedBytes,
      });
    } catch (error) {
      if (isDocumentSkipError(error)) {
        sample.skippedDocuments.push({
          path: file.path,
          reason: error.message,
        });
      } else {
        sample.errors.push({ path: file.path, error: error.message });
      }
    }
  }

  const scale = sample.files > 0 ? files.length / sample.files : 0;
  const estimatedChunks = Math.round(sample.chunks * scale);
  const estimatedTextBytes = Math.round(sample.textBytes * scale);
  const estimatedCompressedBytes = Math.round(sample.compressedBytes * scale);
  const vectorBytes =
    config.embedding.enabled === true
      ? estimatedChunks *
        estimatedEmbeddingDimensions(config) *
        vectorBytesPerDimension(config)
      : 0;
  const keywordBytes =
    config.search.keywordEnabled === true
      ? Math.round(estimatedTextBytes * 0.25)
      : 0;
  const overheadBytes = Math.round(
    (estimatedCompressedBytes + vectorBytes + keywordBytes) * 0.2,
  );

  sample.outliers.sort((a, b) => b.chunks - a.chunks);
  return {
    files: files.length,
    sampledFiles: sample.files,
    sampleSkippedDocuments: sample.skippedDocuments.length,
    sampleErrors: sample.errors.length,
    estimatedChunks,
    estimatedTextBytes,
    estimatedCompressedBytes,
    estimatedVectorBytes: vectorBytes,
    estimatedKeywordBytes: keywordBytes,
    estimatedOverheadBytes: overheadBytes,
    estimatedTotalBytes:
      estimatedCompressedBytes + vectorBytes + keywordBytes + overheadBytes,
    config: {
      chunking: config.chunking,
      search: config.search,
      embedding: {
        enabled: config.embedding.enabled,
        model: config.embedding.model,
        dimensions: config.embedding.dimensions,
        estimatedDimensions: estimatedEmbeddingDimensions(config),
        quantization: vectorStorageMode(config),
      },
    },
    outliers: sample.outliers.slice(0, 10),
    errors: sample.errors.slice(0, 10),
    skippedDocuments: sample.skippedDocuments.slice(0, 10),
  };
}

async function indexLibrary(options = {}) {
  const config = options.config || loadLibraryConfig();
  const force = options.force === true;
  await initDatabase(config);
  const files = collectSourceFiles(config);
  const startFileIndex = Math.max(
    0,
    Math.min(
      files.length,
      Number.isFinite(Number(options.startFileIndex))
        ? Math.floor(Number(options.startFileIndex))
        : 0,
    ),
  );
  const resumeProgress =
    options.resumeProgress && typeof options.resumeProgress === "object"
      ? options.resumeProgress
      : {};
  const resumeNumber = (key, fallback = 0) => {
    if (startFileIndex <= 0) return fallback;
    const value = Number(resumeProgress[key]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const stats = {
    scanned: files.length,
    processed: startFileIndex,
    resumedFromFileIndex: startFileIndex,
    indexed: resumeNumber("indexed"),
    skipped: resumeNumber("skipped"),
    pruned: 0,
    chunks: resumeNumber("chunks"),
    textBytes: resumeNumber("textBytes"),
    compressedBytes: resumeNumber("compressedBytes"),
    embedded: resumeNumber("embedded"),
    embeddingsSkipped: resumeNumber("embeddingsSkipped"),
    embeddingErrors: resumeNumber("embeddingErrors"),
    embeddingReady: false,
    embeddingDimensions: config.embedding.dimensions || 0,
    vectorBytesPerDimension: vectorBytesPerDimension(config),
    embeddingPreflightError: "",
    warnings: [],
    skippedDocuments: [],
    errors: [],
    recentErrors: [],
    databasePath: config.databasePath,
  };

  emitIndexProgress(options, stats, { phase: "embedding-preflight" });
  assertNotCancelled(options);
  const embeddingPreflight = await checkEmbeddingPreflight(config);
  const embeddingReady = embeddingPreflight.ready === true;
  stats.embeddingReady = embeddingReady;
  if (embeddingPreflight.dimensions) {
    stats.embeddingDimensions = embeddingPreflight.dimensions;
  }
  stats.embeddingPreflightError = embeddingPreflight.error || "";
  const indexSignature = buildIndexSignature(config);

  for (
    let fileIndex = startFileIndex;
    fileIndex < files.length;
    fileIndex += 1
  ) {
    const file = files[fileIndex];
    emitIndexProgress(options, stats, {
      phase: "indexing",
      currentFile: file.path,
      currentFileIndex: fileIndex + 1,
    });
    assertNotCancelled(options);
    try {
      const stat = fs.statSync(file.path);
      const existing = await getExistingFile(config, file.path);
      if (!force && existingFileCanBeReused(existing, stat, indexSignature)) {
        stats.skipped += 1;
        if (config.search?.keywordEnabled === true) {
          const keywordGaps = await getFileKeywordGaps(config, file.path);
          if (keywordGaps.missing > 0) {
            emitIndexProgress(options, stats, {
              phase: "keyword-indexing",
              currentFile: file.path,
              currentFileIndex: fileIndex + 1,
            });
            await syncKeywordIndexForFile(config, file.path);
          }
        }
        if (embeddingReady) {
          const gaps = await getFileEmbeddingGaps(
            config,
            file.path,
            stats.embeddingDimensions,
          );
          if (gaps.missing > 0) {
            stats.chunks += gaps.missing;
            emitIndexProgress(options, stats, {
              phase: "embedding",
              currentFile: file.path,
              currentFileIndex: fileIndex + 1,
            });
            await embedFileChunks(config, file.path, {
              embeddingReady,
              onlyMissing: true,
              dimensions: stats.embeddingDimensions,
              shouldCancel: options.shouldCancel,
              onError: (entry) => {
                const issue = recordIndexIssue(stats, options, entry);
                emitIndexProgress(options, stats, {
                  phase: "embedding",
                  currentFile: file.path,
                  currentFileIndex: fileIndex + 1,
                  lastEmbeddingError: issue.error || issue.reason || "",
                });
              },
              onBatch: (batchStats) => {
                stats.embedded += batchStats.embeddedDelta || 0;
                stats.embeddingErrors += batchStats.errorsDelta || 0;
                emitIndexProgress(options, stats, {
                  phase: "embedding",
                  currentFile: file.path,
                  currentFileIndex: fileIndex + 1,
                  lastEmbeddingError: batchStats.errorMessage || "",
                });
              },
            });
          }
        }
        continue;
      }
      const fileHash = await hashFile(file.path);
      if (
        !force &&
        existing &&
        existing.sha256 === fileHash &&
        (existing.indexSignature === indexSignature ||
          (existing.indexSignature && Number(existing.chunkCount || 0) > 0))
      ) {
        await runSqliteScript(
          config.databasePath,
          `UPDATE library_files SET size_bytes = ${sqlInteger(stat.size)}, mtime_ms = ${sqlInteger(Math.round(stat.mtimeMs))} WHERE path = ${sqlLiteral(file.path)};`,
        );
        stats.skipped += 1;
        if (config.search?.keywordEnabled === true) {
          const keywordGaps = await getFileKeywordGaps(config, file.path);
          if (keywordGaps.missing > 0) {
            emitIndexProgress(options, stats, {
              phase: "keyword-indexing",
              currentFile: file.path,
              currentFileIndex: fileIndex + 1,
            });
            await syncKeywordIndexForFile(config, file.path);
          }
        }
        if (embeddingReady) {
          const gaps = await getFileEmbeddingGaps(
            config,
            file.path,
            stats.embeddingDimensions,
          );
          if (gaps.missing > 0) {
            stats.chunks += gaps.missing;
            emitIndexProgress(options, stats, {
              phase: "embedding",
              currentFile: file.path,
              currentFileIndex: fileIndex + 1,
            });
            await embedFileChunks(config, file.path, {
              embeddingReady,
              onlyMissing: true,
              dimensions: stats.embeddingDimensions,
              shouldCancel: options.shouldCancel,
              onError: (entry) => {
                const issue = recordIndexIssue(stats, options, entry);
                emitIndexProgress(options, stats, {
                  phase: "embedding",
                  currentFile: file.path,
                  currentFileIndex: fileIndex + 1,
                  lastEmbeddingError: issue.error || issue.reason || "",
                });
              },
              onBatch: (batchStats) => {
                stats.embedded += batchStats.embeddedDelta || 0;
                stats.embeddingErrors += batchStats.errorsDelta || 0;
                emitIndexProgress(options, stats, {
                  phase: "embedding",
                  currentFile: file.path,
                  currentFileIndex: fileIndex + 1,
                  lastEmbeddingError: batchStats.errorMessage || "",
                });
              },
            });
          }
        }
        continue;
      }
      const document = await readLibraryDocument(file);
      const chunks = buildChunks(document.text, config.chunking);
      const storageStats = await upsertFileChunks(
        config,
        file,
        document,
        fileHash,
        stat,
        chunks,
        indexSignature,
      );
      stats.indexed += 1;
      stats.chunks += chunks.length;
      stats.textBytes += storageStats.textBytes || 0;
      stats.compressedBytes += storageStats.compressedBytes || 0;
      stats.embeddingsSkipped += embeddingReady ? 0 : chunks.length;
      for (const warning of document.warnings || []) {
        stats.warnings.push({ path: file.path, warning });
      }
      await embedFileChunks(config, file.path, {
        embeddingReady,
        dimensions: stats.embeddingDimensions,
        shouldCancel: options.shouldCancel,
        onError: (entry) => {
          const issue = recordIndexIssue(stats, options, entry);
          emitIndexProgress(options, stats, {
            phase: "embedding",
            currentFile: file.path,
            currentFileIndex: fileIndex + 1,
            lastEmbeddingError: issue.error || issue.reason || "",
          });
        },
        onBatch: (batchStats) => {
          stats.embedded += batchStats.embeddedDelta || 0;
          stats.embeddingErrors += batchStats.errorsDelta || 0;
          emitIndexProgress(options, stats, {
            phase: "embedding",
            currentFile: file.path,
            currentFileIndex: fileIndex + 1,
            lastEmbeddingError: batchStats.errorMessage || "",
          });
        },
      });
    } catch (error) {
      if (error?.cancelled) throw error;
      if (isDocumentSkipError(error)) {
        stats.skippedDocuments.push({ path: file.path, reason: error.message });
        recordIndexIssue(stats, options, {
          kind: "document_skipped",
          filePath: file.path,
          reason: error.message,
        });
        continue;
      }
      stats.errors.push({ path: file.path, error: error.message });
      recordIndexIssue(stats, options, {
        kind: "file_error",
        filePath: file.path,
        error: error.message,
      });
    } finally {
      stats.processed += 1;
      emitIndexProgress(options, stats, {
        phase: "indexing",
        currentFile: file.path,
        currentFileIndex: fileIndex + 1,
      });
    }
  }

  assertNotCancelled(options);
  if (options.prune !== false) {
    emitIndexProgress(options, stats, { phase: "pruning" });
    stats.pruned = await pruneMissingFiles(
      config,
      files.map((file) => file.path),
    );
  }
  assertNotCancelled(options);
  if (options.compact !== false) {
    emitIndexProgress(options, stats, { phase: "compacting" });
    await compactDatabase(config);
  }
  emitIndexProgress(options, stats, { phase: "completed", percent: 100 });
  return stats;
}

function normalizeSearchText(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[_-]+/g, " ")
    .replace(/[^\p{L}\p{N}"\s/]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasNormalizedSearchTerm(haystack, term) {
  const normalizedTerm = normalizeSearchText(term);
  if (!normalizedTerm) return false;
  if (normalizedTerm.includes(" ")) return haystack.includes(normalizedTerm);
  return ` ${haystack} `.includes(` ${normalizedTerm} `);
}

function extractSearchTerms(query) {
  const terms = normalizeSearchText(query).match(/[\p{L}\p{N}]{2,}/gu) || [];
  const filtered = terms.filter((term) => !SEARCH_STOP_WORDS.has(term));
  const useful = filtered.length ? filtered : terms;
  return Array.from(new Set(useful)).slice(0, 16);
}

function extractQuotedTerms(query) {
  const matches = [];
  const raw = String(query || "");
  const patterns = [/"([^"]+)"/gu, /“([^”]+)”/gu, /'([^']+)'/gu];
  for (const pattern of patterns) {
    let match = null;
    while ((match = pattern.exec(raw)) !== null) {
      matches.push(match[1]);
    }
  }
  return matches
    .map((match) => normalizeSearchText(match).trim())
    .filter((term) => term.length >= 2);
}

function uniqueTerms(terms, limit = 32) {
  const seen = new Set();
  const result = [];
  for (const term of Array.isArray(terms) ? terms : []) {
    const normalized = normalizeSearchText(term);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= limit) break;
  }
  return result;
}

function splitSearchTerms(text) {
  return normalizeSearchText(text).match(/[\p{L}\p{N}]{2,}/gu) || [];
}

function isConceptTrigger(term) {
  return QUERY_CONCEPTS.some((concept) => concept.triggers.includes(term));
}

function getConceptExpansions(terms) {
  const expansions = [];
  const concepts = [];
  for (const concept of QUERY_CONCEPTS) {
    if (concept.triggers.some((trigger) => terms.includes(trigger))) {
      concepts.push(concept.name);
      expansions.push(...concept.expansions);
    }
  }
  return {
    concepts: uniqueTerms(concepts, 12),
    expansions: uniqueTerms(expansions, 48),
  };
}

function normalizeSourceHint(raw) {
  if (!raw) return null;
  const label = String(raw.title || raw.label || raw.name || "").trim();
  const author = String(raw.author || "").trim();
  const filePath = String(raw.path || "").trim();
  const text = [label, author, filePath, raw.text || ""]
    .filter(Boolean)
    .join(" ");
  const terms = extractSearchTerms(text).filter((term) => term.length > 2);
  if (!label && !author && !filePath && !terms.length) return null;
  return { label, author, path: filePath, terms };
}

function extractQuerySourceHints(query) {
  const hints = [];
  const patterns = [
    /\bseg[uú]n\s+([^,.;:?!\n]{3,80})/giu,
    /\baccording\s+to\s+([^,.;:?!\n]{3,80})/giu,
    /\b(?:libro|obra|book|work)\s+["“”']?([^"“”'\n]{3,100})["“”']?/giu,
  ];
  for (const pattern of patterns) {
    let match = null;
    while ((match = pattern.exec(query)) !== null) {
      const raw = String(match[1] || "")
        .replace(
          /\b(?:cual|cu[aá]l|que|qu[eé]|what|who|where|when|how)\b.*$/iu,
          "",
        )
        .trim();
      const hint = normalizeSourceHint({ label: raw });
      if (hint) hints.push(hint);
    }
  }
  return hints;
}

function mergeSourceHints(query, providedHints = []) {
  const hints = [
    ...extractQuerySourceHints(query),
    ...(Array.isArray(providedHints) ? providedHints : []).map(
      normalizeSourceHint,
    ),
  ].filter(Boolean);
  const seen = new Set();
  const deduped = [];
  for (const hint of hints) {
    const key = `${hint.path}|${hint.label}|${hint.author}|${hint.terms.join(" ")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(hint);
  }
  return deduped.slice(0, 5);
}

function getSourceHintTermSet(sourceHints = []) {
  return new Set(
    (Array.isArray(sourceHints) ? sourceHints : [])
      .flatMap((hint) => hint?.terms || [])
      .filter((term) => term.length > 2),
  );
}

function isSourceHintTerm(term, sourceTerms) {
  if (sourceTerms.has(term)) return true;
  for (const sourceTerm of sourceTerms) {
    if (sourceTerm.length <= 2) continue;
    if (sourceTerm.includes(term) || term.includes(sourceTerm)) return true;
  }
  return false;
}

function buildSearchPlan(query, sourceHints = []) {
  const allTerms = uniqueTerms(splitSearchTerms(query), 48);
  const quotedPhrases = extractQuotedTerms(query);
  const quotedTerms = uniqueTerms(quotedPhrases.flatMap(splitSearchTerms), 24);
  const sourceTerms = getSourceHintTermSet(sourceHints);
  const nonSourceTerms = allTerms.filter(
    (term) => !isSourceHintTerm(term, sourceTerms),
  );
  const usefulTerms = nonSourceTerms.filter(
    (term) => !SEARCH_STOP_WORDS.has(term),
  );
  const conceptInputTerms = uniqueTerms([...allTerms, ...quotedTerms], 64);
  const conceptPlan = getConceptExpansions(conceptInputTerms);
  const quotedPrimaryTerms = quotedTerms.filter(
    (term) =>
      !SEARCH_STOP_WORDS.has(term) &&
      !isConceptTrigger(term) &&
      !isSourceHintTerm(term, sourceTerms),
  );
  const primaryTerms = uniqueTerms(
    [
      ...quotedPrimaryTerms,
      ...usefulTerms.filter((term) => !isConceptTrigger(term)),
    ],
    16,
  );
  const fallbackTerms = uniqueTerms(
    usefulTerms.length
      ? usefulTerms
      : extractSearchTerms(query).filter(
          (term) => !isSourceHintTerm(term, sourceTerms),
        ),
    16,
  );
  const effectivePrimaryTerms = primaryTerms.length
    ? primaryTerms
    : fallbackTerms;
  const expansionTerms = uniqueTerms(
    conceptPlan.expansions.filter(
      (term) =>
        !isSourceHintTerm(term, sourceTerms) &&
        !effectivePrimaryTerms.includes(term),
    ),
    48,
  );
  const ftsTerms = effectivePrimaryTerms.length
    ? effectivePrimaryTerms
    : uniqueTerms([...quotedTerms, ...expansionTerms, ...fallbackTerms], 12);
  return {
    allTerms,
    quotedPhrases,
    quotedTerms,
    concepts: conceptPlan.concepts,
    primaryTerms: effectivePrimaryTerms,
    expansionTerms,
    metadataTerms: uniqueTerms(
      [...effectivePrimaryTerms, ...quotedPrimaryTerms],
      16,
    ),
    ftsTerms: uniqueTerms(ftsTerms, 12),
    scoringTerms: uniqueTerms(
      [...effectivePrimaryTerms, ...expansionTerms],
      64,
    ),
  };
}

function queryRefersToPreviousSource(query) {
  return /\b(ese|esa|este|esta|that|previous)\s+(libro|obra|book|work|source)\b/i.test(
    normalizeSearchText(query),
  );
}

function buildFtsQuery(query, sourceHints = [], plan = null) {
  const queryPlan = plan || buildSearchPlan(query, sourceHints);
  const terms = queryPlan.ftsTerms.slice(0, 12);
  return terms.map((term) => `${term.replace(/"/g, "")}*`).join(" OR ");
}

function normalizeResult(row, kind) {
  return {
    chunkId: Number(row.chunkId),
    title: row.title || path.basename(row.path || ""),
    author: row.author || "",
    path: row.path || "",
    sourceType: row.sourceType || "",
    heading: row.heading || "",
    text: decompressChunkText(row),
    snippet: row.snippet || "",
    score: Number(row.score || 0),
    kind,
  };
}

async function searchFts(config, query, limit, sourceHints = [], plan = null) {
  if (config.search?.keywordEnabled !== true) return [];
  const ftsQuery = buildFtsQuery(query, sourceHints, plan);
  if (!ftsQuery) return [];
  const rows = await runSqliteJson(
    config.databasePath,
    `SELECT
  c.id AS chunkId,
  f.title AS title,
  f.author AS author,
  f.path AS path,
  f.source_type AS sourceType,
  c.heading AS heading,
  c.text AS text,
  hex(c.text_compressed) AS textCompressedHex,
  c.text_encoding AS textEncoding,
  '' AS snippet,
  bm25(library_chunks_fts) +
    CASE
      WHEN lower(c.heading) = 'notas' THEN 6
      WHEN lower(c.heading) LIKE 'bibliograf%' THEN 6
      ELSE 0
    END AS score
FROM library_chunks_fts
JOIN library_chunks c ON c.id = library_chunks_fts.rowid
JOIN library_files f ON f.id = c.file_id
WHERE library_chunks_fts MATCH ${sqlLiteral(ftsQuery)}
ORDER BY score
LIMIT ${sqlInteger(limit)};`,
  );
  return rows.map((row) => normalizeResult(row, "keyword"));
}

function rowSelectSql() {
  return `c.id AS chunkId,
  f.title AS title,
  f.author AS author,
  f.path AS path,
  f.source_type AS sourceType,
  c.heading AS heading,
  c.text AS text,
  hex(c.text_compressed) AS textCompressedHex,
  c.text_encoding AS textEncoding`;
}

async function searchMetadata(
  config,
  query,
  limit,
  sourceHints = [],
  plan = null,
) {
  const queryPlan = plan || buildSearchPlan(query, sourceHints);
  const terms = queryPlan.metadataTerms.filter((term) => term.length > 2);
  const hintTerms = sourceHints.flatMap((hint) => hint.terms || []);
  const allTerms = Array.from(new Set([...terms, ...hintTerms])).slice(0, 16);
  if (!allTerms.length) return [];
  const conditions = allTerms.map((term) => {
    const like = sqlLiteral(`%${term}%`);
    return `(lower(f.title) LIKE ${like}
 OR lower(f.author) LIKE ${like}
 OR lower(f.path) LIKE ${like}
 OR lower(c.heading) LIKE ${like})`;
  });
  const rows = await runSqliteJson(
    config.databasePath,
    `SELECT
  ${rowSelectSql()},
  0 AS score
FROM library_chunks c
JOIN library_files f ON f.id = c.file_id
WHERE ${conditions.join(" OR ")}
ORDER BY lower(f.path), c.chunk_index
LIMIT ${sqlInteger(limit)};`,
  );
  return rows.map((row) => normalizeResult(row, "metadata"));
}

function sourceHintFileConditions(sourceHints) {
  const exactPaths = sourceHints
    .map((hint) => hint.path)
    .filter(Boolean)
    .map((filePath) => `f.path = ${sqlLiteral(filePath)}`);
  const fuzzyTerms = Array.from(
    new Set(sourceHints.flatMap((hint) => hint.terms || [])),
  )
    .filter((term) => term.length > 2)
    .slice(0, 12);
  const fuzzy = fuzzyTerms.map((term) => {
    const like = sqlLiteral(`%${term}%`);
    return `(lower(f.title) LIKE ${like} OR lower(f.author) LIKE ${like} OR lower(f.path) LIKE ${like})`;
  });
  return [...exactPaths, ...fuzzy];
}

async function searchSourceDeepScan(
  config,
  query,
  limit,
  sourceHints = [],
  plan = null,
) {
  if (!sourceHints.length) return [];
  const conditions = sourceHintFileConditions(sourceHints);
  if (!conditions.length) return [];
  const rows = await runSqliteJson(
    config.databasePath,
    `SELECT
  ${rowSelectSql()},
  0 AS score
FROM library_chunks c
JOIN library_files f ON f.id = c.file_id
WHERE f.id IN (
  SELECT id FROM library_files f
  WHERE ${conditions.join(" OR ")}
  ORDER BY lower(path)
  LIMIT 20
)
ORDER BY f.path, c.chunk_index
LIMIT 5000;`,
  );
  const queryPlan = plan || buildSearchPlan(query, sourceHints);
  return rows
    .map((row) => normalizeResult(row, "source"))
    .map((result) => {
      const contentScore = computePlannedContentBonus(result.text, queryPlan, config);
      const headingScore = computePlannedContentBonus(
        result.heading,
        queryPlan,
        config
      );
      const sourceScore = computeSourceHintBoost(result, sourceHints, true);
      const penalty = computePassagePenalty(result, query);
      return {
        result,
        contentScore,
        score: sourceScore + contentScore * 2 + headingScore - penalty,
      };
    })
    .filter(
      (item) =>
        !queryPlan.primaryTerms.length ||
        item.contentScore > 0 ||
        resultHasPrimaryTerm(item.result, queryPlan),
    )
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => ({ ...item.result, score: item.score }));
}

async function searchVector(config, query, limit) {
  if (!isVectorSearchConfigured(config)) return [];
  const queryEmbedding = (await embedTexts(config, [query], "query"))[0];
  if (!Array.isArray(queryEmbedding) || !queryEmbedding.length) return [];
  const vectorJson = JSON.stringify(queryEmbedding);
  const rows = await runSqliteJson(
    config.databasePath,
    `SELECT
  c.id AS chunkId,
  f.title AS title,
  f.author AS author,
  f.path AS path,
  f.source_type AS sourceType,
  c.heading AS heading,
  c.text AS text,
  hex(c.text_compressed) AS textCompressedHex,
  c.text_encoding AS textEncoding,
  '' AS snippet,
  v.distance AS score
FROM library_chunks_vec v
JOIN library_chunks c ON c.id = v.chunk_id
JOIN library_files f ON f.id = c.file_id
WHERE v.embedding MATCH ${vectorSqlExpression(config, vectorJson)}
  AND k = ${sqlInteger(limit)}
ORDER BY v.distance
LIMIT ${sqlInteger(limit)};`,
    { loadExtensionPath: config.embedding.sqliteVecExtensionPath },
  );
  return rows.map((row) => normalizeResult(row, "semantic"));
}

function candidateKey(result) {
  return String(result?.chunkId || "");
}

function computeSourceHintBoost(result, sourceHints = [], strong = false) {
  if (!sourceHints.length) return 0;
  const haystack = normalizeSearchText(
    [result.title, result.author, result.path, result.heading]
      .filter(Boolean)
      .join(" "),
  );
  let boost = 0;
  for (const hint of sourceHints) {
    if (hint.path && hint.path === result.path) {
      boost += strong ? 0.55 : 0.35;
    }
    const exact = normalizeSearchText(
      [hint.label, hint.author].filter(Boolean).join(" "),
    );
    if (exact && haystack.includes(exact)) {
      boost += strong ? 0.35 : 0.22;
    }
    for (const term of hint.terms || []) {
      if (term.length > 2 && haystack.includes(term)) {
        boost += strong ? 0.12 : 0.08;
      }
    }
  }
  return Math.min(boost, DEFAULT_SOURCE_HINT_CAP);
}

function computeMetadataBonus(
  result,
  searchTerms,
  quotedTerms,
  sourceHints,
  strongSourceHints,
  config = {}
) {
  const haystack = normalizeSearchText(
    [result.title, result.author, result.path, result.heading]
      .filter(Boolean)
      .join(" "),
  );
  let bonus = computeSourceHintBoost(result, sourceHints, strongSourceHints);
  const metadataKeywordBonus = config.search?.metadataKeywordBonus ?? 0.06;
  const exactPhraseBonus = metadataKeywordBonus * 3;
  for (const term of quotedTerms) {
    if (term && haystack.includes(term)) bonus += exactPhraseBonus;
  }
  for (const term of searchTerms) {
    if (SEARCH_STOP_WORDS.has(term)) continue;
    if (haystack.includes(term)) bonus += metadataKeywordBonus;
  }
  return Math.min(bonus, DEFAULT_METADATA_CAP + DEFAULT_SOURCE_HINT_CAP);
}

function computePlannedContentBonus(text, plan = {}, config = {}) {
  const haystack = normalizeSearchText(text);
  if (!haystack) return 0;
  let bonus = 0;
  const contentKeywordBonus = config.search?.contentKeywordBonus ?? 0.16;
  const exactPhraseBonus = contentKeywordBonus * 1.75;
  const quotedTermBonus = contentKeywordBonus * 0.75;
  const expansionTermBonus = contentKeywordBonus * 0.25;
  for (const phrase of plan.quotedPhrases || []) {
    if (phrase && haystack.includes(phrase)) bonus += exactPhraseBonus;
  }
  for (const term of plan.quotedTerms || []) {
    if (term && hasNormalizedSearchTerm(haystack, term)) bonus += quotedTermBonus;
  }
  for (const term of plan.primaryTerms || []) {
    if (term && hasNormalizedSearchTerm(haystack, term)) bonus += contentKeywordBonus;
  }
  for (const term of plan.expansionTerms || []) {
    if (term && hasNormalizedSearchTerm(haystack, term)) bonus += expansionTermBonus;
  }
  return Math.min(bonus, 0.85);
}

function resultHasPrimaryTerm(result, plan = {}) {
  if (!plan.primaryTerms?.length) return true;
  const haystack = normalizeSearchText(
    [result?.title, result?.author, result?.heading, result?.text]
      .filter(Boolean)
      .join(" "),
  );
  return plan.primaryTerms.some(
    (term) => term && hasNormalizedSearchTerm(haystack, term),
  );
}

function resultHasStrongPrimaryContent(result, plan = {}) {
  if (!plan.primaryTerms?.length) return false;
  const haystack = normalizeSearchText(
    [result?.heading, result?.text].filter(Boolean).join(" "),
  );
  return plan.primaryTerms.some(
    (term) => term && hasNormalizedSearchTerm(haystack, term),
  );
}

function resultHasExpansionContent(result, plan = {}) {
  if (!plan.expansionTerms?.length) return false;
  const haystack = normalizeSearchText(
    [result?.heading, result?.text].filter(Boolean).join(" "),
  );
  return plan.expansionTerms.some(
    (term) => term && hasNormalizedSearchTerm(haystack, term),
  );
}

function queryRequestsReferenceMaterial(query) {
  return /\b(introducci[oó]n|introduction|pr[oó]logo|prefacio|preface|nota|notas|notes|comentario|commentary|bibliograf[ií]a|bibliography|fuentes|sources)\b/iu.test(
    normalizeSearchText(query),
  );
}

function computePassagePenalty(result, query) {
  if (queryRequestsReferenceMaterial(query)) return 0;
  const heading = normalizeSearchText(result?.heading || "");
  let penalty = 0;
  if (
    /\b(introduccion|introduction|prologo|prefacio|preface)\b/u.test(heading)
  ) {
    penalty += 0.18;
  }
  if (/\b(comentario|commentary|focio)\b/u.test(heading)) {
    penalty += 0.18;
  }
  if (/\b(nota|notas|notes)\b/u.test(heading)) {
    penalty += 0.12;
  }
  if (/\b(bibliografia|bibliography|fuentes|sources)\b/u.test(heading)) {
    penalty += 0.1;
  }
  return Math.min(penalty, 0.3);
}

function fuseRankedResults(groups, options = {}) {
  const k = Math.max(1, Number(options.rrfK || DEFAULT_RRF_K));
  const candidates = new Map();
  for (const group of groups) {
    const weight = Number(group.weight || 1);
    for (let index = 0; index < group.results.length; index += 1) {
      const result = group.results[index];
      const key = candidateKey(result);
      if (!key) continue;
      const existing = candidates.get(key) || {
        result,
        score: 0,
        channels: new Set(),
      };
      existing.result = existing.result || result;
      existing.score += weight / (k + index + 1);
      existing.channels.add(group.name);
      candidates.set(key, existing);
    }
  }
  return Array.from(candidates.values());
}

function applyHybridBonuses(candidates, query, sourceHints, plan = null, config = {}) {
  const queryPlan = plan || buildSearchPlan(query, sourceHints);
  const searchTerms = queryPlan.metadataTerms.length
    ? queryPlan.metadataTerms
    : extractSearchTerms(query);
  const strongSourceHints =
    queryRefersToPreviousSource(query) && sourceHints.length > 0;
  return candidates.map((candidate) => {
    const metadataBonus = computeMetadataBonus(
      candidate.result,
      searchTerms,
      queryPlan.quotedPhrases,
      sourceHints,
      strongSourceHints,
      config
    );
    const contentBonus = computePlannedContentBonus(
      candidate.result.text,
      queryPlan,
      config
    );
    const headingBonus = computePlannedContentBonus(
      candidate.result.heading,
      queryPlan,
      config
    );
    const primaryContentBonus = resultHasStrongPrimaryContent(
      candidate.result,
      queryPlan,
    )
      ? config.search?.contentKeywordBonus ?? 0.12
      : 0;
    const conceptPenalty =
      queryPlan.concepts.length > 0 &&
      !resultHasExpansionContent(candidate.result, queryPlan)
        ? 0.35
        : 0;
    const passagePenalty = computePassagePenalty(candidate.result, query);
    return {
      ...candidate,
      score:
        candidate.score +
        metadataBonus +
        contentBonus +
        headingBonus +
        primaryContentBonus -
        conceptPenalty -
        passagePenalty,
      metadataBonus,
      contentBonus,
      headingBonus,
      primaryContentBonus,
      conceptPenalty,
      passagePenalty,
    };
  });
}

function resultMatchesSourceHints(result, sourceHints = []) {
  return computeSourceHintBoost(result, sourceHints, false) > 0;
}

function resultTextFingerprint(result, plan = null) {
  const normalized = normalizeSearchText(result?.text || "");
  if (!normalized) return "";
  for (const term of plan?.primaryTerms || []) {
    const index = normalized.indexOf(term);
    if (index >= 0) {
      const start = Math.max(0, index - 260);
      return normalized.slice(start, start + 700);
    }
  }
  return normalized.slice(0, 700);
}

function diversifyResults(scored, limit, sourceHints = [], plan = null) {
  const selected = [];
  const perPath = new Map();
  const fingerprints = new Set();
  const takeUpTo = (maxPerPath, target = limit, predicate = null) => {
    for (const item of scored) {
      if (selected.length >= target) return;
      if (predicate && !predicate(item)) continue;
      const key = candidateKey(item.result);
      if (selected.some((existing) => candidateKey(existing.result) === key))
        continue;
      const fingerprint = resultTextFingerprint(item.result, plan);
      if (fingerprint && fingerprints.has(fingerprint)) continue;
      const count = perPath.get(item.result.path) || 0;
      if (count >= maxPerPath) continue;
      perPath.set(item.result.path, count + 1);
      if (fingerprint) fingerprints.add(fingerprint);
      selected.push(item);
    }
  };
  const diversityTarget = Math.min(limit, Math.max(1, Math.ceil(limit * 0.6)));
  if (!sourceHints.length && plan?.primaryTerms?.length) {
    takeUpTo(
      5,
      Math.min(limit, Math.max(3, Math.ceil(limit * 0.45))),
      (item) =>
        resultHasStrongPrimaryContent(item.result, plan) &&
        (!plan.concepts.length || resultHasExpansionContent(item.result, plan)),
    );
  }
  if (sourceHints.length) {
    takeUpTo(
      5,
      Math.min(limit, Math.max(3, Math.ceil(limit * 0.45))),
      (item) =>
        resultMatchesSourceHints(item.result, sourceHints) &&
        Number(item.contentBonus || 0) > 0,
    );
  }
  takeUpTo(1, diversityTarget);
  if (selected.length < limit) takeUpTo(sourceHints.length ? 5 : 3);
  return selected.map((item) => ({
    ...item.result,
    score: item.score,
    channels: Array.from(item.channels || []),
  }));
}

async function searchLibrary(query, options = {}) {
  const config = options.config || loadLibraryConfig();
  await initDatabase(config);
  const maxLimit = config.search.maxLimit || 20;
  const limit = clampNumber(
    options.limit || config.search.defaultLimit,
    1,
    maxLimit,
    5,
  );
  const candidateLimit = clampNumber(
    options.candidateLimit || DEFAULT_HYBRID_CANDIDATE_LIMIT,
    Math.max(limit, 10),
    250,
    DEFAULT_HYBRID_CANDIDATE_LIMIT,
  );
  const sourceHints = mergeSourceHints(query, options.sourceHints);
  const plan = buildSearchPlan(query, sourceHints);
  const groups = [];

  if (isVectorSearchConfigured(config)) {
    try {
      const vectorResults = await searchVector(config, query, candidateLimit);
      groups.push({ name: "semantic", weight: config.search?.semanticWeight ?? 1.0, results: vectorResults });
    } catch (error) {
      console.warn(
        `Vector search failed; falling back to FTS5: ${error.message}`,
      );
    }
  }

  const ftsResults = await searchFts(
    config,
    query,
    candidateLimit,
    sourceHints,
    plan,
  );
  groups.push({ name: "keyword", weight: config.search?.keywordWeight ?? 1.1, results: ftsResults });

  const metadataResults = await searchMetadata(
    config,
    query,
    Math.min(candidateLimit, 120),
    sourceHints,
    plan,
  );
  groups.push({ name: "metadata", weight: config.search?.metadataWeight ?? 0.8, results: metadataResults });

  const sourceResults = await searchSourceDeepScan(
    config,
    query,
    Math.min(candidateLimit, 80),
    sourceHints,
    plan,
  );
  groups.push({ name: "source", weight: config.search?.sourceWeight ?? 1.2, results: sourceResults });

  options.rrfK = config.search?.rrfK ?? 60;
  let candidates = fuseRankedResults(groups, options);
  if (!candidates.length && sourceHints.length) {
    candidates = fuseRankedResults([
      { name: "source", weight: config.search?.sourceWeight ?? 1.2, results: sourceResults },
    ]);
  }

  const scored = applyHybridBonuses(candidates, query, sourceHints, plan, config).sort(
    (a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return String(a.result.path || "").localeCompare(
        String(b.result.path || ""),
      );
    },
  );
  const conceptEvidence = plan.concepts.length
    ? scored.filter(
        (item) =>
          resultHasStrongPrimaryContent(item.result, plan) &&
          resultHasExpansionContent(item.result, plan),
      )
    : [];
  const finalScored =
    conceptEvidence.length >= Math.min(3, limit) ? conceptEvidence : scored;
  return diversifyResults(finalScored, limit, sourceHints, plan);
}

function trimToContextWithStats(results, maxContextChars) {
  const trimmed = [];
  let used = 0;
  for (const result of results) {
    const remaining = maxContextChars - used;
    if (remaining <= 0) break;
    const text = result.text.slice(0, Math.max(0, remaining));
    used += text.length;
    trimmed.push({ ...result, text });
  }
  return {
    trimmed,
    usedChars: used,
    omittedCount: Math.max(
      0,
      (Array.isArray(results) ? results.length : 0) - trimmed.length,
    ),
  };
}

function countUniqueLibrarySources(results) {
  const seen = new Set();
  for (const result of Array.isArray(results) ? results : []) {
    const key =
      result?.path || `${result?.title || ""}|${result?.author || ""}`;
    if (key) seen.add(key);
  }
  return seen.size;
}

function buildLibraryContextPayload(results, options = {}) {
  const maxContextChars = clampNumber(
    options.maxContextChars,
    1000,
    50000,
    12000,
  );
  const trimStats = trimToContextWithStats(results, maxContextChars);
  const trimmed = trimStats.trimmed;
  const strict = options.strict === true;
  if (!trimmed.length) {
    const context = strict
      ? `Strict database-only mode is enabled for this question. No relevant local library passages were retrieved. Tell the user that the local database did not provide enough evidence to answer. Do not use general knowledge, tools, web results, or assumptions.`
      : "";
    return {
      context,
      contextResults: [],
      meta: {
        retrievedCount: Array.isArray(results) ? results.length : 0,
        injectedCount: 0,
        uniqueSourceCount: countUniqueLibrarySources(results),
        maxContextChars,
        usedTextChars: 0,
        contextChars: context.length,
        omittedCount: Array.isArray(results) ? results.length : 0,
      },
    };
  }
  const passages = trimmed
    .map((result, index) => {
      const sourceLine = `${result.title}${result.author ? ` by ${result.author}` : ""}`;
      const headingLine = result.heading ? `\nHeading: ${result.heading}` : "";
      return `Passage ${index + 1}\nWork: ${sourceLine}${headingLine}\nText:\n${result.text}`;
    })
    .join("\n\n");
  const modeInstruction = strict
    ? "Strict database-only mode is enabled for this question. Answer only from the local library passages below. If the passages do not contain enough evidence, say that the local database did not provide enough evidence. Do not use general knowledge, tools, web results, or assumptions."
    : "Database Context is enabled, so the local library has priority for this question. Local library passages have already been retrieved. Answer from these passages when they contain relevant evidence. Do not call external tools or skills for this turn unless the user explicitly asked for a specific tool. If the passages do not contain the answer, say that the local library did not provide enough evidence.";
  const context = `${modeInstruction} Respond as a careful academic researcher writing for scholars, professors, and advanced readers. Answer naturally and substantively: explain the evidence, distinguish main accounts from variants or notes, identify uncertainty, and teach the user what the passages imply. Do not give a skinny one-line extraction when the passages contain richer context. If the passages contain multiple relevant origins, causes, agents, parentages, locations, source traditions, or variant accounts, explain each distinction clearly. Keep the response concise but intellectually useful; avoid padding. Do not print passage numbers, bracket citations, local file paths, a "Source:" line, or a "Retrieved passages" section in your final answer. The app displays source files separately below the response.\n\n${passages}`;
  return {
    context,
    contextResults: trimmed,
    meta: {
      retrievedCount: Array.isArray(results) ? results.length : 0,
      injectedCount: trimmed.length,
      uniqueSourceCount: countUniqueLibrarySources(results),
      maxContextChars,
      usedTextChars: trimStats.usedChars,
      contextChars: context.length,
      omittedCount: trimStats.omittedCount,
    },
  };
}

function buildLibraryContext(results, options = {}) {
  return buildLibraryContextPayload(results, options).context;
}

async function buildChatLibraryContext(query, requestOptions = {}) {
  const config = loadLibraryConfig();
  const chatSettings = normalizeChatIntegration(
    {
      ...config.chatIntegration,
      ...(requestOptions || {}),
    },
    config.search,
  );
  chatSettings.strict = requestOptions?.strict === true;
  if (!chatSettings.enabled) {
    return { enabled: false, results: [], contextMessage: null };
  }
  const results = await searchLibrary(query, {
    config,
    limit: chatSettings.limit,
    sourceHints: requestOptions?.sourceHints,
  });
  const payload = buildLibraryContextPayload(results, chatSettings);
  return {
    enabled: true,
    results,
    contextResults: payload.contextResults,
    contextMeta: payload.meta,
    contextMessage: payload.context
      ? { role: "system", content: payload.context }
      : null,
  };
}

async function getLibraryStatus() {
  const config = loadLibraryConfig();
  const sqlitePath = findSqlitePath();
  const sqliteExtensionPath = findSqlitePath({ requireLoadExtension: true });
  const dbExists = fs.existsSync(config.databasePath);
  const status = {
    configPath: CONFIG_FILE,
    databasePath: config.databasePath,
    sqliteAvailable: !!sqlitePath,
    sqlitePath,
    sqliteCanLoadExtensions: !!sqliteExtensionPath,
    sqliteExtensionPath,
    databaseExists: dbExists,
    sources: config.sources.map((source) => ({
      name: source.name,
      type: source.type,
      path: source.path,
      exists: fs.existsSync(source.path),
      extensions: source.extensions,
    })),
    search: {
      keywordEnabled: config.search.keywordEnabled,
      defaultLimit: config.search.defaultLimit,
      maxLimit: config.search.maxLimit,
      maxContextChars: config.search.maxContextChars,
    },
    embedding: {
      enabled: config.embedding.enabled,
      model: config.embedding.model,
      dimensions: config.embedding.dimensions,
      quantization: vectorStorageMode(config),
      sqliteVecConfigured: isVectorSearchConfigured(config),
      sqliteVecExtensionPath: config.embedding.sqliteVecExtensionPath,
      storedDimensions: 0,
      storedModel: "",
      storedQuantization: "",
    },
    chatIntegration: config.chatIntegration,
    files: 0,
    chunks: 0,
    embeddings: 0,
    textBytes: 0,
    compressedBytes: 0,
    databaseBytes: dbExists ? fs.statSync(config.databasePath).size : 0,
  };
  if (!sqlitePath || !dbExists) return status;
  try {
    const rows = await runSqliteJson(
      config.databasePath,
      `SELECT
  (SELECT COUNT(*) FROM library_files) AS files,
  (SELECT COUNT(*) FROM library_chunks) AS chunks,
  (SELECT COUNT(*) FROM library_embeddings) AS embeddings,
  (SELECT COALESCE(SUM(text_size), 0) FROM library_chunks) AS textBytes,
  (SELECT COALESCE(SUM(LENGTH(text_compressed)), 0) FROM library_chunks) AS compressedBytes;`,
    );
    status.files = Number(rows[0]?.files || 0);
    status.chunks = Number(rows[0]?.chunks || 0);
    status.embeddings = Number(rows[0]?.embeddings || 0);
    status.textBytes = Number(rows[0]?.textBytes || 0);
    status.compressedBytes = Number(rows[0]?.compressedBytes || 0);
    const metaRows = await runSqliteJson(
      config.databasePath,
      "SELECT key, value FROM library_vector_meta WHERE key IN ('dimensions', 'model', 'quantization');",
    );
    const vectorMeta = Object.fromEntries(
      metaRows.map((row) => [row.key, row.value]),
    );
    status.embedding.storedDimensions = Number(vectorMeta.dimensions || 0);
    status.embedding.storedModel = vectorMeta.model || "";
    status.embedding.storedQuantization = vectorMeta.quantization || "";
  } catch (error) {
    status.error = error.message;
  }
  return status;
}

async function listIndexedLibraryFiles(options = {}) {
  const config = loadLibraryConfig();
  if (!fs.existsSync(config.databasePath)) return [];
  const extension =
    typeof options.extension === "string" && options.extension.trim()
      ? options.extension.trim().toLowerCase()
      : "";
  const whereClause = extension
    ? `WHERE lower(path) LIKE ${sqlLiteral(`%${extension.startsWith(".") ? extension : `.${extension}`}`)}`
    : "";
  const rows = await runSqliteJson(
    config.databasePath,
    `SELECT
  id,
  source_name AS sourceName,
  source_type AS sourceType,
  path,
  title,
  author,
  size_bytes AS sizeBytes,
  indexed_at AS indexedAt,
  chunk_count AS chunkCount
FROM library_files
${whereClause}
ORDER BY lower(path);`,
  );
  return rows.map((row) => ({
    id: Number(row.id || 0),
    sourceName: row.sourceName || "",
    sourceType: row.sourceType || "",
    path: row.path || "",
    title: row.title || "",
    author: row.author || "",
    sizeBytes: Number(row.sizeBytes || 0),
    indexedAt: row.indexedAt || "",
    chunkCount: Number(row.chunkCount || 0),
  }));
}

module.exports = {
  CONFIG_FILE,
  buildChatLibraryContext,
  buildChunks,
  buildLibraryContext,
  collectSourceFiles,
  estimateLibraryIndex,
  getLibraryStatus,
  indexLibrary,
  initDatabase,
  listIndexedLibraryFiles,
  loadLibraryConfig,
  normalizeChatIntegration,
  normalizeConfig,
  saveLibraryChatSettings,
  saveLibraryConfig,
  searchLibrary,
};
