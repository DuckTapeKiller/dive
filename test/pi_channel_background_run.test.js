// Records on the Pi event channel that arrive with no turn running.
//
// After a reply settles, Pi can still send a notice, status line or widget
// frame from an extension. The server forwards it with no turn attached, and
// no done ever follows it. It must still be shown and saved with the last
// answer, only ever added to what that answer already holds, and it must
// never make the composer busy: a run that waits for a done that never comes
// queues every message the user types.
//
// These tests run the real assets/js/06-pi.js with the real trace block
// (addThinking), trace and history helpers from 05-history.js, and the real
// isGenerationActive() and abortActiveGeneration() from 07-chat.js, inside a
// vm with a small stand-in for the DOM.
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

// Just enough DOM for the trace block and the chat column.
class Element {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.parentElement = null;
    this.style = {};
    this.dataset = {};
    this.textContent = "";
    this.innerHTML = "";
    this.classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)),
      toggle: (name, on = !this.classes.has(name)) =>
        on ? this.classes.add(name) : this.classes.delete(name),
      contains: (name) => this.classes.has(name),
    };
  }
  get className() {
    return [...this.classes].join(" ");
  }
  set className(value) {
    this.classes = new Set(String(value).split(/\s+/).filter(Boolean));
  }
  appendChild(child) {
    return this.insertBefore(child, null);
  }
  append(...children) {
    children.forEach((child) => this.appendChild(child));
  }
  replaceChildren(...children) {
    this.children.forEach((child) => (child.parentElement = null));
    this.children = [];
    this.append(...children);
  }
  insertBefore(child, reference) {
    child.remove();
    const index = this.children.indexOf(reference);
    this.children.splice(index < 0 ? this.children.length : index, 0, child);
    child.parentElement = this;
    return child;
  }
  remove() {
    if (!this.parentElement) return;
    const siblings = this.parentElement.children;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentElement = null;
  }
  get isConnected() {
    for (let node = this; node; node = node.parentElement) {
      if (node.isRoot) return true;
    }
    return false;
  }
  get nextElementSibling() {
    const siblings = this.parentElement?.children || [];
    return siblings[siblings.indexOf(this) + 1] || null;
  }
  get lastElementChild() {
    return this.children[this.children.length - 1] || null;
  }
  matches(selector) {
    return selector
      .split(".")
      .filter(Boolean)
      .every((name) => this.classes.has(name));
  }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) {
      if (node.matches(selector)) return node;
    }
    return null;
  }
  querySelector(selector) {
    for (const child of this.children) {
      if (child.tagName === selector || child.matches(selector)) return child;
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }
  // Only ".msg-wrap.assistant > .msg.assistant" is asked for.
  querySelectorAll() {
    return this.children
      .filter((wrap) => wrap.matches(".msg-wrap.assistant"))
      .flatMap((wrap) =>
        wrap.children.filter((child) => child.matches(".msg.assistant")),
      );
  }
  setAttribute() {}
  addEventListener() {}
}

const HISTORY_FUNCTIONS = [
  "normalizeLibrarySourceResults",
  "mergeLibraryResultsWithPassages",
  "getMessageLibrarySources",
  "buildAssistantHistoryMessage",
  "cloneAssistantMetadata",
  "dedupeStatusTraceLines",
  "getAssistantMetadataFromMessage",
  "assistantBubbleHasContent",
  "formatStreamEventTraceLine",
  "compactExportTraceLine",
  "isThinkingExpandedByDefault",
  "stripMarkdownHeadingMarkers",
  "addThinking",
  "toolWidgetKey",
  "toolWidgetStartLines",
  "toolWidgetUpdateLines",
  "toolWidgetEndLines",
  "handleStreamEventTrace",
  "getActiveAbortController",
];

