// A Pi session removed before it finished must still send an error.
//
// The browser keeps the composer busy while a background run is open on the
// event channel, and only a done or an error closes it. If a background turn
// (an async wake) never settles and ignores the abort, the stale sweep removes
// the session. That removal must reach the channel, or the browser stays busy.
//
// Driven through the real domain with a fake `pi`. Takes about six seconds:
// the domain waits five seconds for an abort to land before closing.
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { TextDecoder } = require("util");

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

// A fake Pi that answers a prompt and settles, then wakes on its own with
// more text and never settles. Aborts are acknowledged and ignored.
function makeFakePi(tempDir) {
  const commandPath = path.join(tempDir, "fake-pi-hung-wake");
  const source = String.raw`#!/usr/bin/env node
const readline = require("readline");
function emit(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}
function text(delta) {
  return {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta },
  };
}
function handle(command) {
  if (command.type === "prompt") {
    emit({ type: "agent_start" });
    emit(text("answer"));
    emit({ type: "agent_end", willRetry: false });
    emit({ type: "agent_settled" });
    setTimeout(() => emit(text("woke")), 100);
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
        sessionId: "0",
        isStreaming: false,
      },
    });
    return;
  }
  emit({ type: "response", id: command.id, command: command.type, success: true, data: {} });
}
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => handle(JSON.parse(line)));
`;
  fs.writeFileSync(commandPath, source, { mode: 0o700 });
  return commandPath;
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
    normalizeStoredConversationMessages: (history, message, images) => [
      ...(Array.isArray(history) ? history : []),
      { role: "user", content: message, images: images || [] },
    ],
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

// Every event the channel has buffered for a conversation, read as a fresh
// subscriber would see it.
async function channelEvents(baseUrl, convId) {
  const controller = new AbortController();
  const res = await fetch(
    `${baseUrl}/api/pi/events?conv=${encodeURIComponent(convId)}&after=0`,
    { signal: controller.signal },
  );
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  const deadline = Date.now() + 200;
  try {
    while (Date.now() < deadline) {
      const timeout = new Promise((resolve) =>
        setTimeout(() => resolve({ timedOut: true }), deadline - Date.now()),
      );
      const chunk = await Promise.race([reader.read(), timeout]);
      if (chunk.timedOut || chunk.done) break;
      raw += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    controller.abort();
  }
  return raw
    .split("\n\n")
    .map((frame) => frame.split("\n").find((l) => l.startsWith("data: ")))
    .filter(Boolean)
    .map((line) => JSON.parse(line.slice(6)));
}

test("a background turn that never settles still ends with an error", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dive-pi-cleanup-"));
  const domain = createPiDomain(
    makeDeps({ tempDir, commandPath: makeFakePi(tempDir) }),
  );
  const server = createHttpServer(domain);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    domain.api.shutdownAll();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const convId = "hung-wake";
  const res = await fetch(`${baseUrl}/api/pi/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ saveConv: convId, message: "hi", history: [] }),
  });
  await res.text();

  let wakeId = null;
  let ended = null;
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline && !ended) {
    const events = await channelEvents(baseUrl, convId);
    const wake = events.find((e) => e.type === "delta" && e.delta === "woke");
    wakeId = wake?.sessionId || null;
    ended = events.find(
      (e) =>
        wakeId &&
        e.sessionId === wakeId &&
        (e.type === "error" || e.type === "done"),
    );
    if (!ended) await new Promise((resolve) => setTimeout(resolve, 300));
  }

  assert.ok(wakeId, "the background turn never reached the channel");
  assert.ok(ended, "the background turn was removed without an error");
  assert.strictEqual(ended.type, "error");
});
