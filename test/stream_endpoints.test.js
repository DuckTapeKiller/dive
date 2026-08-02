// Contract tests for the three streaming chat endpoints that had none:
//   /api/chat/stream       Ollama      (upstream: NDJSON on /api/chat)
//   /api/llamacpp/stream   llama.cpp   (upstream: OpenAI SSE on /chat/completions)
//   /api/lmstudio/stream   LM Studio   (same)
//
// A real Dive server runs against its own DIVE_DATA_DIR, pointed at a fake
// upstream in this process. Nothing here touches the user's ~/dive, and no
// real model is required, so the assertions are deterministic.
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const APP_PORT = 8941;
const UPSTREAM_PORT = 8942;
const BASE = `http://127.0.0.1:${APP_PORT}`;

let app;
let upstream;
let dataDir;

// What the fake model should do on the next request. Set per test.
let script = { kind: "text", chunks: ["hello ", "world"] };
// Every upstream request body, so tests can assert what Dive actually sent.
let seen = [];

function ollamaChunk(obj) {
  return JSON.stringify(obj) + "\n";
}

function sseChunk(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function startUpstream() {
  return new Promise((resolve) => {
    upstream = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        let parsed = {};
        try {
          parsed = JSON.parse(body || "{}");
        } catch (_e) {
          // Recorded as {} below; assertions report the mismatch clearly.
        }
        seen.push({ url: req.url, body: parsed });

        // LM Studio mode loads the model before chatting (/api/v0/models then
        // /api/v1/models/load). Answer those immediately: only the chat call
        // should ever be made to hang, or the abort test would be exercising
        // the load phase instead of the stream.
        if (/\/models(\/load)?$/.test(req.url)) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              data: [{ id: "fake-model", state: "loaded" }],
              models: [{ name: "fake-model", state: "loaded" }],
              ok: true,
            }),
          );
          return;
        }

        // /v1/models and /api/tags probes: answer plausibly, never stream.
        if (req.method === "GET") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              data: [{ id: "fake-model" }],
              models: [{ name: "fake-model" }],
            }),
          );
          return;
        }

        const isOllama = req.url.startsWith("/api/chat");
        res.writeHead(200, {
          "Content-Type": isOllama
            ? "application/x-ndjson"
            : "text/event-stream",
        });

        if (script.kind === "malformed") {
          // Not JSON at all — Dive must not crash or hang on this.
          res.write("this is not json\n{ also not json\n");
          res.end();
          return;
        }

        if (script.kind === "hang") {
          // Write one chunk, then never finish: the abort test closes the
          // client connection while this is still open.
          res.write(
            isOllama
              ? ollamaChunk({ message: { content: "start" }, done: false })
              : sseChunk({ choices: [{ delta: { content: "start" } }] }),
          );
          return;
        }

        // A tool call on the first request, then a plain answer on the second,
        // so the round trip is observable.
        const isFollowUp = seen.filter((s) => s.url === req.url).length > 1;
        const chunks =
          script.kind === "tool" && !isFollowUp
            ? [script.toolText]
            : script.chunks;

        for (const c of chunks) {
          res.write(
            isOllama
              ? ollamaChunk({ message: { content: c }, done: false })
              : sseChunk({ choices: [{ delta: { content: c } }] }),
          );
          await new Promise((r) => setTimeout(r, 5));
        }
        if (isOllama) {
          res.write(ollamaChunk({ message: { content: "" }, done: true }));
        } else {
          res.write(
            sseChunk({ choices: [{ delta: {}, finish_reason: "stop" }] }),
          );
          res.write("data: [DONE]\n\n");
        }
        res.end();
      });
    });
    upstream.listen(UPSTREAM_PORT, "127.0.0.1", resolve);
  });
}

async function waitForApp(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/conversations`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("Dive server did not start");
}

const post = (url, body) =>
  fetch(`${BASE}${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

// Read an NDJSON stream to completion and return the parsed events.
async function readEvents(response) {
  const text = await response.text();
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch (_e) {
        // A partial trailing line is reported by the assertions, not hidden.
        return { type: "__unparsed__", raw: l };
      }
    });
}

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dive-stream-test-"));
  await startUpstream();
  app = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: { ...process.env, DIVE_DATA_DIR: dataDir, PORT: String(APP_PORT) },
    stdio: "ignore",
  });
  await waitForApp();

  // Point every mode at the fake upstream.
  await post("/api/ollama/settings", {
    baseUrl: `http://127.0.0.1:${UPSTREAM_PORT}`,
  });
  await post("/api/local-models/settings", {
    settings: {
      llamacpp: {
        baseUrl: `http://127.0.0.1:${UPSTREAM_PORT}`,
        model: "fake-model",
      },
      lmstudio: {
        baseUrl: `http://127.0.0.1:${UPSTREAM_PORT}`,
        model: "fake-model",
      },
    },
  });
});

