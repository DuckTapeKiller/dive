"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  CHALLENGE_PAGE_RE,
  canonicalResearchUrl,
  isForbiddenResearchUrl,
  isLarousseUrl,
  isScholarpediaUrl,
  isSnlUrl,
  forbiddenResearchUrlError,
  validateReaderText,
  rankResearchCandidates,
  selectDiverseResearchCandidates,
  compactEvidenceText,
  sourceReliabilityLabel,
} = require("../skills/research-quality.js");
const {
  executeDeepResearch,
  executeLarousse,
  executeScholarpedia,
  executeSnl,
  extractLarousseSearchResults,
  extractScholarpediaArticleText,
  extractScholarpediaSearchResults,
  extractSnlArticleText,
  extractSnlHtmlSearchResults,
  extractSnlSearchResults,
  readUrlContent,
  extractArchivePhMementos,
  extractArchivePhSnapshotUrls,
} = require("../skills/research.js");
const { extractWebSources } = require("../routes/web-sources.js");

test("Grokipedia is permanently blocked, including subdomains and mirrors", () => {
  for (const url of [
    "https://grokipedia.com/wiki/Example",
    "https://www.grokipedia.com/wiki/Example",
    "https://mirror-grokipedia.net/article",
    "https://grokipedia-mirror.org/article",
  ]) {
    assert.equal(isForbiddenResearchUrl(url), true, url);
    assert.match(forbiddenResearchUrlError(url), /permanently blocked/i);
  }
  assert.equal(
    isForbiddenResearchUrl("https://en.wikipedia.org/wiki/Example"),
    false,
  );
  assert.equal(
    isLarousseUrl(
      "https://www.larousse.fr/encyclopedie/personnage/Marie_Curie/123456",
    ),
    true,
  );
  assert.equal(
    isScholarpediaUrl("https://www.scholarpedia.org/article/Neural_network"),
    true,
  );
  assert.equal(isSnlUrl("https://snl.no/Marie_Curie"), true);
  assert.equal(isSnlUrl("https://sml.snl.no/medisin"), false);
  assert.equal(forbiddenResearchUrlError("https://example.org/article"), "");
});

test("reader quality gate rejects challenge HTML and reader error payloads", () => {
  assert.match(
    "Just a moment... Enable JavaScript and cookies to continue",
    CHALLENGE_PAGE_RE,
  );
  assert.equal(
    validateReaderText(
      "<!doctype html><html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>",
      20,
    ).ok,
    false,
  );
  assert.equal(
    validateReaderText('{"error":"upstream unavailable"}'.padEnd(220, " "), 20)
      .ok,
    false,
  );
  assert.equal(
    validateReaderText(
      "Subscribe to continue reading. Sign in to continue reading this article.".padEnd(
        220,
        " ",
      ),
      20,
    ).ok,
    false,
  );
  assert.equal(
    validateReaderText(
      "A real article begins here. " +
        "It contains enough ordinary prose to establish that the reader returned content rather than a challenge page. ".repeat(
          4,
        ),
      20,
    ).ok,
    true,
  );
});

test("readUrlContent refuses Grokipedia before any reader request", async () => {
  let requested = false;
  const result = await readUrlContent(
    "https://grokipedia.com/wiki/Example",
    1000,
    {
      fetchHtmlFn: async () => {
        requested = true;
        return "should never be fetched";
      },
      readViaWaybackFn: async () => null,
      retryDelayMs: 0,
    },
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /Grokipedia.*blocked/i);
  assert.equal(requested, false);
});

