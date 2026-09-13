// Agent Skills discovery, parsing and activation (agent-skills.js).
//
// The fixtures copy the frontmatter styles real skills use — a block-scalar
// description (blader/humanizer), a double-quoted one with colons (a Claude
// skill), a plain one with metadata (a pi skill) — plus the malformed cases the
// Agent Skills integration guide says a client must tolerate or reject.
//
// Everything runs inside a temporary data directory and a temporary HOME, so
// the scan never sees ~/dive/skills or ~/.agents/skills.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dive-agent-skills-"));
const DATA = path.join(TMP, "data");
const HOME = path.join(TMP, "home");
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(HOME, { recursive: true });
process.env.DIVE_DATA_DIR = DATA;
process.env.HOME = HOME;

const agentSkills = require("../agent-skills.js");
const { executeSkill } = require("../skills.js");

const DIVE_SKILLS = path.join(DATA, "skills");
const AGENTS_SKILLS = path.join(HOME, ".agents", "skills");
const OUTSIDE = path.join(TMP, "outside");

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function skillMd(frontmatter, body = "# Instructions\n\nDo the thing.") {
  return `---\n${frontmatter}\n---\n\n${body}\n`;
}

// ---- fixtures ----
write(
  path.join(DIVE_SKILLS, "block-scalar", "SKILL.md"),
  skillMd(
    [
      "name: block-scalar",
      "description: |",
      "  Rewrite text so it reads naturally.",
      "  Use when editing prose.",
      "license: MIT",
      "metadata:",
      '  version: "3.0.0"',
    ].join("\n"),
    "# Block scalar\n\nDo the thing. Read references/guide.md when asked.",
  ),
);
write(
  path.join(DIVE_SKILLS, "block-scalar", "references", "guide.md"),
  "Guide text for block-scalar.",
);
write(
  path.join(DIVE_SKILLS, "block-scalar", "scripts", "run.sh"),
  "#!/bin/sh\necho run\n",
);
write(path.join(OUTSIDE, "secret.txt"), "outside the skill folder");
fs.symlinkSync(
  path.join(OUTSIDE, "secret.txt"),
  path.join(DIVE_SKILLS, "block-scalar", "references", "escape.md"),
);
write(
  path.join(DIVE_SKILLS, "block-scalar", "assets", "image.bin"),
  Buffer.from([0x89, 0x50, 0x00, 0x47, 0x00]),
);

write(
  path.join(AGENTS_SKILLS, "quoted", "SKILL.md"),
  skillMd(
    'name: quoted\ndescription: "Proofread Spanish: <accents> & punctuation. Use when: reviewing Spanish."',
  ),
);
write(
  path.join(AGENTS_SKILLS, "colon-plain", "SKILL.md"),
  skillMd(
    "name: colon-plain\ndescription: Use this skill when: the user asks about PDFs",
  ),
);
write(
  path.join(DIVE_SKILLS, "no-description", "SKILL.md"),
  skillMd("name: no-description"),
);
write(
  path.join(DIVE_SKILLS, "broken-yaml", "SKILL.md"),
  skillMd("name: broken-yaml\ndescription: [unclosed"),
);
write(
  path.join(DIVE_SKILLS, "mismatch-folder", "SKILL.md"),
  skillMd("name: other-name\ndescription: Folder and name differ."),
);
write(
  path.join(DIVE_SKILLS, "Bad_Name", "SKILL.md"),
  skillMd("name: Bad_Name\ndescription: Breaks the naming rules."),
);
write(
  path.join(DIVE_SKILLS, "spaced", "SKILL.md"),
  skillMd("name: has space\ndescription: Cannot be typed after /skill:."),
);
write(
  path.join(AGENTS_SKILLS, "block-scalar-copy", "SKILL.md"),
  skillMd(
    "name: block-scalar\ndescription: A second skill with the same name.",
  ),
);
write(
  path.join(DIVE_SKILLS, "group", "inner", "nested-skill", "SKILL.md"),
  skillMd("name: nested-skill\ndescription: Found inside grouping folders."),
);
write(
  path.join(DIVE_SKILLS, "node_modules", "hidden-skill", "SKILL.md"),
  skillMd("name: hidden-skill\ndescription: Must not be scanned."),
);
write(
  path.join(DIVE_SKILLS, ".git", "git-skill", "SKILL.md"),
  skillMd("name: git-skill\ndescription: Must not be scanned."),
);
write(
  path.join(DIVE_SKILLS, "SKILL.md"),
  skillMd("name: root-file\ndescription: A SKILL.md directly in a root."),
);
write(
  path.join(DIVE_SKILLS, "manual-only", "SKILL.md"),
  skillMd(
    "name: manual-only\ndescription: Only the user activates this.\ndisable-model-invocation: true",
  ),
);
write(
  path.join(DIVE_SKILLS, "crlf-bom", "SKILL.md"),
  "\uFEFF---\r\nname: crlf-bom\r\ndescription: Windows line endings\r\n---\r\nBody with CRLF\r\n",
);
write(
  path.join(OUTSIDE, "linked-skill", "SKILL.md"),
  skillMd("name: linked-skill\ndescription: Reached through a symlink."),
);
fs.symlinkSync(
  path.join(OUTSIDE, "linked-skill"),
  path.join(AGENTS_SKILLS, "linked-skill"),
);
// A loop back to the root must not hang the scan.
fs.symlinkSync(AGENTS_SKILLS, path.join(AGENTS_SKILLS, "loop"));
write(
  path.join(TMP, "claude-skills", "claude-style", "SKILL.md"),
  skillMd(
    "name: claude-style\ndescription: Lives in a folder added through skill-paths.json.",
  ),
);
write(
  path.join(TMP, "single-skill", "SKILL.md"),
  skillMd("name: single-skill\ndescription: A configured path to one skill."),
);
write(
  path.join(DATA, "skill-paths.json"),
  JSON.stringify({
    paths: [
      path.join(TMP, "claude-skills"),
      path.join(TMP, "single-skill"),
      path.join(TMP, "does-not-exist"),
    ],
  }),
);

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function scan() {
  return agentSkills.scanAgentSkills({ force: true });
}

