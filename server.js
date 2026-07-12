const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile, spawn, spawnSync } = require("child_process");
const os = require("os");
const { randomUUID, randomBytes } = require("crypto");
const {
  ALL_SKILLS,
  executeSkill,
  skillRequiresShellConfirmation,
} = require("./skills");
const { initMcpServers, getMcpOllamaTools, executeMcpTool } = require("./mcp");
const {
  buildForcedSkillToolCall,
  isDatabaseSlashCommand,
  isSkillSlashCommand,
  parseSlashCommand,
} = require("./slash_commands");
const {
  buildChatLibraryContext,
  estimateLibraryIndex,
  getLibraryStatus,
  indexLibrary,
  listIndexedLibraryFiles,
  loadLibraryConfig,
  saveLibraryConfig,
  saveLibraryChatSettings,
  searchLibrary,
  searchLibraryFiles,
} = require("./library/store");

const DEFAULT_PORT = 8080;
const PORT = Number.parseInt(process.env.PORT || String(DEFAULT_PORT), 10);
const MAX_CONVERSATIONS = 10;
const MAX_HISTORY_MESSAGES = 200; // max messages stored per conversation
const PI_SESSION_TIMEOUT_MS = 5 * 60 * 1000;
const PI_SESSION_SWEEP_INTERVAL_MS = 15 * 1000;
const MAX_JSON_PAYLOAD_SIZE = 50 * 1024 * 1024; // 50MB for JSON API requests
const MAX_UPLOAD_PAYLOAD_SIZE = 50 * 1024 * 1024; // 50MB for file uploads
const MAX_LOG_FILE_SIZE = 10 * 1024 * 1024; // 10MB per log file
const MAX_ROTATED_LOG_FILES = 3;
const PDFTOTEXT_TIMEOUT_MS = 15 * 1000;
const PDFTOTEXT_MAX_BUFFER = 10 * 1024 * 1024;

let activeLibraryIndexJob = null;
let lastLibraryIndexJob = null;

const DATA_DIR = path.join(os.homedir(), "dive");
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
const OLLAMA_SETTINGS_FILE = path.join(DATA_DIR, "ollama-settings.json");
const NOTES_FILE = path.join(DATA_DIR, "notes.json");
const LIBRARY_INDEX_JOB_FILE = path.join(DATA_DIR, "library-index-job.json");
const LIBRARY_INDEX_ERROR_FILE = path.join(
  DATA_DIR,
  "library-index-errors.jsonl",
);
const LIBRARY_INDEXED_FILES_EXPORT_FILE = path.join(
  DATA_DIR,
  "indexed-epub-files.txt",
);
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
      path.join(
        __dirname,
        "node_modules",
        "dompurify",
        "dist",
        "purify.min.js",
      ),
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
const COMMON_BINARY_DIRS =
  process.platform === "win32"
    ? []
    : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
const PI_COMMAND_CANDIDATES =
  process.platform === "win32"
    ? ["pi.cmd", "pi.exe", "pi"]
    : ["/opt/homebrew/bin/pi", "/usr/local/bin/pi", "pi"];
const VALID_UI_PALETTES = new Set([
  "orange",
  "grey",
  "solarised",
  "forest",
  "calmblue",
  "retro",
  "nordic",
  "carbon",
]);
const CLOUD_PROVIDERS = ["openai", "anthropic", "mistral", "google"];
const CLOUD_PROVIDER_SET = new Set(CLOUD_PROVIDERS);
// Image attachments: extensions we accept on upload and their MIME types.
const IMAGE_MIME_BY_EXT = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

// Normalize an inbound image-attachment payload from the client into a clean
// list of { dataBase64, mimeType, name }. Anything malformed is dropped so a
// bad attachment can never corrupt a model request.
function normalizeAttachmentImages(images) {
  if (!Array.isArray(images)) return [];
  const out = [];
  for (const img of images) {
    if (!img || typeof img !== "object") continue;
    const dataBase64 = typeof img.dataBase64 === "string" ? img.dataBase64 : "";
    const mimeType = typeof img.mimeType === "string" ? img.mimeType : "";
    if (!dataBase64 || !mimeType) continue;
    out.push({
      dataBase64,
      mimeType,
      name: typeof img.name === "string" ? img.name : "",
    });
    if (out.length >= 8) break;
  }
  return out;
}

function extForImageMime(mimeType) {
  for (const [ext, mime] of IMAGE_MIME_BY_EXT) {
    if (mime === mimeType) return ext;
  }
  return ".img";
}
const CLOUD_DEFAULT_MODELS = {
  openai: "gpt-5",
  anthropic: "claude-opus-4-8",
  mistral: "mistral-large-latest",
  google: "gemini-2.5-pro",
};
const CLOUD_DEFAULT_BASE_URLS = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  mistral: "https://api.mistral.ai/v1",
  google: "https://generativelanguage.googleapis.com/v1beta/openai",
};
const CLOUD_ENV_KEY_NAMES = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  mistral: "MISTRAL_API_KEY",
  google: "GEMINI_API_KEY",
};
const CLOUD_MIN_MAX_TOKENS = 1;
const CLOUD_MAX_MAX_TOKENS = 128000;
const CLOUD_DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_UI_FONTS = Object.freeze({
  ollama: '"iA Writer Quattro S", serif',
  pi: "Montserrat, sans-serif",
  cloud: "Sen, sans-serif",
  lmstudio: "Marcellus, serif",
  llamacpp: "Montserrat, sans-serif",
});
// Every mode that has its own persisted palette/font.
const UI_SETTINGS_MODE_KEYS = ["ollama", "pi", "cloud", "lmstudio", "llamacpp"];
const LEGACY_DEFAULT_UI_FONT = '"Space Mono", monospace';

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
  console.error("Refusing to run Dive as root. Run as an unprivileged user.");
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

function persistAsyncWakeTurn(convId, response, metadata = {}) {
  if (!convId || !response) return;
  try {
    const convs = loadConversations();
    const idx = convs.findIndex((c) => c.id === convId);
    if (idx === -1) return; // nothing to attach this turn to

    const history = Array.isArray(convs[idx].history)
      ? convs[idx].history.slice()
      : [];
    const lastIdx = history.length - 1;
    const lastMsg = lastIdx >= 0 ? history[lastIdx] : null;

    // Merge if the last message is an empty assistant response (likely a failed attempt)
    if (
      lastMsg &&
      lastMsg.role === "assistant" &&
      (!lastMsg.content || !lastMsg.content.trim())
    ) {
      lastMsg.content = response;
      if (typeof metadata.thinking === "string" && metadata.thinking.trim()) {
        lastMsg.thinking = metadata.thinking;
      }
      lastMsg.status = "async_wake";
    } else {
      const assistantMessage = { role: "assistant", content: response };
      if (typeof metadata.thinking === "string" && metadata.thinking.trim()) {
        assistantMessage.thinking = metadata.thinking;
      }
      assistantMessage.status = "async_wake";
      history.push(assistantMessage);
    }

    if (history.length > MAX_HISTORY_MESSAGES) {
      history.splice(0, history.length - MAX_HISTORY_MESSAGES);
    }
    convs[idx].history = history;
    convs[idx].updatedAt = Date.now();
    saveConversations(convs);
    appendSecurityEvent("pi_async_wake_persisted", { convId });
  } catch (e) {
    console.error("Failed to persist async-wake Pi turn:", e.message || e);
  }
}

