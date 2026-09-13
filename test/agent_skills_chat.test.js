// Agent Skills through a real chat turn, end to end inside Dive.
//
// A mock OpenAI-compatible provider plays the model in Cloud mode (the XML
// tool path): it activates a skill, reads one of its files, and answers once
// the skill content is in the conversation. Dive runs for real, against a
// temporary data directory and a temporary HOME, so neither ~/dive nor
// ~/.agents/skills is touched or read.
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { spawn } = require("child_process");

const APP_DIR = path.join(__dirname, "..");
const REAL_DATA_DIR = path.join(os.homedir(), "dive");
const MOCK_PORT = 9473;
const APP_PORT = 8973;
const BASE = `http://127.0.0.1:${APP_PORT}`;

const BODY_MARKER = "GREETING-INSTRUCTIONS";
const FILE_MARKER = "WORD-FROM-REFERENCE";
const FINAL = "FINAL-ANSWER";

let serverProc = null;
let mockServer = null;
let tmp = null;
const providerRequests = [];

function sseChunk(text) {
  return (
    "data: " +
    JSON.stringify({ choices: [{ delta: { content: text } }] }) +
    "\n\n"
  );
}

// The "model": answer once a skill result is in the conversation; read the
// bundled file when the skill's instructions are present; otherwise activate.
function startMockProvider() {
  return new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        let parsed = {};
        try {
          parsed = JSON.parse(body);
        } catch (_e) {
          // The assertions report an unparseable body more clearly.
        }
        providerRequests.push(parsed);
        const flat = JSON.stringify(parsed.messages || []);
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        if (flat.includes("[TOOL RESULT: activate_skill]")) {
          res.write(sseChunk(FINAL));
        } else if (flat.includes(BODY_MARKER)) {
          res.write(
            sseChunk(
              '<call:activate_skill>{"name": "test-skill", "file": "references/word.md"}</call>',
            ),
          );
        } else {
          res.write(
            sseChunk('<call:activate_skill>{"name": "test-skill"}</call>'),
          );
        }
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

async function chat(message, history = []) {
  const before = providerRequests.length;
  const res = await postJson("/api/cloud/chat/stream", {
    message,
    history,
    library: { enabled: false },
  });
  const text = await res.text();
  const events = text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_e) {
        return { type: "__unparsed__", raw: line };
      }
    });
  return {
    ok: res.ok,
    events,
    requests: providerRequests.slice(before),
  };
}

function systemText(request) {
  return (request.messages || [])
    .filter((m) => m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n");
}

function lastUserText(request) {
  const users = (request.messages || []).filter((m) => m.role === "user");
  const last = users[users.length - 1];
  return last && typeof last.content === "string" ? last.content : "";
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

test.before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dive-agent-skills-chat-"));
  const dataDir = path.join(tmp, "data");
  const home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
  assert.notStrictEqual(
    path.resolve(dataDir),
    path.resolve(REAL_DATA_DIR),
    "refusing to run against the real data directory",
  );

  write(
    path.join(dataDir, "skills", "test-skill", "SKILL.md"),
    `---\nname: test-skill\ndescription: |\n  Formats greetings.\n  Use when the user asks for a greeting.\nlicense: MIT\n---\n\n# Test skill\n\n${BODY_MARKER}: answer with the word in references/word.md.\n`,
  );
  write(
    path.join(dataDir, "skills", "test-skill", "references", "word.md"),
    `${FILE_MARKER}\n`,
  );
  write(
    path.join(home, ".agents", "skills", "disabled-skill", "SKILL.md"),
    "---\nname: disabled-skill\ndescription: Switched off for Cloud mode.\n---\n\nDISABLED-BODY\n",
  );

  await startMockProvider();
  serverProc = spawn(process.execPath, ["server.js"], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      DIVE_DATA_DIR: dataDir,
      HOME: home,
      PORT: String(APP_PORT),
    },
    stdio: "ignore",
  });
  await waitForApp();

  const settings = await postJson("/api/cloud/settings", {
    provider: "openai",
    apiKeys: { openai: "test-key-not-a-real-secret" },
    baseUrls: { openai: `http://127.0.0.1:${MOCK_PORT}/v1` },
    models: { openai: "mock-model" },
  });
  assert.ok(settings.ok, "cloud settings saved");
  const toggles = await postJson("/api/ollama/skills/settings", {
    mode: "cloud",
    settings: { "skill:disabled-skill": false },
  });
  assert.ok(toggles.ok, "per-mode skill switch saved");
});

