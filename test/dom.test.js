const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const { JSDOM, VirtualConsole } = require("jsdom");

// jsdom does not fetch external scripts; inline the split client files the
// same way the browser composes them (sequential classic scripts).
// Vendor scripts are served from node_modules at runtime (see
// VENDOR_SCRIPT_FILES in server.js); inline them too, or marked/DOMPurify are
// undefined and anything that renders Markdown silently does nothing.
const VENDOR_FILES = {
  "marked.umd.js": "node_modules/marked/lib/marked.umd.js",
  "purify.min.js": "node_modules/dompurify/dist/purify.min.js",
  "highlight.min.js": "node_modules/@highlightjs/cdn-assets/highlight.min.js",
};

const html = fs
  .readFileSync("index.html", "utf8")
  .replace(
    /<script src="\/assets\/(js\/[^"]+)"><\/script>/g,
    (_m, rel) => `<script>${fs.readFileSync(`assets/${rel}`, "utf8")}</script>`,
  )
  .replace(/<script src="\/vendor\/([^"]+)"><\/script>/g, (m, name) => {
    const file = VENDOR_FILES[name];
    if (!file || !fs.existsSync(file)) return m;
    return `<script>${fs.readFileSync(file, "utf8")}</script>`;
  });

function jsonResponse(payload, status = 200) {
  const text = JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => payload,
  };
}

