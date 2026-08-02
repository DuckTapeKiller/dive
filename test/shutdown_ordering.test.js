// D4 — shutdown ordering.
//
// gracefulShutdown does four things in sequence: terminate Pi processes, end
// the long-lived SSE channels, close the HTTP server, and force-exit after 5
// seconds if any of that wedges.
//
// The force-exit is a backstop, not the normal path. These tests assert that
// distinction, because the difference is invisible in day-to-day use: the app
// closed either way. It just took five seconds and exited non-zero every time.
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
let PORT = 8991;

async function waitForApp(base, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/conversations`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("Dive server did not start");
}

// Start a server on its own data directory, run `body`, then SIGTERM it and
// report how it died.
async function withServer(body) {
  const port = PORT++;
  const base = `http://127.0.0.1:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dive-shutdown-test-"));
  const app = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: { ...process.env, DIVE_DATA_DIR: dataDir, PORT: String(port) },
    stdio: "ignore",
  });

  const exited = new Promise((resolve) => {
    app.on("exit", (code, signal) => resolve({ code, signal }));
  });

  const opened = [];
  try {
    await waitForApp(base);
    await body({ base, port, opened });

    const started = Date.now();
    app.kill("SIGTERM");
    const { code, signal } = await exited;
    return { code, signal, elapsedMs: Date.now() - started };
  } finally {
    for (const req of opened) {
      try {
        req.destroy();
      } catch (_e) {
        // already gone
      }
    }
    app.kill("SIGKILL");
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

// Open an SSE connection and resolve once the server has accepted it, so the
// shutdown races a genuinely established stream rather than a pending connect.
function openSse(port, urlPath, opened) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: urlPath }, (res) => {
      res.on("data", () => {});
      res.once("data", () => resolve(res));
      // A stream that sends nothing up front still counts as established.
      setTimeout(() => resolve(res), 1000);
    });
    req.on("error", reject);
    opened.push(req);
  });
}

test("shutdown is clean and immediate with no clients attached", async () => {
  const { code, elapsedMs } = await withServer(async () => {});
  assert.strictEqual(code, 0, "a quiet server did not exit cleanly");
  assert.ok(
    elapsedMs < 2000,
    `a quiet shutdown took ${elapsedMs}ms; it should be near-instant`,
  );
});

test("an attached app-event stream does not delay shutdown to the force-exit", async () => {
  // The regression this pins: /api/events/global is an SSE channel that never
  // ends on its own, and server.close() waits for every open connection. With
  // the UI attached — i.e. always, in real use — shutdown fell through to the
  // 5-second force-exit and exited 1.
  const { code, elapsedMs } = await withServer(async ({ port, opened }) => {
    await openSse(port, "/api/events/global", opened);
  });
  assert.ok(
    elapsedMs < 4000,
    `shutdown took ${elapsedMs}ms with a client attached: it fell through to the 5s force-exit instead of closing the stream`,
  );
  assert.strictEqual(
    code,
    0,
    `shutdown exited ${code} with a client attached; the force-exit path exits 1`,
  );
});

test("several attached streams still shut down cleanly", async () => {
  const { code, elapsedMs } = await withServer(async ({ port, opened }) => {
    await Promise.all([
      openSse(port, "/api/events/global", opened),
      openSse(port, "/api/events/global", opened),
      openSse(port, "/api/events/global", opened),
    ]);
  });
  assert.ok(elapsedMs < 4000, `shutdown took ${elapsedMs}ms with 3 clients`);
  assert.strictEqual(code, 0, `shutdown exited ${code} with 3 clients`);
});

// Not tested here: the `shuttingDown` re-entrancy guard. It is correct and
// worth keeping, but it cannot be observed from outside the process — the whole
// sequence now completes in well under 40ms, so a second signal sent from a
// test always arrives after exit, and the guarded and unguarded builds are
// indistinguishable. A test asserting it would pass either way, which is worse
// than no test.