function byName(name) {
  return scan().skills.find((skill) => skill.name === name);
}

function diagnosticsFor(fragment) {
  return scan().diagnostics.filter((item) => item.location.includes(fragment));
}

test("discovers skills in Dive's folder, ~/.agents/skills and configured paths", () => {
  const names = scan().skills.map((skill) => skill.name);
  for (const expected of [
    "block-scalar",
    "quoted",
    "colon-plain",
    "other-name",
    "Bad_Name",
    "nested-skill",
    "manual-only",
    "crlf-bom",
    "linked-skill",
    "claude-style",
    "single-skill",
  ]) {
    assert.ok(names.includes(expected), `expected ${expected} in ${names}`);
  }
  for (const excluded of [
    "hidden-skill",
    "git-skill",
    "root-file",
    "no-description",
    "broken-yaml",
    "has space",
  ]) {
    assert.ok(!names.includes(excluded), `${excluded} must not load`);
  }
  assert.strictEqual(
    names.filter((name) => name === "block-scalar").length,
    1,
    "a name loads once",
  );
  const sources = Object.fromEntries(
    scan().skills.map((skill) => [skill.name, skill.source]),
  );
  assert.strictEqual(sources["block-scalar"], "dive");
  assert.strictEqual(sources.quoted, "agents");
  assert.strictEqual(sources["claude-style"], "configured");
});

test("parses the frontmatter styles other clients write", () => {
  assert.strictEqual(
    byName("block-scalar").description,
    "Rewrite text so it reads naturally.\nUse when editing prose.",
  );
  assert.strictEqual(
    byName("quoted").description,
    "Proofread Spanish: <accents> & punctuation. Use when: reviewing Spanish.",
  );
  assert.strictEqual(
    byName("colon-plain").description,
    "Use this skill when: the user asks about PDFs",
  );
  assert.ok(
    byName("colon-plain").warnings.some((w) => w.includes("colons")),
    "the colon repair is reported",
  );
  assert.strictEqual(byName("crlf-bom").description, "Windows line endings");
  assert.strictEqual(byName("manual-only").modelInvocable, false);
  assert.strictEqual(byName("block-scalar").modelInvocable, true);
});

