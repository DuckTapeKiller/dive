const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const {
  checkForUpdate,
  clonePlugin,
  displayRepoUrl,
  installPlugin,
  parseGithubRepoUrl,
  pluginSource,
  updatePlugin,
} = require("../plugin-sources.js");

// A real repository standing in for GitHub, a plugin installed as a clone of
// it, and an author's working copy that pushes new versions.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dive-plugin-sources-"));
const remote = path.join(root, "remote.git");
const author = path.join(root, "author");
const pluginsDir = path.join(root, "plugins");
const installed = path.join(pluginsDir, "myplug");

function git(cwd, ...args) {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

function writePlugin(dir, version) {
  fs.writeFileSync(
    path.join(dir, "index.js"),
    `module.exports = {\n  name: "myplug",\n  version: "${version}",\n  skills: [],\n};\n`,
  );
  fs.writeFileSync(
    path.join(dir, "plugin.json"),
    JSON.stringify({ name: "myplug", version }),
  );
}

function publish(version, message) {
  writePlugin(author, version);
  git(author, "add", "-A");
  git(author, "commit", "-q", "-m", message);
  git(author, "push", "-q", "origin", "main");
}

test.before(() => {
  fs.mkdirSync(pluginsDir, { recursive: true });
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  git(root, "init", "-q", "-b", "main", author);
  git(author, "remote", "add", "origin", remote);
  publish("1.0.0", "First version");
  git(pluginsDir, "clone", "-q", remote, installed);
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test("a cloned plugin knows its source; a plain folder has none", async () => {
  const source = await pluginSource(installed);
  assert.ok(source, "a clone has a source");
  assert.match(source.commit, /^[0-9a-f]{7,}$/);
  assert.strictEqual(source.branch, "main");
  assert.strictEqual(source.localChanges, false);
  const plain = path.join(pluginsDir, "plain");
  fs.mkdirSync(plain);
  writePlugin(plain, "1.0.0");
  assert.strictEqual(await pluginSource(plain), null);
  assert.strictEqual((await checkForUpdate(plain)).status, "no-source");
});

test("a newer version is found, with its version and what changed", async () => {
  assert.strictEqual((await checkForUpdate(installed)).status, "up-to-date");
  publish("1.1.0", "Add a feature");
  const check = await checkForUpdate(installed);
  assert.strictEqual(check.status, "available");
  assert.strictEqual(check.behind, 1);
  assert.strictEqual(check.currentVersion, "1.0.0");
  assert.strictEqual(check.latestVersion, "1.1.0");
  assert.deepStrictEqual(
    check.changes.map((change) => change.subject),
    ["Add a feature"],
  );
});

test("local edits block an update, and nothing is overwritten", async () => {
  const file = path.join(installed, "index.js");
  const original = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, `${original}// my own change\n`);
  const result = await updatePlugin(installed);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.status, "blocked");
  assert.match(result.message, /local changes/);
  assert.match(fs.readFileSync(file, "utf8"), /my own change/);
  fs.writeFileSync(file, original);
  // An untracked file (a stray .DS_Store) does not count as an edit.
  fs.writeFileSync(path.join(installed, ".DS_Store"), "x");
  assert.strictEqual((await pluginSource(installed)).localChanges, false);
});

test("an update fast-forwards to the new version", async () => {
  const result = await updatePlugin(installed);
  assert.strictEqual(result.ok, true, result.message);
  assert.strictEqual(result.status, "updated");
  assert.match(result.message, /1\.1\.0/);
  assert.match(
    fs.readFileSync(path.join(installed, "index.js"), "utf8"),
    /version: "1\.1\.0"/,
  );
  assert.strictEqual((await checkForUpdate(installed)).status, "up-to-date");
});

test("a folder whose history moved apart is not touched", async () => {
  fs.writeFileSync(path.join(installed, "local.txt"), "mine");
  git(installed, "add", "local.txt");
  git(installed, "commit", "-q", "-m", "A local commit");
  publish("1.2.0", "Another feature");
  const before = git(installed, "rev-parse", "HEAD");
  const result = await updatePlugin(installed);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.status, "blocked");
  assert.match(result.message, /commit\(s\) the repository does not have/);
  assert.strictEqual(git(installed, "rev-parse", "HEAD"), before);
});

test("adding clones a plugin, and refuses what is not one", async () => {
  const added = await clonePlugin(remote, "fromremote", pluginsDir);
  assert.strictEqual(added.ok, true, added.message);
  assert.ok(fs.existsSync(path.join(pluginsDir, "fromremote", "index.js")));
  const again = await clonePlugin(remote, "fromremote", pluginsDir);
  assert.strictEqual(again.ok, false);
  assert.match(again.message, /already exists/);
  // A repository without index.js is not a Dive plugin and is removed.
  const notPlugin = path.join(root, "notplugin.git");
  git(root, "init", "-q", "--bare", "-b", "main", notPlugin);
  const work = path.join(root, "notplugin-work");
  git(root, "init", "-q", "-b", "main", work);
  fs.writeFileSync(path.join(work, "README.md"), "hello");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "readme");
  git(work, "remote", "add", "origin", notPlugin);
  git(work, "push", "-q", "origin", "main");
  const refused = await clonePlugin(notPlugin, "notplugin", pluginsDir);
  assert.strictEqual(refused.ok, false);
  assert.match(refused.message, /not a Dive plugin/);
  assert.strictEqual(fs.existsSync(path.join(pluginsDir, "notplugin")), false);
  // A name that would leave the plugins directory is refused.
  assert.strictEqual(
    (await clonePlugin(remote, "../escape", pluginsDir)).ok,
    false,
  );
});

test("only https GitHub repository addresses can be added", async () => {
  assert.deepStrictEqual(
    parseGithubRepoUrl("https://github.com/DuckTapeKiller/dive-ytdlp.git"),
    {
      url: "https://github.com/DuckTapeKiller/dive-ytdlp",
      cloneUrl: "https://github.com/DuckTapeKiller/dive-ytdlp.git",
      folder: "dive-ytdlp",
    },
  );
  for (const bad of [
    "http://github.com/a/b",
    "https://gitlab.com/a/b",
    "https://github.com/a",
    "https://github.com/a/b/tree/main",
    "https://user:token@github.com/a/b",
    "https://github.com/../b",
    "file:///etc",
    "not an address",
  ]) {
    assert.ok(parseGithubRepoUrl(bad).error, bad);
  }
  const refused = await installPlugin("https://gitlab.com/a/b", pluginsDir);
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(fs.existsSync(path.join(pluginsDir, "b")), false);
});

test("a repository address is shown without credentials", () => {
  assert.strictEqual(
    displayRepoUrl("https://user:secret@github.com/owner/repo.git"),
    "https://github.com/owner/repo",
  );
  assert.strictEqual(
    displayRepoUrl("git@github.com:owner/repo.git"),
    "https://github.com/owner/repo",
  );
});
