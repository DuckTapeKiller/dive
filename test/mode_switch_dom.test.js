// Walks every mode and asserts the DOM matches that mode. The original
// mode-isolation bug was a module-level alias pointing into a per-mode bucket
// that went stale on switch, leaving one mode's skills list on screen under
// another mode's name. These tests fail if that class of bug returns.
const assert = require("assert");
const fs = require("fs");
const test = require("node:test");
const { JSDOM, VirtualConsole } = require("jsdom");

const {
  MODE_IDS,
  DIVE_SKILL_MODE_IDS,
  LOCAL_MODE_IDS,
  MODE_DEFS,
} = require("../assets/js/00-modes.js");

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
  .replace(/<script src="\/vendor\/([^"]+)"><\/script>/g, (m, name) => {
    const file = VENDOR[name];
    if (!file || !fs.existsSync(file)) return "";
    return `<script>${fs.readFileSync(file, "utf8")}</script>`;
  });

function jsonResponse(body, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

// Every mode gets a distinguishable skills payload so a stale render is
// visible: calculator is enabled only for the mode named in the query, and the
// custom skill is named after its mode.
function fetchStub(url) {
  const raw = String(url).replace("http://localhost", "");
  const parsed = new URL(`http://localhost${raw}`);
  const p = parsed.pathname;
  const mode = parsed.searchParams.get("mode") || "ollama";

  if (p === "/api/ollama/skills/settings") {
    return jsonResponse({
      mode,
      settings: { calculator: mode === "cloud", shell_command: false },
    });
  }
  if (p === "/api/custom-skills") {
    return jsonResponse({
      mode,
      skills: [
        {
          name: `custom_${mode}`,
          description: `only for ${mode}`,
          type: "js",
          code: "1",
        },
      ],
    });
  }
  if (p === "/api/prompts") return jsonResponse([]);
  if (p === "/api/version") return jsonResponse({ version: "1.0.5" });
  if (p === "/api/plugins") {
    return jsonResponse({ directory: "/tmp/plugins", plugins: [] });
  }
  if (p === "/api/mcp/config") return jsonResponse({ mode, servers: [] });
  return jsonResponse({});
}

function boot() {
  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on("jsdomError", (e) => errors.push(e));
  const dom = new JSDOM(html, {
    url: "http://localhost/",
    runScripts: "dangerously",
    virtualConsole,
    beforeParse(window) {
      window.fetch = (url) => fetchStub(url);
      window.alert = () => {};
      window.scrollTo = () => {};
    },
  });
  return { dom, errors };
}

const settle = () => new Promise((r) => setTimeout(r, 60));

// Values returned by w.eval come from the jsdom realm: their prototypes are
// not Node's, so deepStrictEqual on an array from the page always fails.
// Compare JSON strings instead.

test("every mode paints its own skills state, never another's", async () => {
  const { dom } = boot();
  const w = dom.window;
  await settle();

  for (const modeId of DIVE_SKILL_MODE_IDS) {
    w.eval(`setMode(${JSON.stringify(modeId)})`);
    await settle();
    await settle();

    assert.strictEqual(w.eval("mode"), modeId);

    // Custom skills list must name this mode and no other.
    const customText =
      w.document.getElementById("customSkillsList")?.textContent || "";
    assert.match(
      customText,
      new RegExp(`custom_${modeId}\\b`),
      `${modeId}: custom skills list should show custom_${modeId}, got: ${customText.slice(0, 120)}`,
    );
    for (const other of DIVE_SKILL_MODE_IDS) {
      if (other === modeId) continue;
      assert.doesNotMatch(
        customText,
        new RegExp(`custom_${other}\\b`),
        `${modeId}: stale custom skill from ${other} still on screen`,
      );
    }

    // The builtin toggle state is mode-specific too (calculator: cloud only).
    const calcChecked = w.eval(
      `!!document.querySelector('#builtinSkillsList input[data-skill="calculator"]')?.checked`,
    );
    assert.strictEqual(
      calcChecked,
      modeId === "cloud",
      `${modeId}: calculator toggle should be ${modeId === "cloud"}`,
    );

    // And the in-memory accessor must agree with what is painted.
    assert.strictEqual(
      w.eval(`activeCustomSkills()[0].name`),
      `custom_${modeId}`,
    );
  }
});

test("per-mode settings groups are shown for exactly the right modes", async () => {
  const { dom } = boot();
  const w = dom.window;
  await settle();

  const shown = (id) => w.document.getElementById(id)?.style.display !== "none";

  const expectations = [
    ["builtinSkillsGroup", DIVE_SKILL_MODE_IDS],
    ["customSkillsGroup", DIVE_SKILL_MODE_IDS],
    ["bookSearchConfigGroup", DIVE_SKILL_MODE_IDS],
    ["piSettingsGroup", ["pi"]],
    ["cloudSettingsGroup", ["cloud"]],
    ["lmStudioSettingsGroup", ["lmstudio"]],
    ["llamaCppSettingsGroup", ["llamacpp"]],
    ["llamaCppModelsGroup", ["llamacpp"]],
    ["ollamaGenGroup", ["ollama"]],
  ];

  for (const modeId of MODE_IDS) {
    w.eval(`setMode(${JSON.stringify(modeId)})`);
    await settle();
    for (const [id, modes] of expectations) {
      assert.strictEqual(
        shown(id),
        modes.includes(modeId),
        `${id} in ${modeId}: expected ${modes.includes(modeId) ? "shown" : "hidden"}`,
      );
    }
  }
});

test("exactly one topbar button is active per mode", async () => {
  const { dom } = boot();
  const w = dom.window;
  await settle();

  for (const modeId of MODE_IDS) {
    w.eval(`setMode(${JSON.stringify(modeId)})`);
    await settle();
    const active = MODE_DEFS.filter(
      (d) => w.document.getElementById(d.btnId)?.className === "active",
    ).map((d) => d.id);
    assert.deepStrictEqual(
      active,
      [modeId],
      `${modeId}: expected only its own button active`,
    );
    assert.strictEqual(
      w.document.documentElement.getAttribute("data-mode"),
      modeId,
    );
  }
});

test("attachments stay with their own mode across switches", async () => {
  const { dom } = boot();
  const w = dom.window;
  await settle();

  // Drop a file into each mode's bucket, then walk the modes twice and
  // confirm each still sees only its own.
  for (const modeId of MODE_IDS) {
    w.eval(`
      setMode(${JSON.stringify(modeId)});
      setActivePendingFiles([{ name: "file_${modeId}.txt", kind: "text", text: "x" }]);
    `);
    await settle();
  }
  for (let pass = 0; pass < 2; pass++) {
    for (const modeId of MODE_IDS) {
      w.eval(`setMode(${JSON.stringify(modeId)})`);
      await settle();
      assert.strictEqual(
        w.eval("JSON.stringify(activePendingFiles().map((f) => f.name))"),
        JSON.stringify([`file_${modeId}.txt`]),
        `${modeId}: attachments leaked across modes on pass ${pass}`,
      );
    }
  }
});

test("renderMode is idempotent and leaves no stale nodes", async () => {
  const { dom } = boot();
  const w = dom.window;
  await settle();

  w.eval('setMode("cloud")');
  await settle();
  await settle();
  const before = w.document.getElementById("customSkillsList").innerHTML;
  const beforeCount = w.document.querySelectorAll(
    "#customSkillsList .prompt-item",
  ).length;

  w.eval('renderMode("cloud"); renderMode("cloud");');
  await settle();

  assert.strictEqual(
    w.document.getElementById("customSkillsList").innerHTML,
    before,
    "repeated renderMode changed the DOM",
  );
  assert.strictEqual(
    w.document.querySelectorAll("#customSkillsList .prompt-item").length,
    beforeCount,
    "repeated renderMode duplicated nodes",
  );
});

test("the removed per-mode aliases are gone from global scope", async () => {
  const { dom } = boot();
  const w = dom.window;
  await settle();

  // The bug pattern: a module-level binding holding a reference into a
  // *ByMode bucket, re-pointed by hand on every switch. Checked at runtime
  // through the global lexical scope, so `let` bindings are visible too.
  for (const alias of [
    "builtinSkillsConfig",
    "customSkills",
    "pendingFiles",
    "lastMcpStatuses",
    "syncActiveSkillModeState",
  ]) {
    assert.strictEqual(
      w.eval(`typeof ${alias}`),
      "undefined",
      `${alias} is back — read the active mode's bucket through an accessor`,
    );
  }

  // Their replacements are functions, evaluated per call.
  for (const accessor of [
    "activeBuiltinSkills",
    "activeCustomSkills",
    "activePendingFiles",
    "setActivePendingFiles",
    "renderMode",
  ]) {
    assert.strictEqual(w.eval(`typeof ${accessor}`), "function", accessor);
  }
});

test("LOCAL_MODE_IDS drives local-model controls", async () => {
  const { dom } = boot();
  const w = dom.window;
  await settle();
  for (const modeId of MODE_IDS) {
    w.eval(`setMode(${JSON.stringify(modeId)})`);
    await settle();
    assert.strictEqual(
      w.eval("LOCAL_MODE_IDS.includes(mode)"),
      LOCAL_MODE_IDS.includes(modeId),
    );
  }
});
