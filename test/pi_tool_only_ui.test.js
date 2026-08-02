// Does a tool-only Pi turn show the user anything?
//
// The turn under test is the one that prompted this: Pi runs a tool and never
// emits reasoning text or an answer. Two earlier changes bear on it — the drum
// placeholder bubble was removed, and the thinking bubble was made conditional
// on the model actually reasoning. The open question was whether those together
// left such a turn with no visible indication at all.
//
// Scope, stated honestly: jsdom builds the DOM but does no layout and applies
// no stylesheet cascade, so these tests prove the element is created, carries
// the right text, and survives. They CANNOT prove it is visible on screen — a
// CSS rule that hides .thinking, a z-index problem, or an off-screen mount
// would pass every assertion here. That part needs the running app.
const assert = require("assert");
const fs = require("fs");
const test = require("node:test");
const { JSDOM, VirtualConsole } = require("jsdom");

const VENDOR = {
  "marked.umd.js": "node_modules/marked/lib/marked.umd.js",
  "purify.min.js": "node_modules/dompurify/dist/purify.min.js",
  "highlight.min.js": "node_modules/@highlightjs/cdn-assets/highlight.min.js",
};
// Loading these is not optional here: the trace panel renders through marked,
// so a missing bundle turns every assertion into a ReferenceError inside an
// error handler, which then hides the failure that triggered it.
for (const [name, file] of Object.entries(VENDOR)) {
  if (!fs.existsSync(file)) {
    throw new Error(`vendor bundle missing for ${name}: ${file}`);
  }
}
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

// Per-event pacing for the fake stream, so the live phase label can be
// sampled mid-run instead of only after "done".
const CHUNK_MS = 40;

const openWindows = [];
test.after(() => {
  for (const w of openWindows) {
    try {
      w.close();
    } catch (_e) {
      // already torn down
    }
  }
});

// The Pi turn this file is about: a tool runs, nothing is reasoned, nothing is
// answered. No thinking_start/thinking_delta and no delta events anywhere.
const TOOL_ONLY_STREAM = [
  { type: "session_start", sessionId: "s1" },
  { type: "tool_start", toolName: "web_search", toolCallId: "c1" },
  { type: "tool_end", toolCallId: "c1", toolName: "web_search", ok: true },
  { type: "done", response: "" },
];

function boot(streamEvents) {
  const sent = [];
  const dom = new JSDOM(html, {
    url: "http://localhost/",
    runScripts: "dangerously",
    virtualConsole: new VirtualConsole(),
    beforeParse(w) {
      const json = (body) =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: async () => body,
          text: async () => JSON.stringify(body),
        });

      w.fetch = (u) => {
        const p = new URL(
          String(u).replace("http://localhost", ""),
          "http://localhost",
        ).pathname;
        sent.push(p);

        if (p === "/api/pi/stream") {
          // One event per chunk, paced. The phase label is live — it advances
          // as events arrive — so a stream delivered in a single chunk only
          // ever exposes its final state, and "Running <tool>" would be
          // invisible to any assertion. The delay gives the test room to
          // observe the run rather than just its end.
          const text = streamEvents
            .map((e) => JSON.stringify(e) + "\n")
            .join("");
          let i = 0;
          return Promise.resolve({
            ok: true,
            status: 200,
            body: {
              getReader: () => ({
                read: async () => {
                  if (i >= streamEvents.length) {
                    return { done: true, value: undefined };
                  }
                  const line = JSON.stringify(streamEvents[i++]) + "\n";
                  await new Promise((r) => w.setTimeout(r, CHUNK_MS));
                  // Encoded in the window's realm so the page's TextDecoder
                  // gets a Uint8Array it recognises.
                  return {
                    done: false,
                    value: w.Uint8Array.from(line, (c) => c.charCodeAt(0)),
                  };
                },
                cancel: () => {},
                releaseLock: () => {},
              }),
            },
            text: async () => text,
          });
        }

        if (p === "/api/prompts") return json([]);
        if (p === "/api/version") return json({ version: "1.0.5" });
        if (p === "/api/custom-skills") return json({ skills: [] });
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
  return { w: dom.window, sent };
}

const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));

