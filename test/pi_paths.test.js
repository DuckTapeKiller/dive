const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const {
  sanitizePiCommandPath,
  sanitizePiWorkingDirectory,
} = require("../pi-paths.js");

function makeTree() {
  const root = fs.mkdtempSync(path.join(os.homedir(), ".dive-pi-paths-test-"));
  // Mimic a package-manager layout: a group-writable lib prefix holding the
  // real executable, with a bin symlink pointing into it.
  const lib = path.join(root, "lib");
  const bin = path.join(root, "bin");
  fs.mkdirSync(lib);
  fs.mkdirSync(bin);
  const real = path.join(lib, "cli.js");
  fs.writeFileSync(real, "#!/usr/bin/env node\n", { mode: 0o755 });
  fs.symlinkSync(real, path.join(bin, "pi"));
  fs.chmodSync(lib, 0o775); // group-writable, exactly like /opt/homebrew/lib
  return { root, bin, lib, real };
}

test("a Homebrew-style pi install is accepted", () => {
  const { root, bin } = makeTree();
  try {
    const launcher = path.join(bin, "pi");
    const result = sanitizePiCommandPath(launcher);
    assert.strictEqual(
      result.reason,
      "",
      `expected acceptance, got: ${result.reason}`,
    );
    // The launcher path is kept, not the resolved .../cli.js it points at.
    assert.strictEqual(result.path, launcher);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("sanitizing a pi command path is idempotent", () => {
  const { root, bin } = makeTree();
  try {
    // Settings are re-sanitized every time they are loaded from disk, so a
    // saved value must survive the round trip unchanged.
    const once = sanitizePiCommandPath(path.join(bin, "pi"));
    const twice = sanitizePiCommandPath(once.path);
    assert.deepStrictEqual(twice, once);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a rejected pi command path explains why", () => {
  const missing = sanitizePiCommandPath("/nope/definitely/missing/pi");
  assert.strictEqual(missing.path, "");
  assert.match(missing.reason, /does not exist/);

  const wrongName = sanitizePiCommandPath("/usr/bin/env");
  assert.strictEqual(wrongName.path, "");
  assert.match(wrongName.reason, /must end in one of/);

  const relative = sanitizePiCommandPath("./bin/pi");
  assert.strictEqual(relative.path, "");
  assert.match(relative.reason, /absolute path/);
});

test("an empty pi command path is allowed and carries no error", () => {
  assert.deepStrictEqual(sanitizePiCommandPath(""), { path: "", reason: "" });
  assert.deepStrictEqual(sanitizePiCommandPath(undefined), {
    path: "",
    reason: "",
  });
});

test("a world-writable pi executable is refused", () => {
  const { root, bin, real } = makeTree();
  try {
    fs.chmodSync(real, 0o777);
    const result = sanitizePiCommandPath(path.join(bin, "pi"));
    assert.strictEqual(result.path, "");
    assert.match(result.reason, /writable by other users/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the working directory is confined to home or the data folder", () => {
  const dataDir = path.join(os.homedir(), ".dive-data-test");
  const inside = sanitizePiWorkingDirectory(os.homedir(), dataDir);
  assert.strictEqual(inside.reason, "");
  assert.strictEqual(inside.path, path.resolve(os.homedir()));

  const outside = sanitizePiWorkingDirectory("/etc", dataDir);
  assert.strictEqual(outside.path, "");
  assert.match(outside.reason, /home or Dive data folder/);

  const notADirectory = sanitizePiWorkingDirectory("/etc/hosts", dataDir);
  assert.strictEqual(notADirectory.path, "");
  assert.match(notADirectory.reason, /is not a directory/);
});
