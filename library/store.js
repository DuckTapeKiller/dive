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
const SEMANTIC_BRIDGE_RESULT_LIMIT = 40;
const SEMANTIC_BRIDGE_TERM_LIMIT = 14;
const SEMANTIC_DOMINANT_WEIGHT = 2.75;
const STRICT_FTS_DEFAULT_WEIGHT = 3.0;
const SOURCE_STRICT_FTS_DEFAULT_WEIGHT = 3.25;
const SEARCH_MODE_KEYS = ["ollama", "pi", "cloud"];
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
  "in",
  "is",
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

const RETRIEVAL_WEAK_TERMS = new Set([
  "argue",
  "argued",
  "believe",
  "believed",
  "claim",
  "claimed",
  "creia",
  "decir",
  "defendia",
  "dice",
  "did",
  "dijo",
  "does",
  "escribe",
  "escribio",
  "explain",
  "explained",
  "explains",
  "explica",
  "explicaba",
  "explico",
  "feel",
  "happen",
  "happens",
  "happened",
  "ocurre",
  "ocurria",
  "ocurrio",
  "kill",
  "killed",
  "matar",
  "mato",
  "opina",
  "opinaba",
  "opinar",
  "opinion",
  "pensaba",
  "piensa",
  "practicaba",
  "practiced",
  "practise",
  "practised",
  "say",
  "said",
  "says",
  "think",
  "thinking",
  "thought",
  "view",
  "views",
  "write",
  "writes",
  "wrote",
]);

function normalizeEarlySearchTerm(term) {
  return String(term || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[_-]+/g, " ")
    .replace(/[^\p{L}\p{N}\s/]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueEarlyTerms(terms, limit = 64) {
  const seen = new Set();
  const result = [];
  for (const term of Array.isArray(terms) ? terms : []) {
    const normalized = normalizeEarlySearchTerm(term);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= limit) break;
  }
  return result;
}

const CROSS_LINGUAL_EQUIVALENT_GROUPS = [
  ["arab", "arabe", "arabes"],
  ["apollodorus", "apolodoro"],
  ["atom", "atomo", "atomos"],
  ["bestiality", "bestialismo", "zoofilia", "zoophilia"],
  ["biblioteca", "library"],
  ["comedy", "comedia", "comedias"],
  ["conquest", "conquista"],
  ["daughter", "hija"],
  ["evolution", "evolucion"],
  ["father", "padre"],
  ["genealogy", "genealogia", "linaje"],
  ["gravity", "gravedad"],
  ["indies", "indias"],
  ["labour", "labor", "trabajo"],
  ["law", "laws", "ley", "leyes"],
  ["light", "luz"],
  ["literature", "literatura"],
  ["metamorphosis", "metamorfosis"],
  ["meursault", "mersault"],
  ["mother", "madre"],
  ["myth", "myths", "mito", "mitos", "mitologia", "mythology"],
  ["natural", "natural"],
  ["new", "nueva", "nuevas", "nuevo", "nuevos"],
  ["novel", "novela"],
  ["origin", "origen", "origenes", "origins"],
  ["parentage", "descendencia"],
  ["poetry", "poesia"],
  ["opposition", "oposicion"],
  ["relativity", "relatividad"],
  ["religious", "religioso", "religiosa", "religion"],
  ["science", "ciencia"],
  ["scientific", "cientifico", "cientifica"],
  ["selection", "seleccion"],
  ["sphinx", "esfinge"],
  ["species", "especie", "especies"],
  ["time", "tiempo"],
  ["tragedy", "tragedia"],
  ["typographer", "typographers", "tipografo", "tipografos", "tipografia"],
  ["zoophilia", "zoofilia", "bestialismo"],
];

const CROSS_LINGUAL_EQUIVALENTS = new Map();
for (const group of CROSS_LINGUAL_EQUIVALENT_GROUPS) {
  const normalizedGroup = Array.from(
    new Set(group.map((term) => normalizeEarlySearchTerm(term)).filter(Boolean)),
  );
  for (const term of normalizedGroup) {
    CROSS_LINGUAL_EQUIVALENTS.set(
      term,
      uniqueEarlyTerms([
        ...(CROSS_LINGUAL_EQUIVALENTS.get(term) || []),
        ...normalizedGroup.filter((candidate) => candidate !== term),
      ]),
    );
  }
}

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
  if (value === "" || value === null || value === undefined) return fallback;
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
    searchModes: Object.fromEntries(
      SEARCH_MODE_KEYS.map((modeKey) => [
        modeKey,
        {
          ...(base.searchModes?.[modeKey] || {}),
          ...(override?.searchModes?.[modeKey] || {}),
        },
      ]),
    ),
    embedding: { ...base.embedding, ...(override?.embedding || {}) },
    chatIntegration: {
      ...base.chatIntegration,
      ...(override?.chatIntegration || {}),
    },
    chatModes: Object.fromEntries(
      SEARCH_MODE_KEYS.map((modeKey) => [
        modeKey,
        {
          ...(base.chatModes?.[modeKey] || {}),
          ...(override?.chatModes?.[modeKey] || {}),
        },
      ]),
    ),
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
  // Saved configs that still carry the old defaults (5 passages / 12000
  // chars) are migrated to the new defaults, mirroring the legacy
  // search.maxLimit migration in normalizeConfig.
  const usesLegacyChatDefaults =
    Number(raw?.limit) === 5 && Number(raw?.maxContextChars) === 12000;
  return {
    enabled: raw?.enabled === true,
    limit: usesLegacyChatDefaults
      ? 20
      : clampNumber(raw?.limit, 1, maxLimit, 20),
    maxContextChars: usesLegacyChatDefaults
      ? 30000
      : clampNumber(raw?.maxContextChars, 1000, 50000, 30000),
    includeSourcePaths: raw?.includeSourcePaths !== false,
  };
}

function normalizeChatModeSettings(raw, fallback = {}) {
  return {
    enabled:
      raw && typeof raw === "object" && "enabled" in raw
        ? raw.enabled === true
        : fallback.enabled === true,
  };
}

function normalizeChatModes(raw, fallback = {}) {
  return Object.fromEntries(
    SEARCH_MODE_KEYS.map((modeKey) => [
      modeKey,
      normalizeChatModeSettings(raw?.[modeKey], fallback),
    ]),
  );
}

function normalizeSearchAlgorithmOverride(raw, fallback) {
  return {
    rrfK: clampNumber(raw?.rrfK, 1, 100, fallback.rrfK),
    semanticWeight: clampNumber(
      raw?.semanticWeight,
      0,
      3,
      fallback.semanticWeight,
    ),
    keywordWeight: clampNumber(
      raw?.keywordWeight,
      0,
      3,
      fallback.keywordWeight,
    ),
    metadataWeight: clampNumber(
      raw?.metadataWeight,
      0,
      3,
      fallback.metadataWeight,
    ),
    sourceWeight: clampNumber(raw?.sourceWeight, 0, 3, fallback.sourceWeight),
    contentKeywordBonus: clampNumber(
      raw?.contentKeywordBonus,
      0,
      1,
      fallback.contentKeywordBonus,
    ),
    metadataKeywordBonus: clampNumber(
      raw?.metadataKeywordBonus,
      0,
      1,
      fallback.metadataKeywordBonus,
    ),
    maxPassagesPerSource: clampNumber(
      raw?.maxPassagesPerSource,
      1,
      50,
      fallback.maxPassagesPerSource,
    ),
  };
}

