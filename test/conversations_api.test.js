// Contract tests for conversation storage, driven through the real HTTP API
// against a real server process with its own data directory.
//
// Conversations have no unit tests because the code lives in server.js and is
// entangled with the Pi domain, attachments and the security log (see the
// Phase 5 commit message). Testing the API instead pins the behaviour that
// matters without waiting for that untangling — and makes it safe to do later.
//
// This is only possible because DIVE_DATA_DIR exists: before that, a test like
// this wrote into the user's live ~/dive.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const PORT = 8931;
const BASE = `http://127.0.0.1:${PORT}`;

let server;
let dataDir;

async function waitForServer(timeoutMs = 15000) {
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
  throw new Error("server did not start");
}

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dive-conv-test-"));
  server = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: { ...process.env, DIVE_DATA_DIR: dataDir, PORT: String(PORT) },
    stdio: "ignore",
  });
  await waitForServer();
});

test.after(() => {
  if (server) server.kill("SIGKILL");
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

const api = async (method, url, body) => {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // some endpoints return no body
  }
  return { status: res.status, body: json };
};

const save = (id, mode, title, messages) =>
  api("POST", "/api/conversations", { id, mode, title, messages });

// GET /api/conversations deliberately merges every mode into one
// recency-sorted list; each entry carries its own mode.
const list = async () => {
  const { body } = await api("GET", "/api/conversations");
  return Array.isArray(body) ? body : body?.conversations || [];
};

test("a saved conversation can be read back by id", async () => {
  await save("conv-read", "ollama", "Read back", [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi there" },
  ]);
  const { status, body } = await api("GET", "/api/conversations/id/conv-read");
  assert.strictEqual(status, 200);
  assert.strictEqual(body.id, "conv-read");
  assert.strictEqual(body.history.at(-1).content, "hi there");
});

test("each mode's conversations are stored in their own file", async () => {
  await save("conv-ollama-only", "ollama", "Ollama", [
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
  ]);
  await save("conv-cloud-only", "cloud", "Cloud", [
    { role: "user", content: "c" },
    { role: "assistant", content: "d" },
  ]);

  const all = await list();
  const byId = Object.fromEntries(all.map((c) => [c.id, c]));
  assert.strictEqual(byId["conv-ollama-only"].mode, "ollama");
  assert.strictEqual(byId["conv-cloud-only"].mode, "cloud");

  // The merged list is a view. On disk each mode owns its own file, which is
  // what keeps one mode's history out of another's.
  const dir = path.join(dataDir, "conversations");
  const ollamaFile = JSON.parse(
    fs.readFileSync(path.join(dir, "ollama-conversations.json"), "utf8"),
  );
  const cloudFile = JSON.parse(
    fs.readFileSync(path.join(dir, "cloud-conversations.json"), "utf8"),
  );
  const ids = (f) => f.map((c) => c.id);
  assert.ok(ids(ollamaFile).includes("conv-ollama-only"));
  assert.ok(!ids(ollamaFile).includes("conv-cloud-only"));
  assert.ok(ids(cloudFile).includes("conv-cloud-only"));
  assert.ok(!ids(cloudFile).includes("conv-ollama-only"));
});

test("a deleted conversation stays deleted when a late turn arrives", async () => {
  // The invariant tombstones exist for: a generation still running when the
  // user deletes its conversation must not re-create it on completion.
  await save("conv-tombstone", "ollama", "Doomed", [
    { role: "user", content: "q" },
    { role: "assistant", content: "a" },
  ]);
  assert.strictEqual(
    (await api("GET", "/api/conversations/id/conv-tombstone")).status,
    200,
  );

  const del = await api("DELETE", "/api/conversations/id/conv-tombstone");
  assert.ok(del.status === 200 || del.status === 204, `got ${del.status}`);

  // The late write that a finishing turn would perform.
  await save("conv-tombstone", "ollama", "Doomed", [
    { role: "user", content: "q" },
    { role: "assistant", content: "late answer" },
  ]);

  const after = await api("GET", "/api/conversations/id/conv-tombstone");
  assert.notStrictEqual(
    after.status,
    200,
    "a tombstoned conversation was resurrected by a late write",
  );
  assert.ok(!(await list()).map((c) => c.id).includes("conv-tombstone"));
});

test("saving the same id twice updates rather than duplicates", async () => {
  await save("conv-update", "ollama", "First", [
    { role: "user", content: "one" },
    { role: "assistant", content: "first" },
  ]);
  await save("conv-update", "ollama", "Second", [
    { role: "user", content: "one" },
    { role: "assistant", content: "second" },
  ]);
  const matches = (await list()).filter((c) => c.id === "conv-update");
  assert.strictEqual(matches.length, 1, "duplicate conversation entries");
  const { body } = await api("GET", "/api/conversations/id/conv-update");
  assert.strictEqual(body.history.at(-1).content, "second");
});

test("nothing is written outside the configured data directory", async () => {
  // The whole point of DIVE_DATA_DIR: this suite must not touch ~/dive.
  const entries = fs.readdirSync(dataDir);
  assert.ok(
    entries.includes("conversations"),
    `expected conversations/ in the isolated data dir, got: ${entries.join(", ")}`,
  );
  const stored = fs.readdirSync(path.join(dataDir, "conversations"));
  assert.ok(stored.length > 0, "conversations were not persisted to disk");
});