// Run one Pi turn to completion and return a snapshot of what the user sees.
async function runToolOnlyTurn(streamEvents = TOOL_ONLY_STREAM) {
  const { w, sent } = boot(streamEvents);
  await settle();
  w.eval('setMode("pi")');
  await settle();
  w.eval('input.value = "search for something";');
  w.eval("sendMessage();");

  // Poll while the stream drips. The phase label is transient, so what the user
  // saw over the turn is the sequence, not the final frame.
  const phases = [];
  for (let i = 0; i < 60; i++) {
    const t = w.eval(`(function () {
      const el = document.querySelector(".thinking-wrap .thinking");
      return el ? el.textContent : "";
    })()`);
    if (t && phases[phases.length - 1] !== t) phases.push(t);
    await settle(20);
  }

  const snapshot = JSON.parse(
    w.eval(`(function () {
      const wrap = document.querySelector(".thinking-wrap");
      const plain = wrap ? wrap.querySelector(".thinking") : null;
      const details = wrap
        ? Array.from(wrap.querySelectorAll("details.thinking-details"))
        : [];
      const assistants = Array.from(
        document.querySelectorAll(".msg.assistant"),
      );
      return JSON.stringify({
        hasWrap: !!wrap,
        wrapConnected: !!(wrap && wrap.isConnected),
        plainText: plain ? plain.textContent : null,
        plainClass: plain ? plain.className : null,
        detailsShown: details.map((d) => ({
          summary: d.querySelector("summary")
            ? d.querySelector("summary").textContent
            : "",
          display: d.style.display,
          bodyText: (d.querySelector("div") || {}).textContent || "",
        })),
        assistantCount: assistants.length,
        assistantTexts: assistants.map((a) => (a.textContent || "").trim()),
        assistantRaw: assistants.map(
          (a) => a.getAttribute("data-raw-text") || "",
        ),
        transcriptText: (chat.textContent || "").trim(),
      });
    })()`),
  );
  return { w, sent, snapshot, phases };
}

test("a tool-only Pi turn reaches the server and streams tool events", async () => {
  // Guards the fixture itself: if sendMessage never called /api/pi/stream, the
  // assertions below would be describing an idle page, not a Pi turn.
  const { sent } = await runToolOnlyTurn();
  assert.ok(
    sent.includes("/api/pi/stream"),
    `the Pi turn never started; requests were: ${[...new Set(sent)].join(", ")}`,
  );
});

test("the fixture really is tool-only: no reasoning and no answer text", async () => {
  // Criterion 6. If this fixture ever gains a delta or thinking event it stops
  // testing the case it exists for, and every other assertion here goes soft.
  const types = TOOL_ONLY_STREAM.map((e) => e.type);
  assert.ok(types.includes("tool_start"), "fixture has no tool event");
  for (const forbidden of ["delta", "thinking_start", "thinking_delta"]) {
    assert.ok(
      !types.includes(forbidden),
      `fixture emits ${forbidden}, so it is not a tool-only turn`,
    );
  }
  const done = TOOL_ONLY_STREAM.find((e) => e.type === "done");
  assert.strictEqual(done.response, "", "fixture answers with text");
});

test("a tool-only Pi turn creates an activity element", async () => {
  // Criterion 1.
  const { snapshot } = await runToolOnlyTurn();
  assert.ok(
    snapshot.hasWrap && snapshot.wrapConnected,
    "no .thinking-wrap in the document: a tool-only Pi turn shows nothing",
  );
  assert.ok(
    snapshot.plainText && snapshot.plainText.trim().length > 0,
    `the activity line is empty: ${JSON.stringify(snapshot.plainText)}`,
  );
});

test("the activity element names the tool while it is running", async () => {
  // Criterion 2. "Working..." alone would be a spinner by another name; the
  // point of the panel is that it says what is happening.
  //
  // The label is live: after tool_end it advances to "Processing result", so
  // the finished turn does not name the tool and never could. What matters is
  // that the user saw it during the run, so the whole sequence is checked.
  const { phases } = await runToolOnlyTurn();
  assert.ok(
    phases.some((p) => /web_search/.test(p)),
    `the tool was never named while it ran; phases seen: ${JSON.stringify(phases)}`,
  );
});

test("a tool-only Pi turn creates no empty assistant answer bubble", async () => {
  // Criterion 3. This is the drum bug's invariant: no answer, no bubble.
  const { snapshot } = await runToolOnlyTurn();
  const empties = snapshot.assistantTexts.filter((t) => t.length === 0);
  assert.strictEqual(
    empties.length,
    0,
    `${empties.length} empty assistant bubble(s) were created: raw=${JSON.stringify(snapshot.assistantRaw)}`,
  );
});

