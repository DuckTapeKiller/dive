// Attachments that never reach the model must not vanish in silence.
//
// resolveAttachmentImages drops images for three reasons — a malformed entry,
// a file that cannot be read back from the attachments store, and everything
// past the per-turn cap. All three used to be invisible: the user's own message
// bubble renders a thumbnail for every image they attached, so ten thumbnails
// could sit above an answer the model formed from eight.
//
// The turn still runs; it just says what it left behind.
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { TextDecoder } = require("util");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const APP_PORT = 8951;
const UPSTREAM_PORT = 8952;
const BASE = `http://127.0.0.1:${APP_PORT}`;

let app;
let upstream;
let dataDir;

// 1x1 PNG.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function startUpstream() {
  return new Promise((resolve) => {
    upstream = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
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
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        res.write(
          JSON.stringify({ message: { content: "ok" }, done: false }) + "\n",
        );
        res.write(JSON.stringify({ message: { content: "" }, done: true }));
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

async function readEvents(response) {
  const text = await response.text();
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch (_e) {
        return { type: "__unparsed__", raw: l };
      }
    });
}

// Send a turn with `images` and return the notice, if any.
async function turnWithImages(images, convId) {
  const events = await readEvents(
    await post("/api/chat/stream", {
      message: "describe these",
      history: [],
      model: "fake-model",
      images,
      saveConv: convId,
      convTitle: "Attach",
    }),
  );
  return {
    events,
    notice: events.find((e) => e.type === "attachment_notice") || null,
  };
}

const inlineImage = (name) => ({
  name,
  mimeType: "image/png",
  dataBase64: PNG_B64,
});

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dive-attach-test-"));
  await startUpstream();
  app = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: { ...process.env, DIVE_DATA_DIR: dataDir, PORT: String(APP_PORT) },
    stdio: "ignore",
  });
  await waitForApp();
  await post("/api/ollama/settings", {
    baseUrl: `http://127.0.0.1:${UPSTREAM_PORT}`,
  });
});

