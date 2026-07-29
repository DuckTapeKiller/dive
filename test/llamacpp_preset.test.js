const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const preset = require("../routes/llamacpp-preset.js");

// Each case gets a throwaway models folder, because the generator stats every
// model and projector path before writing a section for it.
function makeDir(files = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dive-preset-"));
  for (const name of files) fs.writeFileSync(path.join(dir, name), "x");
  return dir;
}

function model(file, extra = {}) {
  return {
    file,
    ctx: 4096,
    gpuLayers: 99,
    maxCtx: 0,
    embedding: false,
    isProjector: false,
    ...extra,
  };
}

function plan(dir, kind, models, text, exclude = new Set()) {
  const filePath = path.join(dir, `preset-${kind}.ini`);
  if (text !== undefined) fs.writeFileSync(filePath, text);
  return preset.planPreset({
    filePath,
    kind,
    models,
    modelsDir: dir,
    exclude,
  });
}

test("embedding models each get a section in the managed block", () => {
  const dir = makeDir(["bge-m3.gguf"]);
  const result = plan(dir, "embed", [
    model("bge-m3.gguf", { embedding: true }),
  ]);
  assert.ok(result.changed);
  assert.deepStrictEqual(result.managed, ["bge-m3"]);
  assert.match(result.after, /\[bge-m3\]/);
  assert.match(result.after, /embeddings = true/);
  assert.match(result.after, new RegExp(`model = ${dir}/bge-m3\\.gguf`));
});

test("a plain chat model gets a section — --models-dir only scans at startup", () => {
  // Regression: a model downloaded after the router booted is invisible to
  // --models-dir, so loading it fails with "not registered in the external
  // llama-server". Every chat model needs an explicit section.
  const dir = makeDir(["Bonsai-27B-dspark-bf16.gguf"]);
  const result = plan(dir, "chat", [model("Bonsai-27B-dspark-bf16.gguf")]);
  assert.deepStrictEqual(result.managed, ["Bonsai-27B-dspark-bf16"]);
  assert.match(result.after, /\[Bonsai-27B-dspark-bf16\]/);
  assert.match(
    result.after,
    new RegExp(`model = ${dir}/Bonsai-27B-dspark-bf16\\.gguf`),
  );
  assert.ok(
    result.changed,
    "the preset changes, which is what triggers a restart",
  );
});

test("a vision model gets a section pairing its projector", () => {
  const dir = makeDir(["vlm.gguf", "mmproj-vlm.gguf"]);
  const result = plan(dir, "chat", [
    model("vlm.gguf", { projector: "mmproj-vlm.gguf" }),
    model("mmproj-vlm.gguf", { isProjector: true, arch: "clip" }),
  ]);
  assert.deepStrictEqual(result.managed, ["vlm"]);
  assert.match(result.after, new RegExp(`mmproj = ${dir}/mmproj-vlm\\.gguf`));
});

test("a missing projector costs the mmproj line, not the whole model", () => {
  // A dangling mmproj path is fatal to that model, but the model itself is
  // still loadable as text — dropping its section entirely would make it
  // unloadable for no reason.
  const dir = makeDir(["vlm.gguf"]); // projector deliberately absent
  const result = plan(dir, "chat", [
    model("vlm.gguf", { projector: "mmproj-vlm.gguf" }),
  ]);
  assert.deepStrictEqual(result.managed, ["vlm"]);
  assert.doesNotMatch(result.after, /mmproj/);
  assert.strictEqual(result.skipped[0].reason, "projector missing");
});

test("hand-written content outside the block survives verbatim", () => {
  const dir = makeDir(["bge-m3.gguf"]);
  const original = [
    "; my careful notes",
    "; WARNING: do not break this",
    "",
    "[*]",
    "ctx-size = 0",
    "sleep-idle-seconds = 3600",
    "",
    "[hand-written]",
    "model = /elsewhere/other.gguf",
    "",
  ].join("\n");
  const result = plan(
    dir,
    "embed",
    [model("bge-m3.gguf", { embedding: true })],
    original,
  );
  assert.match(result.after, /; my careful notes/);
  assert.match(result.after, /; WARNING: do not break this/);
  assert.match(
    result.after,
    /\[hand-written\]\nmodel = \/elsewhere\/other\.gguf/,
  );
  assert.match(result.after, /\[bge-m3\]/);
});

test("an existing section name is never re-created", () => {
  const dir = makeDir(["nomic-embed.gguf"]);
  const original = [
    "[nomic-embed]",
    `model = ${path.join(dir, "nomic-embed.gguf")}`,
    "",
  ].join("\n");
  const result = plan(
    dir,
    "embed",
    [model("nomic-embed.gguf", { embedding: true })],
    original,
  );
  assert.deepStrictEqual(result.managed, []);
  assert.strictEqual(result.skipped[0].reason, "section already in the file");
});

