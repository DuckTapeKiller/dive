// Contract tests for POST /api/upload — the one endpoint that takes an
// arbitrary file from the user and writes it to disk. It had no test.
//
// Covers what would actually hurt: which types are accepted, that a hostile
// filename cannot escape the data directory, that the size cap is enforced,
// and that malformed multipart is rejected rather than crashing the server.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const http = require("http");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const PORT = 8961;
const BASE = `http://127.0.0.1:${PORT}`;

let app;
let dataDir;

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

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dive-upload-test-"));
  app = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: { ...process.env, DIVE_DATA_DIR: dataDir, PORT: String(PORT) },
    stdio: "ignore",
  });
  await waitForApp();
});

test.after(() => {
  if (app) app.kill("SIGKILL");
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

// A minimal multipart/form-data body, built by hand so the filename and the
// boundary can both be made hostile.
function multipart(filename, content, { boundary = "----diveTest" } = {}) {
  const head =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  return {
    body: Buffer.concat([
      Buffer.from(head),
      Buffer.isBuffer(content) ? content : Buffer.from(content),
      Buffer.from(tail),
    ]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function upload(filename, content, opts) {
  const { body, contentType } = multipart(filename, content, opts);
  const res = await fetch(`${BASE}/api/upload`, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body,
  });
  let json = null;
  try {
    json = JSON.parse(await res.text());
  } catch (_e) {
    // Non-JSON responses are reported by the assertions rather than hidden.
  }
  return { status: res.status, body: json };
}

// 1x1 PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test("an allowed text file comes back as text", async () => {
  const { status, body } = await upload("notes.md", "# hello\nworld");
  assert.strictEqual(status, 200);
  assert.strictEqual(body.kind, "text");
  assert.strictEqual(body.text, "# hello\nworld");
  assert.strictEqual(body.filename, "notes.md");
});

test("an image is stored and returned as base64 with a URL", async () => {
  const { status, body } = await upload("shot.png", PNG);
  assert.strictEqual(status, 200);
  assert.strictEqual(body.kind, "image");
  assert.strictEqual(body.mimeType, "image/png");
  assert.strictEqual(body.dataBase64, PNG.toString("base64"));
  assert.match(
    body.url,
    /^\/api\/attachments\//,
    `unexpected url: ${body.url}`,
  );
});

test("an unsupported extension is refused with 415", async () => {
  for (const name of ["payload.exe", "script.sh", "archive.zip"]) {
    const { status, body } = await upload(name, "x");
    assert.strictEqual(status, 415, `${name} should be refused`);
    assert.match(body.error, /Unsupported file type/);
  }
});

test("a file with no extension is refused", async () => {
  const { status } = await upload("README", "x");
  assert.strictEqual(status, 415);
});

test("a hostile filename cannot write outside the attachments directory", async () => {
  // The stored name is derived from a hash of the content, never from the
  // filename, so traversal in the name has nowhere to go. Pinned because a
  // refactor that "preserved the original filename" would reintroduce it.
  const before = new Set(
    fs.existsSync(path.join(dataDir, "attachments"))
      ? fs.readdirSync(path.join(dataDir, "attachments"))
      : [],
  );
  const hostile = "../../../../../../tmp/dive-escape-test.png";
  const { status, body } = await upload(hostile, PNG);
  assert.strictEqual(status, 200);

  assert.ok(
    !body.url.includes(".."),
    `the returned URL contains traversal: ${body.url}`,
  );
  assert.ok(
    !fs.existsSync("/tmp/dive-escape-test.png"),
    "an uploaded file escaped the data directory",
  );

  const dir = path.join(dataDir, "attachments");
  const added = fs.readdirSync(dir).filter((f) => !before.has(f));
  for (const f of added) {
    assert.match(
      f,
      /^img_[0-9a-f]{32}\.(png|jpe?g|gif|webp)$/,
      `stored under an attacker-influenced name: ${f}`,
    );
  }
  // Everything written stays inside the attachments directory.
  for (const f of fs.readdirSync(dir)) {
    const resolved = path.resolve(dir, f);
    assert.ok(
      resolved.startsWith(path.resolve(dir) + path.sep),
      `${resolved} is outside ${dir}`,
    );
  }
});

test("a traversal filename on the text path does not read a real file", async () => {
  // .txt is allowed, so the request is accepted — but the response must be the
  // uploaded bytes, never the contents of the path the name points at.
  const { status, body } = await upload(
    "../../../../etc/hosts.txt",
    "uploaded content only",
  );
  assert.strictEqual(status, 200);
  assert.strictEqual(body.text, "uploaded content only");
  assert.doesNotMatch(body.text, /localhost/);
});

test("an oversized upload is refused with 413", async () => {
  // readBody rejects on the declared Content-Length before reading a byte.
  // fetch() computes Content-Length from the body it is given, so the header
  // has to be set on a raw request for the cap to be exercised at all.
  const status = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: PORT,
        path: "/api/upload",
        method: "POST",
        headers: {
          "Content-Type": "multipart/form-data; boundary=----diveTest",
          "Content-Length": String(60 * 1024 * 1024),
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
    req.write("x"); // never the declared length; the cap must fire first
  });
  assert.strictEqual(status, 413, "the 50MB upload cap was not enforced");
});

test("multipart with no boundary is rejected, not crashed on", async () => {
  const res = await fetch(`${BASE}/api/upload`, {
    method: "POST",
    headers: { "Content-Type": "multipart/form-data" },
    body: "garbage",
  });
  assert.strictEqual(res.status, 400);
  const { error } = await res.json();
  assert.match(error, /boundary/i);
});

test("a body with no file part is rejected", async () => {
  const boundary = "----diveTest";
  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="notafile"\r\n\r\n` +
    `value\r\n--${boundary}--\r\n`;
  const res = await fetch(`${BASE}/api/upload`, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body,
  });
  assert.strictEqual(res.status, 400);
});

test("the server is still healthy after every malformed upload", async () => {
  const res = await fetch(`${BASE}/api/conversations`);
  assert.strictEqual(res.status, 200);
});
