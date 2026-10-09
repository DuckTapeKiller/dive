// The token counter in the top bar: "used %" in a solid cell, joined to
// "used / total".
//
// What it must get right:
// - the percentage is the one Pi's side panel shows for the same figures;
// - from 90.0% (as displayed) it turns red, and below it does not;
// - what nobody has measured reads as unknown ("--%", "?"), never as 0 or as
//   the previous conversation's figure;
// - a Pi status that answers for a session the page has left, or for one
//   still loading into Pi, never lands on the conversation on screen.
//
// These tests run the real functions from assets/js/07-chat.js and
// assets/js/03-theme.js inside a vm with a stand-in for the counter's DOM.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const vm = require("vm");

const JS_DIR = path.join(__dirname, "..", "assets", "js");
const read = (file) => fs.readFileSync(path.join(JS_DIR, file), "utf8");

// Copy one top-level function out of a source file, from its declaration to
// the closing brace at column 0.
function extractFunction(source, name) {
  const start = new RegExp(`^(async )?function ${name}\\(`, "m").exec(source);
  assert.ok(start, `function ${name} not found`);
  const end = source.indexOf("\n}\n", start.index);
  assert.ok(end > 0, `no closing brace for ${name}`);
  return source.slice(start.index, end + 3);
}

function extractConst(source, name) {
  const match = new RegExp(`^const ${name} = [^\\n]+\\n`, "m").exec(source);
  assert.ok(match, `const ${name} not found`);
  return match[0];
}

const CHAT = read("07-chat.js");
const THEME = read("03-theme.js");

function makeCounter() {
  const cell = (cls) => ({ className: cls, textContent: "" });
  const percent = cell("token-counter-percent");
  const tokens = cell("token-counter-tokens");
  const classes = new Set();
  return {
    percent,
    tokens,
    title: "",
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
      contains: (name) => classes.has(name),
    },
    querySelector(selector) {
      if (selector === ".token-counter-percent") return percent;
      if (selector === ".token-counter-tokens") return tokens;
      return null;
    },
    get critical() {
      return classes.has("critical");
    },
    get text() {
      return `${percent.textContent} | ${tokens.textContent}`;
    },
  };
}

// A vm holding the real counter code and the globals it reads. `fetch`
// answers from `responder`, which may return a promise to hold a request.
function makeApp({ responder } = {}) {
  const counter = makeCounter();
  const fetches = [];
  const context = vm.createContext({
    console,
    document: {
      getElementById: (id) => (id === "tokenCounter" ? counter : null),
    },
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      fetches.push({ url, body });
      const payload = await (responder ? responder(url, body) : null);
      if (!payload) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => payload };
    },
  });
  vm.runInContext(
    `
    var mode = "ollama";
    var history = [];
    var currentConvId = null;
    var piSessionLoadingConvId = null;
    var piStatusInfo = null;
    var piCurrentModelValue = "";
    var piAvailableModels = [];
    var modelSelect = null;
    var ollamaTokenState = { used: null, total: null };
    var piTokenState = { used: null, total: null };
    var cloudTokenState = { used: null, total: null };
    var lmstudioTokenState = { used: null, total: null };
    var llamacppTokenState = { used: null, total: null };
    var modeStatusUpdates = 0;
    function updateModeStatus() { modeStatusUpdates += 1; }
    function apiUrl(p) { return p; }
    ${extractConst(CHAT, "TOKEN_COUNTER_CRITICAL_PERCENT")}
    ${extractFunction(CHAT, "updateTokenCounter")}
    ${extractFunction(CHAT, "piTokenStateFromUsage")}
    ${extractFunction(CHAT, "forgetTokenUsage")}
    ${extractFunction(CHAT, "renderTokenCounter")}
    ${extractFunction(THEME, "refreshPiStatus")}
    `,
    context,
  );
  const run = (code) => vm.runInContext(code, context);
  return { counter, fetches, run, context };
}

const render = (app, used, total) =>
  app.run(
    `renderTokenCounter(document.getElementById("tokenCounter"), ${JSON.stringify(used)}, ${JSON.stringify(total)})`,
  );