test.after(() => {
  if (app) app.kill("SIGKILL");
  if (upstream) upstream.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

const ENDPOINTS = [
  ["/api/chat/stream", "ollama"],
  ["/api/llamacpp/stream", "llamacpp"],
  ["/api/lmstudio/stream", "lmstudio"],
];

for (const [endpoint, mode] of ENDPOINTS) {
  test(`${endpoint} streams the model's answer to the client`, async () => {
    script = { kind: "text", chunks: ["Hel", "lo ", "there"] };
    seen = [];
    const res = await post(endpoint, {
      message: "hi",
      history: [],
      model: "fake-model",
      saveConv: `stream-${mode}`,
      convTitle: "Stream",
    });
    assert.strictEqual(res.status, 200);
    const events = await readEvents(res);

    assert.ok(
      !events.some((e) => e.type === "__unparsed__"),
      `${endpoint} emitted a line that is not valid NDJSON`,
    );
    const deltas = events.filter((e) => e.type === "delta");
    assert.ok(deltas.length > 0, `${endpoint} produced no delta events`);
    const answer = deltas.at(-1).response;
    assert.strictEqual(
      answer,
      "Hello there",
      `${endpoint} assembled "${answer}" from the model's chunks`,
    );
    assert.ok(seen.length > 0, "the upstream model was never called");
  });

  test(`${endpoint} survives malformed model output`, async () => {
    // A local model that emits garbage must produce a clean end, not a hang,
    // a crash, or a corrupt NDJSON line on the wire.
    script = { kind: "malformed" };
    seen = [];
    const res = await post(endpoint, {
      message: "hi",
      history: [],
      model: "fake-model",
      saveConv: `malformed-${mode}`,
      convTitle: "Malformed",
    });
    assert.strictEqual(res.status, 200);
    const events = await readEvents(res);
    assert.ok(
      !events.some((e) => e.type === "__unparsed__"),
      `${endpoint} forwarded malformed upstream output verbatim to the client`,
    );
    // Whatever it decides, it must terminate.
    assert.ok(events.length >= 0);
  });

  test(`${endpoint} stops when the client aborts mid-stream`, async () => {
    script = { kind: "hang" };
    seen = [];
    const controller = new AbortController();
    // fetch() resolves as soon as the headers arrive, so the abort has to be
    // asserted against the body read, not against this promise.
    const res = await fetch(`${BASE}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "hi",
        history: [],
        model: "fake-model",
        saveConv: `abort-${mode}`,
        convTitle: "Abort",
      }),
      signal: controller.signal,
    });
    assert.strictEqual(res.status, 200);

    const reader = res.body.getReader();
    await reader.read(); // the upstream's first chunk
    const pendingRead = reader.read(); // never completes: the fake never ends
    await new Promise((r) => setTimeout(r, 200));
    controller.abort();
    await assert.rejects(pendingRead, /abort/i);

    // The server must still be answering. An abort that wedged the process or
    // leaked the upstream socket shows up here.
    const health = await fetch(`${BASE}/api/conversations`);
    assert.strictEqual(
      health.status,
      200,
      `${endpoint}: the server stopped responding after an aborted stream`,
    );
  });
}

test("/api/chat/stream runs a tool call and feeds the result back", async () => {
  // The XML fallback path: the model emits <call:calculator>, Dive executes it
  // server-side and sends the result back for a second turn.
  script = {
    kind: "tool",
    toolText: '<call:calculator>{"expression": "6*7"}</call>',
    chunks: ["The answer is 42."],
  };
  seen = [];
  const res = await post("/api/chat/stream", {
    message: "what is 6*7",
    history: [],
    model: "fake-model",
    saveConv: "toolcall-ollama",
    convTitle: "Tool",
    nativeTools: false,
  });
  assert.strictEqual(res.status, 200);
  const events = await readEvents(res);

  const toolEvents = events.filter(
    (e) => e.type === "tool_start" || e.type === "skill_start",
  );
  assert.ok(
    toolEvents.length > 0,
    `no tool event was emitted; saw: ${[...new Set(events.map((e) => e.type))].join(", ")}`,
  );
  assert.strictEqual(
    seen.length,
    2,
    `expected a second upstream call carrying the tool result, saw ${seen.length}`,
  );
  const followUp = JSON.stringify(seen[1].body);
  assert.match(
    followUp,
    /42/,
    "the calculator result was not fed back to the model",
  );
});
