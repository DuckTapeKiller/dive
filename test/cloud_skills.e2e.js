/*
 * E2E test: Cloud mode skill loop in Dive.
 * Starts a mock OpenAI-compatible SSE provider, points Dive's cloud settings
 * at it, sends a chat message, and asserts that:
 *   1. The skills system prompt is sent to the provider.
 *   2. A <call:calculator> emitted by the "model" is executed server-side.
 *   3. The skill result is fed back and the final answer streams to the client.
 * Restores the user's cloud-settings.json afterwards.
 */
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const APP_DIR = path.join(__dirname, "..");
const DATA_DIR = path.join(os.homedir(), "dive");
const SETTINGS_FILE = path.join(DATA_DIR, "cloud-settings.json");
const BACKUP_FILE = SETTINGS_FILE + ".e2e-backup";
const MOCK_PORT = 9433;
const APP_PORT = 8099;

let serverProc = null;
let mockServer = null;
let hadSettings = false;
const failures = [];
const seenProviderRequests = [];

function assert(cond, label) {
  if (cond) {
    console.log("PASS: " + label);
  } else {
    failures.push(label);
    console.log("FAIL: " + label);
  }
}

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
        } catch (_e) {}
        seenProviderRequests.push(parsed);
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const flat = JSON.stringify(parsed.messages || []);
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
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
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

function waitForApp(retries = 50) {
  return new Promise((resolve, reject) => {
    const tryOnce = (left) => {
      const req = http.get(
        { host: "127.0.0.1", port: APP_PORT, path: "/" },
        (res) => {
          res.resume();
          resolve();
        },
      );
      req.on("error", () => {
        if (left <= 0) return reject(new Error("App did not start"));
        setTimeout(() => tryOnce(left - 1), 200);
      });
    };
    tryOnce(retries);
  });
}

function postJson(p, payload) {
  return fetch(`http://127.0.0.1:${APP_PORT}${p}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function main() {
  if (fs.existsSync(SETTINGS_FILE)) {
    hadSettings = true;
    fs.copyFileSync(SETTINGS_FILE, BACKUP_FILE);
  }

  await startMockProvider();

  serverProc = spawn("node", ["server.js"], {
    cwd: APP_DIR,
    env: { ...process.env, PORT: String(APP_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverProc.stderr.on("data", (d) => process.stderr.write("[app] " + d));
  await waitForApp();

  const settingsRes = await postJson("/api/cloud/settings", {
    provider: "openai",
    apiKeys: { openai: "test-key-e2e" },
    baseUrls: { openai: `http://127.0.0.1:${MOCK_PORT}/v1` },
    models: { openai: "mock-model" },
  });
  assert(settingsRes.ok, "cloud settings saved");

  const chatRes = await postJson("/api/cloud/chat/stream", {
    message: "What is 2 + 2 * 4?",
    history: [],
    library: { enabled: false },
  });
  assert(chatRes.ok, "cloud chat stream accepted");

  const events = [];
  const text = await chatRes.text();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch (_e) {}
  }

  const toolStart = events.find(
    (e) => e.type === "tool_start" && e.toolName === "calculator",
  );
  const toolEnd = events.find(
    (e) => e.type === "tool_end" && e.toolName === "calculator",
  );
  const done = events.find((e) => e.type === "done");
  const thinkingDeltas = events.filter((e) => e.type === "thinking_delta");

  assert(Boolean(toolStart), "model-initiated calculator tool_start emitted");
  assert(
    Boolean(toolEnd) && /Result:\s*10/.test(toolEnd?.outputPreview || ""),
    "calculator executed server-side with result 10",
  );
  assert(
    Boolean(done) && /is 10/.test(done?.response || ""),
    "final answer uses the skill result",
  );
  assert(
    !/(<call:|<\/call>)/.test(done?.response || ""),
    "skill call XML removed from final response",
  );
  assert(
    thinkingDeltas.some((e) => /Running tool: calculator/.test(e.delta || "")),
    "thinking trace shows the tool run",
  );
  const deltas = events.filter((e) => e.type === "delta");
  assert(
    deltas.every((e) => !/(<call:)/.test(e.response || "")),
    "no skill-call XML leaked into streamed deltas",
  );

  const firstReq = seenProviderRequests[0] || {};
  const sysTexts = (firstReq.messages || [])
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n");
  assert(
    sysTexts.includes("SKILLS & TOOL USAGE (MANDATORY)"),
    "skills system prompt sent to cloud provider",
  );
  assert(
    sysTexts.includes("<call:calculator>"),
    "calculator skill listed in cloud prompt",
  );
  assert(
    sysTexts.includes("MUST call the relevant skill BEFORE answering"),
    "prompt forces skill-first answering",
  );
  assert(
    seenProviderRequests.length === 2,
    "second provider round-trip happened after skill execution",
  );
}

main()
  .catch((e) => {
    failures.push("unhandled: " + e.message);
    console.error(e);
  })
  .finally(() => {
    if (serverProc) serverProc.kill("SIGTERM");
    if (mockServer) mockServer.close();
    try {
      if (hadSettings) {
        fs.copyFileSync(BACKUP_FILE, SETTINGS_FILE);
        fs.unlinkSync(BACKUP_FILE);
      } else if (fs.existsSync(SETTINGS_FILE)) {
        fs.unlinkSync(SETTINGS_FILE);
      }
      console.log("cloud-settings.json restored");
    } catch (e) {
      console.error("RESTORE FAILED:", e.message);
    }
    console.log(
      failures.length === 0
        ? "\nE2E RESULT: ALL PASS"
        : `\nE2E RESULT: ${failures.length} FAILURE(S): ${failures.join("; ")}`,
    );
    process.exit(failures.length === 0 ? 0 : 1);
  });