function makeClient() {
  const chat = new Element("div");
  chat.isRoot = true;
  const fetches = [];
  // What GET /api/conversations/id/... returns.
  let serverHistory = [];
  const session = {
    convId: "conv_test",
    activeAbortController: null,
    // The reply finished ten seconds ago, past the 1.5 s straggler gate.
    lastRunEndedAt: Date.now() - 10000,
    history: [],
    piEventSequences: {},
    lastThinkingController: null,
  };
  const context = {
    console,
    Date,
    Promise,
    setTimeout: () => 0,
    clearInterval() {},
    window: { setInterval: () => 1 },
    document: { createElement: (tag) => new Element(tag) },
    DOMPurify: { sanitize: (html) => html },
    marked: { parse: (text) => String(text) },
    chat,
    mode: "pi",
    currentConvId: "conv_test",
    history: [],
    piSettings: {},
    thinkingExpandedByMode: {},
    activePiPermissionRequest: null,
    getActiveModeSession: () => session,
    scrollChatToBottom() {},
    updateSendButtonState() {},
    refreshSidePanelRecent() {},
    scheduleQueueDrain() {},
    renderAssistantMessage() {},
    setDraftAssistant() {},
    refreshSideDownloads() {},
    finalizeDraftAssistant: () => ({ content: "" }),
    basenameFromPath: (value) =>
      String(value || "")
        .split("/")
        .pop(),
    uiRefreshFailed: () => () => {},
    apiUrl: (value) => value,
    renderSessionTranscript() {},
    readJsonResponse: (response) => response.json(),
    fetch: (url) => {
      if (url.startsWith("/api/conversations/id/")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ id: "conv_test", history: serverHistory }),
        });
      }
      fetches.push(url);
      return Promise.resolve({ ok: true });
    },
  };
  vm.createContext(context);
  const historySource = read("05-history.js");
  const chatSource = read("07-chat.js");
  vm.runInContext(
    [
      ...HISTORY_FUNCTIONS.map((name) => extractFunction(historySource, name)),
      extractFunction(chatSource, "isGenerationActive"),
      extractFunction(chatSource, "abortActiveGeneration"),
      extractFunction(chatSource, "reloadOpenConversationFromServer"),
    ].join("\n"),
    context,
    { filename: "05-07-extract.js" },
  );
  vm.runInContext(read("06-pi.js"), context, { filename: "06-pi.js" });
  const run = (code) => vm.runInContext(code, context);

  const bubble = (role) => {
    const wrap = new Element("div");
    wrap.className = `msg-wrap ${role}`;
    const message = new Element("div");
    message.className = `msg ${role}`;
    wrap.appendChild(message);
    chat.appendChild(wrap);
  };
  // One exchange as renderSessionTranscript draws it: the user bubble, the
  // answer's trace block when it has a trace, and the answer bubble when it
  // has text. Returns the trace block.
  const exchange = (question, answer) => {
    bubble("user");
    const saved = run("getAssistantMetadataFromMessage")(answer);
    const block =
      saved.traceLines.length || saved.traceEvents.length
        ? run("addThinking")({ ...saved, live: false, modeName: "pi" })
        : null;
    if (String(answer.content || "").trim()) bubble("assistant");
    session.history = [
      ...session.history,
      { role: "user", content: question },
      answer,
    ];
    context.history = session.history;
    return block;
  };
  let sequence = 0;
  return {
    session,
    exchange,
    // A streamed answer: its own live block stays the last trace block.
    liveExchange(question, answer) {
      session.lastThinkingController = exchange(question, answer);
    },
    deliver(evt) {
      context.__evt = {
        convId: "conv_test",
        epoch: "e1",
        sequence: ++sequence,
        ...evt,
      };
      run("handlePiChannelEvent(__evt)");
    },
    setServerHistory(turns) {
      serverHistory = turns;
    },
    // The page reloading the open conversation after a server-side save.
    reload: () => run("reloadOpenConversationFromServer('conv_test')"),
    run,
    runOpen: () => run("piChannelRun !== null"),
    busy: () => run("isGenerationActive()"),
    stop: () => run("abortActiveGeneration()"),
    // What beginIsolatedTurn does before every send.
    beginTurn: () => run("finalizePiChannelRun()"),
    blocks: () => chat.children.map((child) => child.className.split(" ")[0]),
    turn: (index) => session.history[index],
    fetches,
  };
}

