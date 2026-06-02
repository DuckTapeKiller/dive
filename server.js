const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile, spawn, spawnSync } = require("child_process");
const os = require("os");
const { randomUUID, randomBytes } = require("crypto");
const { executeSkill, skillRequiresShellConfirmation } = require("./skills");
const { initMcpServers, getMcpOllamaTools, executeMcpTool } = require("./mcp");
const {
  buildChatLibraryContext,
  estimateLibraryIndex,
  getLibraryStatus,
  indexLibrary,
  loadLibraryConfig,
  saveLibraryConfig,
  saveLibraryChatSettings,
  searchLibrary,
} = require("./library/store");

const DEFAULT_PORT = 8080;
const PORT = Number.parseInt(process.env.PORT || String(DEFAULT_PORT), 10);
const MAX_CONVERSATIONS = 10;
const MAX_HISTORY_MESSAGES = 200; // max messages stored per conversation
const PI_SESSION_TIMEOUT_MS = 5 * 60 * 1000;
const PI_SESSION_SWEEP_INTERVAL_MS = 15 * 1000;
const MAX_JSON_PAYLOAD_SIZE = 2 * 1024 * 1024; // 2MB for JSON API requests
const MAX_UPLOAD_PAYLOAD_SIZE = 50 * 1024 * 1024; // 50MB for file uploads
const MAX_LOG_FILE_SIZE = 10 * 1024 * 1024; // 10MB per log file
const MAX_ROTATED_LOG_FILES = 3;
const PDFTOTEXT_TIMEOUT_MS = 15 * 1000;
const PDFTOTEXT_MAX_BUFFER = 10 * 1024 * 1024;

let activeLibraryIndexJob = null;
let lastLibraryIndexJob = null;

const DATA_DIR = path.join(os.homedir(), "ollama-pi-chat");
try {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
} catch (e) {
  console.error("Failed to create storage directory:", e);
}

// Prefer local index.html if it exists (for self-contained runs), fall back to storage directory
const INDEX = fs.existsSync(path.join(__dirname, "index.html"))
  ? path.join(__dirname, "index.html")
  : path.join(DATA_DIR, "index.html");

const EMBEDDED_ASSETS = new Map();
try {
  const sea = require("node:sea");
  if (sea.isSea()) {
    for (const assetName of [
      "index.html",
      "font_faces.css",
      "package.json",
      "vendor/marked.umd.js",
      "vendor/purify.min.js",
    ]) {
      try {
        EMBEDDED_ASSETS.set(assetName, sea.getAsset(assetName, "utf8"));
      } catch (_assetError) {}
    }
  }
} catch (e) {
  // SEA not available or not running as SEA
}
const EMBEDDED_INDEX = EMBEDDED_ASSETS.get("index.html") || null;

const HISTORY_FILE = path.join(DATA_DIR, "conversations.json");
const PROMPTS_FILE = path.join(DATA_DIR, "prompts.json");
const CUSTOM_SKILLS_FILE = path.join(DATA_DIR, "custom_skills.json");
const SKILLS_CONFIG_FILE = path.join(DATA_DIR, "skills_config.json");
const PI_SETTINGS_FILE = path.join(DATA_DIR, "pi-settings.json");
const UI_SETTINGS_FILE = path.join(DATA_DIR, "ui-settings.json");
const CLOUD_SETTINGS_FILE = path.join(DATA_DIR, "cloud-settings.json");
const NOTES_FILE = path.join(DATA_DIR, "notes.json");
const LIBRARY_INDEX_JOB_FILE = path.join(DATA_DIR, "library-index-job.json");
const FONT_FACES_FILE = path.join(__dirname, "font_faces.css");
const FONTS_DIR = path.join(__dirname, "fonts");
const VENDOR_SCRIPT_FILES = {
  "/vendor/marked.umd.js": {
    assetName: "vendor/marked.umd.js",
    resolveFilePath: () =>
      path.join(__dirname, "node_modules", "marked", "lib", "marked.umd.js"),
  },
  "/vendor/purify.min.js": {
    assetName: "vendor/purify.min.js",
    resolveFilePath: () =>
      path.join(__dirname, "node_modules", "dompurify", "dist", "purify.min.js"),
  },
};
const SECURITY_EVENTS_FILE = path.join(DATA_DIR, "security-events.jsonl");
const DAEMON_LOG_FILE = path.join(DATA_DIR, "daemon.log");
const DAEMON_ERROR_LOG_FILE = path.join(DATA_DIR, "daemon.error.log");
const LOG_ROTATION_STATE = new Map();
const ollamaToolRequests = new Map();
const PI_MIN_TIMEOUT_MS = 15 * 1000;
const PI_MAX_TIMEOUT_MS = 30 * 60 * 1000;
const PI_MIN_PERMISSION_TIMEOUT_MS = 0;
const PI_MAX_PERMISSION_TIMEOUT_MS = 10 * 60 * 1000;
const PI_MIN_TRACE_BUFFER_CHARS = 1000;
const PI_MAX_TRACE_BUFFER_CHARS = 50000;
const PI_DEFAULT_SERVER_PORT = 8080;
const PI_MIN_SERVER_PORT = 1024;
const PI_MAX_SERVER_PORT = 65535;
const COMMON_BINARY_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
];
const PI_COMMAND_CANDIDATES = ["/opt/homebrew/bin/pi", "/usr/local/bin/pi"];
const VALID_UI_PALETTES = new Set([
  "orange",
  "grey",
  "solarised",
  "forest",
  "calmblue",
  "retro",
  "nordic",
]);
const CLOUD_PROVIDERS = ["openai", "anthropic", "mistral"];
const CLOUD_PROVIDER_SET = new Set(CLOUD_PROVIDERS);
const CLOUD_DEFAULT_MODELS = {
  openai: "gpt-5",
  anthropic: "claude-sonnet-4-20250514",
  mistral: "mistral-large-latest",
};
const CLOUD_DEFAULT_BASE_URLS = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  mistral: "https://api.mistral.ai/v1",
};
const CLOUD_ENV_KEY_NAMES = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  mistral: "MISTRAL_API_KEY",
};
const CLOUD_MIN_MAX_TOKENS = 1;
const CLOUD_MAX_MAX_TOKENS = 128000;
const CLOUD_DEFAULT_MAX_TOKENS = 2048;

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function rotateFileIfNeeded(filePath, maxBytes = MAX_LOG_FILE_SIZE) {
  try {
    if (!fs.existsSync(filePath)) return;
    const { size } = fs.statSync(filePath);
    if (size <= maxBytes) return;

    for (let index = MAX_ROTATED_LOG_FILES; index >= 1; index -= 1) {
      const src = `${filePath}.${index}`;
      const dst = `${filePath}.${index + 1}`;
      if (fs.existsSync(dst)) fs.unlinkSync(dst);
      if (fs.existsSync(src)) fs.renameSync(src, dst);
    }

    if (fs.existsSync(`${filePath}.${MAX_ROTATED_LOG_FILES + 1}`)) {
      fs.unlinkSync(`${filePath}.${MAX_ROTATED_LOG_FILES + 1}`);
    }
    fs.renameSync(filePath, `${filePath}.1`);
    LOG_ROTATION_STATE.set(filePath, new Date().toISOString());
  } catch (e) {
    console.error("Failed to rotate log file:", filePath, e.message || e);
  }
}
// SV-15: Async write queue for appendFileWithRotation
const fileWriteQueues = new Map();

function appendFileWithRotation(filePath, content) {
  let queue = fileWriteQueues.get(filePath);
  if (!queue) {
    queue = Promise.resolve();
  }
  queue = queue.then(() => {
    return new Promise((resolve) => {
      try {
        rotateFileIfNeeded(filePath);
        fs.appendFile(filePath, content, (err) => {
          if (err) console.error("Async append error:", err);
          resolve();
        });
      } catch (e) {
        console.error("Sync pre-append error:", e);
        resolve();
      }
    });
  });
  fileWriteQueues.set(filePath, queue);
}

function getFileHealth(filePath) {
  const lastRotatedAt = LOG_ROTATION_STATE.get(filePath) || null;
  if (!fs.existsSync(filePath)) {
    return {
      exists: false,
      sizeBytes: 0,
      modifiedAt: null,
      lastRotatedAt,
    };
  }
  const stat = fs.statSync(filePath);
  return {
    exists: true,
    sizeBytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    lastRotatedAt,
  };
}

if (typeof process.getuid === "function" && process.getuid() === 0) {
  console.error(
    "Refusing to run ollama-pi-chat as root. Run as an unprivileged user.",
  );
  process.exit(1);
}

function appendSecurityEvent(event, details = {}) {
  try {
    const payload = {
      ts: new Date().toISOString(),
      event,
      ...details,
    };
    appendFileWithRotation(
      SECURITY_EVENTS_FILE,
      JSON.stringify(payload) + "\n",
    );
  } catch (e) {
    console.error("Failed to write security event:", e.message || e);
  }
}

rotateFileIfNeeded(SECURITY_EVENTS_FILE);
rotateFileIfNeeded(DAEMON_LOG_FILE);
rotateFileIfNeeded(DAEMON_ERROR_LOG_FILE);

function loadConversations() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
    }
  } catch (e) {
    console.warn("Failed to load conversations:", e.message || e);
  }
  return [];
}

// SV-16: Mutex for conversation history
let isSavingConversations = false;
let pendingSaveConversations = null;

function saveConversations(convs) {
  if (isSavingConversations) {
    pendingSaveConversations = convs;
    return;
  }
  isSavingConversations = true;
  fs.writeFile(HISTORY_FILE, JSON.stringify(convs, null, 2), (err) => {
    if (err) console.error("Failed to save conversations:", err);
    isSavingConversations = false;
    if (pendingSaveConversations) {
      const next = pendingSaveConversations;
      pendingSaveConversations = null;
      saveConversations(next);
    }
  });
}

