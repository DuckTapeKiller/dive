const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const os = require("os");
const { randomBytes } = require("crypto");
const { ALL_SKILLS } = require("./skills");
const { initMcpServers, getMcpOllamaTools } = require("./mcp");
const { isDatabaseSlashCommand } = require("./slash_commands");

const DEFAULT_PORT = 8080;
const PORT = Number.parseInt(process.env.PORT || String(DEFAULT_PORT), 10);
const MAX_HISTORY_MESSAGES = 200; // max messages stored per conversation
const PI_SESSION_TIMEOUT_MS = 5 * 60 * 1000;
const PI_SESSION_SWEEP_INTERVAL_MS = 15 * 1000;
const MAX_JSON_PAYLOAD_SIZE = 50 * 1024 * 1024; // 50MB for JSON API requests
const MAX_UPLOAD_PAYLOAD_SIZE = 50 * 1024 * 1024; // 50MB for file uploads
const MAX_LOG_FILE_SIZE = 10 * 1024 * 1024; // 10MB per log file
const MAX_ROTATED_LOG_FILES = 3;
const PDFTOTEXT_TIMEOUT_MS = 15 * 1000;
const PDFTOTEXT_MAX_BUFFER = 10 * 1024 * 1024;

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

// Conversation storage: one JSON file per mode under DATA_DIR/conversations.
const CONVERSATIONS_DIR = path.join(DATA_DIR, "conversations");
const LEGACY_HISTORY_FILE = path.join(DATA_DIR, "conversations.json");
const CONV_TOMBSTONES_FILE = path.join(
  CONVERSATIONS_DIR,
  "deleted-tombstones.json",
);
const CONV_TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;
const CUSTOM_SKILLS_FILE = path.join(DATA_DIR, "custom_skills.json");
const SKILLS_CONFIG_FILE = path.join(DATA_DIR, "skills_config.json");
const PI_SETTINGS_FILE = path.join(DATA_DIR, "pi-settings.json");
const UI_SETTINGS_FILE = path.join(DATA_DIR, "ui-settings.json");
const CLOUD_SETTINGS_FILE = path.join(DATA_DIR, "cloud-settings.json");
const OLLAMA_SETTINGS_FILE = path.join(DATA_DIR, "ollama-settings.json");
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
  "/vendor/highlight.min.js": {
    assetName: "vendor/highlight.min.js",
    resolveFilePath: () =>
      path.join(
        __dirname,
        "node_modules",
        "@highlightjs",
        "cdn-assets",
        "highlight.min.js",
      ),
  },
};
const SECURITY_EVENTS_FILE = path.join(DATA_DIR, "security-events.jsonl");
const DAEMON_LOG_FILE = path.join(DATA_DIR, "daemon.log");
const DAEMON_ERROR_LOG_FILE = path.join(DATA_DIR, "daemon.error.log");
const LOG_ROTATION_STATE = new Map();
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

// Cross-client live sync: every connected client (desktop app, browser)
// subscribes to one global SSE channel. Whenever a conversation is saved or
// deleted — by any client or by a server-side stream — a lightweight signal
// is broadcast so the other clients refresh and, if they have that same
// conversation open, re-render it.
const appEventClients = new Set();

function broadcastAppEvent(type, payload = {}) {
  const frame = `data: ${JSON.stringify({ type, ...payload })}\n\n`;
  for (const res of appEventClients) {
    try {
      if (!res.writableEnded) res.write(frame);
    } catch (_e) {
      appEventClients.delete(res);
    }
  }
}

// ---- Conversation storage ----------------------------------------------
// Design rules (root fixes for the delete-resurrection / lost-update mess):
//  * one file per mode: <mode>-conversations.json in CONVERSATIONS_DIR
//  * every mutation runs through a per-file serialized queue that re-reads
//    the file inside the critical section (no read-modify-write races)
//  * deletes leave a tombstone; late saves from an already-running turn can
//    never re-create a conversation the user deleted
//  * no MAX_CONVERSATIONS cap: history retains everything

function convModeKey(mode) {
  return UI_SETTINGS_MODE_KEYS.includes(mode) ? mode : "ollama";
}

