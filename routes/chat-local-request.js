// Shaping a request to a local OpenAI-compatible server, and reading back the
// two refusals worth reacting to.
//
// Local servers are far less uniform than the cloud ones: llama.cpp applies the
// GGUF's own Jinja chat template, and some templates impose rules the OpenAI
// schema does not — most awkwardly that a system message may only appear first.
// Pure functions, kept out of the chat domain so they can be tested directly.
"use strict";

// Merge the leading run of system messages into one.
//
// Dive normally keeps them separate: the assistant policy, the database context
// and the skills policy are three messages, which small models follow more
// reliably than one merged wall of text. Some chat templates refuse that
// outright — they raise "System message must be at the beginning" for anything
// after the first — so for those models the blocks are joined instead, in the
// same order, preserving the content if not the structure.
//
// Only the LEADING run is touched, and a new array is returned: the caller's
// list accumulates tool results across rounds and must not be rewritten.
function collapseLeadingSystemMessages(list) {
  const messages = Array.isArray(list) ? list : [];
  let end = 0;
  while (
    end < messages.length &&
    messages[end]?.role === "system" &&
    typeof messages[end].content === "string"
  ) {
    end += 1;
  }
  // Nothing to merge: hand back the very same array, so the off path and the
  // ordinary single-system-message case are untouched.
  if (end < 2) return messages;
  const merged = {
    ...messages[0],
    content: messages
      .slice(0, end)
      .map((m) => m.content.trim())
      .filter(Boolean)
      .join("\n\n"),
  };
  return [merged, ...messages.slice(end)];
}

// Is this model one the user ticked as needing a single system message?
//
// The MODELS tab keys these by file name ("x.gguf") while a request names the
// model by its alias ("x"), so either spelling is accepted rather than forcing
// the two to agree.
function wantsSingleSystemMessage(conf, model) {
  const map = conf?.singleSystemMessage;
  if (!map || typeof map !== "object" || !model) return false;
  const name = String(model);
  const stem = name.replace(/\.gguf$/i, "");
  return (
    map[name] === true || map[stem] === true || map[`${stem}.gguf`] === true
  );
}

// Did the server refuse the request because of the native `tools` parameter?
//
// Any 400 counts, as it always has. A 500 counts only when the message names
// the cause: llama.cpp reports a missing --jinja flag that way ("tools param
// requires --jinja flag"), which used to fall straight through to the user,
// but retrying every 500 blindly would double genuine server faults.
function isNativeToolsRejection(error) {
  const status = error?.statusCode;
  if (status === 400) return true;
  if (status !== 500) return false;
  return /jinja|\btools?\b/i.test(String(error?.message || ""));
}

module.exports = {
  collapseLeadingSystemMessages,
  wantsSingleSystemMessage,
  isNativeToolsRejection,
};