function upsertConversation(
  saveConv,
  convTitle,
  message,
  messages,
  response,
  mode = "ollama",
) {
  const piSessionFile =
    mode === "pi" && saveConv && piConvProcesses.has(saveConv)
      ? piConvProcesses.get(saveConv).sessionFile
      : null;
  if (!saveConv) return;
  const convs = loadConversations();
  const newHistory = [...messages, { role: "assistant", content: response }];
  const title = convTitle || message.slice(0, 40);
  const existing = convs.findIndex((c) => c.id === saveConv);

  // Cap the size of the conversation history array
  if (newHistory.length > MAX_HISTORY_MESSAGES) {
    const spliceCount = newHistory.length - MAX_HISTORY_MESSAGES;
    newHistory.splice(0, spliceCount);
  }

  if (existing >= 0) {
    convs[existing].history = newHistory;
    convs[existing].updatedAt = Date.now();
    convs[existing].mode = mode;
    if (piSessionFile) convs[existing].piSessionFile = piSessionFile;
  } else {
    convs.unshift({
      piSessionFile,
      id: saveConv,
      title,
      mode,
      history: newHistory,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    if (convs.length > MAX_CONVERSATIONS) convs.splice(MAX_CONVERSATIONS);
  }
  saveConversations(convs);
}

function loadPrompts() {
  const RESERVED_PROMPT_IDS = new Set(["custom-assistant", "english-editor"]);

  const maybeNormalizePrompts = (prompts) => {
    if (!Array.isArray(prompts)) return [];
    const next = prompts
      .filter(
        (p) =>
          p &&
          typeof p.id === "string" &&
          typeof p.name === "string" &&
          typeof p.content === "string",
      )
      .filter((p) => !RESERVED_PROMPT_IDS.has(p.id))
      .map((p) => ({ ...p }));
    return next;
  };

  try {
    if (fs.existsSync(PROMPTS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(PROMPTS_FILE, "utf8"));
      const normalized = maybeNormalizePrompts(raw);
      if (Array.isArray(raw) && raw.length !== normalized.length) {
        savePrompts(normalized);
      }
      return normalized;
    }
  } catch (e) {
    console.warn("Failed to load prompts:", e.message || e);
  }

  savePrompts([]);
  return [];
}

function savePrompts(prompts) {
  try {
    fs.writeFileSync(PROMPTS_FILE, JSON.stringify(prompts, null, 2));
  } catch (e) {
    console.error("Failed to save prompts:", e);
  }
}

function loadCustomSkills() {
  try {
    if (fs.existsSync(CUSTOM_SKILLS_FILE)) {
      return JSON.parse(fs.readFileSync(CUSTOM_SKILLS_FILE, "utf8"));
    }
  } catch (e) {
    console.warn("Failed to load custom skills:", e.message || e);
  }
  return [];
}

function defaultSkillsConfig() {
  return {
    shell_command: false,
    wikipedia: true,
    britannica: true,
    wiktionary: true,
    deep_etymology: true,
    duckduckgo: true,
    web_scraper: true,
    calculator: true,
    time_and_date: true,
    fact_check: true,
    local_notes: true,
  };
}

function loadSkillsConfig() {
  try {
    if (fs.existsSync(SKILLS_CONFIG_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SKILLS_CONFIG_FILE, "utf8"));
      return { ...defaultSkillsConfig(), ...raw };
    }
  } catch (e) {
    console.warn("Failed to load skills config:", e.message || e);
  }
  return defaultSkillsConfig();
}

function saveSkillsConfig(cfg) {
  try {
    fs.writeFileSync(SKILLS_CONFIG_FILE, JSON.stringify(cfg, null, 2));
  } catch (e) {
    console.error("Failed to save skills config:", e.message || e);
  }
}

function saveCustomSkills(skills) {
  try {
    fs.writeFileSync(CUSTOM_SKILLS_FILE, JSON.stringify(skills, null, 2));
  } catch (e) {
    console.error("Failed to save custom skills:", e);
  }
}

function loadNotes() {
  try {
    if (fs.existsSync(NOTES_FILE)) {
      const raw = JSON.parse(fs.readFileSync(NOTES_FILE, "utf8"));
      const text = typeof raw.text === "string" ? raw.text : "";
      const updatedAt =
        typeof raw.updatedAt === "string" ? raw.updatedAt : null;
      return { text, updatedAt };
    }
  } catch (e) {
    console.error("Failed to read notes:", e.message || e);
  }
  return { text: "", updatedAt: null };
}

function saveNotes(text) {
  const entry = {
    text,
    updatedAt: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(NOTES_FILE, JSON.stringify(entry, null, 2));
  } catch (e) {
    console.error("Failed to save notes:", e.message || e);
    throw e;
  }
  return entry;
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function defaultPiSettings() {
  return {
    commandPath: "",
    workingDirectory: DATA_DIR,
    serverPort: PI_DEFAULT_SERVER_PORT,
    timeoutMs: PI_SESSION_TIMEOUT_MS,
    permissionPolicy: "normal",
    permissionUx: {
      autoOpen: true,
      defaultAction: "deny",
      decisionTimeoutMs: 45 * 1000,
    },
    toolOutputMaxChars: 12000,
    streamThinkingExpanded: false,
  };
}

function sanitizePiSettings(rawInput) {
  const defaults = defaultPiSettings();
  const raw =
    rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
      ? rawInput
      : {};

  const next = {
    ...defaults,
    permissionUx: { ...defaults.permissionUx },
  };

  if (typeof raw.commandPath === "string") {
    next.commandPath = raw.commandPath.trim().slice(0, 500);
  }

  if (typeof raw.workingDirectory === "string") {
    const trimmed = raw.workingDirectory.trim();
    if (trimmed) {
      const resolved = path.resolve(trimmed);
      try {
        if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
          next.workingDirectory = resolved;
        }
      } catch (e) {}
    }
  }

  next.serverPort = clampNumber(
    raw.serverPort,
    PI_MIN_SERVER_PORT,
    PI_MAX_SERVER_PORT,
    defaults.serverPort,
  );

  next.timeoutMs = clampNumber(
    raw.timeoutMs,
    PI_MIN_TIMEOUT_MS,
    PI_MAX_TIMEOUT_MS,
    defaults.timeoutMs,
  );

  if (raw.permissionPolicy === "strict" || raw.permissionPolicy === "normal") {
    next.permissionPolicy = raw.permissionPolicy;
  }

  if (
    raw.permissionUx &&
    typeof raw.permissionUx === "object" &&
    !Array.isArray(raw.permissionUx)
  ) {
    if (typeof raw.permissionUx.autoOpen === "boolean") {
      next.permissionUx.autoOpen = raw.permissionUx.autoOpen;
    }
    if (
      raw.permissionUx.defaultAction === "allow" ||
      raw.permissionUx.defaultAction === "deny"
    ) {
      next.permissionUx.defaultAction = raw.permissionUx.defaultAction;
    }
    next.permissionUx.decisionTimeoutMs = clampNumber(
      raw.permissionUx.decisionTimeoutMs,
      PI_MIN_PERMISSION_TIMEOUT_MS,
      PI_MAX_PERMISSION_TIMEOUT_MS,
      defaults.permissionUx.decisionTimeoutMs,
    );
  }

  next.toolOutputMaxChars = clampNumber(
    raw.toolOutputMaxChars,
    PI_MIN_TRACE_BUFFER_CHARS,
    PI_MAX_TRACE_BUFFER_CHARS,
    defaults.toolOutputMaxChars,
  );

  if (typeof raw.streamThinkingExpanded === "boolean") {
    next.streamThinkingExpanded = raw.streamThinkingExpanded;
  }

  if (next.permissionPolicy === "strict") {
    next.permissionUx.defaultAction = "deny";
    if (next.permissionUx.decisionTimeoutMs > 30 * 1000) {
      next.permissionUx.decisionTimeoutMs = 30 * 1000;
    }
  }

  return next;
}

function loadPiSettings() {
  try {
    if (fs.existsSync(PI_SETTINGS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(PI_SETTINGS_FILE, "utf8"));
      const sanitized = sanitizePiSettings(raw);
      if (JSON.stringify(raw) !== JSON.stringify(sanitized)) {
        savePiSettings(sanitized);
      }
      return sanitized;
    }
  } catch (e) {
    console.warn("Failed to load Pi settings:", e.message || e);
  }

  const defaults = defaultPiSettings();
  savePiSettings(defaults);
  return defaults;
}

function savePiSettings(settings) {
  try {
    const sanitized = sanitizePiSettings(settings);
    fs.writeFileSync(PI_SETTINGS_FILE, JSON.stringify(sanitized, null, 2));
  } catch (e) {
    console.error("Failed to save Pi settings:", e);
  }
}

function normalizeFontStackValue(fontStack) {
  const trimmed = typeof fontStack === "string" ? fontStack.trim() : "";
  return trimmed.slice(0, 300) || '"Space Mono", monospace';
}

function defaultUiSettings() {
  return {
    palettes: {
      ollama: "solarised",
      pi: "orange",
      cloud: "calmblue",
    },
    fonts: {
      ollama: '"Space Mono", monospace',
      pi: '"Space Mono", monospace',
      cloud: '"Space Mono", monospace',
    },
  };
}

function sanitizeUiSettings(rawInput) {
  const defaults = defaultUiSettings();
  const raw =
    rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
      ? rawInput
      : {};
  const next = {
    palettes: { ...defaults.palettes },
    fonts: { ...defaults.fonts },
  };

  if (
    raw.palettes &&
    typeof raw.palettes === "object" &&
    !Array.isArray(raw.palettes)
  ) {
    for (const modeName of ["ollama", "pi", "cloud"]) {
      if (VALID_UI_PALETTES.has(raw.palettes[modeName])) {
        next.palettes[modeName] = raw.palettes[modeName];
      }
    }
  }

  if (
    raw.fonts &&
    typeof raw.fonts === "object" &&
    !Array.isArray(raw.fonts)
  ) {
    for (const modeName of ["ollama", "pi", "cloud"]) {
      if (typeof raw.fonts[modeName] === "string") {
        next.fonts[modeName] = normalizeFontStackValue(raw.fonts[modeName]);
      }
    }
  }

  return next;
}

function loadUiSettingsWithMeta() {
  const exists = fs.existsSync(UI_SETTINGS_FILE);
  if (exists) {
    try {
      const raw = JSON.parse(fs.readFileSync(UI_SETTINGS_FILE, "utf8"));
      const sanitized = sanitizeUiSettings(raw);
      if (JSON.stringify(raw) !== JSON.stringify(sanitized)) {
        saveUiSettings(sanitized);
      }
      return { settings: sanitized, exists: true };
    } catch (e) {
      console.warn("Failed to load UI settings:", e.message || e);
    }
  }
  return { settings: defaultUiSettings(), exists: false };
}

function saveUiSettings(settings) {
  try {
    const sanitized = sanitizeUiSettings(settings);
    fs.writeFileSync(UI_SETTINGS_FILE, JSON.stringify(sanitized, null, 2));
    return sanitized;
  } catch (e) {
    console.error("Failed to save UI settings:", e.message || e);
    throw e;
  }
}

function defaultCloudSettings() {
  return {
    provider: "openai",
    models: { ...CLOUD_DEFAULT_MODELS },
    baseUrls: { ...CLOUD_DEFAULT_BASE_URLS },
    apiKeys: {},
    maxTokens: CLOUD_DEFAULT_MAX_TOKENS,
  };
}

function normalizeCloudBaseUrl(value, fallback) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return fallback;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return fallback;
    }
    return parsed.toString().replace(/\/+$/, "");
  } catch (e) {
    return fallback;
  }
}

function sanitizeCloudSettings(rawInput, existingInput = null) {
  const defaults = defaultCloudSettings();
  const existing =
    existingInput &&
    typeof existingInput === "object" &&
    !Array.isArray(existingInput)
      ? existingInput
      : {};
  const raw =
    rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
      ? rawInput
      : {};

  const next = {
    provider: CLOUD_PROVIDER_SET.has(existing.provider)
      ? existing.provider
      : defaults.provider,
    models: { ...defaults.models, ...(existing.models || {}) },
    baseUrls: { ...defaults.baseUrls, ...(existing.baseUrls || {}) },
    apiKeys: { ...(existing.apiKeys || {}) },
    maxTokens: clampNumber(
      existing.maxTokens,
      CLOUD_MIN_MAX_TOKENS,
      CLOUD_MAX_MAX_TOKENS,
      defaults.maxTokens,
    ),
  };

  if (CLOUD_PROVIDER_SET.has(raw.provider)) {
    next.provider = raw.provider;
  }

  if (
    raw.models &&
    typeof raw.models === "object" &&
    !Array.isArray(raw.models)
  ) {
    for (const provider of CLOUD_PROVIDERS) {
      if (typeof raw.models[provider] === "string") {
        const model = raw.models[provider].trim().slice(0, 200);
        if (model) next.models[provider] = model;
      }
    }
  }

  if (
    raw.baseUrls &&
    typeof raw.baseUrls === "object" &&
    !Array.isArray(raw.baseUrls)
  ) {
    for (const provider of CLOUD_PROVIDERS) {
      next.baseUrls[provider] = normalizeCloudBaseUrl(
        raw.baseUrls[provider],
        next.baseUrls[provider] || defaults.baseUrls[provider],
      );
    }
  }

  if (
    raw.apiKeys &&
    typeof raw.apiKeys === "object" &&
    !Array.isArray(raw.apiKeys)
  ) {
    for (const provider of CLOUD_PROVIDERS) {
      if (typeof raw.apiKeys[provider] !== "string") continue;
      const value = raw.apiKeys[provider].trim();
      if (value) {
        next.apiKeys[provider] = value.slice(0, 4000);
      }
    }
  }

  if (
    raw.clearApiKeys &&
    typeof raw.clearApiKeys === "object" &&
    !Array.isArray(raw.clearApiKeys)
  ) {
    for (const provider of CLOUD_PROVIDERS) {
      if (raw.clearApiKeys[provider] === true) {
        delete next.apiKeys[provider];
      }
    }
  }

  next.maxTokens = clampNumber(
    raw.maxTokens,
    CLOUD_MIN_MAX_TOKENS,
    CLOUD_MAX_MAX_TOKENS,
    next.maxTokens,
  );

  return next;
}

function saveCloudSettings(settings) {
  const sanitized = sanitizeCloudSettings(settings, defaultCloudSettings());
  fs.writeFileSync(CLOUD_SETTINGS_FILE, JSON.stringify(sanitized, null, 2), {
    mode: 0o600,
  });
  try {
    fs.chmodSync(CLOUD_SETTINGS_FILE, 0o600);
  } catch (e) {}
  return sanitized;
}

function loadCloudSettings() {
  if (fs.existsSync(CLOUD_SETTINGS_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(CLOUD_SETTINGS_FILE, "utf8"));
      const sanitized = sanitizeCloudSettings(raw, defaultCloudSettings());
      if (JSON.stringify(raw) !== JSON.stringify(sanitized)) {
        saveCloudSettings(sanitized);
      }
      return sanitized;
    } catch (e) {
      console.warn("Failed to load Cloud settings:", e.message || e);
    }
  }
  return defaultCloudSettings();
}

function getCloudApiKey(settings, provider) {
  const envKeyName = CLOUD_ENV_KEY_NAMES[provider];
  const envValue = envKeyName ? process.env[envKeyName] : "";
  if (typeof settings.apiKeys?.[provider] === "string") {
    const saved = settings.apiKeys[provider].trim();
    if (saved) return saved;
  }
  return typeof envValue === "string" ? envValue.trim() : "";
}

function redactCloudSettings(settings) {
  const sanitized = sanitizeCloudSettings(settings, defaultCloudSettings());
  return {
    provider: sanitized.provider,
    models: sanitized.models,
    baseUrls: sanitized.baseUrls,
    maxTokens: sanitized.maxTokens,
    hasApiKey: Object.fromEntries(
      CLOUD_PROVIDERS.map((provider) => [
        provider,
        Boolean(getCloudApiKey(sanitized, provider)),
      ]),
    ),
    envKeyNames: { ...CLOUD_ENV_KEY_NAMES },
  };
}