function upsertConversation(
  saveConv,
  convTitle,
  message,
  messages,
  response,
  mode = "ollama",
  metadata = {},
) {
  const piSessionFile =
    mode === "pi" && saveConv && piConvProcesses.has(saveConv)
      ? piConvProcesses.get(saveConv).sessionFile
      : null;
  if (!saveConv) return;
  const convs = loadConversations();
  const assistantMessage = { role: "assistant", content: response };
  if (
    Array.isArray(metadata.librarySources) &&
    metadata.librarySources.length
  ) {
    assistantMessage.librarySources = metadata.librarySources;
  }
  if (Array.isArray(metadata.passages) && metadata.passages.length) {
    assistantMessage.passages = metadata.passages;
  }
  if (typeof metadata.thinking === "string" && metadata.thinking.trim()) {
    assistantMessage.thinking = metadata.thinking;
  }
  if (Array.isArray(metadata.traceEvents) && metadata.traceEvents.length) {
    assistantMessage.traceEvents = metadata.traceEvents;
  }
  if (Array.isArray(metadata.traceLines) && metadata.traceLines.length) {
    assistantMessage.traceLines = metadata.traceLines;
  }
  if (typeof metadata.status === "string" && metadata.status.trim()) {
    assistantMessage.status = metadata.status.trim().slice(0, 80);
  }
  // Client-supplied history can carry raw stream events on earlier assistant
  // turns (full thinking accumulations, session ids). Sanitize at the write
  // boundary so re-saving a conversation never re-inflates it.
  const newHistory = [
    ...messages
      .filter((item) => !isTransientLibraryContextMessage(item))
      .map((item) => {
        if (!item || !Array.isArray(item.traceEvents)) return item;
        const cleanEvents = item.traceEvents
          .map((evt) => sanitizeTraceEventForStorage(evt))
          .filter(Boolean);
        const copy = { ...item };
        if (cleanEvents.length) copy.traceEvents = cleanEvents;
        else delete copy.traceEvents;
        return copy;
      }),
    assistantMessage,
  ];
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

// Upsert a full conversation supplied by the client. Used to persist an
// interrupted turn: the normal stream "done" save never fires on abort, so the
// client posts the in-memory history (user + partial assistant) here so it
// survives in the History panel and across reloads, for every mode.
function saveClientConversation(id, title, mode, rawMessages) {
  if (!id || !Array.isArray(rawMessages)) return;
  const allowedRoles = new Set(["system", "user", "assistant", "tool"]);
  const history = rawMessages
    .filter(
      (m) =>
        m &&
        typeof m === "object" &&
        allowedRoles.has(m.role) &&
        typeof m.content === "string",
    )
    .map((m) => {
      const item = { role: m.role, content: m.content };
      if (Array.isArray(m.librarySources) && m.librarySources.length)
        item.librarySources = m.librarySources;
      if (Array.isArray(m.passages) && m.passages.length)
        item.passages = m.passages;
      if (typeof m.thinking === "string" && m.thinking.trim())
        item.thinking = m.thinking;
      if (Array.isArray(m.traceEvents) && m.traceEvents.length) {
        // Client snapshots carry raw stream events — sanitize each one so
        // accumulated thinking strings / session ids never reach disk.
        const cleanEvents = m.traceEvents
          .map((evt) => sanitizeTraceEventForStorage(evt))
          .filter(Boolean);
        if (cleanEvents.length) item.traceEvents = cleanEvents;
      }
      if (Array.isArray(m.traceLines) && m.traceLines.length)
        item.traceLines = m.traceLines;
      if (typeof m.status === "string" && m.status.trim())
        item.status = m.status.trim().slice(0, 80);
      return item;
    });
  if (!history.length) return;
  if (history.length > MAX_HISTORY_MESSAGES) {
    history.splice(0, history.length - MAX_HISTORY_MESSAGES);
  }
  const convs = loadConversations();
  const firstUser = history.find((m) => m.role === "user");
  const finalTitle =
    (typeof title === "string" && title.trim()) ||
    (firstUser ? firstUser.content.slice(0, 40) : "Conversation");
  const existing = convs.findIndex((c) => c.id === id);
  if (existing >= 0) {
    convs[existing].history = history;
    convs[existing].updatedAt = Date.now();
    convs[existing].mode = mode;
  } else {
    convs.unshift({
      id,
      title: finalTitle,
      mode,
      history,
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
    book_search: true,
    britannica: true,
    wiktionary: true,
    deep_etymology: true,
    deep_research: true,
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

function assertBuiltinSkillEnabled(skillName) {
  if (!Object.prototype.hasOwnProperty.call(defaultSkillsConfig(), skillName)) {
    return;
  }
  const config = loadSkillsConfig();
  if (config[skillName] === false) {
    throw new Error(`Skill "${skillName}" is disabled in Skills settings.`);
  }
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

// ---- Notes: individual Markdown files in DATA_DIR/notes ----
const NOTES_DIR = path.join(DATA_DIR, "notes");
const ACTIVE_NOTE_FILE = path.join(NOTES_DIR, ".active");
const NOTE_MAX_CHARS = 200000;

// A note name is the .md filename without extension. Strict allowlist keeps
// path traversal impossible and filenames portable.
function sanitizeNoteName(raw) {
  const cleaned = String(raw || "")
    .replace(/\.md$/i, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 80)
    .trim();
  return cleaned;
}

function noteFilePath(name) {
  const clean = sanitizeNoteName(name);
  if (!clean) {
    const error = new Error("Invalid note name.");
    error.statusCode = 400;
    throw error;
  }
  const filePath = path.join(NOTES_DIR, `${clean}.md`);
  if (!filePath.startsWith(NOTES_DIR + path.sep)) {
    const error = new Error("Invalid note path.");
    error.statusCode = 400;
    throw error;
  }
  return { name: clean, filePath };
}

// One-time migration: the legacy single note (notes.json) becomes Notes.md.
// The legacy file is kept as a backup, never deleted.
function migrateLegacyNotes() {
  try {
    fs.mkdirSync(NOTES_DIR, { recursive: true });
    const hasNotes = fs
      .readdirSync(NOTES_DIR)
      .some((entry) => entry.toLowerCase().endsWith(".md"));
    if (hasNotes || !fs.existsSync(NOTES_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(NOTES_FILE, "utf8"));
    const text = typeof raw.text === "string" ? raw.text : "";
    if (text.trim()) {
      fs.writeFileSync(path.join(NOTES_DIR, "Notes.md"), text, "utf8");
      setActiveNoteName("Notes");
    }
  } catch (e) {
    console.error("Notes migration failed:", e.message || e);
  }
}

function getActiveNoteName() {
  try {
    const raw = fs.readFileSync(ACTIVE_NOTE_FILE, "utf8").trim();
    const clean = sanitizeNoteName(raw);
    if (clean && fs.existsSync(path.join(NOTES_DIR, `${clean}.md`))) {
      return clean;
    }
  } catch {
    /* no active marker yet */
  }
  return "";
}

function setActiveNoteName(name) {
  try {
    fs.mkdirSync(NOTES_DIR, { recursive: true });
    fs.writeFileSync(ACTIVE_NOTE_FILE, sanitizeNoteName(name), "utf8");
  } catch (e) {
    console.error("Could not persist active note:", e.message || e);
  }
}

function listNotes() {
  migrateLegacyNotes();
  let entries = [];
  try {
    entries = fs.readdirSync(NOTES_DIR).filter((entry) => {
      return entry.toLowerCase().endsWith(".md") && !entry.startsWith(".");
    });
  } catch {
    entries = [];
  }
  const notes = entries
    .map((entry) => {
      const filePath = path.join(NOTES_DIR, entry);
      let stat = null;
      try {
        stat = fs.statSync(filePath);
      } catch {
        return null;
      }
      return {
        name: entry.replace(/\.md$/i, ""),
        updatedAt: new Date(stat.mtimeMs).toISOString(),
        sizeBytes: stat.size,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  let active = getActiveNoteName();
  if (!active && notes.length) active = notes[0].name;
  return { notes, active };
}

function readNote(name) {
  const { name: clean, filePath } = noteFilePath(name);
  let text = "";
  let updatedAt = null;
  try {
    text = fs.readFileSync(filePath, "utf8");
    updatedAt = new Date(fs.statSync(filePath).mtimeMs).toISOString();
  } catch {
    text = "";
  }
  return { name: clean, text, updatedAt };
}

function writeNote(name, text) {
  const { name: clean, filePath } = noteFilePath(name);
  const body =
    String(text || "").length > NOTE_MAX_CHARS
      ? String(text).slice(0, NOTE_MAX_CHARS)
      : String(text || "");
  fs.mkdirSync(NOTES_DIR, { recursive: true });
  fs.writeFileSync(filePath, body, "utf8");
  setActiveNoteName(clean);
  return { name: clean, text: body, updatedAt: new Date().toISOString() };
}

// Create a note with a unique name derived from the requested title.
function createNote(title) {
  migrateLegacyNotes();
  const base = sanitizeNoteName(title) || "Untitled";
  let candidate = base;
  let counter = 2;
  while (fs.existsSync(path.join(NOTES_DIR, `${candidate}.md`))) {
    candidate = `${base} ${counter}`;
    counter += 1;
    if (counter > 500) throw new Error("Could not allocate a note name.");
  }
  return writeNote(candidate, "");
}

function renameNote(name, title) {
  const { name: fromName, filePath: fromPath } = noteFilePath(name);
  const toBase = sanitizeNoteName(title);
  if (!toBase) {
    const error = new Error("Invalid note title.");
    error.statusCode = 400;
    throw error;
  }
  if (toBase === fromName) return { name: fromName };
  const { name: toName, filePath: toPath } = noteFilePath(toBase);
  if (fs.existsSync(toPath)) {
    const error = new Error(`A note named "${toName}" already exists.`);
    error.statusCode = 409;
    throw error;
  }
  fs.renameSync(fromPath, toPath);
  if (getActiveNoteName() === fromName) setActiveNoteName(toName);
  return { name: toName };
}

function deleteNote(name) {
  const { name: clean, filePath } = noteFilePath(name);
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* already gone */
  }
  if (getActiveNoteName() === clean) {
    const { notes } = listNotes();
    setActiveNoteName(notes.length ? notes[0].name : "");
  }
  return listNotes();
}

// Legacy single-note API compatibility: reads/writes the active note.
function loadNotes() {
  migrateLegacyNotes();
  const active = getActiveNoteName() || listNotes().active;
  if (active) return readNote(active);
  return { name: "", text: "", updatedAt: null };
}

function saveNotes(text) {
  const active = getActiveNoteName() || listNotes().active || "Notes";
  return writeNote(active, text);
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

let cachedPiSettings = null;

function loadPiSettingsFromDisk() {
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

function loadPiSettings() {
  if (!cachedPiSettings) {
    cachedPiSettings = loadPiSettingsFromDisk();
  }
  return cachedPiSettings;
}

function savePiSettings(settings) {
  try {
    const sanitized = sanitizePiSettings(settings);
    fs.writeFileSync(PI_SETTINGS_FILE, JSON.stringify(sanitized, null, 2));
    cachedPiSettings = sanitized;
  } catch (e) {
    console.error("Failed to save Pi settings:", e);
  }
}

function normalizeFontStackValue(fontStack) {
  const trimmed = typeof fontStack === "string" ? fontStack.trim() : "";
  return trimmed.slice(0, 300) || DEFAULT_UI_FONTS.ollama;
}

function defaultUiSettings() {
  return {
    palettes: {
      ollama: "carbon",
      pi: "orange",
      cloud: "calmblue",
      lmstudio: "carbon",
      llamacpp: "forest",
    },
    fonts: {
      ...DEFAULT_UI_FONTS,
    },
    fontScales: {
      ollama: 1,
      pi: 1,
      cloud: 1,
      lmstudio: 1,
      llamacpp: 1,
    },
    enabledModes: ["lmstudio", "pi", "cloud"],
    defaultMode: "",
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
    fontScales: { ...defaults.fontScales },
    enabledModes: [...defaults.enabledModes],
    defaultMode: "",
  };

  if (
    raw.palettes &&
    typeof raw.palettes === "object" &&
    !Array.isArray(raw.palettes)
  ) {
    for (const modeName of UI_SETTINGS_MODE_KEYS) {
      if (VALID_UI_PALETTES.has(raw.palettes[modeName])) {
        next.palettes[modeName] = raw.palettes[modeName];
      }
    }
  }

  if (raw.fonts && typeof raw.fonts === "object" && !Array.isArray(raw.fonts)) {
    for (const modeName of UI_SETTINGS_MODE_KEYS) {
      if (typeof raw.fonts[modeName] === "string") {
        next.fonts[modeName] = normalizeFontStackValue(raw.fonts[modeName]);
      }
    }
  }

  // Per-mode font-size multiplier (clamped to the UI's supported range).
  if (
    raw.fontScales &&
    typeof raw.fontScales === "object" &&
    !Array.isArray(raw.fontScales)
  ) {
    for (const modeName of UI_SETTINGS_MODE_KEYS) {
      const value = Number(raw.fontScales[modeName]);
      if (Number.isFinite(value)) {
        next.fontScales[modeName] = Math.min(1.6, Math.max(0.7, value));
      }
    }
  }

  // Persist the enabled-modes list (which modes appear in the switcher).
  if (Array.isArray(raw.enabledModes)) {
    const allowed = new Set(UI_SETTINGS_MODE_KEYS);
    const filtered = raw.enabledModes.filter(
      (id) => typeof id === "string" && allowed.has(id),
    );
    next.enabledModes = filtered.length ? filtered : [...defaults.enabledModes];
  }

  // The mode preselected when the app opens. Must be an enabled mode; empty
  // means "first enabled mode" (legacy behavior).
  if (
    typeof raw.defaultMode === "string" &&
    UI_SETTINGS_MODE_KEYS.includes(raw.defaultMode) &&
    next.enabledModes.includes(raw.defaultMode)
  ) {
    next.defaultMode = raw.defaultMode;
  }

  return next;
}

function loadUiSettingsWithMeta() {
  const exists = fs.existsSync(UI_SETTINGS_FILE);
  if (exists) {
    try {
      const raw = JSON.parse(fs.readFileSync(UI_SETTINGS_FILE, "utf8"));
      const sanitized = sanitizeUiSettings(raw);
      const rawFonts =
        raw?.fonts && typeof raw.fonts === "object" && !Array.isArray(raw.fonts)
          ? raw.fonts
          : {};
      const isLegacyUntouchedFontSet = ["ollama", "pi", "cloud"].every(
        (modeName) =>
          !rawFonts[modeName] ||
          normalizeFontStackValue(rawFonts[modeName]) ===
            LEGACY_DEFAULT_UI_FONT,
      );
      if (isLegacyUntouchedFontSet) {
        sanitized.fonts = { ...DEFAULT_UI_FONTS };
      }
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
    // Agent mode: plan-first prompting and a larger tool-call budget.
    agentMode: false,
    agentMaxRounds: 25,
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
    agentMode: existing.agentMode === true,
    agentMaxRounds: clampNumber(existing.agentMaxRounds, 1, 50, 25),
  };

  if (CLOUD_PROVIDER_SET.has(raw.provider)) {
    next.provider = raw.provider;
  }
  if (typeof raw.agentMode === "boolean") {
    next.agentMode = raw.agentMode;
  }
  if (raw.agentMaxRounds !== undefined) {
    next.agentMaxRounds = clampNumber(raw.agentMaxRounds, 1, 50, 25);
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

// ---- Local OpenAI-compatible modes: LM Studio and llama.cpp ----
// Both expose an OpenAI-style /v1/chat/completions (SSE) + /v1/models with no
// auth. They are first-class bespoke modes with their own endpoints, but share
// this OpenAI-format request/stream code internally.
const LOCAL_MODE_DEFAULTS = {
  lmstudio: { label: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1" },
  llamacpp: { label: "llama.cpp", baseUrl: "http://127.0.0.1:8080/v1" },
};
const LOCAL_MODE_IDS = Object.keys(LOCAL_MODE_DEFAULTS);
const LOCAL_MODEL_SETTINGS_FILE = path.join(
  DATA_DIR,
  "local-model-settings.json",
);

function normalizeLocalBaseUrl(url, fallback) {
  let s = String(url || "").trim();
  if (!s) return fallback;
  s = s.replace(/\/+$/, "");
  // Accept a bare host[:port] or a full URL; ensure it targets the /v1 base.
  if (!/^https?:\/\//i.test(s)) s = "http://" + s;
  if (!/\/v\d+$/.test(s)) s = s + "/v1";
  return s;
}

// Sampling parameters accepted by both LM Studio and llama.cpp's
// /v1/chat/completions (min/max/default), verified against their API docs.
const LOCAL_PARAM_SPEC = {
  temperature: { min: 0, max: 2, def: 0.3 },
  top_p: { min: 0, max: 1, def: 0.95 },
  top_k: { min: 0, max: 500, def: 40 },
  min_p: { min: 0, max: 1, def: 0.05 },
  repeat_penalty: { min: 0.8, max: 2, def: 1.1 },
  presence_penalty: { min: -2, max: 2, def: 0 },
  frequency_penalty: { min: -2, max: 2, def: 0 },
  max_tokens: { min: -1, max: 131072, def: -1 },
  seed: { min: -1, max: 2147483647, def: -1 },
};
const LOCAL_PARAM_KEYS = Object.keys(LOCAL_PARAM_SPEC);

function defaultLocalParams() {
  const p = {};
  for (const k of LOCAL_PARAM_KEYS) p[k] = LOCAL_PARAM_SPEC[k].def;
  return p;
}

function sanitizeLocalParams(raw) {
  const out = defaultLocalParams();
  if (raw && typeof raw === "object") {
    for (const k of LOCAL_PARAM_KEYS) {
      const v = raw[k];
      if (typeof v === "number" && Number.isFinite(v)) {
        out[k] = Math.min(
          LOCAL_PARAM_SPEC[k].max,
          Math.max(LOCAL_PARAM_SPEC[k].min, v),
        );
      }
    }
  }
  return out;
}

function defaultLocalModelSettings() {
  const out = {};
  for (const id of LOCAL_MODE_IDS) {
    out[id] = {
      baseUrl: LOCAL_MODE_DEFAULTS[id].baseUrl,
      model: "",
      params: defaultLocalParams(),
      // Offer skills/MCP as native OpenAI tools (XML fallback stays available).
      nativeTools: true,
      // Agent mode: plan-first prompting and a larger tool-call budget.
      agentMode: false,
      agentMaxRounds: 25,
    };
  }
  return out;
}

function sanitizeLocalModelSettings(raw) {
  const defaults = defaultLocalModelSettings();
  const out = defaultLocalModelSettings();
  if (raw && typeof raw === "object") {
    for (const id of LOCAL_MODE_IDS) {
      const entry = raw[id];
      if (entry && typeof entry === "object") {
        if (typeof entry.baseUrl === "string" && entry.baseUrl.trim()) {
          out[id].baseUrl = normalizeLocalBaseUrl(
            entry.baseUrl,
            defaults[id].baseUrl,
          );
        }
        if (typeof entry.model === "string") out[id].model = entry.model.trim();
        out[id].params = sanitizeLocalParams(entry.params);
        out[id].nativeTools = entry.nativeTools !== false;
        out[id].agentMode = entry.agentMode === true;
        const rounds = Number(entry.agentMaxRounds);
        out[id].agentMaxRounds = Number.isFinite(rounds)
          ? Math.min(50, Math.max(1, Math.round(rounds)))
          : 25;
      }
    }
  }
  return out;
}

function saveLocalModelSettings(settings) {
  const sanitized = sanitizeLocalModelSettings(settings);
  fs.writeFileSync(
    LOCAL_MODEL_SETTINGS_FILE,
    JSON.stringify(sanitized, null, 2),
  );
  return sanitized;
}

function loadLocalModelSettings() {
  if (fs.existsSync(LOCAL_MODEL_SETTINGS_FILE)) {
    try {
      const raw = JSON.parse(
        fs.readFileSync(LOCAL_MODEL_SETTINGS_FILE, "utf8"),
      );
      return sanitizeLocalModelSettings(raw);
    } catch (e) {
      console.warn("Failed to load local-model settings:", e.message || e);
    }
  }
  return defaultLocalModelSettings();
}

// Build an OpenAI-compatible /chat/completions request (streaming) for a local
// server. Images are attached to the latest user turn as image_url parts.
function buildLocalOpenAiRequest(
  baseUrl,
  model,
  messages,
  images,
  params,
  tools,
) {
  const p = sanitizeLocalParams(params);
  const imageList = normalizeAttachmentImages(images);
  let outMessages = Array.isArray(messages) ? messages : [];
  if (imageList.length) {
    outMessages = outMessages.map((m) => ({ ...m }));
    for (let i = outMessages.length - 1; i >= 0; i--) {
      if (outMessages[i].role !== "user") continue;
      const textContent =
        typeof outMessages[i].content === "string"
          ? outMessages[i].content
          : "";
      const parts = [];
      if (textContent) parts.push({ type: "text", text: textContent });
      for (const img of imageList) {
        parts.push({
          type: "image_url",
          image_url: { url: `data:${img.mimeType};base64,${img.dataBase64}` },
        });
      }
      outMessages[i].content = parts;
      break;
    }
  }
  const body = {
    messages: outMessages,
    stream: true,
    stream_options: { include_usage: true },
    // Standard OpenAI-schema fields.
    temperature: p.temperature,
    top_p: p.top_p,
  };
  // max_tokens: -1 (or 0) means "no cap" — omit so the server decides.
  if (p.max_tokens > 0) body.max_tokens = p.max_tokens;
  // presence/frequency penalties are OpenAI-schema; only send when non-zero.
  if (p.presence_penalty !== 0) body.presence_penalty = p.presence_penalty;
  if (p.frequency_penalty !== 0) body.frequency_penalty = p.frequency_penalty;
  if (p.seed >= 0) body.seed = p.seed;
  // Extra samplers accepted by LM Studio and llama.cpp (not in the strict
  // OpenAI schema, but both honour them).
  if (p.top_k > 0) body.top_k = p.top_k;
  if (p.min_p > 0) body.min_p = p.min_p;
  body.repeat_penalty = p.repeat_penalty;
  // llama.cpp serves whatever model is loaded and ignores this; LM Studio uses
  // it to select among loaded models. Only send it when the user picked one.
  if (model) body.model = model;
  // Native OpenAI tool calling (skills + MCP as JSON schemas).
  if (Array.isArray(tools) && tools.length) body.tools = tools;
  return {
    url: buildCloudEndpoint(baseUrl, "/chat/completions"),
    headers: { "Content-Type": "application/json" },
    body,
  };
}

async function streamLocalOpenAiCompletion({
  baseUrl,
  model,
  messages,
  images,
  params,
  tools,
  signal,
  onDelta,
  onUsage,
  onReasoning,
  onToolCall,
}) {
  const request = buildLocalOpenAiRequest(
    baseUrl,
    model,
    messages,
    images,
    params,
    tools,
  );
  let upstreamRes;
  try {
    upstreamRes = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal,
    });
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    throw createHttpError(
      502,
      `Could not reach the local server at ${request.url}. Is it running? (${e.message})`,
    );
  }
  if (!upstreamRes.ok) {
    const raw = await upstreamRes.text().catch(() => "");
    throw createHttpError(
      upstreamRes.status,
      `Local model request failed (${upstreamRes.status}): ${(raw || upstreamRes.statusText || "empty response body").slice(0, 700)}`,
    );
  }
  if (!upstreamRes.body) {
    throw createHttpError(502, "Local model returned no stream body.");
  }

  let latestUsage = null;
  // Native tool calls stream as fragments keyed by index: the name arrives in
  // the first fragment, the JSON arguments accumulate across the rest.
  const toolCallsByIndex = new Map();
  const parser = createSseParser((_eventName, data) => {
    if (data === "[DONE]") return;
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch (e) {
      return;
    }
    if (parsed?.error) {
      throw createHttpError(
        502,
        parsed.error?.message || "Local model stream error.",
      );
    }
    if (parsed.usage) {
      latestUsage = normalizeUsage("openai", parsed.usage);
      if (latestUsage && typeof onUsage === "function") onUsage(latestUsage);
    }
    // Reasoning models (e.g. Gemma "thinking") emit chain-of-thought in a
    // separate field — surface it as thinking, like Ollama/Cloud do.
    const d = parsed.choices?.[0]?.delta || {};
    const reasoning = d.reasoning_content ?? d.reasoning;
    if (
      typeof reasoning === "string" &&
      reasoning &&
      typeof onReasoning === "function"
    ) {
      onReasoning(reasoning);
    }
    if (Array.isArray(d.tool_calls)) {
      if (toolCallsByIndex.size === 0 && typeof onToolCall === "function") {
        // First tool-call fragment of this round: the caller can stop
        // streaming interim text to the reply bubble.
        onToolCall();
      }
      for (const fragment of d.tool_calls) {
        if (!fragment || typeof fragment !== "object") continue;
        const index = typeof fragment.index === "number" ? fragment.index : 0;
        let call = toolCallsByIndex.get(index);
        if (!call) {
          call = { id: "", name: "", arguments: "" };
          toolCallsByIndex.set(index, call);
        }
        if (typeof fragment.id === "string" && fragment.id) {
          call.id = fragment.id;
        }
        if (
          typeof fragment.function?.name === "string" &&
          fragment.function.name &&
          !call.name
        ) {
          call.name = fragment.function.name;
        }
        if (typeof fragment.function?.arguments === "string") {
          call.arguments += fragment.function.arguments;
        }
      }
    }
    const delta = d.content;
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
  return {
    usage: latestUsage,
    toolCalls: [...toolCallsByIndex.values()].filter((call) => call.name),
  };
}

async function fetchLocalModels(modeId) {
  const settings = loadLocalModelSettings();
  const baseUrl = normalizeLocalBaseUrl(
    settings[modeId]?.baseUrl,
    LOCAL_MODE_DEFAULTS[modeId].baseUrl,
  );
  let res;
  try {
    const endpoint =
      modeId === "lmstudio"
        ? baseUrl.replace(/\/v1$/, "") + "/api/v1/models"
        : buildCloudEndpoint(baseUrl, "/models");
    res = await fetch(endpoint, {
      method: "GET",
    });
  } catch (e) {
    throw createHttpError(
      502,
      `Could not reach the local server at ${baseUrl}. Is it running? (${e.message})`,
    );
  }
  if (!res.ok) {
    throw createHttpError(res.status, `Model list failed (${res.status}).`);
  }
  const data = await res.json().catch(() => null);
  const modelsList = Array.isArray(data?.models)
    ? data.models
    : Array.isArray(data?.data)
      ? data.data
      : [];
  const allIds = modelsList.map((m) => m?.key || m?.id).filter(Boolean);
  // Embedding models (e.g. LM Studio's bundled
  // text-embedding-nomic-embed-text-v1.5) are listed by /v1/models but cannot
  // chat — keep them out of the chat dropdown and report them separately so
  // the Database settings can offer them as embedding backends.
  const models = allIds.filter((id) => !/embed/i.test(id));
  const embeddingModels = allIds.filter((id) => /embed/i.test(id));
  // The OpenAI-compat /v1/models list is used for model IDs, but we extract the
  // actual loaded context window from the v1 loaded_instances config (or
  // llama.cpp's /props), so the UI can show "used / context".
  const root = baseUrl.replace(/\/v\d+$/, "");
  let contextLength = null;
  try {
    if (modeId === "lmstudio") {
      const loadedModel = modelsList.find(
        (m) => m && m.loaded_instances?.length > 0,
      );
      if (loadedModel) {
        contextLength = loadedModel.loaded_instances[0].config?.context_length;
      }
    } else {
      const r = await fetch(root + "/props", { method: "GET" });
      if (r.ok) {
        const d = await r.json().catch(() => null);
        const n = d?.default_generation_settings?.n_ctx ?? d?.n_ctx;
        if (typeof n === "number") contextLength = n;
      }
    }
  } catch (_e) {
    // context length is best-effort
  }
  return { models, embeddingModels, contextLength };
}

// Resolve "Automatic" (empty model) to a concrete model id for a local server.
// Ollama JIT-loads on any request, but LM Studio returns 400 "No models
// loaded" when asked to chat with no model specified and none loaded. So when
// the user picked Automatic we name a model explicitly: prefer one that is
// already loaded (no reload cost), else the first non-embedding model the
// server reports (LM Studio JIT-loads it). Returns "" if none can be found, in
// which case the request proceeds as before (llama.cpp serves its loaded model).
async function resolveAutomaticLocalModel(modeId, baseUrl) {
  const root = baseUrl.replace(/\/v\d+$/, "");
  // 1) An already-loaded model (LM Studio's native endpoint reports state).
  try {
    const r = await fetch(root + "/api/v0/models", { method: "GET" });
    if (r.ok) {
      const d = await r.json().catch(() => null);
      const list = Array.isArray(d?.data) ? d.data : [];
      const loaded = list.find(
        (m) => m && m.state === "loaded" && !/embed/i.test(m.id || ""),
      );
      if (loaded && loaded.id) return loaded.id;
    }
  } catch (_e) {
    // best-effort; fall through to the OpenAI-compatible list
  }
  // 2) First non-embedding model the server has available to load.
  try {
    const { models } = await fetchLocalModels(modeId);
    if (Array.isArray(models) && models.length) return models[0];
  } catch (_e) {
    // leave unresolved
  }
  return "";
}

// Is a given model already loaded on the server? (LM Studio native endpoint.)
async function lmStudioModelIsLoaded(baseUrl, model) {
  const root = baseUrl.replace(/\/v\d+$/, "");
  try {
    const r = await fetch(root + "/api/v0/models", {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return null; // endpoint absent -> unknown
    const d = await r.json().catch(() => null);
    const list = Array.isArray(d?.data) ? d.data : [];
    return list.some((m) => m && m.id === model && m.state === "loaded");
  } catch (_e) {
    return null;
  }
}

// Explicitly load a model into LM Studio. JIT loading is unreliable / can be
// disabled, so we don't depend on it: the REST load endpoint deterministically
// loads the model (and does NOT evict an already-loaded embedding model, so
// library indexing keeps working). Best-effort: returns true on success, false
// if the endpoint is unavailable or the load fails, in which case the caller
// proceeds and lets the chat request surface any real error.
async function loadLmStudioModel(baseUrl, model) {
  if (!model) return false;
  const root = baseUrl.replace(/\/v\d+$/, "");
  // v1 is the current endpoint; fall back to the legacy v0 path.
  for (const path of ["/api/v1/models/load", "/api/v0/models/load"]) {
    try {
      const r = await fetch(root + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
        // Loading a large model can take a while; allow up to 10 minutes.
        signal: AbortSignal.timeout(600000),
      });
      if (r.ok) {
        const d = await r.json().catch(() => null);
        if (!d || d.status === "loaded" || d.instance_id || d.type) return true;
      }
      // 404 -> try the next path; other non-OK -> give up on this path.
      if (r.status !== 404) break;
    } catch (_e) {
      // network error: stop trying, let the chat request report it
      break;
    }
  }
  return false;
}

// For LM Studio: make sure the chosen chat model is loaded before we send the
// chat request, so the user never has to load one manually (their indexer may
// have loaded only an embedding model). No-op for llama.cpp (it always serves
// the model it was started with) and when there is no concrete model to load.
async function ensureLocalChatModelLoaded(modeId, baseUrl, model, onStatus) {
  if (modeId !== "lmstudio" || !model) return;
  if ((await lmStudioModelIsLoaded(baseUrl, model)) === true) return;
  if (typeof onStatus === "function") onStatus(model);
  await loadLmStudioModel(baseUrl, model);
}

// Shared streaming handler for the bespoke local modes (LM Studio, llama.cpp).
// Remove any skill-call syntax that survived the streaming loop so it can never
// reach the chat bubble. Covers three cases the local models produce that Ollama
// does not: a completed <call:...></call> when skills were disabled (DB on), a
// malformed call missing its closing tag, and a dangling opener at end of text.
function stripLeakedSkillCalls(text) {
  return (
    String(text || "")
      // Completed call blocks: <call:name>args</call>.
      .replace(/<call:[^>]*>[\s\S]*?<\/call>/gi, "")
      // Malformed call: opener plus a JSON argument object but no closing tag.
      // Only the opener and its args are removed so real answer text survives.
      .replace(/<call:[^>]*>\s*\{[^{}]*\}/gi, "")
      // A bare opener/partial left dangling at the very end of the text.
      .replace(/<call:[^>]*>?\s*$/i, "")
      .trim()
  );
}

// Derive the source pills (title + URL) from a skill result so the UI can show
// every source it consulted, the same way library passages are surfaced. Covers
// web_search result lists, <!-- url --> citation comments, and web_scraper URLs.
function hostTitleFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function extractSkillSources(toolName, argsObj, resultText) {
  const text = String(resultText || "");
  const sources = [];
  const seen = new Set();
  const add = (title, url) => {
    const clean = String(url || "").trim();
    if (!/^https?:\/\//i.test(clean) || seen.has(clean)) return;
    seen.add(clean);
    sources.push({
      title: String(title || hostTitleFromUrl(clean)).slice(0, 140),
      url: clean,
    });
  };
  // web_search list: "N. Title" line followed by a "URL: <url>" line.
  const lines = text.split("\n");
  let lastTitle = "";
  for (const line of lines) {
    const t = line.match(/^\s*\d+\.\s*(.+?)\s*$/);
    if (t) {
      lastTitle = t[1].trim();
      continue;
    }
    const u = line.match(/^\s*URL:\s*(\S+)/i);
    if (u) {
      add(lastTitle, u[1]);
      lastTitle = "";
    }
  }
  // Citation comments used by wikipedia/britannica/wiktionary: <!-- https://... -->
  const commentRe = /<!--\s*(https?:\/\/\S+?)\s*-->/g;
  let m;
  while ((m = commentRe.exec(text)) !== null) add(hostTitleFromUrl(m[1]), m[1]);
  // web_scraper reads a single URL passed as an argument.
  if (toolName === "web_scraper" && argsObj && argsObj.url) {
    add(hostTitleFromUrl(argsObj.url), argsObj.url);
  }
  // book_search lists its providers as markdown links on a "Sources:" line.
  if (toolName === "book_search") {
    const BOOK_PROVIDER_LABELS = {
      openlibrary: "Open Library",
      google: "Google Books",
      goodreads: "Goodreads",
      storygraph: "StoryGraph",
      hardcover: "Hardcover",
      librarything: "LibraryThing",
      calibre: "Calibre",
    };
    // Only the links inside the sources comment become pills — the Cover
    // link stays a plain hyperlink in the reply.
    const sourcesComment = text.match(/<!--\s*sources:([\s\S]*?)-->/i);
    const scope = sourcesComment ? sourcesComment[1] : text;
    const linkRe = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
    let link;
    while ((link = linkRe.exec(scope)) !== null) {
      add(BOOK_PROVIDER_LABELS[link[1]] || link[1], link[2]);
    }
  }
  return sources;
}

// Parse a tool-call argument string without throwing.
function safeParseArgs(argStr) {
  try {
    return JSON.parse(argStr);
  } catch {
    return {};
  }
}

// Skill web sources must survive into the saved conversation: merge them into
// the librarySources persisted on the assistant message (deduped by URL) so
// the source pills re-render when the chat is reopened from history.
function mergeWebSourceResults(existing, incoming) {
  const merged = Array.isArray(existing) ? [...existing] : [];
  const seen = new Set(
    merged
      .map((item) => (item && item.url ? String(item.url) : ""))
      .filter(Boolean),
  );
  for (const source of Array.isArray(incoming) ? incoming : []) {
    if (!source) continue;
    const url = source.url ? String(source.url) : "";
    if (url && seen.has(url)) continue;
    if (url) seen.add(url);
    merged.push(source);
  }
  return merged;
}

async function handleLocalModeStream(modeId, req, res, send) {
  let finished = false;
  const abortController = new AbortController();
  const traceEvents = [];
  const emit = (event) => {
    const stored = sanitizeTraceEventForStorage(event);
    if (stored) traceEvents.push(stored);
    if (!res.writableEnded) res.write(JSON.stringify(event) + "\n");
  };
  try {
    const body = await parseJsonBody(req);
    if (!body || typeof body.message !== "string" || !body.message.trim()) {
      send(400, { error: "message is required" });
      return;
    }
    const settings = loadLocalModelSettings();
    const conf = settings[modeId] || {};
    const baseUrl = normalizeLocalBaseUrl(
      conf.baseUrl,
      LOCAL_MODE_DEFAULTS[modeId].baseUrl,
    );
    // Client sends explicit "" when "Automatic" is selected.
    // Prefer the client's explicit choice; fall back to server saved setting only
    // when the client sent nothing (undefined), not when it sent empty string.
    let model =
      body.model !== undefined
        ? typeof body.model === "string"
          ? body.model.trim()
          : ""
        : conf.model || "";
    // "Automatic" (empty model): name a concrete model so LM Studio can load
    // it, instead of erroring with "No models loaded". llama.cpp is unaffected
    // (it serves whatever it was started with), and if nothing resolves we
    // leave it empty and proceed as before.
    if (!model) {
      model = await resolveAutomaticLocalModel(modeId, baseUrl);
    }
    // Prefer params from the request; fall back to the saved per-mode config.
    const params = sanitizeLocalParams(body.params || conf.params);
    const { history = [], saveConv, convTitle, library } = body;
    const originalMessage = body.message;
    const slashCommand = parseSlashCommand(originalMessage);
    const message = getCommandMessage(slashCommand, originalMessage);
    const messages = normalizeCloudHistoryMessages(history, message);
    const storedMessages = normalizeStoredConversationMessages(
      history,
      originalMessage,
    );
    // Hard-mode override (proofread / translate): bypass policy, library, skills.
    const systemOverride =
      typeof body.systemOverride === "string" ? body.systemOverride.trim() : "";
    let requestMessages = systemOverride
      ? [{ role: "system", content: systemOverride }, ...messages]
      : withSharedSystemPrompt(messages);
    let librarySourceResults = [];
    let libraryPassages = [];
    let databaseContextEnabled = false;
    let output = "";
    let usage = null;
    let thinking = "";
    let emittedThinkingStart = false;

    res.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    req.on("close", () => {
      if (!finished) abortController.abort();
    });
    emitSlashCommand(emit, slashCommand);

    // Tracks whether model-callable skills are offered this turn.
    // Stays false in hard-mode (systemOverride), DB-context, and slash commands.
    let localSkillsEnabled = false;
    // Native OpenAI tool calling (per-mode setting, default on). Falls back to
    // the XML path mid-request if the server rejects the `tools` parameter.
    let nativeToolsEnabled = false;
    let nativeTools = [];
    let skillsPromptMessage = null;
    // Agent mode raises the tool-call budget and switches the prompt to a
    // plan-first workflow. The default budget suits quick lookups only.
    const agentModeEnabled = conf.agentMode === true;
    const maxRounds = agentModeEnabled
      ? Math.min(50, Math.max(1, Number(conf.agentMaxRounds) || 25))
      : 6;
    if (!systemOverride) {
      try {
        const libraryContext = await buildChatLibraryContext(
          message,
          getLibraryRequestForCommand(library, slashCommand, history, modeId),
        );
        if (libraryContext.enabled) {
          databaseContextEnabled = true;
          requestMessages[0] = {
            role: "system",
            content: getSharedAssistantPolicyPrompt(true),
          };
          requestMessages = insertLibraryContextMessage(
            requestMessages,
            libraryContext.contextMessage,
          );
          librarySourceResults = serializeLibraryResults(
            getLibraryContextSourceResults(libraryContext),
            getLibraryRequestForCommand(library, slashCommand, history),
          );
          libraryPassages = Array.isArray(libraryContext.contextResults)
            ? libraryContext.contextResults
            : [];
          emit({
            type: "library_results",
            results: librarySourceResults,
            passages: libraryPassages,
            meta: libraryContext.contextMeta,
          });
        }
      } catch (e) {
        emit({ type: "library_error", error: e.message });
      }

      // Optional user-selected system prompt overlay (topbar prompt dropdown),
      // applied only when Database Context is off, right after the base policy.
      const promptOverlay =
        typeof body.promptOverlay === "string" ? body.promptOverlay.trim() : "";
      if (promptOverlay && !databaseContextEnabled) {
        requestMessages = [
          requestMessages[0],
          {
            role: "system",
            content: `Additional user-selected overlay instructions (secondary to the built-in default policy):\n\n${promptOverlay}`,
          },
          ...requestMessages.slice(1),
        ];
      }

      // Skills work exactly like Cloud: offered only when Database Context is off
      // (the DB-on prompt answers strictly from library passages) and not a slash
      // command. Tool-calling-trained models get them as native OpenAI tools;
      // the <call:...> XML mechanism stays as the fallback.
      localSkillsEnabled = !slashCommand && !databaseContextEnabled;
      if (localSkillsEnabled) {
        if (conf.nativeTools !== false) {
          nativeTools = getLocalNativeTools();
          nativeToolsEnabled = nativeTools.length > 0;
        }
        const skillsPrompt = getCloudSkillsPolicyPrompt({
          nativeToolCalling: nativeToolsEnabled,
          agentMode: agentModeEnabled,
          agentMaxRounds: maxRounds,
        });
        if (skillsPrompt) {
          skillsPromptMessage = { role: "system", content: skillsPrompt };
          requestMessages = [
            requestMessages[0],
            skillsPromptMessage,
            ...requestMessages.slice(1),
          ];
        }
      }
    }

    if (isSkillSlashCommand(slashCommand)) {
      try {
        const toolCall = buildForcedSkillToolCall(slashCommand);
        emit({
          type: "tool_start",
          toolName: slashCommand.skillName,
          argsPreview: toolCall.function.arguments.slice(0, 300),
        });
        const result = await executeToolCallWithConfirmation(toolCall, emit);
        appendForcedSkillResult(requestMessages, slashCommand, result);
        emit({
          type: "tool_end",
          toolName: slashCommand.skillName,
          outputPreview: String(result || "").slice(0, 300),
          isError: /^Error:/i.test(String(result || "")),
        });
      } catch (e) {
        emit({ type: "error", error: e.message });
        if (!res.writableEnded) res.end();
        return;
      }
    }

    const seenSkillCalls = new Set();
    // Text the model wrote in a round that ended with a tool call is interim
    // (plan, notes, false starts) — it belongs in the thinking stream, never
    // in the reply bubble.
    const moveInterimTextToThinking = () => {
      if (!output.trim()) return;
      if (!emittedThinkingStart) {
        emittedThinkingStart = true;
        emit({ type: "thinking_start" });
      }
      const interim = `\n\n[Interim notes]\n${output.trim()}\n`;
      thinking += interim;
      emit({ type: "thinking_delta", delta: interim, thinking });
    };
    // When the budget runs out, end with an answer instead of an error: stop
    // offering tools and tell the model to write its final reply.
    const exhaustToolBudget = () => {
      localSkillsEnabled = false;
      nativeToolsEnabled = false;
      requestMessages = [
        ...requestMessages,
        {
          role: "user",
          content:
            "[TOOL BUDGET EXHAUSTED] You have used every allowed tool call for this request. Do not call any more tools. Write your complete final answer now from everything you already found.",
        },
      ];
      if (!emittedThinkingStart) {
        emittedThinkingStart = true;
        emit({ type: "thinking_start" });
      }
      const note = "\n\n[Tool budget exhausted — writing final answer]\n";
      thinking += note;
      emit({ type: "thinking_delta", delta: note, thinking });
      output = "";
      emit({ type: "delta", delta: "", response: output });
    };
    // Runs a single tool call (shared by the native and XML paths): emits the
    // trace events, applies the repeated-call guard, executes, and reports
    // any sources the skill returned.
    const runLocalToolCall = async (toolCall) => {
      if (!emittedThinkingStart) {
        emittedThinkingStart = true;
        emit({ type: "thinking_start" });
      }
      const startMsg = `\n\n[Running tool: ${toolCall.function.name}...]\n`;
      thinking += startMsg;
      emit({ type: "thinking_delta", delta: startMsg, thinking });
      emit({
        type: "tool_start",
        toolName: toolCall.function.name,
        argsPreview: toolCall.function.arguments.slice(0, 300),
      });

      // Loop guard: if the model repeats the exact same call (a common failure
      // mode for small models that keep re-searching), don't run it again —
      // tell it to answer from what it has. This prevents runaway recursion.
      const callKey = `${toolCall.function.name}:${toolCall.function.arguments
        .replace(/\s+/g, "")
        .toLowerCase()}`;
      let result;
      if (seenSkillCalls.has(callKey)) {
        result = `You already ran ${toolCall.function.name} with these exact arguments and have the results above. Do not repeat this call. Answer the user's question now using what you already found.`;
      } else {
        seenSkillCalls.add(callKey);
        try {
          result = await executeToolCallWithConfirmation(toolCall, emit);
        } catch (toolError) {
          result = `Error: ${toolError.message}`;
        }
      }

      emit({
        type: "tool_end",
        toolName: toolCall.function.name,
        outputPreview: String(result || "").slice(0, 300),
        isError: /^Error:/i.test(String(result || "")),
      });
      const localSources = extractSkillSources(
        toolCall.function.name,
        safeParseArgs(toolCall.function.arguments),
        result,
      );
      if (localSources.length) {
        librarySourceResults = mergeWebSourceResults(
          librarySourceResults,
          localSources,
        );
        emit({ type: "web_sources", sources: localSources });
      }
      const endMsg = `[Finished tool: ${toolCall.function.name}]\n`;
      thinking += endMsg;
      emit({ type: "thinking_delta", delta: endMsg, thinking });
      return result;
    };

    // Load the chosen model if LM Studio doesn't have it in memory yet, so the
    // user never gets "No models loaded" after the indexer loaded only an
    // embedder. Surfaced as a thinking line during the (one-time) load.
    await ensureLocalChatModelLoaded(modeId, baseUrl, model, (loadingModel) => {
      if (!emittedThinkingStart) {
        emittedThinkingStart = true;
        emit({ type: "thinking_start" });
      }
      const note = `\n\n[Loading model ${loadingModel} into ${modeId}…]\n`;
      thinking += note;
      emit({ type: "thinking_delta", delta: note, thinking });
    });

    let round = 0;
    for (;;) {
      // Once a native tool call starts streaming, everything the model wrote
      // this round is interim — stop mirroring it to the reply bubble.
      let sawToolCallThisRound = false;
      let streamResult;
      try {
        streamResult = await streamLocalOpenAiCompletion({
          baseUrl,
          model,
          messages: requestMessages,
          // Attach the image only on the first (user) round.
          images: round === 0 ? body.images : undefined,
          params,
          tools: nativeToolsEnabled ? nativeTools : undefined,
          signal: abortController.signal,
          onToolCall: () => {
            if (sawToolCallThisRound) return;
            sawToolCallThisRound = true;
            emit({ type: "delta", delta: "", response: "" });
          },
          onDelta: (delta) => {
            output += delta;
            if (sawToolCallThisRound) return;
            if (output.includes("<call:")) return;
            // Send the raw output (including any trailing partial "<call") so the
            // client can hide it and show the animated drum icon, matching Ollama.
            emit({
              type: "delta",
              delta,
              response: output,
            });
          },
          onReasoning: (chunk) => {
            if (!emittedThinkingStart) {
              emittedThinkingStart = true;
              emit({ type: "thinking_start" });
            }
            thinking += chunk;
            emit({ type: "thinking_delta", delta: chunk, thinking });
          },
          onUsage: (nextUsage) => {
            usage = nextUsage;
          },
        });
      } catch (streamError) {
        // The server rejected the native `tools` parameter (e.g. llama.cpp
        // started without --jinja): retry the same round on the XML path.
        if (nativeToolsEnabled && streamError?.statusCode === 400) {
          nativeToolsEnabled = false;
          if (skillsPromptMessage) {
            skillsPromptMessage.content = getCloudSkillsPolicyPrompt({
              agentMode: agentModeEnabled,
              agentMaxRounds: maxRounds,
            });
          }
          output = "";
          continue;
        }
        throw streamError;
      }
      if (streamResult.usage) usage = streamResult.usage;

      // Native path: the model asked for tools through the OpenAI schema.
      const nativeCalls = localSkillsEnabled ? streamResult.toolCalls : [];
      if (nativeCalls.length) {
        if (round >= maxRounds) {
          exhaustToolBudget();
          continue;
        }
        round += 1;
        const assistantToolCalls = nativeCalls.map((call, i) => ({
          id: call.id || `call_${round}_${i}`,
          type: "function",
          function: {
            name: call.name,
            arguments: call.arguments || "{}",
          },
        }));
        requestMessages = [
          ...requestMessages,
          {
            role: "assistant",
            content: output,
            tool_calls: assistantToolCalls,
          },
        ];
        for (const assistantCall of assistantToolCalls) {
          const result = await runLocalToolCall({
            function: {
              name: assistantCall.function.name,
              arguments: assistantCall.function.arguments,
            },
          });
          requestMessages = [
            ...requestMessages,
            {
              role: "tool",
              tool_call_id: assistantCall.id,
              content: String(result ?? ""),
            },
          ];
        }
        // Reset the accumulated text so the final reply is ONLY what the model
        // writes after the tool results; anything interim goes to thinking.
        moveInterimTextToThinking();
        output = "";
        emit({ type: "delta", delta: "", response: output });
        continue;
      }

      // XML fallback path: models without native tool support (or servers
      // that ignore `tools`) emit the prompt-taught <call:...> syntax.
      const xmlMatch = localSkillsEnabled
        ? output.match(/<call:([^>]+)>(.*?)<\/call>/is)
        : null;
      if (!xmlMatch) break;

      output = output.replace(xmlMatch[0], "").trim();
      if (round >= maxRounds) {
        exhaustToolBudget();
        continue;
      }
      round += 1;

      const toolCall = {
        function: { name: xmlMatch[1].trim(), arguments: xmlMatch[2].trim() },
      };
      const result = await runLocalToolCall(toolCall);

      if (output) {
        requestMessages = [
          ...requestMessages,
          { role: "assistant", content: output },
        ];
      }
      requestMessages = [
        ...requestMessages,
        {
          role: "user",
          content: `[SKILL RESULT: ${toolCall.function.name}]\n\n${result}\n\nUsing this skill result, write your complete final answer to the user's question now. Do not repeat this skill call.`,
        },
      ];
      // Reset the accumulated text so the final reply is ONLY what the model
      // writes after seeing the skill result. Otherwise any answer it produced
      // BEFORE calling the skill stays prepended and the reply looks duplicated.
      moveInterimTextToThinking();
      output = "";
      emit({ type: "delta", delta: "", response: output });
    }

    // Final safety net: never let raw skill-call syntax reach the bubble, even
    // if a call was malformed or emitted while skills were disabled (DB on).
    output = stripLeakedSkillCalls(output);
    emit({ type: "delta", delta: "", response: output });

    if (emittedThinkingStart) {
      emit({ type: "thinking_end", thinking });
    }

    finished = true;
    upsertConversation(
      saveConv,
      convTitle,
      originalMessage,
      storedMessages,
      output,
      modeId,
      {
        librarySources: librarySourceResults,
        passages: libraryPassages,
        thinking,
        traceEvents,
      },
    );
    emit({ type: "done", response: output, usage, model });
    if (!res.writableEnded) res.end();
  } catch (e) {
    const isAbort = e?.name === "AbortError";
    if (!finished) finished = true;
    if (!res.writableEnded) {
      if (!res.headersSent) {
        send(isAbort ? 499 : e.statusCode || 500, {
          error: isAbort ? "Request cancelled." : e.message,
        });
      } else {
        emit({
          type: "error",
          error: isAbort ? "Request cancelled." : e.message,
        });
        res.end();
      }
    }
  }
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

// Cloud keys the web-search skills can reuse as high-quality search backends.
// Whichever the user already saved (or set via env) is used, else DuckDuckGo.
function getCloudSearchKeys() {
  const settings = loadCloudSettings();
  return {
    openai: getCloudApiKey(settings, "openai") || "",
    anthropic: getCloudApiKey(settings, "anthropic") || "",
    google: getCloudApiKey(settings, "google") || "",
  };
}

function redactCloudSettings(settings) {
  const sanitized = sanitizeCloudSettings(settings, defaultCloudSettings());
  return {
    provider: sanitized.provider,
    models: sanitized.models,
    baseUrls: sanitized.baseUrls,
    maxTokens: sanitized.maxTokens,
    agentMode: sanitized.agentMode,
    agentMaxRounds: sanitized.agentMaxRounds,
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

// Prompt used when Database Context is ON: answer strictly and only from the
// retrieved local-library passages, no tools. Kept identical to the Ollama/Pi
// DB-on prompt so every mode behaves the same when its database is enabled.
const DB_ON_PROMPT = `You are a meticulous academic research assistant writing for scholars, professors, and advanced readers. You are precise, explanatory, and intellectually serious. Never use emojis.

Always respond in the language the user speaks to you in. When you write in English, use British English spelling and conventions (e.g. "colour", "analyse", "recognise", "-ise" endings).

### SOLE SOURCE: THE LOCAL LIBRARY PASSAGES
The passages retrieved from the user's local library, included in this turn, are your only source of evidence. Answer strictly and exclusively from them.

Grounding (non-negotiable):
- Use ONLY the provided passages. Do not introduce outside knowledge, do not reason beyond what the text supports, do not call any tools, and never invent facts, quotations, titles, dates, or page references.
- If the passages do not contain enough to answer, say so explicitly and state precisely what is and is not supported by the available text. Do not fill gaps with general knowledge or speculation.

Scholarly method (how to write the answer):
- Be explicative, not extractive. Explain the evidence, define key terms, and develop the reasoning — do not return a bare quotation or a one-line summary when the passages support a fuller account.
- Synthesize across passages: connect related points, and where passages agree, diverge, or qualify one another, make those relationships explicit.
- Distinguish the principal account from variants, exceptions, or marginal/editorial notes, and flag uncertainty, ambiguity, or gaps in the evidence.
- Quote sparingly, only when the exact wording matters; otherwise paraphrase faithfully and accurately.

Attribution (mandatory):
- Name the source of every factual claim inside the sentence, in prose — e.g. "According to Oppenheim's La antigua Mesopotamia…", "As Apolodoro's Biblioteca records…".
- Do not rely on source boxes, bracketed numbers, hyperlinks, or vague formulations such as "some accounts say" or "it is said". Tie each claim to the specific work or author it comes from.

Be concise but substantive: academic, direct, and genuinely informative. Avoid padding, filler, and hedging.`;

// Prompt used when Database Context is OFF: the academic assistant with tool
// access. The cloud tool list itself is added separately as the skills prompt.
const DB_OFF_POLICY_PROMPT = `You are an academic and concise assistant. You get straight to the point. Never use emojis.

Always respond in the language the user speaks to you in. When you write in English, use British English spelling and conventions (e.g. "colour", "analyse", "recognise", "-ise" endings).

If the user asks you to proofread or check grammar, return ONLY the corrected, polished text — no explanation, no commentary, no alternative versions.

If the user asks you to translate a text, return ONLY the translation in the requested language — no explanation, no commentary, no notes.

For any factual, encyclopedic, biographical, definitional, historical, or current-information question, use the available tools (Wikipedia, Britannica, Wiktionary, web search, etc.) rather than relying on your own training data, which is often outdated or inaccurate. Reserve your own knowledge for reasoning, explanation, writing, and language help. Never invent facts, citations, sources, dates, or page references; if no tool covers something and you cannot verify it, say so plainly.`;

function getSharedAssistantPolicyPrompt(databaseEnabled = false) {
  return databaseEnabled === true ? DB_ON_PROMPT : DB_OFF_POLICY_PROMPT;
}

function withSharedSystemPrompt(messages, databaseEnabled = false) {
  const sourceMessages = Array.isArray(messages) ? messages : [];
  return [
    {
      role: "system",
      content: getSharedAssistantPolicyPrompt(databaseEnabled),
    },
    ...sourceMessages,
  ];
}

const CLOUD_SKILL_EXAMPLES = {
  wikipedia: '{"query": "Bob Dylan", "language": "en"}',
  britannica: '{"query": "Bob Dylan"}',
  wiktionary: '{"word": "algorithm", "language": "en"}',
  deep_etymology: '{"word": "eventualmente", "language": "es"}',
  deep_research:
    '{"queries": ["Dean Benedetti biography", "Dean Benedetti Charlie Parker recordings", "Dean Benedetti jazz saxophonist history"]}',
  duckduckgo: '{"query": "latest AI news"}',
  fact_check: '{"claim": "The moon is made of cheese"}',
  web_scraper: '{"url": "https://example.com"}',
  calculator: '{"expression": "2 + 2 * 4"}',
  local_notes: '{"action": "read"}',
  time_and_date: '{"timezone": "Australia/Sydney"}',
  shell_command: '{"command": "ls"}',
};

function getCloudSkillsPolicyPrompt(options = {}) {
  const nativeToolCalling = options.nativeToolCalling === true;
  const agentMode = options.agentMode === true;
  const agentMaxRounds = Number(options.agentMaxRounds) || 25;
  const skillsConfig = loadSkillsConfig();
  const enabledSkills = ALL_SKILLS.filter(
    (skill) => skillsConfig[skill.function.name] !== false,
  );
  const customSkills = loadCustomSkills().filter(
    (skill) =>
      skill && typeof skill.name === "string" && skill.name.trim().length > 0,
  );
  if (!enabledSkills.length && !customSkills.length) return "";

  const lines = [
    "### SKILLS & TOOL USAGE (MANDATORY)",
    "You have access to external tools (skills) that fetch live, verifiable information or perform local actions. Skill results are your primary source of truth.",
    "",
    "RULES:",
    "1. If Database Context/local library passages are provided in the current turn, the local database has priority. Answer from those passages first and call skills only if they are insufficient or the user explicitly requested a specific tool.",
    "2. Otherwise, for ANY question involving facts, people, places, events, news, dates, definitions, word origins, calculations, unit conversions, the current time or date, or the content of a URL, you MUST call the relevant skill BEFORE answering, even if you believe you already know the answer.",
    "3. Base your answer on the skill results. Use your own training knowledge only when the skills return no useful result or an error, and in that case explicitly tell the user that the lookup failed or returned nothing.",
    "4. Purely creative, conversational, or text-transformation requests (rewriting, translating, proofreading, or summarizing text the user provided) do not require skills.",
    "",
  ];
  if (nativeToolCalling) {
    // Native mode: the tool list (names, descriptions, JSON schemas) travels
    // in the request's `tools` array, so don't duplicate it in the prompt.
    lines.push(
      "HOW TO CALL A SKILL:",
      "Call tools ONLY through your native function-calling mechanism. NEVER write tool-call syntax (XML, JSON, or code blocks) in your reply text.",
      "Call one tool at a time. After receiving a result you may call another tool if needed.",
      "",
      "ONLY the tools provided in your tool list exist and are enabled. Never invent a tool name. If a tool result says a tool is disabled, do not call it again; use an enabled one.",
      "",
    );
  } else {
    lines.push("Available skills:");
    let index = 1;
    for (const skill of enabledSkills) {
      const name = skill.function.name;
      const example = CLOUD_SKILL_EXAMPLES[name] || "{}";
      lines.push(
        `${index}. **${name}:** ${skill.function.description}\n   - Example: <call:${name}>${example}</call>`,
      );
      index += 1;
    }
    for (const custom of customSkills) {
      lines.push(
        `${index}. **${custom.name}:** ${custom.description || "User-defined custom skill."}\n   - Example: <call:${custom.name}>{}</call>`,
      );
      index += 1;
    }
    // Connected MCP tools are callable through the same XML mechanism (the
    // executor routes mcp__ names to the MCP client), so list them for the
    // XML-driven modes: Cloud and local-mode fallback. Ollama gets MCP tools
    // natively via its own tools API instead.
    for (const mcpTool of getMcpOllamaTools()) {
      lines.push(
        `${index}. **${mcpTool.function.name}:** ${mcpTool.function.description}\n   - Example: <call:${mcpTool.function.name}>{}</call>`,
      );
      index += 1;
    }
    lines.push(
      "",
      "HOW TO CALL A SKILL:",
      "Output exactly one XML block in this exact format and then stop writing:",
      '<call:skill_name>{"arg": "value"}</call>',
      "The system intercepts the block, executes the skill, and sends you the result so you can continue your answer.",
      "Call one skill at a time. After receiving a result you may call another skill if needed.",
      "",
      "ONLY the skills listed above exist and are enabled. Any skill NOT in that list is disabled — never call it. If a skill result says a skill is disabled, do not call it again; use an enabled one.",
      "",
    );
  }
  if (agentMode) {
    lines.push(
      `AGENT WORKFLOW (up to ${agentMaxRounds} tool calls for this request):`,
      "For any task that needs multiple steps (research, comparing sources, gathering material, writing notes):",
      "1. FIRST think through a short numbered plan of the steps you intend to take. Keep it to one line per step.",
      "2. Execute the plan one tool call at a time. After each result, decide whether the plan still holds; revise it if a step failed or a result changed the picture.",
      "3. Never repeat a call that already failed with the same arguments — change the approach instead.",
      "4. When the plan is complete (or further calls stop adding information), write the final answer synthesizing everything you found.",
      "CRITICAL — WHERE TO WRITE WHAT: the plan and your notes between steps belong in your reasoning/thinking, NEVER in the reply text. While you still intend to call more tools, output NOTHING as reply text — no plan, no progress notes, no partial answers. The ONLY prose you ever write as reply text is the single final answer, after your last tool call.",
      "AMBIGUITY: If a name or term is ambiguous, resolve it with ONE clarifying lookup or answer for the most prominent match and note the assumption in one sentence.",
      "",
    );
  } else {
    lines.push(
      "RESEARCH CHAIN (follow strictly, maximum 4 skill calls per question):",
      "For factual, biographical, current-events, or 'who/what is X' questions:",
      "1. Call deep_research with 'queries' holding 2-4 VARIED angles (different phrasing and scope).",
      "2. If it returns nothing useful, retry deep_research ONCE with completely different phrasing.",
      "3. If that also fails, call wikipedia and britannica on the topic and answer from them.",
      "4. After at most 4 skill calls you MUST stop calling skills and write your answer from whatever you have; if nothing was found, say plainly that you could not verify the topic. Never repeat a failed call and never keep deliberating about whether to search again.",
      "AMBIGUITY: If a name or term is ambiguous (multiple people or topics match) or you cannot tell who the user means, do NOT search repeatedly — answer for the most prominent match and note the assumption in one sentence, or say you cannot confidently identify the subject and ask which one they mean.",
      "",
    );
  }
  lines.push(
    "ANSWER LENGTH AND STYLE:",
    "When the skill results contain rich material, write a COMPREHENSIVE, well-structured answer — multiple detailed paragraphs covering background, key facts, context, and significance, integrating all the sources. When the material is thin, write a shorter accurate answer instead of inflating it. FORBIDDEN: filler adverbs and adjectives, empty intensifiers ('truly remarkable', 'deeply fascinating', 'incredibly important'), and padding sentences that add no facts. Clean, precise, academic prose only — depth must come from information, never from decoration.",
    "",
    "SOURCES:",
    "Do NOT write source links, a 'Source:' line, a 'References' section, or URLs in your answer. The app shows every source used as a clickable pill automatically. Just write the answer itself.",
  );
  return lines.join("\n");
}

// The OpenAI `tools` array offered natively to LM Studio / llama.cpp:
// built-in skills (already OpenAI function schemas), user custom skills, and
// connected MCP tools. Tool-calling-trained models (Gemma, Qwen, Hermes,
// Llama 3.x) are far more reliable with this than with prompt-injected XML;
// the XML <call:...> path remains as fallback for servers that reject `tools`.
function getLocalNativeTools() {
  const skillsConfig = loadSkillsConfig();
  const tools = ALL_SKILLS.filter(
    (skill) => skillsConfig[skill.function.name] !== false,
  ).map((skill) => ({
    type: "function",
    function: {
      name: skill.function.name,
      description: skill.function.description,
      parameters: skill.function.parameters || {
        type: "object",
        properties: {},
      },
    },
  }));
  for (const custom of loadCustomSkills()) {
    if (!custom || typeof custom.name !== "string" || !custom.name.trim()) {
      continue;
    }
    tools.push({
      type: "function",
      function: {
        name: custom.name.trim(),
        description: custom.description || "User-defined custom skill.",
        parameters: { type: "object", properties: {} },
      },
    });
  }
  for (const mcpTool of getMcpOllamaTools()) tools.push(mcpTool);
  return tools;
}

function isTransientLibraryContextMessage(item) {
  return (
    item?.role === "system" &&
    typeof item.content === "string" &&
    (item.content.startsWith(
      "Local library passages retrieved for the user's question.",
    ) ||
      item.content.startsWith(
        "Local library passages have already been retrieved for the user's question.",
      ) ||
      item.content.startsWith(
        "Database Context is enabled, so the local library has priority for this question.",
      ) ||
      item.content.startsWith(
        "Strict database-only mode is enabled for this question.",
      ))
  );
}

function sanitizeModelMessages(messages) {
  const allowedRoles = new Set(["system", "user", "assistant", "tool"]);
  return (Array.isArray(messages) ? messages : [])
    .filter(
      (item) =>
        item &&
        typeof item === "object" &&
        allowedRoles.has(item.role) &&
        typeof item.content === "string",
    )
    .map((item) => {
      const clean = {
        role: item.role,
        content: item.content,
      };
      if (Array.isArray(item.tool_calls)) clean.tool_calls = item.tool_calls;
      if (typeof item.name === "string") clean.name = item.name;
      if (typeof item.tool_call_id === "string") {
        clean.tool_call_id = item.tool_call_id;
      }
      return clean;
    });
}

function normalizeStoredConversationMessages(history, message) {
  const stored = [];
  const sourceHistory = Array.isArray(history) ? history : [];
  for (const item of sourceHistory) {
    if (!item || typeof item !== "object") continue;
    if (item.role !== "user" && item.role !== "assistant") continue;
    if (typeof item.content !== "string") continue;
    const clean = {
      role: item.role,
      content: item.content,
    };
    if (item.role === "assistant") {
      if (Array.isArray(item.librarySources)) {
        clean.librarySources = item.librarySources;
      }
      if (Array.isArray(item.passages)) {
        clean.passages = item.passages;
      }
      if (typeof item.thinking === "string") {
        clean.thinking = item.thinking;
      }
      if (Array.isArray(item.traceEvents)) {
        clean.traceEvents = item.traceEvents;
      }
      if (Array.isArray(item.traceLines)) {
        clean.traceLines = item.traceLines;
      }
      if (typeof item.status === "string") {
        clean.status = item.status;
      }
    }
    stored.push(clean);
  }
  stored.push({ role: "user", content: message });
  if (stored.length > MAX_HISTORY_MESSAGES) {
    return stored.slice(stored.length - MAX_HISTORY_MESSAGES);
  }
  return stored;
}

function serializeLibraryResults(results, options = {}) {
  const includeSourcePaths = options?.includeSourcePaths !== false;
  return (Array.isArray(results) ? results : []).map((result) => ({
    chunkId: result.chunkId,
    title: result.title,
    author: result.author,
    path: includeSourcePaths ? result.path : "",
    heading: result.heading,
    kind: result.kind,
    score: result.score,
    snippet: result.snippet,
  }));
}

function sanitizeTraceEventForStorage(event) {
  if (!event || typeof event !== "object") return null;
  const type = typeof event.type === "string" ? event.type : "";
  // Streaming micro-events are not stored: the full thinking text is already
  // persisted separately (metadata.thinking) and history replay never reads
  // them — keeping hundreds of one-word deltas only bloats conversations.
  if (
    !type ||
    type === "delta" ||
    type === "done" ||
    type === "heartbeat" ||
    type === "thinking_start" ||
    type === "thinking_delta" ||
    type === "thinking_end" ||
    type === "session_start"
  ) {
    return null;
  }
  const clean = { type };
  for (const key of [
    "label",
    "detail",
    "error",
    "command",
    "name",
    "skillName",
    "toolName",
    "argsPreview",
    "outputPreview",
    "chunk",
    "delta",
    "key",
    "text",
    "message",
    "noticeType",
    "model",
  ]) {
    if (typeof event[key] === "string") clean[key] = event[key].slice(0, 4000);
  }
  for (const key of [
    "isError",
    "failure",
    "success",
    "retrievedCount",
    "injectedCount",
    "uniqueSourceCount",
    "maxContextChars",
    "input",
    "output",
    "cost",
    "tokensBefore",
  ]) {
    if (typeof event[key] === "boolean" || typeof event[key] === "number") {
      clean[key] = event[key];
    }
  }
  if (Array.isArray(event.lines)) {
    clean.lines = event.lines
      .slice(0, 80)
      .map((line) => String(line).slice(0, 400));
  } else if (event.lines === null) {
    clean.lines = null;
  }
  if (Array.isArray(event.results)) {
    clean.results = serializeLibraryResults(event.results).slice(0, 50);
  }
  if (
    event.meta &&
    typeof event.meta === "object" &&
    !Array.isArray(event.meta)
  ) {
    clean.meta = {};
    for (const [key, value] of Object.entries(event.meta)) {
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        clean.meta[key] =
          typeof value === "string" ? value.slice(0, 1000) : value;
      }
    }
  }
  return clean;
}

function getLibraryContextSourceResults(libraryContext) {
  return Array.isArray(libraryContext?.contextResults)
    ? libraryContext.contextResults
    : libraryContext?.results;
}

function extractRecentLibrarySourceHints(history, limit = 4) {
  const hints = [];
  const seen = new Set();
  const items = Array.isArray(history) ? history : [];
  for (
    let index = items.length - 1;
    index >= 0 && hints.length < limit;
    index -= 1
  ) {
    const item = items[index];
    const sources = Array.isArray(item?.librarySources)
      ? item.librarySources
      : Array.isArray(item?.libraryResults)
        ? item.libraryResults
        : [];
    for (const source of sources) {
      const title = String(source?.title || "").trim();
      const author = String(source?.author || "").trim();
      const filePath = String(source?.path || "").trim();
      const key = `${title}|${author}|${filePath}`;
      if (!title && !author && !filePath) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      hints.push({ title, author, path: filePath });
      if (hints.length >= limit) break;
    }
  }
  return hints;
}

function insertLibraryContextMessage(messages, contextMessage) {
  if (!contextMessage) return messages;
  const nextMessages = Array.isArray(messages) ? [...messages] : [];
  const firstNonSystemIndex = nextMessages.findIndex(
    (item) => item.role !== "system",
  );
  if (firstNonSystemIndex === -1) {
    nextMessages.push(contextMessage);
  } else {
    nextMessages.splice(firstNonSystemIndex, 0, contextMessage);
  }
  return nextMessages;
}

function buildPiPromptWithLibraryContext(message, contextMessage) {
  if (!contextMessage?.content) return message;
  return `${contextMessage.content}\n\nUser request:\n${message}`;
}

function getCommandMessage(command, fallbackMessage) {
  if (!command) return fallbackMessage;
  return command.input || fallbackMessage;
}

function getLibraryRequestForCommand(
  library,
  command,
  history = [],
  mode = "",
) {
  const base = library && typeof library === "object" ? library : {};
  const sourceHints = extractRecentLibrarySourceHints(history);
  if (!isDatabaseSlashCommand(command)) {
    const request = { ...base };
    // Server-resolved chat mode wins over anything in the client payload so
    // per-mode search algorithm settings cannot be spoofed cross-mode.
    if (mode) request.mode = mode;
    if (sourceHints.length) request.sourceHints = sourceHints;
    return mode || sourceHints.length ? request : library;
  }
  return {
    ...base,
    enabled: true,
    strict: true,
    sourceHints,
    ...(mode ? { mode } : {}),
  };
}

function emitSlashCommand(emit, command) {
  if (!command || typeof emit !== "function") return;
  emit({
    type: "slash_command",
    command: command.name,
    commandType: command.type,
    skillName: command.skillName,
    label: command.label,
  });
}

function appendForcedSkillResult(messages, command, result) {
  messages.push({
    role: "user",
    content: `[FORCED SKILL RESULT: ${command.skillName}]\n\n${result}\n\nAnswer the user's request using this forced skill result. If the result is insufficient, say so. Do not call another skill unless the user asked for it explicitly.`,
  });
}

async function requestShellConfirmation({ emit, title, command, toolName }) {
  return await new Promise((resolve) => {
    const reqId = "ollama_req_" + Date.now() + "_" + randomUUID();
    const denialTimer = setTimeout(
      () => {
        if (ollamaToolRequests.has(reqId)) {
          ollamaToolRequests.delete(reqId);
          resolve(false);
          appendSecurityEvent("shell_command_timeout_denied", { reqId });
        }
      },
      5 * 60 * 1000,
    );
    ollamaToolRequests.set(reqId, {
      resolve,
      timer: denialTimer,
    });
    emit({
      type: "needs_ui",
      sessionId: reqId,
      request: {
        method: "confirm",
        title,
        message: `The AI wants to run the following shell command:\n\n${command}\n\nDo you want to allow this?`,
        requireUserInteraction: true,
        danger: true,
      },
    });
    appendSecurityEvent("shell_command_confirmation_requested", {
      reqId,
      tool: toolName,
    });
  });
}

async function executeToolCallWithConfirmation(toolCall, emit) {
  // A disabled skill must NOT crash the stream. Return an instructive result
  // so the model recovers by using one of its enabled skills instead.
  try {
    assertBuiltinSkillEnabled(toolCall.function.name);
  } catch (error) {
    const enabled = Object.entries(loadSkillsConfig())
      .filter(([, v]) => v !== false)
      .map(([k]) => k)
      .join(", ");
    return `${error.message} Do NOT call it again. Use one of your ENABLED skills instead (${enabled}) to answer the question.`;
  }
  const requiresShellConfirmation = skillRequiresShellConfirmation(
    toolCall.function.name,
    DATA_DIR,
  );
  let executeAllowed = true;
  if (requiresShellConfirmation) {
    executeAllowed = await requestShellConfirmation({
      emit,
      title: "Shell Command Execution Request",
      command: toolCall.function.arguments,
      toolName: toolCall.function.name,
    });
  }

  if (!executeAllowed) {
    appendSecurityEvent("shell_command_denied", {
      command: toolCall.function.arguments,
      tool: toolCall.function.name,
    });
    return "User denied permission to execute this shell command.";
  }

  if (toolCall.function.name.startsWith("mcp__")) {
    return await executeMcpTool(toolCall);
  }

  if (requiresShellConfirmation) {
    appendSecurityEvent("shell_command_executed", {
      command: toolCall.function.arguments,
      tool: toolCall.function.name,
    });
  }
  return await executeSkill(toolCall, {
    dataDir: DATA_DIR,
    allowShellCommand: requiresShellConfirmation,
    cloudKeys: getCloudSearchKeys(),
  });
}

function formatIndexedLibraryFilesExport(files, config) {
  const lines = [
    "Dive Indexed EPUB Files",
    `Generated: ${new Date().toISOString()}`,
    `Database: ${config.databasePath}`,
    `Total indexed EPUB files: ${files.length}`,
    "",
  ];
  files.forEach((file, index) => {
    const title = file.title || path.basename(file.path || "") || "Untitled";
    const author = file.author ? ` - ${file.author}` : "";
    lines.push(`${index + 1}. ${title}${author}`);
    lines.push(`   Path: ${file.path || ""}`);
    lines.push(`   Source: ${file.sourceName || file.sourceType || "unknown"}`);
    lines.push(`   Passages: ${file.chunkCount || 0}`);
    lines.push(`   Indexed: ${file.indexedAt || "unknown"}`);
    lines.push("");
  });
  return `${lines.join("\n").trimEnd()}\n`;
}

function buildCloudEndpoint(baseUrl, pathSuffix) {
  const normalized = String(baseUrl || "").replace(/\/+$/, "");
  return `${normalized}${pathSuffix}`;
}

function buildCloudRequest(provider, settings, messages, images) {
  const imageList = normalizeAttachmentImages(images);
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
    const systemParts = [];
    const anthropicMessages = [];
    for (const item of Array.isArray(messages) ? messages : []) {
      if (!item || typeof item !== "object") continue;
      if (item.role === "system") {
        if (typeof item.content === "string" && item.content.trim()) {
          systemParts.push(item.content.trim());
        }
        continue;
      }
      // The skill-call loop can produce consecutive same-role messages;
      // merge them so the request stays valid for strict role alternation.
      const previous = anthropicMessages[anthropicMessages.length - 1];
      if (previous && previous.role === item.role) {
        previous.content = `${previous.content}\n\n${item.content}`;
        continue;
      }
      anthropicMessages.push({ role: item.role, content: item.content });
    }
    if (imageList.length) {
      // Attach images to the most recent user turn as content blocks.
      for (let i = anthropicMessages.length - 1; i >= 0; i--) {
        if (anthropicMessages[i].role !== "user") continue;
        const textContent =
          typeof anthropicMessages[i].content === "string"
            ? anthropicMessages[i].content
            : "";
        const blocks = [];
        if (textContent) blocks.push({ type: "text", text: textContent });
        for (const img of imageList) {
          blocks.push({
            type: "image",
            source: {
              type: "base64",
              media_type: img.mimeType,
              data: img.dataBase64,
            },
          });
        }
        anthropicMessages[i].content = blocks;
        break;
      }
    }
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
        system: systemParts.join("\n\n"),
        messages: anthropicMessages,
        stream: true,
      },
    };
  }

  let outMessages = messages;
  if (imageList.length) {
    // OpenAI-compatible vision: the user turn's content becomes an array of
    // text + image_url (data URL) parts on the most recent user message.
    outMessages = (Array.isArray(messages) ? messages : []).map((m) => ({
      ...m,
    }));
    for (let i = outMessages.length - 1; i >= 0; i--) {
      if (outMessages[i].role !== "user") continue;
      const textContent =
        typeof outMessages[i].content === "string"
          ? outMessages[i].content
          : "";
      const parts = [];
      if (textContent) parts.push({ type: "text", text: textContent });
      for (const img of imageList) {
        parts.push({
          type: "image_url",
          image_url: { url: `data:${img.mimeType};base64,${img.dataBase64}` },
        });
      }
      outMessages[i].content = parts;
      break;
    }
  }
  const body = {
    model,
    messages: outMessages,
    max_tokens: maxTokens,
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
  images,
  signal,
  onDelta,
  onUsage,
}) {
  const request = buildCloudRequest(provider, settings, messages, images);
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

// Some models (Gemma via the Google endpoint, DeepSeek-R1, QwQ, …) put their
// chain-of-thought in a <thought>…</thought> (or <think>…</think>) block at the
// very start of the reply content. Split that leading block off so it can be
// routed to the collapsed thinking box instead of the answer bubble, matching
// every other mode. Only a block at the very start is treated as reasoning; a
// tag appearing later in the answer is left untouched.
function splitLeadingThought(raw) {
  const open = /^\s*<(thought|think)>/i.exec(raw);
  if (!open) {
    // The opener may still be arriving one character at a time — hold the
    // answer back until we know whether this is a reasoning block.
    const lead = raw.replace(/^\s*/, "").toLowerCase();
    if (
      lead &&
      lead.length < 9 &&
      ("<thought>".startsWith(lead) || "<think>".startsWith(lead))
    ) {
      return { thought: "", answer: "", opened: false, closed: false };
    }
    return { thought: "", answer: raw, opened: false, closed: false };
  }
  const close = `</${open[1].toLowerCase()}>`;
  const openEnd = open[0].length;
  const closeIdx = raw.toLowerCase().indexOf(close, openEnd);
  if (closeIdx === -1) {
    return {
      thought: raw.slice(openEnd),
      answer: "",
      opened: true,
      closed: false,
    };
  }
  return {
    thought: raw.slice(openEnd, closeIdx),
    answer: raw.slice(closeIdx + close.length),
    opened: true,
    closed: true,
  };
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
    top_p: clampOllamaNumber(raw.top_p, 0.75, 0, 1),
    top_k: clampOllamaInteger(raw.top_k, 40, 1, 1000),
    repeat_penalty: clampOllamaNumber(raw.repeat_penalty, 1.1, 0, 2),
    repeat_last_n: clampOllamaInteger(raw.repeat_last_n, 256, -1, 131072),
    num_predict: clampOllamaInteger(raw.num_predict, 2048, -1, 200000),
    num_ctx: clampOllamaInteger(raw.num_ctx, OLLAMA_DEFAULT_CTX, 256, 131072),
    seed: clampOllamaInteger(raw.seed, -1, -2147483648, 2147483647),
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

// Configurable Ollama server URL (persisted like the Cloud settings). Every
// Ollama HTTP request derives its host/port from ollamaConn() so the four
// call sites (chat/stream, ollamaChat, /api/tags, /api/models/info) stay in
// sync with whatever the user set in Settings.
const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
function loadOllamaBaseUrl() {
  try {
    if (fs.existsSync(OLLAMA_SETTINGS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(OLLAMA_SETTINGS_FILE, "utf8"));
      if (raw && typeof raw.baseUrl === "string" && raw.baseUrl.trim()) {
        return raw.baseUrl.trim();
      }
    }
  } catch (_e) {}
  return DEFAULT_OLLAMA_BASE_URL;
}
let ollamaBaseUrl = loadOllamaBaseUrl();
function saveOllamaBaseUrl(url) {
  ollamaBaseUrl =
    typeof url === "string" && url.trim()
      ? url.trim()
      : DEFAULT_OLLAMA_BASE_URL;
  try {
    fs.writeFileSync(
      OLLAMA_SETTINGS_FILE,
      JSON.stringify({ baseUrl: ollamaBaseUrl }, null, 2),
    );
  } catch (_e) {}
  return ollamaBaseUrl;
}
function ollamaConn() {
  try {
    const u = new URL(ollamaBaseUrl);
    return {
      hostname: u.hostname || "localhost",
      port: u.port ? Number(u.port) : 11434,
    };
  } catch (_e) {
    return { hostname: "localhost", port: 11434 };
  }
}

function ollamaChat(model, messages, options, tools = null) {
  let clientReq = null;
  const promise = new Promise((resolve, reject) => {
    const payloadObject = {
      model,
      messages: sanitizeModelMessages(messages),
      stream: false,
    };
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
      ...ollamaConn(),
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
      ...ollamaConn(),
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
    retryEmbeddings: job.retryEmbeddings === true,
    cancelRequested: job.cancelRequested === true,
    pauseRequested: job.pauseRequested === true,
    autoResumed: job.autoResumed === true,
    startedAt: job.startedAt,
    resumedAt: job.resumedAt || null,
    finishedAt: job.finishedAt || null,
    progress: job.progress || null,
    stats: job.stats || null,
    recentErrors: Array.isArray(job.recentErrors)
      ? job.recentErrors.slice(-10)
      : [],
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
  return Number.isFinite(processed) && processed > 0
    ? Math.floor(processed)
    : 0;
}

function appendLibraryIndexError(job, entry) {
  const record = {
    timestamp: new Date().toISOString(),
    jobId: job.id,
    ...entry,
  };
  job.recentErrors = [...(job.recentErrors || []), record].slice(-10);
  appendFileWithRotation(
    LIBRARY_INDEX_ERROR_FILE,
    `${JSON.stringify(record)}\n`,
  );
}

function readRecentLibraryIndexErrors(limit = 50) {
  try {
    if (!fs.existsSync(LIBRARY_INDEX_ERROR_FILE)) return [];
    const max = Math.min(200, Math.max(1, Number(limit) || 50));
    return fs
      .readFileSync(LIBRARY_INDEX_ERROR_FILE, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(-max)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (_error) {
          return { timestamp: "", kind: "parse_error", error: line };
        }
      });
  } catch (error) {
    console.error("Could not read library index error log:", error.message);
    return [];
  }
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
    retryEmbeddings: options.retryEmbeddings === true,
    cancelRequested: false,
    pauseRequested: false,
    autoResumed: options.autoResume === true,
    startedAt: options.startedAt || new Date().toISOString(),
    resumedAt: options.autoResume === true ? new Date().toISOString() : null,
    finishedAt: null,
    progress: resumeProgress,
    stats: null,
    recentErrors: [],
    error: null,
  };
  activeLibraryIndexJob = job;
  lastLibraryIndexJob = job;
  persistLibraryIndexJob(job);
  indexLibrary({
    force: job.force,
    prune: job.prune,
    compact: job.compact,
    retryEmbeddings: job.retryEmbeddings,
    startFileIndex,
    resumeFromPath: options.resumeFromPath || "",
    resumeProgress:
      startFileIndex > 0 || options.resumeFromPath ? resumeProgress : null,
    onProgress: (progress) => {
      job.progress = progress;
      // Progress fires per file AND per embedding batch — persisting each one
      // hammers the disk for hours on a big run. Crash-resume only needs a
      // recent snapshot, so throttle to one write every 2 seconds.
      const now = Date.now();
      if (!job._lastPersistMs || now - job._lastPersistMs >= 2000) {
        job._lastPersistMs = now;
        persistLibraryIndexJob(job);
      }
    },
    onError: (entry) => {
      appendLibraryIndexError(job, entry);
      job.progress = {
        ...(job.progress || {}),
        recentErrors: job.recentErrors.slice(-5),
        lastEmbeddingError: entry.error || entry.reason || "",
      };
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
  // Resume by the last in-flight file PATH (robust to list changes while the
  // app was down); the numeric index is only a fallback for old job files.
  const resumeFromPath =
    startFileIndex > 0 ? String(persisted.progress?.currentFile || "") : "";
  try {
    startLibraryIndexJob({
      id: persisted.id || randomUUID(),
      startedAt: persisted.startedAt || null,
      force: persisted.force === true,
      prune: persisted.prune !== false,
      compact: persisted.compact !== false,
      autoResume: true,
      resumeFromPath,
      resumeProgress:
        startFileIndex > 0 || resumeFromPath
          ? persisted.progress || null
          : null,
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
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
  const merged = [...baseEntries, ...COMMON_BINARY_DIRS];
  return Array.from(new Set(merged)).join(path.delimiter);
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
    const lookup =
      process.platform === "win32"
        ? spawnSync("where", ["pi"], {
            encoding: "utf8",
            env: {
              ...process.env,
              PATH: buildExecutablePath(process.env.PATH || ""),
            },
          })
        : spawnSync("/usr/bin/env", ["which", "pi"], {
            encoding: "utf8",
            env: {
              ...process.env,
              PATH: buildExecutablePath(process.env.PATH || ""),
            },
          });
    if (lookup.status === 0) {
      const found = (lookup.stdout || "").split(/\r?\n/)[0].trim();
      if (found) return found;
    }
  } catch (_error) {}
  return "pi"; // Fallback to PATH
}

function openPathInFileManager(targetPath, options = {}, callback = () => {}) {
  const normalizedPath = path.resolve(targetPath);
  const revealFile = options.revealFile === true;
  const exists = fs.existsSync(normalizedPath);
  const isFile = exists && fs.statSync(normalizedPath).isFile();

  if (process.platform === "darwin") {
    const args =
      revealFile && isFile ? ["-R", normalizedPath] : [normalizedPath];
    execFile("open", args, callback);
    return;
  }

  if (process.platform === "win32") {
    const args =
      revealFile && isFile
        ? [`/select,${normalizedPath}`]
        : [exists ? normalizedPath : path.dirname(normalizedPath)];
    execFile("explorer.exe", args, callback);
    return;
  }

  const directory =
    revealFile && isFile ? path.dirname(normalizedPath) : normalizedPath;
  execFile("xdg-open", [directory], callback);
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

// ---- Persistent per-conversation Pi event channels (SSE) ----
// The per-prompt NDJSON stream only lives as long as one prompt request.
// Events that arrive between turns (async subagent wakes, widget updates,
// orphaned-session captures) are pushed here instead, so the client never
// has to poll conversations.json to find out what happened.
const piEventChannels = new Map(); // convId -> Set<http.ServerResponse>

function broadcastPiConvEvent(convId, event) {
  if (!convId || !event) return;
  const subscribers = piEventChannels.get(convId);
  if (!subscribers || subscribers.size === 0) return;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of subscribers) {
    if (!res.writableEnded) {
      try {
        res.write(payload);
      } catch (_e) {}
    }
  }
}

function emitPiSessionEvent(session, event) {
  if (!session || !event) return;
  // Push to the conversation's persistent channel regardless of whether a
  // prompt stream is attached — the client dedupes by run state.
  broadcastPiConvEvent(session.convProc?.convId, event);
  if (!session.streamListeners) return;
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

// Pi extension widgets/status lines carry terminal ANSI colour codes; strip
// them so the web UI renders clean text.
function stripAnsi(text) {
  return String(text ?? "").replace(
    /\u001b\[[0-9;?]*[a-zA-Z]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b[@-Z\\^_]/g,
    "",
  );
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

  const wasQueued = session.queued;
  const convProc = session.convProc;

  // If the session ended in a provider error but hasn't actually finished the agent run,
  // we must NOT delete it yet. This keeps the session alive so that Pi's internal
  // auto-retries can still emit events to the original session ID, allowing the
  // browser to receive the recovered response on the same stream.
  // Terminal reasons (stale sweep, process death) must still reclaim it,
  // otherwise a retry that never resolves leaks the session forever.
  if (
    session.hadProviderError &&
    !session.done &&
    !session.closed &&
    reason !== "stale_timeout" &&
    reason !== "session_closed"
  ) {
    return;
  }

  if (!session.done && !session.error) {
    session.error = new Error(reason);
  }
  notifyPiSession(session);
  piRpcSessions.delete(sessionId);

  if (convProc) {
    if (wasQueued && convProc.queue) {
      const idx = convProc.queue.findIndex((q) => q.id === sessionId);
      if (idx !== -1) convProc.queue.splice(idx, 1);
    } else if (convProc.activeRequestId === sessionId) {
      advancePiQueue(convProc);
    }
  }

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
      // Avoid killing a process that is actively processing a request
      if (proc.activeRequestId !== null) continue;
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

  proc.on("exit", (code, signal) => {
    convProc.closed = true;
    appendSecurityEvent("pi_process_exit", {
      convId,
      code,
      signal,
    });
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
    pendingCommandResolvers: new Map(),
    convId,
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

      // Generic RPC command responses (issued via sendPiCommand with an id).
      if (
        evt.type === "response" &&
        typeof evt.id === "string" &&
        convProc.pendingCommandResolvers instanceof Map &&
        convProc.pendingCommandResolvers.has(evt.id)
      ) {
        const resolveCommand = convProc.pendingCommandResolvers.get(evt.id);
        convProc.pendingCommandResolvers.delete(evt.id);
        resolveCommand(evt);
        continue;
      }

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

      let session = piRpcSessions.get(convProc.activeRequestId);

      if (!session) {
        // The session is missing (either it never existed, or was cleaned up/timed out).
        // If we get a message update, tool, or end, the model has "woken up" (or a
        // lingering response arrived) and we should capture it as an async wake turn.
        const isWakeEvent =
          evt.type === "message_update" ||
          evt.type === "tool_execution_start" ||
          evt.type === "tool_execution_update" ||
          evt.type === "tool_execution_end" ||
          evt.type === "agent_end";
        if (isWakeEvent) {
          const captured = {
            id: createPiSessionId(),
            proc: convProc.proc,
            convProc,
            response: "",
            thinking: "",
            buffer: "",
            stderrData: "",
            pendingDialog: null,
            done: false,
            closed: false,
            error: null,
            hadProviderError: false,
            waiters: [],
            streamListeners: new Set(),
            source: "async_wake",
            timeoutMs: convProc.settings.timeoutMs,
            uiSettings: convProc.settings.permissionUx,
            createdAt: Date.now(),
            lastActivityAt: Date.now(),
            queued: false,
          };
          piRpcSessions.set(captured.id, captured);
          convProc.activeRequestId = captured.id;
          session = captured;
          appendSecurityEvent("pi_async_wake_detected", {
            convId,
            sessionId: captured.id,
            triggerEvent: evt.type || null,
          });
        }
      }

      // Track the pi-subagents async fleet widget even when no session is
      // attached: its presence means background subagents are still running,
      // which gates when an agent_end really finishes the conversation turn.
      if (
        evt.type === "extension_ui_request" &&
        evt.method === "setWidget" &&
        evt.widgetKey === "subagent-async"
      ) {
        convProc.asyncWidgetActive =
          Array.isArray(evt.widgetLines) && evt.widgetLines.length > 0;
      }

      if (!session) continue;

      session.lastActivityAt = Date.now();

      // Extension UI signals (widgets, status lines, notifications) become
      // first-class readable events instead of raw JSON trace dumps. The
      // subagent fleet widget in particular is the same live progress view
      // the terminal shows — forward its lines verbatim (ANSI stripped).
      if (evt.type === "extension_ui_request") {
        if (evt.method === "setWidget") {
          const widgetLines = Array.isArray(evt.widgetLines)
            ? evt.widgetLines.slice(0, 80).map((l) => stripAnsi(l))
            : null;
          emitPiSessionEvent(session, {
            type: "pi_widget",
            sessionId: session.id,
            key: evt.widgetKey || "widget",
            lines: widgetLines,
          });
          continue;
        }
        if (evt.method === "setStatus") {
          emitPiSessionEvent(session, {
            type: "pi_status",
            sessionId: session.id,
            key: evt.statusKey || "status",
            text:
              typeof evt.statusText === "string"
                ? stripAnsi(evt.statusText)
                : "",
          });
          continue;
        }
        if (evt.method === "notify") {
          emitPiSessionEvent(session, {
            type: "pi_notice",
            sessionId: session.id,
            noticeType: evt.notifyType || "info",
            message: stripAnsi(evt.message || ""),
          });
          continue;
        }
        if (evt.method === "setTitle" || evt.method === "set_editor_text") {
          continue; // terminal-only concerns, meaningless in the web UI
        }
        // select / confirm / input / editor fall through to the dialog
        // handler below (isPiDialogRequest).
      }

      if (evt.type === "auto_retry_start") {
        emitPiSessionEvent(session, {
          type: "provider_retry",
          sessionId: session.id,
        });
        continue;
      }

      if (evt.type === "auto_retry_end") {
        emitPiSessionEvent(session, {
          type: "provider_retry_end",
          success: evt.success || false,
          sessionId: session.id,
        });
        continue;
      }

      if (
        (evt.type === "message_end" || evt.type === "turn_end") &&
        (evt.stopReason === "error" || evt.message?.stopReason === "error")
      ) {
        let errorMsg =
          evt.errorMessage ||
          evt.message?.errorMessage ||
          "Unknown provider error";
        if (typeof errorMsg === "object") {
          errorMsg = JSON.stringify(errorMsg);
        }
        session.hadProviderError = true;
        emitPiSessionEvent(session, {
          type: "provider_error",
          error: clampText(String(errorMsg), 600),
          sessionId: session.id,
        });
        continue;
      }

      // A clean assistant message-end carries the model + token usage for the
      // turn — surface it as a compact readable footer instead of JSON noise.
      if (
        evt.type === "message_end" &&
        evt.message?.role === "assistant" &&
        evt.message?.usage
      ) {
        const usage = evt.message.usage;
        emitPiSessionEvent(session, {
          type: "pi_usage",
          sessionId: session.id,
          model: evt.message.model || "",
          input: Number(usage.input) || 0,
          output: Number(usage.output) || 0,
          cost: Number(usage.cost?.total) || 0,
        });
        continue;
      }

      // Structural lifecycle events carry nothing the user can read — the
      // substance arrives via thinking/text deltas and tool events. Dropping
      // them here is what kills the raw-JSON "Trace" gibberish.
      if (
        evt.type === "agent_start" ||
        evt.type === "turn_start" ||
        evt.type === "turn_end" ||
        evt.type === "message_start" ||
        evt.type === "message_end" ||
        evt.type === "response"
      ) {
        continue;
      }

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
          // First text of the wake turn (after async subagents finished):
          // separate it from the pre-async text instead of gluing them.
          if (session.awaitingAsync) {
            session.awaitingAsync = false;
            if (session.response && session.response.trim()) {
              session.response += "\n\n";
            }
          }
          session.response += delta.delta;
          emitPiSessionEvent(session, {
            type: "delta",
            delta: delta.delta,
            response: session.response,
            sessionId: session.id,
          });
          continue;
        }
        // Fallback: if it's a message update but not a delta, it might be a full response.
        if (typeof delta === "string" && delta.trim()) {
          session.response = delta;
          emitPiSessionEvent(session, {
            type: "delta",
            delta: delta,
            response: session.response,
            sessionId: session.id,
          });
          continue;
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
          outputPreview: clampText(output, 3000),
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
        // Async subagents: pi-subagents lets the parent agent end its turn
        // while background children keep working, then wakes it with their
        // results. While the fleet widget is active, this agent_end is NOT
        // the end of the conversation turn — keep the session (and the
        // client's stream) open so the wake turn lands in the same bubble
        // instead of an empty reply + a prematurely re-enabled send button.
        if (
          convProc.asyncWidgetActive &&
          session.source !== "async_wake" &&
          !session.error
        ) {
          session.awaitingAsync = true;
          emitPiSessionEvent(session, {
            type: "async_pending",
            sessionId: session.id,
          });
          continue;
        }
        session.done = true;
        if (
          session.hadProviderError &&
          (!session.response || !session.response.trim())
        ) {
          emitPiSessionEvent(session, {
            type: "error",
            error:
              "The provider encountered an error and retries were exhausted. No response was generated.",
            sessionId: session.id,
          });
        }
        emitPiSessionEvent(session, {
          type: "done",
          response: session.response || "",
          sessionId: session.id,
        });
        notifyPiSession(session);
        if (session.source === "async_wake") {
          // Nobody is listening for this session (no stream, no waiter) —
          // save the result now, since this is the only chance to.
          persistAsyncWakeTurn(convId, session.response || "", {
            thinking: session.thinking || "",
          });
          cleanupPiSession(session.id, "async_wake_completed");
        }
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
    return Promise.reject(
      createHttpError(409, "State request already in progress"),
    );
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
    return Promise.reject(
      createHttpError(409, "Stats request already in progress"),
    );
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
  const model =
    state?.model && typeof state.model === "object" ? state.model : {};
  const provider = typeof model.provider === "string" ? model.provider : "";
  const cloudProviders = [
    "openai",
    "anthropic",
    "google",
    "mistral",
    "deepseek",
    "perplexity",
  ];
  const isCloud = cloudProviders.includes(provider.toLowerCase());

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

  const isLocal =
    !isCloud &&
    (provider === "ollama" ||
      zeroCost ||
      (statsCost !== null && statsCost === 0));

  const cost = isLocal
    ? "Local"
    : statsCost != null
      ? `$${statsCost.toFixed(4)}`
      : null;

  return {
    model: model.id || model.name || null,
    provider: provider || null,
    isLocal,
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

function isPiConvProcBusy(convProc) {
  return convProc.activeRequestId !== null;
}

function advancePiQueue(convProc) {
  if (!convProc.queue || convProc.queue.length === 0) {
    convProc.activeRequestId = null;
    return;
  }
  const next = convProc.queue.shift();
  const session = piRpcSessions.get(next.id);
  if (!session) {
    advancePiQueue(convProc);
    return;
  }
  dispatchPiPrompt(convProc, session, next.message);
}

function dispatchPiPrompt(convProc, session, message) {
  convProc.activeRequestId = session.id;
  const payload = JSON.stringify({
    type: "prompt",
    message,
    source: session.source,
  });
  convProc.proc.stdin.write(payload + "\n");
  session.lastActivityAt = Date.now();
}

// ---- Pi environment banner (version, context, skills, prompts, extensions) ----
let piVersionCache = null;
function getPiVersionSync() {
  if (piVersionCache !== null) return piVersionCache;
  piVersionCache = "";
  try {
    let cmd = getPiCommand();
    if (!path.isAbsolute(cmd)) {
      const lookup = spawnSync("/usr/bin/env", ["which", cmd], {
        encoding: "utf8",
        env: buildPiEnv(),
      });
      const found = (lookup.stdout || "").trim().split("\n")[0];
      if (found) cmd = found;
    }
    const real = fs.realpathSync(cmd);
    const pkg = JSON.parse(
      fs.readFileSync(
        path.join(path.dirname(real), "..", "package.json"),
        "utf8",
      ),
    );
    piVersionCache = typeof pkg.version === "string" ? pkg.version : "";
  } catch (_e) {}
  return piVersionCache;
}

function listPiExtensionsFromSettings() {
  try {
    const cfg = JSON.parse(
      fs.readFileSync(
        path.join(os.homedir(), ".pi", "agent", "settings.json"),
        "utf8",
      ),
    );
    const names = new Set();
    const nameOf = (source) => {
      const s = String(source);
      if (s.startsWith("npm:")) return s.slice(4);
      return path.basename(s);
    };
    for (const entry of Array.isArray(cfg.extensions) ? cfg.extensions : []) {
      const parts = String(entry).split("/").filter(Boolean);
      // "+extensions/pi-face/src/index.ts" -> "pi-face"
      const idx = parts.findIndex(
        (p) => p === "extensions" || p === "+extensions",
      );
      names.add(idx >= 0 && parts[idx + 1] ? parts[idx + 1] : parts[0]);
    }
    for (const entry of Array.isArray(cfg.packages) ? cfg.packages : []) {
      if (typeof entry === "string") names.add(nameOf(entry));
      else if (entry && typeof entry === "object" && entry.source) {
        names.add(nameOf(entry.source));
      }
    }
    return [...names].sort();
  } catch (_e) {
    return [];
  }
}

function listPiContextFiles(workingDirectory) {
  const home = os.homedir();
  const candidates = [
    path.join(home, ".pi", "agent", "AGENTS.md"),
    workingDirectory ? path.join(workingDirectory, "AGENTS.md") : null,
    workingDirectory ? path.join(workingDirectory, ".pi", "AGENTS.md") : null,
  ].filter(Boolean);
  return candidates
    .filter((file) => {
      try {
        return fs.existsSync(file);
      } catch (_e) {
        return false;
      }
    })
    .map((file) =>
      file.startsWith(home) ? "~" + file.slice(home.length) : file,
    );
}

// Compose the same startup banner the pi terminal shows and deliver it into
// the first turn's execution trace of a conversation.
async function emitPiEnvironmentBanner(convProc, session) {
  const lines = [];
  const version = getPiVersionSync();
  lines.push(version ? `pi v${version}` : "pi");
  const context = listPiContextFiles(
    convProc.settings?.workingDirectory || DATA_DIR,
  );
  if (context.length) lines.push(`Context: ${context.join(", ")}`);
  try {
    const reply = await sendPiCommand(
      convProc,
      { type: "get_commands" },
      20000,
    );
    const commands = reply?.data?.commands || [];
    const skills = commands
      .filter((c) => c.source === "skill")
      .map((c) => c.name)
      .sort();
    const prompts = commands
      .filter((c) => c.source === "prompt")
      .map((c) => "/" + c.name)
      .sort();
    if (skills.length) lines.push(`Skills: ${skills.join(", ")}`);
    if (prompts.length) lines.push(`Prompts: ${prompts.join(", ")}`);
  } catch (_e) {}
  const extensions = listPiExtensionsFromSettings();
  if (extensions.length) lines.push(`Extensions: ${extensions.join(", ")}`);
  emitPiSessionEvent(session, {
    type: "pi_banner",
    sessionId: session.id,
    text: lines.join("\n"),
  });
}

// Send a one-shot RPC command (model switching, thinking level, compaction,
// stats, command discovery) to a conversation's pi process and await its
// response. This is what lets the web UI expose the same controls the
// terminal has instead of prompting-only access.
function sendPiCommand(convProc, command, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (!convProc.proc.stdin || !convProc.proc.stdin.writable) {
      reject(new Error("Pi process stdin is not writable."));
      return;
    }
    if (!(convProc.pendingCommandResolvers instanceof Map)) {
      convProc.pendingCommandResolvers = new Map();
    }
    const id = `cmd_${randomUUID()}`;
    const timer = setTimeout(() => {
      convProc.pendingCommandResolvers.delete(id);
      reject(new Error(`Pi command ${command.type} timed out.`));
    }, timeoutMs);
    convProc.pendingCommandResolvers.set(id, (evt) => {
      clearTimeout(timer);
      resolve(evt);
    });
    convProc.proc.stdin.write(JSON.stringify({ id, ...command }) + "\n");
    convProc.lastActivityAt = Date.now();
  });
}

function sendPiPrompt(convProc, message, source = "manual") {
  // Use convId as the session ID to ensure a single stable channel per conversation.
  // This ensures that async_wake recoveries (which use the same convId) are delivered
  // to the original stream.
  const id = convProc.convId || createPiSessionId();

  const session = {
    id,
    proc: convProc.proc,
    convProc,
    response: "",
    thinking: "",
    buffer: "",
    stderrData: "",
    pendingDialog: null,
    done: false,
    closed: false,
    error: null,
    hadProviderError: false,
    waiters: [],
    streamListeners: new Set(),
    source,
    timeoutMs: convProc.settings.timeoutMs,
    uiSettings: convProc.settings.permissionUx,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    queued: false,
  };

  piRpcSessions.set(id, session);

  if (isPiConvProcBusy(convProc)) {
    session.queued = true;
    if (!convProc.queue) convProc.queue = [];
    convProc.queue.push({ id, message });
    emitPiSessionEvent(session, { type: "queued", sessionId: id });
    return session;
  }

  dispatchPiPrompt(convProc, session, message);
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

  if (req.method === "GET" && urlPath.startsWith("/assets/")) {
    try {
      const filename = urlPath.slice("/assets/".length);
      if (!filename || /\\|\.\./.test(filename)) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Invalid asset path.");
        return;
      }
      const assetPath = path.join(__dirname, "assets", filename);
      if (!fs.existsSync(assetPath)) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Asset not found.");
        return;
      }
      const buffer = fs.readFileSync(assetPath);
      const ext = path.extname(filename).toLowerCase();
      const mimeMap = {
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
      };
      res.writeHead(200, {
        "Content-Type": mimeMap[ext] || "application/octet-stream",
        "Cache-Control": "public, max-age=31536000, immutable",
      });
      res.end(buffer);
    } catch (error) {
      send(500, { error: "Failed to load asset." });
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
      send(200, { models: await getModels(), offline: false });
    } catch (_e) {
      // Ollama not running is a normal state for LM Studio / llama.cpp users:
      // report it as data, not as a 500 that spams the client console.
      send(200, { models: [], offline: true });
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
    let status = null;
    try {
      status = await getLibraryStatus();
    } catch (error) {
      status = { error: error.message };
    }
    // Sync lastLibraryIndexJob from disk to ensure accuracy
    if (!activeLibraryIndexJob) {
      lastLibraryIndexJob = readLibraryIndexJobFile();
    }
    send(200, {
      running: !!activeLibraryIndexJob,
      job: publicLibraryIndexJob(activeLibraryIndexJob || lastLibraryIndexJob),
      status,
    });
    return;
  }

  if (req.method === "GET" && urlPath === "/api/library/index/errors") {
    const limit = Number.parseInt(
      requestUrl.searchParams.get("limit") || "",
      10,
    );
    send(200, {
      errors: readRecentLibraryIndexErrors(Number.isFinite(limit) ? limit : 50),
      path: LIBRARY_INDEX_ERROR_FILE,
    });
    return;
  }

  if (
    req.method === "POST" &&
    urlPath === "/api/library/export-indexed-files"
  ) {
    try {
      const config = loadLibraryConfig();
      const files = await listIndexedLibraryFiles({ extension: ".epub" });
      const text = formatIndexedLibraryFilesExport(files, config);
      fs.writeFileSync(LIBRARY_INDEXED_FILES_EXPORT_FILE, text, "utf8");
      const stat = fs.statSync(LIBRARY_INDEXED_FILES_EXPORT_FILE);
      send(200, {
        ok: true,
        count: files.length,
        path: LIBRARY_INDEXED_FILES_EXPORT_FILE,
        directory: DATA_DIR,
        bytes: stat.size,
      });
    } catch (e) {
      send(e.statusCode || 500, { error: e.message });
    }
    return;
  }

  if (
    req.method === "POST" &&
    urlPath === "/api/library/export-indexed-files/open"
  ) {
    const targetPath = fs.existsSync(LIBRARY_INDEXED_FILES_EXPORT_FILE)
      ? LIBRARY_INDEXED_FILES_EXPORT_FILE
      : DATA_DIR;
    openPathInFileManager(targetPath, { revealFile: true }, (error) => {
      if (error) {
        send(500, { error: `Failed to open export folder: ${error.message}` });
        return;
      }
      send(200, {
        ok: true,
        path: LIBRARY_INDEXED_FILES_EXPORT_FILE,
        directory: DATA_DIR,
      });
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
        retryEmbeddings: body?.retryEmbeddings === true,
      });
      send(202, {
        ok: true,
        running: true,
        job: publicLibraryIndexJob(job),
        status: await getLibraryStatus().catch((error) => ({
          error: error.message,
        })),
      });
    } catch (e) {
      send(e.statusCode || 500, {
        error: e.message,
        running: !!activeLibraryIndexJob,
        job: publicLibraryIndexJob(
          activeLibraryIndexJob || lastLibraryIndexJob,
        ),
        status: await getLibraryStatus().catch((error) => ({
          error: error.message,
        })),
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
        status: await getLibraryStatus().catch((error) => ({
          error: error.message,
        })),
      });
      return;
    }
    const job = pauseLibraryIndexJob();
    send(202, {
      ok: true,
      running: true,
      job: publicLibraryIndexJob(job),
      status: await getLibraryStatus().catch((error) => ({
        error: error.message,
      })),
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
      const results = await searchLibrary(query, {
        limit: body.limit,
        mode: body.mode,
      });
      send(200, { query, results });
    } catch (e) {
      send(e.statusCode || 500, { error: e.message });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/library/files/search") {
    try {
      const body = await parseJsonBody(req);
      const query = typeof body?.query === "string" ? body.query.trim() : "";
      if (!query) {
        send(400, { error: "Search query is required" });
        return;
      }
      const files = await searchLibraryFiles(query, { limit: 12 });
      send(200, { query, files });
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
    openPathInFileManager(__dirname, {}, (error) => {
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

  if (req.method === "POST" && urlPath === "/api/conversations") {
    try {
      const body = await parseJsonBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        send(400, { error: "Conversation body required" });
        return;
      }
      const id = typeof body.id === "string" ? body.id : "";
      if (!id) {
        send(400, { error: "Conversation id required" });
        return;
      }
      saveClientConversation(
        id,
        body.title,
        typeof body.mode === "string" ? body.mode : "ollama",
        body.messages,
      );
      send(200, { ok: true });
    } catch (e) {
      send(e.statusCode || 500, { error: e.message });
    }
    return;
  }

  const deleteModeMatch =
    req.method === "DELETE" &&
    urlPath.match(/^\/api\/conversations\/mode\/([^/]+)$/);
  if (deleteModeMatch) {
    const requestedMode = decodeURIComponent(deleteModeMatch[1] || "");
    // Every chat mode keeps its own history — local modes included.
    const allowedModes = new Set(UI_SETTINGS_MODE_KEYS);
    if (!allowedModes.has(requestedMode)) {
      send(400, { error: "Invalid conversation mode" });
      return;
    }
    const convs = loadConversations();
    const next = convs.filter((conv) => {
      const convMode =
        typeof conv.mode === "string" && conv.mode ? conv.mode : "ollama";
      return convMode !== requestedMode;
    });
    saveConversations(next);
    send(200, {
      ok: true,
      mode: requestedMode,
      deleted: convs.length - next.length,
    });
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

  if (req.method === "GET" && urlPath.startsWith("/api/conversations/id/")) {
    const id = urlPath.slice("/api/conversations/id/".length).trim();
    if (!id) {
      send(400, { error: "Conversation id is required" });
      return;
    }
    const convs = loadConversations();
    const conv = convs.find((c) => c.id === id);
    if (!conv) {
      send(404, { error: "Conversation not found" });
      return;
    }
    send(200, conv);
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
      const servers = await initMcpServers(body.config);
      send(200, { success: true, servers: servers || [] });
    } catch (e) {
      send(500, { error: e.message });
    }
    return;
  }

  // Stop all MCP servers and delete everything they downloaded. The download
  // locations are the absolute paths in each server's env (npm cache, browser
  // downloads, memory file). Only paths nested at least two levels under the
  // user's home are deleted, so a stray "/" or "~" can never be wiped.
  if (req.method === "POST" && urlPath === "/api/mcp/purge") {
    try {
      const body = await parseJsonBody(req);
      await initMcpServers("");
      const removed = [];
      let config = null;
      try {
        config = JSON.parse(typeof body.config === "string" ? body.config : "");
      } catch (_e) {
        config = null;
      }
      const home = os.homedir();
      const candidates = new Set();
      if (config && config.mcpServers) {
        for (const server of Object.values(config.mcpServers)) {
          const env =
            server && typeof server.env === "object" && server.env
              ? server.env
              : {};
          for (const value of Object.values(env)) {
            if (typeof value === "string" && path.isAbsolute(value.trim())) {
              candidates.add(value.trim());
            }
          }
        }
      }
      for (const candidate of candidates) {
        const resolved = path.resolve(candidate);
        if (!resolved.startsWith(home + path.sep)) continue;
        const rel = path.relative(home, resolved);
        if (!rel || rel.split(path.sep).length < 2) continue;
        try {
          fs.rmSync(resolved, { recursive: true, force: true });
          removed.push(resolved);
        } catch (e) {
          console.error(`[MCP] Could not delete ${resolved}:`, e.message);
        }
      }
      send(200, { ok: true, removed });
    } catch (e) {
      send(e.statusCode || 500, { error: e.message });
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

  if (req.method === "GET" && urlPath === "/api/book-search/config") {
    try {
      const file = path.join(DATA_DIR, "book-search.json");
      const cfg = fs.existsSync(file)
        ? JSON.parse(fs.readFileSync(file, "utf8"))
        : {};
      send(200, { config: cfg && typeof cfg === "object" ? cfg : {} });
    } catch (e) {
      send(500, { error: e.message });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/book-search/config") {
    try {
      const body = await parseJsonBody(req);
      const raw = body?.config;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        send(400, { error: "Config object is required" });
        return;
      }
      const clean = {};
      for (const key of [
        "googleApiKey",
        "hardcoverToken",
        "librarythingToken",
        "calibreServerUrl",
        "calibreLibraryId",
      ]) {
        if (typeof raw[key] === "string" && raw[key].trim()) {
          clean[key] = raw[key].trim();
        }
      }
      const file = path.join(DATA_DIR, "book-search.json");
      fs.writeFileSync(file, JSON.stringify(clean, null, 2), { mode: 0o600 });
      send(200, { ok: true, config: clean });
    } catch (e) {
      send(500, { error: e.message });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/ollama/skills/settings") {
    send(200, loadSkillsConfig());
    return;
  }

  if (req.method === "GET" && urlPath === "/api/ollama/settings") {
    send(200, { baseUrl: ollamaBaseUrl });
    return;
  }

  if (req.method === "POST" && urlPath === "/api/ollama/settings") {
    try {
      const body = await parseJsonBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        send(400, { error: "Settings object is required" });
        return;
      }
      const saved = saveOllamaBaseUrl(body.baseUrl);
      send(200, { ok: true, baseUrl: saved });
    } catch (e) {
      send(e.statusCode || 500, { error: e.message });
    }
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

  if (req.method === "GET" && urlPath.startsWith("/api/pi/events")) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const convId = url.searchParams.get("conv") || "default";
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");
    let subscribers = piEventChannels.get(convId);
    if (!subscribers) {
      subscribers = new Set();
      piEventChannels.set(convId, subscribers);
    }
    subscribers.add(res);
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(": hb\n\n");
    }, 15000);
    heartbeat.unref?.();
    req.on("close", () => {
      clearInterval(heartbeat);
      subscribers.delete(res);
      if (subscribers.size === 0) piEventChannels.delete(convId);
    });
    return;
  }

  if (req.method === "POST" && urlPath === "/api/pi/command") {
    try {
      const body = await parseJsonBody(req);
      const convId = body.saveConv || body.convId || "default";
      const command = body.command;
      // Only session-control commands; prompting still goes through the
      // streaming endpoint so events render in the conversation.
      const ALLOWED_PI_COMMANDS = new Set([
        "get_state",
        "get_available_models",
        "set_model",
        "cycle_model",
        "set_thinking_level",
        "cycle_thinking_level",
        "compact",
        "set_auto_compaction",
        "set_auto_retry",
        "abort_retry",
        "get_session_stats",
        "get_commands",
      ]);
      if (
        !command ||
        typeof command !== "object" ||
        !ALLOWED_PI_COMMANDS.has(command.type)
      ) {
        send(400, { error: "Unsupported Pi command" });
        return;
      }
      const convProc = getOrCreatePiConvProcess(convId, loadPiSettings());
      const timeoutMs = command.type === "compact" ? 180000 : 15000;
      const result = await sendPiCommand(convProc, command, timeoutMs);
      send(200, { ok: result?.success !== false, result });
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
        ...ollamaConn(),
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

  if (req.method === "GET" && urlPath === "/api/notes/list") {
    try {
      send(200, listNotes());
    } catch (e) {
      send(e.statusCode || 500, { error: e.message });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/notes") {
    try {
      const requestedName = requestUrl.searchParams.get("name");
      if (requestedName) {
        const note = readNote(requestedName);
        // Opening a note in the panel makes it the target of the local_notes
        // skill ("append this to my notes" lands where the user is looking).
        setActiveNoteName(note.name);
        send(200, note);
        return;
      }
      send(200, loadNotes());
    } catch (e) {
      send(e.statusCode || 500, { error: e.message });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/notes/create") {
    try {
      const body = await parseJsonBody(req);
      send(200, createNote(body?.title || ""));
    } catch (e) {
      send(e.statusCode || 500, { error: e.message });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/notes/rename") {
    try {
      const body = await parseJsonBody(req);
      send(200, renameNote(body?.name || "", body?.title || ""));
    } catch (e) {
      send(e.statusCode || 500, { error: e.message });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/notes/delete") {
    try {
      const body = await parseJsonBody(req);
      send(200, deleteNote(body?.name || ""));
    } catch (e) {
      send(e.statusCode || 500, { error: e.message });
    }
    return;
  }

  if (
    (req.method === "PUT" || req.method === "POST") &&
    urlPath === "/api/notes"
  ) {
    try {
      const body = await parseJsonBody(req);
      if (!body || typeof body.text !== "string") {
        send(400, { error: "text field required" });
        return;
      }
      const saved = body.name
        ? writeNote(body.name, body.text)
        : saveNotes(body.text);
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
    const traceEvents = [];
    const emit = (event) => {
      const storedEvent = sanitizeTraceEventForStorage(event);
      if (storedEvent) traceEvents.push(storedEvent);
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
      const {
        history = [],
        saveConv,
        convTitle,
        mode = "cloud",
        library,
      } = body;
      const originalMessage = body.message;
      const slashCommand = parseSlashCommand(originalMessage);
      const message = getCommandMessage(slashCommand, originalMessage);
      const messages = normalizeCloudHistoryMessages(history, message);
      const storedMessages = normalizeStoredConversationMessages(
        history,
        originalMessage,
      );
      // Hard-mode override (proofread / translate): bypass policy, library, skills.
      const systemOverride =
        typeof body.systemOverride === "string"
          ? body.systemOverride.trim()
          : "";
      let requestMessages = systemOverride
        ? [{ role: "system", content: systemOverride }, ...messages]
        : withSharedSystemPrompt(messages);
      let librarySourceResults = [];
      let libraryPassages = [];
      let databaseContextEnabled = false;
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

      emitSlashCommand(emit, slashCommand);

      // Tracks whether model-callable skills are offered this turn.
      // Stays false in hard-mode (systemOverride), DB-context, and slash commands.
      let cloudSkillsEnabled = false;
      if (!systemOverride) {
        try {
          const libraryContext = await buildChatLibraryContext(
            message,
            getLibraryRequestForCommand(
              library,
              slashCommand,
              history,
              "cloud",
            ),
          );
          if (libraryContext.enabled) {
            databaseContextEnabled = true;
            // Database Context is on for this cloud turn: use the strict
            // library-only prompt instead of the default tool-enabled one.
            requestMessages[0] = {
              role: "system",
              content: getSharedAssistantPolicyPrompt(true),
            };
            requestMessages = insertLibraryContextMessage(
              requestMessages,
              libraryContext.contextMessage,
            );
            librarySourceResults = serializeLibraryResults(
              getLibraryContextSourceResults(libraryContext),
              getLibraryRequestForCommand(library, slashCommand, history),
            );
            libraryPassages = Array.isArray(libraryContext.contextResults)
              ? libraryContext.contextResults
              : [];
            emit({
              type: "library_results",
              results: librarySourceResults,
              passages: libraryPassages,
              meta: libraryContext.contextMeta,
            });
          }
        } catch (e) {
          emit({ type: "library_error", error: e.message });
        }

        // When this mode's Database Context is on, do not offer tools at all —
        // the DB-on prompt answers strictly from the library passages.
        cloudSkillsEnabled = !slashCommand && !databaseContextEnabled;
        if (cloudSkillsEnabled) {
          const skillsPrompt = getCloudSkillsPolicyPrompt({
            agentMode: settings.agentMode === true,
            agentMaxRounds: settings.agentMaxRounds || 25,
          });
          if (skillsPrompt) {
            // Merge into the FIRST system message instead of adding a second
            // one: OpenAI models (gpt-4o) weight the first system message and
            // often ignore later system turns, silently skipping the tools.
            requestMessages = [
              {
                role: "system",
                content: `${requestMessages[0].content}\n\n${skillsPrompt}`,
              },
              ...requestMessages.slice(1),
            ];
          }
        }
      }

      let thinking = "";
      let emittedThinkingStart = false;

      if (isSkillSlashCommand(slashCommand)) {
        try {
          const toolCall = buildForcedSkillToolCall(slashCommand);
          emit({
            type: "tool_start",
            toolName: slashCommand.skillName,
            argsPreview: toolCall.function.arguments.slice(0, 300),
          });
          const result = await executeToolCallWithConfirmation(toolCall, emit);
          appendForcedSkillResult(requestMessages, slashCommand, result);
          emit({
            type: "tool_end",
            toolName: slashCommand.skillName,
            outputPreview: String(result || "").slice(0, 300),
            isError: /^Error:/i.test(String(result || "")),
          });
        } catch (e) {
          emit({ type: "error", error: e.message });
          if (!res.writableEnded) res.end();
          return;
        }
      }

      // Agent mode raises the tool budget; the default suits quick lookups.
      const maxCloudRounds =
        settings.agentMode === true
          ? clampNumber(settings.agentMaxRounds, 1, 50, 25)
          : 6;
      const seenSkillCalls = new Set();
      for (let round = 0; ; round += 1) {
        // Per-round parser state: peel a leading <thought>/<think> reasoning
        // block off this round's content stream and route it to the thinking
        // box; only the answer text flows into `output`.
        let roundRaw = "";
        let roundThoughtLen = 0;
        let roundAnswerLen = 0;
        usage = await streamCloudCompletion({
          provider,
          settings,
          messages: requestMessages,
          // Attach the image only on the first round (the user's turn); later
          // skill-continuation rounds must not re-send it.
          images: round === 0 ? body.images : undefined,
          signal: abortController.signal,
          onDelta: (delta) => {
            roundRaw += delta;
            const split = splitLeadingThought(roundRaw);
            // Stream the reasoning into the collapsed thinking box. While the
            // block is still open, hold back a short tail that might be a
            // partial closing tag so it never leaks into the thinking text.
            let safeThought = split.thought;
            if (split.opened && !split.closed) {
              safeThought = safeThought.slice(
                0,
                Math.max(0, safeThought.length - 10),
              );
            }
            if (safeThought.length > roundThoughtLen) {
              const chunk = safeThought.slice(roundThoughtLen);
              roundThoughtLen = safeThought.length;
              if (!emittedThinkingStart) {
                emittedThinkingStart = true;
                emit({ type: "thinking_start" });
              }
              thinking += chunk;
              emit({ type: "thinking_delta", delta: chunk, thinking });
            }
            // Forward only the answer text (after </thought>) to the bubble.
            const answerDelta = split.answer.slice(roundAnswerLen);
            roundAnswerLen = split.answer.length;
            if (!answerDelta) return;
            output += answerDelta;
            // Stop streaming visible text once a skill call starts; the
            // call block is excised below and streaming resumes next round.
            if (output.includes("<call:")) return;
            // Send the raw output (including any trailing partial "<call") so the
            // client can hide it and show the animated drum icon, matching Ollama.
            emit({
              type: "delta",
              delta: answerDelta,
              response: output,
            });
          },
          onUsage: (nextUsage) => {
            usage = nextUsage;
          },
        });

        const xmlMatch = cloudSkillsEnabled
          ? output.match(/<call:([^>]+)>(.*?)<\/call>/is)
          : null;
        if (!xmlMatch) break;

        output = output.replace(xmlMatch[0], "").trim();
        if (round >= maxCloudRounds) {
          // End with an answer instead of an error: stop offering tools and
          // tell the model to write its final reply from what it has.
          cloudSkillsEnabled = false;
          requestMessages = [
            ...requestMessages,
            {
              role: "user",
              content:
                "[TOOL BUDGET EXHAUSTED] You have used every allowed tool call for this request. Do not call any more tools. Write your complete final answer now from everything you already found.",
            },
          ];
          if (!emittedThinkingStart) {
            emittedThinkingStart = true;
            emit({ type: "thinking_start" });
          }
          const note = "\n\n[Tool budget exhausted — writing final answer]\n";
          thinking += note;
          emit({ type: "thinking_delta", delta: note, thinking });
          output = "";
          emit({ type: "delta", delta: "", response: output });
          continue;
        }

        const toolCall = {
          function: {
            name: xmlMatch[1].trim(),
            arguments: xmlMatch[2].trim(),
          },
        };

        if (!emittedThinkingStart) {
          emittedThinkingStart = true;
          emit({ type: "thinking_start" });
        }
        const startMsg = `\n\n[Running tool: ${toolCall.function.name}...]\n`;
        thinking += startMsg;
        emit({ type: "thinking_delta", delta: startMsg, thinking });
        emit({
          type: "tool_start",
          toolName: toolCall.function.name,
          argsPreview: toolCall.function.arguments.slice(0, 300),
        });

        // Loop guard: repeated identical call -> answer from existing results
        // instead of re-running it, preventing runaway tool recursion.
        const callKey = `${toolCall.function.name}:${toolCall.function.arguments
          .replace(/\s+/g, "")
          .toLowerCase()}`;
        let result;
        if (seenSkillCalls.has(callKey)) {
          result = `You already ran ${toolCall.function.name} with these exact arguments and have the results above. Do not repeat this call. Answer the user's question now using what you already found.`;
        } else {
          seenSkillCalls.add(callKey);
          try {
            result = await executeToolCallWithConfirmation(toolCall, emit);
          } catch (toolError) {
            result = `Error: ${toolError.message}`;
          }
        }

        emit({
          type: "tool_end",
          toolName: toolCall.function.name,
          outputPreview: String(result || "").slice(0, 300),
          isError: /^Error:/i.test(String(result || "")),
        });
        const cloudSources = extractSkillSources(
          toolCall.function.name,
          safeParseArgs(toolCall.function.arguments),
          result,
        );
        if (cloudSources.length) {
          librarySourceResults = mergeWebSourceResults(
            librarySourceResults,
            cloudSources,
          );
          emit({ type: "web_sources", sources: cloudSources });
        }
        const endMsg = `[Finished tool: ${toolCall.function.name}]\n`;
        thinking += endMsg;
        emit({ type: "thinking_delta", delta: endMsg, thinking });

        if (output) {
          requestMessages = [
            ...requestMessages,
            { role: "assistant", content: output },
          ];
        }
        requestMessages = [
          ...requestMessages,
          {
            role: "user",
            content: `[SKILL RESULT: ${toolCall.function.name}]\n\n${result}\n\nUsing this skill result, write your complete final answer to the user's question now. Do not repeat this skill call.`,
          },
        ];
        // Reset the accumulated text so the final reply is ONLY what the model
        // writes after seeing the skill result. Otherwise any answer it produced
        // BEFORE calling the skill stays prepended and the reply looks duplicated.
        // Anything interim (plan, notes) belongs in the thinking stream.
        if (output.trim()) {
          if (!emittedThinkingStart) {
            emittedThinkingStart = true;
            emit({ type: "thinking_start" });
          }
          const interim = `\n\n[Interim notes]\n${output.trim()}\n`;
          thinking += interim;
          emit({ type: "thinking_delta", delta: interim, thinking });
        }
        output = "";
        emit({ type: "delta", delta: "", response: output });
      }

      // Final safety net: never let raw skill-call syntax reach the bubble, even
      // if a call was malformed or emitted while skills were disabled (DB on).
      output = stripLeakedSkillCalls(output);
      emit({ type: "delta", delta: "", response: output });

      if (emittedThinkingStart) {
        emit({ type: "thinking_end", thinking });
      }

      finished = true;
      upsertConversation(
        saveConv,
        convTitle,
        originalMessage,
        storedMessages,
        output,
        mode,
        {
          librarySources: librarySourceResults,
          passages: libraryPassages,
          thinking,
          traceEvents,
        },
      );
      emit({
        type: "done",
        response: output,
        thinking,
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

  // ---- Local OpenAI-compatible bespoke modes (LM Studio, llama.cpp) ----
  if (req.method === "POST" && urlPath === "/api/lmstudio/stream") {
    await handleLocalModeStream("lmstudio", req, res, send);
    return;
  }
  if (req.method === "POST" && urlPath === "/api/llamacpp/stream") {
    await handleLocalModeStream("llamacpp", req, res, send);
    return;
  }
  if (
    req.method === "GET" &&
    (urlPath === "/api/lmstudio/models" || urlPath === "/api/llamacpp/models")
  ) {
    const modeId = urlPath.includes("lmstudio") ? "lmstudio" : "llamacpp";
    try {
      send(200, await fetchLocalModels(modeId));
    } catch (e) {
      send(e.statusCode || 502, { error: e.message });
    }
    return;
  }
  if (req.method === "GET" && urlPath === "/api/local-models/settings") {
    send(200, { settings: loadLocalModelSettings() });
    return;
  }
  if (req.method === "POST" && urlPath === "/api/local-models/settings") {
    try {
      const body = await parseJsonBody(req);
      send(200, { settings: saveLocalModelSettings(body && body.settings) });
    } catch (e) {
      send(e.statusCode || 500, { error: e.message });
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
        message: requestMessage,
        model,
        history = [],
        saveConv,
        convTitle,
        mode = "ollama",
        options,
        library,
      } = body;
      const originalMessage = requestMessage;
      const slashCommand = parseSlashCommand(originalMessage);
      const message = getCommandMessage(slashCommand, originalMessage);
      const attachmentImages = normalizeAttachmentImages(body.images);
      const userMessage = { role: "user", content: message };
      if (attachmentImages.length) {
        // Ollama /api/chat takes base64 (no data: prefix) in images[]. Vision
        // models (llava, gemma3, qwen2-vl…) use them; others ignore them.
        userMessage.images = attachmentImages.map((img) => img.dataBase64);
      }
      const messages = [...history, userMessage];
      const storedMessages = [
        ...history,
        { role: "user", content: originalMessage },
      ];
      const safeOptions = sanitizeOllamaOptions(options);

      res.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      const opts = {
        ...ollamaConn(),
        path: "/api/chat",
        method: "POST",
        headers: { "Content-Type": "application/json" },
      };

      let output = "";
      let thinking = "";
      let emittedThinkingStart = false;
      let librarySourceResults = [];
      let libraryPassages = [];
      const traceEvents = [];
      let transientLibraryContextMessage = null;
      let databasePriorityForLibraryTurn = false;

      const emit = (event) => {
        const storedEvent = sanitizeTraceEventForStorage(event);
        if (storedEvent) traceEvents.push(storedEvent);
        if (!res.writableEnded) {
          res.write(JSON.stringify(event) + "\n");
        }
      };

      emitSlashCommand(emit, slashCommand);

      try {
        const libraryContext = await buildChatLibraryContext(
          message,
          getLibraryRequestForCommand(library, slashCommand, history, "ollama"),
        );
        if (libraryContext.enabled) {
          if (libraryContext.contextMessage) {
            transientLibraryContextMessage = libraryContext.contextMessage;
            const firstNonSystemIndex = messages.findIndex(
              (item) => item.role !== "system",
            );
            if (firstNonSystemIndex === -1) {
              messages.push(transientLibraryContextMessage);
            } else {
              messages.splice(
                firstNonSystemIndex,
                0,
                transientLibraryContextMessage,
              );
            }
          }
          librarySourceResults = serializeLibraryResults(
            getLibraryContextSourceResults(libraryContext),
            getLibraryRequestForCommand(library, slashCommand, history),
          );
          libraryPassages = Array.isArray(libraryContext.contextResults)
            ? libraryContext.contextResults
            : [];
          databasePriorityForLibraryTurn =
            !slashCommand && librarySourceResults.length > 0;
          emit({
            type: "library_results",
            results: librarySourceResults,
            meta: libraryContext.contextMeta,
            passages: libraryPassages,
          });
        }
      } catch (e) {
        emit({ type: "library_error", error: e.message });
      }

      if (isSkillSlashCommand(slashCommand)) {
        try {
          const toolCall = buildForcedSkillToolCall(slashCommand);
          if (!emittedThinkingStart) {
            emittedThinkingStart = true;
            emit({ type: "thinking_start" });
          }
          emit({
            type: "tool_start",
            toolName: slashCommand.skillName,
            argsPreview: toolCall.function.arguments.slice(0, 300),
          });
          const result = await executeToolCallWithConfirmation(toolCall, emit);
          appendForcedSkillResult(messages, slashCommand, result);
          emit({
            type: "tool_end",
            toolName: slashCommand.skillName,
            outputPreview: String(result || "").slice(0, 300),
            isError: /^Error:/i.test(String(result || "")),
          });
        } catch (e) {
          emit({ type: "error", error: e.message });
          if (!res.writableEnded) res.end();
          return;
        }
      }

      // Agent mode (client-driven for Ollama: the skills prompt is built by
      // the client) raises the tool budget; without it the legacy cap holds.
      const maxOllamaDepth =
        body.agentMode === true
          ? clampNumber(body.agentMaxRounds, 1, 50, 25)
          : 10;
      let budgetExhausted = false;
      const startStream = (depth = 0) => {
        if (depth > maxOllamaDepth && !budgetExhausted) {
          // End with an answer instead of an error: stop accepting tool calls
          // and tell the model to write its final reply from what it has.
          budgetExhausted = true;
          messages.push({
            role: "user",
            content:
              "[TOOL BUDGET EXHAUSTED] You have used every allowed tool call for this request. Do not call any more tools. Write your complete final answer now from everything you already found.",
          });
          if (!emittedThinkingStart) {
            emittedThinkingStart = true;
            emit({ type: "thinking_start" });
          }
          const note = "\n\n[Tool budget exhausted — writing final answer]\n";
          thinking += note;
          emit({ type: "thinking_delta", delta: note, thinking });
        }
        const payloadObject = {
          model,
          messages: sanitizeModelMessages(messages),
          stream: true,
        };
        if (safeOptions) payloadObject.options = safeOptions;

        if (
          !isDatabaseSlashCommand(slashCommand) &&
          !databasePriorityForLibraryTurn
        ) {
          // Native tool calling (OpenAI schema): when enabled, send skills +
          // custom skills + MCP as structured function schemas so tool-trained
          // models (Gemma, Qwen, Llama 3) can call them directly. The parse /
          // execute loop below already handles the resulting `tool_calls`
          // (that is how MCP tools already worked). The client-built XML skill
          // prompt stays in the messages as a fallback for models that ignore
          // `tools`. When disabled, only MCP tools are offered natively (legacy
          // behaviour) and skills go through the XML prompt.
          const nativeTools =
            body.nativeTools !== false
              ? getLocalNativeTools()
              : getMcpOllamaTools();
          if (nativeTools.length > 0) {
            payloadObject.tools = nativeTools;
          }
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
                if (databasePriorityForLibraryTurn && xmlMatch) {
                  output = "";
                  outputToolCalls = [];
                  messages.push({
                    role: "user",
                    content:
                      "Database Context returned local library passages for this turn. Do not call tools. Answer the user's original question using the provided database passages. If the passages contain multiple accounts, causes, or origin details, explain each relevant distinction clearly.",
                  });
                  startStream(depth + 1);
                  return;
                }
                if (xmlMatch) {
                  output = output.replace(xmlMatch[0], "").trim();
                  if (!budgetExhausted) {
                    outputToolCalls.push({
                      function: {
                        name: xmlMatch[1].trim(),
                        arguments: xmlMatch[2].trim(),
                      },
                    });
                  }
                }
                if (slashCommand || budgetExhausted) {
                  outputToolCalls = [];
                }

                if (outputToolCalls.length > 0) {
                  messages.push({ role: "assistant", content: output });
                  // Text written before a tool call is interim (plan, notes)
                  // — move it to the thinking stream and clear the bubble so
                  // it never prefixes the final answer.
                  if (output.trim()) {
                    if (!emittedThinkingStart) {
                      emittedThinkingStart = true;
                      emit({ type: "thinking_start" });
                    }
                    const interim = `\n\n[Interim notes]\n${output.trim()}\n`;
                    thinking += interim;
                    emit({ type: "thinking_delta", delta: interim, thinking });
                  }
                  output = "";
                  emit({ type: "delta", delta: "", response: output });
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
                      // Ollama native tool_calls carry arguments as an object;
                      // the XML path pushes a string. Preview either shape.
                      const argsPreview = (
                        typeof tc.function.arguments === "string"
                          ? tc.function.arguments
                          : JSON.stringify(tc.function.arguments || {})
                      ).slice(0, 300);
                      emit({
                        type: "tool_start",
                        toolName: tc.function.name,
                        argsPreview,
                      });

                      let result;
                      try {
                        result = await executeToolCallWithConfirmation(
                          tc,
                          emit,
                        );
                      } catch (toolError) {
                        result = `Error: ${toolError.message}`;
                      }
                      emit({
                        type: "tool_end",
                        toolName: tc.function.name,
                        outputPreview: String(result || "").slice(0, 300),
                        isError: /^Error:/i.test(String(result || "")),
                      });

                      const ollamaSources = extractSkillSources(
                        tc.function.name,
                        safeParseArgs(tc.function.arguments),
                        result,
                      );
                      if (ollamaSources.length) {
                        librarySourceResults = mergeWebSourceResults(
                          librarySourceResults,
                          ollamaSources,
                        );
                        emit({ type: "web_sources", sources: ollamaSources });
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
                  originalMessage,
                  storedMessages,
                  output,
                  mode,
                  {
                    librarySources: librarySourceResults,
                    passages: libraryPassages,
                    thinking,
                    traceEvents,
                  },
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
                originalMessage,
                storedMessages,
                output,
                mode,
                {
                  librarySources: librarySourceResults,
                  passages: libraryPassages,
                  thinking,
                  traceEvents,
                },
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
          let disabledSkillError = "";
          try {
            assertBuiltinSkillEnabled(toolCall.function.name);
          } catch (error) {
            disabledSkillError = error.message;
          }
          if (disabledSkillError) {
            result = `Error: ${disabledSkillError}`;
          } else if (
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
            result = await executeSkill(toolCall, {
              dataDir: DATA_DIR,
              cloudKeys: getCloudSearchKeys(),
            });
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
    let persistTimer = null;
    let persistPartial = null;
    const traceEvents = [];
    let thinking = "";
    const writeStreamEvent = (evt) => {
      // Widget frames update in place — keep only the latest frame per widget
      // in the stored trace so history holds the final state, not hundreds of
      // intermediate repaints. A clear frame (lines: null) mutes the live
      // view but must NOT erase the stored final state.
      let skipStore = false;
      if (evt?.type === "pi_widget") {
        if (Array.isArray(evt.lines) && evt.lines.length) {
          for (let i = traceEvents.length - 1; i >= 0; i--) {
            if (
              traceEvents[i].type === "pi_widget" &&
              traceEvents[i].key === evt.key
            ) {
              traceEvents.splice(i, 1);
            }
          }
        } else {
          skipStore = true;
        }
      }
      const storedEvent = skipStore ? null : sanitizeTraceEventForStorage(evt);
      if (storedEvent) traceEvents.push(storedEvent);
      if (evt?.type === "thinking_delta") {
        if (typeof evt.thinking === "string") {
          thinking = evt.thinking;
        } else if (typeof evt.delta === "string") {
          thinking += evt.delta;
        }
      }
      // Continuously checkpoint the in-flight turn to disk (debounced) so
      // clearing the chat, starting a new session, or a crash mid-run never
      // loses what was already produced.
      if (evt?.type !== "heartbeat" && typeof persistPartial === "function") {
        if (evt?.type === "async_pending") {
          persistPartial();
        } else if (!persistTimer) {
          persistTimer = setTimeout(() => {
            persistTimer = null;
            if (session && !session.done) persistPartial();
          }, 2500);
        }
      }
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
      const originalMessage = body.message;
      const slashCommand = parseSlashCommand(originalMessage);
      const promptQuestion = getCommandMessage(slashCommand, originalMessage);
      const messages = [...history, { role: "user", content: originalMessage }];
      let promptMessage = promptQuestion;
      let librarySourceResults = [];
      let libraryPassages = [];

      res.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      emitSlashCommand(writeStreamEvent, slashCommand);
      if (isSkillSlashCommand(slashCommand)) {
        writeStreamEvent({
          type: "error",
          error: `/${slashCommand.name} is only supported in Ollama mode.`,
        });
        if (!res.writableEnded) res.end();
        return;
      }

      try {
        const libraryContext = await buildChatLibraryContext(
          promptQuestion,
          getLibraryRequestForCommand(
            body.library,
            slashCommand,
            history,
            "pi",
          ),
        );
        if (libraryContext.enabled) {
          // Database Context on for Pi: prepend the strict library-only policy
          // so Pi answers exclusively from the retrieved passages. When the
          // database is off, Pi keeps its own native persona and tools.
          promptMessage =
            DB_ON_PROMPT +
            "\n\n" +
            buildPiPromptWithLibraryContext(
              promptMessage,
              libraryContext.contextMessage,
            );
          librarySourceResults = serializeLibraryResults(
            getLibraryContextSourceResults(libraryContext),
            getLibraryRequestForCommand(body.library, slashCommand, history),
          );
          libraryPassages = Array.isArray(libraryContext.contextResults)
            ? libraryContext.contextResults
            : [];
          writeStreamEvent({
            type: "library_results",
            results: librarySourceResults,
            passages: libraryPassages,
            meta: libraryContext.contextMeta,
          });
        }
      } catch (e) {
        writeStreamEvent({ type: "library_error", error: e.message });
      }

      // Pi is a text-only CLI, so an attached image is written to a temp file
      // and its path is referenced in the prompt; Pi can open it if it has
      // image/file-reading tools. Temp files self-delete after 10 minutes.
      const piImages = normalizeAttachmentImages(body.images);
      if (piImages.length) {
        const refs = [];
        for (const img of piImages) {
          const tmp = path.join(
            os.tmpdir(),
            "pi_img_" +
              randomBytes(8).toString("hex") +
              extForImageMime(img.mimeType),
          );
          try {
            fs.writeFileSync(tmp, Buffer.from(img.dataBase64, "base64"));
            refs.push(tmp);
            setTimeout(
              () => {
                try {
                  fs.unlinkSync(tmp);
                } catch (_e) {}
              },
              10 * 60 * 1000,
            ).unref();
          } catch (_e) {}
        }
        if (refs.length) {
          promptMessage +=
            "\n\n[Attached image file" +
            (refs.length > 1 ? "s" : "") +
            " saved locally — open with your image/file tools: " +
            refs.join(", ") +
            "]";
        }
      }

      const piSettings = loadPiSettings();
      const convId = body.saveConv || "default";
      const convProc = getOrCreatePiConvProcess(convId, piSettings);
      session = sendPiPrompt(convProc, promptMessage, source);
      persistPartial = () => {
        try {
          upsertConversation(
            saveConv,
            convTitle,
            body.message,
            messages,
            session?.response || "",
            mode,
            {
              librarySources: librarySourceResults,
              passages: libraryPassages,
              thinking,
              traceEvents,
              status: "streaming",
            },
          );
        } catch (_e) {}
      };
      writeStreamEvent({ type: "session_start", sessionId: session.id });
      if (!convProc.bannerEmitted) {
        convProc.bannerEmitted = true;
        emitPiEnvironmentBanner(convProc, session).catch(() => {});
      }

      unsubscribe = addPiSessionListener(session, (evt) => {
        writeStreamEvent(evt);
        if (evt.type === "done" || evt.type === "error") {
          if (persistTimer) {
            clearTimeout(persistTimer);
            persistTimer = null;
          }
          if (evt.type === "done") {
            upsertConversation(
              saveConv,
              convTitle,
              body.message,
              messages,
              session.response || "",
              mode,
              {
                librarySources: librarySourceResults,
                passages: libraryPassages,
                thinking,
                traceEvents,
              },
            );
          }
          if (typeof unsubscribe === "function") unsubscribe();
          if (heartbeatInterval) clearInterval(heartbeatInterval);
          if (!res.writableEnded) res.end();
          cleanupPiSession(
            session.id,
            evt.type === "done" ? "completed_stream" : "stream_error",
          );
        }
      });

      const heartbeatInterval = setInterval(() => {
        if (!res.writableEnded) {
          if (session) session.lastActivityAt = Date.now();
          writeStreamEvent({ type: "heartbeat" });
        } else {
          clearInterval(heartbeatInterval);
        }
      }, 2000);

      if (session.pendingDialog) {
        writeStreamEvent({
          type: "needs_ui",
          sessionId: session.id,
          request: formatPiUiRequest(session.pendingDialog),
        });
      }

      res.on("close", () => {
        if (typeof unsubscribe === "function") unsubscribe();
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        if (persistTimer) {
          clearTimeout(persistTimer);
          persistTimer = null;
        }
        if (session && piRpcSessions.has(session.id)) {
          // The client went away mid-run (stop button, app closed, reload):
          // checkpoint whatever the turn produced so far before tearing down.
          if (!session.done && typeof persistPartial === "function") {
            persistPartial();
          }
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
      const slashCommand = parseSlashCommand(body.message);
      if (isSkillSlashCommand(slashCommand)) {
        send(400, {
          error: `/${slashCommand.name} is only supported in Ollama mode.`,
        });
        return;
      }
      const promptQuestion = getCommandMessage(slashCommand, body.message);
      let promptMessage = promptQuestion;
      let libraryResults = [];
      try {
        const libraryContext = await buildChatLibraryContext(
          promptQuestion,
          getLibraryRequestForCommand(
            body.library,
            slashCommand,
            body.history,
            "pi",
          ),
        );
        if (libraryContext.enabled) {
          promptMessage = buildPiPromptWithLibraryContext(
            promptMessage,
            libraryContext.contextMessage,
          );
          libraryResults = serializeLibraryResults(
            libraryContext.results,
            getLibraryRequestForCommand(
              body.library,
              slashCommand,
              body.history,
            ),
          );
        }
      } catch (_e) {}
      const piSettings = loadPiSettings();
      const convId = body.saveConv || "default";
      const convProc = getOrCreatePiConvProcess(convId, piSettings);
      session = sendPiPrompt(convProc, promptMessage, source);
      req.on("close", () => {
        if (session && !res.writableEnded) {
          cleanupPiSession(session.id, "client_disconnected_start");
        }
      });
      const result = await waitForPiSessionStep(session);
      send(200, { ...result, libraryResults });
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
            {
              timeout: PDFTOTEXT_TIMEOUT_MS,
              maxBuffer: PDFTOTEXT_MAX_BUFFER,
              // GUI-launched apps get a minimal PATH that omits Homebrew
              // (/opt/homebrew/bin), so resolve pdftotext the same way the
              // sqlite3 / pi calls do, or the upload fails with "not found".
              env: {
                ...process.env,
                PATH: buildExecutablePath(process.env.PATH || ""),
              },
            },
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
        const ext = path.extname(file.filename || "").toLowerCase();
        if (IMAGE_MIME_BY_EXT.has(ext)) {
          // Images are sent to the model as base64, not extracted to text.
          send(200, {
            kind: "image",
            dataBase64: file.body.toString("base64"),
            mimeType: IMAGE_MIME_BY_EXT.get(ext),
            filename: file.filename,
          });
          return;
        }
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
        if (!ext || !ALLOWED_TEXT_EXTENSIONS.has(ext)) {
          send(415, {
            error: `Unsupported file type${ext ? ": " + ext : ""}. Allowed: .txt, .md, .js, .ts, .py, .html, .css, .json, .pdf, .jpg, .jpeg, .png, .gif, .webp`,
          });
          return;
        }
        send(200, {
          kind: "text",
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