test.after(() => {
  if (serverProc) serverProc.kill("SIGKILL");
  if (mockServer) mockServer.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test("the API lists the skills with this mode's switches", async () => {
  const res = await fetch(`${BASE}/api/agent-skills?mode=cloud`);
  assert.ok(res.ok);
  const payload = await res.json();
  const byName = Object.fromEntries(
    payload.skills.map((skill) => [skill.name, skill]),
  );
  assert.strictEqual(byName["test-skill"].enabled, true);
  assert.strictEqual(byName["test-skill"].source, "dive");
  assert.strictEqual(byName["disabled-skill"].enabled, false);
  assert.strictEqual(byName["disabled-skill"].source, "agents");
  const ollama = await (
    await fetch(`${BASE}/api/agent-skills?mode=ollama`)
  ).json();
  assert.strictEqual(
    ollama.skills.find((skill) => skill.name === "disabled-skill").enabled,
    true,
    "switches are per mode",
  );
});

test("the model sees the catalogue, activates the skill and gets its body", async () => {
  const turn = await chat("Please write a greeting.");
  assert.ok(turn.ok);
  assert.strictEqual(
    turn.requests.length,
    2,
    "one tool round, then the answer",
  );
  const system = systemText(turn.requests[0]);
  assert.ok(system.includes("<available_skills>"));
  assert.ok(system.includes("<name>test-skill</name>"));
  assert.ok(!system.includes("disabled-skill"), "a disabled skill is hidden");
  assert.ok(
    system.includes("<call:activate_skill>"),
    "XML path shows the call",
  );
  const second = JSON.stringify(turn.requests[1].messages);
  assert.ok(second.includes("[TOOL RESULT: activate_skill]"));
  assert.ok(second.includes(BODY_MARKER), "the body reached the model");
  assert.ok(!second.includes("license: MIT"), "frontmatter is stripped");
  assert.ok(
    turn.events.some(
      (e) => e.type === "tool_start" && e.toolName === "activate_skill",
    ),
  );
  assert.ok(turn.events.some((e) => e.type === "done"));
});

test("/skill:name loads the skill into the message and its file on request", async () => {
  const turn = await chat("/skill:test-skill make one");
  assert.ok(turn.ok);
  const firstUser = lastUserText(turn.requests[0]);
  assert.ok(firstUser.startsWith('<skill_content name="test-skill">'));
  assert.ok(firstUser.includes(BODY_MARKER));
  assert.ok(firstUser.endsWith("User: make one"));
  const command = turn.events.find((e) => e.type === "slash_command");
  assert.ok(command, "the activation is visible in the trace");
  assert.strictEqual(command.commandType, "agent_skill");
  assert.strictEqual(command.skillName, "test-skill");
  const second = JSON.stringify(turn.requests[1].messages);
  assert.ok(second.includes(FILE_MARKER), "the bundled file reached the model");
  assert.ok(turn.events.some((e) => e.type === "done"));
});

test("a later turn keeps an earlier /skill: turn expanded", async () => {
  const turn = await chat("Thanks, once more please.", [
    { role: "user", content: "/skill:test-skill make one" },
    { role: "assistant", content: FINAL },
  ]);
  assert.ok(turn.ok);
  const users = turn.requests[0].messages.filter((m) => m.role === "user");
  assert.ok(users[0].content.startsWith('<skill_content name="test-skill">'));
  assert.ok(users[0].content.endsWith("User: make one"));
  assert.strictEqual(
    users[users.length - 1].content,
    "Thanks, once more please.",
  );
});

test("an unknown or disabled skill ends the turn with a readable error", async () => {
  for (const message of ["/skill:nope hi", "/skill:disabled-skill hi"]) {
    const turn = await chat(message);
    assert.ok(turn.ok);
    assert.strictEqual(turn.requests.length, 0, "the model is not called");
    assert.strictEqual(turn.events.length, 1);
    assert.strictEqual(turn.events[0].type, "error");
    assert.match(turn.events[0].error, /no enabled skill named/);
  }
});

test("with every skill switched off, nothing about skills is offered", async () => {
  const off = await postJson("/api/ollama/skills/settings", {
    mode: "cloud",
    settings: { "skill:test-skill": false },
  });
  assert.ok(off.ok);
  const turn = await chat("Please write a greeting.");
  assert.ok(turn.ok);
  const system = systemText(turn.requests[0]);
  assert.ok(!system.includes("<available_skills>"));
  assert.ok(!system.includes("activate_skill"));
  const second = JSON.stringify(turn.requests[1].messages);
  assert.ok(second.includes("no Agent Skills are enabled for this mode"));
  const on = await postJson("/api/ollama/skills/settings", {
    mode: "cloud",
    settings: { "skill:test-skill": true },
  });
  assert.ok(on.ok);
});

test("extra folders are validated, saved and scanned", async () => {
  const bad = await postJson("/api/agent-skills/paths", {
    mode: "cloud",
    paths: ["relative/folder"],
  });
  assert.strictEqual(bad.status, 400);
  const extra = path.join(tmp, "extra-skills");
  write(
    path.join(extra, "extra-skill", "SKILL.md"),
    "---\nname: extra-skill\ndescription: From an added folder.\n---\n\nEXTRA\n",
  );
  const good = await postJson("/api/agent-skills/paths", {
    mode: "cloud",
    paths: [extra],
  });
  assert.ok(good.ok);
  const payload = await good.json();
  assert.deepStrictEqual(payload.paths, [extra]);
  assert.ok(payload.skills.some((skill) => skill.name === "extra-skill"));
  assert.ok(
    fs.existsSync(path.join(tmp, "data", "skill-paths.json")),
    "saved in the isolated data directory",
  );
});
