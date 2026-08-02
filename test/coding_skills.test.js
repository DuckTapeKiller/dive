const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Point Dive's data directory at a temporary tree BEFORE requiring anything
// that reads it — data-dir.js resolves once at require time. Without this the
// test creates directories inside the user's real ~/dive/workspace.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dive-coding-test-"));
process.env.DIVE_DATA_DIR = dataDir;

const {
  resolveAllowedPath,
  globToRegex,
  skillRequiresShellConfirmation,
} = require("../skills.js");

const workspace = path.join(dataDir, "workspace");

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test("resolveAllowedPath accepts the workspace and rejects outside paths", () => {
  fs.mkdirSync(workspace, { recursive: true });
  const ok = resolveAllowedPath(workspace);
  assert.ok(!ok.error, ok.error);
  assert.strictEqual(ok.target, fs.realpathSync(workspace));

  const outside = resolveAllowedPath("/etc");
  assert.ok(outside.error);
  assert.match(outside.error, /outside the allowed directories/);
});

test("resolveAllowedPath rejects relative paths and missing paths", () => {
  assert.ok(resolveAllowedPath("relative/path").error);
  assert.ok(
    resolveAllowedPath(path.join(workspace, "definitely-not-here-12345")).error,
  );
});

test("resolveAllowedPath allowHome accepts home paths for gated callers", () => {
  const home = resolveAllowedPath("~", { allowHome: true });
  assert.ok(!home.error);
  assert.strictEqual(home.target, fs.realpathSync(os.homedir()));
});

test("globToRegex matches like a shell glob", () => {
  assert.ok(globToRegex("*.py").test("/a/b/script.py"));
  assert.ok(!globToRegex("*.py").test("/a/b/script.js"));
  assert.ok(globToRegex("**/config*").test("/a/deep/dir/config.yaml"));
  assert.ok(globToRegex("file?.txt").test("/x/file1.txt"));
  assert.ok(!globToRegex("file?.txt").test("/x/file12.txt"));
});

test("mutating skills are gated, read-only ones are not", () => {
  assert.strictEqual(
    skillRequiresShellConfirmation("run_python", dataDir),
    true,
  );
  assert.strictEqual(
    skillRequiresShellConfirmation("macos_control", dataDir),
    true,
  );
  assert.strictEqual(
    skillRequiresShellConfirmation("shell_command", dataDir),
    true,
  );
  assert.strictEqual(
    skillRequiresShellConfirmation("code_search", dataDir),
    false,
  );
  assert.strictEqual(
    skillRequiresShellConfirmation("git_tools", dataDir),
    false,
  );
  assert.strictEqual(
    skillRequiresShellConfirmation("academic_search", dataDir),
    false,
  );
});
