// Which vision adapter belongs to which model.
//
// This was decided by comparing filenames. `granite-4.2-8b-Q6_K` and
// `mmproj-gemma-4-E2B-it-BF16` share exactly one token once quant and format
// noise is stripped — the digit `4` — and one shared token counted as a match,
// so a Granite text model was launched with a Gemma vision adapter and failed
// to load at all.
//
// Two rules replace it, and both are pinned here: identity is read from the
// files (recorded download provenance, then `general.name`), and where the
// evidence does not single one adapter out, none is attached.
//
// Nothing here needs a GGUF on disk: the matcher takes header facts as data.
"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  isProjector,
  normalizeName,
  compatibilityConflict,
  pairProjectors,
} = require("../routes/llamacpp-projector.js");

// A scanned chat model, as ggufInfoFor() reports one.
function chat(file, extra = {}) {
  return { file, type: "model", arch: "llama", modelName: "", ...extra };
}

// A scanned vision adapter.
function proj(file, extra = {}) {
  return { file, type: "mmproj", arch: "clip", modelName: "", ...extra };
}

// The four files that produced the bug, with their real header values.
const GRANITE = chat("granite-4.2-8b-Q6_K.gguf", {
  arch: "granite",
  modelName: "Granite 4.2 8b",
  embedDim: 4096,
});
const GEMMA_E4B = chat("gemma-4-E4B-it-Q8_0.gguf", {
  arch: "gemma4",
  modelName: "Gemma 4 E4B",
  embedDim: 2560,
});
const MMPROJ_E2B = proj("mmproj-gemma-4-E2B-it-BF16.gguf", {
  modelName: "Gemma 4 E2B",
  projDim: 1536,
  projectorType: "gemma4v",
});
const MMPROJ_E4B = proj("mmproj-gemma-4-E4B-it-BF16.gguf", {
  modelName: "Gemma 4 E4B",
  projDim: 2560,
  projectorType: "gemma4v",
});

function pair(models, sources) {
  const out = pairProjectors(
    models.map((m) => ({ ...m })),
    sources ? { sources } : {},
  );
  const picked = {};
  const offered = {};
  for (const m of out.filter((x) => !isProjector(x))) {
    picked[m.file] = m.projector;
    offered[m.file] = m.projectorCandidates;
  }
  return { picked, offered, out };
}

// ---- The regression ----

test("a Granite model is never handed a Gemma adapter", () => {
  const { picked } = pair([GRANITE, GEMMA_E4B, MMPROJ_E2B, MMPROJ_E4B]);
  assert.strictEqual(picked["granite-4.2-8b-Q6_K.gguf"], undefined);
});

test("the right Gemma adapter is chosen, by name rather than by filename", () => {
  const { picked } = pair([GRANITE, GEMMA_E4B, MMPROJ_E2B, MMPROJ_E4B]);
  assert.strictEqual(
    picked["gemma-4-E4B-it-Q8_0.gguf"],
    "mmproj-gemma-4-E4B-it-BF16.gguf",
  );
});

test("the answer does not depend on the order the folder was read in", () => {
  const forwards = pair([GRANITE, GEMMA_E4B, MMPROJ_E2B, MMPROJ_E4B]).picked;
  const backwards = pair([MMPROJ_E4B, MMPROJ_E2B, GEMMA_E4B, GRANITE]).picked;
  assert.deepStrictEqual(forwards, backwards);
});

test("filenames carry no weight at all any more", () => {
  // Every filename says "gemma", and the adapter is named for a different
  // model. Under the old matcher the names alone would have paired these.
  const { picked } = pair([
    chat("gemma-4-E4B-it-Q8_0.gguf", {
      arch: "gemma4",
      modelName: "Gemma 4 E4B",
    }),
    proj("mmproj-gemma-4-E2B-it-BF16.gguf", { modelName: "Gemma 4 E2B" }),
  ]);
  assert.strictEqual(picked["gemma-4-E4B-it-Q8_0.gguf"], undefined);
});

test("a renamed file is still matched, because the name is read from inside", () => {
  // The case filenames cannot survive: a re-upload under a house naming scheme.
  const { picked } = pair([
    chat("my-vision-model.gguf", { arch: "gemma4", modelName: "Gemma 4 E4B" }),
    proj("adapter-01.gguf", { modelName: "Gemma 4 E4B" }),
  ]);
  assert.strictEqual(picked["my-vision-model.gguf"], "adapter-01.gguf");
});