function convFile(mode) {
  return path.join(
    CONVERSATIONS_DIR,
    `${convModeKey(mode)}-conversations.json`,
  );
}

let convTombstones = new Map();

function pruneConvTombstones() {
  const cutoff = Date.now() - CONV_TOMBSTONE_TTL_MS;
  for (const [id, ts] of convTombstones) {
    if (ts < cutoff) convTombstones.delete(id);
  }
}

function loadConvTombstones() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONV_TOMBSTONES_FILE, "utf8"));
    convTombstones = new Map(
      Object.entries(raw).map(([k, v]) => [k, Number(v)]),
    );
    pruneConvTombstones();
  } catch {
    convTombstones = new Map();
  }
}

function persistConvTombstones() {
  try {
    fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true });
    atomicWriteJson(CONV_TOMBSTONES_FILE, Object.fromEntries(convTombstones));
  } catch (e) {
    console.error("Could not persist conversation tombstones:", e.message);
  }
}

function tombstoneConversation(id) {
  if (!id) return;
  pruneConvTombstones();
  convTombstones.set(id, Date.now());
  persistConvTombstones();
}

function isConversationTombstoned(id) {
  if (!id || !convTombstones.has(id)) return false;
  if (convTombstones.get(id) < Date.now() - CONV_TOMBSTONE_TTL_MS) {
    convTombstones.delete(id);
    return false;
  }
  return true;
}

function readConversationFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function atomicWriteJson(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

// Serialize every mutation per mode file. The mutator receives the freshly
// read list and returns the next list (or null to skip the write).
const convWriteQueues = new Map();

function withModeConversations(mode, mutator) {
  const file = convFile(mode);
  const prev = convWriteQueues.get(file) || Promise.resolve();
  const next = prev
    .then(() => {
      fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true });
      const list = readConversationFile(file);
      const result = mutator(list);
      if (Array.isArray(result)) atomicWriteJson(file, result);
      return result;
    })
    .catch((e) => {
      console.error(`Conversation write failed (${mode}):`, e.message || e);
      return null;
    });
  convWriteQueues.set(file, next);
  return next;
}

function loadConversationsForMode(mode) {
  return readConversationFile(convFile(mode));
}

function loadConversations() {
  const all = [];
  for (const mode of UI_SETTINGS_MODE_KEYS) {
    all.push(...loadConversationsForMode(mode));
  }
  all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return all;
}

function getConversationById(id) {
  if (!id) return null;
  for (const mode of UI_SETTINGS_MODE_KEYS) {
    const found = loadConversationsForMode(mode).find((c) => c.id === id);
    if (found) return found;
  }
  return null;
}

function deleteConversationById(id) {
  if (!id) return Promise.resolve(false);
  tombstoneConversation(id);
  const deletions = UI_SETTINGS_MODE_KEYS.map((mode) =>
    withModeConversations(mode, (list) => {
      const next = list.filter((c) => c.id !== id);
      return next.length === list.length ? null : next;
    }),
  );
  return Promise.all(deletions).then((results) => {
    const deleted = results.some((r) => Array.isArray(r));
    if (deleted) {
      broadcastAppEvent("conversation_deleted", { id });
    }
    return deleted;
  });
}

function deleteConversationsByMode(mode) {
  return withModeConversations(mode, (list) => {
    for (const conv of list) tombstoneConversation(conv.id);
    return [];
  }).then((result) => {
    broadcastAppEvent("conversation_deleted", { mode });
    return Array.isArray(result) ? 0 : 0;
  });
}

function deleteAllConversations() {
  return Promise.all(
    UI_SETTINGS_MODE_KEYS.map((mode) => deleteConversationsByMode(mode)),
  );
}