function createFetchStub() {
  const piSettings = {
    commandPath: "",
    workingDirectory: "",
    serverPort: 8080,
    timeoutMs: 300000,
    permissionPolicy: "normal",
    permissionUx: {
      autoOpen: true,
      defaultAction: "deny",
      decisionTimeoutMs: 45000,
    },
    toolOutputMaxChars: 12000,
    streamThinkingExpanded: false,
  };

  return async (url) => {
    const path = String(url).replace("http://localhost", "");
    if (path === "/api/models") return jsonResponse(["test-model"]);
    if (path === "/api/ui/settings") {
      return jsonResponse({
        exists: false,
        settings: {
          palettes: {
            ollama: "solarised",
            pi: "orange",
            cloud: "calmblue",
          },
          fonts: {
            ollama: '"Space Mono", monospace',
            pi: '"Space Mono", monospace',
            cloud: '"Space Mono", monospace',
          },
        },
      });
    }
    if (path === "/api/prompts") return jsonResponse([]);
    if (path === "/api/custom-skills") return jsonResponse([]);
    if (path === "/api/plugins") {
      return jsonResponse({ directory: "/tmp/plugins", plugins: [] });
    }
    if (path === "/api/plugins/drafts") return jsonResponse({ drafts: [] });
    if (path === "/api/lessons" || path.startsWith("/api/lessons?")) {
      return jsonResponse({ text: "" });
    }
    if (
      path === "/api/system-prompts" ||
      path.startsWith("/api/system-prompts?")
    ) {
      return jsonResponse({
        mode: "ollama",
        editable: true,
        dbOffDefault: "",
        dbOnDefault: "",
        dbOffOverride: "",
        dbOnOverride: "",
        dbOff: "",
        dbOn: "",
        lessonsApplied: false,
      });
    }
    if (path === "/api/cloud/settings") {
      return jsonResponse({
        settings: {
          provider: "openai",
          models: {
            openai: "gpt-5",
            anthropic: "claude-opus-4-8",
            mistral: "mistral-large-latest",
          },
          baseUrls: {
            openai: "https://api.openai.com/v1",
            anthropic: "https://api.anthropic.com/v1",
            mistral: "https://api.mistral.ai/v1",
          },
          maxTokens: 2048,
          hasApiKey: {
            openai: false,
            anthropic: false,
            mistral: false,
          },
          envKeyNames: {
            openai: "OPENAI_API_KEY",
            anthropic: "ANTHROPIC_API_KEY",
            mistral: "MISTRAL_API_KEY",
          },
        },
      });
    }
    if (path === "/api/library/config") {
      return jsonResponse({
        config: {
          version: 1,
          databasePath: "/tmp/ollama-pi-chat-test/library.sqlite",
          sources: [
            {
              name: "Books",
              type: "book",
              path: "/tmp/Libros",
              extensions: [".epub"],
            },
          ],
          chunking: {
            targetChars: 4200,
            overlapChars: 120,
            minChars: 300,
            maxChars: 6500,
          },
          search: {
            keywordEnabled: false,
            defaultLimit: 5,
            maxLimit: 20,
            maxContextChars: 12000,
            rrfK: 60,
            semanticWeight: 1,
            keywordWeight: 1.1,
            metadataWeight: 0.8,
            sourceWeight: 1.2,
            contentKeywordBonus: 0.16,
            metadataKeywordBonus: 0.06,
            maxPassagesPerSource: 5,
          },
          embedding: {
            enabled: false,
            model: "nomic-embed-text-v2-moe:latest",
            dimensions: 256,
            ollamaBaseUrl: "http://127.0.0.1:11434",
            batchSize: 16,
            sqliteVecExtensionPath: "",
          },
          chatIntegration: {
            enabled: false,
            limit: 5,
            maxContextChars: 12000,
            includeSourcePaths: true,
          },
          chatModes: {
            ollama: { enabled: true },
            llamacpp: { enabled: true },
            pi: { enabled: false },
            cloud: { enabled: true },
          },
          watch: {
            enabled: false,
            debounceMs: 2000,
            rescanIntervalMs: 60000,
          },
        },
      });
    }
    if (path === "/api/library/status") {
      return jsonResponse({
        sqliteAvailable: true,
        databaseExists: false,
        files: 0,
        chunks: 0,
        embeddings: 0,
        sources: [],
        embedding: {
          enabled: false,
          model: "nomic-embed-text-v2-moe:latest",
          dimensions: 256,
          sqliteVecConfigured: false,
        },
        search: {
          keywordEnabled: false,
          defaultLimit: 5,
          maxLimit: 20,
          maxContextChars: 12000,
          rrfK: 60,
          semanticWeight: 1,
          keywordWeight: 1.1,
          metadataWeight: 0.8,
          sourceWeight: 1.2,
          contentKeywordBonus: 0.16,
          metadataKeywordBonus: 0.06,
          maxPassagesPerSource: 5,
        },
      });
    }
    if (path === "/api/library/index") {
      return jsonResponse({
        running: false,
        job: null,
      });
    }
    if (path === "/api/pi/settings") {
      return jsonResponse({
        settings: piSettings,
        runtime: {
          dataDir: "/tmp/ollama-pi-chat-test",
          projectDir: "/tmp/ollama-pi-chat-test",
          configuredServerPort: 8080,
          activeServerPort: 8080,
          resolvedWorkingDirectory: "/tmp",
          sandbox: { globalEnabled: false, projectEnabled: false },
        },
      });
    }
    if (path === "/api/ollama/skills/settings") return jsonResponse({});
    if (path === "/api/local-models/settings") {
      return jsonResponse({
        settings: {
          lmstudio: { baseUrl: "http://127.0.0.1:1234/v1", model: "" },
          llamacpp: { baseUrl: "http://127.0.0.1:8080/v1", model: "" },
        },
      });
    }
    if (path === "/api/lmstudio/models" || path === "/api/llamacpp/models") {
      return jsonResponse({ models: [] });
    }
    if (path === "/api/version") return jsonResponse({ version: "1.0.5" });
    if (
      path === "/api/security-event" ||
      path === "/api/mcp/config" ||
      path === "/api/library/config"
    ) {
      return jsonResponse({ ok: true });
    }
    return jsonResponse({ error: `Unhandled test URL: ${path}` }, 404);
  };
}

function waitFor(predicate, timeoutMs = 1000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        if (predicate()) {
          resolve();
          return;
        }
      } catch (error) {
        reject(error);
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error("Timed out waiting for DOM condition."));
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

// Every created window must be closed when the suite ends: the app registers
// repeating timers (e.g. the Pi history poller) that otherwise keep Node's
// event loop alive forever and hang `node --test`.
const openDoms = [];

function createDom() {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error));
  virtualConsole.on("error", (...args) => errors.push(args.join(" ")));

  const dom = new JSDOM(html, {
    url: "http://localhost/",
    runScripts: "dangerously",
    virtualConsole,
    beforeParse(window) {
      window.fetch = createFetchStub();
    },
  });

  openDoms.push(dom);
  return { dom, errors };
}

test.after(() => {
  for (const dom of openDoms) {
    try {
      dom.window.close();
    } catch (_e) {
      // window already gone
    }
  }
});