test("reports what it could not load, and loads what the guide says to tolerate", () => {
  assert.ok(
    diagnosticsFor("no-description").some(
      (d) => d.level === "error" && d.message.includes("description"),
    ),
  );
  assert.ok(
    diagnosticsFor("broken-yaml").some(
      (d) => d.level === "error" && d.message.includes("not valid YAML"),
    ),
  );
  assert.ok(
    diagnosticsFor("spaced").some((d) => d.level === "error"),
    "a name with spaces is rejected",
  );
  assert.ok(
    byName("other-name").warnings.some((w) => w.includes("does not match")),
  );
  assert.ok(
    byName("Bad_Name").warnings.some((w) => w.includes("naming rules")),
  );
  assert.ok(
    diagnosticsFor("block-scalar-copy").some((d) =>
      d.message.includes("already found"),
    ),
    "the shadowed duplicate is reported",
  );
  assert.ok(
    diagnosticsFor("does-not-exist").some((d) => d.level === "warning"),
    "a missing configured folder is reported",
  );
});

test("the first root wins a name collision", () => {
  assert.ok(byName("block-scalar").location.startsWith(DIVE_SKILLS));
});

test("a mode's snapshot honours skill:<name> toggles", () => {
  scan();
  const names = agentSkills
    .getAgentSkillSnapshot({ "skill:quoted": false, "skill:crlf-bom": true })
    .map((skill) => skill.name);
  assert.ok(!names.includes("quoted"));
  assert.ok(names.includes("crlf-bom"));
  assert.ok(names.includes("block-scalar"));
  assert.strictEqual(agentSkills.skillConfigKey("quoted"), "skill:quoted");
  assert.ok(agentSkills.isAgentSkillConfigKey("skill:quoted"));
  assert.ok(!agentSkills.isAgentSkillConfigKey("skill:"));
  assert.ok(!agentSkills.isAgentSkillConfigKey("calculator"));
});

test("the catalogue lists model-invocable skills only, with escaped text", () => {
  scan();
  const snapshot = agentSkills.getAgentSkillSnapshot({});
  const prompt = agentSkills.buildAgentSkillsPrompt(snapshot);
  assert.ok(prompt.startsWith("### AGENT SKILLS"));
  assert.ok(prompt.includes("<name>block-scalar</name>"));
  assert.ok(!prompt.includes("manual-only"));
  assert.ok(prompt.includes("&lt;accents&gt; &amp; punctuation"));
  assert.ok(!prompt.includes("<call:"), "native mode needs no XML example");
  const xml = agentSkills.buildAgentSkillsPrompt(snapshot, {
    nativeToolCalling: false,
  });
  assert.ok(xml.includes("<call:activate_skill>"));
});

test("nothing is offered when no skill is enabled", () => {
  assert.strictEqual(agentSkills.buildAgentSkillsPrompt([]), "");
  assert.strictEqual(agentSkills.getActivateSkillToolDef([]), null);
  assert.strictEqual(
    agentSkills.executeActivateSkill({ name: "block-scalar" }, []),
    "Error: no Agent Skills are enabled for this mode.",
  );
});

test("the tool definition enumerates the enabled skills", () => {
  scan();
  const snapshot = agentSkills.getAgentSkillSnapshot({ "skill:quoted": false });
  const def = agentSkills.getActivateSkillToolDef(snapshot);
  assert.strictEqual(def.function.name, "activate_skill");
  assert.deepStrictEqual(
    def.function.parameters.properties.name.enum,
    snapshot.map((skill) => skill.name),
  );
  assert.deepStrictEqual(def.function.parameters.required, ["name"]);
});

test("activation returns the body, the skill folder and its files", () => {
  scan();
  const snapshot = agentSkills.getAgentSkillSnapshot({});
  const result = agentSkills.executeActivateSkill(
    { name: "block-scalar" },
    snapshot,
  );
  assert.ok(result.startsWith('<skill_content name="block-scalar">'));
  assert.ok(result.includes("Do the thing."));
  assert.ok(!result.includes("license: MIT"), "frontmatter is stripped");
  assert.ok(
    result.includes(
      `Skill directory: ${path.join(DIVE_SKILLS, "block-scalar")}`,
    ),
  );
  assert.ok(result.includes("<file>references/guide.md</file>"));
  assert.ok(result.includes("<file>scripts/run.sh</file>"));
  assert.ok(!result.includes("<file>SKILL.md</file>"));
  assert.ok(result.trimEnd().endsWith("</skill_content>"));
  const noFiles = agentSkills.executeActivateSkill(
    { name: "quoted" },
    snapshot,
  );
  assert.ok(noFiles.includes("This skill has no bundled files."));
  assert.ok(
    agentSkills
      .executeActivateSkill({ name: "BLOCK-SCALAR" }, snapshot)
      .startsWith("<skill_content"),
    "names match case-insensitively as a fallback",
  );
  assert.ok(
    agentSkills
      .executeActivateSkill({ name: "missing" }, snapshot)
      .startsWith('Error: there is no enabled skill named "missing"'),
  );
});

