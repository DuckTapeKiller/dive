const assert = require("assert");
const fs = require("fs");
const path = require("path");
const test = require("node:test");

const {
  MODES,
  MODE_DEFS,
  MODE_IDS,
  DIVE_SKILL_MODE_IDS,
  LOCAL_MODE_IDS,
  DEFAULT_ENABLED_MODES,
  modeById,
} = require("../assets/js/00-modes.js");

// These are the exact lists the codebase used before the registry existed.
// They are asserted literally rather than derived: the point is to catch a
// registry edit that silently changes storage key order or the topbar.
test("the registry reproduces every list it replaced, in order", () => {
  assert.deepStrictEqual(MODE_IDS, [
    "ollama",
    "pi",
    "cloud",
    "lmstudio",
    "llamacpp",
  ]);
  assert.deepStrictEqual(DIVE_SKILL_MODE_IDS, [
    "ollama",
    "cloud",
    "lmstudio",
    "llamacpp",
  ]);
  assert.deepStrictEqual(LOCAL_MODE_IDS, ["lmstudio", "llamacpp"]);
  assert.deepStrictEqual(DEFAULT_ENABLED_MODES, ["llamacpp", "pi", "cloud"]);
  assert.deepStrictEqual(
    MODE_DEFS.map((d) => d.id),
    ["llamacpp", "pi", "cloud", "lmstudio", "ollama"],
  );
  assert.deepStrictEqual(
    MODE_DEFS.map((d) => d.btnId),
    ["btnLlamaCpp", "btnPi", "btnCloud", "btnLmStudio", "btnOllama"],
  );
});

test("canonical order minus Pi is the Dive-skill order", () => {
  // Storage key order in persisted settings depends on this, and server.js
  // rewrites a settings file whenever its JSON differs from the sanitised form.
  assert.deepStrictEqual(
    MODE_IDS.filter((id) => id !== "pi"),
    DIVE_SKILL_MODE_IDS,
  );
});

test("Pi does not use Dive's skill loop", () => {
  // Pi runs its own agent loop in an external process, with its own skills,
  // extensions and context files, and documents that it has no MCP.
  assert.strictEqual(modeById("pi").diveSkills, false);
  assert.strictEqual(
    MODES.filter((m) => !m.diveSkills).length,
    1,
    "Pi should be the only mode outside Dive's skill loop",
  );
  assert.ok(!DIVE_SKILL_MODE_IDS.includes("pi"));
});

test("registry entries are frozen", () => {
  assert.ok(Object.isFrozen(MODES));
  assert.ok(MODES.every(Object.isFrozen));
  assert.ok(Object.isFrozen(DIVE_SKILL_MODE_IDS));
});

// Guard: the nine literals the registry replaced must not creep back.
const SEARCHED = [
  "server.js",
  "skills.js",
  "mode-state.js",
  "library/store.js",
  "routes/chat.js",
  "routes/prompts.js",
  "assets/js/00-modes.js",
  "assets/js/01-core.js",
  "assets/js/07-chat.js",
];

// server.js pins the modes that existed when the legacy default UI font was in
// use. It must stay frozen, so it is the one allowed literal.
const ALLOWED = [{ file: "server.js", literal: '["ollama", "pi", "cloud"]' }];

test("no mode list is hardcoded outside the registry", () => {
  const listPattern =
    /\[\s*"(?:ollama|pi|cloud|lmstudio|llamacpp)"(?:\s*,\s*"(?:ollama|pi|cloud|lmstudio|llamacpp)")+\s*,?\s*\]/g;
  const offenders = [];
  for (const file of SEARCHED) {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    // Collapse wrapped literals so a Prettier-split array is still caught.
    const flat = source
      .replace(/\[\s*\n\s*"/g, '["')
      .replace(/",\s*\n\s*"/g, '", "')
      .replace(/",\s*\n\s*\]/g, '"]');
    for (const match of flat.match(listPattern) || []) {
      const allowed = ALLOWED.some(
        (a) => a.file === file && a.literal === match,
      );
      // 00-modes.js is the registry itself; its object literals are the source.
      if (!allowed && file !== "assets/js/00-modes.js") {
        offenders.push(`${file}: ${match}`);
      }
    }
  }
  assert.deepStrictEqual(
    offenders,
    [],
    `hardcoded mode lists found — use the registry:\n${offenders.join("\n")}`,
  );
});