const STEPS = [
  { type: "tool_start", toolName: "bash", toolCallId: "t1", argsPreview: "ls" },
  { type: "tool_end", toolName: "bash", toolCallId: "t1", outputPreview: "a" },
  { type: "pi_widget", key: "fleet", lines: ["fleet: 2 running"] },
];
const answer = (extra = {}) => ({
  role: "assistant",
  content: "a1",
  thinking: "reasoned",
  traceEvents: STEPS.map((step) => ({ ...step })),
  status: "done",
  ...extra,
});
const NOTICE = { type: "pi_notice", noticeType: "info", message: "Saved" };
const WAKE = [
  { type: "tool_start", toolName: "read", toolCallId: "w1", sessionId: "w" },
  { type: "tool_end", toolName: "read", toolCallId: "w1", sessionId: "w" },
];
// The server marks a session's done as completed when it sends it.
const WAKE_DONE = {
  type: "done",
  response: "",
  sessionId: "w",
  completed: true,
};
// The chat for one answer with its own trace block.
const ONE_BLOCK = ["msg-wrap", "thinking-wrap", "msg-wrap"];
const kinds = (message) =>
  (message.traceEvents || []).map((evt) =>
    [evt.type, evt.key, evt.message, ...(evt.lines || [])]
      .filter(Boolean)
      .join(":"),
  );

test("a late notice, status line or widget frame: shown, saved, composer free", () => {
  for (const evt of [
    NOTICE,
    { type: "pi_status", key: "job", text: "working" },
    { type: "pi_widget", key: "fleet", lines: ["fleet: done"] },
  ]) {
    const client = makeClient();
    client.liveExchange("q1", answer());
    client.deliver(evt);
    assert.equal(client.runOpen(), false, `${evt.type} left a run open`);
    assert.equal(client.busy(), false, `${evt.type} made the composer busy`);
    // Enter with text calls stopActiveGeneration() first; it must find
    // nothing to stop, or the message would not be sent.
    assert.equal(client.stop(), false, `${evt.type} swallowed the send`);
    assert.deepEqual(client.fetches, []);
    // Shown in the answer's own trace block, not a new one.
    assert.deepEqual(client.blocks(), ONE_BLOCK);
    const saved = kinds(client.turn(1));
    assert.deepEqual(saved.slice(0, 2), ["tool_start", "tool_end"]);
    assert.ok(
      saved.some((kind) => kind.startsWith(evt.type)),
      "not saved",
    );
  }
});

test("a notice right after the reply is shown and saved too", () => {
  const client = makeClient();
  client.liveExchange("q1", answer());
  client.session.lastRunEndedAt = Date.now() - 200;
  client.deliver(NOTICE);
  assert.ok(kinds(client.turn(1)).includes("pi_notice:Saved"));
  assert.equal(client.busy(), false);
});

test("a notice keeps the answer's own status, thinking and text", () => {
  const client = makeClient();
  client.liveExchange("q1", answer({ status: "error" }));
  client.deliver(NOTICE);
  const saved = client.turn(1);
  assert.equal(saved.status, "error");
  assert.equal(saved.thinking, "reasoned");
  assert.equal(saved.content, "a1");
});

test("after a reopen, late records only add to the answer's saved steps", () => {
  const client = makeClient();
  client.exchange("q1", answer());
  client.deliver({ type: "pi_status", key: "sandbox", text: "on" });
  client.deliver({ type: "pi_widget", key: "fleet", lines: ["fleet: done"] });
  client.deliver(NOTICE);
  client.beginTurn();
  assert.deepEqual(kinds(client.turn(1)), [
    "tool_start",
    "tool_end",
    "pi_status:sandbox",
    "pi_widget:fleet:fleet: done",
    "pi_notice:Saved",
  ]);
  // One block of their own, above the answer.
  assert.deepEqual(client.blocks(), [
    "msg-wrap",
    "thinking-wrap",
    "thinking-wrap",
    "msg-wrap",
  ]);
});

