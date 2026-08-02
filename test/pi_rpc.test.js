const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { promisify } = require("util");
const test = require("node:test");

const createPiDomain = require("../routes/pi.js");
const { PiJsonlDecoder } = createPiDomain;

const mkdtemp = promisify(fs.mkdtemp);
const chmod = promisify(fs.chmod);
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

function readResponseBody(response) {
  return response.text().then((text) => {
    let value;
    try {
      value = JSON.parse(text);
    } catch (_error) {
      value = text;
    }
    return { response, value };
  });
}

function parseNdjson(text) {
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function post(baseUrl, route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return readResponseBody(response);
}

async function makeFakePi(tempDir) {
  const commandPath = path.join(tempDir, "fake-pi.js");
  const logPath = path.join(tempDir, "fake-pi-prompts.jsonl");
  const source = String.raw`#!/usr/bin/env node
const fs = require("fs");
const readline = require("readline");
const logPath = ${JSON.stringify(logPath)};
let promptNumber = 0;
let currentSession = 0;

function emit(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}
function log(value) {
  if (!logPath) return;
  fs.appendFileSync(logPath, JSON.stringify(value) + "\n");
}
function state(id) {
  emit({
    type: "response",
    ...(id ? { id } : {}),
    command: "get_state",
    data: {
      sessionFile: "/tmp/fake-pi-session.jsonl",
      model: {
        id: "fake/vision",
        provider: "fake",
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      sessionId: String(currentSession),
      isStreaming: false,
    },
  });
}
function finishPrompt(command, number) {
  const retry = String(command.message || "").includes("retry");
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello " } });
  emit({
    type: "tool_execution_start",
    toolCallId: "call-" + number,
    toolName: "web_search",
    args: { number },
  });
  emit({
    type: "tool_execution_update",
    toolCallId: "call-" + number,
    toolName: "web_search",
    partialResult: {
      content: [{ type: "text", text: "partial output" }],
      details: { phase: "partial" },
    },
  });
  emit({
    type: "tool_execution_end",
    toolCallId: "call-" + number,
    toolName: "web_search",
    result: {
      content: [
        {
          type: "text",
          text: "**Sources:**\n1. Fake source\nhttps://example.test/source",
        },
      ],
      details: { fullOutputPath: "/tmp/fake-output.txt", truncated: false },
    },
    isError: false,
  });
  if (retry) {
    emit({ type: "agent_end", willRetry: true, message: { role: "assistant", content: [{ type: "text", text: "retrying" }] } });
    emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 0 });
    emit({ type: "auto_retry_end", attempt: 1 });
  }
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "world" } });
  emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hello world" }] } });
  emit({ type: "agent_end", willRetry: false });
  emit({ type: "agent_settled" });
}
function handle(command) {
  try { fs.appendFileSync(logPath + ".commands", JSON.stringify({ type: command.type }) + "\n"); } catch (e) {}
  if (command.type === "get_state") {
    state(command.id);
    return;
  }
  if (command.type === "get_session_stats") {
    if (fs.existsSync(logPath + ".hang")) return;
    emit({ type: "response", id: command.id, command: command.type, success: true, data: { cost: 0, contextUsage: { tokens: 12, contextWindow: 100 } } });
    return;
  }
  if (command.type === "get_commands") {
    emit({ type: "response", id: command.id, command: command.type, success: true, data: [{ name: "fake_command", description: "fake" }] });
    return;
  }
  if (command.type === "get_messages") {
    // Used by the integration test to verify pending RPC rejection on exit.
    return;
  }
  if (command.type === "prompt") {
    promptNumber += 1;
    log({ promptNumber, message: command.message, images: command.images || [] });
    emit({ type: "agent_start" });
    // A "slow" prompt stays active long enough for the next one to queue
    // behind it deterministically.
    setTimeout(() => finishPrompt(command, promptNumber), /slow/.test(String(command.message || "")) ? 2500 : 20);
    return;
  }
  if (command.type === "abort") {
    emit({ type: "response", id: command.id, command: command.type, success: true, data: { aborted: true } });
    emit({ type: "agent_end", willRetry: false });
    emit({ type: "agent_settled" });
    return;
  }
  if (command.type === "new_session") {
    currentSession += 1;
    emit({ type: "response", id: command.id, command: command.type, success: true, data: { sessionId: String(currentSession) } });
    state();
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
  await chmod(commandPath, 0o700);
  return { commandPath, logPath };
}

function makeDeps({ tempDir, commandPath, logPath }) {
  const conversations = [];
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
    upsertConversation: (...args) => conversations.push(args),
    persistAsyncWakeTurn: () => {},
    normalizeStoredConversationMessages: (history, message, images) => [
      ...(Array.isArray(history) ? history : []),
      { role: "user", content: message, images: images || [] },
    ],
    resolveAttachmentImages: (images) =>
      Array.isArray(images)
        ? images.filter((image) => image && image.dataBase64)
        : [],
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
    conversations,
    logPath,
  };
}

test("Pi JSONL decoder handles split UTF-8, multiple records, and rejects malformed input", () => {
  const records = [];
  const decoder = new PiJsonlDecoder((record) => records.push(record));
  decoder.push(Buffer.from('{"text":"caf'));
  decoder.push(Buffer.from("é"));
  decoder.push(Buffer.from('"}\n{"next":true}'));
  decoder.push(Buffer.from("\n"));
  assert.deepStrictEqual(records, [{ text: "café" }, { next: true }]);
  assert.throws(
    () => decoder.push(Buffer.from("not-json\n")),
    /Invalid Pi JSONL record/,
  );
});

test("fake Pi RPC preserves lifecycle, unique turn IDs, native images, and structured tool results", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dive-pi-rpc-"));
  const fake = await makeFakePi(tempDir);
  const deps = makeDeps({ tempDir, ...fake });
  const domain = createPiDomain(deps);
  const server = createHttpServer(domain);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    domain.api.shutdownAll();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const image = {
    mimeType: "image/png",
    dataBase64: Buffer.from("fake-image").toString("base64"),
  };
  const first = post(baseUrl, "/api/pi/stream", {
    saveConv: "integration",
    convTitle: "Integration",
    message: "retry once",
    images: [image],
    history: [],
    mode: "pi",
  });
  const second = post(baseUrl, "/api/pi/stream", {
    saveConv: "integration",
    convTitle: "Integration",
    message: "second turn",
    images: [],
    history: [],
    mode: "pi",
  });
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.strictEqual(firstResult.response.status, 200);
  assert.strictEqual(secondResult.response.status, 200);
  const firstEvents = parseNdjson(firstResult.value);
  const secondEvents = parseNdjson(secondResult.value);
  const firstStart = firstEvents.find(
    (event) => event.type === "session_start",
  );
  const secondStart = secondEvents.find(
    (event) => event.type === "session_start",
  );
  assert.ok(firstStart?.sessionId);
  assert.ok(secondStart?.sessionId);
  assert.notStrictEqual(firstStart.sessionId, secondStart.sessionId);
  assert.strictEqual(firstEvents.at(-1).type, "done");
  assert.strictEqual(secondEvents.at(-1).type, "done");

  const firstDoneIndex = firstEvents.findIndex(
    (event) => event.type === "done",
  );
  const retryEndIndex = firstEvents.findIndex(
    (event) => event.type === "provider_retry_end",
  );
  assert.ok(retryEndIndex > -1);
  assert.ok(firstDoneIndex > retryEndIndex);

  const toolEnd = firstEvents.find((event) => event.type === "tool_end");
  assert.strictEqual(toolEnd.toolCallId, "call-1");
  const webSources = firstEvents.find((event) => event.type === "web_sources");
  assert.deepStrictEqual(webSources.sources, [
    { title: "Fake source", url: "https://example.test/source" },
  ]);
  assert.deepStrictEqual(toolEnd.result.details, {
    fullOutputPath: "/tmp/fake-output.txt",
    truncated: false,
  });
  const loggedPrompts = fs
    .readFileSync(fake.logPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.strictEqual(loggedPrompts.length, 2);
  assert.strictEqual(loggedPrompts[0].images[0].type, "image");
  assert.strictEqual(loggedPrompts[0].images[0].mimeType, "image/png");
  assert.strictEqual(loggedPrompts[0].images[0].data, image.dataBase64);

  const command = await post(baseUrl, "/api/pi/command", {
    convId: "integration",
    command: { type: "get_state" },
  });
  assert.strictEqual(command.response.status, 200);
  assert.strictEqual(command.value.result.command, "get_state");

  const detachedPrompt = await post(baseUrl, "/api/pi/command", {
    convId: "integration",
    command: { type: "prompt", message: "channel turn" },
  });
  assert.strictEqual(detachedPrompt.response.status, 400);
  const sseAbort = new AbortController();
  const sseResponse = await fetch(
    `${baseUrl}/api/pi/events?conv=integration&after=0`,
    { signal: sseAbort.signal },
  );
  assert.strictEqual(sseResponse.status, 200);
  const sseReader = sseResponse.body.getReader();
  let sseText = "";
  for (let i = 0; i < 10 && !/id: \d+/.test(sseText); i += 1) {
    const chunk = await sseReader.read();
    if (chunk.done) break;
    sseText += Buffer.from(chunk.value).toString("utf8");
  }
  assert.match(sseText, /id: \d+/);
  assert.match(sseText, /"convId":"integration"/);
  sseAbort.abort();
  await sseReader.cancel().catch(() => {});

  fs.writeFileSync(fake.logPath + ".hang", "1");
  const pendingCommand = post(baseUrl, "/api/pi/command", {
    convId: "integration",
    command: { type: "get_session_stats" },
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  domain.api.shutdownAll();
  const rejected = await pendingCommand;
  assert.strictEqual(rejected.response.status, 500);
  assert.match(
    rejected.value.error,
    /shutdown|shutting down|closed|writable|exited/i,
  );
});

test("a queued Pi turn is cancelled, not run, when the session is reset", async (t) => {
  // advancePiQueue must drop a cancelled entry instead of dispatching it. The
  // fake Pi logs every prompt it receives, so "was it dispatched?" is a fact on
  // disk rather than an inference from the stream.
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dive-pi-queue-"));
  const fake = await makeFakePi(tempDir);
  const deps = makeDeps({ tempDir, ...fake });
  const domain = createPiDomain(deps);
  const server = createHttpServer(domain);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    domain.api.shutdownAll();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // The log file only appears once Pi has received a prompt.
  const promptsLogged = () => {
    if (!fs.existsSync(fake.logPath)) return [];
    return fs
      .readFileSync(fake.logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line).message);
  };

  const body = (message) => ({
    saveConv: "queue-test",
    convTitle: "Queue",
    message,
    history: [],
    mode: "pi",
  });

  const running = post(baseUrl, "/api/pi/stream", body("slow first turn"));
  // /api/pi/stream builds the library context before it queues, so wait on the
  // observable fact that the first prompt reached Pi rather than a fixed delay.
  const deadline = Date.now() + 5000;
  while (promptsLogged().length < 1 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.strictEqual(promptsLogged().length, 1, "first turn never started");

  const queued = post(baseUrl, "/api/pi/stream", body("second turn"));
  await new Promise((r) => setTimeout(r, 600));
  assert.strictEqual(
    promptsLogged().length,
    1,
    "the second turn should be queued behind the slow one, not dispatched",
  );

  const reset = await post(baseUrl, "/api/pi/new-session", {
    saveConv: "queue-test",
  });
  assert.strictEqual(reset.response.status, 200);

  const queuedEvents = parseNdjson((await queued).value);
  await running;

  assert.deepStrictEqual(
    promptsLogged(),
    ["slow first turn"],
    "a cancelled queue entry must never reach Pi",
  );
  const last = queuedEvents.at(-1);
  assert.ok(
    last && (last.type === "error" || last.type === "done"),
    `the cancelled turn's stream should terminate, got ${JSON.stringify(last)}`,
  );
});

