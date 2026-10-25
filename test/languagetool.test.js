// The LanguageTool route: settings, the Markdown annotation it sends, and the
// check it forwards, against a stand-in LanguageTool server.
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const test = require("node:test");

const createLanguageToolDomain = require("../routes/languagetool.js");
const { buildAnnotation, normalizeServerUrl, sanitizeLanguageToolSettings } =
  createLanguageToolDomain;

// What LanguageTool reads: text kept, markup replaced by its interpretAs.
function readAs(annotation) {
  return annotation
    .map((part) =>
      part.text !== undefined ? part.text : part.interpretAs || "",
    )
    .join("");
}

test("the annotation covers the whole text, in order", () => {
  const text =
    "# Title\n\n- Ayer *fuimos* al `cine` con [Ana](https://a.es/x) y <b>Luis</b>.\n\n```js\nconst x = 1;\n```\nVer https://b.org/y, gracias. snake_case __bold__";
  const { annotation } = buildAnnotation(text);
  const original = annotation
    .map((part) => (part.text !== undefined ? part.text : part.markup))
    .join("");
  assert.equal(original, text);
  assert.equal(
    readAs(annotation),
    "Title\n\nAyer fuimos al 0 con Ana y Luis.\n\n\n\n\nVer 0, gracias. snake_case bold",
  );
});

test("paragraphs split at blank lines, never inside fenced code", () => {
  const long = (word) => `${word} `.repeat(15).trim();
  const text = [
    "# Short heading",
    "",
    long("uno"),
    "",
    "```",
    "code",
    "",
    "more code",
    "```",
    "",
    long("two"),
    "",
    "",
    "Short end.",
  ].join("\n");
  const blocks = createLanguageToolDomain.splitBlocks(text);
  assert.deepStrictEqual(
    blocks.map(([from, to]) => text.slice(from, to)),
    [
      `# Short heading\n\n${long("uno")}`,
      // Code alone says nothing about the language, so it joins the next.
      `\`\`\`\ncode\n\nmore code\n\`\`\`\n\n${long("two")}\n\n\nShort end.`,
    ],
  );
});

test("indentation at a line start is markup", () => {
  const { annotation } = buildAnnotation("First line.\n\n  Indented line.");
  assert.equal(readAs(annotation), "First line.\n\nIndented line.");
});

test("plain prose needs no annotation", () => {
  assert.equal(buildAnnotation("Just a sentence, nothing else."), null);
});

test("settings are sanitized", () => {
  const s = sanitizeLanguageToolSettings({
    enabled: "yes",
    serverUrl: "http://127.0.0.1:8010/v2/",
    language: "es; DROP",
    preferredVariants: "en-GB, bad, es-ES",
    dictionary: ["Dive", "two words", "Dive", 3],
    disabledRules: ["WHITESPACE_RULE", "no spaces allowed"],
    spelling: "macos",
  });
  assert.deepStrictEqual(s, {
    enabled: false,
    serverUrl: "http://127.0.0.1:8010",
    language: "auto",
    preferredVariants: "en-GB,es-ES",
    spelling: "languagetool",
    dictionary: ["Dive"],
    disabledRules: ["WHITESPACE_RULE"],
  });
  assert.equal(
    normalizeServerUrl("file:///etc/passwd"),
    "http://localhost:8010",
  );
  assert.equal(normalizeServerUrl(""), "http://localhost:8010");
});

function fakeLanguageTool() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const fields = Object.fromEntries(new URLSearchParams(body));
      requests.push({ url: req.url, fields });
      const text = fields.text ?? readAs(JSON.parse(fields.data).annotation);
      const matches = [];
      // a/an is a "misspelling" to LanguageTool, but not a speller rule.
      const flagged = [
        ["Divee", "Dive", "MORFOLOGIK_RULE_EN_GB"],
        ["teh", "the", "MORFOLOGIK_RULE_EN_GB"],
        ["a error", "an error", "EN_A_VS_AN"],
      ];
      for (const [word, fix, id] of flagged) {
        const at = (fields.text ?? "").length ? fields.text.indexOf(word) : -1;
        if (at >= 0) {
          matches.push({
            offset: at,
            length: word.length,
            message: "Possible spelling mistake found.",
            replacements: [{ value: fix }],
            rule: {
              id,
              issueType: "misspelling",
              category: { name: "Possible Typo" },
            },
          });
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          software: { name: "LanguageTool", version: "6.4" },
          language: {
            code: fields.language,
            detectedLanguage: { code: "en-GB", name: "English (GB)" },
          },
          matches,
          echo: text,
        }),
      );
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        server,
        requests,
        url: `http://127.0.0.1:${server.address().port}`,
      }),
    ),
  );
}

