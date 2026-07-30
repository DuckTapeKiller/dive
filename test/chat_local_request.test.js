// Dive sends the assistant policy, the database context and the skills policy
// as three separate system messages, because small models follow them better
// that way. Some chat templates refuse any system message after the first, so
// those models — and only those — get the blocks merged. These pin down both
// halves of that, and the refusal detection that sits next to it.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const {
  collapseLeadingSystemMessages,
  wantsSingleSystemMessage,
  isNativeToolsRejection,
} = require("../routes/chat-local-request.js");

const THREE = [
  { role: "system", content: "policy" },
  { role: "system", content: "database context" },
  { role: "system", content: "skills" },
  { role: "user", content: "hello" },
];

test("three system messages become one, in the same order", () => {
  const out = collapseLeadingSystemMessages(THREE);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].role, "system");
  assert.strictEqual(out[0].content, "policy\n\ndatabase context\n\nskills");
  assert.deepStrictEqual(out[1], { role: "user", content: "hello" });
});

test("the caller's array is never rewritten", () => {
  const input = THREE.map((m) => ({ ...m }));
  const before = JSON.stringify(input);
  collapseLeadingSystemMessages(input);
  assert.strictEqual(JSON.stringify(input), before);
});

test("a single system message is handed back untouched", () => {
  const one = [
    { role: "system", content: "policy" },
    { role: "user", content: "hi" },
  ];
  // The very same array, so the ordinary path allocates nothing.
  assert.strictEqual(collapseLeadingSystemMessages(one), one);
});

test("merging is idempotent, so re-sending a round cannot compound it", () => {
  const once = collapseLeadingSystemMessages(THREE);
  assert.strictEqual(collapseLeadingSystemMessages(once), once);
});

test("only the LEADING run is merged", () => {
  // A system message after the conversation starts is left where it is: moving
  // it would change what the model is told, and when.
  const out = collapseLeadingSystemMessages([
    { role: "system", content: "a" },
    { role: "system", content: "b" },
    { role: "user", content: "q" },
    { role: "system", content: "late" },
  ]);
  assert.strictEqual(out.length, 3);
  assert.strictEqual(out[0].content, "a\n\nb");
  assert.deepStrictEqual(out[2], { role: "system", content: "late" });
});

test("fields on the first system message survive the merge", () => {
  const out = collapseLeadingSystemMessages([
    { role: "system", content: "a", name: "policy" },
    { role: "system", content: "b" },
  ]);
  assert.strictEqual(out[0].name, "policy");
});

test("empty blocks do not leave blank gaps", () => {
  const out = collapseLeadingSystemMessages([
    { role: "system", content: "a" },
    { role: "system", content: "   " },
    { role: "system", content: "b" },
  ]);
  assert.strictEqual(out[0].content, "a\n\nb");
});

test("a run is not merged across non-string content", () => {
  // Image parts arrive as arrays; treating one as text would corrupt it.
  const input = [
    { role: "system", content: "a" },
    { role: "system", content: [{ type: "text", text: "b" }] },
  ];
  assert.strictEqual(collapseLeadingSystemMessages(input), input);
});

test("odd input does not throw", () => {
  assert.deepStrictEqual(collapseLeadingSystemMessages(undefined), []);
  assert.deepStrictEqual(collapseLeadingSystemMessages([]), []);
});

// ---- Which models are opted in ----

test("off by default: no map means no merging", () => {
  assert.strictEqual(wantsSingleSystemMessage({}, "bonsai-27b"), false);
  assert.strictEqual(wantsSingleSystemMessage(undefined, "bonsai-27b"), false);
});

test("a ticked model is matched whichever spelling is stored", () => {
  // The MODELS tab keys by file name, a request names the alias.
  const byFile = { singleSystemMessage: { "bonsai-27b-Q4_K_M.gguf": true } };
  const byAlias = { singleSystemMessage: { "bonsai-27b-Q4_K_M": true } };
  for (const conf of [byFile, byAlias]) {
    assert.strictEqual(
      wantsSingleSystemMessage(conf, "bonsai-27b-Q4_K_M"),
      true,
    );
    assert.strictEqual(
      wantsSingleSystemMessage(conf, "bonsai-27b-Q4_K_M.gguf"),
      true,
    );
  }
});

test("one model being ticked never affects another", () => {
  const conf = { singleSystemMessage: { "bonsai-27b-Q4_K_M": true } };
  assert.strictEqual(
    wantsSingleSystemMessage(conf, "gemma-4-E4B-it-Q8_0"),
    false,
  );
});

test("a falsy value is not an opt-in, and no model is not a match", () => {
  const conf = { singleSystemMessage: { a: false, b: "yes", c: 1 } };
  for (const name of ["a", "b", "c"]) {
    assert.strictEqual(wantsSingleSystemMessage(conf, name), false);
  }
  assert.strictEqual(wantsSingleSystemMessage(conf, ""), false);
});

// ---- Refusals worth retrying without native tools ----

test("every 400 is retried, as it always was", () => {
  assert.strictEqual(isNativeToolsRejection({ statusCode: 400 }), true);
  assert.strictEqual(
    isNativeToolsRejection({ statusCode: 400, message: "anything" }),
    true,
  );
});

test("the missing --jinja 500 is retried", () => {
  // This is the one that used to reach the user untouched.
  assert.strictEqual(
    isNativeToolsRejection({
      statusCode: 500,
      message:
        'Local model request failed (500): {"error":{"message":"tools param requires --jinja flag"}}',
    }),
    true,
  );
});

test("an unrelated 500 is not retried", () => {
  assert.strictEqual(
    isNativeToolsRejection({ statusCode: 500, message: "out of memory" }),
    false,
  );
});

test("other statuses are never retried", () => {
  for (const statusCode of [401, 404, 429, 502, 503, undefined]) {
    assert.strictEqual(
      isNativeToolsRejection({ statusCode, message: "tools" }),
      false,
    );
  }
  assert.strictEqual(isNativeToolsRejection(undefined), false);
});
