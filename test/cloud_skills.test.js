// Cloud mode's skill loop, end to end.
//
// A mock OpenAI-compatible provider stands in for the real API: the "model"
// emits <call:calculator>, Dive executes it server-side, feeds the result back,
// and streams the final answer. No network, no credentials, no real model — so
// this is a deterministic integration test rather than a true e2e one, and it
// belongs in the normal suite.
//
// It used to point Dive at the real ~/dive and put the user's cloud settings
// back afterwards. That restore only ran in the cleanup path, so any crash or
// kill left the real configuration overwritten with a fake key and a base URL
// aimed at 127.0.0.1. It now runs entirely inside a temporary DIVE_DATA_DIR,
// and the first test below checks the real file was not touched.
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { spawn } = require("child_process");

const APP_DIR = path.join(__dirname, "..");
const REAL_DATA_DIR = path.join(os.homedir(), "dive");
const REAL_SETTINGS_FILE = path.join(REAL_DATA_DIR, "cloud-settings.json");
const MOCK_PORT = 9433;
const APP_PORT = 8099;
const BASE = `http://127.0.0.1:${APP_PORT}`;

let serverProc = null;
let mockServer = null;
let dataDir = null;

// What the run produced, captured once in before() and asserted piecewise.
const providerRequests = [];
let events = [];
let settingsOk = false;
let chatOk = false;

// Fingerprint of the user's real cloud settings, taken before anything starts.
function fingerprintRealSettings() {
  if (!fs.existsSync(REAL_SETTINGS_FILE)) return { exists: false, hash: null };
  return {
    exists: true,
    hash: crypto
      .createHash("sha256")
      .update(fs.readFileSync(REAL_SETTINGS_FILE))
      .digest("hex"),
  };
}
const realSettingsBefore = fingerprintRealSettings();

function sseChunk(text) {
  return (
    "data: " +
    JSON.stringify({ choices: [{ delta: { content: text } }] }) +
    "\n\n"
  );
}

function startMockProvider() {
  return new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let parsed = {};
        try {
          parsed = JSON.parse(body);
        } catch (_e) {
          // The assertions report an unparseable body far more clearly.
        }
        providerRequests.push(parsed);
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const flat = JSON.stringify(parsed.messages || []);
        // Second round trip: the skill result is in the conversation, so answer.
        if (flat.includes("[SKILL RESULT: calculator]")) {
          res.write(sseChunk("The result of 2 + 2 * 4 is 10."));
        } else {
          res.write(sseChunk("Let me calculate that. "));
          res.write(
            sseChunk('<call:calculator>{"expression": "2 + 2 * 4"}</call>'),
          );
        }
        res.write(
          "data: " +
            JSON.stringify({
              choices: [{ delta: {} }],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 5,
                total_tokens: 15,
              },
            }) +
            "\n\n",
        );
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    mockServer.listen(MOCK_PORT, "127.0.0.1", resolve);
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

const postJson = (p, payload) =>
  fetch(`${BASE}${p}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dive-cloud-test-"));
  // Fail closed. If this ever resolves to the real directory, stop before the
  // server writes anything rather than discovering it afterwards.
  assert.notStrictEqual(
    path.resolve(dataDir),
    path.resolve(REAL_DATA_DIR),
    "refusing to run against the real data directory",
  );

  await startMockProvider();
  serverProc = spawn(process.execPath, ["server.js"], {
    cwd: APP_DIR,
    env: { ...process.env, DIVE_DATA_DIR: dataDir, PORT: String(APP_PORT) },
    stdio: "ignore",
  });
  await waitForApp();

  settingsOk = (
    await postJson("/api/cloud/settings", {
      provider: "openai",
      apiKeys: { openai: "test-key-not-a-real-secret" },
      baseUrls: { openai: `http://127.0.0.1:${MOCK_PORT}/v1` },
      models: { openai: "mock-model" },
    })
  ).ok;

  const chatRes = await postJson("/api/cloud/chat/stream", {
    message: "What is 2 + 2 * 4?",
    history: [],
    library: { enabled: false },
  });
  chatOk = chatRes.ok;

  const text = await chatRes.text();
  events = text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch (_e) {
        // A partial trailing NDJSON line is reported by the assertions.
        return { type: "__unparsed__", raw: l };
      }
    });
});