test("the percentage is the side panel's figure for the same tokens", () => {
  const app = makeApp();
  // The side panel prints Pi's own percent, tokens / window * 100, to one
  // decimal place. Sweep sizes from a small local window to a large cloud one.
  for (const total of [4096, 8192, 32768, 131072, 200000, 272000, 1000000]) {
    for (let i = 0; i <= 400; i++) {
      const used = Math.round((total * i) / 400);
      render(app, used, total);
      const sidePanel = `${((used / total) * 100).toFixed(1)}%`;
      assert.strictEqual(
        app.counter.percent.textContent,
        sidePanel,
        `${used} / ${total}`,
      );
    }
  }
  render(app, 19891, 272000);
  assert.strictEqual(app.counter.text, "7.3% | 19,891 / 272,000");
});

test("it turns red exactly where the label first reads 90.0%", () => {
  const app = makeApp();
  render(app, 244500, 272000); // 89.89%
  assert.strictEqual(app.counter.percent.textContent, "89.9%");
  assert.strictEqual(app.counter.critical, false);

  render(app, 244786, 272000); // 89.995%, displayed as 90.0%
  assert.strictEqual(app.counter.percent.textContent, "90.0%");
  assert.strictEqual(app.counter.critical, true);

  render(app, 266560, 272000);
  assert.strictEqual(app.counter.text, "98.0% | 266,560 / 272,000");
  assert.strictEqual(app.counter.critical, true);

  // Back below 90% (a new conversation, a compaction): red goes away.
  render(app, 1000, 272000);
  assert.strictEqual(app.counter.critical, false);
});

test("usage past the window reads 100.0%, never more", () => {
  const app = makeApp();
  render(app, 300000, 272000);
  assert.strictEqual(app.counter.percent.textContent, "100.0%");
  assert.strictEqual(app.counter.critical, true);
});

test("anything unmeasured reads as unknown, not as 0", () => {
  const app = makeApp();
  render(app, null, 272000);
  assert.strictEqual(app.counter.text, "--% | ? / 272,000");
  assert.strictEqual(app.counter.critical, false);

  render(app, 500, null);
  assert.strictEqual(app.counter.text, "--% | 500 / ?");

  render(app, null, null);
  assert.strictEqual(app.counter.text, "--% | ? / ?");

  // A red counter whose figures become unknown is no longer red.
  render(app, 266560, 272000);
  render(app, null, 272000);
  assert.strictEqual(app.counter.critical, false);
});

test("a reply's usage is recorded for its mode and shown", async () => {
  const app = makeApp();
  await app.run(`updateTokenCounter("ollama", 4096, 8192)`);
  assert.strictEqual(app.counter.text, "50.0% | 4,096 / 8,192");
  // A plain redraw changes nothing.
  await app.run(`updateTokenCounter()`);
  assert.strictEqual(app.counter.text, "50.0% | 4,096 / 8,192");
  // Usage recorded for another mode is kept for it, not shown here.
  await app.run(`updateTokenCounter("llamacpp", 100, 131072)`);
  assert.strictEqual(app.counter.text, "50.0% | 4,096 / 8,192");
  assert.deepStrictEqual(
    { ...app.run("llamacppTokenState") },
    { used: 100, total: 131072 },
  );
});

test("opening a conversation drops the previous one's usage", async () => {
  const app = makeApp();
  await app.run(`updateTokenCounter("ollama", 6000, 8192)`);
  assert.strictEqual(app.counter.percent.textContent, "73.2%");

  // Opened from history: it has messages, but no reply has measured it.
  app.run(
    `history = [{ role: "user", content: "x" }]; forgetTokenUsage("ollama")`,
  );
  await app.run(`updateTokenCounter()`);
  assert.strictEqual(app.counter.text, "--% | ? / 8,192");

  // An empty conversation uses nothing.
  app.run(`history = []`);
  await app.run(`updateTokenCounter()`);
  assert.strictEqual(app.counter.text, "0.0% | 0 / 8,192");
});

test("a window update keeps unmeasured usage unmeasured", async () => {
  const app = makeApp();
  app.run(`mode = "llamacpp"; history = [{ role: "user", content: "x" }]`);
  // The llama.cpp status poll and the CONTEXT slider pass the state's own
  // `used` back with a new total. Unknown must not turn into 0.
  await app.run(
    `updateTokenCounter("llamacpp", llamacppTokenState.used, 65536)`,
  );
  assert.strictEqual(app.counter.text, "--% | ? / 65,536");
  assert.strictEqual(app.run("llamacppTokenState.used"), null);
});