test("the activity element survives the end of the turn", async () => {
  // Criterion 4. The stream has already sent "done" by the time the snapshot is
  // taken, so a panel that is torn down on completion fails here.
  const { snapshot } = await runToolOnlyTurn();
  assert.ok(
    snapshot.wrapConnected,
    "the activity element was removed when the turn finished, leaving the turn blank",
  );
});

test("no empty reasoning panel is shown when Pi did not reason", async () => {
  // Criterion 7, from the standing instruction: when the model does not produce
  // thinking, the thinking bubble must not exist. A panel forced open with an
  // empty body is the thing that was explicitly rejected.
  const { snapshot } = await runToolOnlyTurn();
  const openReasoning = snapshot.detailsShown.filter(
    (d) => /Thinking/i.test(d.summary) && d.display !== "none",
  );
  for (const d of openReasoning) {
    assert.ok(
      d.bodyText.trim().length > 0,
      "an empty reasoning panel was shown for a turn with no reasoning",
    );
  }
});

test("the tool step is recorded in the execution trace", async () => {
  // Criterion 5, first half: the steps exist after completion rather than only
  // during the run.
  const { snapshot } = await runToolOnlyTurn();
  const trace = snapshot.detailsShown.filter((d) =>
    /Execution Trace/i.test(d.summary),
  );
  assert.ok(
    trace.length > 0,
    `no execution trace panel; panels were: ${JSON.stringify(snapshot.detailsShown.map((d) => d.summary))}`,
  );
  assert.ok(
    trace.some((d) => /web_search/.test(d.bodyText)),
    `the trace does not mention the tool that ran: ${JSON.stringify(trace.map((d) => d.bodyText.slice(0, 120)))}`,
  );
});

test("the tool-only turn survives a transcript re-render", async () => {
  // Criterion 5, second half. The turn is stored with an empty answer plus its
  // trace, so re-rendering from history is where two things could go wrong:
  // the trace could be dropped, or the empty answer could be turned back into
  // the blank bubble this whole thread is about.
  const { w } = await runToolOnlyTurn();

  const stored = JSON.parse(w.eval("JSON.stringify(modeSession.pi.history)"));
  const assistant = stored.find((m) => m.role === "assistant");
  assert.ok(assistant, "the tool-only turn was not stored at all");
  assert.strictEqual(assistant.content, "", "fixture answered with text");
  assert.ok(
    Array.isArray(assistant.traceEvents) && assistant.traceEvents.length > 0,
    "the tool steps were not stored with the turn, so a reload loses them",
  );

  // Re-render the transcript the way switching back to this conversation does.
  // renderSessionTranscript clears the chat container itself.
  w.eval(`renderSessionTranscript(getActiveModeSession("pi"));`);
  await settle(200);

  const after = JSON.parse(
    w.eval(`(function () {
      const assistants = Array.from(
        document.querySelectorAll(".msg.assistant"),
      );
      return JSON.stringify({
        emptyBubbles: assistants.filter(
          (a) => (a.textContent || "").trim() === "",
        ).length,
        transcript: chat.textContent || "",
        assistantHtml: assistants.map((a) => a.outerHTML.slice(0, 260)),
      });
    })()`),
  );

  // KNOWN FAILURE — a real defect, left red on purpose.
  //
  // The live turn is correct: no bubble is created while Pi runs a tool. But
  // renderAssistantHistoryMessage builds the bubble unconditionally
  // (05-history.js), while the trace panel above it is guarded by
  // assistantMetadataHasContent. So a stored tool-only turn re-renders as an
  // empty <div class="msg assistant" data-raw-text="">, and .msg carries
  // padding, a border and a shadow with no :empty rule anywhere in app.css —
  // it draws as a visible empty box.
  //
  // This is the same element from the original drum report, on the reload path
  // rather than the live one.
  assert.strictEqual(
    after.emptyBubbles,
    0,
    `re-rendering the stored turn produced an empty assistant bubble: ${JSON.stringify(after.assistantHtml)}`,
  );
  assert.match(
    after.transcript,
    /web_search/,
    `the tool steps did not survive the re-render: ${after.transcript.slice(0, 200)}`,
  );
});
