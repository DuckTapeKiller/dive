// The single owner of every copy of "which model is loaded" and "which port
// serves it".
//
// Three files each hold a piece of that state, because three subsystems own
// them independently:
//
//   llamacpp.json           port, lastModel, lastEmbeddingModel   (the truth)
//   local-model-settings    llamacpp.baseUrl, llamacpp.model      (chat reads)
//   library-config.json     embedding.ollamaBaseUrl, .model       (search reads)
//
// The last two are DERIVED — every value there is computable from the first —
// but each used to be written by whichever code path happened to care. So a
// path updated the copy it owned and left the others naming something that had
// moved or gone: load wrote the chat selection but not the embedding one,
// delete wrote neither, and a port change wrote no URL at all. Same defect
// three times, one per write path that forgot a copy.
//
// Hence this module. Nothing else may write those four values; every write
// path calls in here instead, so a new one cannot forget a copy that does not
// appear anywhere in its own code.
//
// ---- Why the embedding model name is not simply copied ----
//
// The other three values are safe to overwrite: wrong ones self-correct on the
// next load, and cost a request in the meantime. The library's embedding model
// name is not like that. It is the key its vector index is stored under, so
// changing it means the stored vectors were built by a different model:
// indexing DROPs them and starts again, and until then search embeds queries in
// one vector space and compares them against another, which returns confident
// nonsense rather than an error.
//
// That makes a WRONG value here expensive (a re-index of the whole library) and
// silent. So the name is only ever written to one a router has confirmed it
// serves that file under — never to a guess from the filename — and never over
// a name the existing index was built with. A real change of embedding model is
// reported to the caller instead, for the user to act on deliberately.
"use strict";

const HOST = "127.0.0.1";

// The chat server's OpenAI-compatible base URL for a given port.
function chatBaseUrl(port) {
  return `http://${HOST}:${port}/v1`;
}

// The embedding server's base URL. The embedding slot runs on port + 1
// throughout Dive; this is the one place that converts it into an address, so
// library-config can no longer drift from the port that is actually in use.
function embedBaseUrl(port) {
  return `http://${HOST}:${Number(port) + 1}`;
}

// The name a model file is known by once it is being served: the filename
// without its extension. A router may advertise it under a different section
// name, which is why callers pass a confirmed alias where they have one — this
// is the fallback for Dive's own managed servers, which serve exactly one file
// and answer to any name.
function selectionNameFor(file) {
  return String(file || "").replace(/\.gguf$/i, "");
}

// Does this stored selection name refer to `file`?
//
// Delete has to recognise its own past writes without a router to ask (the
// model is on its way out, and an unloaded one may not be advertised at all).
// A selection is ours if it matches the filename stem, or the file itself —
// older versions stored the name either way.
function selectionNames(file) {
  const stem = selectionNameFor(file);
  return new Set([stem, String(file || "")].filter(Boolean));
}

// What to do about an embedding model name that has changed.
//
//   none     the library already names this model; nothing to write
//   write    safe to adopt — no existing index is keyed to another name
//   blocked  the index was built by a different model; adopting the new name
//            would invalidate every stored vector, so the caller is told
//            instead and library-config is left alone
//
// `indexedModel` is what the stored vectors were built with (empty when none
// have been). It, not the config, is what makes a rename destructive — a config
// that disagrees with an empty index costs nothing to correct.
function planEmbeddingRename({ current, next, indexedModel }) {
  const to = String(next || "").trim();
  if (!to) return { action: "none", reason: "no confirmed router name" };
  const from = String(current || "").trim();
  if (from === to) return { action: "none", reason: "already current" };
  const indexed = String(indexedModel || "").trim();
  if (indexed && indexed !== to) {
    return {
      action: "blocked",
      reason:
        `The library's index was built with "${indexed}" and still searches with it. ` +
        `Loading "${to}" does not change that: its vectors are not comparable with the stored ones. ` +
        `To switch, set the embedding model in Database settings and re-index.`,
    };
  }
  return { action: "write", reason: "" };
}

