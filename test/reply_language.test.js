const test = require("node:test");
const assert = require("node:assert");

const {
  detectLanguage,
  needsRewrite,
  withReplyLanguage,
  withLanguageReminder,
  rewriteInLanguage,
} = require("../routes/reply-language.js");

// A real exchange: a Spanish question answered in French by gemma E2B after
// deep_research filled the context with Larousse.
const QUESTION =
  "qué hora es en shangai y cuantos años tenia hemingway cuandoe escribió adios a las armas";
const FRENCH_ANSWER =
  "L'heure actuelle à Shanghai est 18h59min20s, jeudi 19 novembre 2026.\n\nErnest Hemingway avait trente ans lorsqu'il a écrit *Adios a las armas* en 1929.";
const SPANISH_ANSWER =
  "La hora actual en Shanghái es las 18:59 del jueves 19 de noviembre de 2026. Ernest Hemingway tenía 30 años cuando publicó *Adiós a las armas* en 1929.";

test("each language is named when the text is clearly in it", () => {
  const cases = [
    [QUESTION, "Spanish"],
    [FRENCH_ANSWER, "French"],
    [SPANISH_ANSWER, "Spanish"],
    [
      "What time is it in Shanghai, and how old was Hemingway when he wrote it?",
      "English",
    ],
    ["¿qué hora es?", "Spanish"],
    ["Wie alt war Hemingway, als er In einem andern Land schrieb?", "German"],
    ["Quanti anni aveva Hemingway quando scrisse Addio alle armi?", "Italian"],
    [
      "Quantos anos tinha Hemingway quando escreveu Adeus às armas?",
      "Portuguese",
    ],
    ["Resume mis notas sobre Cartagena", "Spanish"],
    ["Summarise my notes on Cartagena", "English"],
  ];
  for (const [text, language] of cases) {
    assert.strictEqual(detectLanguage(text), language, text);
  }
});

test("nothing is named when the text does not say", () => {
  for (const text of [
    "ok",
    "Dune",
    "",
    "9780060883287",
    "https://es.wikipedia.org/wiki/Cartagena_de_Indias",
  ]) {
    assert.strictEqual(detectLanguage(text), null, text);
  }
});

test("titles, quotations and tables are not taken for the language of the prose", () => {
  // An English answer about a Spanish book, its table holding the Spanish title.
  const englishAnswer = [
    "Here is what I found about the novel *Cien años de soledad* by García Márquez.",
    "",
    "| Title | One Hundred Years of Solitude |",
    "| Original title | Cien años de soledad |",
    "",
    "It was first published in 1967 and the English translation is by Gregory Rabassa.",
  ].join("\n");
  assert.strictEqual(detectLanguage(englishAnswer), "English");
  assert.strictEqual(
    needsRewrite("What is One Hundred Years of Solitude about?", englishAnswer),
    null,
  );
  // Quoting a French title in a Spanish answer is still a Spanish answer.
  assert.strictEqual(
    detectLanguage(
      'Según el artículo "Le Petit Prince", la obra se publicó en 1943 y es muy conocida.',
    ),
    "Spanish",
  );
});

test("a rewrite is asked for only when question and answer clearly differ", () => {
  assert.strictEqual(needsRewrite(QUESTION, FRENCH_ANSWER), "Spanish");
  assert.strictEqual(needsRewrite(QUESTION, SPANISH_ANSWER), null);
  // Unclear on either side: no rewrite.
  assert.strictEqual(needsRewrite("ok", FRENCH_ANSWER), null);
  assert.strictEqual(needsRewrite(QUESTION, "18:59"), null);
});

test("the language goes on the last leading system message, nowhere later", () => {
  const messages = [
    { role: "system", content: "You are Dive." },
    { role: "system", content: "Tools policy." },
    { role: "user", content: QUESTION },
  ];
  const out = withReplyLanguage(messages, "Spanish");
  assert.strictEqual(out[0].content, "You are Dive.");
  assert.match(
    out[1].content,
    /^Tools policy\.\n\nReply in Spanish, the language of the user's message/,
  );
  assert.deepStrictEqual(out[2], messages[2]);
  // The caller's list is left alone.
  assert.strictEqual(messages[1].content, "Tools policy.");
  // No system message yet: one is added at the top.
  assert.strictEqual(
    withReplyLanguage([{ role: "user", content: "x" }], "French")[0].role,
    "system",
  );
  // No language, no change.
  assert.strictEqual(withReplyLanguage(messages, null), messages);
});

test("tool results end by naming the language", () => {
  assert.match(
    withLanguageReminder("## Larousse: Ernest Hemingway …", "Spanish"),
    /…\n\n\[Reply in Spanish, the language of the user's message, whatever the language of the tool results/,
  );
  assert.strictEqual(withLanguageReminder("result", null), "result");
});

test("a rewrite is kept only when it comes back in the right language", async () => {
  const fixed = await rewriteInLanguage(
    FRENCH_ANSWER,
    "Spanish",
    async (messages) => {
      assert.match(
        messages[0].content,
        /Rewrite the following text in Spanish/,
      );
      assert.strictEqual(messages[1].content, FRENCH_ANSWER);
      return SPANISH_ANSWER;
    },
  );
  assert.strictEqual(fixed, SPANISH_ANSWER);
  // Still French, empty or failing: the answer stays as it was.
  assert.strictEqual(
    await rewriteInLanguage(
      FRENCH_ANSWER,
      "Spanish",
      async () => FRENCH_ANSWER,
    ),
    FRENCH_ANSWER,
  );
  assert.strictEqual(
    await rewriteInLanguage(FRENCH_ANSWER, "Spanish", async () => ""),
    FRENCH_ANSWER,
  );
  assert.strictEqual(
    await rewriteInLanguage(FRENCH_ANSWER, "Spanish", async () => {
      throw new Error("model gone");
    }),
    FRENCH_ANSWER,
  );
});

test("accented words count, and tool names do not", () => {
  // JavaScript's \b knows no accented letters: "qué", "aquí" and "imágenes"
  // were never counted, and this question went unnamed.
  const question =
    "Usa download_images_with_gallery_dl con destinationPath /tmp/x para ver qué imágenes puedo descargar de aquí: https://wellcomecollection.org/search/images?query=casa";
  assert.strictEqual(detectLanguage(question), "Spanish");
  assert.strictEqual(
    needsRewrite(
      question,
      "Gallery preview displayed in the Dive interface: 35 candidate(s). Please select the images you wish to download from the preview panel.",
    ),
    "Spanish",
  );
  assert.strictEqual(
    detectLanguage("Où était-il né ? Il était très jeune, à Paris."),
    "French",
  );
});

test("short download requests name their language", () => {
  // "descarga esta imagen" was unnamed, and the reply came back in the
  // tool's English.
  for (const text of [
    "descarga esta imagen https://wellcomecollection.org/works/r95ccgus/images?id=uj5wxepv",
    "descarga esta imagenhttps://artvee.com/dl/struggle-for-the-guidon-2#00b",
    "descarga los episodios de Night Tracks https://www.bbc.co.uk/sounds/brand/m0008w2m",
    "bájame las fotos de https://example.org/gallery",
  ]) {
    assert.strictEqual(detectLanguage(text), "Spanish", text);
  }
  assert.strictEqual(
    detectLanguage("download this image https://artvee.com/dl/x"),
    "English",
  );
});
