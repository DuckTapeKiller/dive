// Reading a router's configuration off its own command line is the whole
// reason preset sync needs no settings, so the parse is pinned down here. It
// takes a string, so none of this needs a live llama-server.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const {
  parseRouterCommand,
  routerModelPath,
  routerAliasFor,
} = require("../routes/llamacpp-router-discovery.js");

const CHAT =
  "/opt/homebrew/bin/llama-server --models-dir /Users/x/models" +
  " --models-preset /Users/x/models/llama-server-chat.ini" +
  " --models-max 1 --host 127.0.0.1 --port 8130";

const EMBED =
  "/opt/homebrew/bin/llama-server" +
  " --models-preset /Users/x/models/llama-server-embed.ini" +
  " --models-max 1 --host 127.0.0.1 --port 8131";

test("a chat router yields both its preset and its models folder", () => {
  assert.deepStrictEqual(parseRouterCommand(CHAT), {
    binary: "/opt/homebrew/bin/llama-server",
    presetPath: "/Users/x/models/llama-server-chat.ini",
    modelsDir: "/Users/x/models",
  });
});

test("an embedding router has no --models-dir, and says so rather than guessing", () => {
  const parsed = parseRouterCommand(EMBED);
  assert.strictEqual(
    parsed.presetPath,
    "/Users/x/models/llama-server-embed.ini",
  );
  assert.strictEqual(parsed.modelsDir, "");
});

test("Dive's own managed server is never adopted as a router", () => {
  // No --models-preset: this is `llama-server -m model.gguf`, Dive's child.
  assert.strictEqual(
    parseRouterCommand(
      "/opt/homebrew/bin/llama-server -m /Users/x/models/a.gguf --port 8130",
    ),
    null,
  );
});

test("a router's own spawned per-model child is not a router either", () => {
  assert.strictEqual(
    parseRouterCommand(
      "/opt/homebrew/Cellar/llama.cpp/10090/bin/llama-server --host 127.0.0.1" +
        " --jinja --port 49243 --alias a --model /Users/x/models/a.gguf",
    ),
    null,
  );
});

test("a process that is not llama-server is never touched", () => {
  // The guard that keeps this away from everything else on the machine: even
  // something carrying the exact flags is ignored unless it IS a llama-server.
  assert.strictEqual(
    parseRouterCommand(
      "/usr/bin/node server.js --models-preset /Users/x/a.ini",
    ),
    null,
  );
  assert.strictEqual(
    parseRouterCommand("/usr/bin/python3 --models-preset /Users/x/a.ini"),
    null,
  );
  assert.strictEqual(parseRouterCommand(""), null);
});

test("a preset path must be an absolute .ini", () => {
  const bad = [
    "/opt/homebrew/bin/llama-server --models-preset relative.ini",
    "/opt/homebrew/bin/llama-server --models-preset /Users/x/models.txt",
    "/opt/homebrew/bin/llama-server --models-preset",
  ];
  for (const cmd of bad) assert.strictEqual(parseRouterCommand(cmd), null);
});

test("a path containing spaces survives ps's unquoted output", () => {
  const parsed = parseRouterCommand(
    "/opt/homebrew/bin/llama-server --models-dir /Users/x/my models" +
      " --models-preset /Users/x/my models/chat.ini --port 8130",
  );
  assert.strictEqual(parsed.presetPath, "/Users/x/my models/chat.ini");
  assert.strictEqual(parsed.modelsDir, "/Users/x/my models");
});

test("a llama-server invoked by bare name still parses", () => {
  const parsed = parseRouterCommand(
    "llama-server --models-preset /Users/x/a.ini --port 8130",
  );
  assert.strictEqual(parsed.presetPath, "/Users/x/a.ini");
});

// ---- Matching a file to the name a router knows it by ----
//
// A router names each model after its `[section]`, so the name need not
// resemble the filename. The embedding preset relies on that: its section is
// named for the library's vector index, not for the .gguf. Matching by name
// therefore failed exactly there — LOAD refused, and unload was accepted with
// the wrong name and quietly did nothing.

const EMBED_ENTRY = {
  id: "text-embedding-nomic-embed-text-v2-moe",
  status: {
    value: "unloaded",
    args: [
      "/opt/homebrew/bin/llama-server",
      "--embeddings",
      "--alias",
      "text-embedding-nomic-embed-text-v2-moe",
      "--model",
      "/Users/x/models/nomic-embed-text-v2-moe.f16.gguf",
    ],
    preset:
      "[text-embedding-nomic-embed-text-v2-moe]\n" +
      "embeddings = true\n" +
      "model = /Users/x/models/nomic-embed-text-v2-moe.f16.gguf\n",
  },
};

test("the model file is read from a router's spawn arguments", () => {
  assert.strictEqual(
    routerModelPath(EMBED_ENTRY),
    "/Users/x/models/nomic-embed-text-v2-moe.f16.gguf",
  );
});

test("the preset text is used when no --model argument is reported", () => {
  const entry = {
    id: "a",
    status: {
      value: "unloaded",
      preset: "[a]\nmodel = /Users/x/models/a.gguf\n",
    },
  };
  assert.strictEqual(routerModelPath(entry), "/Users/x/models/a.gguf");
});

test("an entry with no status yields no path rather than throwing", () => {
  assert.strictEqual(routerModelPath({ id: "a" }), "");
  assert.strictEqual(routerModelPath(undefined), "");
  assert.strictEqual(routerModelPath({ id: "a", status: "loaded" }), "");
});

test("a hand-named section is found by its file, not its name", () => {
  const advertised = {
    models: [{ ...EMBED_ENTRY, modelPath: routerModelPath(EMBED_ENTRY) }],
  };
  assert.strictEqual(
    routerAliasFor(
      advertised,
      "/Users/x/models/nomic-embed-text-v2-moe.f16.gguf",
      "nomic-embed-text-v2-moe.f16.gguf",
    ),
    "text-embedding-nomic-embed-text-v2-moe",
  );
});

test("a router reporting no path still matches on the filename stem", () => {
  const advertised = { models: [{ id: "gemma-4-E4B-it-Q8_0", modelPath: "" }] };
  assert.strictEqual(
    routerAliasFor(
      advertised,
      "/Users/x/models/gemma-4-E4B-it-Q8_0.gguf",
      "gemma-4-E4B-it-Q8_0.gguf",
    ),
    "gemma-4-E4B-it-Q8_0",
  );
});

test("a model the router does not serve yields no alias, so nothing is sent", () => {
  const advertised = {
    models: [{ ...EMBED_ENTRY, modelPath: routerModelPath(EMBED_ENTRY) }],
  };
  assert.strictEqual(
    routerAliasFor(
      advertised,
      "/Users/x/models/gemma-4-E4B-it-Q8_0.gguf",
      "gemma-4-E4B-it-Q8_0.gguf",
    ),
    "",
  );
  assert.strictEqual(
    routerAliasFor({ models: [] }, "/Users/x/a.gguf", "a.gguf"),
    "",
  );
  assert.strictEqual(
    routerAliasFor(undefined, "/Users/x/a.gguf", "a.gguf"),
    "",
  );
});

test("an unnormalised path still matches the same file", () => {
  const advertised = {
    models: [{ ...EMBED_ENTRY, modelPath: routerModelPath(EMBED_ENTRY) }],
  };
  assert.strictEqual(
    routerAliasFor(
      advertised,
      "/Users/x/models/../models/nomic-embed-text-v2-moe.f16.gguf",
      "nomic-embed-text-v2-moe.f16.gguf",
    ),
    "text-embedding-nomic-embed-text-v2-moe",
  );
});