test("bundled files load, and nothing outside the skill folder does", () => {
  scan();
  const snapshot = agentSkills.getAgentSkillSnapshot({});
  const read = (file) =>
    agentSkills.executeActivateSkill({ name: "block-scalar", file }, snapshot);
  const guide = read("references/guide.md");
  assert.ok(
    guide.startsWith(
      '<skill_file skill="block-scalar" path="references/guide.md">',
    ),
  );
  assert.ok(guide.includes("Guide text for block-scalar."));
  assert.ok(read("./references/../references/guide.md").includes("Guide text"));
  assert.match(read("../quoted/SKILL.md"), /^Error: .*outside the folder/);
  assert.match(
    read("../mismatch-folder/SKILL.md"),
    /^Error: .*outside the folder/,
    "an existing sibling is refused the same way as a missing one",
  );
  assert.match(read(path.join(OUTSIDE, "secret.txt")), /^Error: .*absolute/);
  assert.match(read("references/escape.md"), /^Error: .*outside the folder/);
  assert.match(read("references/missing.md"), /^Error: .*has no file/);
  assert.match(read("assets/image.bin"), /^Error: .*binary/);
  assert.match(read("references"), /^Error: .*not a file/);
});

test("body edits show up on the next activation", () => {
  scan();
  const snapshot = agentSkills.getAgentSkillSnapshot({});
  const file = path.join(DIVE_SKILLS, "crlf-bom", "SKILL.md");
  const original = fs.readFileSync(file);
  try {
    fs.writeFileSync(
      file,
      "---\nname: crlf-bom\ndescription: Windows line endings\n---\nEdited body\n",
    );
    assert.ok(
      agentSkills
        .executeActivateSkill({ name: "crlf-bom" }, snapshot)
        .includes("Edited body"),
    );
  } finally {
    fs.writeFileSync(file, original);
  }
});

test("large content is paged at line breaks, deterministically", () => {
  const line = "x".repeat(99) + "\n";
  const text = line.repeat(Math.ceil((agentSkills.PART_CHARS * 2.5) / 100));
  const parts = agentSkills.splitIntoParts(text);
  assert.strictEqual(parts.join(""), text);
  assert.ok(parts.length === 3, `expected 3 parts, got ${parts.length}`);
  for (const part of parts) {
    assert.ok(part.length <= agentSkills.PART_CHARS);
  }
  write(
    path.join(DIVE_SKILLS, "big-skill", "SKILL.md"),
    skillMd("name: big-skill\ndescription: A very long skill.", text),
  );
  scan();
  const snapshot = agentSkills.getAgentSkillSnapshot({});
  const first = agentSkills.executeActivateSkill(
    { name: "big-skill" },
    snapshot,
  );
  assert.ok(first.includes("[Part 1 of 3."));
  assert.ok(first.includes('{"name":"big-skill","part":2}'));
  const last = agentSkills.executeActivateSkill(
    { name: "big-skill", part: 3 },
    snapshot,
  );
  assert.ok(last.includes("[Part 3 of 3. This is the last part.]"));
  assert.match(
    agentSkills.executeActivateSkill({ name: "big-skill", part: 4 }, snapshot),
    /^Error: part 4 does not exist/,
  );
  assert.match(
    agentSkills.executeActivateSkill(
      { name: "big-skill", part: "two" },
      snapshot,
    ),
    /^Error: part must be a whole number/,
  );
});

