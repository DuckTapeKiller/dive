// Three copies of "which model, on which port" used to drift apart because
// each write path updated only the one it owned. These pin down the projection
// that replaced them: what each write path must touch, and — for the library's
// embedding model, where a wrong value costs a full re-index — what it must
// refuse to touch.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const {
  createDerivedState,
  chatBaseUrl,
  embedBaseUrl,
  selectionNameFor,
  planEmbeddingRename,
} = require("../routes/llamacpp-derived.js");

// Each load hands back a copy, so a caller that mutates what it reads cannot
// change the stored file without saving — exactly as the real files behave.
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// An in-memory stand-in for the three config files.
function harness(overrides = {}) {
  const files = {
    llama: {
      port: 8130,
      lastModel: "chat-model.gguf",
      lastEmbeddingModel: "nomic-embed-text-v2-moe.f16.gguf",
      ...(overrides.llama || {}),
    },
    local: {
      llamacpp: {
        baseUrl: "http://127.0.0.1:8130/v1",
        model: "chat-model",
        ...(overrides.local || {}),
      },
    },
    library: {
      embedding: {
        model: "text-embedding-nomic-embed-text-v2-moe",
        ollamaBaseUrl: "http://127.0.0.1:8131",
        ...(overrides.library || {}),
      },
    },
  };
  const warnings = [];
  const announced = [];
  const state = createDerivedState({
    onChatSelectionChanged: (name) => announced.push(name),
    loadLlamaConfig: () => clone(files.llama),
    saveLlamaConfig: (cfg) => {
      files.llama = clone(cfg);
      return files.llama;
    },
    loadLocalModelSettings: () => clone(files.local),
    saveLocalModelSettings: (s) => {
      files.local = clone(s);
    },
    loadLibraryConfig: () => clone(files.library),
    saveLibraryConfig: (c) => {
      files.library = clone(c);
      return files.library;
    },
    readIndexedEmbeddingModel: async () =>
      overrides.indexedModel !== undefined ? overrides.indexedModel : "",
    warn: (m) => warnings.push(m),
  });
  return { state, files, warnings, announced };
}

test("deleting the loaded model clears every copy that named it", () => {
  const { state, files } = harness();
  const result = state.forgetModel("chat-model.gguf");

  assert.strictEqual(result.clearedChat, true);
  assert.strictEqual(files.llama.lastModel, "", "autostart would reload it");
  assert.strictEqual(
    files.local.llamacpp.model,
    "",
    "the next message would ask a server for a model that is gone",
  );
});

test("deleting the embedding model clears the startup choice for its slot", () => {
  const { state, files } = harness();
  const result = state.forgetModel("nomic-embed-text-v2-moe.f16.gguf");

  assert.strictEqual(result.clearedEmbedding, true);
  assert.strictEqual(files.llama.lastEmbeddingModel, "");
  // The chat selection names a different model and must survive.
  assert.strictEqual(files.local.llamacpp.model, "chat-model");
});

test("deleting the embedding model leaves the library's index key alone", () => {
  const { state, files } = harness();
  state.forgetModel("nomic-embed-text-v2-moe.f16.gguf");

  // The .gguf is gone; the vectors built from it are not. Blanking the name
  // they are stored under would strand an index nothing refers to.
  assert.strictEqual(
    files.library.embedding.model,
    "text-embedding-nomic-embed-text-v2-moe",
  );
});

test("deleting some other model touches nothing", () => {
  const { state, files } = harness();
  const before = JSON.stringify(files);
  state.forgetModel("unrelated.gguf");
  assert.strictEqual(JSON.stringify(files), before);
});

test("a selection stored as a bare filename is still recognised on delete", () => {
  // Older versions wrote the selection with its extension; delete has to match
  // its own past writes, not just the current spelling.
  const { state, files } = harness({
    llama: { lastModel: "" },
    local: { model: "chat-model.gguf" },
  });
  state.forgetModel("chat-model.gguf");
  assert.strictEqual(files.local.llamacpp.model, "");
});

test("changing the port moves both derived addresses, including the library's", () => {
  const { state, files } = harness();
  state.syncPorts({ port: 9000 });

  assert.strictEqual(files.local.llamacpp.baseUrl, "http://127.0.0.1:9000/v1");
  assert.strictEqual(
    files.library.embedding.ollamaBaseUrl,
    "http://127.0.0.1:9001",
    "the embed port is port + 1 everywhere else; the library stored a literal",
  );
});

test("a port change does not disturb either model name", () => {
  const { state, files } = harness();
  state.syncPorts({ port: 9000 });

  assert.strictEqual(files.local.llamacpp.model, "chat-model");
  assert.strictEqual(
    files.library.embedding.model,
    "text-embedding-nomic-embed-text-v2-moe",
  );
});

test("a nonsense port is ignored rather than written", () => {
  const { state, files } = harness();
  state.syncPorts({ port: 0 });
  assert.strictEqual(files.local.llamacpp.baseUrl, "http://127.0.0.1:8130/v1");
});

test("loading a chat model moves the URL and the name together", () => {
  const { state, files } = harness();
  state.setChatSelection({ port: 8130 }, "new-model.gguf", { port: 8130 });

  assert.strictEqual(files.llama.lastModel, "new-model.gguf");
  assert.strictEqual(files.local.llamacpp.model, "new-model");
  assert.strictEqual(files.local.llamacpp.baseUrl, "http://127.0.0.1:8130/v1");
});

test("a router's own name for a model wins over the filename", () => {
  // A preset section need not be named after its file, and the router only
  // answers to the section name.
  const { state, files } = harness();
  state.setChatSelection({ port: 8130 }, "new-model.gguf", {
    port: 8130,
    alias: "house-alias",
  });
  assert.strictEqual(files.local.llamacpp.model, "house-alias");
});