test("after a tool-only turn, late records go to that turn's block", () => {
  const client = makeClient();
  client.exchange("q0", { role: "assistant", content: "a0", status: "done" });
  client.liveExchange("q1", answer({ content: "" }));
  client.deliver(NOTICE);
  client.deliver({ ...NOTICE, message: "Again" });
  assert.deepEqual(client.blocks(), [
    "msg-wrap",
    "msg-wrap",
    "msg-wrap",
    "thinking-wrap",
  ]);
  assert.deepEqual(kinds(client.turn(3)).slice(-2), [
    "pi_notice:Saved",
    "pi_notice:Again",
  ]);
  assert.deepEqual(kinds(client.turn(1)), []);
});

test("a slash command, then a notice: saved on its answer, kept on send", () => {
  const client = makeClient();
  client.liveExchange("q1", answer());
  client.exchange("/help", { role: "assistant", content: "help text" });
  client.deliver(NOTICE);
  client.beginTurn();
  assert.deepEqual(
    client.session.history.map((message) => message.content),
    ["q1", "a1", "/help", "help text"],
  );
  assert.deepEqual(kinds(client.turn(3)), ["pi_notice:Saved"]);
  assert.deepEqual(kinds(client.turn(1)), [
    "tool_start",
    "tool_end",
    "pi_widget:fleet:fleet: 2 running",
  ]);
});

test("a slash command, a notice, then a background turn: nothing lost", () => {
  const client = makeClient();
  client.liveExchange("q1", answer());
  client.exchange("/help", { role: "assistant", content: "help text" });
  client.deliver(NOTICE);
  assert.equal(client.busy(), false);
  client.deliver(WAKE[0]);
  assert.equal(client.busy(), true);
  client.deliver(WAKE[1]);
  client.deliver(WAKE_DONE);
  assert.equal(client.busy(), false);
  assert.deepEqual(kinds(client.turn(3)), [
    "pi_notice:Saved",
    "tool_start",
    "tool_end",
  ]);
  assert.equal(client.turn(3).thinking || "", "");
  assert.deepEqual(kinds(client.turn(1)), [
    "tool_start",
    "tool_end",
    "pi_widget:fleet:fleet: 2 running",
  ]);
});

test("a page reload does not add a saved notice a second time", () => {
  const client = makeClient();
  const saved = { ...NOTICE, message: "Old", sequence: 5, epoch: "e1" };
  client.exchange("q1", answer({ traceEvents: [...STEPS, saved] }));
  client.deliver({ ...saved, replay: true });
  client.deliver({
    ...NOTICE,
    message: "New",
    sequence: 9,
    epoch: "e1",
    replay: true,
  });
  const notices = kinds(client.turn(1)).filter((kind) =>
    kind.startsWith("pi_notice"),
  );
  assert.deepEqual(notices, ["pi_notice:Old", "pi_notice:New"]);
});

test("a clear widget frame with nothing on screen adds no empty block", () => {
  const client = makeClient();
  client.exchange("q1", answer());
  client.deliver({ type: "pi_widget", key: "fleet", lines: null });
  assert.deepEqual(client.blocks(), ONE_BLOCK);
  assert.equal(client.turn(1).traceEvents.length, STEPS.length);
});

test("records from a turn that already finished start nothing", () => {
  const client = makeClient();
  client.liveExchange("q1", answer());
  client.deliver({ type: "tool_start", sessionId: "s", completed: true });
  client.deliver({ ...NOTICE, sessionId: "s", completed: true });
  assert.equal(client.runOpen(), false);
  assert.equal(client.busy(), false);
  assert.equal(client.turn(1).traceEvents.length, STEPS.length);
});

test("a background turn after a reply runs in its block and ends on done", () => {
  const client = makeClient();
  client.liveExchange("q1", answer());
  client.deliver(WAKE[0]);
  assert.equal(client.busy(), true);
  client.deliver(WAKE[1]);
  client.deliver(WAKE_DONE);
  assert.equal(client.busy(), false);
  assert.deepEqual(client.blocks(), ONE_BLOCK);
  assert.deepEqual(kinds(client.turn(1)).slice(-2), ["tool_start", "tool_end"]);
});