function call(domain, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    domain
      .handleRequest({
        req: { method, body },
        urlPath,
        send: (status, payload) => resolve({ status, payload }),
      })
      .then((handled) => {
        if (!handled) reject(new Error(`${urlPath} was not handled`));
      }, reject);
  });
}

test("checks go to the configured server and honour the lists", async (t) => {
  const lt = await fakeLanguageTool();
  t.after(() => lt.server.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dive-lt-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const domain = createLanguageToolDomain({
    DATA_DIR: dir,
    parseJsonBody: async (req) => req.body,
  });

  let r = await call(domain, "POST", "/api/languagetool/settings", {
    settings: { enabled: true, serverUrl: lt.url },
  });
  assert.equal(r.payload.settings.serverUrl, lt.url);

  r = await call(domain, "POST", "/api/languagetool/check", {
    text: "Divee fixed teh bug.",
  });
  assert.equal(r.status, 200);
  assert.deepStrictEqual(
    r.payload.matches.map((m) => [m.text, m.replacements[0]]),
    [
      ["Divee", "Dive"],
      ["teh", "the"],
    ],
  );
  assert.deepStrictEqual(r.payload.language, {
    code: "en-GB",
    name: "English (GB)",
  });
  const sent = lt.requests.at(-1).fields;
  assert.equal(sent.language, "auto");
  assert.equal(sent.preferredVariants, "en-GB,es-ES");
  assert.equal(sent.disabledRules, undefined);

  await call(domain, "POST", "/api/languagetool/dictionary", { word: "Divee" });
  await call(domain, "POST", "/api/languagetool/disabled-rules", {
    ruleId: "WHITESPACE_RULE",
  });
  r = await call(domain, "POST", "/api/languagetool/check", {
    text: "Divee fixed teh bug.",
  });
  assert.deepStrictEqual(
    r.payload.matches.map((m) => m.text),
    ["teh"],
  );
  assert.equal(lt.requests.at(-1).fields.disabledRules, "WHITESPACE_RULE");

  // With the system spellchecker on spelling, LanguageTool's speller is
  // dropped but its other spelling-type rules stay.
  await call(domain, "POST", "/api/languagetool/settings", {
    settings: { spelling: "system" },
  });
  r = await call(domain, "POST", "/api/languagetool/check", {
    text: "Hey, teh bot made a error.",
  });
  assert.deepStrictEqual(
    r.payload.matches.map((m) => m.text),
    ["a error"],
  );
  await call(domain, "POST", "/api/languagetool/settings", {
    settings: { spelling: "both" },
  });
  r = await call(domain, "POST", "/api/languagetool/check", {
    text: "Hey, teh bot made a error.",
  });
  assert.deepStrictEqual(
    r.payload.matches.map((m) => m.text),
    ["teh", "a error"],
  );

  r = await call(domain, "POST", "/api/languagetool/check", {
    text: "Use `npm test` now.",
  });
  const data = JSON.parse(lt.requests.at(-1).fields.data);
  assert.equal(readAs(data.annotation), "Use 0 now.");

  r = await call(domain, "GET", "/api/languagetool/status");
  assert.deepStrictEqual(r.payload, {
    ok: true,
    serverUrl: lt.url,
    name: "LanguageTool",
    version: "6.4",
  });
});

test("an unreachable server is reported, not thrown", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dive-lt-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const domain = createLanguageToolDomain({
    DATA_DIR: dir,
    parseJsonBody: async (req) => req.body,
  });
  await call(domain, "POST", "/api/languagetool/settings", {
    settings: { enabled: true, serverUrl: "http://127.0.0.1:9" },
  });
  let r = await call(domain, "POST", "/api/languagetool/check", {
    text: "Hello there.",
  });
  assert.equal(r.status, 502);
  assert.match(r.payload.error, /not reachable at http:\/\/127\.0\.0\.1:9/);
  r = await call(domain, "GET", "/api/languagetool/status");
  assert.equal(r.payload.ok, false);
});
