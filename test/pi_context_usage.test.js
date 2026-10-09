// Pi's context usage, as the status and the /stats command report it.
//
// The token counter and the side panel's CONTEXT figure both show what Pi
// reports. After a compaction Pi cannot measure the context until the next
// reply and says so with tokens: null. That must reach the browser as
// unknown: reporting 0 showed an empty context, and dropping the usage left
// the pre-compaction figure on screen.
//
// Driven through the real domain with a fake `pi` whose usage is read from a
// file on every request, so one process can report before and after.

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const test = require("node:test");

const createPiDomain = require("../routes/pi.js");

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

// A fake Pi whose get_session_stats answers with the contextUsage in
// usage.json beside it, re-read on every request.
function makeFakePi(tempDir) {
  const commandPath = path.join(tempDir, "fake-pi-usage");
  const usagePath = path.join(tempDir, "usage.json");
  const source = String.raw`#!/usr/bin/env node
const fs = require("fs");
const readline = require("readline");
const usagePath = ${JSON.stringify(usagePath)};
function emit(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}
function handle(command) {
  const id = command.id ? { id: command.id } : {};
  if (command.type === "get_state") {
    emit({
      type: "response",
      ...id,
      command: "get_state",
      data: {
        sessionFile: "/tmp/fake-pi-session.jsonl",
        model: { id: "fake/x", provider: "fake", input: ["text"], cost: {} },
        sessionId: "0",
        isStreaming: false,
      },
    });
    return;
  }
  if (command.type === "get_session_stats") {
    const contextUsage = JSON.parse(fs.readFileSync(usagePath, "utf8"));
    emit({
      type: "response",
      ...id,
      command: "get_session_stats",
      success: true,
      data: { contextUsage, cost: 0, userMessages: 1, assistantMessages: 1 },
    });
    return;
  }
  emit({ type: "response", ...id, command: command.type, success: true, data: {} });
}
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => handle(JSON.parse(line)));
`;
  fs.writeFileSync(commandPath, source, { mode: 0o700 });
  return { commandPath, usagePath };
}

function makeDeps({ tempDir, commandPath }) {
  const settings = {
    commandPath,
    workingDirectory: tempDir,
    timeoutMs: 300,
    permissionPolicy: "confirm",
    toolOutputMaxChars: 4000,
  };
  return {
    DATA_DIR: tempDir,
    PORT: 0,
    PI_DEFAULT_SERVER_PORT: 0,
    PI_SESSION_TIMEOUT_MS: 300,
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
    normalizeStoredConversationMessages: (history) =>
      Array.isArray(history) ? history : [],
    resolveAttachmentImages: () => [],
    extForImageMime: () => ".png",
    piAttachmentStageDir: () => tempDir,
    sweepPiAttachments: () => {},
    emitSlashCommand: () => {},
    getCommandMessage: (_command, message) => message,
    getLibraryRequestForCommand: () => ({ enabled: false, mode: "pi" }),
    serializeLibraryResults: (results) => results,
    getLibraryContextSourceResults: (context) => context.results || [],
    buildPiPromptWithLibraryContext: (message) => message,
    appendSecurityEvent: () => {},
    sanitizeTraceEventForStorage: (event) => event,
    openPathInFileManager: () => {},
    defaultPiSettings: settings,
  };
}

async function startDomain(t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dive-pi-usage-"));
  const { commandPath, usagePath } = makeFakePi(tempDir);
  const domain = createPiDomain(makeDeps({ tempDir, commandPath }));
  const server = createHttpServer(domain);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    domain.api.shutdownAll();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  const post = async (urlPath, body) => {
    const res = await fetch(baseUrl + urlPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const setUsage = (usage) =>
    fs.writeFileSync(usagePath, JSON.stringify(usage));
  return { post, setUsage };
}

const BEFORE = { tokens: 19891, contextWindow: 272000, percent: 7.3128676 };
const AFTER_COMPACTION = { tokens: null, contextWindow: 272000, percent: null };

test("the status reports Pi's usage, and unknown after a compaction", async (t) => {
  const { post, setUsage } = await startDomain(t);
  const convId = "usage-status";
  setUsage(BEFORE);
  // Any command starts the conversation's Pi process.
  const started = await post("/api/pi/command", {
    saveConv: convId,
    command: { type: "get_state" },
  });
  assert.strictEqual(started.status, 200);

  const before = await post("/api/pi/status", { saveConv: convId });
  assert.strictEqual(before.status, 200);
  assert.deepStrictEqual(before.body.status.contextUsage, {
    used: 19891,
    total: 272000,
    percent: 7.3128676,
  });

  setUsage(AFTER_COMPACTION);
  const after = await post("/api/pi/status", { saveConv: convId });
  assert.strictEqual(after.status, 200);
  assert.deepStrictEqual(
    after.body.status.contextUsage,
    { used: null, total: 272000, percent: null },
    "unknown usage must stay unknown, not become 0 or vanish",
  );
});

test("a percentage Pi leaves out is worked out unrounded", async (t) => {
  const { post, setUsage } = await startDomain(t);
  const convId = "usage-no-percent";
  setUsage({ tokens: 1000, contextWindow: 3000 });
  await post("/api/pi/command", {
    saveConv: convId,
    command: { type: "get_state" },
  });
  const status = await post("/api/pi/status", { saveConv: convId });
  assert.strictEqual(status.body.status.contextUsage.used, 1000);
  assert.strictEqual(status.body.status.contextUsage.total, 3000);
  assert.ok(
    Math.abs(status.body.status.contextUsage.percent - 100 / 3) < 1e-9,
    `percent was ${status.body.status.contextUsage.percent}`,
  );
});

test("the /stats command keeps unknown usage unknown", async (t) => {
  const { post, setUsage } = await startDomain(t);
  const convId = "usage-stats";
  setUsage(AFTER_COMPACTION);
  const stats = await post("/api/pi/command", {
    saveConv: convId,
    command: { type: "get_session_stats" },
  });
  assert.strictEqual(stats.status, 200);
  assert.deepStrictEqual(stats.body.result.data.contextUsage, {
    tokens: null,
    contextWindow: 272000,
    percent: null,
  });

  setUsage(BEFORE);
  const known = await post("/api/pi/command", {
    saveConv: convId,
    command: { type: "get_session_stats" },
  });
  assert.deepStrictEqual(known.body.result.data.contextUsage, BEFORE);
});