test("Stop still stops a real background turn", () => {
  const client = makeClient();
  client.liveExchange("q1", answer());
  client.deliver(WAKE[0]);
  assert.equal(client.stop(), true);
  assert.deepEqual(client.fetches, ["/api/pi/command"]);
  assert.equal(client.busy(), false);
});

test("a notice during a live background turn is handed to that turn", () => {
  const client = makeClient();
  client.liveExchange("q1", answer());
  client.deliver(WAKE[0]);
  client.deliver(NOTICE);
  assert.equal(client.busy(), true);
  client.deliver(WAKE_DONE);
  assert.ok(kinds(client.turn(1)).includes("pi_notice:Saved"));
});

// The server's copy after it saved a background turn: the answer with the
// turn's steps appended, and none of the notices the page showed.
const SAVED_WAKE = [
  { type: "tool_start", toolName: "read", toolCallId: "w1" },
  { type: "tool_end", toolName: "read", toolCallId: "w1" },
];
const serverCopyAfterWake = (extraEvents = []) => [
  { role: "user", content: "q1" },
  answer({
    traceEvents: [...STEPS, ...SAVED_WAKE, ...extraEvents],
    status: "async_wake",
  }),
];
// Let the page's fetch-then chains finish.
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a notice survives the reload after a background turn is saved", async () => {
  const client = makeClient();
  client.liveExchange("q1", answer());
  client.deliver(NOTICE);
  client.setServerHistory(serverCopyAfterWake());
  await client.reload();
  const saved = client.turn(1);
  assert.deepEqual(kinds(saved), [
    "tool_start",
    "tool_end",
    "pi_widget:fleet:fleet: 2 running",
    "tool_start",
    "tool_end",
    "pi_notice:Saved",
  ]);
  assert.equal(saved.status, "async_wake");
  assert.ok(saved.traceLines.some((line) => line.includes("Notice: Saved")));
});

test("a notice the server already saved is not added again", async () => {
  const client = makeClient();
  client.liveExchange("q1", answer());
  client.deliver(NOTICE);
  const stored = client.turn(1).traceEvents.at(-1);
  client.setServerHistory(serverCopyAfterWake([stored]));
  await client.reload();
  const notices = kinds(client.turn(1)).filter((kind) =>
    kind.startsWith("pi_notice"),
  );
  assert.deepEqual(notices, ["pi_notice:Saved"]);
});

test("a notice is never put back on a different answer", async () => {
  const client = makeClient();
  client.liveExchange("q1", answer());
  client.deliver(NOTICE);
  const changed = serverCopyAfterWake();
  changed[0] = { role: "user", content: "another question" };
  client.setServerHistory(changed);
  await client.reload();
  assert.ok(!kinds(client.turn(1)).includes("pi_notice:Saved"));
});

test("a notice survives the replay-gap reconcile", async () => {
  const client = makeClient();
  client.liveExchange("q1", answer());
  client.deliver(NOTICE);
  client.setServerHistory(serverCopyAfterWake());
  client.deliver({ type: "replay_gap" });
  await settle();
  assert.ok(kinds(client.turn(1)).includes("pi_notice:Saved"));
});

test("a notice shown during a reconcile goes on the reconciled last answer", async () => {
  const client = makeClient();
  client.liveExchange("q1", answer());
  // Meanwhile another window added a turn.
  client.setServerHistory([
    { role: "user", content: "q1" },
    answer(),
    { role: "user", content: "q2" },
    answer({ content: "a2" }),
  ]);
  client.deliver({ type: "replay_gap" });
  client.deliver({ ...NOTICE, replay: true });
  await settle();
  assert.ok(kinds(client.turn(3)).includes("pi_notice:Saved"));
  assert.ok(!kinds(client.turn(1)).includes("pi_notice:Saved"));
});

