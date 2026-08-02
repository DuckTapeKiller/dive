const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  NON_PI_MODES,
  requireNonPiMode,
  loadSkillsConfig,
  saveSkillsConfig,
  loadCustomSkills,
  saveCustomSkills,
} = require("../mode-state.js");

const defaults = () => ({
  calculator: true,
  wikipedia: true,
  shell_command: false,
});

test("mode state migrates legacy definitions without sharing later edits", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dive-mode-state-"));
  const legacySkills = path.join(dataDir, "skills_config.json");
  const legacyCustom = path.join(dataDir, "custom_skills.json");
  try {
    fs.writeFileSync(
      legacySkills,
      JSON.stringify({ calculator: false, wikipedia: true }),
    );
    const legacySkill = {
      name: "legacy_tool",
      description: "Legacy tool",
      type: "javascript",
      code: "return 'legacy';",
    };
    fs.writeFileSync(legacyCustom, JSON.stringify([legacySkill]));

    const ollama = loadSkillsConfig({
      dataDir,
      mode: "ollama",
      legacyPath: legacySkills,
      defaults,
    });
    const cloud = loadSkillsConfig({
      dataDir,
      mode: "cloud",
      legacyPath: legacySkills,
      defaults,
    });
    assert.equal(ollama.calculator, false);
    assert.equal(cloud.calculator, false);

    saveSkillsConfig({
      dataDir,
      mode: "cloud",
      config: { calculator: true },
      defaults,
    });
    assert.equal(
      loadSkillsConfig({
        dataDir,
        mode: "cloud",
        legacyPath: legacySkills,
        defaults,
      }).calculator,
      true,
    );
    assert.equal(
      loadSkillsConfig({
        dataDir,
        mode: "ollama",
        legacyPath: legacySkills,
        defaults,
      }).calculator,
      false,
    );

    const ollamaCustom = loadCustomSkills({
      dataDir,
      mode: "ollama",
      legacyPath: legacyCustom,
    });
    const cloudCustom = loadCustomSkills({
      dataDir,
      mode: "cloud",
      legacyPath: legacyCustom,
    });
    assert.deepEqual(ollamaCustom, [legacySkill]);
    assert.deepEqual(cloudCustom, [legacySkill]);

    saveCustomSkills({
      dataDir,
      mode: "cloud",
      skills: [{ ...legacySkill, name: "cloud_only_tool" }],
    });
    assert.deepEqual(
      loadCustomSkills({
        dataDir,
        mode: "cloud",
        legacyPath: legacyCustom,
      }).map((skill) => skill.name),
      ["cloud_only_tool"],
    );
    assert.deepEqual(
      loadCustomSkills({
        dataDir,
        mode: "ollama",
        legacyPath: legacyCustom,
      }).map((skill) => skill.name),
      ["legacy_tool"],
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("only supported non-Pi modes can own mode state", () => {
  assert.deepEqual(NON_PI_MODES, ["ollama", "cloud", "lmstudio", "llamacpp"]);
  assert.equal(requireNonPiMode("cloud"), "cloud");
  assert.equal(requireNonPiMode(undefined), "ollama");
  assert.throws(
    () => requireNonPiMode("pi"),
    (error) => error && error.statusCode === 400,
  );
});