test.after(() => {
  if (serverProc) serverProc.kill("SIGKILL");
  if (mockServer) mockServer.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test("the run does not touch the user's real cloud settings", async () => {
  // The reason this file was rewritten. Everything above has already run, so
  // any write to the real path has happened by now.
  const after = fingerprintRealSettings();
  assert.strictEqual(
    after.exists,
    realSettingsBefore.exists,
    after.exists
      ? `the test created ${REAL_SETTINGS_FILE}, which did not exist before`
      : `the test deleted ${REAL_SETTINGS_FILE}`,
  );
  assert.strictEqual(
    after.hash,
    realSettingsBefore.hash,
    `the test modified the user's real cloud settings at ${REAL_SETTINGS_FILE}`,
  );
  // And it wrote its own settings somewhere inside the temporary directory.
  assert.ok(
    fs.existsSync(path.join(dataDir, "cloud-settings.json")),
    "cloud settings were not written to the isolated data directory",
  );
});

test("cloud settings are accepted and the chat stream opens", () => {
  assert.ok(settingsOk, "cloud settings were rejected");
  assert.ok(chatOk, "the cloud chat stream was refused");
  assert.ok(
    !events.some((e) => e.type === "__unparsed__"),
    "the stream emitted a line that is not valid NDJSON",
  );
});

test("the skills system prompt reaches the provider", () => {
  const first = providerRequests[0] || {};
  const system = (first.messages || [])
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n");
  assert.match(system, /SKILLS & TOOL USAGE \(MANDATORY\)/);
  assert.match(system, /<call:calculator>/);
  assert.match(system, /MUST call the relevant skill BEFORE answering/);
});

test("a model-initiated skill call is executed server-side", () => {
  const toolStart = events.find(
    (e) => e.type === "tool_start" && e.toolName === "calculator",
  );
  const toolEnd = events.find(
    (e) => e.type === "tool_end" && e.toolName === "calculator",
  );
  assert.ok(toolStart, "no tool_start for the calculator the model called");
  assert.ok(toolEnd, "the calculator never finished");
  assert.match(
    toolEnd.outputPreview || "",
    /Result:\s*10/,
    `the calculator produced ${JSON.stringify(toolEnd.outputPreview)}`,
  );
});

test("the skill result is fed back for a second round trip", () => {
  assert.strictEqual(
    providerRequests.length,
    2,
    `expected two provider calls, saw ${providerRequests.length}`,
  );
  const second = JSON.stringify(providerRequests[1] || {});
  assert.match(
    second,
    /\[SKILL RESULT: calculator\]/,
    "the second call did not carry the skill result",
  );
});

test("the final answer uses the skill result", () => {
  const done = events.find((e) => e.type === "done");
  assert.ok(done, "the stream never finished");
  assert.match(
    done.response || "",
    /is 10/,
    `the answer ignored the skill result: ${JSON.stringify(done.response)}`,
  );
});

test("skill-call markup never reaches the user", () => {
  const done = events.find((e) => e.type === "done");
  assert.doesNotMatch(
    done?.response || "",
    /<call:|<\/call>/,
    "skill-call XML survived into the final answer",
  );
  for (const e of events.filter((e) => e.type === "delta")) {
    assert.doesNotMatch(
      e.response || "",
      /<call:/,
      "skill-call XML leaked into a streamed delta",
    );
  }
});

test("the trace shows the tool that ran", () => {
  const thinking = events.filter((e) => e.type === "thinking_delta");
  assert.ok(
    thinking.some((e) => /Running tool: calculator/.test(e.delta || "")),
    "the execution trace never mentions the calculator",
  );
});
