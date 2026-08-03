// /api/pi and /api/pi/stream must agree about a failed library lookup.
//
// The streaming route emitted a library_error event. The non-streaming route
// caught the same failure, wrote it to the server console, and returned a
// perfectly ordinary-looking answer — one that was NOT grounded in the database
// and was indistinguishable from one that was.
//
// The two tiers differ. An explicit /db request that cannot reach the database
// has not been served, so it fails. Ambient library context is best-effort, so
// the turn continues and says what it lost.
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { promisify } = require("util");

// Stub the library before routes/pi.js is loaded, so its top-level require
// picks up the failing version. Production code stays injection-free.
const storePath = require.resolve("../library/store");
const realStore = require("../library/store");
let libraryFailure = null;
require.cache[storePath].exports = {
  ...realStore,
  buildChatLibraryContext: async (...args) => {
    if (libraryFailure) throw new Error(libraryFailure);
    return realStore.buildChatLibraryContext(...args);
  },
};

const createPiDomain = require("../routes/pi.js");

const mkdtemp = promisify(fs.mkdtemp);
const writeFile = promisify(fs.writeFile);

function createHttpServer(domain) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const send = (status, payload) => {
      if (res.headersSent || res.writableEnded) return;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    domain
      .handleRequest({ req, res, urlPath: url.pathname, send })
      .then((handled) => {
        if (!handled && !res.writableEnded) send(404, { error: "not found" });
      })
      .catch((error) => {
        if (!res.headersSent && !res.writableEnded) {
          send(error.statusCode || 500, { error: error.message });
        }
      });
  });
}

// A fake pi that answers immediately, so the ambient case can reach a real
// 200 response without the machine's own `pi` ever being spawned.
async function makeFakePi(tempDir) {
  const commandPath = path.join(tempDir, "fake-pi-library");
  const source = String.raw`#!/usr/bin/env node
const readline = require("readline");
let currentSession = 0;
function emit(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}
function handle(command) {
  if (command.type === "prompt") {
    emit({ type: "agent_start" });
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "answer" } });
    emit({ type: "agent_end", willRetry: false });
    emit({ type: "agent_settled" });
    return;
  }
  if (command.type === "get_state") {
    emit({
      type: "response",
      ...(command.id ? { id: command.id } : {}),
      command: "get_state",
      data: {
        sessionFile: "/tmp/fake-pi-session.jsonl",
        model: { id: "fake/x", provider: "fake", input: ["text"], cost: {} },
        sessionId: String(currentSession),
        isStreaming: false,
      },
    });
    return;
  }
  if (command.type === "new_session") {
    currentSession += 1;
    emit({ type: "response", id: command.id, command: command.type, success: true, data: { sessionId: String(currentSession) } });
    return;
  }
  emit({ type: "response", id: command.id, command: command.type, success: true, data: {} });
}
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  try {
    handle(JSON.parse(line));
  } catch (error) {
    emit({ type: "error", message: error.message });
  }
});
`;
  await writeFile(commandPath, source, { mode: 0o700 });
  fs.chmodSync(commandPath, 0o700);
  return commandPath;
}

function makeDeps({ tempDir, commandPath }) {
  const settings = {
    commandPath,
    workingDirectory: tempDir,
    timeoutMs: 5000,
    permissionPolicy: "confirm",
    toolOutputMaxChars: 4000,
  };
  return {
    DATA_DIR: tempDir,
    PORT: 0,
    PI_DEFAULT_SERVER_PORT: 0,
    PI_SESSION_TIMEOUT_MS: 30_000,
    PI_SESSION_SWEEP_INTERVAL_MS: 50,
    loadPiSettings: () => ({ ...settings }),
    savePiSettings: () => {},
    sanitizePiSettings: (value) => value,
    getPiCommand: () => commandPath,
    buildExecutablePath: (value) => value,
    getPiVersionSync: () => "fake-pi 1.0",
    parseJsonBody: async (req) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString("utf8");
      return text.trim() ? JSON.parse(text) : {};
    },
    createHttpError: (statusCode, message) =>
      Object.assign(new Error(message), { statusCode }),
    upsertConversation: () => {},
    persistAsyncWakeTurn: () => {},
    normalizeStoredConversationMessages: (history, message, images) => [
      ...(Array.isArray(history) ? history : []),
      { role: "user", content: message, images: images || [] },
    ],
    resolveAttachmentImages: () => [],
    describeDroppedAttachments: () => "",
    extForImageMime: () => ".png",
    piAttachmentStageDir: () => tempDir,
    sweepPiAttachments: () => {},
    emitSlashCommand: () => {},
    getCommandMessage: (_command, message) => message,
    getLibraryRequestForCommand: () => ({ enabled: true, mode: "pi" }),
    serializeLibraryResults: (results) => results || [],
    getLibraryContextSourceResults: (context) => context.results || [],
    buildPiPromptWithLibraryContext: (message) => message,
    appendSecurityEvent: () => {},
    sanitizeTraceEventForStorage: (event) => event,
    openPathInFileManager: () => {},
    defaultPiSettings: settings,
  };
}

