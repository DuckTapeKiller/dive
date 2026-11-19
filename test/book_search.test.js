const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Data directory first: the SSRF guard's module reads it at require time.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dive-books-test-"));
process.env.DIVE_DATA_DIR = dataDir;

const books = require("../skills/books/index.js");
const adapter = require("../skills/books/obsidian-adapter.js");
const gbs = require("../skills/books/global-book-search.js");

test.after(() => {
  adapter.setFetch(null);
  adapter.trustOrigin("");
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// A fetch stand-in that records every request and answers from `respond`.
function stubFetch(respond) {
  const calls = [];
  adapter.setFetch(async (url, init) => {
    calls.push({ url, headers: { ...(init?.headers || {}) } });
    const { status = 200, body = "", headers = {} } = respond(url) || {};
    return new Response(body, { status, headers });
  });
  return calls;
}

test("Dive's settings reach the plugin under its own names", () => {
  const settings = books.pluginSettings(
    {
      googleApiKey: " g-key ",
      hardcoverToken: "hc",
      librarythingToken: "lt",
      calibreServerUrl: "http://127.0.0.1:8085/",
      calibreLibraryId: "Books",
      storygraphSessionCookie: "sess",
      storygraphRememberToken: "remember",
    },
    "es-ES",
  );
  assert.strictEqual(settings.apiKey, "g-key");
  assert.strictEqual(settings.hardcoverApiToken, "hc");
  assert.strictEqual(settings.librarythingApiKey, "lt");
  assert.strictEqual(settings.calibreServerUrl, "http://127.0.0.1:8085");
  assert.strictEqual(settings.calibreLibraryId, "Books");
  assert.strictEqual(settings.storygraphSessionCookie, "sess");
  assert.strictEqual(settings.storygraphRememberToken, "remember");
  assert.strictEqual(settings.localePreference, "es");
  // The plugin's own field-by-field source order comes along unchanged.
  assert.deepStrictEqual(
    settings.fieldSourcePreferences,
    gbs.DEFAULT_SETTINGS.fieldSourcePreferences,
  );
  assert.strictEqual(books.pluginSettings({}, "").localePreference, "default");
});

test("an ISBN is recognised with or without hyphens and prefix", () => {
  assert.strictEqual(books.detectIsbn("978-0-06-088328-7"), "9780060883287");
  assert.strictEqual(books.detectIsbn("ISBN: 0060883286"), "0060883286");
  assert.strictEqual(books.detectIsbn("030738726x"), "030738726X");
  assert.strictEqual(books.detectIsbn("Dune"), "");
  assert.strictEqual(books.detectIsbn("12345"), "");
});

test("the work closest to the query wins, then the one most sources know", () => {
  const works = [
    {
      title: "Gabriel García Márquez: One Hundred Years of Solitude",
      author: "Michael Wood",
      _sourceIds: ["goodreads"],
    },
    {
      title: "One Hundred Years of Solitude",
      author: "Gabriel García Márquez",
      _sourceIds: ["goodreads", "openlibrary"],
    },
    {
      title: "One Hundred Years of Solitude",
      author: "Somebody Else",
      _sourceIds: ["google"],
    },
  ];
  const ranked = books.rankWorks(works, "One Hundred Years of Solitude");
  assert.strictEqual(ranked[0].author, "Gabriel García Márquez");
  const byAuthor = books.rankWorks(
    works,
    "One Hundred Years of Solitude Somebody Else",
  );
  assert.strictEqual(byAuthor[0].author, "Somebody Else");
});

test("the result table shows what is known and says why sources were missing", () => {
  const out = books.formatResult({
    book: {
      title: "El amor en los tiempos del cólera",
      originalTitle: "El amor en los tiempos del colera",
      authors: ["Gabriel García Márquez"],
      translator: "",
      isbn10: "0307387267",
      asin: "0307387267",
      series: "Obras",
      seriesNumber: 3,
      moods: "reflective | slow",
      link: "https://www.goodreads.com/book/show/500400",
      coverUrl: "https://covers.example/cover.jpg",
      description: "De jóvenes, Florentino…",
    },
    sources: ["Goodreads", "Open Library"],
    conflicts: [
      {
        fieldName: "publisher",
        label: "Publisher",
        values: [
          { value: "Vintage Español", source: "Goodreads" },
          { value: "Vintage", source: "Open Library" },
        ],
      },
    ],
    others: [{ title: "Guía de lectura", author: "ResumenExpress" }],
    outcomes: {
      goodreads: { outcome: "found", reason: "" },
      storygraph: { outcome: "failed", reason: "sign-in needed" },
      google: { outcome: "failed", reason: "quota used up" },
      hardcover: { outcome: "failed", reason: "" },
    },
    primaryId: "goodreads",
  });
  assert.match(out, /^## El amor en los tiempos del cólera/);
  assert.match(out, /\| Series \| Obras #3 \|/);
  // A pipe inside a value must not break the table.
  assert.match(out, /\| Moods \| reflective \/ slow \|/);
  // Nothing empty, and nothing that only repeats another row.
  assert.doesNotMatch(out, /Translator/);
  assert.doesNotMatch(out, /ASIN/);
  assert.doesNotMatch(out, /Original title/);
  assert.match(
    out,
    /<!-- sources: \[goodreads\]\(https:\/\/www\.goodreads\.com\/book\/show\/500400\) -->/,
  );
  assert.match(
    out,
    /Sources disagree on\*\* Publisher: Vintage Español \(Goodreads\) vs Vintage \(Open Library\)/,
  );
  assert.match(out, /Other matches.*Guía de lectura \(ResumenExpress\)/);
  assert.match(
    out,
    /StoryGraph \(sign-in needed: add your StoryGraph login in Settings → TOOLS → BOOK SEARCH PROVIDERS\)/,
  );
  assert.match(out, /Google Books \(quota used up: .*API key/);
  assert.match(out, /Hardcover \(no answer\)/);
});

test("the StoryGraph login goes to StoryGraph and nowhere else", async () => {
  const calls = stubFetch((url) =>
    url.includes("thestorygraph.com")
      ? { body: "<html><title>Sign In</title>You need to sign in</html>" }
      : { body: "[]", headers: { "content-type": "application/json" } },
  );
  const settings = books.pluginSettings(
    { storygraphSessionCookie: "SESSION", storygraphRememberToken: "REMEMBER" },
    "",
  );
  await assert.rejects(
    gbs.factoryServiceProvider(settings, "storygraph").getByQuery("Dune"),
    (error) =>
      error instanceof gbs.ProviderBlockedError &&
      error.shortReason === "login not accepted",
  );
  await gbs
    .factoryServiceProvider(settings, "goodreads")
    .getByQuery("Dune")
    .catch(() => []);
  const story = calls.filter(
    (c) => new URL(c.url).hostname === "app.thestorygraph.com",
  );
  assert.ok(story.length, "StoryGraph was never asked");
  for (const call of story) {
    assert.strictEqual(
      call.headers.Cookie,
      "_storygraph_session=SESSION; remember_user_token=REMEMBER",
    );
  }
  const elsewhere = calls.filter(
    (c) => new URL(c.url).hostname !== "app.thestorygraph.com",
  );
  assert.ok(elsewhere.length, "Goodreads was never asked");
  for (const call of elsewhere) {
    assert.ok(
      !Object.keys(call.headers).some((k) => k.toLowerCase() === "cookie"),
      `a cookie went to ${call.url}`,
    );
  }
});

test("without a login StoryGraph says how to add one, at once", async () => {
  stubFetch(() => ({
    status: 403,
    body: "<html><title>Just a moment...</title></html>",
    headers: { "cf-mitigated": "challenge" },
  }));
  const out = await books.executeBookSearch(
    { query: "Dune", provider: "storygraph" },
    { dataDir },
  );
  assert.match(
    out,
    /^Book Search Error: StoryGraph refused the search \(sign-in needed: add your StoryGraph login/,
  );
});

test("requests to private addresses are refused unless the user configured them", async () => {
  stubFetch(() => ({ body: "{}" }));
  const { obsidian } = adapter;
  await assert.rejects(
    obsidian.requestUrl({ url: "http://127.0.0.1:9/x" }),
    /blocked|private|local/i,
  );
  adapter.trustOrigin("http://127.0.0.1:8085");
  const ok = await obsidian.requestUrl({
    url: "http://127.0.0.1:8085/ajax/search?query=x",
  });
  assert.strictEqual(ok.status, 200);
  adapter.trustOrigin("");
  // A public page that redirects to a private address is refused at the hop.
  stubFetch((url) =>
    url.startsWith("https://books.example")
      ? { status: 302, headers: { location: "http://169.254.169.254/latest" } }
      : { body: "secret" },
  );
  await assert.rejects(
    obsidian.requestUrl({ url: "https://books.example/start", throw: false }),
    /blocked|private|local|address/i,
  );
});

test("requestUrl behaves as Obsidian's: status, lower-case headers, json, throw", async () => {
  stubFetch(() => ({
    status: 200,
    body: '{"a":1}',
    headers: { "Content-Type": "application/json" },
  }));
  const res = await adapter.obsidian.requestUrl({
    url: "https://books.example/api",
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers["content-type"], "application/json");
  assert.deepStrictEqual(res.json, { a: 1 });
  assert.strictEqual(res.text, '{"a":1}');
  stubFetch(() => ({ status: 404, body: "nope" }));
  await assert.rejects(
    adapter.obsidian.requestUrl({ url: "https://books.example/x" }),
    /status 404/,
  );
  const quiet = await adapter.obsidian.requestUrl({
    url: "https://books.example/x",
    throw: false,
  });
  assert.strictEqual(quiet.status, 404);
});

test("the DOM parser builds a whole document, as a browser's does", () => {
  const parse = (text) =>
    new adapter.DOMParser().parseFromString(text, "text/html");
  assert.strictEqual(parse("<div class=x>hi</div>").body.textContent, "hi");
  assert.strictEqual(parse("[]").body.textContent, "[]");
  assert.strictEqual(parse("").documentElement.tagName.toUpperCase(), "HTML");
  const page = parse(
    "<html><head><title>T</title></head><body>b</body></html>",
  );
  assert.strictEqual(page.querySelector("title").textContent, "T");
  assert.strictEqual(page.body.textContent, "b");
});
