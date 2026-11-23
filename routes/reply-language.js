"use strict";

// The answer is always in the language of the question.
//
// Saying so once at the top of the system prompt ("respond in the language the
// user speaks to you in") is not enough for a small model: by the time it
// answers, the context is full of tool results and passages in other languages,
// and it follows those instead. A Spanish question about Hemingway was answered
// in French because deep_research had filled the context with Larousse.
//
// So, as in Horme: the language is NAMED, not described; it is said again
// after every batch of tool results, the last thing before the answer; and an
// answer that still comes out in another language is rewritten.
//
// Detection is deliberately conservative: a language is named only when the
// text clearly is that language, and null (no instruction, no rewrite)
// otherwise. A wrong guess would do more harm than none.

// Words that mark one language and are rare in the others. Words several
// languages share ("de", "la", "en", "que", "a", "no") count for none.
const MARKERS = {
  English:
    /\b(the|and|what|how|which|who|whom|when|where|why|my|is|are|was|were|of|to|about|does|did|do|show|tell|write|find|search|this|that|there|many|from|in|on|an|it|for|with|please|explain|give|me|old|time|wrote|written|his|her|their|would|could|should|have|has|had|been|be|which|than|then|you|your|we|our|they|them|its|into|over|after|before|because|also|but|or|not|only|very|between|download|save|picture|pictures|episodes)\b/gi,
  Spanish:
    /[¿¡ñ]|\b(qué|cómo|cuál|cuáles|cuántos|cuántas|cuántos|cuándo|dónde|quién|quiénes|según|mis|sobre|el|los|las|del|es|son|para|con|una|por|está|están|estaba|hay|tengo|esta|este|estos|estas|y|años|año|tenía|tenia|cuando|escribió|escribio|hora|también|pero|muy|como|fue|era|ha|han|su|sus|al|lo|nos|les|le|ese|esa|eso|dame|busca|explica|resume|cuantos|cuanto|dime|puedo|puede|ver|aquí|aqui|imágenes|imagenes|descargar|usa|quiero|necesito|hazme|muéstrame|dónde|qué|cómo|descarga|descárgame|descargame|bájame|bajame|imagen|episodios|guárdame|guardame)\b/giu,
  French:
    /\b(le|les|des|du|une|est|sont|était|étaient|avait|avaient|il|elle|ils|elles|nous|vous|je|tu|pas|pour|avec|dans|sur|qui|lorsqu|lorsque|quand|ans|heure|cette|ces|aux|au|où|été|être|fait|très|mais|ou|aussi|leur|leurs|son|sa|ses|ce|ça|c'est|qu'il|n'est|actuelle|écrit|écrivit)\b/giu,
  Portuguese:
    /[ãõç]|\b(não|são|uma|umas|uns|com|para|pelo|pela|pelos|pelas|está|estão|foi|eram|tinha|anos|quando|onde|quem|também|mas|muito|você|vocês|ele|ela|eles|elas|seu|sua|seus|suas|isso|isto|esse|essa|na|no|nas|nos|do|da|dos|das|ao|aos|à|às|escreveu)\b/giu,
  Italian:
    /\b(il|gli|della|delle|dello|degli|nella|nelle|nello|negli|sono|era|erano|aveva|avevano|che|chi|quando|dove|perché|anche|ma|molto|questo|questa|questi|queste|non|una|uno|per|con|del|dei|nel|nei|sul|sulla|anni|ora|scrisse|scritto)\b/giu,
  German:
    /[äöüß]|\b(der|die|das|und|ist|sind|war|waren|hatte|hatten|ein|eine|einen|einem|einer|nicht|mit|für|auf|von|zu|zum|zur|wie|wann|wo|wer|was|warum|auch|aber|sehr|ich|du|er|sie|es|wir|ihr|jahre|jahr|alt|schrieb|geschrieben|uhr|wieviel)\b/giu,
};

// Accents that are a strong sign of one language and no other in this set.
const STRONG = {
  // ñ, ¿ and ¡ are Spanish alone; an acute á, í, ó or ú is Spanish or
  // Portuguese (French and Italian mark those vowels otherwise), and Portuguese
  // has its own ã, õ and ç below.
  Spanish: /[ñ¿¡]|[áíóú]/g,
  French: /[èêëîïôûùœ]|\b(l|d|qu|n|c|j|s)'(?=[a-zàâéèêëîïôûùœ])/giu,
  Portuguese: /[ãõ]/g,
  German: /[äöüß]/g,
};

// `\b` in a JavaScript regular expression only knows unaccented letters, so
// "qué", "aquí" or "été" never matched as words and a plainly Spanish question
// went unnamed. Word edges are taken from Unicode letters instead.
const UNICODE_MARKERS = Object.fromEntries(
  Object.entries(MARKERS).map(([language, re]) => [
    language,
    new RegExp(
      re.source
        .replace(/\\b\(/g, "(?<![\\p{L}\\p{N}_])(")
        .replace(/\)\\b/g, ")(?![\\p{L}\\p{N}_])"),
      "giu",
    ),
  ]),
);

function score(text, language) {
  const words = text.match(UNICODE_MARKERS[language]) ?? [];
  const strong = STRONG[language] ? (text.match(STRONG[language]) ?? []) : [];
  return words.length + strong.length * 2;
}

// The language a text is clearly written in, or null when it is short, mixed
// or none of these.
function detectLanguage(rawText) {
  const text = String(rawText || "")
    // Addresses, code and citations hold words of every language.
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/\[\d+\]/g, " ")
    // So do titles and quotations — *Cien años de soledad* in an English
    // answer is a name, not Spanish prose — and table rows, which are data.
    .replace(/^\s*\|.*$/gm, " ")
    .replace(/\*\*?[^*\n]+\*\*?|_[^_\n]+_/g, " ")
    .replace(/"[^"\n]*"|“[^”\n]*”|«[^»\n]*»|‘[^’\n]*’/g, " ");
  const scores = Object.keys(MARKERS)
    .map((language) => ({ language, score: score(text, language) }))
    .sort((a, b) => b.score - a.score);
  const [best, second] = scores;
  if (best.score >= 3 && best.score >= second.score * 2) return best.language;
  // A short question ("¿qué hora es?") still names its language plainly.
  if (best.score >= 2 && second.score === 0) return best.language;
  return null;
}