test("Stop aborts the agent, an in-flight retry, and a running bash command", async (t) => {
  // Pi's terminal Esc ends all three; over RPC they are three separate
  // commands. Sending only {type:"abort"} leaves a retry counting down and a
  // bash child still running, so the turn looks alive after Stop.
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dive-pi-stop-"));
  const fake = await makeFakePi(tempDir);
  const deps = makeDeps({ tempDir, ...fake });
  const domain = createPiDomain(deps);
  const server = createHttpServer(domain);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    domain.api.shutdownAll();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const commandsSeen = () => {
    const file = fake.logPath + ".commands";
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line).type);
  };

  const running = post(baseUrl, "/api/pi/stream", {
    saveConv: "stop-test",
    convTitle: "Stop",
    message: "slow turn to interrupt",
    history: [],
    mode: "pi",
  });
  const deadline = Date.now() + 5000;
  while (!commandsSeen().includes("prompt") && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(commandsSeen().includes("prompt"), "the turn never started");

  const stop = await post(baseUrl, "/api/pi/command", {
    saveConv: "stop-test",
    command: { type: "abort" },
  });
  assert.strictEqual(stop.response.status, 200);
  await running;

  const seen = commandsSeen();
  for (const expected of ["abort", "abort_retry", "abort_bash"]) {
    assert.ok(
      seen.includes(expected),
      `Stop must send ${expected}; Pi only saw: ${seen.join(", ")}`,
    );
  }
  // The sub-activities are stopped before the agent settles.
  assert.ok(
    seen.indexOf("abort_bash") < seen.indexOf("abort"),
    "abort_bash should precede abort so the agent cannot settle first",
  );
});
