const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dive-render-test-"));
process.env.DIVE_DATA_DIR = dataDir;

const {
  renderPage,
  renderAvailable,
  renderCommand,
} = require("../skills/render-page.js");
const { readUrlContent } = require("../skills/research.js");

const ROOT = path.join(__dirname, "..");
test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

// A stand-in for the Electron renderer: a Node script that answers the way
// electron/render-page.js does, and records how it was started.
function fakeRenderer(body) {
  const dir = fs.mkdtempSync(path.join(dataDir, "renderer-"));
  const script = path.join(dir, "render.js");
  const log = path.join(dir, "started.json");
  fs.writeFileSync(
    script,
    `require("fs").writeFileSync(${JSON.stringify(log)}, JSON.stringify({
       url: process.env.DIVE_RENDER_URL,
       runAsNode: process.env.ELECTRON_RUN_AS_NODE || "",
       args: process.argv.slice(2),
     }));
     ${body}`,
  );
  return {
    log,
    env: {
      ...process.env,
      DIVE_ELECTRON_BINARY: process.execPath,
      DIVE_RENDER_ARGS: JSON.stringify([script, "--render-page"]),
      // A server running as Electron-in-Node passes this down; the renderer
      // must not inherit it.
      ELECTRON_RUN_AS_NODE: "1",
    },
  };
}

test("without Dive's desktop app there is no renderer, and nothing is started", async () => {
  const env = { ...process.env };
  delete env.DIVE_ELECTRON_BINARY;
  assert.strictEqual(renderAvailable(env), false);
  const result = await renderPage("https://example.com/", { env });
  assert.deepStrictEqual(result, {
    ok: false,
    error: "page rendering needs Dive's desktop app",
  });
  assert.strictEqual(
    renderCommand({
      DIVE_ELECTRON_BINARY: process.execPath,
      DIVE_RENDER_ARGS: "{",
    }),
    null,
  );
});

test("the rendered page comes back from the renderer's last line", async () => {
  const { env, log } = fakeRenderer(`
    console.log("some log line first");
    process.stdout.write(JSON.stringify({ ok: true, url: process.env.DIVE_RENDER_URL,
      title: "T", html: "<html><body><article>${"Rendered text. ".repeat(20)}</article></body></html>" }) + "\\n");
  `);
  const result = await renderPage("https://example.com/app", { env });
  assert.strictEqual(result.ok, true, result.error);
  assert.match(result.html, /Rendered text/);
  const started = JSON.parse(fs.readFileSync(log, "utf8"));
  assert.strictEqual(started.url, "https://example.com/app");
  assert.strictEqual(
    started.runAsNode,
    "",
    "ELECTRON_RUN_AS_NODE reached the renderer",
  );
  assert.deepStrictEqual(started.args, ["--render-page"]);
});

test("a private address is refused before any renderer starts", async () => {
  const { env, log } = fakeRenderer(`process.stdout.write("{}\\n");`);
  for (const url of [
    "http://127.0.0.1:8080/",
    "http://localhost:8130/",
    "http://192.168.1.1/",
  ]) {
    const result = await renderPage(url, { env });
    assert.strictEqual(result.ok, false, url);
    assert.match(result.error, /local or private/i, url);
  }
  assert.strictEqual(fs.existsSync(log), false, "a renderer was started");
});

test("a renderer that says nothing useful is reported, not trusted", async () => {
  const { env } = fakeRenderer(`process.stdout.write("not json\\n");`);
  const result = await renderPage("https://example.com/", { env });
  assert.deepStrictEqual(result, {
    ok: false,
    error: "the renderer gave no readable answer",
  });
});

test("the reader renders a page only after a plain fetch found no text", async () => {
  const order = [];
  const article = `<html><body><article>${"A paragraph the page builds with JavaScript. ".repeat(12)}</article></body></html>`;
  const result = await readUrlContent("https://example.com/app", 2000, {
    retryDelayMs: 0,
    fetchHtmlFn: async (target) => {
      order.push(target.startsWith("https://r.jina.ai/") ? "jina" : "direct");
      if (target.startsWith("https://r.jina.ai/"))
        throw new Error("rate limited");
      return "<html><body><div id=root></div></body></html>";
    },
    renderPageFn: async (url) => {
      order.push(`render ${url}`);
      return { ok: true, html: article };
    },
    readViaWaybackFn: async () => {
      order.push("wayback");
      return null;
    },
    readViaArchivePhFn: async () => {
      order.push("archive.ph");
      return null;
    },
  });
  assert.strictEqual(result.ok, true, result.error);
  assert.match(result.text, /builds with JavaScript/);
  assert.deepStrictEqual(order, [
    "jina",
    "jina",
    "direct",
    "render https://example.com/app",
  ]);
});

test("Dive --render-page hands over before the lock, a window or the LaunchAgent", () => {
  // electron/main.js run with a fake `electron` module that fails the test if
  // anything of the normal start-up is touched, and a fake render-page.js.
  const out = execFileSync(
    process.execPath,
    [
      "-e",
      `
      const Module = require("module");
      const touched = [];
      const trap = (name) => new Proxy(function () {}, {
        get: (_t, key) => { touched.push(name + "." + String(key)); return trap(name + "." + String(key)); },
        apply: () => { touched.push(name + "()"); return trap(name); },
      });
      const load = Module._load;
      Module._load = function (request, parent, isMain) {
        if (request === "electron") return { app: trap("app"), BrowserWindow: trap("BrowserWindow"), dialog: trap("dialog"), shell: trap("shell") };
        if (request === "./render-page.js") { touched.push("render-page"); return {}; }
        return load.apply(this, arguments);
      };
      process.argv.push("--render-page");
      require(${JSON.stringify(path.join(ROOT, "electron", "main.js"))});
      process.stdout.write(JSON.stringify(touched));
      `,
    ],
    { encoding: "utf8", env: { ...process.env, DIVE_DATA_DIR: dataDir } },
  );
  assert.deepStrictEqual(JSON.parse(out), ["render-page"]);
});
