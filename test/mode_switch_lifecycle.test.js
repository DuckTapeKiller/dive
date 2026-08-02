// D1/D3: mode switching and abort, from the client's side.
//
// modeSession[mode] is the per-mode store, but `history`, `currentConvId`,
// `lastUserMessage` and `lastSentMessage` are module-level globals holding the
// ACTIVE mode's copy, kept in sync by hand — syncCurrentSessionState pushes
// globals into the session, setMode pulls them back out. That is the same
// pattern as the stale aliases removed in Phase 2, just via a different
// container, so these tests check it cannot drift.
const assert = require("assert");
const fs = require("fs");
const test = require("node:test");
const { JSDOM, VirtualConsole } = require("jsdom");
const { MODE_IDS } = require("../assets/js/00-modes.js");

const VENDOR = {
  "marked.umd.js": "node_modules/marked/marked.min.js",
  "purify.min.js": "node_modules/dompurify/dist/purify.min.js",
  "highlight.min.js": "node_modules/@highlightjs/cdn-assets/highlight.min.js",
};
const html = fs
  .readFileSync("index.html", "utf8")
  .replace(
    /<script src="\/assets\/(js\/[^"]+)"><\/script>/g,
    (_m, rel) => `<script>${fs.readFileSync(`assets/${rel}`, "utf8")}</script>`,
  )
  .replace(/<script src="\/vendor\/([^"]+)"><\/script>/g, (_m, name) => {
    const file = VENDOR[name];
    return file && fs.existsSync(file)
      ? `<script>${fs.readFileSync(file, "utf8")}</script>`
      : "";
  });

const json = (body) =>
  Promise.resolve({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });

const openWindows = [];
test.after(() => {
  // Each JSDOM instance keeps timers running; without this the suite finishes
  // its assertions and then hangs forever.
  for (const w of openWindows) {
    try {
      w.close();
    } catch (_e) {
      // already torn down
    }
  }
});

function boot() {
  const dom = new JSDOM(html, {
    url: "http://localhost/",
    runScripts: "dangerously",
    virtualConsole: new VirtualConsole(),
    beforeParse(w) {
      w.fetch = (u) => {
        const p = new URL(
          String(u).replace("http://localhost", ""),
          "http://localhost",
        ).pathname;
        if (p === "/api/prompts") return json([]);
        if (p === "/api/version") return json({ version: "1.0.5" });
        if (p === "/api/custom-skills") return json({ skills: [] });
        if (p === "/api/ollama/skills/settings") return json({ settings: {} });
        return json({});
      };
      w.alert = () => {};
      w.scrollTo = () => {};
      w.EventSource = class {
        close() {}
      };
    },
  });
  openWindows.push(dom.window);
  return dom.window;
}

const settle = () => new Promise((r) => setTimeout(r, 60));

test("the active-mode globals always match that mode's session", async () => {
  const w = boot();
  await settle();

  // Give every mode a distinct conversation and history.
  for (const id of MODE_IDS) {
    w.eval(`
      setMode(${JSON.stringify(id)});
      currentConvId = ${JSON.stringify("conv-" + id)};
      history = [{ role: "user", content: ${JSON.stringify("q-" + id)} },
                 { role: "assistant", content: "a" }];
      lastUserMessage = ${JSON.stringify("last-" + id)};
      syncCurrentSessionState();
    `);
    await settle();
  }

  // Two full passes: a one-pass check would miss state that only goes stale
  // after returning to a mode.
  for (let pass = 0; pass < 2; pass++) {
    for (const id of MODE_IDS) {
      w.eval(`setMode(${JSON.stringify(id)})`);
      await settle();
      const state = JSON.parse(
        w.eval(`JSON.stringify({
          mode,
          convId: currentConvId,
          sessionConvId: modeSession[mode].convId,
          firstMessage: history[0] ? history[0].content : null,
          sessionFirst: modeSession[mode].history[0]
            ? modeSession[mode].history[0].content : null,
          lastUser: lastUserMessage,
          sessionLastUser: modeSession[mode].lastUserMessage,
        })`),
      );
      assert.strictEqual(state.mode, id);
      assert.strictEqual(
        state.convId,
        state.sessionConvId,
        `${id} pass ${pass}: currentConvId drifted from the session`,
      );
      assert.strictEqual(
        state.firstMessage,
        state.sessionFirst,
        `${id} pass ${pass}: history drifted from the session`,
      );
      assert.strictEqual(
        state.lastUser,
        state.sessionLastUser,
        `${id} pass ${pass}: lastUserMessage drifted from the session`,
      );
      assert.strictEqual(
        state.convId,
        `conv-${id}`,
        `${id}: wrong conversation`,
      );
    }
  }
});

test("leaving a mode mid-run does not rebind the run to the viewed conversation", async () => {
  // The detached-view guard in syncCurrentSessionState: while a run is active
  // and the user is looking at a different conversation of that mode, leaving
  // must keep the run's own conversation, or the streaming reply lands in the
  // wrong place.
  const w = boot();
  await settle();

  w.eval(`
    setMode("ollama");
    const s = getActiveModeSession("ollama");
    s.convId = "running-conv";
    s.history = [{ role: "user", content: "streaming" }];
    s.activeAbortController = new AbortController();
    currentConvId = "some-other-conv";   // user navigated away in-mode
    history = [{ role: "user", content: "browsing" }];
  `);
  w.eval('setMode("cloud")');
  await settle();

  assert.strictEqual(
    w.eval("modeSession.ollama.convId"),
    "running-conv",
    "the active run was rebound to the conversation the user was browsing",
  );
  assert.strictEqual(
    w.eval("modeSession.ollama.history[0].content"),
    "streaming",
    "the browsed history overwrote the running conversation's history",
  );

  // Returning snaps back to the running conversation.
  w.eval('setMode("ollama")');
  await settle();
  assert.strictEqual(w.eval("currentConvId"), "running-conv");
});

test("switching away mid-run leaves the other mode's state untouched", async () => {
  const w = boot();
  await settle();
  w.eval(`
    setMode("cloud");
    currentConvId = "cloud-conv";
    history = [{ role: "user", content: "cloud-question" }];
    syncCurrentSessionState();
    setMode("ollama");
    const s = getActiveModeSession("ollama");
    s.activeAbortController = new AbortController();
    currentConvId = "ollama-running";
    history = [{ role: "user", content: "ollama-question" }];
  `);
  w.eval('setMode("cloud")');
  await settle();

  assert.strictEqual(
    w.eval("currentConvId"),
    "cloud-conv",
    "an active run in another mode leaked its conversation id",
  );
  assert.strictEqual(
    w.eval("history[0].content"),
    "cloud-question",
    "an active run in another mode leaked its history",
  );
});

test("abortActiveGeneration reports whether there was anything to stop", async () => {
  const w = boot();
  await settle();
  w.eval('setMode("ollama")');
  await settle();

  assert.strictEqual(
    w.eval("abortActiveGeneration()"),
    false,
    "Stop claimed to abort something when nothing was running",
  );

  const aborted = w.eval(`
    const s = getActiveModeSession("ollama");
    let seen = false;
    s.activeAbortController = new AbortController();
    s.activeAbortController.signal.addEventListener("abort", () => { seen = true; });
    const result = abortActiveGeneration();
    JSON.stringify({ result: result === true, seen });
  `);
  const { result, seen } = JSON.parse(aborted);
  assert.strictEqual(result, true, "Stop did not report aborting a live run");
  assert.strictEqual(seen, true, "Stop did not fire the abort signal");
});
