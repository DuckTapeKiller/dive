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
    if (path === "/api/prompts") return jsonResponse([]);
    if (path === "/api/custom-skills") return jsonResponse([]);
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
    if (path === "/api/version") return jsonResponse({ version: "1.0.0" });
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
      "1.0.0",
  );

  assert.deepStrictEqual(errors, []);
  assert.strictEqual(
    dom.window.document.getElementById("app-version-label").textContent,
    "1.0.0",
  );
  assert.strictEqual(
    dom.window.document.querySelectorAll("#modelSelect option").length,
    1,
  );
});

test("palette change listener updates UI state", async () => {
  const { dom, errors } = createDom();
  await waitFor(
    () =>
      dom.window.document.getElementById("app-version-label").textContent ===
      "1.0.0",
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

test("markdown and sanitizer scripts are served locally", () => {
  assert.match(html, /<script src="\/vendor\/marked\.umd\.js"><\/script>/);
  assert.match(html, /<script src="\/vendor\/purify\.min\.js"><\/script>/);
  assert.doesNotMatch(html, /cdn\.jsdelivr\.net/);
});
