// Pairing a vision adapter with the model it belongs to.
//
// Vision models ship as a language GGUF plus a separate multimodal projector
// ("mmproj"). llama-server needs that projector passed with --mmproj, or
// written as `mmproj =` in a router preset, before it will accept an image.
//
// This used to be decided by comparing FILENAMES. `granite-4.2-8b-Q6_K.gguf`
// and `mmproj-gemma-4-E2B-it-BF16.gguf` share exactly one token once quant and
// format noise is stripped — the digit `4`, from Granite 4.2 and Gemma 4 — and
// one shared token counted as a match. Granite was handed a Gemma adapter,
// which is not a cosmetic error: llama-server fails the load outright, so the
// model became unusable for text as well.
//
// Two things were wrong, and only one of them was the digit.
//
// FIRST: the filename was the wrong thing to read. A GGUF states its own
// identity. A projector and the model it was converted alongside carry the
// SAME `general.name`, stamped by the conversion run from the same source
// repository:
//
//   gemma-4-E4B-it-Q8_0.gguf          general.name = "Gemma 4 E4B"
//   mmproj-gemma-4-E4B-it-BF16.gguf   general.name = "Gemma 4 E4B"
//   mmproj-gemma-4-E2B-it-BF16.gguf   general.name = "Gemma 4 E2B"
//
// That is provenance, not resemblance: it separates E2B from E4B exactly, and
// it excludes Granite without arithmetic. The filename, by contrast, is the one
// string in a GGUF that nobody controls — re-uploaders rename, quantisers
// append suffixes, users rename. It is now read by nothing here.
//
// SECOND, and worse: the matcher was built to always produce an answer. Any
// overlap above zero won, and when nothing overlapped a fallback paired on raw
// counts. The harm is asymmetric — a WRONG projector stops the model loading at
// all, while NO projector merely costs image input — so the default has to be
// refusal. Where the evidence does not identify one adapter, none is attached
// and the compatible candidates are reported for the caller to offer as a
// choice. Guessing is not a service.
//
// Evidence, strongest first:
//
//   1. Recorded provenance. A file downloaded through Dive remembers the repo
//      it came from; a model and an adapter from the same repo belong together
//      and nothing needs inferring at all.
//   2. `general.name` equality, punctuation and case ignored.
//   3. Compatibility, which can only ever VETO a candidate, never nominate
//      one: a projector emits into the model's embedding space, so
//      `clip.vision.projection_dim` must equal `<arch>.embedding_length`; and
//      a known `clip.vision.projector_type` must belong to the model's
//      architecture family.
//
// An explicit choice made by the user outranks all of it and is not made here.
"use strict";

// A projector says so in its own header. `general.type` is the declaration;
// architecture "clip" is the fallback for files written before it existed.
function isProjector(entry) {
  return entry?.type === "mmproj" || entry?.arch === "clip";
}

// Identity, compared the way two humans would: case and punctuation carry no
// meaning here, so "Gemma 4 E4B" and "gemma-4-e4b" are the same name.
function normalizeName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

// Which language architecture a projector type belongs to.
//
// Deliberately incomplete. An entry here can only ever REJECT a pairing, so a
// wrong guess would break a combination that works — whereas a missing entry
// merely leaves the decision to the evidence above. Types that are generic by
// design (the LLaVA-style projectors, shared across unrelated models) must
// never appear here, and neither must anything unverified.
const PROJECTOR_TYPE_ARCH = new Map([
  ["gemma3", "gemma3"],
  ["gemma4v", "gemma4"],
  ["gemma4a", "gemma4"],
  ["qwen2vl_merger", "qwen2vl"],
  ["qwen2.5vl_merger", "qwen2vl"],
  ["qwen3vl_merger", "qwen3vl"],
  ["llama4", "llama4"],
]);

// Do the two headers positively contradict each other?
//
// True only where both sides are known and disagree. An absent number or an
// unrecognised projector type is not evidence of a mismatch — it leaves the
// question to be answered by identity, above, rather than answering it wrongly
// here.
function compatibilityConflict(model, projector) {
  const wanted = Number(model?.embedDim) || 0;
  const offered = Number(projector?.projDim) || 0;
  if (wanted && offered && wanted !== offered) return true;
  const family = PROJECTOR_TYPE_ARCH.get(
    String(projector?.projectorType || "").toLowerCase(),
  );
  if (family && model?.arch && model.arch !== family) return true;
  return false;
}

function sameRecordedSource(model, projector, sources) {
  const a = sources?.[model?.file];
  const b = sources?.[projector?.file];
  return Boolean(a && b && a === b);
}

function sameDeclaredName(model, projector) {
  const a = normalizeName(model?.modelName);
  const b = normalizeName(projector?.modelName);
  return Boolean(a && b && a === b);
}

function byFile(a, b) {
  return String(a.file).localeCompare(String(b.file));
}

// The adapter for one model: `{ projector, candidates }`. `projector` is null
// whenever the evidence does not single one out, and `candidates` then holds
// every compatible adapter so a caller can ask the user which — or none.
function resolveProjector(model, projectors, sources) {
  const candidates = projectors
    .filter((p) => !compatibilityConflict(model, p))
    .sort(byFile);
  if (!candidates.length) return { projector: null, candidates };

  // 1. Provenance. One adapter downloaded from this model's own repository
  //    needs no inference: they were published together.
  const sameSource = candidates.filter((p) =>
    sameRecordedSource(model, p, sources),
  );
  if (sameSource.length === 1) {
    return { projector: sameSource[0], candidates };
  }

  // 2. Declared identity. Several adapters from one repository (the same
  //    projector at different quantizations, say) are separated by name like
  //    anything else; where provenance says nothing, every candidate is
  //    considered.
  const pool = sameSource.length > 1 ? sameSource : candidates;
  const named = pool.filter((p) => sameDeclaredName(model, p));
  // Everything left here carries this model's own name, so any of them is its
  // adapter — the remaining difference is quantization. Sorted, so the choice
  // is at least the same on every machine.
  if (named.length) return { projector: named[0], candidates };

  // Nothing identifies one. Attaching the "best" of them is how a Granite
  // model came to be launched with a Gemma adapter, so attach none and let the
  // candidates be offered instead.
  return { projector: null, candidates };
}

// Annotate a scanned models list in place.
//
// Adds `projector` to a chat model that has one and `projectorCandidates` when
// it has several it cannot choose between, and `isProjector`/`parentFile` to
// each adapter. A `projector` already set — the user having said so — is left
// exactly as it is. Nothing is ever removed from the list.
function pairProjectors(models, options = {}) {
  const sources = options.sources || {};
  const list = Array.isArray(models) ? models : [];
  const projectors = list.filter(isProjector);
  if (!projectors.length) return list;
  const chatModels = list.filter((m) => !isProjector(m) && !m.embedding);
  for (const model of chatModels) {
    // An explicit pin outranks every inference below, including a refusal to
    // infer: it is the answer to the case where the evidence runs out.
    if (model.projector) continue;
    const { projector, candidates } = resolveProjector(
      model,
      projectors,
      sources,
    );
    if (projector) {
      model.projector = projector.file;
    } else if (candidates.length) {
      model.projectorCandidates = candidates.map((p) => p.file);
    }
  }
  for (const p of projectors) {
    p.isProjector = true;
    const parent = chatModels.find((m) => m.projector === p.file);
    p.parentFile = parent ? parent.file : null;
  }
  return list;
}

module.exports = {
  isProjector,
  normalizeName,
  compatibilityConflict,
  resolveProjector,
  pairProjectors,
  PROJECTOR_TYPE_ARCH,
};