test("readUrlContent rejects a mocked Jina challenge and accepts real prose", async () => {
  const challenge =
    "<!doctype html><html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>";
  const valid =
    "A verified article paragraph. " +
    "This mocked response contains ordinary source prose and no reader challenge. ".repeat(
      12,
    );
  const blocked = await readUrlContent("https://example.com/article", 1000, {
    fetchHtmlFn: async () => challenge,
    readViaWaybackFn: async () => null,
    readViaArchivePhFn: async () => null,
    retryDelayMs: 0,
  });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /challenge|CAPTCHA|failed/i);

  const accepted = await readUrlContent("https://example.com/article", 1000, {
    fetchHtmlFn: async () => valid,
    readViaWaybackFn: async () => null,
    readViaArchivePhFn: async () => null,
    retryDelayMs: 0,
  });
  assert.equal(accepted.ok, true);
  assert.match(accepted.text, /verified article paragraph/);

  const archived = await readUrlContent("https://example.com/article", 1000, {
    fetchHtmlFn: async () => challenge,
    readViaWaybackFn: async () => null,
    readViaArchivePhFn: async () => ({
      ok: true,
      text: valid,
      retrieval: {
        service: "archive.ph",
        archivedUrl: "https://archive.ph/abc12",
        capturedAt: "Wed, 03 Jan 2024 00:00:00 GMT",
      },
    }),
    retryDelayMs: 0,
  });
  assert.equal(archived.ok, true);
  assert.equal(archived.retrieval.service, "archive.ph");
  assert.equal(archived.retrieval.archivedUrl, "https://archive.ph/abc12");
});

test("Archive.ph Memento and HTML parsers keep only archive.ph snapshots", () => {
  const timemap = [
    '<https://archive.ph/newer>; rel="memento"; datetime="Wed, 03 Jan 2024 00:00:00 GMT"',
    '<https://archive.ph/older>; rel="memento"; datetime="Mon, 01 Jan 2024 00:00:00 GMT"',
    '<https://example.org/not-archive>; rel="memento"; datetime="Thu, 04 Jan 2024 00:00:00 GMT"',
  ].join("\n");
  assert.deepEqual(extractArchivePhMementos(timemap), [
    {
      url: "https://archive.ph/newer",
      datetime: "Wed, 03 Jan 2024 00:00:00 GMT",
    },
    {
      url: "https://archive.ph/older",
      datetime: "Mon, 01 Jan 2024 00:00:00 GMT",
    },
  ]);
  assert.deepEqual(
    extractArchivePhSnapshotUrls(
      '<a href="https://archive.ph/abc12">good</a><a href="https://archive.ph/submit/">ignore</a><a href="https://example.org/no">ignore</a>',
    ),
    ["https://archive.ph/abc12"],
  );
});