function getPiRuntimeInfo(settings = loadPiSettings()) {
  const resolvedWorkingDirectory = settings.workingDirectory || DATA_DIR;
  const globalSandbox = path.join(os.homedir(), ".pi", "sandbox.json");
  const projectSandbox = path.join(
    resolvedWorkingDirectory,
    ".pi",
    "sandbox.json",
  );
  const configuredCommand =
    typeof settings.commandPath === "string" && settings.commandPath.trim()
      ? settings.commandPath.trim()
      : null;
  const autoDetectedCommand = getPiCommand();
  const resolvedCommand = configuredCommand || autoDetectedCommand;

  return {
    dataDir: DATA_DIR,
    projectDir: __dirname,
    configuredServerPort: settings.serverPort || PI_DEFAULT_SERVER_PORT,
    activeServerPort: PORT,
    configuredCommand,
    autoDetectedCommand,
    resolvedCommand,
    resolvedWorkingDirectory,
    sandbox: {
      globalPath: globalSandbox,
      globalEnabled: fs.existsSync(globalSandbox),
      projectPath: projectSandbox,
      projectEnabled: fs.existsSync(projectSandbox),
    },
  };
}

function parseMultipart(buffer, boundary) {
  const parts = [];
  const sep = Buffer.from("--" + boundary);
  let start = 0;
  while (true) {
    const idx = buffer.indexOf(sep, start);
    if (idx === -1) break;
    const next = buffer.indexOf(sep, idx + sep.length);
    if (next === -1) break;

    // Detect line ending style: check bytes right after the boundary
    const afterSep = idx + sep.length;
    let lineEndLen = 0;
    if (buffer[afterSep] === 0x0d && buffer[afterSep + 1] === 0x0a) {
      lineEndLen = 2; // \r\n
    } else if (buffer[afterSep] === 0x0a) {
      lineEndLen = 1; // \n
    } else {
      start = next;
      continue;
    }

    // Trim trailing line ending before next boundary
    let partEnd = next;
    if (
      partEnd >= 2 &&
      buffer[partEnd - 2] === 0x0d &&
      buffer[partEnd - 1] === 0x0a
    ) {
      partEnd -= 2;
    } else if (partEnd >= 1 && buffer[partEnd - 1] === 0x0a) {
      partEnd -= 1;
    }

    const part = buffer.slice(afterSep + lineEndLen, partEnd);

    // Support both \r\n\r\n and \n\n as header/body separator
    let headerEnd = part.indexOf("\r\n\r\n");
    let headerSepLen = 4;
    if (headerEnd === -1) {
      headerEnd = part.indexOf("\n\n");
      headerSepLen = 2;
    }
    if (headerEnd === -1) {
      start = next;
      continue;
    }
    const headers = part.slice(0, headerEnd).toString();
    const body = part.slice(headerEnd + headerSepLen);
    const nameMatch = headers.match(/name="([^"]+)"/);
    const filenameMatch = headers.match(/filename="([^"]+)"/);
    parts.push({ name: nameMatch?.[1], filename: filenameMatch?.[1], body });
    start = next;
  }
  return parts;
}

function readBody(req, maxPayloadSize = MAX_JSON_PAYLOAD_SIZE) {
  return new Promise((resolve, reject) => {
    const lengthHeader = req.headers["content-length"];
    const declaredLength = Number.parseInt(
      Array.isArray(lengthHeader) ? lengthHeader[0] : lengthHeader || "0",
      10,
    );
    if (Number.isFinite(declaredLength) && declaredLength > maxPayloadSize) {
      reject(
        createHttpError(
          413,
          `Payload too large. Maximum size is ${Math.floor(maxPayloadSize / 1024 / 1024)}MB.`,
        ),
      );
      return;
    }

    const chunks = [];
    let totalLength = 0;
    let settled = false;

    req.on("data", (c) => {
      if (settled) return;
      totalLength += c.length;
      if (totalLength > maxPayloadSize) {
        settled = true;
        req.destroy();
        reject(
          createHttpError(
            413,
            `Payload too large. Maximum size is ${Math.floor(maxPayloadSize / 1024 / 1024)}MB.`,
          ),
        );
      } else {
        chunks.push(c);
      }
    });

    req.on("end", () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks));
      }
    });
    req.on("error", (e) => {
      if (!settled) {
        settled = true;
        reject(e);
      }
    });
  });
}

async function parseJsonBody(req, maxPayloadSize = MAX_JSON_PAYLOAD_SIZE) {
  const bodyBuffer = await readBody(req, maxPayloadSize);
  try {
    return JSON.parse(bodyBuffer.toString("utf8"));
  } catch (_error) {
    throw createHttpError(400, "Invalid JSON payload.");
  }
}

function normalizeCloudHistoryMessages(history, message) {
  const messages = [];
  const sourceHistory = Array.isArray(history) ? history : [];
  for (const item of sourceHistory) {
    if (!item || typeof item !== "object") continue;
    if (item.role !== "user" && item.role !== "assistant") continue;
    if (typeof item.content !== "string" || !item.content.trim()) continue;
    messages.push({
      role: item.role,
      content: item.content,
    });
  }
  messages.push({ role: "user", content: message });
  if (messages.length > MAX_HISTORY_MESSAGES) {
    return messages.slice(messages.length - MAX_HISTORY_MESSAGES);
  }
  return messages;
}

function buildCloudEndpoint(baseUrl, pathSuffix) {
  const normalized = String(baseUrl || "").replace(/\/+$/, "");
  return `${normalized}${pathSuffix}`;
}

function buildCloudRequest(provider, settings, messages) {
  const model = settings.models?.[provider] || CLOUD_DEFAULT_MODELS[provider];
  const baseUrl =
    settings.baseUrls?.[provider] || CLOUD_DEFAULT_BASE_URLS[provider];
  const maxTokens = clampNumber(
    settings.maxTokens,
    CLOUD_MIN_MAX_TOKENS,
    CLOUD_MAX_MAX_TOKENS,
    CLOUD_DEFAULT_MAX_TOKENS,
  );
  const apiKey = getCloudApiKey(settings, provider);
  if (!apiKey) {
    throw createHttpError(
      400,
      `Missing ${provider} API key. Add it in Cloud settings or set ${CLOUD_ENV_KEY_NAMES[provider]}.`,
    );
  }

  if (provider === "anthropic") {
    return {
      url: buildCloudEndpoint(baseUrl, "/messages"),
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: {
        model,
        max_tokens: maxTokens,
        messages,
        stream: true,
      },
    };
  }

  const body = {
    model,
    messages,
    stream: true,
  };
  if (provider === "openai") {
    body.stream_options = { include_usage: true };
  }

  return {
    url: buildCloudEndpoint(baseUrl, "/chat/completions"),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body,
  };
}

function normalizeUsage(provider, usage) {
  if (!usage || typeof usage !== "object") return null;
  if (provider === "anthropic") {
    const input =
      typeof usage.input_tokens === "number" ? usage.input_tokens : null;
    const output =
      typeof usage.output_tokens === "number" ? usage.output_tokens : null;
    return {
      input,
      output,
      total:
        typeof input === "number" && typeof output === "number"
          ? input + output
          : null,
    };
  }
  const input =
    typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : null;
  const output =
    typeof usage.completion_tokens === "number"
      ? usage.completion_tokens
      : null;
  const total =
    typeof usage.total_tokens === "number"
      ? usage.total_tokens
      : typeof input === "number" && typeof output === "number"
        ? input + output
        : null;
  return { input, output, total };
}

function createSseParser(onEvent) {
  let buffer = "";
  return {
    push(chunk) {
      buffer += Buffer.from(chunk).toString("utf8");
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() || "";

      for (const rawEvent of events) {
        const dataLines = [];
        let eventName = "";
        for (const rawLine of rawEvent.split(/\r?\n/)) {
          const line = rawLine.trimEnd();
          if (!line || line.startsWith(":")) continue;
          if (line.startsWith("event:")) {
            eventName = line.slice("event:".length).trim();
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice("data:".length).trimStart());
          }
        }
        const data = dataLines.join("\n");
        if (data) onEvent(eventName, data);
      }
    },
    flush() {
      if (!buffer.trim()) return;
      const pending = buffer;
      buffer = "";
      const dataLines = [];
      let eventName = "";
      for (const rawLine of pending.split(/\r?\n/)) {
        const line = rawLine.trimEnd();
        if (!line || line.startsWith(":")) continue;
        if (line.startsWith("event:")) {
          eventName = line.slice("event:".length).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice("data:".length).trimStart());
        }
      }
      const data = dataLines.join("\n");
      if (data) onEvent(eventName, data);
    },
  };
}

async function streamCloudCompletion({
  provider,
  settings,
  messages,
  signal,
  onDelta,
  onUsage,
}) {
  const request = buildCloudRequest(provider, settings, messages);
  const upstreamRes = await fetch(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(request.body),
    signal,
  });

  if (!upstreamRes.ok) {
    const raw = await upstreamRes.text().catch(() => "");
    throw createHttpError(
      upstreamRes.status,
      `Cloud provider request failed (${upstreamRes.status}): ${(raw || upstreamRes.statusText || "empty response body").slice(0, 700)}`,
    );
  }
  if (!upstreamRes.body) {
    throw createHttpError(502, "Cloud provider returned no stream body.");
  }

  let latestUsage = null;
  const parser = createSseParser((_eventName, data) => {
    if (data === "[DONE]") return;
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch (e) {
      return;
    }

    if (parsed?.type === "error" || parsed?.error) {
      const message =
        parsed.error?.message ||
        parsed.message ||
        "Cloud provider stream error.";
      throw createHttpError(502, message);
    }

    if (provider === "anthropic") {
      if (parsed.type === "message_start" && parsed.message?.usage) {
        latestUsage = normalizeUsage(provider, parsed.message.usage);
        if (latestUsage && typeof onUsage === "function") onUsage(latestUsage);
      }
      if (parsed.type === "message_delta" && parsed.usage) {
        latestUsage = {
          ...(latestUsage || {}),
          ...normalizeUsage(provider, parsed.usage),
        };
        if (latestUsage && typeof onUsage === "function") onUsage(latestUsage);
      }
      const textDelta =
        parsed.type === "content_block_delta" &&
        parsed.delta?.type === "text_delta" &&
        typeof parsed.delta.text === "string"
          ? parsed.delta.text
          : "";
      if (textDelta && typeof onDelta === "function") {
        onDelta(textDelta);
      }
      return;
    }

    if (parsed.usage) {
      latestUsage = normalizeUsage(provider, parsed.usage);
      if (latestUsage && typeof onUsage === "function") onUsage(latestUsage);
    }
    const delta = parsed.choices?.[0]?.delta?.content;
    if (typeof delta === "string" && delta && typeof onDelta === "function") {
      onDelta(delta);
    }
  });

  const reader = upstreamRes.body.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    parser.push(value);
  }
  parser.flush();

  return latestUsage;
}

// clampOllamaNumber and clampOllamaInteger are kept as thin wrappers for
// call-site compatibility. They differ from clampNumber in that they do not
// round to integer (Number) vs parseInt respectively.
function clampOllamaNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function clampOllamaInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

// Default context window used when the client sends no num_ctx value.
// This is only a fallback — if the user sets NUM CTX in Settings that value
// is sent by the frontend and passes through the clamp unchanged.
const OLLAMA_DEFAULT_CTX = 32768;

function sanitizeOllamaOptions(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const options = {
    temperature: clampOllamaNumber(raw.temperature, 0.3, 0, 2),
    top_p: clampOllamaNumber(raw.top_p, 0.6, 0, 1),
    top_k: clampOllamaInteger(raw.top_k, 20, 1, 1000),
    repeat_penalty: clampOllamaNumber(raw.repeat_penalty, 1.15, 0, 2),
    repeat_last_n: clampOllamaInteger(raw.repeat_last_n, 128, -1, 131072),
    num_predict: clampOllamaInteger(raw.num_predict, 320, -1, 200000),
    num_ctx: clampOllamaInteger(raw.num_ctx, OLLAMA_DEFAULT_CTX, 256, 131072),
    seed: clampOllamaInteger(raw.seed, 42, -2147483648, 2147483647),
  };
  if (Array.isArray(raw.stop)) {
    const stop = raw.stop
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean)
      .slice(0, 16);
    if (stop.length) options.stop = stop;
  }
  return options;
}

function ollamaChat(model, messages, options, tools = null) {
  let clientReq = null;
  const promise = new Promise((resolve, reject) => {
    const payloadObject = { model, messages, stream: false };
    if (options && typeof options === "object") {
      payloadObject.options = options;
    }

    const mcpTools = getMcpOllamaTools();
    let finalTools = tools ? [...tools] : [];
    if (mcpTools.length > 0) {
      finalTools = [...finalTools, ...mcpTools];
    }

    if (finalTools.length > 0) {
      payloadObject.tools = finalTools;
    }

    const payload = JSON.stringify(payloadObject);
    const opts = {
      hostname: "localhost",
      port: 11434,
      path: "/api/chat",
      method: "POST",
      headers: { "Content-Type": "application/json" },
    };
    clientReq = http.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data).message);
        } catch (e) {
          reject(new Error("Ollama parse error: " + data));
        }
      });
    });
    clientReq.on("error", reject);
    clientReq.write(payload);
    clientReq.end();
  });
  return {
    promise,
    abort: () => {
      if (clientReq) {
        clientReq.destroy();
      }
    },
  };
}

