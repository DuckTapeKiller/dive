// Pi domain: the entire Pi RPC integration — process lifecycle per
// conversation, session event fan-out, the persistent SSE event channel,
// environment banner, RPC commands, and every /api/pi/* route. Shared
// storage/library/security helpers are injected from server.js; the api
// object exposes the pieces the legacy /api/chat/stream pi branch still
// consumes there.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { randomBytes, randomUUID } = require("crypto");
const { StringDecoder } = require("string_decoder");
const { buildChatLibraryContext } = require("../library/store");
const { extractWebSources } = require("./web-sources.js");
const {
  redactText: redactPiText,
  redactValue: redactPiRpcValue,
  boundedValue: boundedJsonValue,
} = require("../redact.js");
const {
  isSkillSlashCommand,
  parseSlashCommand,
} = require("../slash_commands.js");

const PI_COMMAND_CANDIDATES =
  process.platform === "win32"
    ? ["pi.cmd", "pi.exe", "pi"]
    : ["/opt/homebrew/bin/pi", "/usr/local/bin/pi", "pi"];

// Attachments handed to Pi have to live somewhere pi-sandbox lets the agent
// read. os.tmpdir() is the wrong place on macOS: it resolves to the private
// per-user $TMPDIR (/var/folders/…/T), which is in none of the sandbox's
// allowed roots, so a dragged-in image reaches Pi as a path it is denied
// permission to open. /tmp is in pi-sandbox's default allowWrite (write
// implies read), so stage there instead and keep the directory 0700 so the
// attachment stays readable only by this user.
const PI_ATTACHMENT_DIR_NAME = "dive-pi-attachments";
const PI_ATTACHMENT_TTL_MS = 10 * 60 * 1000;
const MAX_PI_RPC_RECORD_CHARS = 4 * 1024 * 1024;
const PI_EVENT_BUFFER_SIZE = 256;
const PI_EVENT_BUFFER_MAX_BYTES = 4 * 1024 * 1024;
const PI_EVENT_CHANNEL_MAX = 256;
const PI_EVENT_CHANNEL_TTL_MS = 30 * 60 * 1000;
const MAX_PI_RESPONSE_CHARS = 2 * 1024 * 1024;
const MAX_PI_THINKING_CHARS = 512 * 1024;
const MAX_PI_TRACE_EVENTS = 512;
const MAX_PI_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_PI_IMAGE_TOTAL_BYTES = 40 * 1024 * 1024;

// Pi's RPC stream is strict JSONL. A stdout data chunk may split a UTF-8
// sequence or contain several records, so never parse chunks directly.
class PiJsonlDecoder {
  constructor(onValue) {
    this.decoder = new StringDecoder("utf8");
    this.onValue = onValue;
    this.buffer = "";
  }

  push(chunk) {
    this.buffer += Buffer.isBuffer(chunk)
      ? this.decoder.write(chunk)
      : String(chunk);
    this.drain(false);
  }

  end() {
    this.buffer += this.decoder.end();
    this.drain(true);
  }

  drain(flush) {
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      this.parse(this.buffer.slice(0, newlineIndex));
      this.buffer = this.buffer.slice(newlineIndex + 1);
      newlineIndex = this.buffer.indexOf("\n");
    }
    if (this.buffer.length > MAX_PI_RPC_RECORD_CHARS) {
      throw new Error("Pi RPC record exceeds 4 MiB.");
    }
    if (flush && this.buffer.length > 0) {
      this.parse(this.buffer);
      this.buffer = "";
    }
  }

  parse(line) {
    const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (normalized.length > MAX_PI_RPC_RECORD_CHARS) {
      throw new Error("Pi RPC record exceeds 4 MiB.");
    }
    if (!normalized.trim()) return;
    let value;
    try {
      value = JSON.parse(normalized);
    } catch (error) {
      throw new Error(`Invalid Pi JSONL record: ${error.message}`, {
        cause: error,
      });
    }
    this.onValue(value);
  }
}

const piOwnedAttachmentDirs = new Set();

function piAttachmentRoots() {
  return process.platform === "win32" ? [os.tmpdir()] : ["/tmp"];
}

function sweepPiAttachments(dir) {
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(dir)) {
      const entry = path.join(dir, name);
      try {
        if (now - fs.statSync(entry).mtimeMs > PI_ATTACHMENT_TTL_MS) {
          fs.rmSync(entry, { recursive: true, force: true });
        }
      } catch (_e) {
        // Expected: another sweep or the OS removed this entry first.
      }
    }
  } catch (_e) {
    // Expected: the staging directory is already gone.
  }
}

function sweepPiAttachmentRoots() {
  for (const root of piAttachmentRoots()) {
    try {
      for (const name of fs.readdirSync(root)) {
        if (!name.startsWith(`${PI_ATTACHMENT_DIR_NAME}-`)) continue;
        const dir = path.join(root, name);
        const stat = fs.lstatSync(dir);
        if (!stat.isDirectory()) continue;
        if (
          typeof process.getuid === "function" &&
          stat.uid !== process.getuid()
        ) {
          continue;
        }
        sweepPiAttachments(dir);
        if (
          Date.now() - stat.mtimeMs > PI_ATTACHMENT_TTL_MS &&
          fs.readdirSync(dir).length === 0
        ) {
          fs.rmdirSync(dir);
        }
      }
    } catch (_e) {
      // Expected: the root is unreadable or an entry raced with the sweep.
    }
  }
}

function piAttachmentStageDir() {
  sweepPiAttachmentRoots();
  for (const root of piAttachmentRoots()) {
    try {
      const dir = fs.mkdtempSync(path.join(root, `${PI_ATTACHMENT_DIR_NAME}-`));
      fs.chmodSync(dir, 0o700);
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory()) continue;
      if (typeof process.getuid === "function" && stat.uid !== process.getuid())
        continue;
      piOwnedAttachmentDirs.add(dir);
      return dir;
    } catch (_e) {
      // Expected per root: try the next candidate. Exhausting them all is
      // reported by the caller, because it silently costs the user an image.
    }
  }
  console.warn(
    `[pi] could not create an attachment staging directory in any of: ${piAttachmentRoots().join(", ")}. Images cannot be handed to Pi.`,
  );
  return null;
}

function removeOwnedPiAttachmentDirs() {
  for (const dir of piOwnedAttachmentDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_e) {
      // Expected at shutdown: the directory may already be gone.
    }
    piOwnedAttachmentDirs.delete(dir);
  }
}

