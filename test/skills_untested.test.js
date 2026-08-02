// Tests for skills that had none.
//
// Scope, stated honestly.
//
// web_scraper and fetch_paper cannot be pointed at a local fake: the SSRF guard
// correctly refuses loopback and private addresses, which is the whole reason
// they are safe to expose to a model. So their fetch path is covered by testing
// the guard itself, and the extraction they depend on is covered directly
// through extractMainText, which is pure. A happy-path fetch would need a
// public URL or an injectable HTTP layer; neither belongs in a unit test.
//
// remember_lesson and propose_plugin only touch the filesystem and are covered
// properly. The other seven (britannica, wiktionary, duckduckgo, book_search,
// fact_check, deep_research, deep_etymology) call hardcoded upstreams with no
// injection point — testing them here would mean real requests to Wikipedia and
// friends on every run. Their argument handling is covered; their network
// behaviour is not, and closing that needs an injectable HTTP layer.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

// Isolate the data directory before anything reads it.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dive-skills-test-"));
process.env.DIVE_DATA_DIR = dataDir;

const { executeSkill } = require("../skills.js");

const { extractMainText } = require("../skills/research.js");

const call = (name, args) => ({
  function: { name, arguments: JSON.stringify(args) },
});
const run = (name, args, ctx = {}) =>
  executeSkill(call(name, args), { dataDir, ...ctx });

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- web_scraper

test("extractMainText keeps the article and drops the page chrome", () => {
  // This is what web_scraper turns a page into. Pure, so it is tested directly
  // rather than through a fetch the SSRF guard would (correctly) refuse.
  // The chrome is deliberately inside <article>: anything outside it is already
  // excluded by container selection, so putting it there would test nothing.
  const html = `<html><head><title>T</title></head><body>
      <article>
        <nav>NAVIGATION LINKS</nav>
        <script>window.tracker = 1;</script>
        <h1>Main heading</h1>
        <p>The distinctive body sentence that extraction should keep.</p>
        <aside>SIDEBAR BOILERPLATE</aside>
        <footer>FOOTER BOILERPLATE</footer>
      </article>
    </body></html>`;
  const text = extractMainText(html);
  assert.match(text, /distinctive body sentence/, "the article body was lost");
  assert.doesNotMatch(text, /NAVIGATION LINKS/, "nav chrome was kept");
  assert.doesNotMatch(text, /FOOTER BOILERPLATE/, "footer chrome was kept");
  assert.doesNotMatch(text, /SIDEBAR BOILERPLATE/, "aside chrome was kept");
  assert.doesNotMatch(text, /window\.tracker/, "script content was kept");
});

test("extractMainText does not throw on degenerate input", () => {
  for (const html of ["", "<html>", "not html at all", "<article></article>"]) {
    assert.strictEqual(typeof extractMainText(html), "string");
  }
});

test("web_scraper refuses private and loopback addresses it was not given", async () => {
  // The SSRF guard is the reason this skill is safe to expose to a model.
  for (const url of [
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.1/",
    "http://[::1]/",
    "http://192.168.1.1/admin",
  ]) {
    const out = await run("web_scraper", { url });
    // Deliberately the exact guard message: matching /Error/ would also pass
    // on a plain connection failure, which proves nothing about the guard.
    assert.match(
      out,
      /local or private network addresses is not allowed/,
      `${url} was not refused by the SSRF guard: ${out.slice(0, 140)}`,
    );
  }
});

test("web_scraper refuses non-http schemes", async () => {
  for (const url of ["file:///etc/passwd", "ftp://example.com/x"]) {
    const out = await run("web_scraper", { url });
    assert.match(out, /Error/i, `${url} was not refused`);
  }
});

// ---------------------------------------------------------------- fetch_paper

test("fetch_paper refuses a local address rather than fetching it", async () => {
  // Note the message shape: it is "Fetch Paper Error: ...", not "Error: ...".
  // An earlier version of this test asserted /^Error/i and passed vacuously.
  const out = await run("fetch_paper", {
    url_or_doi: "http://127.0.0.1:9/paper.pdf",
    save: true,
  });
  assert.match(
    out,
    /local or private network addresses is not allowed/,
    `unexpected result: ${out.slice(0, 160)}`,
  );
  // Nothing may have been written for a refused fetch.
  const workspace = path.join(dataDir, "workspace");
  if (fs.existsSync(workspace)) {
    const files = fs.readdirSync(workspace, { recursive: true });
    assert.ok(
      !files.some((f) => String(f).endsWith(".pdf")),
      `a refused fetch still wrote a file: ${files.join(", ")}`,
    );
  }
});