function getModels() {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "localhost",
      port: 11434,
      path: "/api/tags",
      method: "GET",
    };
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data).models.map((m) => m.name));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function publicLibraryIndexJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    force: job.force,
    prune: job.prune,
    compact: job.compact,
    cancelRequested: job.cancelRequested === true,
    pauseRequested: job.pauseRequested === true,
    autoResumed: job.autoResumed === true,
    startedAt: job.startedAt,
    resumedAt: job.resumedAt || null,
    finishedAt: job.finishedAt || null,
    progress: job.progress || null,
    stats: job.stats || null,
    error: job.error || null,
  };
}

function readLibraryIndexJobFile() {
  try {
    if (!fs.existsSync(LIBRARY_INDEX_JOB_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(LIBRARY_INDEX_JOB_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (error) {
    console.error("Could not read library index job state:", error.message);
    return null;
  }
}

function persistLibraryIndexJob(job) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${LIBRARY_INDEX_JOB_FILE}.tmp`;
    fs.writeFileSync(
      tmp,
      JSON.stringify(publicLibraryIndexJob(job), null, 2),
      "utf8",
    );
    fs.renameSync(tmp, LIBRARY_INDEX_JOB_FILE);
  } catch (error) {
    console.error("Could not persist library index job state:", error.message);
  }
}

function persistedJobStartFileIndex(job) {
  const progress = job?.progress || {};
  const embeddingErrors = Number(progress.embeddingErrors || 0);
  const fileErrors = Number(progress.errors || 0);
  if (embeddingErrors > 0 || fileErrors > 0) return 0;
  const processed = Number(job?.progress?.processed || 0);
  return Number.isFinite(processed) && processed > 0 ? Math.floor(processed) : 0;
}

function startLibraryIndexJob(options = {}) {
  if (activeLibraryIndexJob) {
    const error = new Error("A library index job is already running.");
    error.statusCode = 409;
    throw error;
  }
  const resumeProgress =
    options.resumeProgress && typeof options.resumeProgress === "object"
      ? options.resumeProgress
      : null;
  const startFileIndex = Math.max(
    0,
    Number.isFinite(Number(options.startFileIndex))
      ? Math.floor(Number(options.startFileIndex))
      : 0,
  );
  const job = {
    id: options.id || randomUUID(),
    status: "running",
    force: options.force === true,
    prune: options.prune !== false,
    compact: options.compact !== false,
    cancelRequested: false,
    pauseRequested: false,
    autoResumed: options.autoResume === true,
    startedAt: options.startedAt || new Date().toISOString(),
    resumedAt: options.autoResume === true ? new Date().toISOString() : null,
    finishedAt: null,
    progress: resumeProgress,
    stats: null,
    error: null,
  };
  activeLibraryIndexJob = job;
  lastLibraryIndexJob = job;
  persistLibraryIndexJob(job);
  indexLibrary({
    force: job.force,
    prune: job.prune,
    compact: job.compact,
    startFileIndex,
    resumeProgress: startFileIndex > 0 ? resumeProgress : null,
    onProgress: (progress) => {
      job.progress = progress;
      persistLibraryIndexJob(job);
    },
    shouldCancel: () => job.cancelRequested === true,
  })
    .then((stats) => {
      job.status = "completed";
      job.stats = stats;
      job.progress = {
        ...(job.progress || {}),
        phase: "completed",
        percent: 100,
      };
      persistLibraryIndexJob(job);
    })
    .catch((error) => {
      if (error?.cancelled) {
        job.status = job.pauseRequested ? "paused" : "cancelled";
        job.error = null;
        job.progress = {
          ...(job.progress || {}),
          phase: job.pauseRequested ? "paused" : "cancelled",
        };
      } else {
        job.status = "failed";
        job.error = error.stack || error.message || String(error);
      }
      persistLibraryIndexJob(job);
    })
    .finally(() => {
      job.finishedAt = new Date().toISOString();
      activeLibraryIndexJob = null;
      persistLibraryIndexJob(job);
    });
  return job;
}

function pauseLibraryIndexJob() {
  if (!activeLibraryIndexJob) return null;
  activeLibraryIndexJob.pauseRequested = true;
  activeLibraryIndexJob.cancelRequested = true;
  activeLibraryIndexJob.progress = {
    ...(activeLibraryIndexJob.progress || {}),
    phase: "pausing",
  };
  persistLibraryIndexJob(activeLibraryIndexJob);
  return activeLibraryIndexJob;
}

function resumePersistedLibraryIndexJob() {
  const persisted = readLibraryIndexJobFile();
  if (!persisted) return;
  lastLibraryIndexJob = persisted;
  if (
    persisted.status !== "running" ||
    persisted.cancelRequested === true ||
    persisted.pauseRequested === true
  ) {
    return;
  }
  const startFileIndex = persistedJobStartFileIndex(persisted);
  try {
    startLibraryIndexJob({
      id: persisted.id || randomUUID(),
      startedAt: persisted.startedAt || null,
      force: persisted.force === true,
      prune: persisted.prune !== false,
      compact: persisted.compact !== false,
      autoResume: true,
      resumeProgress: startFileIndex > 0 ? persisted.progress || null : null,
      startFileIndex,
    });
  } catch (error) {
    persisted.status = "failed";
    persisted.error = `Auto-resume failed: ${error.message}`;
    persisted.finishedAt = new Date().toISOString();
    lastLibraryIndexJob = persisted;
    persistLibraryIndexJob(persisted);
  }
}

function buildExecutablePath(basePath = "") {
  const baseEntries = String(basePath)
    .split(":")
    .map((item) => item.trim())
    .filter(Boolean);
  const merged = [...baseEntries, ...COMMON_BINARY_DIRS];
  return Array.from(new Set(merged)).join(":");
}

function isExecutableFile(filePath) {
  if (!filePath || typeof filePath !== "string") return false;
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch (_error) {
    return false;
  }
}

function getPiCommand() {
  for (const candidate of PI_COMMAND_CANDIDATES) {
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }

  try {
    const lookup = spawnSync("/usr/bin/env", ["which", "pi"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: buildExecutablePath(process.env.PATH || ""),
      },
    });
    if (lookup.status === 0) {
      const found = (lookup.stdout || "").trim();
      if (found) return found;
    }
  } catch (_error) {}
  return "pi"; // Fallback to PATH
}

const PI_DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
const piRpcSessions = new Map();

function createPiSessionId() {
  return `pi_${randomUUID()}`;
}

function buildPiEnv() {
  const env = { ...process.env };
  env.PATH = buildExecutablePath(env.PATH || "");
  return env;
}

function notifyPiSession(session) {
  const waiters = session.waiters.splice(0);
  waiters.forEach((resolve) => resolve());
}

function emitPiSessionEvent(session, event) {
  if (!session || !session.streamListeners || !event) return;
  for (const listener of session.streamListeners) {
    try {
      listener(event);
    } catch (e) {}
  }
}

function clampText(value, maxLength = 1000) {
  const text = typeof value === "string" ? value : String(value ?? "");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}…`;
}

function extractToolTextPayload(payload) {
  if (!payload || !Array.isArray(payload.content)) return "";
  const parts = payload.content
    .filter(
      (item) => item && item.type === "text" && typeof item.text === "string",
    )
    .map((item) => item.text);
  return parts.join("\n");
}

function addPiSessionListener(session, listener) {
  if (!session || typeof listener !== "function") {
    return () => {};
  }
  session.streamListeners.add(listener);
  return () => {
    session.streamListeners.delete(listener);
  };
}

function isPiDialogRequest(evt) {
  return (
    evt?.type === "extension_ui_request" && PI_DIALOG_METHODS.has(evt.method)
  );
}

function formatPiUiRequest(evt) {
  return {
    id: evt.id,
    method: evt.method,
    title: evt.title || "",
    message: evt.message || "",
    options: Array.isArray(evt.options) ? evt.options : [],
    placeholder: evt.placeholder || "",
    prefill: evt.prefill || "",
    timeout: typeof evt.timeout === "number" ? evt.timeout : undefined,
  };
}

const piConvProcesses = new Map();
// convId -> { proc, buffer, stderrData, closed, lastActivityAt, settings, sessionFile, activeRequestId, pendingStatsResolver, pendingStateResolver }

function cleanupPiSession(sessionId, reason = "session_closed") {
  const session = piRpcSessions.get(sessionId);
  if (!session) return;

  if (!session.done && !session.error) {
    session.error = new Error(reason);
  }
  notifyPiSession(session);
  piRpcSessions.delete(sessionId);

  appendSecurityEvent("pi_session_cleanup", {
    sessionId,
    reason,
    source: session.source || null,
    pendingDialogMethod: session.pendingDialog?.method || null,
  });
}

function getOrCreatePiConvProcess(convId, piSettings = null) {
  if (piConvProcesses.has(convId)) {
    const existing = piConvProcesses.get(convId);
    if (!existing.closed) {
      existing.lastActivityAt = Date.now();
      return existing;
    }
    piConvProcesses.delete(convId);
  }

  // Cap number of running Pi processes
  const MAX_PI_CONV_PROCESSES = 20;
  if (piConvProcesses.size >= MAX_PI_CONV_PROCESSES) {
    let oldest = null,
      oldestTime = Infinity;
    for (const [id, proc] of piConvProcesses.entries()) {
      if (proc.closed) {
        piConvProcesses.delete(id);
        break; // we just need to free up one slot
      }
      if (proc.lastActivityAt < oldestTime) {
        oldest = id;
        oldestTime = proc.lastActivityAt;
      }
    }
    if (piConvProcesses.size >= MAX_PI_CONV_PROCESSES && oldest) {
      try {
        piConvProcesses.get(oldest).proc.kill();
      } catch (_) {}
      piConvProcesses.delete(oldest);
    }
  }

  const settings = sanitizePiSettings(piSettings || loadPiSettings());
  const configuredCommand =
    typeof settings.commandPath === "string" ? settings.commandPath.trim() : "";
  const cmd = configuredCommand || getPiCommand();
  const proc = spawn(cmd, ["--mode", "rpc"], {
    cwd: settings.workingDirectory || DATA_DIR,
    env: buildPiEnv(),
  });

  const convProc = {
    proc,
    buffer: "",
    stderrData: "",
    closed: false,
    lastActivityAt: Date.now(),
    settings,
    sessionFile: null,
    activeRequestId: null,
    pendingStatsResolver: null,
    pendingStateResolver: null,
  };

  piConvProcesses.set(convId, convProc);

  proc.stdout.on("data", (chunk) => {
    convProc.buffer += chunk.toString();
    const lines = convProc.buffer.split("\n");
    convProc.buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      let evt;
      try {
        evt = JSON.parse(line);
      } catch (e) {
        continue;
      }

      convProc.lastActivityAt = Date.now();

      if (evt.type === "response" && evt.command === "get_state") {
        const stateData = evt.data || evt;
        convProc.sessionFile = stateData.sessionFile || convProc.sessionFile;
        if (convProc.pendingStateResolver) {
          const resolveState = convProc.pendingStateResolver;
          convProc.pendingStateResolver = null;
          resolveState(stateData);
        }
        continue;
      }

      if (
        (evt.type === "response" && evt.command === "get_session_stats") ||
        evt.type === "session_stats" ||
        evt.type === "get_session_stats_response" ||
        evt.contextUsage
      ) {
        const statsData = evt.data || evt;
        if (convProc.pendingStatsResolver && statsData.contextUsage) {
          const resolveStats = convProc.pendingStatsResolver;
          convProc.pendingStatsResolver = null;
          resolveStats(statsData);
        }
        continue;
      }

      if (!convProc.activeRequestId) continue;
      const session = piRpcSessions.get(convProc.activeRequestId);
      if (!session) continue;

      session.lastActivityAt = Date.now();

      if (evt.type === "compaction_start") {
        emitPiSessionEvent(session, {
          type: "compaction_start",
          reason: evt.reason || null,
          sessionId: session.id,
        });
        continue;
      }

      if (evt.type === "compaction_end") {
        emitPiSessionEvent(session, {
          type: "compaction_end",
          reason: evt.reason || null,
          tokensBefore: evt.result?.tokensBefore || null,
          sessionId: session.id,
        });
        continue;
      }

      if (evt.type === "message_update") {
        const delta = evt.assistantMessageEvent;
        if (delta?.type === "thinking_start") {
          emitPiSessionEvent(session, {
            type: "thinking_start",
            sessionId: session.id,
          });
          continue;
        }
        if (delta?.type === "thinking_delta") {
          const chunk = typeof delta.delta === "string" ? delta.delta : "";
          if (chunk) session.thinking += chunk;
          emitPiSessionEvent(session, {
            type: "thinking_delta",
            delta: chunk,
            thinking: session.thinking,
            sessionId: session.id,
          });
          continue;
        }
        if (delta?.type === "thinking_end") {
          emitPiSessionEvent(session, {
            type: "thinking_end",
            thinking: session.thinking,
            sessionId: session.id,
          });
          continue;
        }
        if (delta?.type === "text_delta") {
          session.response += delta.delta;
          emitPiSessionEvent(session, {
            type: "delta",
            delta: delta.delta,
            response: session.response,
            sessionId: session.id,
          });
        }
        continue;
      }

      if (evt.type === "tool_execution_start") {
        emitPiSessionEvent(session, {
          type: "tool_start",
          sessionId: session.id,
          toolName: evt.toolName || null,
          toolCallId: evt.toolCallId || null,
          argsPreview: clampText(JSON.stringify(evt.args || {}), 400),
        });
        continue;
      }

      if (evt.type === "tool_execution_update") {
        const output = extractToolTextPayload(evt.partialResult);
        emitPiSessionEvent(session, {
          type: "tool_update",
          sessionId: session.id,
          toolName: evt.toolName || null,
          toolCallId: evt.toolCallId || null,
          outputPreview: clampText(output, 1500),
        });
        continue;
      }

      if (evt.type === "tool_execution_end") {
        const output = extractToolTextPayload(evt.result);
        emitPiSessionEvent(session, {
          type: "tool_end",
          sessionId: session.id,
          toolName: evt.toolName || null,
          toolCallId: evt.toolCallId || null,
          isError: evt.isError === true,
          outputPreview: clampText(output, 1500),
        });
        continue;
      }

      if (isPiDialogRequest(evt)) {
        session.pendingDialog = evt;
        emitPiSessionEvent(session, {
          type: "needs_ui",
          sessionId: session.id,
          request: formatPiUiRequest(evt),
        });
        notifyPiSession(session);
        continue;
      }

      if (evt.type === "agent_end") {
        session.done = true;
        emitPiSessionEvent(session, {
          type: "done",
          response: session.response || "",
          sessionId: session.id,
        });
        notifyPiSession(session);
        continue;
      }

      if (evt.type === "extension_error") {
        emitPiSessionEvent(session, {
          type: "trace",
          sessionId: session.id,
          label: "extension_error",
          detail: clampText(JSON.stringify(evt), 1500),
        });
        continue;
      }

      emitPiSessionEvent(session, {
        type: "trace",
        sessionId: session.id,
        label: evt.type || "event",
        detail: clampText(JSON.stringify(evt), 1200),
      });
    }
  });

  proc.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    // Ring-buffer: keep only the last 50KB to prevent memory exhaustion
    convProc.stderrData = (convProc.stderrData + text).slice(-50_000);
    if (convProc.activeRequestId) {
      const session = piRpcSessions.get(convProc.activeRequestId);
      if (session) {
        emitPiSessionEvent(session, {
          type: "stderr",
          sessionId: session.id,
          chunk: clampText(text, 1500),
        });
      }
    }
  });

  proc.stdin.on("error", () => {});

  proc.on("error", (error) => {
    let errMsg = error instanceof Error ? error.message : String(error);
    if (error.code === "ENOENT") {
      errMsg =
        "Pi command not found. Please install Pi and ensure it is in your PATH, or configure its path in Settings.";
    }
    if (convProc.activeRequestId) {
      const session = piRpcSessions.get(convProc.activeRequestId);
      if (session) {
        session.error = new Error(errMsg);
        emitPiSessionEvent(session, {
          type: "error",
          error: session.error.message,
          sessionId: session.id,
        });
        notifyPiSession(session);
      }
    }
    if (convProc.pendingStateResolver) {
      const resolveState = convProc.pendingStateResolver;
      convProc.pendingStateResolver = null;
      resolveState(null);
    }
    if (convProc.pendingStatsResolver) {
      const resolveStats = convProc.pendingStatsResolver;
      convProc.pendingStatsResolver = null;
      resolveStats(null);
    }
  });

  proc.on("close", (code) => {
    convProc.closed = true;
    if (convProc.pendingStateResolver) {
      const resolveState = convProc.pendingStateResolver;
      convProc.pendingStateResolver = null;
      resolveState(null);
    }
    if (convProc.pendingStatsResolver) {
      const resolveStats = convProc.pendingStatsResolver;
      convProc.pendingStatsResolver = null;
      resolveStats(null);
    }
    if (convProc.activeRequestId) {
      const session = piRpcSessions.get(convProc.activeRequestId);
      if (session && !session.done) {
        if (code !== 0) {
          session.error = new Error(
            `Pi process exited with code ${code}. Stderr: ${convProc.stderrData.trim() || "none"}`,
          );
          emitPiSessionEvent(session, {
            type: "error",
            error: session.error.message,
            sessionId: session.id,
          });
        } else {
          session.done = true;
          emitPiSessionEvent(session, {
            type: "done",
            response: session.response || "",
            sessionId: session.id,
          });
        }
        notifyPiSession(session);
      }
    }
  });

  proc.stdin.write(JSON.stringify({ type: "get_state" }) + "\n");

  return convProc;
}