test("clearing Pi's usage clears its window too", () => {
  const app = makeApp();
  app.run(
    `piTokenState = { used: 5000, total: 272000 }; forgetTokenUsage("pi")`,
  );
  assert.deepStrictEqual(
    { ...app.run("piTokenState") },
    { used: null, total: null },
  );
  app.run(
    `ollamaTokenState = { used: 5000, total: 8192 }; forgetTokenUsage("ollama")`,
  );
  assert.deepStrictEqual(
    { ...app.run("ollamaTokenState") },
    { used: null, total: 8192 },
  );
});

test("Pi is not asked while the session is still loading", async () => {
  const app = makeApp({
    responder: () => ({
      status: { contextUsage: { used: 1, total: 2, percent: 50 } },
    }),
  });
  app.run(`
    mode = "pi";
    currentConvId = "conv_b";
    piSessionLoadingConvId = "conv_b";
    history = [{ role: "user", content: "x" }];
  `);
  await app.run(`refreshPiStatus()`);
  assert.strictEqual(app.fetches.length, 0, "asked Pi mid-load");
  assert.strictEqual(app.run("modeStatusUpdates"), 1);
});

test("Pi's unknown usage after a compaction shows as unknown", async () => {
  const app = makeApp({
    responder: () => ({
      status: { contextUsage: { used: null, total: 272000, percent: null } },
    }),
  });
  app.run(`
    mode = "pi";
    currentConvId = "conv_a";
    history = [{ role: "user", content: "x" }];
    piTokenState = { used: 250000, total: 272000 };
  `);
  await app.run(`refreshPiStatus()`);
  assert.deepStrictEqual(
    { ...app.run("piTokenState") },
    { used: null, total: 272000 },
  );
  assert.strictEqual(app.counter.text, "--% | ? / 272,000");
  assert.strictEqual(app.counter.critical, false);
});

test("a Pi status for a conversation the user has left is dropped", async () => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const app = makeApp({
    responder: () =>
      held.then(() => ({
        status: {
          contextUsage: { used: 260000, total: 272000, percent: 95.6 },
        },
      })),
  });
  app.run(`mode = "pi"; currentConvId = "conv_a"`);
  const refreshing = app.run(`refreshPiStatus()`);
  // The user opens another conversation before the answer arrives.
  app.run(`
    currentConvId = "conv_b";
    piTokenState = { used: 1200, total: 272000 };
  `);
  await app.run(`updateTokenCounter()`);
  release();
  await refreshing;
  assert.deepStrictEqual(
    { ...app.run("piTokenState") },
    { used: 1200, total: 272000 },
    "conv_a's status replaced conv_b's usage",
  );
  assert.strictEqual(app.counter.text, "0.4% | 1,200 / 272,000");
});

test("the counter never asks Pi itself", () => {
  // The server takes one stats request per Pi process at a time. A lookup of
  // the counter's own raced refreshPiStatus and made the side panel's fail.
  const app = makeApp({ responder: () => ({ status: {} }) });
  app.run(`
    mode = "pi";
    currentConvId = "conv_a";
    history = [{ role: "user", content: "x" }];
    forgetTokenUsage("pi");
    updateTokenCounter();
  `);
  assert.strictEqual(app.fetches.length, 0);
  assert.strictEqual(app.counter.text, "--% | ? / ?");
});

test("switching Pi chats shows unknown until Pi answers for the new one", async () => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const app = makeApp({
    responder: () =>
      held.then(() => ({
        status: { contextUsage: { used: 19891, total: 272000, percent: 7.31 } },
      })),
  });
  app.run(`
    mode = "pi";
    currentConvId = "conv_a";
    history = [{ role: "user", content: "x" }];
    piTokenState = { used: 19829, total: 272000 };
    updateTokenCounter();
  `);
  assert.strictEqual(app.counter.text, "7.3% | 19,829 / 272,000");

  // loadConversation for conv_b: drop conv_a's figure, redraw, ask Pi.
  app.run(
    `currentConvId = "conv_b"; forgetTokenUsage("pi"); updateTokenCounter()`,
  );
  const refreshing = app.run(`refreshPiStatus()`);
  assert.strictEqual(
    app.counter.text,
    "--% | ? / ?",
    "conv_a's figure stayed up while Pi was asked about conv_b",
  );
  release();
  await refreshing;
  assert.strictEqual(app.counter.text, "7.3% | 19,891 / 272,000");
  assert.strictEqual(app.fetches.length, 1, "Pi was asked more than once");
});