// The line that names it.
function replyLanguageLine(language) {
  return `Reply in ${language}, the language of the user's message, whatever the language of the tool results, passages or sources. Translate any facts you use from them into ${language}.`;
}

// The named language added to the system prompt. It goes on the last of the
// LEADING system messages, so it stays at the top for chat templates that
// refuse a system message anywhere else.
function withReplyLanguage(messages, language) {
  if (!language || !Array.isArray(messages)) return messages;
  const line = replyLanguageLine(language);
  let last = -1;
  for (
    let i = 0;
    i < messages.length && messages[i]?.role === "system";
    i += 1
  ) {
    last = i;
  }
  if (last === -1) return [{ role: "system", content: line }, ...messages];
  if (typeof messages[last].content !== "string") return messages;
  const copy = messages.slice();
  copy[last] = {
    ...messages[last],
    content: `${messages[last].content}\n\n${line}`,
  };
  return copy;
}

// The same, said again at the end of tool results: the last thing the model
// reads before it answers. Appended to the result itself (a tool message or
// the user message that carries it), never as a late system message.
function withLanguageReminder(content, language) {
  if (!language) return content;
  return `${String(content ?? "")}\n\n[${replyLanguageLine(language)}]`;
}

// Whether a finished answer is clearly in another language than the question.
function needsRewrite(question, answer) {
  const asked = detectLanguage(question);
  const written = detectLanguage(answer);
  return asked && written && asked !== written ? asked : null;
}

// The instruction for the rewrite: the prose translated, everything a reader
// follows or quotes kept exactly.
function rewriteInstruction(language) {
  return `Rewrite the following text in ${language}. Translate the prose only: keep the Markdown, every link, every [n] citation, names, numbers, titles and quotations from sources exactly as they are. Reply with the rewritten text and nothing else.`;
}

// Ask a model to rewrite an answer in the question's language. `complete`
// takes chat messages and resolves to the reply text. The rewrite is kept only
// when it really is in that language; otherwise the original stands.
async function rewriteInLanguage(answer, language, complete) {
  try {
    const out = String(
      (await complete([
        { role: "system", content: rewriteInstruction(language) },
        { role: "user", content: String(answer || "") },
      ])) || "",
    ).trim();
    return out && detectLanguage(out) === language ? out : answer;
  } catch {
    return answer;
  }
}

module.exports = {
  detectLanguage,
  replyLanguageLine,
  withReplyLanguage,
  withLanguageReminder,
  needsRewrite,
  rewriteInstruction,
  rewriteInLanguage,
};