// One-time migration: split the legacy single conversations.json into the
// per-mode files. The original is kept as a .migrated-backup, never deleted.
function migrateLegacyConversations() {
  try {
    fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true });
    if (!fs.existsSync(LEGACY_HISTORY_FILE)) return;
    const legacy = JSON.parse(fs.readFileSync(LEGACY_HISTORY_FILE, "utf8"));
    if (Array.isArray(legacy) && legacy.length) {
      const byMode = {};
      for (const conv of legacy) {
        if (!conv || typeof conv !== "object") continue;
        const m = convModeKey(conv.mode || "ollama");
        (byMode[m] ||= []).push(conv);
      }
      for (const [m, list] of Object.entries(byMode)) {
        const file = convFile(m);
        const existing = readConversationFile(file);
        const ids = new Set(existing.map((conv) => conv.id));
        const merged = [
          ...existing,
          ...list.filter((conv) => !ids.has(conv.id)),
        ];
        merged.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        atomicWriteJson(file, merged);
      }
      console.log(
        `[conversations] migrated ${legacy.length} conversations from the legacy single file into per-mode files`,
      );
    }
    fs.renameSync(
      LEGACY_HISTORY_FILE,
      `${LEGACY_HISTORY_FILE}.migrated-backup`,
    );
  } catch (e) {
    console.error("Conversation migration failed:", e.message || e);
  }
}