function createPiDomain(deps) {
  const {
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
    resolveAttachmentImages,
    describeDroppedAttachments,
    normalizeStoredConversationMessages,
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
  } = deps;
  const attachmentSweepTimer = setInterval(sweepPiAttachmentRoots, 60 * 1000);
  attachmentSweepTimer.unref?.();

  function isExecutableFile(filePath) {
    if (!filePath || typeof filePath !== "string") return false;
    try {
      fs.accessSync(filePath, fs.constants.X_OK);
      return true;
    } catch (_error) {
      return false;
    }
  }

  function signalPiProcess(proc, signal = "SIGTERM") {
    if (!proc || proc.killed) return;
    try {
      if (process.platform !== "win32" && proc.pid) {
        process.kill(-proc.pid, signal);
      } else {
        proc.kill(signal);
      }
    } catch (_error) {
      try {
        proc.kill(signal);
      } catch (_ignored) {
        // Expected: the process had already exited.
      }
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
    } catch (_error) {
      // Expected when `which`/`where` is unavailable; fall back to PATH.
    }
    return "pi"; // Fallback to PATH
  }

  function getAllowedPiSessionPath(convProc, candidatePath) {
    if (!convProc || typeof candidatePath !== "string") return null;
    let resolved;
    try {
      resolved = fs.realpathSync(path.resolve(candidatePath));
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) return null;
      if (
        typeof process.getuid === "function" &&
        stat.uid !== process.getuid() &&
        stat.uid !== 0
      ) {
        return null;
      }
    } catch (_error) {
      return null;
    }
    const workingDirectory = convProc.settings?.workingDirectory || DATA_DIR;
    const roots = [
      path.join(os.homedir(), ".pi", "agent", "sessions"),
      path.join(workingDirectory, ".pi", "agent", "sessions"),
      path.join(workingDirectory, ".pi", "sessions"),
    ];
    return roots.some((root) => {
      try {
        const realRoot = fs.realpathSync(root);
        return resolved.startsWith(realRoot + path.sep);
      } catch (_error) {
        return false;
      }
    })
      ? resolved
      : null;
  }

  function isAllowedPiSessionPath(convProc, candidatePath) {
    return Boolean(getAllowedPiSessionPath(convProc, candidatePath));
  }

  // A sandbox policy counts as active only if it exists AND does not switch
  // itself off. Reporting on file existence alone told the user they were
  // sandboxed when the policy said "enabled": false.
  function sandboxPolicyActive(policyPath) {
    if (!fs.existsSync(policyPath)) return false;
    try {
      const raw = fs
        .readFileSync(policyPath, "utf8")
        .replace(/^\s*\/\/.*$/gm, "");
      const parsed = JSON.parse(raw);
      return parsed?.enabled !== false;
    } catch (_error) {
      // Unparseable policy: the file is there, so report it rather than
      // claiming the user has no sandbox at all.
      return true;
    }
  }

  function getPiRuntimeInfo(settings = loadPiSettings()) {
    const resolvedWorkingDirectory = settings.workingDirectory || DATA_DIR;
    // pi-sandbox reads the global policy from ~/.pi/agent/sandbox.json and the
    // project policy from <cwd>/.pi/sandbox.json (its README, "Add a config
    // like this either to ~/.pi/agent/sandbox.json (global) or to
    // .pi/sandbox.json (local)"). Dive previously checked ~/.pi/sandbox.json,
    // which pi-sandbox does not read, so a correctly sandboxed setup was
    // reported as unsandboxed.
    const globalSandbox = path.join(
      os.homedir(),
      ".pi",
      "agent",
      "sandbox.json",
    );
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
      version: getPiVersionSync(settings),
      capabilities: {
        rpc: true,
        agentSettled: true,
        nativeImages: true,
        structuredToolResults: true,
        sequencedReplay: true,
      },
      resolvedWorkingDirectory,
      sandbox: {
        globalPath: globalSandbox,
        globalEnabled: sandboxPolicyActive(globalSandbox),
        projectPath: projectSandbox,
        projectEnabled: sandboxPolicyActive(projectSandbox),
      },
    };
  }

  const PI_DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
  const piRpcSessions = new Map();

  function createPiSessionId() {
    return `pi_${randomUUID()}`;
  }

  const PI_ENV_ALLOWLIST = new Set([
    "HOME",
    "LANG",
    "LC_ALL",
    "LOGNAME",
    "PATH",
    "SHELL",
    "TERM",
    "TMPDIR",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    // Pi providers use these variables for their own authentication. Other
    // Dive/server credentials must never be inherited by the tool-capable Pi
    // process.
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "MISTRAL_API_KEY",
    "DEEPSEEK_API_KEY",
    "OPENROUTER_API_KEY",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AZURE_OPENAI_API_KEY",
    "AZURE_API_KEY",
  ]);

  function buildPiEnv() {
    const env = {};
    for (const key of PI_ENV_ALLOWLIST) {
      if (typeof process.env[key] === "string") env[key] = process.env[key];
    }
    env.PATH = buildExecutablePath(process.env.PATH || "");
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
  // has to poll conversations.json to find out what happened. Each channel
  // retains a bounded replay window so EventSource reconnects do not silently
  // lose a continuation.
  const piEventChannels = new Map();

  function normalizePiChannelId(value) {
    const id = String(value || "default");
    return id.length <= 200 && !/[\u0000-\u001f]/.test(id) ? id : "default";
  }

  function requirePiConversationId(value) {
    const id =
      typeof value === "string" && value.trim() ? value.trim() : "default";
    if (id.length > 200 || /[\u0000-\u001f]/.test(id)) {
      throw createHttpError(400, "Invalid Pi conversation ID");
    }
    return id;
  }

  function getPiEventChannel(convId) {
    if (piShuttingDown) return null;
    const id = normalizePiChannelId(convId);
    let channel = piEventChannels.get(id);
    if (!channel) {
      if (piEventChannels.size >= PI_EVENT_CHANNEL_MAX) {
        const evictable = [...piEventChannels.entries()]
          .filter(
            ([key, value]) =>
              value.subscribers.size === 0 &&
              !piConvProcesses.has(key) &&
              ![...piRpcSessions.values()].some(
                (session) =>
                  normalizePiChannelId(session.convProc?.convId) === key,
              ),
          )
          .sort((a, b) => a[1].lastActivityAt - b[1].lastActivityAt)[0];
        if (evictable) {
          piEventChannels.delete(evictable[0]);
        } else {
          return null;
        }
      }
      channel = {
        subscribers: new Set(),
        events: [],
        nextSequence: 0,
        eventBytes: 0,
        lastActivityAt: Date.now(),
        completedSessions: new Map(),
      };
      piEventChannels.set(id, channel);
    }
    channel.lastActivityAt = Date.now();
    return channel;
  }

  function broadcastPiConvEvent(convId, event, { replay = true } = {}) {
    if (!convId || !event) return event;
    const channel = getPiEventChannel(convId);
    if (!channel) return event;
    const sessionId =
      typeof event.sessionId === "string" ? event.sessionId : null;
    if (sessionId && (event.type === "done" || event.type === "error")) {
      channel.completedSessions.set(sessionId, Date.now());
      while (channel.completedSessions.size > PI_EVENT_BUFFER_SIZE) {
        channel.completedSessions.delete(
          channel.completedSessions.keys().next().value,
        );
      }
    }
    const safeEvent = sanitizePiPublicEvent(event);
    const publicEvent = {
      ...safeEvent,
      convId: normalizePiChannelId(convId),
      sequence: ++channel.nextSequence,
      ...(sessionId
        ? { completed: channel.completedSessions.has(sessionId) }
        : {}),
    };
    if (replay) {
      channel.events.push(publicEvent);
      channel.eventBytes += Buffer.byteLength(JSON.stringify(publicEvent));
      while (
        channel.events.length > PI_EVENT_BUFFER_SIZE ||
        channel.eventBytes > PI_EVENT_BUFFER_MAX_BYTES
      ) {
        const removed = channel.events.shift();
        channel.eventBytes -= Buffer.byteLength(JSON.stringify(removed));
      }
    }
    const payload = `id: ${publicEvent.sequence}\ndata: ${JSON.stringify(publicEvent)}\n\n`;
    for (const res of channel.subscribers) {
      if (!res.writableEnded) {
        try {
          res.write(payload);
        } catch (_e) {
          // Expected: the subscriber disconnected between the check and write.
        }
      }
    }
    return publicEvent;
  }

  function storeAsyncWakeTraceEvent(session, event) {
    if (!session?.captureTraceEvents || !event) return;
    let skipStore = false;
    if (event?.type === "pi_widget") {
      if (Array.isArray(event.lines) && event.lines.length) {
        for (let i = session.traceEvents.length - 1; i >= 0; i--) {
          if (
            session.traceEvents[i].type === "pi_widget" &&
            session.traceEvents[i].key === event.key
          ) {
            session.traceEvents.splice(i, 1);
          }
        }
      } else {
        skipStore = true;
      }
    }
    const stored = skipStore ? null : sanitizeTraceEventForStorage(event);
    if (stored) {
      session.traceEvents.push(stored);
      if (session.traceEvents.length > MAX_PI_TRACE_EVENTS) {
        session.traceEvents.splice(
          0,
          session.traceEvents.length - MAX_PI_TRACE_EVENTS,
        );
      }
    }
  }

  function emitPiSessionEvent(session, event) {
    if (!session || !event) return;
    // Push to the conversation's persistent channel regardless of whether a
    // prompt stream is attached. The same sequenced event is sent to the
    // foreground stream and the reconnectable channel.
    // Keep a bounded copy even while a foreground listener is attached. If
    // either transport drops mid-turn, SSE can replay the same sequenced
    // events and the browser will deduplicate them by watermark.
    const publicEvent = broadcastPiConvEvent(session.convProc?.convId, event);
    storeAsyncWakeTraceEvent(session, publicEvent);
    if (!session.streamListeners) return;
    for (const listener of session.streamListeners) {
      try {
        listener(publicEvent);
      } catch (error) {
        // A listener bug must not break the fan-out to the others, but it is a
        // bug and was previously invisible.
        console.error("[pi] stream listener threw:", error);
      }
    }
  }

  function clampText(value, maxLength = 1000) {
    const text = redactPiText(
      typeof value === "string" ? value : String(value ?? ""),
    );
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength)}…`;
  }

  function toolContentText(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((item) => {
          if (typeof item === "string") return item;
          if (item && typeof item === "object") {
            if (item.type === "text" && typeof item.text === "string") {
              return item.text;
            }
            if ("content" in item) return toolContentText(item.content);
            if (item.type === "image") return "[image]";
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
    if (content && typeof content === "object" && "content" in content) {
      return toolContentText(content.content);
    }
    return "";
  }

  function extractToolTextPayload(payload) {
    return toolContentText(payload?.content ?? payload);
  }

  function extractAssistantText(message) {
    if (!message || typeof message !== "object") return "";
    return toolContentText(message.content);
  }

  function clampPiPublicValue(value, depth = 0) {
    if (depth > 8) return "[redacted-depth]";
    if (typeof value === "string") return clampText(value, 12000);
    if (Array.isArray(value)) {
      return value
        .slice(0, 100)
        .map((item) => clampPiPublicValue(item, depth + 1));
    }
    if (!value || typeof value !== "object") return value;
    const clean = {};
    for (const [key, item] of Object.entries(value).slice(0, 120)) {
      clean[key] = clampPiPublicValue(item, depth + 1);
    }
    return clean;
  }

  function sanitizePiPublicEvent(event) {
    const safe = clampPiPublicValue(redactPiRpcValue(event));
    if (!safe || typeof safe !== "object" || Array.isArray(safe)) {
      return { type: "event", payload: safe };
    }
    let serialized = JSON.stringify(safe);
    if (serialized.length > 256 * 1024) {
      for (const key of ["payload", "result", "partial", "toolCall", "lines"]) {
        if (key in safe) safe[key] = { truncated: true };
      }
      serialized = JSON.stringify(safe);
      if (serialized.length > 256 * 1024) {
        return {
          type: typeof safe.type === "string" ? safe.type : "event",
          sessionId:
            typeof safe.sessionId === "string" ? safe.sessionId : undefined,
          truncated: true,
        };
      }
    }
    return safe;
  }

  function toolOutputLimit(session) {
    const configured = Number(session?.convProc?.settings?.toolOutputMaxChars);
    return Number.isFinite(configured) && configured > 0 ? configured : 12000;
  }

  function snapshotToolResult(result, maxChars) {
    if (!result || typeof result !== "object") return null;
    const snapshot = {};
    for (const key of ["toolCallId", "toolName"]) {
      if (typeof result[key] === "string") snapshot[key] = result[key];
    }
    if (typeof result.isError === "boolean") snapshot.isError = result.isError;
    if ("content" in result) {
      snapshot.content = boundedJsonValue(
        redactPiRpcValue(result.content),
        maxChars,
      );
    }
    if ("details" in result) {
      snapshot.details = boundedJsonValue(
        redactPiRpcValue(result.details),
        maxChars,
      );
    }
    return snapshot;
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
      title: clampText(stripAnsi(evt.title || ""), 1000),
      message: clampText(stripAnsi(evt.message || ""), 4000),
      options: Array.isArray(evt.options)
        ? evt.options.slice(0, 100).map((option) => clampText(option, 1000))
        : [],
      placeholder: clampText(stripAnsi(evt.placeholder || ""), 1000),
      prefill: clampText(stripAnsi(evt.prefill || ""), 4000),
      timeout: typeof evt.timeout === "number" ? evt.timeout : undefined,
    };
  }

  const piConvProcesses = new Map();
  let piShuttingDown = false;
  // convId -> { proc, stderrData, closed, lastActivityAt, settings, sessionFile, activeRequestId, pendingStatsResolver, pendingStateResolver }

  function rejectPendingPiCommands(convProc, error) {
    if (!(convProc?.pendingCommandResolvers instanceof Map)) return;
    for (const [id, pending] of convProc.pendingCommandResolvers.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      convProc.pendingCommandResolvers.delete(id);
    }
  }

  function cleanupPiSession(sessionId, reason = "session_closed") {
    const session = piRpcSessions.get(sessionId);
    if (!session) return;

    const wasQueued = session.queued;
    const convProc = session.convProc;

    // A timeout must abort the active Pi generation before its queue can be
    // advanced. Otherwise the next prompt can enter the same RPC process while
    // the timed-out generation is still emitting events.
    if (
      convProc?.activeRequestId === sessionId &&
      !session.done &&
      !session.closed &&
      (reason === "stale_timeout" || reason === "session_timeout")
    ) {
      if (!session.abortRequested) {
        abortPiSession(session, reason);
      }
      if (
        !session.abortRequestedAt ||
        Date.now() - session.abortRequestedAt < 5000
      ) {
        return;
      }
      session.closed = true;
      session.error = new Error("Pi session abort timed out.");
      cancelQueuedPiSessions(convProc, "process_abort_timeout");
      convProc.activeRequestId = null;
      signalPiProcess(convProc.proc, "SIGTERM");
    }

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

  function cancelQueuedPiSessions(convProc, reason = "queue_cancelled") {
    const queued = Array.isArray(convProc?.queue)
      ? convProc.queue.splice(0)
      : [];
    for (const item of queued) {
      const session = piRpcSessions.get(item.id);
      if (!session) continue;
      session.closed = true;
      session.error = new Error(reason);
      emitPiSessionEvent(session, {
        type: "error",
        error: reason,
        sessionId: session.id,
      });
      cleanupPiSession(session.id, reason);
    }
  }

  // Stop means stop. Pi exposes three independent aborts over RPC and the
  // terminal's Esc (app.interrupt) ends all of them; sending only `abort`
  // leaves an in-flight auto-retry counting down and a running bash command
  // still executing, so the turn appears to keep going after Stop.
  //
  // Order matters: kill the sub-activities first, then the agent itself, so
  // the agent cannot settle while its bash child is still running. Pi reads
  // stdin line by line, so writing them in sequence is enough. Failures are
  // ignored — "no bash running" is a normal outcome, not an error.
  function stopPiGeneration(convProc, timeoutMs = 5000) {
    if (!convProc || convProc.closed) return Promise.resolve(null);
    const send = (type) =>
      sendPiCommand(convProc, { type }, timeoutMs).catch(() => null);
    const bash = send("abort_bash");
    const retry = send("abort_retry");
    const abort = send("abort");
    return Promise.allSettled([bash, retry, abort]).then(
      () => abort.catch(() => null),
      () => null,
    );
  }

  function abortPiSession(session, reason = "client_disconnected") {
    if (!session) return;
    session.detached = true;
    session.abortRequested = true;
    session.abortRequestedAt = Date.now();
    const convProc = session.convProc;
    if (!convProc || convProc.closed || session.done) {
      cleanupPiSession(session.id, reason);
      return;
    }
    if (session.queued) {
      cleanupPiSession(session.id, reason);
      return;
    }
    try {
      // Each abort is best-effort: "no bash running" and "no retry pending"
      // are normal outcomes, and the process may exit as we write.
      stopPiGeneration(convProc).catch(() => {});
    } catch (_error) {
      // stdin already closed; the process is going away regardless.
    }
  }

  function finishPiSession(session) {
    if (!session || session.done) return;
    session.response = clampText(session.response, MAX_PI_RESPONSE_CHARS);
    session.thinking = clampText(session.thinking, MAX_PI_THINKING_CHARS);
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
      persistAsyncWakeTurn(session.convProc?.convId, session.response || "", {
        thinking: session.thinking || "",
        traceEvents: session.traceEvents || [],
      });
      cleanupPiSession(session.id, "async_wake_completed");
    } else if (session.detached) {
      cleanupPiSession(session.id, "detached_completed");
    }
  }

  // One decoded Pi RPC record. Every branch is a terminal decision for that
  // record, so each returns rather than falling through to the next.
  function handlePiRpcEvent(convProc, evt) {
    if (!evt || typeof evt !== "object") return;
    convProc.lastActivityAt = Date.now();

    // Generic RPC command responses (issued via sendPiCommand with an id).
    if (
      evt.type === "response" &&
      typeof evt.id === "string" &&
      convProc.pendingCommandResolvers instanceof Map &&
      convProc.pendingCommandResolvers.has(evt.id)
    ) {
      const pending = convProc.pendingCommandResolvers.get(evt.id);
      convProc.pendingCommandResolvers.delete(evt.id);
      clearTimeout(pending.timer);
      if (evt.command === "get_state") {
        const stateData = evt.data || evt;
        const allowedSessionFile = getAllowedPiSessionPath(
          convProc,
          stateData.sessionFile,
        );
        if (allowedSessionFile) {
          convProc.sessionFile = allowedSessionFile;
        }
        if (stateData.model && typeof stateData.model === "object") {
          convProc.model = stateData.model;
        }
        convProc.resolveInitialState();
      }
      pending.resolve(evt);
      return;
    }

    if (evt.type === "response" && evt.command === "get_state") {
      const stateData = evt.data || evt;
      const allowedSessionFile = getAllowedPiSessionPath(
        convProc,
        stateData.sessionFile,
      );
      if (allowedSessionFile) convProc.sessionFile = allowedSessionFile;
      if (stateData.model && typeof stateData.model === "object") {
        convProc.model = stateData.model;
      }
      convProc.resolveInitialState();
      if (convProc.pendingStateResolver) {
        const resolveState = convProc.pendingStateResolver;
        convProc.pendingStateResolver = null;
        resolveState(stateData);
      }
      return;
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
      return;
    }

    let session = piRpcSessions.get(convProc.activeRequestId);

    if (!session) {
      // Fire-and-forget extension updates can arrive between turns. Keep
      // them on the replay channel without manufacturing an assistant
      // message; a later UI can still reconcile them.
      if (evt.type === "extension_ui_request") {
        if (evt.method === "setWidget") {
          broadcastPiConvEvent(convProc.convId, {
            type: "pi_widget",
            key: evt.widgetKey || "widget",
            lines: Array.isArray(evt.widgetLines)
              ? evt.widgetLines
                  .slice(0, 80)
                  .map((line) => clampText(stripAnsi(line), 4000))
              : null,
          });
        } else if (evt.method === "setStatus") {
          broadcastPiConvEvent(convProc.convId, {
            type: "pi_status",
            key: evt.statusKey || "status",
            text:
              typeof evt.statusText === "string"
                ? clampText(stripAnsi(evt.statusText), 4000)
                : "",
          });
        } else if (evt.method === "notify") {
          broadcastPiConvEvent(convProc.convId, {
            type: "pi_notice",
            noticeType: evt.notifyType || "info",
            message: clampText(stripAnsi(evt.message || ""), 4000),
          });
        }
        return;
      }

      // The session is missing (either it never existed, or was cleaned
      // up/timed out). Only message/tool/lifecycle records can wake an
      // async turn; unknown protocol records are transport noise.
      const isWakeEvent =
        evt.type === "message_update" ||
        evt.type === "tool_execution_start" ||
        evt.type === "tool_execution_update" ||
        evt.type === "tool_execution_end" ||
        evt.type === "agent_end" ||
        evt.type === "agent_settled";
      if (!isWakeEvent) return;
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
        detached: true,
        abortRequested: false,
        waiters: [],
        streamListeners: new Set(),
        source: "async_wake",
        timeoutMs: convProc.settings.timeoutMs,
        uiSettings: convProc.settings.permissionUx,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        queued: false,
        captureTraceEvents: true,
        traceEvents: [],
        toolArgs: new Map(),
      };
      piRpcSessions.set(captured.id, captured);
      convProc.activeRequestId = captured.id;
      session = captured;
      appendSecurityEvent("pi_async_wake_detected", {
        convId: convProc.convId,
        sessionId: captured.id,
        triggerEvent: evt.type || null,
      });
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

    if (!session) return;

    session.lastActivityAt = Date.now();

    // Extension UI signals (widgets, status lines, notifications) become
    // first-class readable events instead of raw JSON trace dumps. The
    // subagent fleet widget in particular is the same live progress view
    // the terminal shows — forward its lines verbatim (ANSI stripped).
    if (evt.type === "extension_ui_request") {
      if (evt.method === "setWidget") {
        const widgetLines = Array.isArray(evt.widgetLines)
          ? evt.widgetLines
              .slice(0, 80)
              .map((l) => clampText(stripAnsi(l), 4000))
          : null;
        emitPiSessionEvent(session, {
          type: "pi_widget",
          sessionId: session.id,
          key: evt.widgetKey || "widget",
          lines: widgetLines,
        });
        return;
      }
      if (evt.method === "setStatus") {
        emitPiSessionEvent(session, {
          type: "pi_status",
          sessionId: session.id,
          key: evt.statusKey || "status",
          text:
            typeof evt.statusText === "string"
              ? clampText(stripAnsi(evt.statusText), 4000)
              : "",
        });
        return;
      }
      if (evt.method === "notify") {
        emitPiSessionEvent(session, {
          type: "pi_notice",
          sessionId: session.id,
          noticeType: evt.notifyType || "info",
          message: clampText(stripAnsi(evt.message || ""), 4000),
        });
        return;
      }
      if (evt.method === "setTitle" || evt.method === "set_editor_text") {
        return; // terminal-only concerns, meaningless in the web UI
      }
      // select / confirm / input / editor fall through to the dialog
      // handler below (isPiDialogRequest).
    }

    if (evt.type === "auto_retry_start") {
      emitPiSessionEvent(session, {
        type: "provider_retry",
        attempt: Number.isFinite(evt.attempt) ? evt.attempt : null,
        maxAttempts: Number.isFinite(evt.maxAttempts) ? evt.maxAttempts : null,
        delayMs: Number.isFinite(evt.delayMs) ? evt.delayMs : null,
        sessionId: session.id,
      });
      return;
    }

    if (evt.type === "auto_retry_end") {
      emitPiSessionEvent(session, {
        type: "provider_retry_end",
        attempt: Number.isFinite(evt.attempt) ? evt.attempt : null,
        success: evt.success === true,
        sessionId: session.id,
      });
      return;
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
      return;
    }

    if (
      evt.type === "message_end" &&
      evt.message?.role === "assistant" &&
      !session.response.trim()
    ) {
      const text = extractAssistantText(evt.message);
      if (text) {
        session.response = clampText(text, MAX_PI_RESPONSE_CHARS);
        emitPiSessionEvent(session, {
          type: "delta",
          delta: clampText(text, 12000),
          response: session.response,
          sessionId: session.id,
        });
      }
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
      return;
    }

    // Lifecycle and command-response records are protocol noise. They
    // still drive state transitions above, but never reach the UI trace.
    if (
      evt.type === "agent_start" ||
      evt.type === "turn_start" ||
      evt.type === "turn_end" ||
      evt.type === "message_start" ||
      evt.type === "message_end" ||
      evt.type === "response"
    ) {
      return;
    }

    if (evt.type === "compaction_start") {
      emitPiSessionEvent(session, {
        type: "compaction_start",
        reason: evt.reason || null,
        sessionId: session.id,
      });
      return;
    }

    if (evt.type === "compaction_end") {
      emitPiSessionEvent(session, {
        type: "compaction_end",
        reason: evt.reason || null,
        tokensBefore: evt.result?.tokensBefore || null,
        sessionId: session.id,
      });
      return;
    }

    if (evt.type === "message_update") {
      const delta = evt.assistantMessageEvent;
      if (
        delta?.type === "toolcall_start" ||
        delta?.type === "toolcall_delta" ||
        delta?.type === "toolcall_end"
      ) {
        emitPiSessionEvent(session, {
          type: "tool_call_update",
          sessionId: session.id,
          phase: delta.type,
          contentIndex: Number.isSafeInteger(delta.contentIndex)
            ? delta.contentIndex
            : null,
          toolCallId:
            typeof delta.toolCallId === "string"
              ? delta.toolCallId
              : typeof delta.toolCall?.id === "string"
                ? delta.toolCall.id
                : null,
          delta: typeof delta.delta === "string" ? delta.delta : "",
          partial: boundedJsonValue(redactPiRpcValue(delta.partial), 64 * 1024),
          toolCall: boundedJsonValue(
            redactPiRpcValue(delta.toolCall),
            64 * 1024,
          ),
        });
        return;
      }
      if (delta?.type === "thinking_start") {
        emitPiSessionEvent(session, {
          type: "thinking_start",
          sessionId: session.id,
        });
        return;
      }
      if (delta?.type === "thinking_delta") {
        const chunk = typeof delta.delta === "string" ? delta.delta : "";
        if (chunk && session.thinking.length < MAX_PI_THINKING_CHARS) {
          session.thinking = (session.thinking + chunk).slice(
            0,
            MAX_PI_THINKING_CHARS,
          );
        }
        emitPiSessionEvent(session, {
          type: "thinking_delta",
          delta: clampText(chunk, 12000),
          thinking: session.thinking,
          sessionId: session.id,
        });
        return;
      }
      if (delta?.type === "thinking_end") {
        emitPiSessionEvent(session, {
          type: "thinking_end",
          thinking: session.thinking,
          sessionId: session.id,
        });
        return;
      }
      if (delta?.type === "text_delta") {
        const chunk = typeof delta.delta === "string" ? delta.delta : "";
        if (!chunk) return;
        // First text of the wake turn (after async subagents finished):
        // separate it from the pre-async text instead of gluing them.
        if (session.awaitingAsync) {
          session.awaitingAsync = false;
          if (session.response && session.response.trim()) {
            session.response += "\n\n";
          }
        }
        if (session.response.length < MAX_PI_RESPONSE_CHARS) {
          session.response = (session.response + chunk).slice(
            0,
            MAX_PI_RESPONSE_CHARS,
          );
        }
        emitPiSessionEvent(session, {
          type: "delta",
          delta: clampText(chunk, 12000),
          response: session.response,
          sessionId: session.id,
        });
        return;
      }
      // Fallback: if it's a message update but not a delta, it might be a full response.
      if (typeof delta === "string" && delta.trim()) {
        session.response = clampText(delta, MAX_PI_RESPONSE_CHARS);
        emitPiSessionEvent(session, {
          type: "delta",
          delta: clampText(delta, 12000),
          response: session.response,
          sessionId: session.id,
        });
        return;
      }
      return;
    }

    if (evt.type === "tool_execution_start") {
      if (evt.toolCallId && session.toolArgs instanceof Map) {
        session.toolArgs.set(evt.toolCallId, evt.args || {});
      }
      emitPiSessionEvent(session, {
        type: "tool_start",
        sessionId: session.id,
        toolName: evt.toolName || null,
        toolCallId: evt.toolCallId || null,
        argsPreview: clampText(JSON.stringify(evt.args || {}), 400),
      });
      return;
    }

    if (evt.type === "tool_execution_update") {
      const limit = toolOutputLimit(session);
      const output = extractToolTextPayload(evt.partialResult);
      emitPiSessionEvent(session, {
        type: "tool_update",
        sessionId: session.id,
        toolName: evt.toolName || null,
        toolCallId: evt.toolCallId || null,
        outputPreview: clampText(output, limit),
        result: snapshotToolResult(
          {
            ...(evt.partialResult || {}),
            toolCallId: evt.toolCallId,
            toolName: evt.toolName,
          },
          limit,
        ),
      });
      return;
    }

    if (evt.type === "tool_execution_end") {
      const limit = toolOutputLimit(session);
      const output = extractToolTextPayload(evt.result);
      const toolArgs =
        evt.toolCallId && session.toolArgs instanceof Map
          ? session.toolArgs.get(evt.toolCallId) || {}
          : {};
      if (evt.toolCallId && session.toolArgs instanceof Map) {
        session.toolArgs.delete(evt.toolCallId);
      }
      emitPiSessionEvent(session, {
        type: "tool_end",
        sessionId: session.id,
        toolName: evt.toolName || null,
        toolCallId: evt.toolCallId || null,
        isError: evt.isError === true,
        outputPreview: clampText(output, limit),
        result: snapshotToolResult(
          {
            ...(evt.result || {}),
            toolCallId: evt.toolCallId,
            toolName: evt.toolName,
            isError: evt.isError === true,
          },
          limit,
        ),
      });
      const sources = extractWebSources(evt.toolName, toolArgs, output);
      if (sources.length) {
        emitPiSessionEvent(session, {
          type: "web_sources",
          sessionId: session.id,
          sources,
        });
      }
      return;
    }

    if (isPiDialogRequest(evt)) {
      session.pendingDialog = evt;
      emitPiSessionEvent(session, {
        type: "needs_ui",
        sessionId: session.id,
        request: formatPiUiRequest(evt),
      });
      notifyPiSession(session);
      return;
    }

    if (evt.type === "agent_end") {
      // Pi's agent_end closes one low-level run only. It may be followed
      // by retry, compaction retry, queued follow-ups, or an async wake.
      // agent_settled is the session-level completion boundary.
      session.agentEnded = true;
      session.agentWillRetry = evt.willRetry === true;
      if (session.agentWillRetry) session.awaitingAsync = true;
      return;
    }

    if (evt.type === "agent_settled") {
      session.agentSettled = true;
      finishPiSession(session);
      return;
    }

    if (evt.type === "extension_error") {
      emitPiSessionEvent(session, {
        type: "trace",
        sessionId: session.id,
        label: "extension_error",
        detail: clampText(JSON.stringify(redactPiRpcValue(evt)), 1500),
      });
      return;
    }
  }

  function getOrCreatePiConvProcess(convId, piSettings = null) {
    if (piShuttingDown) {
      throw createHttpError(503, "Pi subsystem is shutting down.");
    }
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
        signalPiProcess(piConvProcesses.get(oldest).proc, "SIGTERM");
        piConvProcesses.delete(oldest);
      }
    }

    const settings = sanitizePiSettings(piSettings || loadPiSettings());
    const configuredCommand =
      typeof settings.commandPath === "string"
        ? settings.commandPath.trim()
        : "";
    const cmd = configuredCommand || getPiCommand();
    const piArgs = ["--mode", "rpc"];
    const rpcUiCompat = path.join(__dirname, "pi-rpc-ui-compat.js");
    if (fs.existsSync(rpcUiCompat)) {
      // Keep the frequently updated pi-sandbox package untouched. This
      // Dive-owned RPC adapter translates its custom terminal prompt into the
      // select dialog already handled by the web UI.
      piArgs.push("--extension", rpcUiCompat);
    }
    const proc = spawn(cmd, piArgs, {
      cwd: settings.workingDirectory || DATA_DIR,
      env: buildPiEnv(),
      detached: process.platform !== "win32",
    });
    let initialStateReady = false;
    let resolveInitialState;
    let initialStateTimer;
    const initialStatePromise = new Promise((resolve) => {
      resolveInitialState = () => {
        if (initialStateReady) return;
        initialStateReady = true;
        clearTimeout(initialStateTimer);
        resolve();
      };
      initialStateTimer = setTimeout(resolveInitialState, 3000);
      initialStateTimer.unref?.();
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
      stderrData: "",
      closed: false,
      protocolError: null,
      lastActivityAt: Date.now(),
      settings,
      sessionFile: null,
      activeRequestId: null,
      pendingStatsResolver: null,
      pendingStateResolver: null,
      pendingCommandResolvers: new Map(),
      initialStatePromise,
      // handlePiRpcEvent resolves this when Pi answers the opening get_state.
      resolveInitialState,
      convId,
    };

    const failPiProcess = (cause) => {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      if (!convProc.protocolError) convProc.protocolError = error;
      resolveInitialState();
      rejectPendingPiCommands(convProc, error);
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
        const active = piRpcSessions.get(convProc.activeRequestId);
        if (active && !active.done && !active.error) {
          active.closed = true;
          active.error = error;
          emitPiSessionEvent(active, {
            type: "error",
            error: error.message,
            sessionId: active.id,
          });
          notifyPiSession(active);
        }
      }
      signalPiProcess(proc, "SIGTERM");
    };

    piConvProcesses.set(convId, convProc);

    const decoder = new PiJsonlDecoder((evt) =>
      handlePiRpcEvent(convProc, evt),
    );
    convProc.rpcDecoder = decoder;
    proc.stdout.on("data", (chunk) => {
      try {
        decoder.push(chunk);
      } catch (error) {
        failPiProcess(error);
      }
    });
    proc.stdout.on("end", () => {
      try {
        decoder.end();
      } catch (error) {
        failPiProcess(error);
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
      failPiProcess(new Error(errMsg));
    });

    proc.on("close", (code) => {
      convProc.closed = true;
      resolveInitialState();
      const closeDiagnostic = clampText(convProc.stderrData.trim(), 1500);
      if (code !== 0 && closeDiagnostic) {
        appendSecurityEvent("pi_process_failure", {
          convId,
          code,
          diagnostic: closeDiagnostic,
        });
      }
      const closeError =
        code === 0
          ? new Error("Pi process closed before the RPC session settled.")
          : new Error(
              `Pi process exited with code ${code}. Check the Pi process log for details.`,
            );
      rejectPendingPiCommands(convProc, closeError);
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
          session.closed = true;
          if (!session.error) {
            if (code !== 0) {
              session.error = closeError;
              emitPiSessionEvent(session, {
                type: "error",
                error: session.error.message,
                sessionId: session.id,
              });
              notifyPiSession(session);
            } else {
              finishPiSession(session);
            }
          }
          if (session.error) cleanupPiSession(session.id, "process_exit");
          else if (session.done) cleanupPiSession(session.id, "process_exit");
        }
      }
    });

    try {
      proc.stdin.write(JSON.stringify({ type: "get_state" }) + "\n");
    } catch (error) {
      failPiProcess(error);
    }

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
      try {
        convProc.proc.stdin.write(JSON.stringify({ type: "get_state" }) + "\n");
      } catch (_error) {
        finish(null);
      }
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
      try {
        convProc.proc.stdin.write(
          JSON.stringify({ type: "get_session_stats" }) + "\n",
        );
      } catch (_error) {
        finish(null);
      }
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
    // Skip queue entries whose session was cleaned up while waiting. A loop
    // rather than recursion: a long queue of dead entries must not grow the
    // stack one frame per entry.
    while (convProc.queue && convProc.queue.length > 0) {
      const next = convProc.queue.shift();
      const session = piRpcSessions.get(next.id);
      if (!session) continue;
      session.queued = false;
      dispatchPiPrompt(convProc, session, next.message, next.images);
      return;
    }
    convProc.activeRequestId = null;
  }

  function dispatchPiPrompt(convProc, session, message, images = []) {
    convProc.activeRequestId = session.id;
    const payload = JSON.stringify({
      type: "prompt",
      message,
      ...(Array.isArray(images) && images.length ? { images } : {}),
      source: session.source,
    });
    try {
      convProc.proc.stdin.write(payload + "\n");
      session.lastActivityAt = Date.now();
    } catch (error) {
      session.error = error instanceof Error ? error : new Error(String(error));
      emitPiSessionEvent(session, {
        type: "error",
        error: session.error.message,
        sessionId: session.id,
      });
      Promise.resolve().then(() => {
        notifyPiSession(session);
        if (session.detached)
          cleanupPiSession(session.id, "prompt_write_error");
      });
    }
  }

  // ---- Pi environment banner (version, context, skills, prompts, extensions) ----
  const piVersionCache = new Map();
  function getPiVersionSync(settings = loadPiSettings()) {
    const configured =
      typeof settings?.commandPath === "string"
        ? settings.commandPath.trim()
        : "";
    const cacheKey = configured || "(auto)";
    if (piVersionCache.has(cacheKey)) return piVersionCache.get(cacheKey);
    let version = "";
    try {
      let cmd = configured || getPiCommand();
      if (!path.isAbsolute(cmd)) {
        const workingCandidate = path.resolve(
          settings?.workingDirectory || DATA_DIR,
          cmd,
        );
        if (fs.existsSync(workingCandidate)) {
          cmd = workingCandidate;
        } else {
          const lookup = spawnSync("/usr/bin/env", ["which", cmd], {
            encoding: "utf8",
            env: buildPiEnv(),
          });
          const found = (lookup.stdout || "").trim().split("\n")[0];
          if (found) cmd = found;
        }
      }
      const real = fs.realpathSync(cmd);
      const pkg = JSON.parse(
        fs.readFileSync(
          path.join(path.dirname(real), "..", "package.json"),
          "utf8",
        ),
      );
      version = typeof pkg.version === "string" ? pkg.version : "";
    } catch (_e) {
      // Expected: Pi installed somewhere without a readable package.json. The
      // banner degrades to "pi" with no version.
    }
    piVersionCache.set(cacheKey, version);
    return version;
  }

  // Deliver only a bounded runtime/version banner to the browser. Pi's
  // extension, skill, prompt, and context-file inventory is intentionally kept
  // inside the external process rather than exposed through the web API.
  async function emitPiEnvironmentBanner(convProc, session) {
    const version = getPiVersionSync(convProc.settings);
    emitPiSessionEvent(session, {
      type: "pi_banner",
      sessionId: session.id,
      text: version ? `pi v${version}` : "pi",
    });
  }

  // Send a one-shot RPC command (model switching, thinking level, compaction,
  // stats) to a conversation's pi process and await its response. This is
  // what lets the web UI expose a narrow set of safe session controls.
  function sendPiCommand(convProc, command, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (
        convProc.closed ||
        convProc.protocolError ||
        !convProc.proc.stdin ||
        !convProc.proc.stdin.writable
      ) {
        reject(
          convProc.protocolError ||
            new Error("Pi process stdin is not writable."),
        );
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
      convProc.pendingCommandResolvers.set(id, { resolve, reject, timer });
      try {
        convProc.proc.stdin.write(JSON.stringify({ ...command, id }) + "\n");
        convProc.lastActivityAt = Date.now();
      } catch (error) {
        clearTimeout(timer);
        convProc.pendingCommandResolvers.delete(id);
        reject(error);
      }
    });
  }

  const PI_BROWSER_COMMAND_TYPES = new Set([
    "abort",
    "new_session",
    "get_state",
    "get_available_models",
    "set_model",
    "cycle_model",
    "set_thinking_level",
    "cycle_thinking_level",
    "get_available_thinking_levels",
    "set_steering_mode",
    "set_follow_up_mode",
    "compact",
    "set_auto_compaction",
    "set_auto_retry",
    "abort_retry",
    "abort_bash",
    "get_session_stats",
    "switch_session",
    "set_session_name",
  ]);
  const PI_THINKING_LEVELS = new Set([
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  const PI_QUEUE_MODES = new Set(["all", "one-at-a-time"]);

  function normalizePiBrowserCommand(command) {
    if (!command || typeof command !== "object") {
      throw createHttpError(400, "Unsupported Pi command");
    }
    const type = typeof command.type === "string" ? command.type : "";
    if (!PI_BROWSER_COMMAND_TYPES.has(type)) {
      throw createHttpError(400, "Unsupported Pi command");
    }
    const normalized = { type };
    if (type === "set_model") {
      if (
        typeof command.provider !== "string" ||
        typeof command.modelId !== "string" ||
        !command.provider.trim() ||
        !command.modelId.trim()
      ) {
        throw createHttpError(400, "provider and modelId are required");
      }
      normalized.provider = command.provider.trim().slice(0, 200);
      normalized.modelId = command.modelId.trim().slice(0, 300);
    } else if (type === "set_thinking_level") {
      if (!PI_THINKING_LEVELS.has(command.level)) {
        throw createHttpError(400, "Invalid thinking level");
      }
      normalized.level = command.level;
    } else if (type === "set_steering_mode" || type === "set_follow_up_mode") {
      if (!PI_QUEUE_MODES.has(command.mode)) {
        throw createHttpError(400, "Invalid queue mode");
      }
      normalized.mode = command.mode;
    } else if (type === "set_auto_compaction" || type === "set_auto_retry") {
      if (typeof command.enabled !== "boolean") {
        throw createHttpError(400, `${type}.enabled must be boolean`);
      }
      normalized.enabled = command.enabled;
    } else if (type === "set_session_name") {
      if (typeof command.name !== "string") {
        throw createHttpError(400, "set_session_name.name must be a string");
      }
      normalized.name = command.name.trim().slice(0, 200);
    } else if (type === "switch_session") {
      if (typeof command.sessionPath !== "string") {
        throw createHttpError(400, "sessionPath is required");
      }
      normalized.sessionPath = command.sessionPath.trim().slice(0, 1000);
    } else if (
      type === "compact" &&
      typeof command.customInstructions === "string"
    ) {
      normalized.customInstructions = command.customInstructions.slice(0, 2000);
    }
    return normalized;
  }

  function publicPiModel(model) {
    if (!model || typeof model !== "object") return null;
    return {
      provider:
        typeof model.provider === "string" ? model.provider.slice(0, 100) : "",
      id: typeof model.id === "string" ? model.id.slice(0, 200) : "",
      name: typeof model.name === "string" ? model.name.slice(0, 200) : "",
    };
  }

  function sanitizePiCommandResult(command, response) {
    const type = command.type;
    const result = response && typeof response === "object" ? response : {};
    const clean = {
      type: "response",
      command: type,
      success: result.success !== false,
    };
    if (typeof result.error === "string") {
      clean.error = clampText(result.error, 1000);
    }
    const data =
      result.data && typeof result.data === "object" ? result.data : {};
    if (type === "get_state") {
      clean.data = {
        model: publicPiModel(data.model),
        thinkingLevel:
          typeof data.thinkingLevel === "string" ? data.thinkingLevel : null,
        isStreaming: data.isStreaming === true,
        isCompacting: data.isCompacting === true,
        steeringMode:
          typeof data.steeringMode === "string" ? data.steeringMode : null,
        followUpMode:
          typeof data.followUpMode === "string" ? data.followUpMode : null,
        sessionName:
          typeof data.sessionName === "string"
            ? clampText(data.sessionName, 200)
            : null,
        messageCount: Number.isSafeInteger(data.messageCount)
          ? data.messageCount
          : null,
        pendingMessageCount: Number.isSafeInteger(data.pendingMessageCount)
          ? data.pendingMessageCount
          : null,
      };
    } else if (type === "get_available_models") {
      clean.data = {
        models: Array.isArray(data.models)
          ? data.models.slice(0, 200).map(publicPiModel)
          : [],
      };
    } else if (type === "get_available_thinking_levels") {
      clean.data = {
        levels: Array.isArray(data.levels)
          ? data.levels.filter((level) => PI_THINKING_LEVELS.has(level))
          : [],
      };
    } else if (type === "get_session_stats") {
      clean.data = {
        contextUsage: data.contextUsage
          ? {
              tokens: Number(data.contextUsage.tokens) || 0,
              contextWindow: Number(data.contextUsage.contextWindow) || 0,
              percent: Number(data.contextUsage.percent) || 0,
            }
          : null,
        cost: Number.isFinite(Number(data.cost)) ? Number(data.cost) : null,
        userMessages: Number(data.userMessages) || 0,
        assistantMessages: Number(data.assistantMessages) || 0,
        toolCalls: Number(data.toolCalls) || 0,
        toolResults: Number(data.toolResults) || 0,
        totalMessages: Number(data.totalMessages) || 0,
      };
    } else if (type === "set_model" || type === "cycle_model") {
      clean.data = { model: publicPiModel(data.model) };
    } else if (type === "cycle_thinking_level") {
      clean.data = {
        level: PI_THINKING_LEVELS.has(data.level) ? data.level : null,
      };
    } else if (type === "compact") {
      clean.data = {
        tokensBefore: Number(data.tokensBefore) || 0,
        tokensAfter: Number(data.tokensAfter || data.estimatedTokensAfter) || 0,
      };
    } else if (typeof data.cancelled === "boolean") {
      clean.data = { cancelled: data.cancelled };
    } else if (result.success === false) {
      clean.data = {};
    }
    return clean;
  }

  function normalizePiImages(images) {
    const normalized = [];
    let totalBytes = 0;
    for (const image of Array.isArray(images) ? images : []) {
      if (
        !image ||
        image.type !== "image" ||
        typeof image.data !== "string" ||
        typeof image.mimeType !== "string"
      ) {
        continue;
      }
      const bytes = Buffer.byteLength(image.data, "base64");
      if (
        !Number.isFinite(bytes) ||
        bytes <= 0 ||
        bytes > MAX_PI_IMAGE_BYTES ||
        totalBytes + bytes > MAX_PI_IMAGE_TOTAL_BYTES
      ) {
        continue;
      }
      normalized.push({
        type: "image",
        data: image.data,
        mimeType: image.mimeType.slice(0, 100),
      });
      totalBytes += bytes;
      if (normalized.length >= 8) break;
    }
    return normalized;
  }

  function preparePiImagePrompt(convProc, images, promptMessage) {
    const piImages = Array.isArray(images) ? images : [];
    const modelInputs = Array.isArray(convProc.model?.input)
      ? convProc.model.input
      : null;
    if (modelInputs && modelInputs.includes("image")) {
      return {
        message: promptMessage,
        images: piImages.map((image) => ({
          type: "image",
          data: image.dataBase64,
          mimeType: image.mimeType,
        })),
      };
    }

    if (!piImages.length) return { message: promptMessage, images: [] };
    const piStageDir = piAttachmentStageDir();
    if (piStageDir) sweepPiAttachments(piStageDir);
    const refs = [];
    for (const image of piImages) {
      if (!piStageDir) break;
      const tmp = path.join(
        piStageDir,
        "pi_img_" +
          randomBytes(8).toString("hex") +
          extForImageMime(image.mimeType),
      );
      try {
        fs.writeFileSync(tmp, Buffer.from(image.dataBase64, "base64"), {
          mode: 0o600,
        });
        refs.push(tmp);
        setTimeout(() => {
          try {
            fs.unlinkSync(tmp);
          } catch (_e) {
            // Expected: already swept, or the directory was removed.
          }
        }, PI_ATTACHMENT_TTL_MS).unref();
      } catch (error) {
        // Not expected. The image is dropped from the prompt entirely and Pi
        // is never told it existed, so this must not be silent.
        console.error(
          `[pi] failed to stage an attachment for Pi (${image.mimeType}):`,
          error,
        );
      }
    }
    if (!refs.length) return { message: promptMessage, images: [] };
    return {
      message:
        promptMessage +
        "\n\n[Attached image file" +
        (refs.length > 1 ? "s" : "") +
        " saved locally — open with your image/file tools: " +
        refs.join(", ") +
        "]",
      images: [],
    };
  }

  function sendPiPrompt(convProc, message, source = "manual", images = []) {
    // The conversation ID owns the process and persistent SSE channel, but
    // every prompt needs its own session ID so concurrent HTTP requests cannot
    // overwrite each other's dialog, queue, or cleanup state.
    const id = createPiSessionId();

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
      detached: false,
      abortRequested: false,
      images: normalizePiImages(images),
      toolArgs: new Map(),
    };

    piRpcSessions.set(id, session);

    if (convProc.protocolError) {
      session.error = convProc.protocolError;
      Promise.resolve().then(() => notifyPiSession(session));
      return session;
    }

    if (isPiConvProcBusy(convProc)) {
      session.queued = true;
      if (!convProc.queue) convProc.queue = [];
      convProc.queue.push({ id, message, images: session.images });
      emitPiSessionEvent(session, { type: "queued", sessionId: id });
      return session;
    }

    dispatchPiPrompt(convProc, session, message, session.images);
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
    const pending = session.pendingDialog;
    if (!pending || pending.id !== uiResponse.id) {
      throw new Error("uiResponse.id does not match current pending request");
    }

    const method = pending.method;
    const cancelled = uiResponse.cancelled === true;
    if (!cancelled) {
      if (method === "confirm" && typeof uiResponse.confirmed !== "boolean") {
        throw new Error("confirm responses require a boolean confirmed value");
      }
      if (
        (method === "select" || method === "input" || method === "editor") &&
        typeof uiResponse.value !== "string"
      ) {
        throw new Error(`${method} responses require a string value`);
      }
      if (
        method === "select" &&
        Array.isArray(pending.options) &&
        pending.options.length > 0 &&
        !pending.options.includes(uiResponse.value)
      ) {
        throw new Error("select response value is not one of the options");
      }
    }

    if (session.proc.stdin.destroyed || session.proc.stdin.writableEnded) {
      throw new Error("Pi RPC stdin is not writable");
    }

    const response = { type: "extension_ui_response", id: uiResponse.id };
    if (cancelled) {
      response.cancelled = true;
    } else if (method === "confirm") {
      response.confirmed = uiResponse.confirmed;
    } else {
      response.value = uiResponse.value;
    }
    session.proc.stdin.write(JSON.stringify(response) + "\n");
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

    // Replay buffers are bounded per conversation, and idle channel objects
    // are bounded globally as well. Keep channels that still have a process,
    // session, or subscriber; discard abandoned arbitrary IDs after a TTL.
    for (const [convId, channel] of piEventChannels.entries()) {
      if (channel.subscribers.size > 0) continue;
      if (piConvProcesses.has(convId)) continue;
      const hasSession = [...piRpcSessions.values()].some(
        (session) => normalizePiChannelId(session.convProc?.convId) === convId,
      );
      if (
        !hasSession &&
        now - channel.lastActivityAt > PI_EVENT_CHANNEL_TTL_MS
      ) {
        piEventChannels.delete(convId);
      }
    }
  }, PI_SESSION_SWEEP_INTERVAL_MS).unref();

  async function dispatch(ctx) {
    const { req, res, urlPath, send } = ctx;

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
        // Strict: an unusable command path or working directory is reported
        // back to the user rather than silently saved as blank.
        const sanitized = sanitizePiSettings(nextSettings, { strict: true });
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

    if (req.method === "GET" && urlPath.startsWith("/api/pi/events")) {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      let convId;
      try {
        convId = requirePiConversationId(url.searchParams.get("conv"));
      } catch (error) {
        res.writeHead(error.statusCode || 400, {
          "Content-Type": "application/json",
        });
        res.end(JSON.stringify({ error: error.message }));
        return;
      }
      const channel = getPiEventChannel(convId);
      if (!channel) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Pi event channel capacity reached" }));
        return;
      }
      const requestedAfter = Number.parseInt(
        url.searchParams.get("after") || req.headers["last-event-id"] || "0",
        10,
      );
      const after = Number.isSafeInteger(requestedAfter) ? requestedAfter : 0;
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write("retry: 1000\n\n: connected\n\n");
      const oldestSequence = channel.events[0]?.sequence || 0;
      if (after > 0 && oldestSequence > after + 1) {
        res.write(
          `data: ${JSON.stringify({
            type: "replay_gap",
            convId,
            sequence: oldestSequence - 1,
            oldestSequence,
            latestSequence: channel.nextSequence,
          })}\n\n`,
        );
      }
      for (const event of channel.events) {
        if (event.sequence <= after) continue;
        const replayEvent = {
          ...event,
          replay: true,
          ...(event.sessionId
            ? {
                completed: channel.completedSessions.has(event.sessionId),
              }
            : {}),
        };
        res.write(
          `id: ${event.sequence}\ndata: ${JSON.stringify(replayEvent)}\n\n`,
        );
      }
      channel.subscribers.add(res);
      const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(": hb\n\n");
      }, 15000);
      heartbeat.unref?.();
      res.on("close", () => {
        clearInterval(heartbeat);
        channel.subscribers.delete(res);
        // Keep the bounded replay buffer after the last subscriber leaves.
        // A later reconnect can still recover events emitted meanwhile.
      });
      return;
    }

    if (req.method === "POST" && urlPath === "/api/pi/command") {
      try {
        const body = await parseJsonBody(req);
        const convId = requirePiConversationId(body.saveConv || body.convId);
        const command = normalizePiBrowserCommand(body.command);
        // `abort` targets a RUNNING generation: never spawn a fresh Pi
        // process just to abort nothing — that both misses the real target
        // and leaks a new process. Absent process = nothing to stop = ok.
        if (command.type === "abort") {
          const existing = piConvProcesses.get(convId);
          if (!existing) {
            send(200, { ok: true, result: { success: true, noop: true } });
            return;
          }
          cancelQueuedPiSessions(existing, "command_abort");
          const activeId = existing.activeRequestId;
          const result = await stopPiGeneration(existing);
          const active = activeId ? piRpcSessions.get(activeId) : null;
          if (active) {
            try {
              await waitForPiSessionStep(active, 5000);
            } catch (_error) {
              // Expected: the abort may time out; cleanup happens either way.
            }
            cleanupPiSession(active.id, "command_abort");
          }
          send(200, {
            ok: result?.success !== false,
            result: sanitizePiCommandResult(command, result),
          });
          return;
        }
        const convProc = getOrCreatePiConvProcess(convId, loadPiSettings());
        await convProc.initialStatePromise;
        if (
          (command.type === "new_session" ||
            command.type === "switch_session") &&
          convProc.activeRequestId
        ) {
          send(409, { error: "Pi conversation is busy" });
          return;
        }
        if (command.type === "switch_session") {
          if (
            typeof command.sessionPath !== "string" ||
            !isAllowedPiSessionPath(convProc, command.sessionPath)
          ) {
            send(400, { error: "sessionPath is outside the Pi session store" });
            return;
          }
        }
        const timeoutMs = command.type === "compact" ? 180000 : 15000;
        const result = await sendPiCommand(convProc, command, timeoutMs);
        send(200, {
          ok: result?.success !== false,
          result: sanitizePiCommandResult(command, result),
        });
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return;
    }

    if (req.method === "POST" && urlPath === "/api/pi/new-session") {
      try {
        const body = await parseJsonBody(req);
        const convId = requirePiConversationId(body.saveConv || body.convId);
        const convProc = piConvProcesses.get(convId);
        if (convProc && !convProc.closed) {
          cancelQueuedPiSessions(convProc, "new_session_abort");
          if (convProc.activeRequestId) {
            const activeId = convProc.activeRequestId;
            await stopPiGeneration(convProc);
            const active = piRpcSessions.get(activeId);
            if (active) {
              try {
                await waitForPiSessionStep(active, 5000);
                cleanupPiSession(active.id, "new_session_abort");
              } catch (error) {
                active.closed = true;
                convProc.closed = true;
                signalPiProcess(convProc.proc, "SIGTERM");
                cleanupPiSession(active.id, "new_session_abort");
                send(504, {
                  error: `Pi did not settle before starting a new session: ${error.message}`,
                });
                return;
              }
            }
          }
          const command = { type: "new_session" };
          const result = await sendPiCommand(convProc, command, 15000);
          send(200, {
            ok: result?.success !== false,
            result: sanitizePiCommandResult(command, result),
          });
          return;
        }
        send(200, { ok: true, result: { success: true, noop: true } });
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return;
    }

    if (req.method === "POST" && urlPath === "/api/pi/load-session") {
      try {
        const body = await parseJsonBody(req);
        const convId = requirePiConversationId(body.saveConv || body.convId);
        const { sessionFile } = body;

        if (typeof sessionFile !== "string" || !sessionFile.trim()) {
          send(400, { error: "sessionFile must be a non-empty string" });
          return;
        }
        const resolvedPath = path.resolve(sessionFile.trim());

        const convProc = getOrCreatePiConvProcess(convId);
        await convProc.initialStatePromise;
        // A switch_session sent to a process that is mid-turn resets the
        // agent and cancels the in-flight generation. Refuse instead: the
        // running turn already owns the session, and the file can be loaded
        // once the turn has finished.
        if (convProc.activeRequestId) {
          send(200, { ok: false, busy: true });
          return;
        }
        if (!isAllowedPiSessionPath(convProc, resolvedPath)) {
          send(400, { error: "sessionFile is outside the Pi session store" });
          return;
        }
        // Same plumbing as /api/pi/command: the command is tracked by id and
        // its outcome is reported. Callers open sessions in the background, so
        // a Pi-side failure is reported as ok:false rather than a 5xx.
        const command = { type: "switch_session", sessionPath: resolvedPath };
        try {
          const result = await sendPiCommand(convProc, command, 15000);
          send(200, {
            ok: result?.success !== false,
            result: sanitizePiCommandResult(command, result),
          });
        } catch (commandError) {
          send(200, { ok: false, error: commandError.message });
        }
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return;
    }

    if (req.method === "POST" && urlPath === "/api/pi/stats") {
      try {
        const body = await parseJsonBody(req);
        const convId = requirePiConversationId(body.saveConv || body.convId);
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
        const convId = requirePiConversationId(body.saveConv || body.convId);
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
        const storedEvent = skipStore
          ? null
          : sanitizeTraceEventForStorage(evt);
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
        const slashCommand = parseSlashCommand(originalMessage, {});
        const promptQuestion = getCommandMessage(slashCommand, originalMessage);
        // `messages` is what gets stored for this conversation: attachments are
        // recorded as refs on the user turn so the thumbnails survive in
        // history, exactly as in the other modes.
        const messages = normalizeStoredConversationMessages(
          history,
          originalMessage,
          body.images,
        );
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

        // Resolved and reported before Pi is started: the user attached these
        // regardless of whether the agent comes up, so a startup failure must
        // not also swallow the news that some of them were dropped.
        const droppedAttachments = [];
        const turnImages = resolveAttachmentImages(
          body.images,
          droppedAttachments,
        );
        if (droppedAttachments.length) {
          writeStreamEvent({
            type: "attachment_notice",
            message: describeDroppedAttachments(droppedAttachments),
            dropped: droppedAttachments,
          });
        }

        const piSettings = loadPiSettings();
        const convId = requirePiConversationId(body.saveConv);
        const convProc = getOrCreatePiConvProcess(convId, piSettings);
        await convProc.initialStatePromise;
        const preparedImages = preparePiImagePrompt(
          convProc,
          turnImages,
          promptMessage,
        );
        session = sendPiPrompt(
          convProc,
          preparedImages.message,
          source,
          preparedImages.images,
        );
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
          } catch (error) {
            // The streaming checkpoint is what protects an in-flight turn from
            // a crash or a Stop. Losing it silently loses the answer.
            console.error(
              "[pi] failed to checkpoint the in-flight turn:",
              error,
            );
          }
        };
        writeStreamEvent({ type: "session_start", sessionId: session.id });
        if (!convProc.bannerEmitted) {
          convProc.bannerEmitted = true;
          // Cosmetic banner only; a failure costs nothing visible.
          emitPiEnvironmentBanner(convProc, session).catch(() => {});
        }

        unsubscribe = addPiSessionListener(session, (evt) => {
          if (evt.type === "web_sources" && Array.isArray(evt.sources)) {
            const seen = new Set(
              librarySourceResults
                .map((source) => String(source?.url || ""))
                .filter(Boolean),
            );
            for (const source of evt.sources) {
              const url = String(source?.url || "");
              if (!url || seen.has(url)) continue;
              seen.add(url);
              librarySourceResults.push(source);
            }
          }
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
            // The client went away mid-run (stop button, app closed, reload).
            // Stop MUST stop: send a real abort RPC to the Pi process
            // (terminal Esc parity) and drop any queued follow-up prompts,
            // otherwise Pi keeps generating server-side and the finished
            // answer resurrects through the SSE channel and checkpoints.
            if (!session.done) {
              cancelQueuedPiSessions(convProc, "stream_client_disconnected");
              // Keep the detached session until Pi emits agent_settled. This
              // prevents the late abort lifecycle from being misclassified as
              // an unrelated async wake turn.
              abortPiSession(session, "stream_client_disconnected");
              // Checkpoint whatever the turn produced so far — but only if it
              // produced anything; an empty checkpoint would race with (and
              // clobber) the client's own "Request cancelled" save.
              if (typeof persistPartial === "function" && session.response) {
                persistPartial();
              }
            } else {
              cleanupPiSession(session.id, "stream_client_disconnected");
            }
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
      (urlPath === "/api/pi" || urlPath === "/api/pi/start")
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
        const slashCommand = parseSlashCommand(body.message, {});
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
        } catch (error) {
          // The streaming route reports this to the client as library_error.
          // This route has no event channel, so at least record it: the answer
          // is produced without the database grounding the user asked for.
          console.warn(
            "[pi] library context unavailable for this turn:",
            error,
          );
        }
        const piSettings = loadPiSettings();
        const convId = requirePiConversationId(body.saveConv);
        const convProc = getOrCreatePiConvProcess(convId, piSettings);
        await convProc.initialStatePromise;
        session = sendPiPrompt(convProc, promptMessage, source);
        res.on("close", () => {
          if (session && !res.writableEnded) {
            abortPiSession(session, "client_disconnected_start");
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

    if (req.method === "POST" && urlPath === "/api/pi/respond") {
      let sessionId = null;
      try {
        const body = await parseJsonBody(req);
        const {
          sessionId: requestSessionId,
          uiResponse,
          streaming,
        } = body || {};
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
        res.on("close", () => {
          if (sessionId && !res.writableEnded) {
            abortPiSession(session, "client_disconnected_respond");
          }
        });

        applyPiUiResponse(session, uiResponse);
        appendSecurityEvent("pi_permission_response", {
          sessionId,
          responseType:
            typeof uiResponse.confirmed === "boolean"
              ? "confirm"
              : typeof uiResponse.value === "string"
                ? "value"
                : "unknown",
          approved:
            typeof uiResponse.confirmed === "boolean"
              ? uiResponse.confirmed
              : uiResponse.cancelled === true
                ? "cancelled"
                : "provided",
          valueLength:
            typeof uiResponse.value === "string" ? uiResponse.value.length : 0,
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

    send(404, { error: "Unknown Pi endpoint" });
  }

  async function handleRequest(ctx) {
    if (ctx.urlPath !== "/api/pi" && !ctx.urlPath.startsWith("/api/pi/")) {
      return false;
    }
    await dispatch(ctx);
    return true;
  }

  return {
    handleRequest,
    api: {
      getOrCreatePiConvProcess,
      sendPiPrompt,
      addPiSessionListener,
      cleanupPiSession,
      emitPiEnvironmentBanner,
      applyPiUiResponse,
      waitForPiSessionStep,
      getSessionFile(convId) {
        return piConvProcesses.has(convId)
          ? piConvProcesses.get(convId).sessionFile
          : null;
      },
      shutdownAll() {
        if (piShuttingDown) return;
        piShuttingDown = true;
        clearInterval(attachmentSweepTimer);
        const shutdownError = new Error("Pi subsystem is shutting down.");

        for (const channel of piEventChannels.values()) {
          for (const subscriber of channel.subscribers) {
            try {
              subscriber.end();
            } catch (_error) {
              // Expected at shutdown: the socket may already be closed.
            }
          }
          channel.subscribers.clear();
        }
        piEventChannels.clear();

        for (const procObj of piConvProcesses.values()) {
          procObj.closed = true;
          cancelQueuedPiSessions(procObj, "process_shutdown");
          const activeId = procObj.activeRequestId;
          procObj.activeRequestId = null;
          if (activeId) {
            const active = piRpcSessions.get(activeId);
            if (active) {
              active.closed = true;
              active.error = shutdownError;
              notifyPiSession(active);
              cleanupPiSession(active.id, "process_shutdown");
            }
          }
          rejectPendingPiCommands(procObj, shutdownError);
          procObj.pendingStateResolver?.(null);
          procObj.pendingStatsResolver?.(null);
          procObj.pendingStateResolver = null;
          procObj.pendingStatsResolver = null;
          signalPiProcess(procObj.proc, "SIGTERM");
        }
        for (const session of [...piRpcSessions.values()]) {
          if (!piRpcSessions.has(session.id)) continue;
          session.closed = true;
          session.error = shutdownError;
          notifyPiSession(session);
          cleanupPiSession(session.id, "process_shutdown");
        }
        piConvProcesses.clear();
        removeOwnedPiAttachmentDirs();
      },
    },
  };
}

module.exports = createPiDomain;
module.exports.PiJsonlDecoder = PiJsonlDecoder;