test("loading an embedding model records it for autostart", async () => {
  const { state, files } = harness();
  await state.setEmbeddingSelection({ port: 8130 }, "other-embed.gguf", {
    alias: "other-embed",
  });
  assert.strictEqual(files.llama.lastEmbeddingModel, "other-embed.gguf");
});

test("a different embedding model does NOT silently repoint an existing index", async () => {
  // The stored vectors were built by the model currently named. Adopting the
  // new name drops them on the next index run and, until then, compares two
  // unrelated vector spaces — so the caller is told instead.
  const { state, files } = harness({
    indexedModel: "text-embedding-nomic-embed-text-v2-moe",
  });
  const { warning } = await state.setEmbeddingSelection(
    { port: 8130 },
    "bge-m3.gguf",
    { alias: "bge-m3" },
  );

  assert.match(warning, /re-index/i);
  assert.strictEqual(
    files.library.embedding.model,
    "text-embedding-nomic-embed-text-v2-moe",
  );
  // Still recorded for autostart: the slot really is serving it.
  assert.strictEqual(files.llama.lastEmbeddingModel, "bge-m3.gguf");
});

test("with nothing indexed yet, the library adopts the loaded model", async () => {
  const { state, files } = harness({ indexedModel: "" });
  const { warning } = await state.setEmbeddingSelection(
    { port: 8130 },
    "bge-m3.gguf",
    { alias: "bge-m3" },
  );

  assert.strictEqual(warning, "");
  assert.strictEqual(files.library.embedding.model, "bge-m3");
});

test("an unconfirmed name is never written, however plausible", async () => {
  // No alias means no router confirmed serving this file under any name.
  // Guessing from the filename is exactly the wrong-value case that costs a
  // re-index, so nothing is written.
  const { state, files } = harness({ indexedModel: "" });
  await state.setEmbeddingSelection({ port: 8130 }, "bge-m3.gguf", {});
  assert.strictEqual(
    files.library.embedding.model,
    "text-embedding-nomic-embed-text-v2-moe",
  );
});

test("an unreadable index blocks the rename rather than risking it", async () => {
  const files = { failed: false };
  const state = createDerivedState({
    loadLlamaConfig: () => ({ port: 8130, lastEmbeddingModel: "" }),
    saveLlamaConfig: () => {},
    loadLocalModelSettings: () => ({ llamacpp: {} }),
    saveLocalModelSettings: () => {},
    loadLibraryConfig: () => ({ embedding: { model: "old-name" } }),
    saveLibraryConfig: () => {
      files.failed = true;
    },
    readIndexedEmbeddingModel: async () => {
      throw new Error("database is locked");
    },
    warn: () => {},
  });
  const { warning } = await state.setEmbeddingSelection({}, "bge-m3.gguf", {
    alias: "bge-m3",
  });

  assert.strictEqual(files.failed, false, "must not write on an unknown index");
  assert.match(warning, /re-index/i);
});

test("running without the library keeps the chat copies in step regardless", () => {
  let saved = null;
  const state = createDerivedState({
    loadLlamaConfig: () => ({ port: 8130, lastModel: "" }),
    saveLlamaConfig: () => {},
    loadLocalModelSettings: () => ({ llamacpp: {} }),
    saveLocalModelSettings: (s) => {
      saved = s;
    },
    // No library accessors at all.
  });
  state.syncPorts({ port: 9000 });
  assert.strictEqual(saved.llamacpp.baseUrl, "http://127.0.0.1:9000/v1");
});

// An open UI caches the selection and posts it with every message, where an
// explicit choice beats the server's own record. So a selection that moves
// without the UI hearing about it does not merely look stale: the next message
// asks for the model that was replaced, and the router loads it back over the
// one just loaded. These pin down that the move is always announced.
test("loading a chat model announces the new selection", () => {
  const { state, announced } = harness();
  state.setChatSelection({ port: 8130 }, "new-model.gguf", { port: 8130 });
  assert.deepStrictEqual(announced, ["new-model"]);
});

test("the announced name is the one a message must actually ask for", () => {
  const { state, announced } = harness();
  state.setChatSelection({ port: 8130 }, "new-model.gguf", {
    port: 8130,
    alias: "house-alias",
  });
  assert.deepStrictEqual(announced, ["house-alias"]);
});

test("deleting the selected model announces that it is now unset", () => {
  const { state, announced } = harness();
  state.forgetModel("chat-model.gguf");
  assert.deepStrictEqual(announced, [""]);
});

test("re-loading the model already selected announces nothing", () => {
  const { state, announced } = harness();
  state.setChatSelection({ port: 8130 }, "chat-model.gguf", { port: 8130 });
  assert.deepStrictEqual(announced, [], "no change, so nothing to tell anyone");
});

test("deleting an unselected model announces nothing", () => {
  const { state, announced } = harness();
  state.forgetModel("unrelated.gguf");
  assert.deepStrictEqual(announced, []);
});

test("the derived addresses agree with the ports used everywhere else", () => {
  assert.strictEqual(chatBaseUrl(8130), "http://127.0.0.1:8130/v1");
  assert.strictEqual(embedBaseUrl(8130), "http://127.0.0.1:8131");
  assert.strictEqual(selectionNameFor("a.Q8_0.gguf"), "a.Q8_0");
});

test("a rename to the name already in use is not a rename", () => {
  assert.strictEqual(
    planEmbeddingRename({ current: "x", next: "x", indexedModel: "x" }).action,
    "none",
  );
});