test("Larousse search and article extraction keep encyclopedia records", async () => {
  const searchHtml = `
    <section class="dossier"><article class="content">
      <header><a href="/encyclopedie/personnage/Marie_Curie/123456">Voir le dossier</a><h1>Marie Curie</h1></header>
      <p>Scientifique d'origine polonaise, Marie Curie a contribué à l'étude de la radioactivité.</p>
    </article></section>
    <article><a href="/encyclopedie/personnage/Marie_Curie/123456"><h4>Marie Curie</h4><p>Physicienne et chimiste.</p></a></article>
    <article><a href="/encyclopedie/images/Marie_Curie/1"><h4>Image</h4></a></article>`;
  const articleText =
    "Scientifique d'origine polonaise, Marie Curie a contribué à l'étude de la radioactivité. ".repeat(
      5,
    );
  const result = await executeLarousse(
    { query: "Marie Curie" },
    {
      fetchHtmlFn: async (url) =>
        url.includes("/rechercher?")
          ? searchHtml
          : `<article class="content"><h1>Marie Curie</h1><p>${articleText}</p></article>`,
    },
  );
  assert.match(result, /^## Larousse: Marie Curie/m);
  assert.match(result, /radioactivité/);
  assert.match(
    result,
    /https:\/\/www\.larousse\.fr\/encyclopedie\/personnage\/Marie_Curie\/123456/,
  );
  assert.deepEqual(
    extractLarousseSearchResults(searchHtml).map((item) => item.url),
    ["https://www.larousse.fr/encyclopedie/personnage/Marie_Curie/123456"],
  );
});

test("Scholarpedia uses the MediaWiki API and keeps article HTML bounded", async () => {
  const scholarlyText =
    "Neural networks are computational models studied in machine learning and neuroscience. ".repeat(
      5,
    );
  const result = await executeScholarpedia(
    { query: "neural networks" },
    {
      fetchJsonFn: async (url) =>
        url.includes("list=search")
          ? {
              query: {
                search: [{ title: "Neural_network" }],
              },
            }
          : {
              query: {
                pages: [
                  {
                    title: "Neural network",
                    fullurl:
                      "https://www.scholarpedia.org/article/Neural_network",
                    extract: scholarlyText,
                  },
                ],
              },
            },
    },
  );
  assert.match(result, /^## Scholarpedia: Neural network/m);
  assert.match(result, /computational models/);
  assert.match(
    result,
    /https:\/\/www\.scholarpedia\.org\/article\/Neural_network/,
  );

  const html = `
    <div id="mw-content-text"><div class="mw-parser-output">
      <h1>Neural networks</h1><p>Article paragraph.</p>
      <div class="references"><p>Reference noise.</p></div>
    </div></div>`;
  assert.match(extractScholarpediaArticleText(html), /Article paragraph/);
  assert.doesNotMatch(extractScholarpediaArticleText(html), /Reference noise/);
  assert.deepEqual(
    extractScholarpediaSearchResults(
      '<a href="/article/Neural_network">Neural networks</a><a href="/wiki/Special:RecentChanges">ignore</a>',
    ),
    [
      {
        title: "Neural networks",
        url: "https://www.scholarpedia.org/article/Neural_network",
      },
    ],
  );
});

test("Store norske leksikon uses autocomplete and structured article text", async () => {
  const articleText =
    "Marie Curie var en polskfødt fysiker som oppdaget radioaktive grunnstoffer sammen med Pierre Curie. ".repeat(
      8,
    );
  const articleHtml = `
    <article class="l-article">
      <h1>Marie Curie</h1>
      <section class="l-article__body-text" id="_article-top">
        <div class="article-text"><p>${articleText}</p></div>
      </section>
      <section class="l-article__section"><h2 class="l-article__subheading">Oppvekst</h2>
        <div class="l-article__body-text"><div class="article-text"><p>Hun vokste opp i Warszawa og studerte senere i Paris.</p></div></div>
      </section>
      <aside class="highlighted-authors"><p>Navigation noise</p></aside>
    </article>`;
  const result = await executeSnl(
    { query: "Marie Curie" },
    {
      fetchJsonFn: async () => [
        {
          id: 55503,
          title: "Marie Curie",
          excerpt: "var en polskfødt fysiker",
          article_url: "https://snl.no/Marie_Curie",
        },
        {
          id: 2,
          title: "Marie Curie",
          article_url: "https://lille.snl.no/Marie_Curie",
          encyclopedia: "Lille norske leksikon",
        },
      ],
      fetchHtmlFn: async (url) => {
        assert.equal(url, "https://snl.no/Marie_Curie");
        return articleHtml;
      },
    },
  );
  assert.match(result, /^## Store norske leksikon: Marie Curie/m);
  assert.match(result, /radioaktive grunnstoffer/);
  assert.doesNotMatch(result, /Navigation noise/);
  assert.match(result, /https:\/\/snl\.no\/Marie_Curie/);
  assert.deepEqual(
    extractSnlSearchResults([
      {
        title: "Marie Curie",
        article_url: "https://snl.no/Marie_Curie",
      },
      {
        title: "Lille Marie Curie",
        article_url: "https://lille.snl.no/Marie_Curie",
      },
    ]),
    [
      {
        title: "Marie Curie",
        url: "https://snl.no/Marie_Curie",
        snippet: "",
        encyclopedia: "",
      },
    ],
  );
  const searchHtml =
    '<div class="l-search__result"><a href="/Marie_Curie"><h2>Marie Curie</h2></a><p>Polskfødt fysiker.</p></div>';
  assert.deepEqual(extractSnlHtmlSearchResults(searchHtml), [
    {
      title: "Marie Curie",
      url: "https://snl.no/Marie_Curie",
      snippet: "Polskfødt fysiker.",
    },
  ]);
  assert.match(extractSnlArticleText(articleHtml), /Oppvekst/);
  assert.doesNotMatch(extractSnlArticleText(articleHtml), /Navigation noise/);
});

test("deep research builds a verified dossier and excludes a mocked challenge source", async () => {
  const validText = (label) =>
    `${label} discusses Dean Benedetti, the jazz saxophonist, and provides dated biographical evidence. `.repeat(
      8,
    );
  const output = await executeDeepResearch(
    {
      queries: ["Dean Benedetti biography", "Dean Benedetti recordings"],
      max_sources: 4,
    },
    {
      researchHooks: {
        executeWikipedia: async () =>
          `## Wikipedia: Dean Benedetti\n\n${validText("Wikipedia")}\n\n<!-- https://en.wikipedia.org/wiki/Dean_Benedetti -->`,
        executeBritannica: async () =>
          `## Britannica: "Dean Benedetti"\n\n${validText("Britannica")}\n\n<!-- https://www.britannica.com/biography/Dean-Benedetti -->`,
        executeLarousse: async () =>
          `## Larousse: Dean Benedetti\n\n${validText("Larousse")}\n\n<!-- https://www.larousse.fr/encyclopedie/personnage/Dean_Benedetti/123456 -->`,
        executeSnl: async () => "No Store norske leksikon article found",
        runWebSearch: async () => ({
          provider: "fixture",
          results: [
            {
              title: "Dean Benedetti archive",
              url: "https://archive.example/dean-benedetti",
              snippet: "Dean Benedetti archival records",
            },
            {
              title: "Dean Benedetti challenge",
              url: "https://blocked.example/dean-benedetti",
              snippet: "Dean Benedetti",
            },
            {
              title: "Dean Benedetti on Grokipedia",
              url: "https://grokipedia.com/wiki/Dean_Benedetti",
              snippet: "Dean Benedetti",
            },
          ],
        }),
        readUrlContent: async (url) =>
          url.includes("blocked.example")
            ? {
                ok: false,
                error: "reader returned a bot-protection page",
              }
            : url.includes("archive.example")
              ? {
                  ok: true,
                  text: validText("Archive"),
                  retrieval: {
                    service: "archive.ph",
                    archivedUrl: "https://archive.ph/abc12",
                    capturedAt: "Wed, 03 Jan 2024 00:00:00 GMT",
                  },
                }
              : { ok: true, text: validText("Archive") },
        sleepMs: async () => {},
      },
    },
  );

  assert.match(output, /Deep research evidence dossier/);
  assert.match(output, /Reliable sources: 4/);
  assert.match(output, /Dean Benedetti archive/);
  assert.match(output, /Larousse/);
  assert.match(output, /https:\/\/archive\.ph\/abc12/);
  assert.match(
    output,
    /Original URL: https:\/\/archive\.example\/dean-benedetti/,
  );
  assert.match(output, /Wikipedia/);
  assert.match(output, /Britannica/);
  assert.doesNotMatch(output, /blocked\.example/);
  assert.doesNotMatch(output, /grokipedia/i);
  assert.match(output, /bot-protection/);
  assert.deepEqual(
    extractWebSources("deep_research", {}, output).map((source) => source.url),
    [
      "https://en.wikipedia.org/wiki/Dean_Benedetti",
      "https://www.larousse.fr/encyclopedie/personnage/Dean_Benedetti/123456",
      "https://www.britannica.com/biography/Dean-Benedetti",
      "https://archive.ph/abc12",
    ],
  );
});

test("deep research adds Scholarpedia for academic scientific topics", async () => {
  const text =
    "Scholarpedia explains neural networks as computational models with expert-reviewed technical background. ".repeat(
      7,
    );
  const output = await executeDeepResearch(
    { query: "neural networks", academic: true, max_sources: 1 },
    {
      researchHooks: {
        executeWikipedia: async () => "Wikipedia Error: unavailable",
        executeBritannica: async () => "No Britannica article found",
        executeLarousse: async () => "No Larousse article found",
        executeSnl: async () => "No Store norske leksikon article found",
        executeScholarpedia: async () =>
          `## Scholarpedia: Neural networks\n\n${text}\n\n<!-- https://www.scholarpedia.org/article/Neural_network -->`,
        runAcademicSearch: async () => [],
        runWebSearch: async () => ({ provider: "fixture", results: [] }),
        sleepMs: async () => {},
      },
    },
  );
  assert.match(output, /Reliable sources: 1/);
  assert.match(output, /Scholarpedia/);
  assert.match(output, /peer-reviewed expert encyclopedia source/);
  assert.deepEqual(
    extractWebSources("deep_research", {}, output).map((source) => source.url),
    ["https://www.scholarpedia.org/article/Neural_network"],
  );
});

test("deep research includes Store norske leksikon as an encyclopedic anchor", async () => {
  const text =
    "Store norske leksikon describes Marie Curie as a Polish-born physicist and chemist who researched radioactivity. ".repeat(
      7,
    );
  const output = await executeDeepResearch(
    { query: "Marie Curie", max_sources: 1 },
    {
      researchHooks: {
        executeWikipedia: async () => "Wikipedia Error: unavailable",
        executeBritannica: async () => "No Britannica article found",
        executeLarousse: async () => "No Larousse article found",
        executeSnl: async () =>
          `## Store norske leksikon: Marie Curie\n\n${text}\n\n<!-- https://snl.no/Marie_Curie -->`,
        executeScholarpedia: async () => "No Scholarpedia article found",
        runWebSearch: async () => ({ provider: "fixture", results: [] }),
        sleepMs: async () => {},
      },
    },
  );
  assert.match(output, /Reliable sources: 1/);
  assert.match(output, /Store norske leksikon/);
  assert.match(output, /Norwegian editorial encyclopedia source/);
  assert.deepEqual(
    extractWebSources("deep_research", {}, output).map((source) => source.url),
    ["https://snl.no/Marie_Curie"],
  );
});

test("canonical research URLs remove tracking noise without changing the source", () => {
  assert.equal(
    canonicalResearchUrl(
      "https://Example.org/article/?utm_source=test&ref=home&id=7#section",
    ),
    "https://example.org/article?id=7",
  );
});

test("candidate ranking prefers relevant authoritative evidence and drops unrelated pages", () => {
  const ranked = rankResearchCandidates(
    [
      {
        title: "Dean Benedetti",
        url: "https://en.wikipedia.org/wiki/Dean_Benedetti",
        snippet: "Biography and recordings of the jazz saxophonist.",
        sourceType: "wikipedia",
        anchor: true,
      },
      {
        title: "Dean Benedetti archive",
        url: "https://archive.example.org/dean-benedetti",
        snippet: "Catalogued recordings and correspondence.",
        sourceType: "web",
      },
      {
        title: "Charlie Parker",
        url: "https://example.org/charlie-parker",
        snippet: "A general article about a different musician.",
        sourceType: "web",
      },
    ],
    "Dean Benedetti biography",
    { primaryQuery: "Dean Benedetti biography" },
  );
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].sourceType, "wikipedia");
  assert.match(ranked[0].matchedTokens.join(" "), /dean|benedetti/);
});

test("diversity selection keeps anchors and distinct domains before top-up", () => {
  const selected = selectDiverseResearchCandidates(
    [
      {
        title: "Wiki",
        url: "https://en.wikipedia.org/wiki/X",
        domain: "en.wikipedia.org",
        anchor: true,
      },
      {
        title: "Britannica",
        url: "https://www.britannica.com/topic/X",
        domain: "britannica.com",
        anchor: true,
      },
      { title: "Source A", url: "https://a.example/X", domain: "a.example" },
      {
        title: "Source A duplicate",
        url: "https://a.example/Y",
        domain: "a.example",
      },
      { title: "Source B", url: "https://b.example/X", domain: "b.example" },
    ],
    4,
  );
  assert.deepEqual(
    selected.map((item) => item.title),
    ["Wiki", "Britannica", "Source A", "Source B"],
  );
});

test("evidence excerpts are bounded and reliability is labelled", () => {
  const excerpt = compactEvidenceText(
    "Sentence one.\n\n" + "Long evidence. ".repeat(100),
    120,
  );
  assert.ok(excerpt.length <= 160);
  assert.match(
    sourceReliabilityLabel({ sourceType: "wikipedia" }),
    /orientation/i,
  );
  assert.match(
    sourceReliabilityLabel({
      sourceType: "web",
      url: "https://random.example/article",
    }),
    /general web source/i,
  );
  assert.match(
    sourceReliabilityLabel({ retrieval: { service: "wayback" } }),
    /Wayback Machine/,
  );
  assert.match(
    sourceReliabilityLabel({ retrieval: { service: "archive.ph" } }),
    /archive\.ph/,
  );
  assert.match(
    sourceReliabilityLabel({ sourceType: "scholarpedia" }),
    /peer-reviewed/i,
  );
});

test("a look-alike domain cannot inherit the authority it imitates", () => {
  // Authority decides what evidence gets read and cited, so it must not be
  // claimable by registering a host that merely CONTAINS a trusted name.
  // These pairs previously scored identically: the checks were substring
  // matches on the hostname, so "nih.gov.evil-mirror.com" was as authoritative
  // as "nih.gov".
  const score = (url) => {
    const [ranked] = rankResearchCandidates(
      [{ url, title: "Marie Curie biography", snippet: "Marie Curie" }],
      "Marie Curie",
    );
    return ranked ? ranked.score : 0;
  };
  const plain = score("https://some-random-blog.example/curie");

  const pairs = [
    ["https://www.nih.gov/x", "https://nih.gov.evil-mirror.com/x"],
    ["https://www.cam.ac.uk/x", "https://cam.ac.attacker.net/x"],
    ["https://www.nature.com/a", "https://nature.com.phish.io/a"],
    [
      "https://en.wikipedia.org/wiki/X",
      "https://wikipedia.org.evil.com/wiki/X",
    ],
    ["https://arxiv.org/abs/1", "https://arxiv.org.cdn-fake.cc/abs/1"],
    ["https://www.britannica.com/x", "https://britannica.com.reader.xyz/x"],
    ["https://www.loc.gov/x", "https://loc.gov.spam.top/x"],
  ];
  for (const [genuine, lookalike] of pairs) {
    assert.ok(
      score(genuine) > plain,
      `${genuine} lost its authority bonus entirely`,
    );
    assert.strictEqual(
      score(lookalike),
      plain,
      `${lookalike} still scores above an unknown domain (${score(lookalike)} vs ${plain})`,
    );
  }

  // Nor by burying a trusted word in an unrelated registration.
  for (const junk of [
    "https://cheap-university-essays.biz/curie",
    "https://museum-ticket-deals.net/curie",
    "https://pubmed.malware.example/curie",
  ]) {
    assert.strictEqual(score(junk), plain, `${junk} claimed authority`);
  }
});

test("genuine institutional domains keep their authority", () => {
  // The other half: tightening the match must not demote real sources.
  const score = (url) => {
    const [ranked] = rankResearchCandidates(
      [{ url, title: "Marie Curie biography", snippet: "Marie Curie" }],
      "Marie Curie",
    );
    return ranked ? ranked.score : 0;
  };
  const plain = score("https://some-random-blog.example/curie");
  for (const url of [
    "https://www.nih.gov/x",
    "https://www.gov.uk/x",
    "https://mit.edu/x",
    "https://ox.ac.uk/x",
    "https://doi.org/10.1/x",
    "https://pubmed.ncbi.nlm.nih.gov/1/",
    "https://arxiv.org/abs/1",
    "https://www.nature.com/a",
    "https://www.jstor.org/a",
    "https://archive.org/x",
    "https://www.nationalarchives.gov.uk/x",
    "https://en.wikipedia.org/wiki/X",
    "https://www.britannica.com/x",
  ]) {
    assert.ok(score(url) > plain, `${url} was demoted to an unknown domain`);
  }
});
