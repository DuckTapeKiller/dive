const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const { JSDOM, VirtualConsole } = require("jsdom");

const html = fs.readFileSync("index.html", "utf8");

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
    if (path === "/api/cloud/settings") {
      return jsonResponse({
        settings: {
          provider: "openai",
          models: {
            openai: "gpt-5",
            anthropic: "claude-sonnet-4-20250514",
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
    if (path === "/api/version") return jsonResponse({ version: "1.0.1" });
    if (path === "/api/security-event" || path === "/api/mcp/config") {
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

  return { dom, errors };
}

test("frontend boots without network fetch crashes", async () => {
  const { dom, errors } = createDom();
  await waitFor(
    () =>
      dom.window.document.getElementById("app-version-label").textContent ===
      "1.0.1",
  );

  assert.deepStrictEqual(errors, []);
  assert.strictEqual(
    dom.window.document.getElementById("app-version-label").textContent,
    "1.0.1",
  );
  assert.strictEqual(
    dom.window.document.querySelectorAll("#modelSelect option").length,
    1,
  );
  assert.ok(dom.window.document.getElementById("btnCloud"));
  assert.ok(dom.window.document.querySelector("#btnOllama svg"));
  assert.ok(dom.window.document.querySelector("#btnPi svg"));
  assert.strictEqual(
    dom.window.document.getElementById("btnOllama").textContent.trim(),
    "",
  );
});

test("palette change listener updates UI state", async () => {
  const { dom, errors } = createDom();
  await waitFor(
    () =>
      dom.window.document.getElementById("app-version-label").textContent ===
      "1.0.1",
  );

  const select = dom.window.document.getElementById("settingOllamaPalette");
  select.value = "orange";
  select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));

  assert.deepStrictEqual(errors, []);
  assert.strictEqual(
    dom.window.document.documentElement.getAttribute("data-palette"),
    "orange",
  );
});

test("mode switch hides Ollama-only settings outside Ollama mode", async () => {
  const { dom, errors } = createDom();
  await waitFor(
    () =>
      dom.window.document.getElementById("app-version-label").textContent ===
      "1.0.1",
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

  dom.window.document.getElementById("btnCloud").click();
  assert.strictEqual(
    dom.window.document.getElementById("cloudSettingsGroup").style.display,
    "",
  );
  assert.strictEqual(
    dom.window.document.getElementById("piSettingsGroup").style.display,
    "none",
  );

  assert.deepStrictEqual(errors, []);
});

test("markdown and sanitizer scripts are served locally", () => {
  assert.match(html, /<script src="\/vendor\/marked\.umd\.js"><\/script>/);
  assert.match(html, /<script src="\/vendor\/purify\.min\.js"><\/script>/);
  assert.doesNotMatch(html, /cdn\.jsdelivr\.net/);
});