let baseUrl;
let server;
let domain;
let tempDir;

test.before(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "dive-pi-library-"));
  const commandPath = await makeFakePi(tempDir);
  domain = createPiDomain(makeDeps({ tempDir, commandPath }));
  server = createHttpServer(domain);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  libraryFailure = null;
  if (domain) domain.api.shutdownAll();
  if (server) await new Promise((resolve) => server.close(resolve));
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  require.cache[storePath].exports = realStore;
});

const post = (route, body) =>
  fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("an explicit /db request fails when the library cannot be reached", async () => {
  // The user asked for the database by name. An ordinary answer here would be
  // ungrounded and indistinguishable from a grounded one.
  libraryFailure = "library index is corrupt";
  const res = await post("/api/pi", {
    message: "/db what does the handbook say",
    history: [],
    saveConv: "pi-library-required",
    convTitle: "Library",
    mode: "pi",
  });
  const body = await res.json();
  assert.strictEqual(
    res.status,
    502,
    `an explicit database request returned ${res.status} as though it had worked: ${JSON.stringify(body).slice(0, 160)}`,
  );
  assert.match(body.error, /not be grounded|library search failed/i);
  assert.match(body.libraryError, /library index is corrupt/);
});

test("ambient library failure is reported but does not lose the turn", async () => {
  // Best-effort context: the answer is still worth having, so the turn runs and
  // the response says what it lost.
  libraryFailure = "library index is corrupt";
  const res = await post("/api/pi", {
    message: "what does the handbook say",
    history: [],
    saveConv: "pi-library-optional",
    convTitle: "Library",
    mode: "pi",
  });
  const body = await res.json();
  assert.strictEqual(res.status, 200, JSON.stringify(body).slice(0, 200));
  assert.match(
    String(body.libraryError || ""),
    /library index is corrupt/,
    `the failure was swallowed: ${JSON.stringify(body).slice(0, 200)}`,
  );
});

test("a healthy turn reports no library error at all", async () => {
  // A field that is always present would be ignored within a week.
  libraryFailure = null;
  const res = await post("/api/pi", {
    message: "what does the handbook say",
    history: [],
    saveConv: "pi-library-ok",
    convTitle: "Library",
    mode: "pi",
  });
  const body = await res.json();
  assert.strictEqual(res.status, 200, JSON.stringify(body).slice(0, 200));
  assert.strictEqual(
    body.libraryError,
    undefined,
    `a healthy turn reported a library error: ${body.libraryError}`,
  );
});

test("the streaming route reports the same failure as an event", async () => {
  // The two routes must not disagree about whether retrieval failed.
  libraryFailure = "library index is corrupt";
  const res = await post("/api/pi/stream", {
    message: "what does the handbook say",
    history: [],
    saveConv: "pi-library-stream",
    convTitle: "Library",
    mode: "pi",
  });
  const text = await res.text();
  const events = text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_e) {
        return { type: "__partial__" };
      }
    });
  const failure = events.find((event) => event.type === "library_error");
  assert.ok(
    failure,
    `the streaming route swallowed the failure; saw: ${[
      ...new Set(events.map((e) => e.type)),
    ].join(", ")}`,
  );
  assert.match(String(failure.error || ""), /library index is corrupt/);
});