test("a model already referenced under a different alias is left alone", () => {
  // The real hazard: generating [nomic-embed-text-v2-moe.f16] beside a
  // hand-written [text-embedding-...] pointing at the same file would make the
  // router advertise one file as two models, and orphan the vector index.
  const dir = makeDir(["nomic-embed-text-v2-moe.f16.gguf"]);
  const original = [
    "[text-embedding-nomic-embed-text-v2-moe]",
    `model = ${path.join(dir, "nomic-embed-text-v2-moe.f16.gguf")}`,
    "embeddings = true",
    "",
  ].join("\n");
  const result = plan(
    dir,
    "embed",
    [model("nomic-embed-text-v2-moe.f16.gguf", { embedding: true })],
    original,
  );
  assert.deepStrictEqual(result.managed, []);
  assert.strictEqual(result.skipped[0].reason, "file already has a section");
  assert.match(result.after, /\[text-embedding-nomic-embed-text-v2-moe\]/);
});

test("a section Dive wrote disappears once its model is gone", () => {
  const dir = makeDir(["bge-m3.gguf", "e5-small.gguf"]);
  const first = plan(dir, "embed", [
    model("bge-m3.gguf", { embedding: true }),
    model("e5-small.gguf", { embedding: true }),
  ]);
  preset.commitPlan(first);
  fs.rmSync(path.join(dir, "e5-small.gguf"));
  const second = plan(dir, "embed", [
    model("bge-m3.gguf", { embedding: true }),
  ]);
  assert.match(second.after, /\[bge-m3\]/);
  assert.doesNotMatch(second.after, /\[e5-small\]/);
});

test("exclude drops a model before its file is deleted", () => {
  const dir = makeDir(["bge-m3.gguf"]);
  const first = plan(dir, "embed", [model("bge-m3.gguf", { embedding: true })]);
  preset.commitPlan(first);
  // Same models list, but the file is about to go: the section must come out
  // first so the router is never pointed at a path that stops existing.
  const second = plan(
    dir,
    "embed",
    [model("bge-m3.gguf", { embedding: true })],
    undefined,
    new Set(["bge-m3.gguf"]),
  );
  assert.doesNotMatch(second.after, /\[bge-m3\]/);
});

test("`[*]` globals are copied into generated sections", () => {
  // A named section may replace the globals rather than merge with them, so
  // omitting them would silently change how the model runs.
  const dir = makeDir(["vlm.gguf", "mmproj-vlm.gguf"]);
  const original = [
    "[*]",
    "ctx-size = 0",
    "n-gpu-layers = 99",
    "jinja = true",
    "sleep-idle-seconds = 3600",
    "",
  ].join("\n");
  const result = plan(
    dir,
    "chat",
    [
      model("vlm.gguf", { projector: "mmproj-vlm.gguf" }),
      model("mmproj-vlm.gguf", { isProjector: true }),
    ],
    original,
  );
  for (const line of [
    "ctx-size = 0",
    "n-gpu-layers = 99",
    "jinja = true",
    "sleep-idle-seconds = 3600",
  ]) {
    assert.ok(result.after.includes(line), `missing ${line}`);
  }
});

test("house style is learned when a file has no [*] section", () => {
  const dir = makeDir(["bge-m3.gguf", "other.gguf"]);
  const original = [
    "[other]",
    `model = ${path.join(dir, "other.gguf")}`,
    "sleep-idle-seconds = 3600",
    "embeddings = true",
    "",
  ].join("\n");
  const result = plan(
    dir,
    "embed",
    [model("bge-m3.gguf", { embedding: true })],
    original,
  );
  assert.match(result.after, /\[bge-m3\][\s\S]*sleep-idle-seconds = 3600/);
});

test("jinja is never copied onto an embedding section", () => {
  const dir = makeDir(["bge-m3.gguf"]);
  const original = ["[*]", "jinja = true", "sleep-idle-seconds = 60", ""].join(
    "\n",
  );
  const result = plan(
    dir,
    "embed",
    [model("bge-m3.gguf", { embedding: true })],
    original,
  );
  // Assert on the generated block only: the user's own `[*] jinja = true`
  // stays in the file untouched, which is the whole point of the block.
  const block = preset.splitManagedBlock(result.after).managed.join("\n");
  assert.doesNotMatch(block, /jinja/);
  assert.match(block, /sleep-idle-seconds = 60/);
  assert.match(result.after, /\[\*\]\njinja = true/);
});

test("an embedding model is capped at its trained context", () => {
  const dir = makeDir(["nomic.gguf"]);
  const result = plan(dir, "embed", [
    model("nomic.gguf", { embedding: true, ctx: 4096, maxCtx: 512 }),
  ]);
  assert.match(result.after, /ctx-size = 512/);
});