// `io` supplies the three config files as load/save pairs, plus a reader for
// the model the stored vectors were built with. Injected rather than required
// so the whole projection is testable without touching disk.
function createDerivedState(io) {
  const {
    loadLlamaConfig,
    saveLlamaConfig,
    loadLocalModelSettings,
    saveLocalModelSettings,
    loadLibraryConfig,
    saveLibraryConfig,
    // Returns the embedding model name the existing vectors were built with,
    // or "" when the library has none. Failure must read as "unknown", which
    // blocks a rename rather than risking one.
    readIndexedEmbeddingModel = async () => "",
    // Called with the new chat model name whenever the selection moves, so an
    // open UI can follow it instead of caching the name it read at startup.
    onChatSelectionChanged = () => {},
    warn = () => {},
  } = io;

  // Write only when something actually changed. These files are read on every
  // request and watched by the settings UI, so a no-op write is a spurious
  // refresh at best.
  function updateLocalModelSettings(mutate) {
    const settings = loadLocalModelSettings();
    const before = JSON.stringify(settings.llamacpp || {});
    mutate(settings);
    if (JSON.stringify(settings.llamacpp || {}) === before) return false;
    saveLocalModelSettings(settings);
    return true;
  }

  // Dive runs without the library (the accessors are optional deps), and then
  // there is simply no second copy to keep in step.
  const hasLibrary =
    typeof loadLibraryConfig === "function" &&
    typeof saveLibraryConfig === "function";

  function updateLibraryEmbedding(mutate) {
    if (!hasLibrary) return false;
    const config = loadLibraryConfig();
    const embedding = { ...(config.embedding || {}) };
    const before = JSON.stringify(embedding);
    mutate(embedding);
    if (JSON.stringify(embedding) === before) return false;
    saveLibraryConfig({ ...config, embedding });
    return true;
  }

  // Both derived base URLs follow cfg.port. Called after any port change, and
  // after a load — a load already knows the port it used, and going through
  // here keeps that knowledge in one place.
  function syncPorts(cfg) {
    const port = Number(cfg.port);
    if (!Number.isInteger(port) || port <= 0) return;
    updateLocalModelSettings((settings) => {
      settings.llamacpp.baseUrl = chatBaseUrl(port);
    });
    try {
      updateLibraryEmbedding((embedding) => {
        embedding.ollamaBaseUrl = embedBaseUrl(port);
      });
    } catch (e) {
      // The library config is optional to Dive's chat path; a failure here
      // must not fail the port change that prompted it.
      warn(`could not point the library at port ${port + 1}: ${e.message}`);
    }
  }

  // A chat model finished loading: record it everywhere at once.
  //
  // The two halves have to move together. The chat pipeline reads the baseUrl
  // AND the model name from local-model-settings, so a load that updated one
  // put a model on the server while the topbar named another — and the next
  // message asked for the old one, which on a router running --models-max 1
  // evicted the model that had just been loaded.
  function setChatSelection(cfg, file, { port, alias } = {}) {
    const target = Number(port) > 0 ? Number(port) : Number(cfg.port);
    const name = file ? alias || selectionNameFor(file) : "";
    const changed = updateLocalModelSettings((settings) => {
      settings.llamacpp.baseUrl = chatBaseUrl(target);
      if (file) settings.llamacpp.model = name;
    });
    const fresh = loadLlamaConfig();
    if (file && fresh.lastModel !== file) {
      fresh.lastModel = file;
      saveLlamaConfig(fresh);
    }
    // An open UI holds its own copy of this name and posts it with every
    // message, where it overrides the server's own record. Left uncorrected it
    // asks for the model this load replaced, and the router loads that one back
    // — so the change has to reach the client, not just the file.
    if (changed) onChatSelectionChanged(name);
  }

  // An embedding model finished loading. The port always follows; the name only
  // does when that cannot invalidate an existing index.
  //
  // Returns { warning } — non-empty when the library is deliberately left
  // pointing at a different model, so the caller can say so rather than let the
  // MODELS tab imply a control it does not have.
  async function setEmbeddingSelection(cfg, file, { alias } = {}) {
    const fresh = loadLlamaConfig();
    if (file && fresh.lastEmbeddingModel !== file) {
      fresh.lastEmbeddingModel = file;
      saveLlamaConfig(fresh);
    }
    if (!file || !hasLibrary) return { warning: "" };
    let config;
    try {
      config = loadLibraryConfig();
    } catch (e) {
      warn(`could not read the library config: ${e.message}`);
      return { warning: "" };
    }
    // Only a name a router has confirmed for this exact file may be adopted.
    // The filename stem is a guess, and a wrong guess here costs a re-index.
    const plan = planEmbeddingRename({
      current: config.embedding?.model,
      next: alias,
      indexedModel: await readIndexedEmbeddingModel(config).catch((e) => {
        warn(`could not read the library's vector metadata: ${e.message}`);
        // Unknown is not "none": treat it as occupied so a rename is blocked
        // rather than risked.
        return "unknown";
      }),
    });
    if (plan.action !== "write") {
      return { warning: plan.action === "blocked" ? plan.reason : "" };
    }
    try {
      updateLibraryEmbedding((embedding) => {
        embedding.model = String(alias).trim();
      });
    } catch (e) {
      warn(`could not point the library at "${alias}": ${e.message}`);
    }
    return { warning: "" };
  }

  // A model file is gone. Clear every copy that still names it, or the next
  // message asks a server for a model that no longer exists and autostart tries
  // to reload it on the next launch.
  //
  // Cleared, not replaced: an empty chat selection means "Automatic", which
  // resolves whatever the server is actually serving. Guessing a replacement
  // here would just be a different wrong answer.
  function forgetModel(file) {
    if (!file) return { clearedChat: false, clearedEmbedding: false };
    const cfg = loadLlamaConfig();
    const clearedChat = cfg.lastModel === file;
    const clearedEmbedding = cfg.lastEmbeddingModel === file;
    if (clearedChat) cfg.lastModel = "";
    if (clearedEmbedding) cfg.lastEmbeddingModel = "";
    if (clearedChat || clearedEmbedding) saveLlamaConfig(cfg);
    const names = selectionNames(file);
    const clearedSelection = updateLocalModelSettings((settings) => {
      // Match by name as well as by the config's own record: the selection may
      // predate lastModel being written, and either way it names a file that
      // has just left the disk.
      if (clearedChat || names.has(String(settings.llamacpp?.model || ""))) {
        settings.llamacpp.model = "";
      }
    });
    // Same reason as a load: an open UI would keep posting the deleted name.
    if (clearedSelection) onChatSelectionChanged("");
    // The library's embedding model is deliberately NOT cleared. It is the key
    // the stored vectors live under, and deleting the .gguf does not delete
    // them — blanking it would strand an index nothing names any more. Search
    // fails loudly (the model cannot be served) until another is configured,
    // which is the honest outcome.
    return { clearedChat, clearedEmbedding };
  }

  return {
    syncPorts,
    setChatSelection,
    setEmbeddingSelection,
    forgetModel,
  };
}

module.exports = {
  createDerivedState,
  chatBaseUrl,
  embedBaseUrl,
  selectionNameFor,
  planEmbeddingRename,
};