test("frontend boots without network fetch crashes", async () => {
  const { dom, errors } = createDom();
  await waitFor(
    () =>
      dom.window.document.getElementById("app-version-label").textContent ===
      "1.0.5",
  );

  assert.deepStrictEqual(errors, []);
  assert.strictEqual(
    dom.window.document.getElementById("app-version-label").textContent,
    "1.0.5",
  );
  assert.strictEqual(
    dom.window.document.querySelectorAll("#modelSelect option").length,
    1,
  );
  assert.ok(dom.window.document.getElementById("btnCloud"));
  assert.ok(dom.window.document.querySelector("#btnOllama svg"));
  assert.ok(dom.window.document.querySelector("#btnPi svg"));
  assert.ok(dom.window.document.querySelector("#databaseSettingsGroup svg"));
  assert.ok(dom.window.document.getElementById("databaseEmbeddingModelSelect"));
  assert.ok(
    dom.window.document.getElementById("databaseEmbeddingDimensionsInput"),
  );
  assert.ok(dom.window.document.getElementById("databaseKeywordEnabledInput"));
  assert.ok(dom.window.document.getElementById("estimateLibraryIndexBtn"));
  assert.ok(dom.window.document.getElementById("exportIndexedFilesBtn"));
  assert.ok(dom.window.document.getElementById("openIndexedFilesExportBtn"));
  assert.ok(
    dom.window.document.getElementById("copyIndexedFilesExportPathBtn"),
  );
  assert.ok(dom.window.document.getElementById("libraryEstimateTotalValue"));
  assert.ok(dom.window.document.getElementById("libraryStatusFilesValue"));
  assert.ok(
    dom.window.document.getElementById("libraryStatusEmbeddingsReadyValue"),
  );
  assert.ok(
    dom.window.document.getElementById("libraryStatusEmbeddingsMissingValue"),
  );
  assert.ok(dom.window.document.getElementById("libraryJobPhaseValue"));
  assert.ok(
    dom.window.document.getElementById("libraryJobPendingEmbeddingsValue"),
  );
  assert.ok(
    dom.window.document.getElementById("libraryJobEmbeddingErrorsValue"),
  );
  assert.ok(dom.window.document.getElementById("libraryJobRecentIssuesValue"));
  assert.ok(dom.window.document.getElementById("libraryIndexProgressFill"));
  assert.ok(dom.window.document.getElementById("retryLibraryEmbeddingsBtn"));
  assert.ok(
    dom.window.document.getElementById("resetSearchAlgorithmSettingsBtn"),
  );
  assert.ok(
    dom.window.document.querySelectorAll(
      "#builtinSkillsList .builtin-skill-toggle",
    ).length > 0,
  );
  assert.strictEqual(
    dom.window.document.querySelector(
      '#builtinSkillsList .builtin-skill-toggle[data-skill="shell_command"]',
    ).checked,
    false,
  );
  assert.strictEqual(
    dom.window.document.getElementById("databaseMaxPassagesPerSourceInput")
      .value,
    "5",
  );
  // MAIN, MODES, DATABASE, PROMPTS, SKILLS + the llama.cpp-only MODELS tab.
  assert.strictEqual(
    dom.window.document.querySelectorAll(".settings-tab").length,
    6,
  );
  assert.strictEqual(
    dom.window.document.getElementById("ollamaFontGroup").parentElement.id,
    "settingsTabMain",
  );
  // The Ollama colour palette now lives inside ollamaFontGroup (ordered to
  // match LM Studio: tools -> palette -> font), not a standalone group.
  assert.strictEqual(
    dom.window.document
      .getElementById("settingOllamaPalette")
      .closest(".setting-group").id,
    "ollamaFontGroup",
  );
  assert.strictEqual(
    dom.window.document.getElementById("databaseSettingsGroup").parentElement
      .id,
    "settingsTabDatabase",
  );
  assert.strictEqual(
    dom.window.document.getElementById("promptSettingsGroup").parentElement.id,
    "settingsTabPrompts",
  );
  assert.strictEqual(
    dom.window.document.getElementById("builtinSkillsGroup").parentElement.id,
    "settingsTabSkills",
  );
  assert.strictEqual(
    dom.window.document.querySelectorAll(
      "#databaseSourcesList .database-source-row",
    ).length,
    1,
  );
  assert.strictEqual(
    dom.window.document.getElementById("btnOllama").textContent.trim(),
    "",
  );
  assert.strictEqual(
    dom.window.document.getElementById("ollamaTemperatureInput").value,
    "0.3",
  );
  assert.strictEqual(
    dom.window.document.getElementById("ollamaTopPInput").value,
    "0.75",
  );
  assert.strictEqual(
    dom.window.document.getElementById("ollamaTopKInput").value,
    "40",
  );
  assert.strictEqual(
    dom.window.document.getElementById("ollamaNumPredictInput").value,
    "2048",
  );
  assert.strictEqual(
    dom.window.document.getElementById("ollamaSeedInput").value,
    "-1",
  );
  assert.strictEqual(
    dom.window.document.getElementById("ollamaRepeatPenaltyInput").value,
    "1.1",
  );
  assert.strictEqual(
    dom.window.document.getElementById("ollamaRepeatLastNInput").value,
    "256",
  );
});