function persistAsyncWakeTurn(convId, response, metadata = {}) {
  if (!convId || !response) return;
  if (isConversationTombstoned(convId)) return;
  const existing = getConversationById(convId);
  if (!existing) return; // nothing to attach this turn to
  const mode = convModeKey(existing.mode || "pi");
  withModeConversations(mode, (convs) => {
    const idx = convs.findIndex((c) => c.id === convId);
    if (idx === -1) return null;

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
    return convs;
  }).then(() => {
    appendSecurityEvent("pi_async_wake_persisted", { convId });
    broadcastAppEvent("conversation_saved", {
      id: convId,
      mode,
      origin: "server",
    });
  });
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
    mode === "pi" && saveConv ? piDomain.api.getSessionFile(saveConv) : null;
  if (!saveConv) return;
  // A deleted conversation stays deleted: a still-running turn that finishes
  // after the user deleted its conversation must not re-create it.
  if (isConversationTombstoned(saveConv)) return;
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

  // Cap the size of the conversation history array
  if (newHistory.length > MAX_HISTORY_MESSAGES) {
    const spliceCount = newHistory.length - MAX_HISTORY_MESSAGES;
    newHistory.splice(0, spliceCount);
  }

  return withModeConversations(mode, (convs) => {
    if (isConversationTombstoned(saveConv)) return null;
    const existing = convs.findIndex((c) => c.id === saveConv);
    if (existing >= 0) {
      convs[existing].history = newHistory;
      convs[existing].updatedAt = Date.now();
      convs[existing].mode = convModeKey(mode);
      if (piSessionFile) convs[existing].piSessionFile = piSessionFile;
    } else {
      convs.unshift({
        piSessionFile,
        id: saveConv,
        title,
        mode: convModeKey(mode),
        history: newHistory,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    return convs;
  }).then((result) => {
    if (Array.isArray(result)) {
      broadcastAppEvent("conversation_saved", {
        id: saveConv,
        mode,
        origin: "server",
      });
    }
  });
}

// Upsert a full conversation supplied by the client. Used to persist an
// interrupted turn: the normal stream "done" save never fires on abort, so the
// client posts the in-memory history (user + partial assistant) here so it
// survives in the History panel and across reloads, for every mode.
function saveClientConversation(id, title, mode, rawMessages, originClientId) {
  if (!id || !Array.isArray(rawMessages)) return Promise.resolve();
  if (isConversationTombstoned(id)) return Promise.resolve();
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
  if (!history.length) return Promise.resolve();
  if (history.length > MAX_HISTORY_MESSAGES) {
    history.splice(0, history.length - MAX_HISTORY_MESSAGES);
  }
  const firstUser = history.find((m) => m.role === "user");
  const finalTitle =
    (typeof title === "string" && title.trim()) ||
    (firstUser ? firstUser.content.slice(0, 40) : "Conversation");
  return withModeConversations(mode, (convs) => {
    if (isConversationTombstoned(id)) return null;
    const existing = convs.findIndex((c) => c.id === id);
    if (existing >= 0) {
      convs[existing].history = history;
      convs[existing].updatedAt = Date.now();
      convs[existing].mode = convModeKey(mode);
    } else {
      convs.unshift({
        id,
        title: finalTitle,
        mode: convModeKey(mode),
        history,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    return convs;
  }).then((result) => {
    if (Array.isArray(result)) {
      broadcastAppEvent("conversation_saved", {
        id,
        mode,
        origin: "client",
        clientId: typeof originClientId === "string" ? originClientId : "",
      });
    }
  });
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
    remember_lesson: true,
    propose_plugin: false,
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

// Resolve "Automatic" (empty model) to a concrete model id for a local server.
// Ollama JIT-loads on any request, but LM Studio returns 400 "No models
// loaded" when asked to chat with no model specified and none loaded. So when
// the user picked Automatic we name a model explicitly: prefer one that is
// already loaded (no reload cost), else the first non-embedding model the
// server reports (LM Studio JIT-loads it). Returns "" if none can be found, in
// which case the request proceeds as before (llama.cpp serves its loaded model).
// Is a given model already loaded on the server? (LM Studio native endpoint.)
// Explicitly load a model into LM Studio. JIT loading is unreliable / can be
// disabled, so we don't depend on it: the REST load endpoint deterministically
// loads the model (and does NOT evict an already-loaded embedding model, so
// library indexing keeps working). Best-effort: returns true on success, false
// if the endpoint is unavailable or the load fails, in which case the caller
// proceeds and lets the chat request surface any real error.
// For LM Studio: make sure the chosen chat model is loaded before we send the
// chat request, so the user never has to load one manually (their indexer may
// have loaded only an embedding model). No-op for llama.cpp (it always serves
// the model it was started with) and when there is no concrete model to load.
// Shared streaming handler for the bespoke local modes (LM Studio, llama.cpp).
// Remove any skill-call syntax that survived the streaming loop so it can never
// reach the chat bubble. Covers three cases the local models produce that Ollama
// does not: a completed <call:...></call> when skills were disabled (DB on), a
// malformed call missing its closing tag, and a dangling opener at end of text.
// Derive the source pills (title + URL) from a skill result so the UI can show
// every source it consulted, the same way library passages are surfaced. Covers
// web_search result lists, <!-- url --> citation comments, and web_scraper URLs.
// Parse a tool-call argument string without throwing.
// Skill web sources must survive into the saved conversation: merge them into
// the librarySources persisted on the assistant message (deduped by URL) so
// the source pills re-render when the chat is reopened from history.
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

function buildExecutablePath(basePath = "") {
  const baseEntries = String(basePath)
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
  const merged = [...baseEntries, ...COMMON_BINARY_DIRS];
  return Array.from(new Set(merged)).join(path.delimiter);
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

const chatDomain = require("./routes/chat")({
  DB_ON_PROMPT,
  clampOllamaNumber,
  clampOllamaInteger,
  MAX_HISTORY_MESSAGES,
  loadCustomSkills,
  ALL_SKILLS,
  getCloudApiKey,
  createHttpError,
  buildCloudEndpoint,
  defaultSkillsConfig,
  loadSkillsConfig,
  streamLocalOpenAiCompletion,
  sanitizeLocalParams,
  normalizeLocalBaseUrl,
  loadLocalModelSettings,
  LOCAL_MODE_DEFAULTS,
  DATA_DIR,
  PORT,
  CLOUD_DEFAULT_MODELS,
  CLOUD_PROVIDER_SET,
  appendSecurityEvent,
  clampNumber,
  emitSlashCommand,
  getCommandMessage,
  getLibraryContextSourceResults,
  getLibraryRequestForCommand,
  loadCloudSettings,
  normalizeAttachmentImages,
  normalizeStoredConversationMessages,
  ollamaChat,
  ollamaConn,
  parseJsonBody,
  sanitizeModelMessages,
  sanitizeTraceEventForStorage,
  serializeLibraryResults,
  streamCloudCompletion,
  upsertConversation,
});
const piDomain = require("./routes/pi")({
  DATA_DIR,
  PORT,
  PI_DEFAULT_SERVER_PORT,
  PI_SESSION_TIMEOUT_MS,
  PI_SESSION_SWEEP_INTERVAL_MS,
  DB_ON_PROMPT,
  buildExecutablePath,
  parseJsonBody,
  appendSecurityEvent,
  createHttpError,
  openPathInFileManager,
  upsertConversation,
  persistAsyncWakeTurn,
  sanitizeTraceEventForStorage,
  normalizeAttachmentImages,
  extForImageMime,
  emitSlashCommand,
  getCommandMessage,
  getLibraryRequestForCommand,
  getLibraryContextSourceResults,
  serializeLibraryResults,
  loadPiSettings,
  savePiSettings,
  sanitizePiSettings,
  defaultPiSettings,
  buildPiPromptWithLibraryContext,
});
const conversationsDomain = require("./routes/conversations")({
  parseJsonBody,
  loadConversations,
  loadConversationsForMode,
  saveClientConversation,
  getConversationById,
  deleteConversationById,
  deleteConversationsByMode,
  deleteAllConversations,
  UI_SETTINGS_MODE_KEYS,
});
const promptsDomain = require("./routes/prompts")({ DATA_DIR, parseJsonBody });
const notesDomain = require("./routes/notes")({ DATA_DIR, parseJsonBody });
const settingsDomain = require("./routes/settings")({
  parseJsonBody,
  loadUiSettingsWithMeta,
  saveUiSettings,
  loadCloudSettings,
  saveCloudSettings,
  sanitizeCloudSettings,
  redactCloudSettings,
  loadLocalModelSettings,
  saveLocalModelSettings,
  getOllamaBaseUrl: () => ollamaBaseUrl,
  saveOllamaBaseUrl,
});
const skillsDomain = require("./routes/skills")({
  DATA_DIR,
  parseJsonBody,
  loadCustomSkills,
  saveCustomSkills,
  loadSkillsConfig,
  saveSkillsConfig,
  defaultSkillsConfig,
  initMcpServers,
});
const libraryDomain = require("./routes/library")({
  DATA_DIR,
  parseJsonBody,
  appendFileWithRotation,
  openPathInFileManager,
});

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
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
      };
      // App code (split client JS/CSS) must never be cached across app
      // updates; images keep the long immutable cache.
      const isAppCode = ext === ".js" || ext === ".css";
      res.writeHead(200, {
        "Content-Type": mimeMap[ext] || "application/octet-stream",
        "Cache-Control": isAppCode
          ? "no-cache"
          : "public, max-age=31536000, immutable",
      });
      res.end(buffer);
    } catch (error) {
      send(500, { error: "Failed to load asset." });
    }
    return;
  }

  // Global live-sync channel: all clients subscribe here and receive
  // conversation-change signals from every other client (issue 2.1).
  if (req.method === "GET" && urlPath === "/api/events/global") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");
    appEventClients.add(res);
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(": hb\n\n");
    }, 15000);
    heartbeat.unref?.();
    res.on("close", () => {
      clearInterval(heartbeat);
      appEventClients.delete(res);
    });
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

  if (await chatDomain.handleRequest({ req, res, urlPath, requestUrl, send })) {
    return;
  }

  if (await settingsDomain.handleRequest({ req, urlPath, send })) {
    return;
  }

  if (
    await libraryDomain.handleRequest({ req, res, urlPath, requestUrl, send })
  ) {
    return;
  }

  if (await piDomain.handleRequest({ req, res, urlPath, requestUrl, send })) {
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

  if (
    (await conversationsDomain.handleRequest({ req, urlPath, send })) ||
    (await promptsDomain.handleRequest({ req, urlPath, send }))
  ) {
    return;
  }

  if (await skillsDomain.handleRequest({ req, urlPath, send })) {
    return;
  }

  if (await notesDomain.handleRequest({ req, urlPath, requestUrl, send })) {
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

loadConvTombstones();
migrateLegacyConversations();

server.listen(PORT, "127.0.0.1", () => {
  console.log("Running securely on http://127.0.0.1:" + PORT);
  libraryDomain.resumePersistedLibraryIndexJob();
});

// SV-18: Graceful shutdown handler
function gracefulShutdown(signal) {
  console.log(`Received ${signal}. Shutting down gracefully...`);

  // Clean up all Pi processes
  piDomain.api.shutdownAll();

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