test("a second sync with no changes rewrites nothing", () => {
  const dir = makeDir(["bge-m3.gguf"]);
  const first = plan(dir, "embed", [model("bge-m3.gguf", { embedding: true })]);
  preset.commitPlan(first);
  const second = plan(dir, "embed", [
    model("bge-m3.gguf", { embedding: true }),
  ]);
  assert.strictEqual(second.changed, false);
  assert.strictEqual(preset.commitPlan(second).written, false);
});

test("the first write leaves a backup, later writes do not overwrite it", () => {
  const dir = makeDir(["bge-m3.gguf", "e5-small.gguf"]);
  const filePath = path.join(dir, "preset-embed.ini");
  const original = "; original\n";
  fs.writeFileSync(filePath, original);
  const first = plan(dir, "embed", [model("bge-m3.gguf", { embedding: true })]);
  const firstResult = preset.commitPlan(first);
  assert.strictEqual(firstResult.backup, `${filePath}.dive-backup`);
  assert.strictEqual(fs.readFileSync(firstResult.backup, "utf8"), original);
  const second = plan(dir, "embed", [
    model("bge-m3.gguf", { embedding: true }),
    model("e5-small.gguf", { embedding: true }),
  ]);
  const secondResult = preset.commitPlan(second);
  assert.strictEqual(secondResult.backup, "");
  assert.strictEqual(
    fs.readFileSync(`${filePath}.dive-backup`, "utf8"),
    original,
  );
});

test("stale hand-written sections are reported, never removed", () => {
  const dir = makeDir([]);
  const original = [
    "[gone-model]",
    "model = /Users/someone/models/gone-model.gguf",
    "",
  ].join("\n");
  const result = plan(dir, "chat", [], original);
  assert.strictEqual(result.stale.length, 1);
  assert.strictEqual(result.stale[0].section, "gone-model");
  assert.match(result.after, /\[gone-model\]/);
});

test("a file with nothing to manage is not touched at all", () => {
  // Enabling sync on a preset where every model is already hand-written must
  // not stamp an empty block (and a .dive-backup) onto it.
  const dir = makeDir(["nomic.gguf"]);
  const original = [
    "; hand-written, nothing for Dive to add",
    "[nomic]",
    `model = ${path.join(dir, "nomic.gguf")}`,
    "",
  ].join("\n");
  const result = plan(
    dir,
    "embed",
    [model("nomic.gguf", { embedding: true })],
    original,
  );
  assert.strictEqual(result.changed, false);
  assert.strictEqual(result.after, original);
  assert.doesNotMatch(result.after, /dive-managed/);
});

test("an existing block is still emptied when its last model goes", () => {
  const dir = makeDir(["bge-m3.gguf"]);
  const first = plan(dir, "embed", [model("bge-m3.gguf", { embedding: true })]);
  preset.commitPlan(first);
  fs.rmSync(path.join(dir, "bge-m3.gguf"));
  const second = plan(dir, "embed", []);
  assert.ok(second.changed);
  assert.doesNotMatch(second.after, /\[bge-m3\]/);
  assert.match(second.after, /dive-managed/);
});

test("a missing preset file is created containing only the block", () => {
  const dir = makeDir(["bge-m3.gguf"]);
  const result = plan(dir, "embed", [
    model("bge-m3.gguf", { embedding: true }),
  ]);
  assert.strictEqual(result.existed, false);
  preset.commitPlan(result);
  const written = fs.readFileSync(path.join(dir, "preset-embed.ini"), "utf8");
  assert.match(written, /dive-managed/);
  assert.match(written, /\[bge-m3\]/);
});

test("a truncated block is reclaimed rather than duplicated", () => {
  const dir = makeDir(["bge-m3.gguf"]);
  const original = [
    "; kept",
    preset.BLOCK_START,
    "[half-written]",
    "model = /x.gguf",
  ].join("\n");
  const result = plan(
    dir,
    "embed",
    [model("bge-m3.gguf", { embedding: true })],
    original,
  );
  assert.match(result.after, /; kept/);
  assert.doesNotMatch(result.after, /half-written/);
  assert.strictEqual(result.after.match(/dive-managed/g).length, 2);
});

test("split-model siblings and projectors never become embed sections", () => {
  const dir = makeDir(["mmproj-vlm.gguf"]);
  const result = plan(dir, "embed", [
    model("mmproj-vlm.gguf", { isProjector: true, embedding: true }),
  ]);
  assert.deepStrictEqual(result.managed, []);
});