test("palette change listener updates UI state", async () => {
  const { dom, errors } = createDom();
  await waitFor(
    () =>
      dom.window.document.getElementById("app-version-label").textContent ===
      "1.0.5",
  );

  const select = dom.window.document.getElementById("llamaCppPaletteSelect");
  select.value = "calmblue";
  select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));

  assert.deepStrictEqual(errors, []);
  assert.strictEqual(
    dom.window.document.documentElement.getAttribute("data-palette"),
    "calmblue",
  );
});

test("mode switch shows skills in Cloud but keeps Pi isolated", async () => {
  const { dom, errors } = createDom();
  await waitFor(
    () =>
      dom.window.document.getElementById("app-version-label").textContent ===
      "1.0.5",
  );

  dom.window.document.getElementById("btnPi").click();
  assert.strictEqual(
    dom.window.document.getElementById("builtinSkillsGroup").style.display,
    "none",
  );
  assert.strictEqual(
    dom.window.document.getElementById("customSkillsGroup").style.display,
    "none",
  );
  assert.strictEqual(
    dom.window.document.querySelector('[data-settings-tab="skills"]').style
      .display,
    "none",
  );
  assert.strictEqual(
    dom.window.document.querySelector('[data-settings-tab="prompts"]').style
      .display,
    "none",
  );
  assert.strictEqual(
    dom.window.document.getElementById("databaseSettingsGroup").style.display,
    "",
  );

  dom.window.document.getElementById("btnCloud").click();
  assert.strictEqual(
    dom.window.document.getElementById("cloudSettingsGroup").style.display,
    "",
  );
  assert.strictEqual(
    dom.window.document.getElementById("builtinSkillsGroup").style.display,
    "",
  );
  assert.strictEqual(
    dom.window.document.getElementById("customSkillsGroup").style.display,
    "none",
  );
  assert.strictEqual(
    dom.window.document.querySelector('[data-settings-tab="skills"]').style
      .display,
    "",
  );
  // Cloud is a prompt mode: the PROMPTS tab and its subsections are visible,
  // with its own independent prompts, active selection, and base overrides.
  assert.strictEqual(
    dom.window.document.querySelector('[data-settings-tab="prompts"]').style
      .display,
    "",
  );
  assert.strictEqual(
    dom.window.document.getElementById("promptSettingsGroup").style.display,
    "",
  );
  assert.strictEqual(
    dom.window.document.getElementById("piSettingsGroup").style.display,
    "none",
  );

  assert.deepStrictEqual(errors, []);
});

test("database enable checkbox is independent per mode", async () => {
  const { dom, errors } = createDom();
  await waitFor(
    () =>
      dom.window.document.getElementById("app-version-label").textContent ===
      "1.0.5",
  );

  const enabledInput = dom.window.document.getElementById(
    "librarySearchEnabledInput",
  );
  assert.strictEqual(enabledInput.checked, true);

  dom.window.document.getElementById("btnPi").click();
  assert.strictEqual(enabledInput.checked, false);

  dom.window.document.getElementById("btnCloud").click();
  assert.strictEqual(enabledInput.checked, true);

  assert.deepStrictEqual(errors, []);
});