// Returns a config whose `search` block carries the per-mode algorithm
// overrides for the given chat mode (ollama | pi | cloud). Unknown or
// missing modes fall back to the shared search settings unchanged.
function resolveSearchConfigForMode(config, mode) {
  const modeKey = String(mode || "")
    .trim()
    .toLowerCase();
  const override = config?.searchModes?.[modeKey];
  if (!override || !SEARCH_MODE_KEYS.includes(modeKey)) return config;
  return { ...config, search: { ...config.search, ...override } };
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
  const hasExplicitChatModes =
    rawConfig &&
    typeof rawConfig === "object" &&
    Object.prototype.hasOwnProperty.call(rawConfig, "chatModes");
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
    contentKeywordBonus: clampNumber(
      merged.search?.contentKeywordBonus,
      0,
      1,
      0.16,
    ),
    metadataKeywordBonus: clampNumber(
      merged.search?.metadataKeywordBonus,
      0,
      1,
      0.06,
    ),
    maxPassagesPerSource: clampNumber(
      merged.search?.maxPassagesPerSource,
      1,
      50,
      5,
    ),
  };
  // Per-mode search algorithm overrides. Each mode is materialized with the
  // full field set, seeded from the shared search settings so existing
  // single-config tuning carries into all three modes.
  const searchModes = Object.fromEntries(
    SEARCH_MODE_KEYS.map((modeKey) => [
      modeKey,
      normalizeSearchAlgorithmOverride(merged.searchModes?.[modeKey], search),
    ]),
  );
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
  const chatIntegration = normalizeChatIntegration(merged.chatIntegration, search);

  return {
    version: 1,
    databasePath,
    sources,
    chunking,
    search,
    searchModes,
    embedding,
    chatIntegration,
    chatModes: normalizeChatModes(hasExplicitChatModes ? merged.chatModes : null, {
      enabled: chatIntegration.enabled,
    }),
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
  
  const skippedCount = Math.max(0, (options.totalChunks || 0) - rows.length);
  if (skippedCount > 0 && typeof options.onBatch === "function") {
    options.onBatch({
      embeddedDelta: 0,
      errorsDelta: 0,
      skippedDelta: skippedCount
    });
  }
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
              totalChunks: gaps.chunks,
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
                stats.embeddingsSkipped += batchStats.skippedDelta || 0;
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
              totalChunks: gaps.chunks,
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
                stats.embeddingsSkipped += batchStats.skippedDelta || 0;
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
        onlyMissing: true,
        totalChunks: chunks.length,
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
          stats.embeddingsSkipped += batchStats.skippedDelta || 0;
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

function normalizeRetrievalQuoteMarks(text) {
  return String(text || "")
    .replace(/[\u00ab\u00bb\u201c\u201d\u201e\u201f]/g, '"')
    .replace(/[\u2018\u2019\u201a\u201b]/g, "'");
}

// Lightweight language detector. Returns "es", "en", or "" (unknown).
// Two cheap, fast signals:
//   1. Spanish-only diacritics / punctuation → "es"
//   2. Common stop-word counts ("el la los las de y que" vs "the and of to a")
// The goal is "is the chunk language probably the same as the query?",
// not perfect language ID. Unknown is treated as a match.
const SPANISH_STOPWORDS = new Set([
  "el","la","los","las","un","una","unos","unas","de","del","y","o","u","que",
  "porque","como","pero","si","no","es","son","fue","fueron","ser","estar",
  "se","su","sus","lo","les","me","te","nos","con","sin","por","para","entre",
  "más","muy","ya","sobre","cuando","donde","quien","quién","cuál","cómo",
]);
const ENGLISH_STOPWORDS = new Set([
  "the","a","an","and","or","but","if","of","to","in","on","at","by","for",
  "from","as","is","are","was","were","be","been","being","that","this",
  "these","those","with","without","into","about","over","under","than",
  "then","there","here","what","when","where","why","how","who","whose",
  "which","not","no","yes","do","does","did","have","has","had",
]);
const SPANISH_DIACRITICS = /[áéíóúüñ¿¡]/i;
function detectLanguageHint(text) {
  const raw = String(text || "");
  if (!raw) return "";
  if (SPANISH_DIACRITICS.test(raw)) return "es";
  const tokens = raw
    .toLowerCase()
    .match(/[\p{L}]{2,}/gu);
  if (!tokens || tokens.length < 3) return "";
  let es = 0;
  let en = 0;
  for (const token of tokens) {
    if (SPANISH_STOPWORDS.has(token)) es += 1;
    else if (ENGLISH_STOPWORDS.has(token)) en += 1;
  }
  if (es === 0 && en === 0) return "";
  if (es >= en * 2 && es >= 2) return "es";
  if (en >= es * 2 && en >= 2) return "en";
  return "";
}

// Cap on how much same-language bias the bonus stage is allowed to apply.
// 1.0 means full bonus (legacy behaviour); 0.25 means a 75% reduction when
// the chunk language clearly differs from the query language.
const CROSS_LINGUAL_BONUS_FACTOR = 0.25;
function crossLingualMultiplier(queryLang, chunkLang) {
  if (!queryLang || !chunkLang) return 1;
  if (queryLang === chunkLang) return 1;
  return CROSS_LINGUAL_BONUS_FACTOR;
}

function extractSearchTerms(query) {
  const terms = normalizeSearchText(query).match(/[\p{L}\p{N}]{2,}/gu) || [];
  const filtered = terms.filter((term) => !SEARCH_STOP_WORDS.has(term));
  const useful = filtered.length ? filtered : terms;
  return Array.from(new Set(useful)).slice(0, 16);
}

function extractQuotedTerms(query) {
  const matches = [];
  const raw = normalizeRetrievalQuoteMarks(query);
  const patterns = [/"([^"]+)"/gu, /'([^']+)'/gu];
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

// Extract the raw (non-normalized) spans inside any quote style. Used to
// build the user-instruction half of a quote-restricted query — preserving
// original case/punctuation for the LLM prompt.
function extractQuotedSpansRaw(query) {
  const raw = normalizeRetrievalQuoteMarks(query);
  const spans = [];
  const patterns = [/"([^"]+)"/gu, /'([^']+)'/gu];
  for (const pattern of patterns) {
    let match = null;
    while ((match = pattern.exec(raw)) !== null) {
      spans.push({ start: match.index, end: match.index + match[0].length, text: match[1] });
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

// Splits a raw chat query into the part used for retrieval (vector + FTS +
// metadata) and the part passed to the LLM as instruction. When quotes are
// present, only quoted spans are embedded; everything outside the quotes is
// treated as user instruction. When no quotes are present, behavior is
// unchanged: the whole query is the retrieval query and there is no extra
// instruction. Empty / whitespace-only quotes degrade to the default.
function splitQueryForRetrieval(query) {
  const raw = normalizeRetrievalQuoteMarks(query);
  if (!raw.trim()) {
    return { retrievalQuery: raw, userInstruction: "", hasQuotedScope: false };
  }
  const spans = extractQuotedSpansRaw(raw);
  if (!spans.length) {
    return { retrievalQuery: raw, userInstruction: "", hasQuotedScope: false };
  }
  const quotedJoined = spans
    .map((span) => span.text.trim())
    .filter(Boolean)
    .join(" ");
  if (!quotedJoined) {
    return { retrievalQuery: raw, userInstruction: "", hasQuotedScope: false };
  }
  let outsideText = "";
  let cursor = 0;
  for (const span of spans) {
    outsideText += raw.slice(cursor, span.start);
    cursor = span.end;
  }
  outsideText += raw.slice(cursor);
  const userInstruction = outsideText.replace(/\s+/g, " ").trim();
  return {
    retrievalQuery: quotedJoined,
    userInstruction,
    hasQuotedScope: true,
    quotedPhrases: spans
      .map((span) => normalizeSearchText(span.text).trim())
      .filter((term) => term.length >= 2),
  };
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

function equivalentTermsFor(term) {
  const normalized = normalizeSearchText(term);
  if (!normalized) return [];
  return uniqueTerms(
    [normalized, ...(CROSS_LINGUAL_EQUIVALENTS.get(normalized) || [])],
    16,
  );
}

function expandEquivalentTerms(terms, limit = 64) {
  return uniqueTerms(
    (Array.isArray(terms) ? terms : []).flatMap((term) =>
      equivalentTermsFor(term),
    ),
    limit,
  );
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

function buildQuoteScopeGroups(quotedPhrases) {
  return (Array.isArray(quotedPhrases) ? quotedPhrases : [])
    .map((phrase) => {
      const phrases = uniqueTerms([phrase], 24);
      const terms = uniqueTerms(
        phrases
          .flatMap(splitSearchTerms)
          .flatMap((term) => equivalentTermsFor(term))
          .filter((term) => !SEARCH_STOP_WORDS.has(term)),
        48,
      );
      return { phrases, terms };
    })
    .filter((group) => group.phrases.length || group.terms.length);
}

function isStrictFacetTerm(term) {
  const normalized = normalizeSearchText(term);
  if (!normalized || normalized.length < 3) return false;
  if (SEARCH_STOP_WORDS.has(normalized)) return false;
  if (RETRIEVAL_WEAK_TERMS.has(normalized)) return false;
  if (isConceptTrigger(normalized)) return false;
  return true;
}

function buildFacetGroups(terms, limit = 4) {
  const groups = [];
  const seen = new Set();
  for (const term of uniqueTerms(terms, 32)) {
    if (!isStrictFacetTerm(term)) continue;
    const equivalents = expandEquivalentTerms([term], 12).filter(
      (candidate) => candidate.length >= 3,
    );
    if (!equivalents.length) continue;
    const key = equivalents.slice().sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    groups.push(equivalents);
    if (groups.length >= limit) break;
  }
  return groups;
}

function buildSourceFacetGroups(sourceHints = []) {
  const groups = [];
  const seen = new Set();
  for (const hint of Array.isArray(sourceHints) ? sourceHints : []) {
    const terms = expandEquivalentTerms(
      [
        ...(hint.sourceTerms || hint.terms || []),
        ...(hint.titleHint ? [] : splitSearchTerms(hint.label || "")),
        ...splitSearchTerms(hint.author || ""),
      ],
      32,
    ).filter((term) => term.length >= 3 && !SEARCH_STOP_WORDS.has(term));
    if (!terms.length) continue;
    const key = terms.slice().sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    groups.push(terms.slice(0, 12));
    if (groups.length >= 3) break;
  }
  return groups;
}

function buildSearchPlan(query, sourceHints = [], options = {}) {
  const supportingQuery = options.supportingQuery || "";
  const allTerms = uniqueTerms(splitSearchTerms(query), 48);
  const supportingTerms = uniqueTerms(
    splitSearchTerms(supportingQuery).filter(
      (term) => !SEARCH_STOP_WORDS.has(term) && !RETRIEVAL_WEAK_TERMS.has(term),
    ),
    24,
  );
  const quotedPhrases = Array.isArray(options.quotedPhrases)
    ? uniqueTerms(options.quotedPhrases, 24)
    : extractQuotedTerms(query);
  const quotedTerms = uniqueTerms(quotedPhrases.flatMap(splitSearchTerms), 48);
  const sourceTerms = getSourceHintTermSet(sourceHints);
  const nonSourceTerms = allTerms.filter(
    (term) => !isSourceHintTerm(term, sourceTerms),
  );
  const usefulTerms = nonSourceTerms.filter(
    (term) => !SEARCH_STOP_WORDS.has(term) && !RETRIEVAL_WEAK_TERMS.has(term),
  );
  const conceptInputTerms = uniqueTerms([...allTerms, ...quotedTerms], 96);
  const conceptPlan = getConceptExpansions(conceptInputTerms);
  const quotedPrimaryTerms = quotedTerms.filter(
    (term) =>
      !SEARCH_STOP_WORDS.has(term) &&
      !RETRIEVAL_WEAK_TERMS.has(term) &&
      !isConceptTrigger(term) &&
      !isSourceHintTerm(term, sourceTerms),
  );
  const primaryTerms = uniqueTerms(
    [
      ...quotedPrimaryTerms,
      ...usefulTerms.filter((term) => !isConceptTrigger(term)),
    ],
    24,
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
    64,
  );
  const ftsTerms = effectivePrimaryTerms.length
    ? effectivePrimaryTerms
    : uniqueTerms([...quotedTerms, ...expansionTerms, ...fallbackTerms], 16);
  const lexicalExpansionTerms = expandEquivalentTerms(
    [...effectivePrimaryTerms, ...quotedTerms],
    80,
  ).filter((term) => !effectivePrimaryTerms.includes(term));
  const sourceFacetGroups = buildSourceFacetGroups(sourceHints);
  const topicFacetGroups = buildFacetGroups(
    uniqueTerms(
      [
        ...quotedPrimaryTerms,
        ...effectivePrimaryTerms,
        ...supportingTerms,
      ].filter((term) => !isSourceHintTerm(term, sourceTerms)),
      24,
    ),
    sourceFacetGroups.length ? 4 : 3,
  );
  const strictFacetGroups = sourceFacetGroups.length
    ? [...sourceFacetGroups, ...topicFacetGroups.slice(0, 4)]
    : topicFacetGroups.slice(0, 3);
  return {
    allTerms,
    quotedPhrases,
    quotedTerms,
    quoteScopeGroups: buildQuoteScopeGroups(quotedPhrases),
    hasQuotedScope: options.hasQuotedScope === true,
    concepts: conceptPlan.concepts,
    primaryTerms: effectivePrimaryTerms,
    supportingTerms,
    expansionTerms: uniqueTerms([...expansionTerms, ...lexicalExpansionTerms], 96),
    lexicalExpansionTerms,
    metadataTerms: uniqueTerms(
      [
        ...effectivePrimaryTerms,
        ...quotedPrimaryTerms,
        ...lexicalExpansionTerms.slice(0, 24),
      ],
      24,
    ),
    ftsTerms: uniqueTerms([...ftsTerms, ...lexicalExpansionTerms.slice(0, 12)], 24),
    scoringTerms: uniqueTerms(
      [
        ...effectivePrimaryTerms,
        ...expansionTerms,
        ...lexicalExpansionTerms,
        ...supportingTerms,
      ],
      80,
    ),
    sourceFacetGroups,
    topicFacetGroups,
    strictFacetGroups,
    hasTitleSourceHint: sourceHints.some((hint) => hint?.titleHint === true),
  };
}

function isSemanticBridgeTerm(term) {
  if (!term) return false;
  if (SEARCH_STOP_WORDS.has(term)) return false;
  return term.length >= 4 || /^\d{4}$/u.test(term);
}

function buildSemanticBridgeTerms(results, limit = SEMANTIC_BRIDGE_TERM_LIMIT) {
  const docCounts = new Map();
  const termCounts = new Map();
  const semanticResults = Array.isArray(results)
    ? results.slice(0, SEMANTIC_BRIDGE_RESULT_LIMIT)
    : [];
  for (const result of semanticResults) {
    const text = [
      result?.title,
      result?.author,
      result?.heading,
      String(result?.text || "").slice(0, 1800),
    ]
      .filter(Boolean)
      .join(" ");
    const terms = splitSearchTerms(text).filter(isSemanticBridgeTerm);
    const uniqueResultTerms = new Set(terms);
    for (const term of uniqueResultTerms) {
      docCounts.set(term, (docCounts.get(term) || 0) + 1);
    }
    for (const term of terms) {
      termCounts.set(term, (termCounts.get(term) || 0) + 1);
    }
  }

  const minDocs = semanticResults.length >= 3 ? 2 : 1;
  return Array.from(docCounts.entries())
    .filter(([, docCount]) => docCount >= minDocs)
    .map(([term, docCount]) => ({
      term,
      score: docCount * 4 + Math.min(termCounts.get(term) || 0, 12),
    }))
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return a.term.localeCompare(b.term);
    })
    .map((item) => item.term)
    .slice(0, limit);
}

function addSemanticBridgeTermsToPlan(plan, bridgeTerms) {
  const terms = uniqueTerms(bridgeTerms, SEMANTIC_BRIDGE_TERM_LIMIT);
  if (!terms.length) return plan;
  return {
    ...plan,
    semanticBridgeTerms: terms,
    expansionTerms: uniqueTerms([...(plan.expansionTerms || []), ...terms], 96),
    scoringTerms: uniqueTerms([...(plan.scoringTerms || []), ...terms], 96),
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
  const sourceText =
    raw.titleHint === true
      ? [author, filePath, raw.text || ""].filter(Boolean).join(" ")
      : text;
  const terms = extractSearchTerms(text).filter((term) => term.length > 2);
  const sourceTerms = extractSearchTerms(sourceText).filter(
    (term) => term.length > 2,
  );
  if (!label && !author && !filePath && !terms.length) return null;
  return {
    label,
    author,
    path: filePath,
    terms,
    sourceTerms,
    titleHint: raw.titleHint === true,
  };
}

function cleanSourceHintLabel(raw) {
  return String(raw || "")
    .replace(
      /\b(?:cual|cu[aá]l|que|qu[eé]|what|who|where|when|how|why|did|does|do)\b.*$/iu,
      "",
    )
    .replace(
      /^(?:el|la|los|las|the|a|an|autor|author|filosofo|filosofa|philosopher|writer|escritor|escritora)\s+/iu,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function extractQuerySourceHints(query) {
  const hints = [];
  const patterns = [
    /\bseg[uú]n\s+([^,.;:?!\n]{3,80})/giu,
    /\baccording\s+to\s+([^,.;:?!\n]{3,80})/giu,
    /\b(?:libro|obra|book|work)\s+["“”']?([^"“”'\n]{3,100})["“”']?/giu,
    /\bwhat\s+(?:did|does|do)\s+([^,.;:?!\n]{3,80}?)\s+(?:say|think|write|argue|claim|believe|feel|explain|thought|wrote|said|argued|claimed|believed|explained|explains)\s+(?:about|of|regarding)\b/giu,
    /\bqu[eé]\s+(?:dijo|dice|opinaba|opino|opin[oó]|pensaba|piensa|escribio|escribi[oó]|argumentaba|afirmaba|creia|cre[ií]a|explica|explicaba|explico|explic[oó])\s+([^,.;:?!\n]{3,80}?)\s+(?:sobre|de|acerca\s+de|respecto\s+a)\b/giu,
  ];
  for (const pattern of patterns) {
    let match = null;
    while ((match = pattern.exec(query)) !== null) {
      const raw = cleanSourceHintLabel(match[1]);
      const hint = normalizeSourceHint({ label: raw });
      if (hint) hints.push(hint);
    }
  }
  const titleAuthorPatterns = [
    {
      pattern:
        /\b(?:en|in)\s+["“”']?(?:el|la|los|las|the)?\s*([^"“”',.;:?!\n]{3,90}?)["“”']?\s+(?:de|by)\s+([A-ZÁÉÍÓÚÑ][^,.;:?!\n]{2,80})/giu,
      build: (match) => ({ label: match[1], author: match[2] }),
    },
    {
      pattern:
        /\b([A-ZÁÉÍÓÚÑ][\p{L}ÁÉÍÓÚáéíóúñÑ]+)(?:'s|’s)\s+([^,.;:?!\n]{3,90})/gu,
      build: (match) => ({ label: match[2], author: match[1] }),
    },
    {
      pattern:
        /\bwhat\s+is\s+([A-ZÁÉÍÓÚÑ][\p{L}ÁÉÍÓÚáéíóúñÑ]+)\s+([^,.;:?!\n]{3,90}?)\s+about\b/giu,
      build: (match) => ({ label: match[2], author: match[1] }),
    },
  ];
  for (const { pattern, build } of titleAuthorPatterns) {
    let match = null;
    while ((match = pattern.exec(query)) !== null) {
      const raw = build(match);
      const hint = normalizeSourceHint({
        label: cleanSourceHintLabel(raw.label),
        author: cleanSourceHintLabel(raw.author),
        titleHint: true,
      });
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

function sourceHintResolvedFileIds(sourceHints = []) {
  return uniqueIntegerList(
    (Array.isArray(sourceHints) ? sourceHints : []).flatMap(
      (hint) => hint?.resolvedFileIds || [],
    ),
    80,
  );
}

function uniqueIntegerList(values, limit = 100) {
  const seen = new Set();
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed <= 0 || seen.has(parsed)) continue;
    seen.add(parsed);
    result.push(parsed);
    if (result.length >= limit) break;
  }
  return result;
}

function intersectOrUseFileIds(baseIds, extraIds) {
  const base = uniqueIntegerList(baseIds, 1000);
  const extra = uniqueIntegerList(extraIds, 1000);
  if (base.length && extra.length) {
    const extraSet = new Set(extra);
    return base.filter((id) => extraSet.has(id));
  }
  return base.length ? base : extra;
}

function levenshteinDistance(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  const prev = Array.from({ length: right.length + 1 }, (_v, i) => i);
  const curr = Array(right.length + 1).fill(0);
  for (let i = 1; i <= left.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost,
      );
    }
    for (let j = 0; j <= right.length; j += 1) prev[j] = curr[j];
  }
  return prev[right.length];
}

function normalizedSimilarity(a, b) {
  const left = normalizeSearchText(a);
  const right = normalizeSearchText(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (right.includes(left) || left.includes(right)) {
    return Math.min(left.length, right.length) / Math.max(left.length, right.length);
  }
  const maxLength = Math.max(left.length, right.length);
  if (!maxLength) return 0;
  return 1 - levenshteinDistance(left, right) / maxLength;
}

function scoreSourceFileMatch(file, hint) {
  const label = normalizeSearchText(
    [hint.label, hint.author].filter(Boolean).join(" "),
  );
  const baseHintTerms = uniqueTerms(
    [...(hint.terms || []), ...splitSearchTerms(label)].filter(
      (term) => term.length > 2,
    ),
    16,
  );
  const termGroups = baseHintTerms.map((term) => equivalentTermsFor(term));
  const haystack = normalizeSearchText(
    [file.title, file.author, file.path].filter(Boolean).join(" "),
  );
  const titleAuthor = normalizeSearchText(
    [file.title, file.author].filter(Boolean).join(" "),
  );
  let score = 0;
  if (hint.path && hint.path === file.path) score += 3;
  const labelInTitleAuthor = Boolean(label && titleAuthor.includes(label));
  const labelInHaystack = Boolean(label && haystack.includes(label));
  if (labelInTitleAuthor) score += 2.5;
  if (labelInHaystack) score += 1.5;
  const matchedGroups = termGroups.filter((group) =>
    group.some((term) => hasNormalizedSearchTerm(haystack, term)),
  );
  if (termGroups.length) {
    score += (matchedGroups.length / termGroups.length) * 1.6;
    if (matchedGroups.length >= Math.min(2, termGroups.length)) score += 0.5;
  }
  let bestSimilarity = 0;
  if (label) {
    const pieces = [file.title, file.author, path.basename(file.path || "")]
      .filter(Boolean)
      .map(normalizeSearchText);
    bestSimilarity = Math.max(
      ...pieces.map((piece) => normalizedSimilarity(label, piece)),
      0,
    );
    score += bestSimilarity * 1.25;
  }
  if (
    termGroups.length >= 2 &&
    matchedGroups.length < 2 &&
    !labelInTitleAuthor &&
    !labelInHaystack &&
    bestSimilarity < 0.72
  ) {
    return 0;
  }
  return score;
}

async function resolveSourceHints(config, sourceHints = []) {
  if (!sourceHints.length) return [];
  let rows = [];
  try {
    rows = await runSqliteJson(
      config.databasePath,
      `SELECT id, title, author, path
FROM library_files
ORDER BY lower(path);`,
    );
  } catch (_error) {
    return sourceHints;
  }
  return sourceHints.map((hint) => {
    const scored = rows
      .map((row) => ({
        id: Number(row.id),
        title: row.title || "",
        author: row.author || "",
        path: row.path || "",
        score: scoreSourceFileMatch(row, hint),
      }))
      .filter((item) => item.id > 0 && item.score >= 0.9)
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, 40);
    const resolvedTerms = expandEquivalentTerms(
      [...(hint.terms || []), ...splitSearchTerms(hint.label || hint.author || "")],
      48,
    );
    return {
      ...hint,
      terms: uniqueTerms([...(hint.terms || []), ...resolvedTerms], 64),
      resolvedFileIds: scored.map((item) => item.id),
      resolvedPaths: scored.map((item) => item.path),
    };
  });
}

function getSourceHintTermSet(sourceHints = []) {
  return new Set(
    (Array.isArray(sourceHints) ? sourceHints : [])
      .flatMap((hint) => hint?.sourceTerms || hint?.terms || [])
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

function ftsTermQuery(term) {
  const normalized = normalizeSearchText(term).replace(/[^\p{L}\p{N}]/gu, "");
  if (!normalized || normalized.length < 2) return "";
  return `${normalized.replace(/"/g, "")}*`;
}

function ftsFacetGroupQuery(group) {
  const terms = uniqueTerms(group, 16).map(ftsTermQuery).filter(Boolean);
  if (!terms.length) return "";
  if (terms.length === 1) return terms[0];
  return `(${terms.join(" OR ")})`;
}

function buildStrictFtsQuery(groups, minGroups = 2) {
  const parts = (Array.isArray(groups) ? groups : [])
    .map(ftsFacetGroupQuery)
    .filter(Boolean);
  if (parts.length < minGroups) return "";
  return parts.join(" AND ");
}

function normalizeResult(row, kind) {
  return {
    chunkId: Number(row.chunkId),
    fileId: Number(row.fileId || row.file_id || 0),
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

// Book filter: chat requests may restrict retrieval to specific
// library_files ids. Sanitized to at most 10 positive integers.
const LIBRARY_FILE_FILTER_MAX = 10;

function sanitizeLibraryFileIds(value) {
  if (!Array.isArray(value)) return [];
  const ids = [];
  for (const item of value) {
    const id = Number.parseInt(item, 10);
    if (!Number.isInteger(id) || id <= 0 || ids.includes(id)) continue;
    ids.push(id);
    if (ids.length >= LIBRARY_FILE_FILTER_MAX) break;
  }
  return ids;
}

function fileIdFilterSql(fileIds, column) {
  if (!Array.isArray(fileIds) || !fileIds.length) return "";
  return ` AND ${column} IN (${fileIds.map((id) => sqlInteger(id)).join(", ")})`;
}

async function searchLibraryFiles(query, options = {}) {
  const config = options.config || loadLibraryConfig();
  if (!fs.existsSync(config.databasePath)) return [];
  const term = String(query || "")
    .trim()
    .toLowerCase();
  if (!term) return [];
  const limit = clampNumber(options.limit, 1, 50, 12);
  const like = sqlLiteral(`%${term}%`);
  const rows = await runSqliteJson(
    config.databasePath,
    `SELECT f.id AS id, f.title AS title, f.author AS author, f.path AS path
FROM library_files f
WHERE lower(f.title) LIKE ${like} OR lower(f.author) LIKE ${like}
ORDER BY lower(f.title)
LIMIT ${sqlInteger(limit)};`,
  );
  return rows.map((row) => ({
    id: Number(row.id),
    title:
      String(row.title || "").trim() ||
      path.basename(String(row.path || "")) ||
      "Untitled",
    author: String(row.author || "").trim(),
    path: String(row.path || ""),
  }));
}

async function searchFts(
  config,
  query,
  limit,
  sourceHints = [],
  plan = null,
  fileIds = [],
) {
  if (config.search?.keywordEnabled !== true) return [];
  const ftsQuery = buildFtsQuery(query, sourceHints, plan);
  if (!ftsQuery) return [];
  return searchFtsQuery(config, ftsQuery, limit, "keyword", fileIds);
}

async function searchFtsQuery(
  config,
  ftsQuery,
  limit,
  kind = "keyword",
  fileIds = [],
) {
  if (config.search?.keywordEnabled !== true || !ftsQuery) return [];
  const rows = await runSqliteJson(
    config.databasePath,
    `SELECT
  c.id AS chunkId,
  f.id AS fileId,
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
WHERE library_chunks_fts MATCH ${sqlLiteral(ftsQuery)}${fileIdFilterSql(fileIds, "c.file_id")}
ORDER BY score
LIMIT ${sqlInteger(limit)};`,
  );
  return rows.map((row) => normalizeResult(row, kind));
}

function rowSelectSql() {
  return `c.id AS chunkId,
  f.id AS fileId,
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
  fileIds = [],
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
WHERE (${conditions.join(" OR ")})${fileIdFilterSql(fileIds, "f.id")}
ORDER BY lower(f.path), c.chunk_index
LIMIT ${sqlInteger(limit)};`,
  );
  return rows.map((row) => normalizeResult(row, "metadata"));
}

function sourceHintFileConditions(sourceHints) {
  const exactIds = sourceHintResolvedFileIds(sourceHints).map(
    (id) => `f.id = ${sqlInteger(id)}`,
  );
  const exactPaths = sourceHints
    .flatMap((hint) => [hint.path, ...(hint.resolvedPaths || [])])
    .filter(Boolean)
    .map((filePath) => `f.path = ${sqlLiteral(filePath)}`);
  const exactConditions = [...exactIds, ...exactPaths];
  if (exactConditions.length) return exactConditions;
  const fuzzyTerms = Array.from(
    new Set(sourceHints.flatMap((hint) => hint.terms || [])),
  )
    .filter((term) => term.length > 2)
    .slice(0, 12);
  const fuzzy = fuzzyTerms.map((term) => {
    const like = sqlLiteral(`%${term}%`);
    return `(lower(f.title) LIKE ${like} OR lower(f.author) LIKE ${like} OR lower(f.path) LIKE ${like})`;
  });
  return fuzzy;
}

async function searchSourceDeepScan(
  config,
  query,
  limit,
  sourceHints = [],
  plan = null,
  fileIds = [],
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
  WHERE (${conditions.join(" OR ")})${fileIdFilterSql(fileIds, "f.id")}
  ORDER BY lower(path)
  LIMIT 20
)
ORDER BY f.path, c.chunk_index
LIMIT 5000;`,
  );
  const queryPlan = plan || buildSearchPlan(query, sourceHints);
  const queryLang = detectLanguageHint(query);
  return rows
    .map((row) => normalizeResult(row, "source"))
    .map((result) => {
      const contentScore = computePlannedContentBonus(
        result.text,
        queryPlan,
        config,
        queryLang,
      );
      const headingScore = computePlannedContentBonus(
        result.heading,
        queryPlan,
        config,
        queryLang,
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

async function searchSourceHeadings(
  config,
  limit,
  sourceHints = [],
  plan = null,
  fileIds = [],
) {
  const sourceIds = intersectOrUseFileIds(
    fileIds,
    sourceHintResolvedFileIds(sourceHints),
  );
  if (!sourceIds.length) return [];
  const queryPlan = plan || buildSearchPlan("", sourceHints);
  const terms = uniqueTerms(
    (queryPlan.topicFacetGroups || []).flatMap((group) => group),
    32,
  ).filter((term) => term.length > 2);
  if (!terms.length) return [];
  const conditions = terms.map((term) => {
    const like = sqlLiteral(`%${term}%`);
    return `lower(c.heading) LIKE ${like}`;
  });
  const rows = await runSqliteJson(
    config.databasePath,
    `SELECT
  ${rowSelectSql()},
  0 AS score
FROM library_chunks c
JOIN library_files f ON f.id = c.file_id
WHERE c.file_id IN (${sourceIds.map((id) => sqlInteger(id)).join(", ")})
  AND (${conditions.join(" OR ")})
ORDER BY f.path, c.chunk_index
LIMIT ${sqlInteger(limit)};`,
  );
  return rows.map((row) => normalizeResult(row, "source-heading"));
}

async function searchVector(config, query, limit, fileIds = []) {
  if (!isVectorSearchConfigured(config)) return [];
  const queryEmbedding = (await embedTexts(config, [query], "query"))[0];
  if (!Array.isArray(queryEmbedding) || !queryEmbedding.length) return [];
  const vectorJson = JSON.stringify(queryEmbedding);
  // The vec0 KNN picks the k nearest chunks across the whole library and the
  // file filter is applied after the join, so widen k when filtering to keep
  // recall inside the selected books.
  const knnLimit = fileIds.length
    ? Math.min(Math.max(limit * 20, 200), 1000)
    : limit;
  const rows = await runSqliteJson(
    config.databasePath,
    `SELECT
  c.id AS chunkId,
  f.id AS fileId,
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
  AND k = ${sqlInteger(knnLimit)}${fileIdFilterSql(fileIds, "c.file_id")}
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
    if (
      result.fileId &&
      Array.isArray(hint.resolvedFileIds) &&
      hint.resolvedFileIds.includes(result.fileId)
    ) {
      boost += strong ? 0.55 : 0.35;
    }
    if (hint.path && hint.path === result.path) {
      boost += strong ? 0.55 : 0.35;
    }
    if (Array.isArray(hint.resolvedPaths) && hint.resolvedPaths.includes(result.path)) {
      boost += strong ? 0.5 : 0.3;
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
  config = {},
  queryLang = "",
) {
  const haystack = normalizeSearchText(
    [result.title, result.author, result.path, result.heading]
      .filter(Boolean)
      .join(" "),
  );
  // Source-hint boosts (e.g. "according to Apolodoro") are intentionally
  // language-neutral: they apply at full strength regardless of the
  // chunk's language. Only the term-match bonuses below are damped when
  // the chunk language clearly differs from the query language.
  let bonus = computeSourceHintBoost(result, sourceHints, strongSourceHints);
  const chunkLang = detectLanguageHint(
    [result.title, result.author, result.heading].filter(Boolean).join(" ") ||
      result.text,
  );
  const multiplier = crossLingualMultiplier(queryLang, chunkLang);
  const metadataKeywordBonus =
    (config.search?.metadataKeywordBonus ?? 0.06) * multiplier;
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

function computePlannedContentBonus(text, plan = {}, config = {}, queryLang = "") {
  const haystack = normalizeSearchText(text);
  if (!haystack) return 0;
  const chunkLang = detectLanguageHint(text);
  const multiplier = crossLingualMultiplier(queryLang, chunkLang);
  let bonus = 0;
  const contentKeywordBonus =
    (config.search?.contentKeywordBonus ?? 0.16) * multiplier;
  const exactPhraseBonus = contentKeywordBonus * 1.75;
  const quotedTermBonus = contentKeywordBonus * 0.75;
  const expansionTermBonus = contentKeywordBonus * 0.25;
  const phraseTerms = uniqueTerms(plan.quotedPhrases || [], 64);
  for (const phrase of phraseTerms) {
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
  for (const term of plan.supportingTerms || []) {
    if (term && hasNormalizedSearchTerm(haystack, term)) {
      bonus += contentKeywordBonus * 0.15;
    }
  }
  return Math.min(bonus, 0.85);
}

function resultHasPrimaryTerm(result, plan = {}) {
  if (!plan.primaryTerms?.length) return true;
  const primaryTerms = expandEquivalentTerms(plan.primaryTerms, 64);
  const haystack = normalizeSearchText(
    [result?.title, result?.author, result?.heading, result?.text]
      .filter(Boolean)
      .join(" "),
  );
  return primaryTerms.some(
    (term) => term && hasNormalizedSearchTerm(haystack, term),
  );
}

function resultHasStrongPrimaryContent(result, plan = {}) {
  if (!plan.primaryTerms?.length) return false;
  const primaryTerms = expandEquivalentTerms(plan.primaryTerms, 64);
  const haystack = normalizeSearchText(
    [result?.heading, result?.text].filter(Boolean).join(" "),
  );
  return primaryTerms.some(
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

function resultMatchesQuoteScope(result, plan = {}) {
  if (!Array.isArray(plan.quoteScopeGroups) || !plan.quoteScopeGroups.length) {
    return true;
  }
  const haystack = normalizeSearchText(
    [result?.title, result?.author, result?.heading, result?.text]
      .filter(Boolean)
      .join(" "),
  );
  return plan.quoteScopeGroups.every((group) => {
    if ((group.phrases || []).some((phrase) => haystack.includes(phrase))) {
      return true;
    }
    const terms = (group.terms || []).filter(Boolean);
    if (!terms.length) return false;
    const matches = terms.filter((term) =>
      hasNormalizedSearchTerm(haystack, term),
    ).length;
    return matches >= Math.min(2, terms.length);
  });
}

function candidateHasSemanticRetrieval(candidate) {
  return (
    candidate?.channels?.has?.("semantic") ||
    candidate?.channels?.has?.("semantic-bridge")
  );
}

function candidateMatchesQuoteScope(candidate, plan = {}) {
  if (!plan.hasQuotedScope) return true;
  if (candidateHasSemanticRetrieval(candidate)) return true;
  return resultMatchesQuoteScope(candidate?.result, plan);
}

function queryRequestsReferenceMaterial(query) {
  return /\b(introducci[oó]n|introduction|pr[oó]logo|prefacio|preface|nota|notas|notes|comentario|commentary|bibliograf[ií]a|bibliography|fuentes|sources)\b/iu.test(
    normalizeSearchText(query),
  );
}

function countPatternMatches(text, pattern, limit = 20) {
  const matches = String(text || "").match(pattern);
  return Math.min(Array.isArray(matches) ? matches.length : 0, limit);
}

function looksLikeReferenceListing(result) {
  const heading = normalizeSearchText(result?.heading || "");
  const text = String(result?.text || "").slice(0, 2200);
  const normalized = normalizeSearchText(text);
  if (
    /\b(bibliografia|bibliography|referencias|references|fuentes|sources)\b/u.test(
      heading,
    )
  ) {
    return true;
  }
  if (
    /\b(bibliografia|bibliography|referencias|references|fuentes|sources)\b/u.test(
      normalized.slice(0, 500),
    )
  ) {
    return true;
  }

  const yearCount = countPatternMatches(
    text,
    /\b(?:1[5-9]\d{2}|20\d{2})\b/gu,
  );
  const publisherMarkers = countPatternMatches(
    normalized,
    /\b(?:madrid|barcelona|mexico|paris|london|press|universidad|university|editorial|ediciones|fce|siglo|iberoamericana|vol|vols|eds|ed)\b/gu,
  );
  const citationSeparators = countPatternMatches(
    text,
    /(?:<<|—,|--,|\bet al\.|\b[A-ZÁÉÍÓÚÑ]{3,}[,;])/gu,
  );
  return (
    (yearCount >= 5 && publisherMarkers >= 3) ||
    (yearCount >= 4 && citationSeparators >= 5)
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
  if (looksLikeReferenceListing(result)) {
    penalty += 0.45;
  }
  return Math.min(penalty, 0.65);
}

function queryAsksForDateEvidence(query) {
  return /\b(when|date|established|establish|founded|created|issued|published|approved|promulgated|cuando|fecha|establecio|establecieron|fundado|fundada|creado|creada|emitido|emitida|publicado|publicada|aprobado|aprobada|promulgado|promulgada|promulgaron)\b/u.test(
    normalizeSearchText(query),
  );
}

function queryAsksForOpinionEvidence(query) {
  return /\b(opinion|opinaba|pensaba|think|thought|view|views|stance|position|postura|parecer|creia|defendia|proponia|argumentaba)\b/u.test(
    normalizeSearchText(query),
  );
}

function resultHasDateEvidence(result) {
  const rawText = [result?.heading, result?.text].filter(Boolean).join(" ");
  const normalized = normalizeSearchText(rawText);
  const hasDate =
    /\b\d{1,2}\s+de\s+[a-záéíóúñ]+\s+de\s+\d{3,4}\b/iu.test(rawText) ||
    /\b(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\s+de\s+\d{3,4}\b/iu.test(
      rawText,
    ) ||
    /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s+\d{3,4}\b/iu.test(
      rawText,
    ) ||
    /\b(?:1[0-9]{3}|20[0-9]{2})\b/u.test(normalized);
  const hasDateAction =
    /\b(promulgad\w*|establecid\w*|fundad\w*|cread\w*|emitid\w*|publicad\w*|aprobad\w*|decretad\w*|established|founded|created|issued|published|approved|promulgated|decreed)\b/u.test(
      normalized,
    );
  return { hasDate, hasDateAction };
}

function resultHasOpinionEvidence(result) {
  return /\b(opinion|opin\w*|pensab\w*|crei\w*|defend\w*|propon\w*|argument\w*|critic\w*|denunci\w*|conden\w*|rechaz\w*|abol\w*|suspend\w*|restituci\w*|thought|argued|defended|proposed|criticized|criticised|denounced|condemned|rejected|abolished|suspended|restitution)\b/u.test(
    normalizeSearchText([result?.heading, result?.text].filter(Boolean).join(" ")),
  );
}

function computeAnswerEvidenceBonus(result, query) {
  let bonus = 0;
  const asksDate = queryAsksForDateEvidence(query);
  const asksOpinion = queryAsksForOpinionEvidence(query);
  const dateEvidence = resultHasDateEvidence(result);
  const opinionEvidence = resultHasOpinionEvidence(result);
  if (asksDate && dateEvidence.hasDate && dateEvidence.hasDateAction) {
    bonus += 0.55;
  } else if (asksDate && dateEvidence.hasDate) {
    bonus += 0.25;
  }
  if (asksOpinion && opinionEvidence) {
    bonus += 0.3;
  }
  if (
    asksDate &&
    asksOpinion &&
    dateEvidence.hasDate &&
    opinionEvidence
  ) {
    bonus += 0.15;
  }
  return Math.min(bonus, 0.85);
}

function computeMissingAnswerEvidencePenalty(result, query) {
  let penalty = 0;
  const asksDate = queryAsksForDateEvidence(query);
  const asksOpinion = queryAsksForOpinionEvidence(query);
  const dateEvidence = resultHasDateEvidence(result);
  const opinionEvidence = resultHasOpinionEvidence(result);
  if (asksDate && !dateEvidence.hasDate) {
    penalty += 0.45;
  } else if (asksDate && !dateEvidence.hasDateAction) {
    penalty += 0.2;
  }
  if (asksOpinion && !opinionEvidence) {
    penalty += 0.15;
  }
  return Math.min(penalty, 0.55);
}

function resultFacetHaystack(result) {
  return normalizeSearchText(
    [result?.title, result?.author, result?.path, result?.heading, result?.text]
      .filter(Boolean)
      .join(" "),
  );
}

function resultMatchesFacetGroup(haystack, group) {
  return (Array.isArray(group) ? group : []).some((term) =>
    hasNormalizedSearchTerm(haystack, term),
  );
}

function countMatchedFacetGroups(result, groups = []) {
  const haystack = resultFacetHaystack(result);
  if (!haystack) return 0;
  return (Array.isArray(groups) ? groups : []).filter((group) =>
    resultMatchesFacetGroup(haystack, group),
  ).length;
}

function computeHeadingFacetBonus(result, plan = {}) {
  if (Array.isArray(plan.concepts) && plan.concepts.length) return 0;
  const groups = Array.isArray(plan.topicFacetGroups)
    ? plan.topicFacetGroups
    : [];
  if (!groups.length) return 0;
  const headingHaystack = normalizeSearchText(
    plan.hasTitleSourceHint
      ? result?.heading || ""
      : [result?.title, result?.heading].filter(Boolean).join(" "),
  );
  if (!headingHaystack) return 0;
  const matched = groups.filter((group) =>
    resultMatchesFacetGroup(headingHaystack, group),
  ).length;
  if (!matched) return 0;
  const coverage = matched / groups.length;
  return Math.min(0.9, coverage * 0.55 + (coverage === 1 ? 0.25 : 0));
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

function applyHybridBonuses(
  candidates,
  query,
  sourceHints,
  plan = null,
  config = {},
  answerQuery = query,
) {
  const queryPlan = plan || buildSearchPlan(query, sourceHints);
  const searchTerms = queryPlan.metadataTerms.length
    ? queryPlan.metadataTerms
    : extractSearchTerms(query);
  const strongSourceHints =
    queryRefersToPreviousSource(query) && sourceHints.length > 0;
  const queryLang = detectLanguageHint(query);
  const hasSemanticCandidates = candidates.some((candidate) =>
    candidateHasSemanticRetrieval(candidate),
  );
  return candidates.map((candidate) => {
    const metadataBonus = computeMetadataBonus(
      candidate.result,
      searchTerms,
      queryPlan.quotedPhrases || [],
      sourceHints,
      strongSourceHints,
      config,
      queryLang,
    );
    const contentBonus = computePlannedContentBonus(
      candidate.result.text,
      queryPlan,
      config,
      queryLang,
    );
    const headingBonus = computePlannedContentBonus(
      candidate.result.heading,
      queryPlan,
      config,
      queryLang,
    );
    // primaryContentBonus is a fixed-size kicker (~0.12-0.16) tied to the
    // same content match. Damp it identically so a cross-language hit isn't
    // double-rewarded relative to its damped content bonus.
    const chunkLang = detectLanguageHint(candidate.result.text);
    const primaryContentBonus = resultHasStrongPrimaryContent(
      candidate.result,
      queryPlan,
    )
      ? (config.search?.contentKeywordBonus ?? 0.12) *
        crossLingualMultiplier(queryLang, chunkLang)
      : 0;
    const conceptPenalty =
      queryPlan.concepts.length > 0 &&
      !resultHasExpansionContent(candidate.result, queryPlan)
        ? 0.35
        : 0;
    const passagePenalty = computePassagePenalty(candidate.result, answerQuery);
    const answerEvidenceBonus = computeAnswerEvidenceBonus(
      candidate.result,
      answerQuery,
    );
    const missingAnswerEvidencePenalty = computeMissingAnswerEvidencePenalty(
      candidate.result,
      answerQuery,
    );
    const facetGroupCount = Array.isArray(queryPlan.strictFacetGroups)
      ? queryPlan.strictFacetGroups.length
      : 0;
    const semanticDominantMode =
      Number(config.search?.semanticWeight || 0) >= SEMANTIC_DOMINANT_WEIGHT;
    const matchedFacetGroups = countMatchedFacetGroups(
      candidate.result,
      queryPlan.strictFacetGroups,
    );
    const facetCoverageBonus =
      facetGroupCount > 0 && !semanticDominantMode
        ? (matchedFacetGroups / facetGroupCount) * 0.65
        : 0;
    const facetCoveragePenalty =
      !semanticDominantMode &&
      facetGroupCount >= 2 &&
      matchedFacetGroups < Math.min(2, facetGroupCount)
        ? matchedFacetGroups === 0
          ? 0.75
          : 0.38
        : 0;
    const headingFacetBonus = semanticDominantMode
      ? 0
      : computeHeadingFacetBonus(candidate.result, queryPlan);
    const strictChannelBonus = semanticDominantMode
      ? 0
      : candidate.channels?.has?.("source-heading")
        ? 1.8
        : candidate.channels?.has?.("source-strict")
        ? 1.65
        : candidate.channels?.has?.("strict")
          ? 1.35
          : 0;
    const semanticDominantBonus =
      candidate.channels?.has?.("semantic") && semanticDominantMode
        ? 1.6
        : 0;
    const semanticQuoteScopeBonus =
      queryPlan.hasQuotedScope && candidateHasSemanticRetrieval(candidate)
        ? 0.25
        : 0;
    const metadataOnlyPenalty =
      hasSemanticCandidates &&
      candidate.channels?.size === 1 &&
      candidate.channels?.has?.("metadata")
        ? 0.3
        : 0;
    return {
      ...candidate,
      score:
        candidate.score +
        metadataBonus +
        contentBonus +
        headingBonus +
        primaryContentBonus -
        conceptPenalty -
        passagePenalty +
        answerEvidenceBonus +
        strictChannelBonus +
        semanticDominantBonus +
        facetCoverageBonus +
        headingFacetBonus +
        semanticQuoteScopeBonus -
        missingAnswerEvidencePenalty -
        facetCoveragePenalty -
        metadataOnlyPenalty,
      metadataBonus,
      contentBonus,
      headingBonus,
      primaryContentBonus,
      conceptPenalty,
      passagePenalty,
      answerEvidenceBonus,
      missingAnswerEvidencePenalty,
      strictChannelBonus,
      semanticDominantBonus,
      facetCoverageBonus,
      facetCoveragePenalty,
      headingFacetBonus,
      semanticQuoteScopeBonus,
      metadataOnlyPenalty,
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

function diversifyResults(
  scored,
  limit,
  sourceHints = [],
  plan = null,
  config = {},
) {
  const selected = [];
  const perPath = new Map();
  const fingerprints = new Set();
  const maxPerSource = Math.max(
    1,
    Math.min(
      limit,
      Number(config.search?.maxPassagesPerSource || 5),
    ),
  );
  const takeUpTo = (maxPerPath, target = limit, predicate = null) => {
    const effectiveMaxPerPath = Math.max(
      1,
      Math.min(limit, Number(maxPerPath || maxPerSource), maxPerSource),
    );
    for (const item of scored) {
      if (selected.length >= target) return;
      if (predicate && !predicate(item)) continue;
      const key = candidateKey(item.result);
      if (selected.some((existing) => candidateKey(existing.result) === key))
        continue;
      const fingerprint = resultTextFingerprint(item.result, plan);
      if (fingerprint && fingerprints.has(fingerprint)) continue;
      const count = perPath.get(item.result.path) || 0;
      if (count >= effectiveMaxPerPath) continue;
      perPath.set(item.result.path, count + 1);
      if (fingerprint) fingerprints.add(fingerprint);
      selected.push(item);
    }
  };
  const diversityTarget = Math.min(limit, Math.max(1, Math.ceil(limit * 0.6)));
  if (
    plan?.strictFacetGroups?.length &&
    Number(config.search?.semanticWeight || 0) < SEMANTIC_DOMINANT_WEIGHT
  ) {
    takeUpTo(
      maxPerSource,
      Math.min(limit, Math.max(3, Math.ceil(limit * 0.5))),
      (item) =>
        item.channels?.has?.("source-heading") ||
        item.channels?.has?.("source-strict") ||
        item.channels?.has?.("strict"),
    );
  }
  if (
    !sourceHints.length &&
    plan?.primaryTerms?.length &&
    Number(config.search?.semanticWeight || 0) < SEMANTIC_DOMINANT_WEIGHT
  ) {
    takeUpTo(
      maxPerSource,
      Math.min(limit, Math.max(3, Math.ceil(limit * 0.45))),
      (item) =>
        resultHasStrongPrimaryContent(item.result, plan) &&
        (!plan.concepts.length || resultHasExpansionContent(item.result, plan)),
    );
  }
  if (sourceHints.length) {
    takeUpTo(
      maxPerSource,
      Math.min(limit, Math.max(3, Math.ceil(limit * 0.45))),
      (item) =>
        resultMatchesSourceHints(item.result, sourceHints) &&
        Number(item.contentBonus || 0) > 0,
    );
  }
  takeUpTo(Math.min(maxPerSource, 2), diversityTarget);
  if (selected.length < limit) takeUpTo(maxPerSource);
  return selected.map((item) => ({
    ...item.result,
    score: item.score,
    channels: Array.from(item.channels || []),
  }));
}

async function searchLibrary(query, options = {}) {
  const config = resolveSearchConfigForMode(
    options.config || loadLibraryConfig(),
    options.mode,
  );
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
  const fileIds = sanitizeLibraryFileIds(options.fileIds);
  // Quote-scoped retrieval: quoted text remains the lexical scope for
  // keyword/metadata/source scans, while semantic search receives the full
  // question so unquoted intent still has weaker vector influence.
  const split = splitQueryForRetrieval(query);
  const lexicalQuery = split.hasQuotedScope ? split.retrievalQuery : query;
  const semanticQuery = split.hasQuotedScope ? query : lexicalQuery;
  const effectiveQuery = lexicalQuery || query;
  const sourceHints = await resolveSourceHints(
    config,
    mergeSourceHints(query, options.sourceHints),
  );
  let plan = buildSearchPlan(effectiveQuery, sourceHints, {
    supportingQuery: split.userInstruction,
    quotedPhrases: split.quotedPhrases,
    hasQuotedScope: split.hasQuotedScope,
  });
  const groups = [];
  let semanticResults = [];

  const strictFtsQuery = buildStrictFtsQuery(plan.strictFacetGroups, 2);
  if (strictFtsQuery) {
    const strictResults = await searchFtsQuery(
      config,
      strictFtsQuery,
      candidateLimit,
      "strict",
      fileIds,
    );
    if (strictResults.length) {
      groups.push({
        name: "strict",
        weight: config.search?.strictWeight ?? STRICT_FTS_DEFAULT_WEIGHT,
        results: strictResults,
      });
    }
  }

  const resolvedSourceFileIds = sourceHintResolvedFileIds(sourceHints);
  const sourceScopedFileIds = intersectOrUseFileIds(
    fileIds,
    resolvedSourceFileIds,
  );
  const sourceStrictQuery =
    sourceScopedFileIds.length && plan.topicFacetGroups.length
      ? buildStrictFtsQuery(plan.topicFacetGroups, 1)
      : "";
  if (sourceStrictQuery) {
    const sourceStrictResults = await searchFtsQuery(
      config,
      sourceStrictQuery,
      candidateLimit,
      "source-strict",
      sourceScopedFileIds,
    );
    if (sourceStrictResults.length) {
      groups.push({
        name: "source-strict",
        weight:
          config.search?.sourceStrictWeight ?? SOURCE_STRICT_FTS_DEFAULT_WEIGHT,
        results: sourceStrictResults,
      });
    }
  }
  const sourceHeadingResults = await searchSourceHeadings(
    config,
    Math.min(candidateLimit, 80),
    sourceHints,
    plan,
    fileIds,
  );
  if (sourceHeadingResults.length) {
    groups.push({
      name: "source-heading",
      weight:
        config.search?.sourceHeadingWeight ??
        SOURCE_STRICT_FTS_DEFAULT_WEIGHT + 0.4,
      results: sourceHeadingResults,
    });
  }

  if (Array.isArray(options.semanticResults)) {
    semanticResults = options.semanticResults;
    groups.push({
      name: "semantic",
      weight: config.search?.semanticWeight ?? 1.0,
      results: semanticResults,
    });
  } else if (isVectorSearchConfigured(config)) {
    try {
      semanticResults = await searchVector(
        config,
        semanticQuery,
        candidateLimit,
        fileIds,
      );
      groups.push({
        name: "semantic",
        weight: config.search?.semanticWeight ?? 1.0,
        results: semanticResults,
      });
    } catch (error) {
      console.warn(
        `Vector search failed; falling back to FTS5: ${error.message}`,
      );
    }
  }

  const semanticBridgeTerms = buildSemanticBridgeTerms(semanticResults);
  if (semanticBridgeTerms.length) {
    plan = addSemanticBridgeTermsToPlan(plan, semanticBridgeTerms);
    const bridgeQuery = semanticBridgeTerms.join(" ");
    const bridgePlan = buildSearchPlan(bridgeQuery, sourceHints, {
      supportingQuery: effectiveQuery,
    });
    const bridgeResults = await searchFts(
      config,
      bridgeQuery,
      candidateLimit,
      sourceHints,
      bridgePlan,
      fileIds,
    );
    if (bridgeResults.length) {
      groups.push({
        name: "semantic-bridge",
        weight: config.search?.semanticBridgeWeight ?? 0.45,
        results: bridgeResults,
      });
    }
  }

  const ftsResults = await searchFts(
    config,
    effectiveQuery,
    candidateLimit,
    sourceHints,
    plan,
    fileIds,
  );
  groups.push({ name: "keyword", weight: config.search?.keywordWeight ?? 1.1, results: ftsResults });

  const metadataResults = await searchMetadata(
    config,
    effectiveQuery,
    Math.min(candidateLimit, 120),
    sourceHints,
    plan,
    fileIds,
  );
  groups.push({ name: "metadata", weight: config.search?.metadataWeight ?? 0.8, results: metadataResults });

  const sourceResults = await searchSourceDeepScan(
    config,
    effectiveQuery,
    Math.min(candidateLimit, 80),
    sourceHints,
    plan,
    fileIds,
  );
  groups.push({ name: "source", weight: config.search?.sourceWeight ?? 1.2, results: sourceResults });

  options.rrfK = config.search?.rrfK ?? 60;
  let candidates = fuseRankedResults(groups, options);
  if (!candidates.length && sourceHints.length) {
    candidates = fuseRankedResults([
      { name: "source", weight: config.search?.sourceWeight ?? 1.2, results: sourceResults },
    ]);
  }

  const scored = applyHybridBonuses(candidates, effectiveQuery, sourceHints, plan, config, query).sort(
    (a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return String(a.result.path || "").localeCompare(
        String(b.result.path || ""),
      );
    },
  );
  const quoteScoped = split.hasQuotedScope
    ? scored.filter((item) => candidateMatchesQuoteScope(item, plan))
    : scored;
  const scopedScored = quoteScoped.length ? quoteScoped : scored;
  const conceptEvidence = plan.concepts.length
    ? scopedScored.filter(
        (item) =>
          resultHasStrongPrimaryContent(item.result, plan) &&
          resultHasExpansionContent(item.result, plan),
      )
    : [];
  const finalScored =
    conceptEvidence.length >= Math.min(3, limit) ? conceptEvidence : scopedScored;
  return diversifyResults(finalScored, limit, sourceHints, plan, config);
}

function trimToContextWithStats(results, maxContextChars) {
  const trimmed = [];
  let used = 0;
  for (const result of results) {
    const remaining = maxContextChars - used;
    if (remaining <= 0) break;

    let text = result.text;
    if (text.length > remaining) {
      if (remaining < 150) break;
      const cutIdx = text.lastIndexOf(" ", remaining - 4);
      const safeCut = cutIdx > 0 ? cutIdx : Math.max(0, remaining - 4);
      text = text.slice(0, safeCut).trimEnd() + " ...";
    }

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
  const context = `${modeInstruction} Respond as a careful academic researcher writing for scholars, professors, and advanced readers. Answer naturally and substantively: explain the evidence, distinguish main accounts from variants or notes, identify uncertainty, and teach the user what the passages imply. Do not give a skinny one-line extraction when the passages contain richer context. If the passages contain multiple relevant origins, causes, agents, parentages, locations, source traditions, or variant accounts, explain each distinction clearly. Every factual claim drawn from these passages must name its source inside the body of the answer, using prose attribution such as "According to Apolodoro's Biblioteca..." or "In Colin Wilson's The Outsider...". Do not write vague source-free claims like "there are accounts that say..." when a passage identifies the work or author. This attribution requirement is about naming the author/work/source in the sentence, not about hyperlinks. Keep the response concise but intellectually useful; avoid padding. Do not print passage numbers, bracket citations, local file paths, a "Source:" line, or a "Retrieved passages" section in your final answer. The app displays source files separately below the response.\n\n${passages}`;
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
  const modeName = String(requestOptions?.mode || "").toLowerCase();
  const modeKey = SEARCH_MODE_KEYS.includes(modeName) ? modeName : "ollama";
  const chatSettings = normalizeChatIntegration(
    {
      ...config.chatIntegration,
      ...(requestOptions || {}),
    },
    config.search,
  );
  chatSettings.strict = requestOptions?.strict === true;
  const requestForcesEnable = requestOptions?.enabled === true;
  if (!requestForcesEnable) {
    const modeSettings = config.chatModes?.[modeKey];
    const modeEnabled =
      modeSettings && typeof modeSettings === "object" && "enabled" in modeSettings
        ? modeSettings.enabled === true
        : config.chatIntegration.enabled === true;
    chatSettings.enabled = chatSettings.enabled && modeEnabled;
  }
  if (!chatSettings.enabled) {
    return { enabled: false, results: [], contextMessage: null };
  }
  const { retrievalQuery, userInstruction, hasQuotedScope } =
    splitQueryForRetrieval(query);
  const results = await searchLibrary(query, {
    config,
    mode: modeKey,
    limit: chatSettings.limit,
    sourceHints: requestOptions?.sourceHints,
    fileIds: requestOptions?.fileIds,
  });
  const payload = buildLibraryContextPayload(results, chatSettings);
  let contextText = payload.context;
  // When the user scoped retrieval with quotes, tell the LLM exactly which
  // part of the message was a search restriction and which part was the
  // instruction to act on the retrieved passages. This keeps the model
  // from re-treating the quoted span as the question.
  if (hasQuotedScope && contextText) {
    const instruction = userInstruction
      ? `The user typed a quoted search scope (${JSON.stringify(retrievalQuery)}) and an instruction outside the quotes: ${JSON.stringify(userInstruction)}. Use the retrieved passages only to satisfy that instruction. Do not answer the quoted text as if it were the question.`
      : `The user typed a quoted search scope (${JSON.stringify(retrievalQuery)}) without a separate instruction. Answer using the retrieved passages and treat the quoted text as the topic, not as a verbatim question.`;
    contextText = `${instruction}\n\n${contextText}`;
  }
  return {
    enabled: true,
    results,
    contextResults: payload.contextResults,
    contextMeta: payload.meta,
    contextMessage: contextText
      ? { role: "system", content: contextText }
      : null,
    retrievalQuery,
    userInstruction,
    hasQuotedScope,
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
      rrfK: config.search.rrfK,
      semanticWeight: config.search.semanticWeight,
      keywordWeight: config.search.keywordWeight,
      metadataWeight: config.search.metadataWeight,
      sourceWeight: config.search.sourceWeight,
      contentKeywordBonus: config.search.contentKeywordBonus,
      metadataKeywordBonus: config.search.metadataKeywordBonus,
      maxPassagesPerSource: config.search.maxPassagesPerSource,
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
      ready: false,
      readyCount: 0,
      missingCount: 0,
      vectorRows: 0,
      matchingRows: 0,
      expectedDimensions: 0,
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
    const expectedDimensions =
      Number(config.embedding.dimensions || 0) ||
      status.embedding.storedDimensions ||
      0;
    status.embedding.expectedDimensions = expectedDimensions;
    const dimensionFilter = expectedDimensions
      ? ` AND e.dimensions = ${sqlInteger(expectedDimensions)}`
      : "";
    const matchingRows = await runSqliteJson(
      config.databasePath,
      `SELECT COUNT(*) AS count
FROM library_embeddings e
JOIN library_chunks c ON c.id = e.chunk_id
WHERE e.model = ${sqlLiteral(config.embedding.model)}${dimensionFilter};`,
    );
    status.embedding.matchingRows = Number(matchingRows[0]?.count || 0);
    status.embedding.readyCount = status.embedding.matchingRows;
    const vectorConfigured = isVectorSearchConfigured(config);
    if (vectorConfigured) {
      try {
        const vectorRows = await runSqliteJson(
          config.databasePath,
          `SELECT COUNT(*) AS count FROM library_chunks_vec;`,
          { loadExtensionPath: config.embedding.sqliteVecExtensionPath },
        );
        status.embedding.vectorRows = Number(vectorRows[0]?.count || 0);
        status.embedding.readyCount = Math.min(
          status.embedding.readyCount,
          status.embedding.vectorRows,
        );
      } catch (vectorError) {
        status.embedding.vectorStatusError = vectorError.message;
        status.embedding.vectorRows = 0;
        status.embedding.readyCount = 0;
      }
    } else {
      status.embedding.readyCount = 0;
    }
    status.embedding.missingCount =
      config.embedding.enabled === true
        ? Math.max(
            0,
            status.chunks - (vectorConfigured ? status.embedding.readyCount : 0),
          )
        : 0;
    status.embedding.ready =
      config.embedding.enabled === true &&
      vectorConfigured &&
      status.chunks > 0 &&
      status.embedding.missingCount === 0;
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
  searchLibraryFiles,
  splitQueryForRetrieval,
  detectLanguageHint,
};
