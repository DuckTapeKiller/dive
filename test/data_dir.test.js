const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");

// data-dir.js resolves once at require time, so each case runs in its own
// process with its own environment.
function resolveIn(env) {
  const out = execFileSync(
    process.execPath,
    ["-e", 'process.stdout.write(JSON.stringify(require("./data-dir.js")))'],
    { cwd: ROOT, encoding: "utf8", env: { ...process.env, ...env } },
  );
  return JSON.parse(out);
}

test("defaults to ~/dive when nothing is set", () => {
  const d = resolveIn({ DIVE_DATA_DIR: "" });
  assert.strictEqual(d.DATA_DIR, path.join(os.homedir(), "dive"));
  assert.strictEqual(d.PLUGINS_DIR, path.join(os.homedir(), "dive", "plugins"));
  assert.strictEqual(d.isOverridden, false);
});

test("DIVE_DATA_DIR overrides it, and subdirectories follow", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dive-datadir-"));
  try {
    const d = resolveIn({ DIVE_DATA_DIR: dir });
    assert.strictEqual(d.DATA_DIR, path.resolve(dir));
    assert.strictEqual(d.PLUGINS_DIR, path.join(d.DATA_DIR, "plugins"));
    assert.strictEqual(d.WORKSPACE_DIR, path.join(d.DATA_DIR, "workspace"));
    assert.strictEqual(d.isOverridden, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a relative override is resolved to an absolute path", () => {
  const d = resolveIn({ DIVE_DATA_DIR: "./tmp-data" });
  assert.ok(path.isAbsolute(d.DATA_DIR));
  assert.strictEqual(d.DATA_DIR, path.join(ROOT, "tmp-data"));
});

test("whitespace-only override falls back to the default", () => {
  const d = resolveIn({ DIVE_DATA_DIR: "   " });
  assert.strictEqual(d.DATA_DIR, path.join(os.homedir(), "dive"));
  assert.strictEqual(d.isOverridden, false);
});

test("every module that stores data honours the override", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dive-datadir-"));
  try {
    // Each of these used to compute ~/dive independently.
    const out = execFileSync(
      process.execPath,
      [
        "-e",
        `const { DATA_DIR } = require("./data-dir.js");
         const p = require("./plugins.js");
         const sandbox = require("./skills/sandbox.js");
         process.stdout.write(JSON.stringify({
           dataDir: DATA_DIR,
           pluginsDir: p.PLUGINS_DIR,
           allowedDirsFile: sandbox.ALLOWED_DIRS_FILE,
         }));`,
      ],
      {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, DIVE_DATA_DIR: dir },
      },
    );
    const got = JSON.parse(out);
    const real = path.resolve(dir);
    assert.strictEqual(got.dataDir, real);
    assert.strictEqual(got.pluginsDir, path.join(real, "plugins"));
    assert.strictEqual(
      got.allowedDirsFile,
      path.join(real, "allowed-dirs.json"),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