// ---- Tier 1: recorded download provenance ----

test("two files from one repo are paired without inferring anything", () => {
  // Neither carries a usable name; the download record settles it.
  const { picked } = pair([chat("a.gguf"), proj("b.gguf")], {
    "a.gguf": "unsloth/vlm-GGUF",
    "b.gguf": "unsloth/vlm-GGUF",
  });
  assert.strictEqual(picked["a.gguf"], "b.gguf");
});

test("a different repo is not provenance, and does not pair", () => {
  const { picked } = pair([chat("a.gguf"), proj("b.gguf")], {
    "a.gguf": "org/one-GGUF",
    "b.gguf": "org/two-GGUF",
  });
  assert.strictEqual(picked["a.gguf"], undefined);
});

test("provenance outranks a name that disagrees with it", () => {
  const { picked } = pair(
    [
      chat("a.gguf", { modelName: "Model One" }),
      proj("b.gguf", { modelName: "Model Two" }),
    ],
    { "a.gguf": "org/repo", "b.gguf": "org/repo" },
  );
  assert.strictEqual(picked["a.gguf"], "b.gguf");
});

test("several adapters from one repo are separated by name", () => {
  const { picked } = pair([GEMMA_E4B, MMPROJ_E2B, MMPROJ_E4B], {
    "gemma-4-E4B-it-Q8_0.gguf": "google/gemma-4-GGUF",
    "mmproj-gemma-4-E2B-it-BF16.gguf": "google/gemma-4-GGUF",
    "mmproj-gemma-4-E4B-it-BF16.gguf": "google/gemma-4-GGUF",
  });
  assert.strictEqual(
    picked["gemma-4-E4B-it-Q8_0.gguf"],
    "mmproj-gemma-4-E4B-it-BF16.gguf",
  );
});

// ---- Tier 2: declared identity ----

test("punctuation and case in general.name are not differences", () => {
  assert.strictEqual(
    normalizeName("Gemma 4 E4B"),
    normalizeName("gemma-4-e4b"),
  );
  const { picked } = pair([
    chat("m.gguf", { modelName: "Gemma 4 E4B" }),
    proj("p.gguf", { modelName: "gemma-4-e4b" }),
  ]);
  assert.strictEqual(picked["m.gguf"], "p.gguf");
});

test("one adapter serves every quantization of its model", () => {
  const { picked } = pair([
    chat("model-Q4_K_M.gguf", { modelName: "Some VLM" }),
    chat("model-Q8_0.gguf", { modelName: "Some VLM" }),
    proj("mmproj.gguf", { modelName: "Some VLM" }),
  ]);
  assert.strictEqual(picked["model-Q4_K_M.gguf"], "mmproj.gguf");
  assert.strictEqual(picked["model-Q8_0.gguf"], "mmproj.gguf");
});

test("the same adapter at two quantizations is not an ambiguity", () => {
  // Both carry the model's name, so either is correct; the choice is made the
  // same way on every machine rather than by directory order.
  const { picked } = pair([
    chat("m.gguf", { modelName: "Some VLM" }),
    proj("mmproj-BF16.gguf", { modelName: "Some VLM" }),
    proj("mmproj-F16.gguf", { modelName: "Some VLM" }),
  ]);
  assert.strictEqual(picked["m.gguf"], "mmproj-BF16.gguf");
});

// ---- Tier 3: compatibility can only ever veto ----

test("a dimension conflict overrules an exact name match", () => {
  const { picked } = pair([
    chat("m.gguf", { modelName: "Same Name", embedDim: 4096 }),
    proj("p.gguf", { modelName: "Same Name", projDim: 1536 }),
  ]);
  assert.strictEqual(picked["m.gguf"], undefined);
});

test("a known projector type belonging to another family is refused", () => {
  const { picked } = pair([
    chat("m.gguf", { arch: "granite", modelName: "Same Name" }),
    proj("p.gguf", { modelName: "Same Name", projectorType: "gemma4v" }),
  ]);
  assert.strictEqual(picked["m.gguf"], undefined);
});