test("passages bubble survives history render and mode switch", async () => {
  const { dom, errors } = createDom();
  await waitFor(
    () =>
      dom.window.document.getElementById("app-version-label").textContent ===
      "1.0.5",
  );

  const passage = {
    title: "Biblioteca",
    author: "Apolodoro",
    heading: "La Esfinge",
    text: "Hera envio a la Esfinge, hija de Equidna y Tifon.",
  };

  dom.window.loadConversation({
    id: "conv_passages_history",
    mode: "ollama",
    title: "Passages history",
    history: [
      { role: "user", content: "genealogia de la esfinge" },
      {
        role: "assistant",
        content: "Segun la Biblioteca de Apolodoro...",
        passages: [passage],
      },
    ],
  });

  const findPassagesDetails = () =>
    Array.from(dom.window.document.querySelectorAll(".thinking-details")).find(
      (node) => node.querySelector("summary")?.textContent === "Passages",
    );

  assert.match(findPassagesDetails()?.textContent || "", /Equidna/);

  dom.window.document.getElementById("btnPi").click();
  dom.window.document.getElementById("btnOllama").click();

  assert.match(findPassagesDetails()?.textContent || "", /Equidna/);

  const session = dom.window.getActiveModeSession("ollama");
  session.history = [];
  session.draftAssistant = dom.window.buildAssistantHistoryMessage(
    "Draft answer",
    [],
    { passages: [passage] },
  );
  dom.window.renderSessionTranscript(session);

  assert.match(findPassagesDetails()?.textContent || "", /Equidna/);

  dom.window.document.getElementById("btnPi").click();
  dom.window.document.getElementById("btnOllama").click();

  assert.match(findPassagesDetails()?.textContent || "", /Equidna/);
  assert.deepStrictEqual(errors, []);
});

test("markdown and sanitizer scripts are served locally", () => {
  // Reads index.html straight from disk on purpose: the `html` constant above
  // has the vendor tags inlined for jsdom, and the minified libraries contain
  // CDN strings of their own that would make this assertion meaningless.
  const source = fs.readFileSync("index.html", "utf8");
  assert.match(source, /<script src="\/vendor\/marked\.umd\.js"><\/script>/);
  assert.match(source, /<script src="\/vendor\/purify\.min\.js"><\/script>/);
  assert.doesNotMatch(source, /cdn\.jsdelivr\.net/);
});

// ---- Queued messages while a response is streaming ----