test.after(() => {
  if (app) app.kill("SIGKILL");
  if (upstream) upstream.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test("a turn within the limit says nothing about attachments", async () => {
  // The other half of the contract: a warning on every ordinary turn would be
  // worse than no warning at all, because it would be ignored.
  const { notice } = await turnWithImages(
    [inlineImage("a.png"), inlineImage("b.png")],
    "attach-ok",
  );
  assert.strictEqual(
    notice,
    null,
    `a turn that lost nothing warned anyway: ${notice && notice.message}`,
  );
});

test("images past the per-turn cap are reported, not dropped in silence", async () => {
  // Ten attached, eight sent. The user's own bubble shows all ten.
  const images = Array.from({ length: 10 }, (_, i) =>
    inlineImage(`shot-${i + 1}.png`),
  );
  const { notice } = await turnWithImages(images, "attach-cap");
  assert.ok(notice, "ten images were sent, two were dropped, nothing was said");
  assert.strictEqual(notice.dropped.length, 2, notice.message);
  assert.ok(
    notice.dropped.every((d) => d.reason === "over_limit"),
    `wrong reason: ${JSON.stringify(notice.dropped)}`,
  );
  assert.match(notice.message, /2 attachments not sent/);
  assert.match(notice.message, /limit/);
  // Named, so the user knows which ones.
  assert.match(notice.message, /shot-9\.png/);
  assert.match(notice.message, /shot-10\.png/);
});

test("an attachment that cannot be read back is reported", async () => {
  // A ref to a stored attachment that is not there — the file was removed, or
  // never written. loadAttachmentImage returns null and the turn continues.
  const { notice } = await turnWithImages(
    [
      inlineImage("present.png"),
      { name: "ghost.png", url: "/api/attachments/img_deadbeef.png" },
    ],
    "attach-missing",
  );
  assert.ok(notice, "a missing attachment was dropped silently");
  assert.ok(
    notice.dropped.some((d) => d.reason === "unreadable"),
    `expected an unreadable drop, got ${JSON.stringify(notice.dropped)}`,
  );
  assert.match(notice.message, /ghost\.png/);
});

test("a malformed attachment entry is reported", async () => {
  const { notice } = await turnWithImages(
    [inlineImage("real.png"), null, "not-an-object", 42],
    "attach-malformed",
  );
  assert.ok(notice, "malformed attachment entries were dropped silently");
  assert.strictEqual(
    notice.dropped.filter((d) => d.reason === "invalid").length,
    3,
    `expected 3 malformed entries, got ${JSON.stringify(notice.dropped)}`,
  );
});

test("the turn still runs and answers after dropping attachments", async () => {
  // "Continue and tell", not "reject". Losing the ninth image must not cost
  // the user the answer.
  const images = Array.from({ length: 12 }, (_, i) =>
    inlineImage(`many-${i}.png`),
  );
  const { events, notice } = await turnWithImages(images, "attach-continues");
  assert.ok(notice, "no notice");
  const done = events.find((e) => e.type === "done");
  assert.ok(done, "the turn was aborted instead of continuing");
  assert.match(
    done.response || "",
    /ok/,
    `the model's answer was lost: ${JSON.stringify(done.response)}`,
  );
});

test("the notice reaches the client before the answer", async () => {
  // It has to arrive while the turn is still on screen, not after the answer
  // has scrolled it away.
  const images = Array.from({ length: 10 }, (_, i) =>
    inlineImage(`order-${i}.png`),
  );
  const { events } = await turnWithImages(images, "attach-order");
  const noticeAt = events.findIndex((e) => e.type === "attachment_notice");
  const firstDeltaAt = events.findIndex((e) => e.type === "delta");
  assert.ok(noticeAt >= 0, "no notice was emitted");
  assert.ok(
    firstDeltaAt === -1 || noticeAt < firstDeltaAt,
    `the notice arrived at ${noticeAt}, after the first answer chunk at ${firstDeltaAt}`,
  );
});

test("Pi reports dropped attachments even when Pi itself fails to start", async () => {
  // Same guarantee on the mode with its own request path, and the harder case:
  // the notice is emitted before the agent is started, so a Pi that never comes
  // up cannot also swallow the news that attachments were dropped.
  //
  // Pi is pointed at a command that does not exist, so this never spawns the
  // real `pi` on the machine running the tests.
  await post("/api/pi/settings", {
    settings: {
      commandPath: path.join(dataDir, "no-such-pi-binary"),
      workingDirectory: dataDir,
    },
  });

  const images = Array.from({ length: 10 }, (_, i) =>
    inlineImage(`pi-${i}.png`),
  );
  // Read incrementally with a deadline instead of awaiting the whole stream:
  // Pi never starts here, so the response does not end on its own. The point is
  // that the notice arrives anyway.
  const res = await post("/api/pi/stream", {
    message: "describe these",
    history: [],
    images,
    saveConv: "attach-pi",
    convTitle: "Attach Pi",
    mode: "pi",
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !buffered.includes("attachment_notice")) {
    const timeout = new Promise((r) =>
      setTimeout(
        () => r({ timedOut: true }),
        Math.max(0, deadline - Date.now()),
      ),
    );
    const chunk = await Promise.race([reader.read(), timeout]);
    if (chunk.timedOut || chunk.done) break;
    buffered += decoder.decode(chunk.value, { stream: true });
  }
  reader.cancel().catch(() => {});

  const events = buffered
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch (_e) {
        return { type: "__partial__" };
      }
    });
  const notice = events.find((e) => e.type === "attachment_notice");
  assert.ok(
    notice,
    `Pi dropped attachments without saying so; event types: ${[
      ...new Set(events.map((e) => e.type)),
    ].join(", ")}`,
  );
  assert.strictEqual(notice.dropped.length, 2, notice.message);
});