test("a hand-written section is removed once its model file is gone", () => {
  // The rule that makes delete mean delete: ownership is by location, so a
  // section pointing into the models folder goes when its file does — even
  // though Dive never wrote it.
  const dir = makeDir(["keep.gguf"]);
  const original = [
    "[*]",
    "ctx-size = 0",
    "",
    "[gone-model]",
    `model = ${path.join(dir, "gone-model.gguf")}`,
    "ctx-size = 32768",
    "",
    "[keep]",
    `model = ${path.join(dir, "keep.gguf")}`,
    "",
  ].join("\n");
  const result = plan(dir, "chat", [model("keep.gguf")], original);
  assert.ok(result.changed);
  assert.doesNotMatch(result.after, /\[gone-model\]/);
  assert.doesNotMatch(result.after, /gone-model\.gguf/);
  assert.match(result.after, /\[keep\]/);
  assert.match(result.after, /\[\*\]\nctx-size = 0/);
  assert.deepStrictEqual(
    result.removed.map((r) => r.section),
    ["gone-model"],
  );
});

test("deleting a model drops its section before the file goes", () => {
  const dir = makeDir(["doomed.gguf"]);
  const original = [
    "[doomed]",
    `model = ${path.join(dir, "doomed.gguf")}`,
    "",
  ].join("\n");
  const result = plan(
    dir,
    "chat",
    [model("doomed.gguf")],
    original,
    new Set(["doomed.gguf"]),
  );
  assert.doesNotMatch(result.after, /\[doomed\]/);
  assert.deepStrictEqual(
    result.removed.map((r) => r.section),
    ["doomed"],
  );
});

test("comments describing a removed section go with it", () => {
  const dir = makeDir([]);
  const original = [
    "; keep me — file header",
    "",
    "; this note is about the model below",
    "[gone]",
    `model = ${path.join(dir, "gone.gguf")}`,
    "",
    "; trailing note",
    "",
  ].join("\n");
  const result = plan(dir, "chat", [], original);
  assert.match(result.after, /; keep me — file header/);
  assert.doesNotMatch(result.after, /this note is about the model below/);
  assert.match(result.after, /; trailing note/);
});

test("a section pointing outside the models folder is never removed", () => {
  const dir = makeDir([]);
  const original = [
    "[elsewhere]",
    "model = /opt/other-models/thing.gguf",
    "",
  ].join("\n");
  const result = plan(dir, "chat", [], original);
  assert.match(result.after, /\[elsewhere\]/);
  assert.deepStrictEqual(result.removed, []);
  assert.deepStrictEqual(
    result.stale.map((s) => s.section),
    ["elsewhere"],
  );
});

test("removing a section takes a dated backup first", () => {
  const dir = makeDir([]);
  const filePath = path.join(dir, "preset-chat.ini");
  const original = [
    "[gone]",
    `model = ${path.join(dir, "gone.gguf")}`,
    "",
  ].join("\n");
  fs.writeFileSync(filePath, original);
  const result = preset.planPreset({
    filePath,
    kind: "chat",
    models: [],
    modelsDir: dir,
    exclude: new Set(),
  });
  preset.commitPlan(result);
  const backups = fs.readdirSync(dir).filter((f) => f.endsWith(".bak"));
  assert.strictEqual(backups.length, 1, "a dated .bak was written");
  assert.match(
    fs.readFileSync(path.join(dir, backups[0]), "utf8"),
    /\[gone\]/,
    "the backup holds the section that was removed",
  );
});

test("a preset with nothing dead is still left untouched", () => {
  const dir = makeDir(["here.gguf"]);
  const original = [
    "[here]",
    `model = ${path.join(dir, "here.gguf")}`,
    "",
  ].join("\n");
  const result = plan(dir, "chat", [model("here.gguf")], original);
  assert.strictEqual(result.changed, false);
  assert.deepStrictEqual(result.removed, []);
});

test("a projector is never registered as a chat model", () => {
  // Detection is by GGUF architecture, but a header that fails to parse would
  // leave a projector looking like an ordinary model. Registering it would
  // advertise an mmproj file as something you can chat with.
  const dir = makeDir(["mmproj-vlm-BF16.gguf", "real-model.gguf"]);
  const result = plan(dir, "chat", [
    model("mmproj-vlm-BF16.gguf"), // arch missing, isProjector unset
    model("real-model.gguf"),
  ]);
  assert.deepStrictEqual(result.managed, ["real-model"]);
  assert.doesNotMatch(result.after, /\[mmproj-vlm-BF16\]/);
});

test("a projector is never registered as an embedding model either", () => {
  const dir = makeDir(["mmproj-vlm-BF16.gguf"]);
  const result = plan(dir, "embed", [
    model("mmproj-vlm-BF16.gguf", { embedding: true }),
  ]);
  assert.deepStrictEqual(result.managed, []);
});