test("an unrecognised projector type never rejects anything", () => {
  // The table is deliberately incomplete: an entry can only veto, so a wrong
  // one would break a working combination. Unknown means "no opinion".
  assert.strictEqual(
    compatibilityConflict(
      { arch: "llama", embedDim: 4096 },
      { projectorType: "some-new-thing", projDim: 4096 },
    ),
    false,
  );
  const { picked } = pair([
    chat("m.gguf", { modelName: "X", arch: "llama" }),
    proj("p.gguf", { modelName: "X", projectorType: "some-new-thing" }),
  ]);
  assert.strictEqual(picked["m.gguf"], "p.gguf");
});

test("an unknown dimension is not evidence of a mismatch", () => {
  const conflict = (embedDim, projDim) =>
    compatibilityConflict({ embedDim }, { projDim });
  assert.strictEqual(conflict(0, 1536), false);
  assert.strictEqual(conflict(4096, 0), false);
  assert.strictEqual(conflict(2560, 2560), false);
  assert.strictEqual(conflict(4096, 1536), true);
});

// ---- Refusal, and the choice it hands back ----

test("an adapter nothing identifies is attached to nothing", () => {
  // The old count-based fallback paired exactly this: one model, one adapter,
  // no evidence whatsoever.
  const { picked } = pair([chat("m.gguf"), proj("mmproj-F16.gguf")]);
  assert.strictEqual(picked["m.gguf"], undefined);
});

test("the compatible candidates are reported so they can be offered", () => {
  const { offered } = pair([chat("m.gguf"), proj("p1.gguf"), proj("p2.gguf")]);
  assert.deepStrictEqual(offered["m.gguf"], ["p1.gguf", "p2.gguf"]);
});

test("an incompatible adapter is not even offered as a candidate", () => {
  const { offered } = pair([GRANITE, MMPROJ_E2B, MMPROJ_E4B]);
  assert.strictEqual(offered["granite-4.2-8b-Q6_K.gguf"], undefined);
});

test("nothing is offered once a match is certain", () => {
  const { offered } = pair([GEMMA_E4B, MMPROJ_E4B]);
  assert.strictEqual(offered["gemma-4-E4B-it-Q8_0.gguf"], undefined);
});

// ---- The user's own answer wins ----

test("a pinned adapter is never second-guessed", () => {
  const { picked } = pair([
    chat("m.gguf", { modelName: "X", projector: "chosen.gguf" }),
    proj("chosen.gguf", { modelName: "totally different" }),
    proj("would-have-matched.gguf", { modelName: "X" }),
  ]);
  assert.strictEqual(picked["m.gguf"], "chosen.gguf");
});

// ---- Detection and bookkeeping ----

test("an adapter is recognised from its own declared type", () => {
  // `general.type` is the declaration; "clip" covers files written before it.
  assert.strictEqual(isProjector({ type: "mmproj", arch: "" }), true);
  assert.strictEqual(isProjector({ type: "", arch: "clip" }), true);
  assert.strictEqual(isProjector({ type: "model", arch: "gemma4" }), false);
  // A filename is not a declaration and no longer counts as one.
  assert.strictEqual(
    isProjector({ file: "mmproj-x.gguf", type: "model" }),
    false,
  );
});

test("an adapter names the model it was paired with", () => {
  const { out } = pair([GEMMA_E4B, MMPROJ_E4B]);
  const adapter = out.find((m) => m.file === MMPROJ_E4B.file);
  assert.strictEqual(adapter.isProjector, true);
  assert.strictEqual(adapter.parentFile, "gemma-4-E4B-it-Q8_0.gguf");
});

test("an adapter that matched nothing reports no parent", () => {
  const { out } = pair([GRANITE, MMPROJ_E2B]);
  const adapter = out.find((m) => m.file === MMPROJ_E2B.file);
  assert.strictEqual(adapter.isProjector, true);
  assert.strictEqual(adapter.parentFile, null);
});

test("an embedding model is never given an adapter", () => {
  const { picked } = pair([
    chat("nomic.gguf", { modelName: "X", embedding: true }),
    proj("p.gguf", { modelName: "X" }),
  ]);
  assert.strictEqual(picked["nomic.gguf"], undefined);
});

test("a folder with no adapters is left exactly as it was", () => {
  const { out } = pair([GRANITE, GEMMA_E4B]);
  assert.ok(out.every((m) => m.projector === undefined));
});