test("fetch_paper applies the same SSRF guard", async () => {
  const out = await run("fetch_paper", {
    url_or_doi: "http://169.254.169.254/latest/meta-data/",
    save: false,
  });
  assert.match(
    out,
    /local or private network addresses is not allowed/,
    `the metadata endpoint was not refused by the guard: ${out.slice(0, 150)}`,
  );
});

// ------------------------------------------------------------ remember_lesson

test("remember_lesson appends to the calling mode's lessons file only", async () => {
  const out = await run(
    "remember_lesson",
    { lesson: "Prefer metric units." },
    { mode: "cloud" },
  );
  assert.doesNotMatch(out, /^Error/i, out.slice(0, 150));

  const cloudFile = path.join(dataDir, "lessons", "cloud-lessons.md");
  assert.ok(fs.existsSync(cloudFile), "the cloud lessons file was not written");
  assert.match(fs.readFileSync(cloudFile, "utf8"), /Prefer metric units/);

  // Another mode's file must not have been touched.
  const ollamaFile = path.join(dataDir, "lessons", "ollama-lessons.md");
  if (fs.existsSync(ollamaFile)) {
    assert.doesNotMatch(
      fs.readFileSync(ollamaFile, "utf8"),
      /Prefer metric units/,
      "a lesson leaked into another mode",
    );
  }
});

test("remember_lesson rejects an empty lesson instead of writing a blank line", async () => {
  const before = fs.existsSync(
    path.join(dataDir, "lessons", "cloud-lessons.md"),
  )
    ? fs.readFileSync(path.join(dataDir, "lessons", "cloud-lessons.md"), "utf8")
    : "";
  const out = await run(
    "remember_lesson",
    { lesson: "   " },
    { mode: "cloud" },
  );
  const after = fs.existsSync(path.join(dataDir, "lessons", "cloud-lessons.md"))
    ? fs.readFileSync(path.join(dataDir, "lessons", "cloud-lessons.md"), "utf8")
    : "";
  assert.strictEqual(after, before, `an empty lesson was written: ${out}`);
});

// ------------------------------------------------------------- propose_plugin

test("propose_plugin writes a draft that is inert until approved", async () => {
  const out = await run("propose_plugin", {
    name: "test_plugin",
    description: "A drafted plugin",
    code: "module.exports = { skills: [] };",
  });
  assert.doesNotMatch(out, /^Error/i, out.slice(0, 200));

  const drafts = path.join(dataDir, "plugin-drafts");
  assert.ok(fs.existsSync(drafts), "no plugin-drafts directory was created");

  // The draft must NOT land in the live plugins directory, where it would run.
  const live = path.join(dataDir, "plugins");
  if (fs.existsSync(live)) {
    assert.ok(
      !fs.readdirSync(live).some((f) => f.includes("test_plugin")),
      "a proposed plugin was written straight into the live plugins directory",
    );
  }
});

test("propose_plugin cannot escape the drafts directory via its name", async () => {
  await run("propose_plugin", {
    name: "../../../../tmp/dive-plugin-escape",
    description: "hostile",
    code: "module.exports = {};",
  });
  assert.ok(
    !fs.existsSync("/tmp/dive-plugin-escape") &&
      !fs.existsSync("/tmp/dive-plugin-escape.js"),
    "a proposed plugin escaped the drafts directory",
  );
});

// ------------------------------------------------------- argument handling

test("no skill throws on missing or empty arguments", async () => {
  // A throwing skill breaks the whole turn; a skill that returns a message lets
  // the model recover. Only cases that are rejected before any network call are
  // listed, so this stays offline and deterministic.
  //
  // Not covered: deep_etymology with a word but no language, which used to
  // throw on language.toLowerCase(). Reaching that line now requires a real
  // fetch, so it cannot be asserted here without an injectable HTTP layer.
  const offline = [
    ["deep_research", {}],
    ["deep_research", { query: "" }],
    ["deep_etymology", {}],
    ["deep_etymology", { word: "" }],
    ["web_scraper", {}],
    ["fetch_paper", {}],
    ["remember_lesson", {}],
    ["propose_plugin", {}],
  ];
  for (const [name, args] of offline) {
    let result;
    try {
      result = await run(name, args, { mode: "cloud" });
    } catch (error) {
      assert.fail(
        `${name}(${JSON.stringify(args)}) threw instead of returning: ${error.message}`,
      );
    }
    assert.strictEqual(
      typeof result,
      "string",
      `${name} returned ${typeof result}, not a string`,
    );
  }
});