// Boot the app and pretend the current mode is mid-generation, which is the
// only state in which the composer queues instead of sending.
async function bootGenerating() {
  const { dom, errors } = createDom();
  await waitFor(
    () =>
      dom.window.document.getElementById("app-version-label").textContent ===
      "1.0.5",
  );
  const win = dom.window;
  const doc = win.document;
  const input = doc.getElementById("input");
  const send = doc.getElementById("send");
  const strip = doc.getElementById("queueStrip");
  const startRun = () => {
    win.getActiveModeSession().activeAbortController =
      new win.AbortController();
    win.updateSendButtonState();
  };
  const endRun = () => {
    win.getActiveModeSession().activeAbortController = null;
    win.updateSendButtonState();
  };
  const type = (text) => {
    input.value = text;
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
  };
  const pressEnter = () =>
    input.dispatchEvent(
      new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  // `mode` is a lexical binding, not a window property; the app mirrors it
  // onto the root element, which is the only way in from a test.
  const activeMode = () => doc.documentElement.getAttribute("data-mode");
  return {
    activeMode,
    dom,
    errors,
    win,
    doc,
    input,
    send,
    strip,
    startRun,
    endRun,
    type,
    pressEnter,
    queued: () => win.getActiveModeSession().queue,
  };
}

test("Enter during a response queues it instead of stopping the stream", async () => {
  const t = await bootGenerating();
  t.startRun();
  t.type("follow-up question");
  t.pressEnter();

  assert.strictEqual(t.queued().length, 1);
  assert.strictEqual(t.queued()[0].text, "follow-up question");
  assert.strictEqual(t.input.value, "", "composer is freed for the next one");
  assert.ok(
    t.win.getActiveModeSession().activeAbortController,
    "the running stream must not have been aborted",
  );
  assert.ok(t.strip.classList.contains("show"));
  assert.match(t.strip.textContent, /follow-up question/);
  assert.deepStrictEqual(t.errors, []);
});

test("Enter during a response with an empty composer still stops it", async () => {
  const t = await bootGenerating();
  t.startRun();
  const controller = t.win.getActiveModeSession().activeAbortController;
  t.type("   ");
  t.pressEnter();

  assert.strictEqual(t.queued().length, 0);
  assert.ok(
    controller.signal.aborted,
    "empty composer keeps the stop shortcut",
  );
  assert.deepStrictEqual(t.errors, []);
});

test("the composer button flips between Stop and Queue as you type", async () => {
  const t = await bootGenerating();
  assert.strictEqual(t.send.getAttribute("aria-label"), "Send message");

  t.startRun();
  assert.strictEqual(t.send.getAttribute("aria-label"), "Stop response");
  assert.ok(t.send.classList.contains("stopping"));

  t.type("something");
  assert.strictEqual(t.send.getAttribute("aria-label"), "Queue message");
  assert.ok(!t.send.classList.contains("stopping"));

  t.type("");
  assert.strictEqual(t.send.getAttribute("aria-label"), "Stop response");
  assert.deepStrictEqual(t.errors, []);
});

test("queued messages can be removed individually", async () => {
  const t = await bootGenerating();
  t.startRun();
  t.type("first");
  t.pressEnter();
  t.type("second");
  t.pressEnter();
  assert.strictEqual(t.queued().length, 2);

  t.strip.querySelectorAll(".file-pill-x")[0].click();
  assert.strictEqual(t.queued().length, 1);
  assert.strictEqual(t.queued()[0].text, "second");
  assert.deepStrictEqual(t.errors, []);
});

test("stopping the response discards anything queued behind it", async () => {
  const t = await bootGenerating();
  t.startRun();
  t.type("queued but unwanted");
  t.pressEnter();
  assert.strictEqual(t.queued().length, 1);

  t.win.stopActiveGeneration();
  assert.strictEqual(t.queued().length, 0);
  assert.ok(!t.strip.classList.contains("show"));
  assert.deepStrictEqual(t.errors, []);
});

test("the queue belongs to the mode it was typed in", async () => {
  const t = await bootGenerating();
  const BUTTON_FOR = {
    ollama: "btnOllama",
    pi: "btnPi",
    cloud: "btnCloud",
    lmstudio: "btnLmStudio",
    llamacpp: "btnLlamaCpp",
  };
  const startMode = t.activeMode();
  t.startRun();
  t.type("typed in the first mode");
  t.pressEnter();
  assert.ok(t.strip.classList.contains("show"));

  t.doc.getElementById("btnPi").click();
  assert.ok(!t.strip.classList.contains("show"), "Pi has its own empty queue");

  t.doc.getElementById(BUTTON_FOR[startMode]).click();
  assert.ok(t.strip.classList.contains("show"));
  assert.match(t.strip.textContent, /typed in the first mode/);
  assert.deepStrictEqual(t.errors, []);
});

test("a finished run sends the next queued message, in order", async () => {
  const t = await bootGenerating();
  const sent = [];
  // Simulates a real send: a run starts, so the queue pauses until it ends.
  t.win.sendMessage = function stubbedSend() {
    sent.push(t.input.value);
    t.input.value = "";
    t.win.getActiveModeSession().activeAbortController =
      new t.win.AbortController();
  };
  t.startRun();
  t.type("first");
  t.pressEnter();
  t.type("second");
  t.pressEnter();

  t.endRun();
  t.win.scheduleQueueDrain(t.activeMode());
  await waitFor(() => sent.length === 1);
  assert.deepStrictEqual(sent, ["first"]);
  assert.strictEqual(t.queued().length, 1, "the second one waits its turn");

  t.endRun();
  t.win.scheduleQueueDrain(t.activeMode());
  await waitFor(() => sent.length === 2);
  assert.deepStrictEqual(sent, ["first", "second"]);
  assert.strictEqual(t.queued().length, 0);
  assert.ok(!t.strip.classList.contains("show"));
  assert.deepStrictEqual(t.errors, []);
});

test("a queued message never drains into a different conversation", async () => {
  const t = await bootGenerating();
  const sent = [];
  t.win.sendMessage = function stubbedSend() {
    sent.push(t.input.value);
  };
  t.startRun();
  t.type("meant for this chat");
  t.pressEnter();

  // The user opens another conversation before the run finishes. It has to go
  // through loadConversation: `currentConvId` is a lexical binding, so setting
  // it on `window` would not reach the app at all.
  t.win.loadConversation({
    id: "conv_somewhere_else",
    mode: t.activeMode(),
    history: [],
  });
  t.endRun();
  t.win.scheduleQueueDrain(t.activeMode());
  await new Promise((r) => setTimeout(r, 30));
  assert.deepStrictEqual(sent, [], "nothing sent into the wrong transcript");
  assert.deepStrictEqual(t.errors, []);
});

test("text typed since queueing keeps the composer and defers the queue", async () => {
  const t = await bootGenerating();
  const sent = [];
  t.win.sendMessage = function stubbedSend() {
    sent.push(t.input.value);
  };
  t.startRun();
  t.type("queued earlier");
  t.pressEnter();
  t.type("typed just now");

  t.endRun();
  t.win.scheduleQueueDrain(t.activeMode());
  await new Promise((r) => setTimeout(r, 30));
  assert.deepStrictEqual(sent, [], "the half-typed message is not clobbered");
  assert.strictEqual(t.input.value, "typed just now");
  assert.strictEqual(t.queued().length, 1);
  assert.deepStrictEqual(t.errors, []);
});

test("sending a new message does not silently drop a waiting queue", async () => {
  // Regression: stopActiveGeneration() is also the ordinary idle send path, so
  // clearing the queue there destroyed messages that were only waiting for the
  // composer to empty.
  const t = await bootGenerating();
  const sent = [];
  t.win.sendMessage = function stubbedSend() {
    sent.push(t.input.value);
    t.input.value = "";
  };
  t.startRun();
  t.type("queued earlier");
  t.pressEnter();

  // Run ends while something else is half-typed: the queue defers.
  t.type("typed just now");
  t.endRun();
  t.win.scheduleQueueDrain(t.activeMode());
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(t.queued().length, 1);

  // Sending the typed message must not take the queued one with it.
  t.pressEnter();
  assert.deepStrictEqual(sent, ["typed just now"]);
  assert.strictEqual(
    t.queued().length,
    1,
    "the queued message is still waiting",
  );

  t.win.scheduleQueueDrain(t.activeMode());
  await waitFor(() => sent.length === 2);
  assert.deepStrictEqual(sent, ["typed just now", "queued earlier"]);
  assert.deepStrictEqual(t.errors, []);
});

test("a queued send that starts no run still drains the rest", async () => {
  // A Pi slash command handled locally returns from sendMessage without ever
  // starting a run, so no `finally` fires — the queue behind it must not stall.
  const t = await bootGenerating();
  const sent = [];
  t.win.sendMessage = async function stubbedSend() {
    sent.push(t.input.value);
    t.input.value = "";
    // deliberately starts nothing
  };
  t.startRun();
  t.type("/local-command");
  t.pressEnter();
  t.type("real question");
  t.pressEnter();
  assert.strictEqual(t.queued().length, 2);

  t.endRun();
  t.win.scheduleQueueDrain(t.activeMode());
  await waitFor(() => sent.length === 2);
  assert.deepStrictEqual(sent, ["/local-command", "real question"]);
  assert.strictEqual(t.queued().length, 0);
  assert.deepStrictEqual(t.errors, []);
});

test("overlapping drains never send two messages at once", async () => {
  const t = await bootGenerating();
  const sent = [];
  let release;
  t.win.sendMessage = function stubbedSend() {
    sent.push(t.input.value);
    t.input.value = "";
    // Mimic a real run: the abort controller is only set after an await, the
    // window in which a second drain could double-send.
    return new Promise((resolve) => {
      release = () => {
        t.win.getActiveModeSession().activeAbortController = null;
        resolve();
      };
      setTimeout(() => {
        t.win.getActiveModeSession().activeAbortController =
          new t.win.AbortController();
      }, 5);
    });
  };
  t.startRun();
  t.type("one");
  t.pressEnter();
  t.type("two");
  t.pressEnter();

  t.endRun();
  const activeMode = t.activeMode();
  t.win.scheduleQueueDrain(activeMode);
  t.win.scheduleQueueDrain(activeMode);
  t.win.scheduleQueueDrain(activeMode);
  await waitFor(() => sent.length === 1);
  await new Promise((r) => setTimeout(r, 40));
  assert.deepStrictEqual(sent, ["one"], "the second must wait for the first");

  release();
  await waitFor(() => sent.length === 2);
  assert.deepStrictEqual(sent, ["one", "two"]);
  assert.deepStrictEqual(t.errors, []);
});

// ---- Notes Markdown preview ----

async function bootNotes() {
  const { dom, errors } = createDom();
  await waitFor(
    () =>
      dom.window.document.getElementById("app-version-label").textContent ===
      "1.0.5",
  );
  const win = dom.window;
  const doc = win.document;
  return {
    dom,
    errors,
    win,
    doc,
    panel: doc.getElementById("notesPanel"),
    area: doc.getElementById("notesArea"),
    preview: doc.getElementById("notesPreview"),
    button: doc.getElementById("notesPreviewBtn"),
  };
}

test("notes preview renders Markdown instead of showing raw syntax", async () => {
  const t = await bootNotes();
  t.area.value = "# Title\n\nSome **bold** text\n\n- one\n- two";
  t.button.click();

  assert.ok(t.panel.classList.contains("preview-mode"));
  assert.strictEqual(t.preview.querySelector("h1")?.textContent, "Title");
  assert.strictEqual(t.preview.querySelector("strong")?.textContent, "bold");
  assert.strictEqual(t.preview.querySelectorAll("li").length, 2);
  assert.doesNotMatch(t.preview.textContent, /\*\*|^# /m);
  assert.strictEqual(t.button.textContent.trim(), "EDIT");
  assert.deepStrictEqual(t.errors, []);
});

test("previewing never alters the note's text", async () => {
  // The safety property that matters: the textarea is the only source of
  // truth, so no round trip through the renderer may change a single byte.
  const t = await bootNotes();
  const original =
    "# Heading\n\n<b>literal html</b>\n\n\ttabbed\n\ntrailing   ";
  t.area.value = original;
  t.button.click();
  t.button.click();
  t.button.click();
  t.button.click();
  assert.strictEqual(t.area.value, original);
  assert.ok(!t.panel.classList.contains("preview-mode"));
  assert.deepStrictEqual(t.errors, []);
});

test("notes preview sanitizes dangerous markup", async () => {
  const t = await bootNotes();
  t.area.value =
    '# Hi\n\n<script>window.__pwned = 1;</script>\n\n<img src=x onerror="window.__pwned=1">';
  t.button.click();

  assert.strictEqual(t.preview.querySelector("script"), null);
  assert.strictEqual(
    t.preview.querySelector("img")?.hasAttribute("onerror"),
    false,
  );
  assert.strictEqual(t.win.__pwned, undefined);
  // The note text itself is untouched — only the rendering is sanitized.
  assert.match(t.area.value, /<script>/);
  assert.deepStrictEqual(t.errors, []);
});

test("an empty note previews as an empty state, not blank", async () => {
  const t = await bootNotes();
  t.area.value = "   \n\n";
  t.button.click();
  assert.ok(t.preview.querySelector(".notes-preview-empty"));
  assert.deepStrictEqual(t.errors, []);
});

test("preview and editor are never both visible", async () => {
  const t = await bootNotes();
  t.area.value = "text";
  assert.ok(!t.panel.classList.contains("preview-mode"));
  t.button.click();
  assert.ok(t.panel.classList.contains("preview-mode"));
  // Browsing the note list hides both, and entering preview closes the list.
  t.win.toggleNotesList();
  assert.ok(t.panel.classList.contains("list-open"));
  t.win.setNotesPreview(true);
  assert.ok(!t.panel.classList.contains("list-open"));
  assert.deepStrictEqual(t.errors, []);
});

test("typing still autosaves while the preview exists", async () => {
  const t = await bootNotes();
  let scheduled = 0;
  const real = t.win.scheduleNotesSave;
  t.win.scheduleNotesSave = function (immediate) {
    scheduled += 1;
    return real.call(this, immediate);
  };
  t.area.value = "typed";
  t.area.dispatchEvent(new t.win.Event("input", { bubbles: true }));
  assert.strictEqual(scheduled, 1, "the autosave listener is still attached");
  assert.deepStrictEqual(t.errors, []);
});

test("a broken Markdown renderer shows the raw note, never a blank pane", async () => {
  const t = await bootNotes();
  t.area.value = "# Heading\n\nbody text";
  t.win.marked = {
    parse() {
      throw new Error("boom");
    },
  };
  t.button.click();
  assert.strictEqual(t.preview.querySelector("h1"), null);
  assert.match(t.preview.textContent, /# Heading/);
  assert.match(t.preview.textContent, /body text/);
  assert.strictEqual(t.area.value, "# Heading\n\nbody text");
});