test("past the server's 200-message limit the notice still comes back", async () => {
  const client = makeClient();
  for (let i = 0; i < 100; i += 1) {
    client.session.history.push(
      { role: "user", content: `old q${i}` },
      { role: "assistant", content: `old a${i}` },
    );
  }
  client.liveExchange("q1", answer());
  // The server keeps only the last 200 messages, without the notice.
  client.setServerHistory(client.session.history.slice(-200));
  client.deliver(NOTICE);
  await client.reload();
  assert.ok(kinds(client.session.history.at(-1)).includes("pi_notice:Saved"));
});

// A tool-only answer: no text, recognised by a step it held.
const toolOnly = (callId, sequence) =>
  answer({
    content: "",
    traceEvents: [
      { type: "tool_start", toolCallId: callId, epoch: "e1", sequence },
    ],
  });

test("an answer with no text gets back only its own notice", async () => {
  const client = makeClient();
  client.liveExchange("q1", toolOnly("t1", 1));
  client.deliver(NOTICE);
  // Regenerated: same place, same question, a different answer.
  client.setServerHistory([
    { role: "user", content: "q1" },
    toolOnly("t9", 40),
  ]);
  await client.reload();
  assert.ok(!kinds(client.turn(1)).includes("pi_notice:Saved"));
  // The original answer, filled in by the background turn, gets it back.
  client.setServerHistory([
    { role: "user", content: "q1" },
    { ...toolOnly("t1", 1), content: "wake text" },
  ]);
  await client.reload();
  assert.ok(kinds(client.turn(1)).includes("pi_notice:Saved"));
});

// The header line of a trace block ("Working…", "Finished in 3s").
const header = (block) =>
  block.element.children.find((child) => child.classes.has("thinking"));

test("a finished turn's header says how long it took, not Working", () => {
  const client = makeClient();
  const live = client.run("addThinking")({ live: true, modeName: "pi" });
  assert.match(header(live).textContent, /^Working\.\.\. /);
  client.run("handleStreamEventTrace")({ type: "done" }, live);
  assert.match(header(live).textContent, /^Finished in \d+s$/);
  const stopped = client.run("addThinking")({ live: true, modeName: "pi" });
  stopped.markFinished("Stopped after");
  assert.match(header(stopped).textContent, /^Stopped after \d+s$/);
  const failed = client.run("addThinking")({ live: true, modeName: "pi" });
  failed.markFailure("boom");
  failed.markFinished();
  assert.equal(header(failed).textContent, "Failed — see Execution Trace");
});

test("a saved turn's trace block shows no Working label", () => {
  const client = makeClient();
  const saved = client.run("addThinking")({
    live: false,
    modeName: "pi",
    traceLines: ["Turn: m"],
  });
  assert.equal(header(saved).style.display, "none");
});

test("a trace rebuilt from saved events reads like the live one", () => {
  const client = makeClient();
  const { traceLines } = client.run("getAssistantMetadataFromMessage")({
    role: "assistant",
    content: "a1",
    traceEvents: [
      { type: "pi_usage", model: "m", input: 10, output: 5 },
      { type: "pi_notice", message: "Saved" },
      { type: "pi_status", key: "job", text: "done" },
    ],
  });
  assert.deepEqual(traceLines, [
    "Turn: m · ↑10 · ↓5",
    "Notice: Saved",
    "Status · job: done",
  ]);
});

test("a notice put back after a reload sits where it happened", async () => {
  const client = makeClient();
  client.liveExchange(
    "q1",
    answer({
      traceEvents: [
        { type: "pi_usage", model: "m", input: 1, epoch: "e1", sequence: 1 },
      ],
    }),
  );
  client.deliver({ ...NOTICE, sequence: 2 });
  // The background turn's usage came after the notice.
  client.setServerHistory([
    { role: "user", content: "q1" },
    answer({
      traceEvents: [
        { type: "pi_usage", model: "m", input: 1, epoch: "e1", sequence: 1 },
        { type: "pi_usage", model: "m", input: 2, epoch: "e1", sequence: 3 },
      ],
      status: "async_wake",
    }),
  ]);
  await client.reload();
  assert.deepEqual(client.turn(1).traceLines, [
    "Turn: m · ↑1",
    "Notice: Saved",
    "Turn: m · ↑2",
  ]);
});