function requestPiState(convProc, timeoutMs = 5000) {
  if (!convProc || convProc.closed) return Promise.resolve(null);
  if (convProc.pendingStateResolver) {
    return Promise.reject(createHttpError(409, "State request already in progress"));
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (convProc.pendingStateResolver === finish) {
        convProc.pendingStateResolver = null;
      }
      resolve(value);
    };
    convProc.pendingStateResolver = finish;
    convProc.proc.stdin.write(JSON.stringify({ type: "get_state" }) + "\n");
    setTimeout(() => finish(null), timeoutMs);
  });
}

function requestPiStats(convProc, timeoutMs = 5000) {
  if (!convProc || convProc.closed) return Promise.resolve(null);
  if (convProc.pendingStatsResolver) {
    return Promise.reject(createHttpError(409, "Stats request already in progress"));
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (convProc.pendingStatsResolver === finish) {
        convProc.pendingStatsResolver = null;
      }
      resolve(value);
    };
    convProc.pendingStatsResolver = finish;
    convProc.proc.stdin.write(
      JSON.stringify({ type: "get_session_stats" }) + "\n",
    );
    setTimeout(() => finish(null), timeoutMs);
  });
}

function formatPiContextUsage(stats) {
  const cu = stats && stats.contextUsage;
  if (cu && cu.tokens != null && cu.contextWindow != null) {
    return {
      used: cu.tokens,
      total: cu.contextWindow,
      percent:
        cu.percent != null
          ? cu.percent
          : Math.round((cu.tokens / cu.contextWindow) * 100),
    };
  }
  return null;
}

function summarizePiStatus(state, stats = null) {
  const model = state?.model && typeof state.model === "object" ? state.model : {};
  const provider = typeof model.provider === "string" ? model.provider : "";
  const zeroCost =
    model.cost &&
    typeof model.cost === "object" &&
    Number(model.cost.input || 0) === 0 &&
    Number(model.cost.output || 0) === 0 &&
    Number(model.cost.cacheRead || 0) === 0 &&
    Number(model.cost.cacheWrite || 0) === 0;
  const statsCost =
    stats && typeof stats.cost === "number" && Number.isFinite(stats.cost)
      ? stats.cost
      : null;
  const cost =
    provider === "ollama" || zeroCost || statsCost === 0
      ? "Local"
      : statsCost != null
        ? `$${statsCost.toFixed(4)}`
        : null;

  return {
    model: model.id || model.name || null,
    provider: provider || null,
    state: state?.isCompacting
      ? "COMPACTING"
      : state?.isStreaming
        ? "STREAMING"
        : "IDLE",
    thinkingLevel:
      typeof state?.thinkingLevel === "string" ? state.thinkingLevel : null,
    cost,
    sessionId: typeof state?.sessionId === "string" ? state.sessionId : null,
    contextUsage: formatPiContextUsage(stats),
  };
}

function sendPiPrompt(convProc, message, source = "manual") {
  const id = createPiSessionId();
  convProc.activeRequestId = id;

  const session = {
    id,
    proc: convProc.proc,
    response: "",
    thinking: "",
    buffer: "",
    stderrData: "",
    pendingDialog: null,
    done: false,
    closed: false,
    error: null,
    waiters: [],
    streamListeners: new Set(),
    source,
    timeoutMs: convProc.settings.timeoutMs,
    uiSettings: convProc.settings.permissionUx,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
  };

  piRpcSessions.set(id, session);
  appendSecurityEvent("pi_prompt_received", { sessionId: id, source });

  convProc.proc.stdin.write(JSON.stringify({ type: "prompt", message }) + "\n");
  convProc.lastActivityAt = Date.now();

  return session;
}

async function waitForPiSessionStep(
  session,
  timeoutMs = session?.timeoutMs || PI_SESSION_TIMEOUT_MS,
) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (session.error) {
      cleanupPiSession(session.id);
      throw session.error;
    }

    if (session.pendingDialog) {
      return {
        status: "needs_ui",
        sessionId: session.id,
        request: formatPiUiRequest(session.pendingDialog),
      };
    }

    if (session.done) {
      const response = session.response || "";
      appendSecurityEvent("pi_response_completed", {
        sessionId: session.id,
        source: session.source || null,
        responseLength: response.length,
      });
      cleanupPiSession(session.id, "completed");
      return {
        status: "done",
        response,
      };
    }

    await new Promise((resolve) => {
      if (session.error || session.pendingDialog || session.done) {
        resolve();
      } else {
        session.waiters.push(resolve);
      }
    });
  }

  cleanupPiSession(session.id, "session_timeout");
  throw new Error("Timed out waiting for Pi RPC response.");
}

function applyPiUiResponse(session, uiResponse) {
  if (!uiResponse || typeof uiResponse !== "object") {
    throw new Error("uiResponse object is required");
  }
  if (uiResponse.type !== "extension_ui_response") {
    throw new Error("uiResponse.type must be extension_ui_response");
  }
  if (typeof uiResponse.id !== "string" || !uiResponse.id) {
    throw new Error("uiResponse.id is required");
  }
  if (!session.pendingDialog || session.pendingDialog.id !== uiResponse.id) {
    throw new Error("uiResponse.id does not match current pending request");
  }

  if (session.proc.stdin.destroyed || session.proc.stdin.writableEnded) {
    throw new Error("Pi RPC stdin is not writable");
  }

  session.proc.stdin.write(JSON.stringify(uiResponse) + "\n");
  session.lastActivityAt = Date.now();
  session.pendingDialog = null;
}

setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of piRpcSessions.entries()) {
    if (session.done || session.closed) continue;
    const staleTimeoutMs = session.timeoutMs || PI_SESSION_TIMEOUT_MS;
    if (now - session.lastActivityAt > staleTimeoutMs) {
      cleanupPiSession(sessionId, "stale_timeout");
    }
  }

  // Sweep closed piConvProcesses
  for (const [convId, proc] of piConvProcesses.entries()) {
    if (proc.closed) {
      piConvProcesses.delete(convId);
    }
  }
}, PI_SESSION_SWEEP_INTERVAL_MS).unref();

function isRequestAllowed(req) {
  const host = req.headers["host"] || "";
  const origin = req.headers["origin"] || "";

  // Host must be 127.0.0.1 or localhost on our specified PORT
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) {
    return false;
  }

  // Origin, if present, must be 127.0.0.1 or localhost on our specified PORT
  if (
    origin &&
    origin !== `http://127.0.0.1:${PORT}` &&
    origin !== `http://localhost:${PORT}`
  ) {
    return false;
  }

  return true;
}