test("/skill:<name> expands to the skill followed by the user's text", () => {
  scan();
  const snapshot = agentSkills.getAgentSkillSnapshot({});
  const command = agentSkills.resolveSkillCommand(
    "/skill:block-scalar  Please rewrite this.\nSecond line.",
    snapshot,
  );
  assert.strictEqual(command.name, "block-scalar");
  assert.strictEqual(command.args, "Please rewrite this.\nSecond line.");
  assert.ok(command.message.startsWith('<skill_content name="block-scalar">'));
  assert.ok(
    command.message.endsWith("User: Please rewrite this.\nSecond line."),
  );
  const bare = agentSkills.resolveSkillCommand("/skill:manual-only", snapshot);
  assert.ok(bare.message.endsWith("</skill_content>"), "no args, no User line");
  assert.strictEqual(
    agentSkills.resolveSkillCommand("rewrite /skill:block-scalar", snapshot),
    null,
  );
  assert.strictEqual(
    agentSkills.resolveSkillCommand("/wiki x", snapshot),
    null,
  );
  const unknown = agentSkills.resolveSkillCommand("/skill:nope hi", snapshot);
  assert.match(unknown.error, /no enabled skill named "nope"/);
  assert.match(unknown.error, /Enabled skills: .*block-scalar/);
  assert.match(
    agentSkills.resolveSkillCommand("/skill: hi", snapshot).error,
    /Type the skill name/,
  );
  assert.match(
    agentSkills.resolveSkillCommand("/skill:quoted hi", [
      ...snapshot.filter((skill) => skill.name !== "quoted"),
    ]).error,
    /no enabled skill named "quoted"/,
    "a disabled skill cannot be activated",
  );
});

test("history keeps earlier /skill: turns expanded", () => {
  scan();
  const snapshot = agentSkills.getAgentSkillSnapshot({});
  const history = [
    { role: "user", content: "/skill:block-scalar first text" },
    { role: "assistant", content: "/skill:block-scalar is what you typed" },
    { role: "user", content: "/skill:nope unknown stays as typed" },
    { role: "user", content: "plain turn" },
  ];
  const expanded = agentSkills.expandSkillCommandsInHistory(history, snapshot);
  assert.ok(expanded[0].content.includes("<skill_content"));
  assert.ok(expanded[0].content.endsWith("User: first text"));
  assert.strictEqual(expanded[1], history[1]);
  assert.strictEqual(expanded[2], history[2]);
  assert.strictEqual(expanded[3], history[3]);
  assert.strictEqual(
    history[0].content,
    "/skill:block-scalar first text",
    "the input is not mutated",
  );
});

test("executeSkill routes activate_skill to the request's snapshot", async () => {
  scan();
  const snapshot = agentSkills.getAgentSkillSnapshot({});
  const call = (args, context) =>
    executeSkill(
      {
        function: { name: "activate_skill", arguments: JSON.stringify(args) },
      },
      context,
    );
  assert.ok(
    (
      await call({ name: "block-scalar" }, { agentSkills: snapshot })
    ).startsWith('<skill_content name="block-scalar">'),
  );
  assert.strictEqual(
    await call({ name: "block-scalar" }, {}),
    "Error: no Agent Skills are enabled for this mode.",
  );
});

test("configured folders are validated and saved", () => {
  assert.throws(
    () => agentSkills.saveConfiguredSkillPaths(["relative/folder"]),
    (error) => error.statusCode === 400 && /absolute/.test(error.message),
  );
  assert.throws(
    () => agentSkills.saveConfiguredSkillPaths("~/not-an-array"),
    (error) => error.statusCode === 400,
  );
  const previous = fs.readFileSync(path.join(DATA, "skill-paths.json"), "utf8");
  try {
    const saved = agentSkills.saveConfiguredSkillPaths([
      " ~/skills-a ",
      "/abs/skills-b",
      "~/skills-a",
      "",
    ]);
    assert.deepStrictEqual(saved, ["~/skills-a", "/abs/skills-b"]);
    assert.deepStrictEqual(agentSkills.readConfiguredSkillPaths().paths, saved);
    const roots = scan().roots.map((root) => root.path);
    assert.ok(roots.includes(path.join(HOME, "skills-a")), "~ is expanded");
  } finally {
    fs.writeFileSync(path.join(DATA, "skill-paths.json"), previous);
  }
});

test("describeAgentSkills reports roots, paths, skills and toggles", () => {
  const payload = agentSkills.describeAgentSkills(
    { "skill:quoted": false },
    { force: true },
  );
  assert.strictEqual(payload.directory, DIVE_SKILLS);
  assert.ok(payload.roots.some((root) => root.source === "agents"));
  assert.strictEqual(payload.paths.length, 3);
  const quoted = payload.skills.find((skill) => skill.name === "quoted");
  assert.strictEqual(quoted.enabled, false);
  assert.strictEqual(
    payload.skills.find((skill) => skill.name === "block-scalar").enabled,
    true,
  );
  assert.ok(!("realBaseDir" in quoted), "internal fields stay server-side");
  assert.ok(payload.diagnostics.length > 0);
});
