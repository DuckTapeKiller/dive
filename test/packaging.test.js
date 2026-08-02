// Every new top-level module this session (redact.js, pi-paths.js,
// data-dir.js) and every new directory (skills/, server/) had to be added to
// THREE places or the packaged app would fail to start:
//   1. electron/main.js syncRuntimeFiles — what the app copies to its runtime
//   2. package.json build.files          — what electron-builder ships
//   3. package.json build.asarUnpack     — what stays outside the asar
//
// Each was missed at least once and caught by hand. This derives the real
// dependency graph from server.js and checks all three, so the next one is
// caught by the suite instead of by a user with a blank window.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");
const pkg = require("../package.json");
const mainSource = fs.readFileSync(
  path.join(ROOT, "electron", "main.js"),
  "utf8",
);

// Walk relative requires from server.js and collect the top-level entries the
// packaged app needs (a file like "redact.js", or a directory like "routes").
function requiredTopLevelEntries() {
  const seen = new Set();
  const entries = new Set();
  (function scan(file) {
    if (seen.has(file) || !fs.existsSync(file)) return;
    seen.add(file);
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/require\("(\.[^"]+)"\)/g)) {
      const resolved = path.normalize(path.join(path.dirname(file), match[1]));
      const target = resolved.endsWith(".js") ? resolved : `${resolved}.js`;
      const rel = path.relative(ROOT, target);
      if (rel.startsWith("..")) continue;
      entries.add(rel.split(path.sep)[0]);
      scan(target);
    }
  })(path.join(ROOT, "server.js"));
  entries.add("server.js");
  return [...entries].sort();
}

const NEEDED = requiredTopLevelEntries();

test("the dependency walk found the modules it should", () => {
  // Guards the test itself: if the walk silently found nothing, everything
  // below would pass vacuously.
  assert.ok(NEEDED.length >= 8, `only found: ${NEEDED.join(", ")}`);
  for (const expected of ["skills.js", "routes", "data-dir.js", "server"]) {
    assert.ok(NEEDED.includes(expected), `walk missed ${expected}`);
  }
});

test("electron copies every module the server requires into its runtime", () => {
  const copied = new Set(
    [...mainSource.matchAll(/path\.join\(appRoot,\s*"([^"]+)"\)/g)].map(
      (m) => m[1],
    ),
  );
  const missing = NEEDED.filter(
    (entry) => !copied.has(entry) && !copied.has(entry.replace(/\.js$/, "")),
  );
  assert.deepStrictEqual(
    missing,
    [],
    `syncRuntimeFiles does not copy: ${missing.join(", ")} — the packaged app would fail to start`,
  );
});

test("electron-builder ships every module the server requires", () => {
  const covers = (patterns, entry) =>
    patterns.some(
      (p) =>
        p === entry ||
        p === entry.replace(/\.js$/, "") ||
        p === `${entry}/**/*` ||
        p === `${entry.replace(/\.js$/, "")}/**/*`,
    );

  for (const field of ["files", "asarUnpack"]) {
    const patterns = pkg.build[field];
    assert.ok(Array.isArray(patterns), `build.${field} is missing`);
    const missing = NEEDED.filter((entry) => !covers(patterns, entry));
    assert.deepStrictEqual(
      missing,
      [],
      `build.${field} does not cover: ${missing.join(", ")}`,
    );
  }
});

test("a new top-level module would be caught, not shipped broken", () => {
  // Prove the check bites: a module the server requires but nothing packages.
  const pretend = [...NEEDED, "not-packaged-module.js"];
  const copied = new Set(
    [...mainSource.matchAll(/path\.join\(appRoot,\s*"([^"]+)"\)/g)].map(
      (m) => m[1],
    ),
  );
  const missing = pretend.filter(
    (entry) => !copied.has(entry) && !copied.has(entry.replace(/\.js$/, "")),
  );
  assert.deepStrictEqual(
    missing,
    ["not-packaged-module.js"],
    "the packaging check cannot detect an unpackaged module",
  );
});

test("dev-only directories are not shipped", () => {
  for (const field of ["files", "asarUnpack"]) {
    for (const unwanted of ["test", "scripts", "release"]) {
      assert.ok(
        !pkg.build[field].some((p) => p.startsWith(unwanted)),
        `build.${field} ships ${unwanted}/`,
      );
    }
  }
});