const server = http.createServer(async (req, res) => {
  // CORS & Host check for security
  if (!isRequestAllowed(req)) {
    console.warn(
      `Blocked request from untrusted origin/host: ${req.headers["host"]} / ${req.headers["origin"]}`,
    );
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden: Cross-Origin request blocked.");
    return;
  }

  // SV-14: Normalize URL path by stripping query strings
  const urlPath = req.url.split("?")[0];
  const requestUrl = new URL(req.url, `http://127.0.0.1:${PORT}`);

  // SV-17: Generate a nonce for CSP
  const cspNonce = randomBytes(16).toString("base64");

  // Add robust HTTP security headers
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'self'; script-src 'self' 'nonce-${cspNonce}'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self' http://127.0.0.1:${PORT} http://localhost:${PORT};`,
  );

  console.log("Incoming request:", req.method, req.url);

  const send = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  if (req.method === "GET" && urlPath === "/") {
    const injectNonce = (html) =>
      html
        .replace(/<script /g, `<script nonce="${cspNonce}" `)
        .replace(/<script>/g, `<script nonce="${cspNonce}">`)
        .replace(/<style /g, `<style nonce="${cspNonce}" `)
        .replace(/<style>/g, `<style nonce="${cspNonce}">`);
    if (EMBEDDED_INDEX) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(injectNonce(EMBEDDED_INDEX));
      return;
    }
    fs.readFile(INDEX, "utf8", (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end("Error loading index.html");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(injectNonce(data));
    });
    return;
  }

  if (req.method === "GET" && VENDOR_SCRIPT_FILES[urlPath]) {
    try {
      const vendor = VENDOR_SCRIPT_FILES[urlPath];
      const embedded = EMBEDDED_ASSETS.get(vendor.assetName);
      const source =
        typeof embedded === "string"
          ? embedded
          : fs.readFileSync(vendor.resolveFilePath(), "utf8");
      res.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "public, max-age=31536000, immutable",
      });
      res.end(source);
    } catch (error) {
      send(500, { error: "Failed to load vendor script." });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/fonts/pi-font-faces.css") {
    try {
      const embedded = EMBEDDED_ASSETS.get("font_faces.css");
      if (!embedded && !fs.existsSync(FONT_FACES_FILE)) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Font faces file not found.");
        return;
      }
      const css =
        typeof embedded === "string"
          ? embedded
          : fs.readFileSync(FONT_FACES_FILE, "utf8");
      res.writeHead(200, {
        "Content-Type": "text/css; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
      });
      res.end(css);
    } catch (error) {
      send(500, { error: "Failed to load font faces." });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/version") {
    try {
      const pkgPath = path.join(__dirname, "package.json");
      const embeddedPackage = EMBEDDED_ASSETS.get("package.json");
      if (typeof embeddedPackage === "string") {
        const pkg = JSON.parse(embeddedPackage);
        send(200, { version: pkg.version || "unknown" });
      } else if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        send(200, { version: pkg.version || "unknown" });
      } else {
        send(200, { version: "unknown" });
      }
    } catch (error) {
      send(200, { version: "unknown" });
    }
    return;
  }

  if (req.method === "GET" && urlPath.startsWith("/fonts/")) {
    try {
      const filename = urlPath.slice("/fonts/".length);
      if (!/^[a-z0-9._-]+\.woff2$/i.test(filename)) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Invalid font filename.");
        return;
      }
      const fontPath = path.join(FONTS_DIR, filename);
      if (!fs.existsSync(fontPath)) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Font file not found.");
        return;
      }
      const buffer = fs.readFileSync(fontPath);
      res.writeHead(200, {
        "Content-Type": "font/woff2",
        "Cache-Control": "public, max-age=31536000, immutable",
      });
      res.end(buffer);
    } catch (error) {
      send(500, { error: "Failed to load font file." });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/models") {
    try {
      send(200, await getModels());
    } catch (e) {
      send(500, { error: e.message });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/ui/settings") {
    const payload = loadUiSettingsWithMeta();
    send(200, payload);
    return;
  }

  if (req.method === "POST" && urlPath === "/api/ui/settings") {
    try {
      const body = await parseJsonBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        send(400, { error: "Settings object is required" });
        return;
      }
      const nextSettings =
        body.settings && typeof body.settings === "object"
          ? body.settings
          : body;
      const sanitized = saveUiSettings(nextSettings);
      send(200, { ok: true, settings: sanitized, exists: true });
    } catch (e) {
      send(e.statusCode || 500, { error: e.message });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/cloud/settings") {
    send(200, { settings: redactCloudSettings(loadCloudSettings()) });
    return;
  }

  if (req.method === "POST" && urlPath === "/api/cloud/settings") {
    try {
      const body = await parseJsonBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        send(400, { error: "Settings object is required" });
        return;
      }
      const nextSettings =
        body.settings && typeof body.settings === "object"
          ? body.settings
          : body;
      const sanitized = sanitizeCloudSettings(
        nextSettings,
        loadCloudSettings(),
      );
      saveCloudSettings(sanitized);
      send(200, {
        ok: true,
        settings: redactCloudSettings(sanitized),
      });
    } catch (e) {
      send(e.statusCode || 500, { error: e.message });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/library/settings") {
    try {
      const config = loadLibraryConfig();
      send(200, { settings: config.chatIntegration });
    } catch (e) {
      send(e.statusCode || 500, { error: e.message });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/library/settings") {
    try {
      const body = await parseJsonBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        send(400, { error: "Settings object is required" });
        return;
      }
      const nextSettings =
        body.settings && typeof body.settings === "object"
          ? body.settings
          : body;
      const config = saveLibraryChatSettings(nextSettings);
      send(200, { ok: true, settings: config.chatIntegration });
    } catch (e) {
      send(e.statusCode || 500, { error: e.message });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/library/config") {
    try {
      send(200, { config: loadLibraryConfig() });
    } catch (e) {
      send(e.statusCode || 500, { error: e.message });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/library/config") {
    try {
      const body = await parseJsonBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        send(400, { error: "Config object is required" });
        return;
      }
      const nextConfig =
        body.config && typeof body.config === "object" ? body.config : body;
      const config = saveLibraryConfig(nextConfig);
      send(200, { ok: true, config });
    } catch (e) {
      send(e.statusCode || 500, { error: e.message });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/library/status") {
    try {
      send(200, await getLibraryStatus());
    } catch (e) {
      send(e.statusCode || 500, { error: e.message });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/library/estimate") {
    try {
      const sampleLimit = Number.parseInt(
        requestUrl.searchParams.get("sample") || "",
        10,
      );
      send(
        200,
        await estimateLibraryIndex({
          sampleLimit: Number.isFinite(sampleLimit) ? sampleLimit : undefined,
        }),
      );
    } catch (e) {
      send(e.statusCode || 500, { error: e.message });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/library/index") {
    send(200, {
      running: !!activeLibraryIndexJob,
      job: publicLibraryIndexJob(activeLibraryIndexJob || lastLibraryIndexJob),
    });
    return;
  }

  if (req.method === "POST" && urlPath === "/api/library/index") {
    try {
      const body = await parseJsonBody(req);
      const job = startLibraryIndexJob({
        force: body?.force === true,
        prune: body?.prune !== false,
        compact: body?.compact !== false,
      });
      send(202, { ok: true, running: true, job: publicLibraryIndexJob(job) });
    } catch (e) {
      send(e.statusCode || 500, {
        error: e.message,
        running: !!activeLibraryIndexJob,
        job: publicLibraryIndexJob(activeLibraryIndexJob || lastLibraryIndexJob),
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/library/index/cancel") {
    if (!activeLibraryIndexJob) {
      send(200, {
        ok: true,
        running: false,
        job: publicLibraryIndexJob(lastLibraryIndexJob),
      });
      return;
    }
    const job = pauseLibraryIndexJob();
    send(202, {
      ok: true,
      running: true,
      job: publicLibraryIndexJob(job),
    });
    return;
  }

  if (req.method === "POST" && urlPath === "/api/library/search") {
    try {
      const body = await parseJsonBody(req);
      const query = typeof body?.query === "string" ? body.query.trim() : "";
      if (!query) {
        send(400, { error: "Search query is required" });
        return;
      }
      const results = await searchLibrary(query, { limit: body.limit });
      send(200, { query, results });
    } catch (e) {
      send(e.statusCode || 500, { error: e.message });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/pi/settings") {
    const settings = loadPiSettings();
    send(200, {
      settings,
      runtime: getPiRuntimeInfo(settings),
    });
    return;
  }

  if (req.method === "POST" && urlPath === "/api/pi/settings") {
    try {
      const body = await parseJsonBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        send(400, { error: "Settings object is required" });
        return;
      }
      const nextSettings =
        body.settings && typeof body.settings === "object"
          ? body.settings
          : body;
      const sanitized = sanitizePiSettings(nextSettings);
      savePiSettings(sanitized);
      send(200, {
        ok: true,
        settings: sanitized,
        runtime: getPiRuntimeInfo(sanitized),
      });
    } catch (e) {
      send(e.statusCode || 500, { error: e.message });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/pi/settings/reset") {
    const defaults = defaultPiSettings();
    savePiSettings(defaults);
    send(200, {
      ok: true,
      settings: defaults,
      runtime: getPiRuntimeInfo(defaults),
    });
    return;
  }

  if (req.method === "POST" && urlPath === "/api/pi/open-project-folder") {
    execFile("open", [__dirname], (error) => {
      if (error) {
        send(500, {
          error: `Failed to open project folder: ${error.message}`,
        });
        return;
      }
      send(200, { ok: true, path: __dirname });
    });
    return;
  }

  if (req.method === "GET" && urlPath === "/api/health/logs") {
    send(200, {
      dataDir: DATA_DIR,
      maxLogFileSizeBytes: MAX_LOG_FILE_SIZE,
      maxRotatedFiles: MAX_ROTATED_LOG_FILES,
      logs: {
        securityEvents: {
          path: SECURITY_EVENTS_FILE,
          ...getFileHealth(SECURITY_EVENTS_FILE),
        },
        daemonStdout: {
          path: DAEMON_LOG_FILE,
          ...getFileHealth(DAEMON_LOG_FILE),
        },
        daemonStderr: {
          path: DAEMON_ERROR_LOG_FILE,
          ...getFileHealth(DAEMON_ERROR_LOG_FILE),
        },
      },
    });
    return;
  }

  if (req.method === "GET" && urlPath === "/api/conversations") {
    send(200, loadConversations());
    return;
  }

  if (req.method === "DELETE" && urlPath === "/api/conversations") {
    saveConversations([]);
    send(200, { ok: true });
    return;
  }

  const deleteMatch =
    req.method === "DELETE" &&
    urlPath.match(/^\/api\/conversations\/id\/([^/]+)$/);
  if (deleteMatch) {
    const encodedId = deleteMatch[1];
    const convId = decodeURIComponent(encodedId || "");
    if (!convId) {
      send(400, { error: "Conversation id is required" });
      return;
    }
    const convs = loadConversations();
    const next = convs.filter((c) => c.id !== convId);
    if (next.length === convs.length) {
      send(404, { error: "Conversation not found" });
      return;
    }
    saveConversations(next);
    send(200, { ok: true });
    return;
  }

  if (
    req.method === "DELETE" &&
    (urlPath === "/api/conversations/id" ||
      urlPath === "/api/conversations/id/")
  ) {
    send(400, {
      error:
        "Conversation id is required in the URL path, e.g. /api/conversations/id/{id}",
    });
    return;
  }

  if (req.method === "DELETE" && urlPath.startsWith("/api/conversations/")) {
    const parts = urlPath.split("/");
    const idxStr = parts.pop();
    const idx = parseInt(idxStr, 10);
    const convs = loadConversations();
    if (isNaN(idx) || idx < 0 || idx >= convs.length) {
      send(400, { error: "Invalid conversation index" });
      return;
    }
    convs.splice(idx, 1);
    saveConversations(convs);
    send(200, { ok: true });
    return;
  }

  if (req.method === "GET" && urlPath === "/api/prompts") {
    send(200, loadPrompts());
    return;
  }

  if (req.method === "POST" && urlPath === "/api/prompts") {
    try {
      const body = await parseJsonBody(req);
      if (!Array.isArray(body)) {
        send(400, { error: "Prompts must be an array" });
        return;
      }
      const valid = body.every(
        (p) =>
          p &&
          typeof p.id === "string" &&
          typeof p.name === "string" &&
          typeof p.content === "string",
      );
      if (!valid) {
        send(400, { error: "Invalid prompt structure" });
        return;
      }
      savePrompts(body);
      send(200, { ok: true });
    } catch (e) {
      send(e.statusCode || 500, { error: e.message });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/custom-skills") {
    send(200, loadCustomSkills());
    return;
  }

  if (req.method === "POST" && urlPath === "/api/mcp/config") {
    try {
      const body = await parseJsonBody(req);
      await initMcpServers(body.config);
      send(200, { success: true });
    } catch (e) {
      send(500, { error: e.message });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/custom-skills") {
    try {
      const body = await parseJsonBody(req);
      if (!Array.isArray(body)) {
        send(400, { error: "Custom skills must be an array" });
        return;
      }
      const valid = body.every(
        (s) =>
          s &&
          typeof s.name === "string" &&
          typeof s.description === "string" &&
          typeof s.type === "string" &&
          typeof s.code === "string",
      );
      if (!valid) {
        send(400, { error: "Invalid custom skill structure" });
        return;
      }
      saveCustomSkills(body);
      send(200, { ok: true });
    } catch (e) {
      send(e.statusCode || 500, { error: e.message });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/ollama/skills/settings") {
    send(200, loadSkillsConfig());
    return;
  }

  if (req.method === "POST" && urlPath === "/api/ollama/skills/settings") {
    try {
      const body = await parseJsonBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        send(400, { error: "Settings object is required" });
        return;
      }

      const VALID_SKILL_KEYS = new Set(Object.keys(defaultSkillsConfig()));
      const filtered = Object.fromEntries(
        Object.entries(body).filter(([k]) => VALID_SKILL_KEYS.has(k)),
      );
      const nextSettings = { ...loadSkillsConfig(), ...filtered };

      saveSkillsConfig(nextSettings);
      send(200, { ok: true, settings: nextSettings });
    } catch (e) {
      send(e.statusCode || 500, { error: e.message });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/ollama/tool-respond") {
    try {
      const body = await parseJsonBody(req);
      const { sessionId, uiResponse } = body || {};
      if (typeof sessionId !== "string" || !sessionId) {
        send(400, { error: "sessionId is required" });
        return;
      }

      const entry = ollamaToolRequests.get(sessionId);
      if (!entry) {
        send(404, { error: "Ollama tool request not found or expired" });
        return;
      }

      const approved =
        typeof uiResponse.confirmed === "boolean"
          ? uiResponse.confirmed
          : false;

      clearTimeout(entry.timer);
      entry.resolve(approved);
      ollamaToolRequests.delete(sessionId);

      send(200, { ok: true });
    } catch (e) {
      send(e.statusCode || 500, { error: e.message });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/pi/new-session") {
    try {
      const body = await parseJsonBody(req);
      const convId = body.saveConv || body.convId || "default";
      const convProc = piConvProcesses.get(convId);
      if (convProc && !convProc.closed) {
        convProc.proc.stdin.write(
          JSON.stringify({ type: "new_session" }) + "\n",
        );
      }
      send(200, { ok: true });
    } catch (e) {
      send(500, { error: e.message });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/pi/load-session") {
    try {
      const body = await parseJsonBody(req);
      const convId = body.saveConv || body.convId || "default";
      const { sessionFile } = body;

      if (typeof sessionFile !== "string" || !sessionFile.trim()) {
        send(400, { error: "sessionFile must be a non-empty string" });
        return;
      }
      const resolvedPath = path.resolve(sessionFile.trim());

      const convProc = getOrCreatePiConvProcess(convId);
      convProc.proc.stdin.write(
        JSON.stringify({ type: "switch_session", sessionPath: resolvedPath }) +
          "\n",
      );
      send(200, { ok: true });
    } catch (e) {
      send(500, { error: e.message });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/pi/stats") {
    try {
      const body = await parseJsonBody(req);
      const convId = body.saveConv || body.convId || "default";
      const convProc = piConvProcesses.get(convId);
      if (!convProc || convProc.closed) {
        send(404, { error: "No active Pi process" });
        return;
      }

      const stats = await requestPiStats(convProc);
      send(200, { contextUsage: formatPiContextUsage(stats) });
    } catch (e) {
      send(e.statusCode || 500, { error: e.message });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/pi/status") {
    try {
      const body = await parseJsonBody(req);
      const convId = body.saveConv || body.convId || "default";
      const convProc = piConvProcesses.get(convId);
      if (!convProc || convProc.closed) {
        send(404, { error: "No active Pi process" });
        return;
      }

      const state = await requestPiState(convProc);
      const stats = await requestPiStats(convProc);
      send(200, {
        status: summarizePiStatus(state, stats),
      });
    } catch (e) {
      send(e.statusCode || 500, { error: e.message });
    }
    return;
  }

  if (req.method === "GET" && urlPath.startsWith("/api/models/info")) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const modelName = url.searchParams.get("model");
    if (!modelName) {
      send(400, { error: "model parameter required" });
      return;
    }
    try {
      const opts = {
        hostname: "localhost",
        port: 11434,
        path: "/api/show",
        method: "POST",
        headers: { "Content-Type": "application/json" },
      };
      const r = http.request(opts, (resProxy) => {
        let data = "";
        resProxy.on("data", (c) => (data += c));
        resProxy.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            // Only return a context length if the model has an explicit num_ctx
            // set in its Ollama parameters (i.e. the user ran `ollama run model
            // --num-ctx N` or set it via Modelfile). We deliberately ignore the
            // architectural context_length fields which reflect theoretical
            // maximums (e.g. 1 024 000 for Nemo) and have nothing to do with
            // what Ollama will actually load.
            let modelNumCtx = null;
            const paramsText =
              typeof parsed.parameters === "string" ? parsed.parameters : "";
            if (paramsText) {
              const m = paramsText.match(/\bnum_ctx\s+(\d+)/i);
              if (m && Number.isFinite(Number(m[1]))) {
                modelNumCtx = Number(m[1]);
              }
            }
            send(200, { contextLength: modelNumCtx });
          } catch (e) {
            send(500, { error: "Failed to parse ollama show response" });
          }
        });
      });
      r.on("error", (e) => send(500, { error: e.message }));
      r.write(JSON.stringify({ name: modelName }));
      r.end();
    } catch (e) {
      send(500, { error: e.message });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/notes") {
    const notes = loadNotes();
    send(200, notes);
    return;
  }

  if (
    (req.method === "PUT" || req.method === "POST") &&
    req.url === "/api/notes"
  ) {
    try {
      const body = await parseJsonBody(req);
      if (!body || typeof body.text !== "string") {
        send(400, { error: "text field required" });
        return;
      }
      const text =
        body.text.length > 200000 ? body.text.slice(0, 200000) : body.text;
      const saved = saveNotes(text);
      send(200, saved);
    } catch (e) {
      const status = e && e.statusCode ? e.statusCode : 500;
      send(status, { error: e?.message || "Failed to save notes" });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/cloud/chat/stream") {
    let finished = false;
    const abortController = new AbortController();
    const emit = (event) => {
      if (!res.writableEnded) {
        res.write(JSON.stringify(event) + "\n");
      }
    };

    try {
      const body = await parseJsonBody(req);
      if (!body || typeof body.message !== "string" || !body.message.trim()) {
        send(400, { error: "message is required" });
        return;
      }

      const settings = loadCloudSettings();
      const provider = CLOUD_PROVIDER_SET.has(settings.provider)
        ? settings.provider
        : "openai";
      const { history = [], saveConv, convTitle, mode = "cloud" } = body;
      const message = body.message;
      const messages = normalizeCloudHistoryMessages(history, message);
      let output = "";
      let usage = null;

      res.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      req.on("close", () => {
        if (!finished) {
          abortController.abort();
        }
      });

      usage = await streamCloudCompletion({
        provider,
        settings,
        messages,
        signal: abortController.signal,
        onDelta: (delta) => {
          output += delta;
          emit({ type: "delta", delta, response: output });
        },
        onUsage: (nextUsage) => {
          usage = nextUsage;
        },
      });

      finished = true;
      upsertConversation(saveConv, convTitle, message, messages, output, mode);
      emit({
        type: "done",
        response: output,
        usage,
        provider,
        model: settings.models?.[provider] || CLOUD_DEFAULT_MODELS[provider],
      });
      if (!res.writableEnded) res.end();
    } catch (e) {
      const isAbort = e?.name === "AbortError";
      if (!finished) {
        finished = true;
      }
      if (!res.writableEnded) {
        if (!res.headersSent) {
          send(isAbort ? 499 : e.statusCode || 500, {
            error: isAbort ? "Cloud request cancelled." : e.message,
          });
        } else {
          emit({
            type: "error",
            error: isAbort ? "Cloud request cancelled." : e.message,
          });
          res.end();
        }
      }
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/chat/stream") {
    let finished = false;
    let upstreamReq = null;
    let upstreamRes = null;
    try {
      const body = await parseJsonBody(req);
      const {
        message,
        model,
        history = [],
        saveConv,
        convTitle,
        mode = "ollama",
        options,
        library,
      } = body;
      const messages = [...history, { role: "user", content: message }];
      const safeOptions = sanitizeOllamaOptions(options);

      res.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      const opts = {
        hostname: "localhost",
        port: 11434,
        path: "/api/chat",
        method: "POST",
        headers: { "Content-Type": "application/json" },
      };

      let output = "";
      let thinking = "";
      let emittedThinkingStart = false;

      const emit = (event) => {
        if (!res.writableEnded) {
          res.write(JSON.stringify(event) + "\n");
        }
      };

      try {
        const libraryContext = await buildChatLibraryContext(message, library);
        if (libraryContext.enabled) {
          if (libraryContext.contextMessage) {
            const firstNonSystemIndex = messages.findIndex(
              (item) => item.role !== "system",
            );
            if (firstNonSystemIndex === -1) {
              messages.push(libraryContext.contextMessage);
            } else {
              messages.splice(firstNonSystemIndex, 0, libraryContext.contextMessage);
            }
          }
          emit({
            type: "library_results",
            results: libraryContext.results.map((result) => ({
              chunkId: result.chunkId,
              title: result.title,
              author: result.author,
              path: result.path,
              heading: result.heading,
              kind: result.kind,
              score: result.score,
              snippet: result.snippet,
            })),
          });
        }
      } catch (e) {
        emit({ type: "library_error", error: e.message });
      }

      const startStream = (depth = 0) => {
        if (depth > 10) {
          emit({ type: "error", error: "Tool call recursion limit exceeded." });
          if (!res.writableEnded) res.end();
          return;
        }
        const payloadObject = { model, messages, stream: true };
        if (safeOptions) payloadObject.options = safeOptions;

        const mcpTools = getMcpOllamaTools();
        if (mcpTools.length > 0) {
          payloadObject.tools = mcpTools;
        }

        const payload = JSON.stringify(payloadObject);

        let lineBuffer = "";
        let promptEvalCount = 0;
        let evalCount = 0;
        let outputToolCalls = [];

        upstreamReq = http.request(opts, (ollamaRes) => {
          upstreamRes = ollamaRes;
          ollamaRes.on("data", (chunk) => {
            lineBuffer += chunk.toString();
            const lines = lineBuffer.split("\n");
            lineBuffer = lines.pop() || "";

            for (const rawLine of lines) {
              const line = rawLine.trim();
              if (!line) continue;
              let evt;
              try {
                evt = JSON.parse(line);
              } catch (_e) {
                continue;
              }

              const msg = evt?.message || {};

              if (msg.tool_calls) {
                outputToolCalls = msg.tool_calls;
              }

              const thinkingDelta =
                typeof msg.thinking === "string" ? msg.thinking : "";
              if (thinkingDelta) {
                if (!emittedThinkingStart) {
                  emittedThinkingStart = true;
                  emit({ type: "thinking_start" });
                }
                thinking += thinkingDelta;
                emit({
                  type: "thinking_delta",
                  delta: thinkingDelta,
                  thinking,
                });
              }

              const delta = typeof msg.content === "string" ? msg.content : "";
              if (delta) {
                output += delta;
                if (!output.includes("<call:")) {
                  emit({ type: "delta", delta, response: output });
                }
              }

              if (evt.done === true) {
                const xmlMatch = output.match(/<call:([^>]+)>(.*?)<\/call>/is);
                if (xmlMatch) {
                  outputToolCalls.push({
                    function: {
                      name: xmlMatch[1].trim(),
                      arguments: xmlMatch[2].trim(),
                    },
                  });
                  output = output.replace(xmlMatch[0], "").trim();
                }

                if (outputToolCalls.length > 0) {
                  messages.push({ role: "assistant", content: output });
                  (async () => {
                    for (const tc of outputToolCalls) {
                      if (!emittedThinkingStart) {
                        emittedThinkingStart = true;
                        emit({ type: "thinking_start" });
                      }
                      const startMsg = `\n\n[Running tool: ${tc.function.name}...]\n`;
                      thinking += startMsg;
                      emit({
                        type: "thinking_delta",
                        delta: startMsg,
                        thinking,
                      });

                      const requiresShellConfirmation =
                        skillRequiresShellConfirmation(
                          tc.function.name,
                          DATA_DIR,
                        );
                      let executeAllowed = true;
                      if (requiresShellConfirmation) {
                        executeAllowed = await new Promise((resolve) => {
                          const reqId =
                            "ollama_req_" + Date.now() + "_" + randomUUID();
                          const denialTimer = setTimeout(
                            () => {
                              if (ollamaToolRequests.has(reqId)) {
                                ollamaToolRequests.delete(reqId);
                                resolve(false);
                                appendSecurityEvent(
                                  "shell_command_timeout_denied",
                                  { reqId },
                                );
                              }
                            },
                            5 * 60 * 1000,
                          ); // 5 minute auto-deny timeout
                          ollamaToolRequests.set(reqId, {
                            resolve,
                            timer: denialTimer,
                          });
                          emit({
                            type: "needs_ui",
                            sessionId: reqId,
                            request: {
                              method: "confirm",
                              title: "Shell Command Execution Request",
                              message: `The AI wants to run the following shell command:\n\n${tc.function.arguments}\n\nDo you want to allow this?`,
                              requireUserInteraction: true,
                              danger: true,
                            },
                          });
                        });
                      }

                      let result;
                      if (tc.function.name.startsWith("mcp__")) {
                        result = await executeMcpTool(tc);
                      } else if (executeAllowed) {
                        if (requiresShellConfirmation) {
                          appendSecurityEvent("shell_command_executed", {
                            command: tc.function.arguments,
                            tool: tc.function.name,
                          });
                        }
                        result = await executeSkill(tc, {
                          dataDir: DATA_DIR,
                          allowShellCommand: requiresShellConfirmation,
                        });
                      } else {
                        appendSecurityEvent("shell_command_denied", {
                          command: tc.function.arguments,
                          tool: tc.function.name,
                        });
                        result =
                          "User denied permission to execute this shell command.";
                      }

                      messages.push({
                        role: "user",
                        content: `[SKILL RESULT: ${tc.function.name}]\n\n${result}\n\nPlease continue your response based on this result.`,
                      });

                      const endMsg = `[Finished tool: ${tc.function.name}]\n`;
                      thinking += endMsg;
                      emit({ type: "thinking_delta", delta: endMsg, thinking });
                    }
                    startStream(depth + 1);
                  })();
                  return;
                }

                promptEvalCount =
                  typeof evt.prompt_eval_count === "number"
                    ? evt.prompt_eval_count
                    : 0;
                evalCount =
                  typeof evt.eval_count === "number" ? evt.eval_count : 0;
                if (emittedThinkingStart) {
                  emit({ type: "thinking_end", thinking });
                }

                if (finished) return;
                finished = true;
                upsertConversation(
                  saveConv,
                  convTitle,
                  message,
                  messages,
                  output,
                  mode,
                );
                emit({
                  type: "done",
                  response: output,
                  thinking,
                  promptTokens: promptEvalCount,
                  evalTokens: evalCount,
                });
                if (!res.writableEnded) res.end();
              }
            }
          });

          ollamaRes.on("end", () => {
            if (!finished && outputToolCalls.length === 0) {
              finished = true;
              upsertConversation(
                saveConv,
                convTitle,
                message,
                messages,
                output,
                mode,
              );
              emit({ type: "done", response: output, thinking });
              if (!res.writableEnded) res.end();
            }
          });

          ollamaRes.on("error", (e) => {
            if (!finished) {
              finished = true;
              emit({ type: "error", error: e.message });
              if (!res.writableEnded) res.end();
            }
          });
        });

        upstreamReq.on("error", (e) => {
          if (!finished) {
            finished = true;
            emit({ type: "error", error: e.message });
            if (!res.writableEnded) res.end();
          }
        });

        upstreamReq.write(payload);
        upstreamReq.end();
      };

      startStream(0);

      req.on("close", () => {
        if (!finished) {
          if (upstreamReq) upstreamReq.destroy();
          if (upstreamRes) upstreamRes.destroy();
        }
      });
    } catch (e) {
      if (!res.writableEnded) {
        if (!res.headersSent) {
          send(e.statusCode || 500, { error: e.message });
        } else {
          res.write(JSON.stringify({ type: "error", error: e.message }) + "\n");
          res.end();
        }
      }
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/chat") {
    let finished = false;
    let cancel = null;
    try {
      const body = await parseJsonBody(req);
      const {
        message,
        model,
        history = [],
        saveConv,
        convTitle,
        mode = "ollama",
        options,
      } = body;
      const messages = [...history, { role: "user", content: message }];
      const safeOptions = sanitizeOllamaOptions(options);

      let { promise, abort } = ollamaChat(model, messages, safeOptions);
      cancel = abort;

      req.on("close", () => {
        if (!finished) {
          console.log("Client aborted request. Aborting Ollama API request...");
          cancel();
        }
      });

      let messageObj = await promise;

      if (messageObj && typeof messageObj.content === "string") {
        const xmlMatch = messageObj.content.match(
          /<call:([^>]+)>(.*?)<\/call>/is,
        );
        if (xmlMatch) {
          if (!messageObj.tool_calls) messageObj.tool_calls = [];
          messageObj.tool_calls.push({
            function: {
              name: xmlMatch[1].trim(),
              arguments: xmlMatch[2].trim(),
            },
          });
          messageObj.content = messageObj.content
            .replace(xmlMatch[0], "")
            .trim();
        }
      }

      if (
        messageObj &&
        messageObj.tool_calls &&
        messageObj.tool_calls.length > 0
      ) {
        messages.push(messageObj);
        for (const toolCall of messageObj.tool_calls) {
          let result;
          if (
            skillRequiresShellConfirmation(toolCall.function.name, DATA_DIR)
          ) {
            appendSecurityEvent("shell_command_denied_non_stream", {
              command: toolCall.function.arguments,
              tool: toolCall.function.name,
            });
            result =
              "Error: shell command execution requires interactive confirmation, which is not supported in the non-streaming API.";
          } else if (toolCall.function.name.startsWith("mcp__")) {
            result = await executeMcpTool(toolCall);
          } else {
            result = await executeSkill(toolCall, { dataDir: DATA_DIR });
          }
          messages.push({
            role: "tool",
            content: result,
          });
        }

        const secondCall = ollamaChat(model, messages, safeOptions);
        cancel = secondCall.abort;
        messageObj = await secondCall.promise;
      }

      const response = messageObj ? messageObj.content || "" : "";
      finished = true;

      upsertConversation(
        saveConv,
        convTitle,
        message,
        messages,
        response,
        mode,
      );
      send(200, { response });
    } catch (e) {
      if (req.destroyed) {
        console.log(
          "Request was destroyed (aborted). Skipping error response.",
        );
      } else {
        send(e.statusCode || 500, { error: e.message });
      }
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/security-event") {
    try {
      const body = await parseJsonBody(req);
      if (!body || typeof body.event !== "string" || !body.event.trim()) {
        send(400, { error: "event is required" });
        return;
      }

      const ALLOWED_SECURITY_EVENTS = new Set([
        "user_action",
        "settings_changed",
        "conversation_cleared",
        "file_uploaded",
        "pi_mode_entered",
        "ollama_mode_entered",
        "cloud_mode_entered",
        "user_message_submitted",
      ]);
      if (!ALLOWED_SECURITY_EVENTS.has(body.event.trim())) {
        send(400, { error: "Unknown security event type" });
        return;
      }

      appendSecurityEvent(body.event.trim(), {
        ...(body.details && typeof body.details === "object"
          ? body.details
          : {}),
      });
      send(200, { ok: true });
    } catch (e) {
      send(e.statusCode || 500, { error: e.message });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/pi/stream") {
    let session = null;
    let unsubscribe = null;
    const writeStreamEvent = (evt) => {
      if (res.writableEnded) return;
      res.write(JSON.stringify(evt) + "\n");
    };
    try {
      const body = await parseJsonBody(req);
      if (!body || typeof body.message !== "string" || !body.message.trim()) {
        send(400, { error: "message is required" });
        return;
      }

      const source =
        typeof body.source === "string" && body.source.trim()
          ? body.source.trim()
          : "manual";
      const { history = [], saveConv, convTitle, mode = "pi" } = body;
      const messages = [...history, { role: "user", content: body.message }];

      res.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      const piSettings = loadPiSettings();
      const convId = body.saveConv || "default";
      const convProc = getOrCreatePiConvProcess(convId, piSettings);
      session = sendPiPrompt(convProc, body.message, source);
      writeStreamEvent({ type: "session_start", sessionId: session.id });

      unsubscribe = addPiSessionListener(session, (evt) => {
        writeStreamEvent(evt);
        if (evt.type === "done" || evt.type === "error") {
          if (evt.type === "done") {
            upsertConversation(
              saveConv,
              convTitle,
              body.message,
              messages,
              session.response || "",
              mode,
            );
          }
          if (typeof unsubscribe === "function") unsubscribe();
          if (!res.writableEnded) res.end();
          cleanupPiSession(
            session.id,
            evt.type === "done" ? "completed_stream" : "stream_error",
          );
        }
      });

      if (session.pendingDialog) {
        writeStreamEvent({
          type: "needs_ui",
          sessionId: session.id,
          request: formatPiUiRequest(session.pendingDialog),
        });
      }

      res.on("close", () => {
        if (typeof unsubscribe === "function") unsubscribe();
        if (session && piRpcSessions.has(session.id)) {
          cleanupPiSession(session.id, "stream_client_disconnected");
        }
      });
    } catch (e) {
      if (!res.writableEnded) {
        if (!res.headersSent) {
          send(e.statusCode || 500, { error: e.message });
        } else {
          writeStreamEvent({ type: "error", error: e.message || String(e) });
          res.end();
        }
      }
      if (session && piRpcSessions.has(session.id)) {
        cleanupPiSession(session.id, "stream_setup_error");
      }
    }
    return;
  }

  if (
    req.method === "POST" &&
    (req.url === "/api/pi" || req.url === "/api/pi/start")
  ) {
    let session = null;
    try {
      const body = await parseJsonBody(req);
      if (!body || typeof body.message !== "string" || !body.message.trim()) {
        send(400, { error: "message is required" });
        return;
      }

      const source =
        typeof body.source === "string" && body.source.trim()
          ? body.source.trim()
          : "manual";
      const piSettings = loadPiSettings();
      const convId = body.saveConv || "default";
      const convProc = getOrCreatePiConvProcess(convId, piSettings);
      session = sendPiPrompt(convProc, body.message, source);
      req.on("close", () => {
        if (session && !res.writableEnded) {
          cleanupPiSession(session.id, "client_disconnected_start");
        }
      });
      const result = await waitForPiSessionStep(session);
      send(200, result);
    } catch (e) {
      if (req.destroyed) {
        console.log(
          "Request was destroyed (aborted). Skipping error response.",
        );
      } else {
        send(e.statusCode || 500, { error: e.message });
      }
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/pi/respond") {
    let sessionId = null;
    try {
      const body = await parseJsonBody(req);
      const { sessionId: requestSessionId, uiResponse, streaming } = body || {};
      sessionId = requestSessionId;
      if (typeof sessionId !== "string" || !sessionId) {
        send(400, { error: "sessionId is required" });
        return;
      }

      const session = piRpcSessions.get(sessionId);
      if (!session) {
        send(404, { error: "Pi RPC session not found or expired" });
        return;
      }
      req.on("close", () => {
        if (sessionId && !res.writableEnded) {
          cleanupPiSession(sessionId, "client_disconnected_respond");
        }
      });

      applyPiUiResponse(session, uiResponse);
      appendSecurityEvent("pi_permission_response", {
        sessionId,
        approved:
          typeof uiResponse.confirmed === "boolean"
            ? uiResponse.confirmed
            : typeof uiResponse.value === "string"
              ? uiResponse.value
              : uiResponse.cancelled === true
                ? "cancelled"
                : "unknown",
      });

      if (streaming === true) {
        send(200, { ok: true });
        return;
      }

      const result = await waitForPiSessionStep(session);
      send(200, result);
    } catch (e) {
      if (req.destroyed) {
        console.log(
          "Request was destroyed (aborted). Skipping error response.",
        );
      } else {
        send(e.statusCode || 500, { error: e.message });
      }
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/upload") {
    try {
      const buf = await readBody(req, MAX_UPLOAD_PAYLOAD_SIZE);
      const ct = req.headers["content-type"] || "";
      const boundaryMatch = ct.match(/boundary=(.+)/);
      if (!boundaryMatch) {
        send(400, { error: "No boundary" });
        return;
      }
      const parts = parseMultipart(buf, boundaryMatch[1]);
      const file = parts.find((p) => p.filename);
      if (!file) {
        send(400, { error: "No file" });
        return;
      }
      const isPdf = file.filename.toLowerCase().endsWith(".pdf");
      if (isPdf) {
        const tmp = path.join(
          os.tmpdir(),
          "upload_" + randomBytes(8).toString("hex") + ".pdf",
        );
        try {
          fs.writeFileSync(tmp, file.body);
          execFile(
            "pdftotext",
            [tmp, "-"],
            { timeout: PDFTOTEXT_TIMEOUT_MS, maxBuffer: PDFTOTEXT_MAX_BUFFER },
            (err, stdout) => {
              try {
                if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
              } catch (unlinkErr) {
                console.error("Failed to delete temp file:", unlinkErr);
              }
              if (err) {
                console.error("pdftotext failed:", err);
                send(500, { error: "pdftotext failed" });
                return;
              }
              send(200, { text: stdout, filename: file.filename });
            },
          );
        } catch (writeErr) {
          try {
            if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
          } catch (e) {}
          throw writeErr;
        }
      } else {
        const ALLOWED_TEXT_EXTENSIONS = new Set([
          ".txt",
          ".md",
          ".js",
          ".ts",
          ".py",
          ".html",
          ".css",
          ".json",
        ]);
        const ext = path.extname(file.filename || "").toLowerCase();
        if (!ext || !ALLOWED_TEXT_EXTENSIONS.has(ext)) {
          send(415, {
            error: `Unsupported file type${ext ? ": " + ext : ""}. Allowed: .txt, .md, .js, .ts, .py, .html, .css, .json, .pdf`,
          });
          return;
        }
        send(200, {
          text: file.body.toString("utf8"),
          filename: file.filename,
        });
      }
    } catch (e) {
      send(e.statusCode || 500, { error: e.message });
    }
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("Running securely on http://127.0.0.1:" + PORT);
  resumePersistedLibraryIndexJob();
});

// SV-18: Graceful shutdown handler
function gracefulShutdown(signal) {
  console.log(`Received ${signal}. Shutting down gracefully...`);

  // Clean up all Pi processes
  for (const procObj of piConvProcesses.values()) {
    try {
      procObj.proc.kill("SIGTERM");
    } catch (e) {}
  }
  piConvProcesses.clear();

  // Shut down server
  server.close(() => {
    console.log("Server stopped.");
    process.exit(0);
  });

  // Force exit after 5 seconds
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
