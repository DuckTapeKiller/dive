const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// plugins.js reads its folder from DIVE_DATA_DIR when it is first required.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dive-plugin-rules-"));
process.env.DIVE_DATA_DIR = dataDir;
const pluginsDir = path.join(dataDir, "plugins");

function writePlugin(name, skills) {
  const dir = path.join(pluginsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "index.js"),
    `module.exports = { name: ${JSON.stringify(name)}, skills: ${skills} };`,
  );
}

writePlugin(
  "images",
  `[{
    name: "download_images",
    description: "Download images from a web address.",
    rule: "  IMAGES: when the user asks to download an image\\n and gives an address, you MUST call download_images.  ",
    async execute() { return "ok"; },
  }]`,
);
writePlugin(
  "dice",
  `[{ name: "roll_dice", description: "Roll dice.", async execute() { return "4"; } }]`,
);
writePlugin(
  "huge",
  `[{ name: "huge_rule", description: "x", rule: "y".repeat(5000), async execute() { return ""; } }]`,
);

const {
  loadPlugins,
  getPluginToolRules,
  getPluginSkillSnapshot,
  getPluginToolDefs,
} = require("../plugins.js");

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test("a plugin skill's rule reaches Dive, tidied, and only for skills that have one", () => {
  loadPlugins();
  const rules = getPluginToolRules();
  const byName = Object.fromEntries(rules.map((r) => [r.name, r.rule]));
  assert.strictEqual(
    byName.download_images,
    "IMAGES: when the user asks to download an image and gives an address, you MUST call download_images.",
  );
  assert.ok(!("roll_dice" in byName), "a skill without a rule adds none");
  assert.strictEqual(byName.huge_rule.length, 1200, "a rule is capped");
});

test("rules follow the request's snapshot, and stay out of the tool schema", () => {
  loadPlugins();
  const snapshot = getPluginSkillSnapshot().filter(
    (skill) => skill.name !== "download_images",
  );
  assert.deepStrictEqual(
    getPluginToolRules(snapshot).map((r) => r.name),
    ["huge_rule"],
  );
  // The rule is an instruction for the system prompt, not part of the
  // OpenAI function definition sent to the model server.
  for (const def of getPluginToolDefs()) {
    assert.deepStrictEqual(Object.keys(def.function).sort(), [
      "description",
      "name",
      "parameters",
    ]);
  }
});
