const BOOK_SEARCH_FIELDS = {
  bookSearchGoogleKey: "googleApiKey",
  bookSearchHardcoverToken: "hardcoverToken",
  bookSearchLibrarythingToken: "librarythingToken",
  bookSearchCalibreUrl: "calibreServerUrl",
  bookSearchCalibreLibrary: "calibreLibraryId",
};

async function loadBookSearchConfigUi() {
  try {
    const res = await fetch(apiUrl("/api/book-search/config"));
    const payload = await readJsonResponse(res, "Book search config");
    const cfg = payload?.config || {};
    for (const [id, key] of Object.entries(BOOK_SEARCH_FIELDS)) {
      const el = document.getElementById(id);
      if (el) el.value = cfg[key] || "";
    }
  } catch (_e) {
    // Optional provider keys; the form stays blank if they cannot be read.
  }
}

async function saveBookSearchConfigUi() {
  const config = {};
  for (const [id, key] of Object.entries(BOOK_SEARCH_FIELDS)) {
    const el = document.getElementById(id);
    if (el && el.value.trim()) config[key] = el.value.trim();
  }
  try {
    const res = await fetch(apiUrl("/api/book-search/config"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config }),
    });
    await readJsonResponse(res, "Save book search config");
  } catch (e) {
    await appAlert(
      e.message || "Failed to save book search settings.",
      "Tools",
    );
  }
}

// ---- PI SESSION COMMANDS ----
// Pi's RPC protocol exposes the same session controls the terminal has
// (model switching, thinking level, compaction, stats, command list).
// These are surfaced as slash commands and via the top-bar model picker.
let piAvailableModels = [];
let piCurrentModelValue = "";

async function callPiCommand(command) {
  const res = await fetch(apiUrl("/api/pi/command"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      saveConv: currentConvId || "default",
      command,
    }),
  });
  return readJsonResponse(res, "Pi command");
}

function piModelValue(m) {
  if (!m) return "";
  return `${m.provider || "?"}/${m.id || m.modelId || "?"}`;
}

// Sync the side-panel thinking dropdown to Pi's actual resolved level.
// Pi always resolves a concrete level (e.g. "high"), so without this the
// static <select> would keep showing its first option ("Off") until a
// conversation exists and refreshPiStatus runs — which is exactly the
// "shows only Off by default" symptom.
function syncPiThinkingSelect(level) {
  if (!level) return;
  const sel = document.getElementById("sidePiThinkSelect");
  if (!sel || sel.value === level) return;
  if (![...sel.options].some((o) => o.value === level)) return;
  sel.value = level;
  if (typeof syncCustomSelect === "function") syncCustomSelect(sel);
}

async function loadPiTopbarModels() {
  try {
    const payload = await callPiCommand({ type: "get_available_models" });
    piAvailableModels = payload?.result?.data?.models || [];
    try {
      const st = await callPiCommand({ type: "get_state" });
      const m = st?.result?.data?.model;
      if (m) piCurrentModelValue = piModelValue(m);
      // Initialise the thinking dropdown from Pi's real state on entry,
      // before any conversation exists.
      syncPiThinkingSelect(st?.result?.data?.thinkingLevel);
    } catch (_e) {
      // Pi has no process yet; the dropdowns fill in on the first turn.
    }
    if (mode === "pi") populateTopbarModelSelect();
  } catch (_e) {
    // Entering Pi mode must never fail because its status could not be read.
  }
}

// Handle Dive-level Pi slash commands. Returns true when handled here;
// unknown /commands fall through and are sent to Pi as a prompt, so
// Pi's own extension commands (/subagents-fleet, skills, …) still work.
async function runPiLocalCommand(rawText) {
  const match = rawText.trim().match(/^\/([a-zA-Z][\w-]*)\s*([\s\S]*)$/);
  if (!match) return false;
  const name = match[1].toLowerCase();
  const arg = (match[2] || "").trim();
  const KNOWN = new Set([
    "models",
    "model",
    "think",
    "thinking",
    "compact",
    "stats",
    "help",
    "commands",
  ]);
  if (!KNOWN.has(name)) return false;
  if (!currentConvId) currentConvId = "conv_" + Date.now();
  const runSession = getActiveModeSession("pi");
  runSession.convId = currentConvId;
  const record = (answer) => {
    addMessage(rawText, "user");
    addMessage(answer, "assistant");
    runSession.history = [
      ...history,
      { role: "user", content: rawText },
      { role: "assistant", content: answer },
    ];
    history = [...runSession.history];
    persistConversationSnapshot(
      currentConvId,
      "pi",
      runSession.history,
      rawText.slice(0, 40),
    );
    scrollChatToBottom();
  };
  try {
    if (name === "models") {
      const payload = await callPiCommand({
        type: "get_available_models",
      });
      const models = payload?.result?.data?.models || [];
      piAvailableModels = models;
      if (mode === "pi") populateTopbarModelSelect();
      record(
        models.length
          ? "**Available models** (switch with `/model <name>` or the model dropdown):\n\n" +
              models.map((m) => `- \`${piModelValue(m)}\``).join("\n")
          : "No models reported by Pi.",
      );
      return true;
    }
    if (name === "model") {
      if (!arg) {
        const st = await callPiCommand({ type: "get_state" });
        const m = st?.result?.data?.model;
        record(
          m
            ? `Current model: \`${piModelValue(m)}\``
            : "Current model: unknown",
        );
        return true;
      }
      if (!piAvailableModels.length) {
        const payload = await callPiCommand({
          type: "get_available_models",
        });
        piAvailableModels = payload?.result?.data?.models || [];
      }
      const lower = arg.toLowerCase();
      const target =
        piAvailableModels.find(
          (m) => piModelValue(m).toLowerCase() === lower,
        ) ||
        piAvailableModels.find(
          (m) => String(m.id || "").toLowerCase() === lower,
        ) ||
        piAvailableModels.find((m) =>
          piModelValue(m).toLowerCase().includes(lower),
        );
      if (!target) {
        record(`No model matching \`${arg}\`. Use /models to list.`);
        return true;
      }
      const r = await callPiCommand({
        type: "set_model",
        provider: target.provider,
        modelId: target.id,
      });
      if (r?.result?.success === false) {
        record(`Failed to set model: ${r.result.error || "unknown error"}`);
      } else {
        piCurrentModelValue = piModelValue(target);
        if (mode === "pi") populateTopbarModelSelect();
        updateModeStatus();
        // A new model brings its own context window.
        refreshPiStatus().catch(uiRefreshFailed("Pi status"));
        record(`Model set to \`${piCurrentModelValue}\`.`);
      }
      return true;
    }
    if (name === "think" || name === "thinking") {
      if (!arg) {
        record("Usage: `/think off | minimal | low | medium | high`");
        return true;
      }
      const r = await callPiCommand({
        type: "set_thinking_level",
        level: arg,
      });
      record(
        r?.result?.success === false
          ? `Failed: ${r.result.error || "unknown error"}`
          : `Thinking level set to \`${arg}\`.`,
      );
      return true;
    }
    if (name === "compact") {
      const r = await callPiCommand({ type: "compact" });
      // Pi cannot measure the compacted context until the next reply; the
      // status says so, rather than leaving the pre-compaction figure up.
      refreshPiStatus().catch(uiRefreshFailed("Pi status"));
      const data = r?.result?.data || {};
      record(
        r?.result?.success === false
          ? `Compaction failed: ${r.result.error || "unknown error"}`
          : `Session compacted${
              data.tokensBefore
                ? ` (tokens before: ${data.tokensBefore}${
                    data.tokensAfter ? ", after: " + data.tokensAfter : ""
                  })`
                : ""
            }.`,
      );
      return true;
    }
    if (name === "stats") {
      const r = await callPiCommand({ type: "get_session_stats" });
      record(
        "**Session stats**\n\n```json\n" +
          JSON.stringify(r?.result?.data || {}, null, 2) +
          "\n```",
      );
      return true;
    }
    if (name === "help" || name === "commands") {
      record(
        "**Dive Pi commands**\n" +
          "- `/models` — list available models\n" +
          "- `/model <name>` — switch model\n" +
          "- `/think <level>` — set thinking level\n" +
          "- `/compact` — compact the session\n" +
          "- `/stats` — session statistics\n" +
          "- `/help` — this list",
      );
      return true;
    }
  } catch (e) {
    record("Command failed: " + (e.message || String(e)));
    return true;
  }
  return false;
}

// ---- PERSISTENT PI EVENT CHANNEL (SSE) ----
// The per-prompt stream only lives as long as one request. This channel
// is tied to the conversation instead, so events that arrive while no
// prompt is in flight (async subagent wakes, orphaned-session captures)
// render live as a continuation turn — no polling, no re-render races.
let piEventSource = null;
let piEventConvId = null;
let piChannelRun = null;

function piChannelResponseText(run, response = run.response || "") {
  const prior = String(run.baseMessage?.content || "").trim();
  const next = String(response || "").trim();
  if (!prior) return next;
  // A background wake is an internal continuation after the answer has
  // already been rendered. Keep its trace, steps, widgets, and sources,
  // but never append Pi's process-summary prose as a second answer.
  return prior;
}

function piChannelSources(run) {
  return normalizeLibrarySourceResults([
    ...getMessageLibrarySources(run.baseMessage),
    ...(Array.isArray(run.sources) ? run.sources : []),
  ]);
}

function renderPiChannelResponse(run) {
  const text = piChannelResponseText(run);
  const sources = piChannelSources(run);
  if (run.assistantDiv?.isConnected) {
    renderAssistantMessage(run.assistantDiv, text, sources);
  } else {
    setDraftAssistant("pi", text, sources);
  }
}

function finalizePiChannelRun(finalResponse, finishedPrefix) {
  const run = piChannelRun;
  piChannelRun = null;
  if (!run) return;
  const session = run.session || getActiveModeSession("pi");
  const baseHistory = Array.isArray(run.history) ? run.history : [];
  const activeSession = getActiveModeSession("pi");
  const canRender =
    mode === "pi" && currentConvId === run.convId && activeSession === session;
  const responseText =
    typeof finalResponse === "string" && finalResponse
      ? finalResponse
      : run.response || "";
  run.response = responseText;
  run.controller?.finalizeTimeline?.();
  run.controller?.markFinished?.(finishedPrefix);

  const nextHistory = [...baseHistory];
  const sources = piChannelSources(run);
  const mergedText = piChannelResponseText(run, responseText);
  const baseIndex = Number.isInteger(run.baseIndex) ? run.baseIndex : -1;
  if (baseIndex >= 0 && nextHistory[baseIndex]?.role === "assistant") {
    const previous = nextHistory[baseIndex];
    const previousMetadata = getAssistantMetadataFromMessage(previous);
    const wakeMetadata = run.controller?.getSnapshot?.() || {};
    const mergeMetadata = (key) => {
      const wakeValue = Array.isArray(wakeMetadata[key])
        ? wakeMetadata[key]
        : [];
      const previousValue = Array.isArray(previousMetadata[key])
        ? previousMetadata[key]
        : [];
      return run.reusedController
        ? wakeValue.length
          ? wakeValue
          : previousValue
        : [...previousValue, ...wakeValue];
    };
    const previousThinking = previousMetadata.thinking || "";
    const wakeThinking = wakeMetadata.thinking || "";
    const mergedThinking = run.reusedController
      ? wakeThinking || previousThinking
      : previousThinking && wakeThinking
        ? `${previousThinking}\n\n${wakeThinking}`
        : previousThinking || wakeThinking;
    const mergedMessage = buildAssistantHistoryMessage(mergedText, sources, {
      thinking: mergedThinking,
      traceLines: mergeMetadata("traceLines"),
      traceEvents: mergeMetadata("traceEvents"),
      passages: mergeMetadata("passages"),
      status: "done",
    });
    nextHistory[baseIndex] = { ...previous, ...mergedMessage };
  } else if (responseText.trim()) {
    const metadata = run.controller?.getSnapshot?.() || {};
    metadata.status = "done";
    nextHistory.push(
      buildAssistantHistoryMessage(responseText, sources, metadata),
    );
  }

  if (canRender) {
    session.history = nextHistory;
    history = [...nextHistory];
    session.draftAssistant = null;
    session.streamingAssistantDiv = null;
    // Keep the finished thinking controller attached. Finalizing a wake
    // must freeze its steps and trace, never remove or replace them.
    session.thinkingController = run.controller || null;
    if (baseIndex >= 0 && run.assistantDiv?.isConnected) {
      renderAssistantMessage(
        run.assistantDiv,
        nextHistory[baseIndex].content,
        sources,
      );
    } else if (baseIndex < 0 && responseText.trim()) {
      session.streamingAssistantDiv = addMessage(responseText, "assistant", {
        librarySources: sources,
      });
    }
  }
  // The continuation is merged into the original assistant bubble. Keep
  // every trace, step, widget, and status frame; if this wake had to
  // create a new controller, place it before the answer rather than
  // leaving a second block below it.
  if (
    !run.reusedController &&
    run.controller?.element?.parentElement &&
    run.assistantDiv?.closest(".msg-wrap")?.parentElement
  ) {
    const answerWrap = run.assistantDiv.closest(".msg-wrap");
    answerWrap.parentElement.insertBefore(run.controller.element, answerWrap);
  }
  if (run.controller?.isConnected) {
    session.lastThinkingController = run.controller;
  }
  // The server persists async wake turns authoritatively when it emits
  // the settled event. Do not write the same wake from the browser.
  refreshSidePanelRecent();
  if (typeof updateSendButtonState === "function") {
    updateSendButtonState();
  }
  if (typeof scheduleQueueDrain === "function") scheduleQueueDrain("pi");
}

function closePiEventChannel() {
  if (piChannelRun) finalizePiChannelRun();
  if (piEventSource) {
    try {
      piEventSource.close();
    } catch (_e) {
      // Already closed by the browser.
    }
  }
  piEventSource = null;
  piEventConvId = null;
}

function ensurePiEventChannel() {
  if (mode !== "pi" || !currentConvId) {
    closePiEventChannel();
    return;
  }
  if (piEventSource && piEventConvId === currentConvId) return;
  closePiEventChannel();
  piEventConvId = currentConvId;
  const channelSession = getActiveModeSession("pi");
  if (!channelSession.piEventSequences) channelSession.piEventSequences = {};
  const after = Number(channelSession.piEventSequences[currentConvId]) || 0;
  piEventSource = new EventSource(
    apiUrl(
      `/api/pi/events?conv=${encodeURIComponent(currentConvId)}&after=${after}`,
    ),
  );
  piEventSource.onmessage = (msg) => {
    let evt;
    try {
      evt = JSON.parse(msg.data);
    } catch (_e) {
      return;
    }
    handlePiChannelEvent(evt);
  };
  // EventSource reconnects automatically on error.
}

// Events that mean Pi is working: they open a background run, which keeps the
// composer busy until its done or error.
const PI_CHANNEL_SUBSTANTIVE = new Set([
  "delta",
  "thinking_start",
  "thinking_delta",
  "thinking_end",
  "tool_start",
  "tool_update",
  "tool_end",
  "tool_call_update",
  "web_sources",
  "pi_usage",
  "async_pending",
  "provider_retry",
  "provider_retry_end",
  "provider_error",
  "compaction_start",
  "compaction_end",
  "stderr",
  "trace",
]);
// Extension notices, status lines and widget frames. The server also sends
// these with no session at all, after the reply has settled, and no done ever
// follows them, so those must never open a background run: it would never
// end, and the composer would stay busy. With no run open, each one is shown
// and saved with the last answer at once (addPassivePiRecord). One that
// carries a session belongs to a turn still running, whose done will come.
const PI_CHANNEL_PASSIVE = new Set(["pi_widget", "pi_status", "pi_notice"]);

// The last answer in a history, and its bubble. A turn with neither text nor
// sources has none (the rule renderAssistantHistoryMessage applies).
function piLastAnswer(turns) {
  const index = turns.findLastIndex((message) => message?.role === "assistant");
  const answer = index >= 0 ? turns[index] : null;
  const hasBubble =
    !!answer &&
    assistantBubbleHasContent(answer.content, getMessageLibrarySources(answer));
  const bubbles = chat.querySelectorAll(".msg-wrap.assistant > .msg.assistant");
  return {
    index,
    bubble: hasBubble ? bubbles[bubbles.length - 1] || null : null,
  };
}

// Whether a trace block belongs to the given answer bubble: it sits directly
// above it or, for an answer with no bubble, at the end of the chat.
function piTraceBlockPrecedes(controller, bubble) {
  const block = controller?.isConnected ? controller.element : null;
  if (!block) return false;
  if (!bubble) return block === chat.lastElementChild;
  return block.nextElementSibling === bubble.closest(".msg-wrap");
}

// Whether a passive record is in a saved history: same channel epoch, type
// and sequence. A widget keeps only its latest frame, so a saved frame of that
// widget at or after this one covers it.
function piRecordInHistory(turns, evt) {
  if (!evt.epoch || !Number.isSafeInteger(evt.sequence)) return false;
  return turns.some((message) =>
    (Array.isArray(message?.traceEvents) ? message.traceEvents : []).some(
      (saved) =>
        saved?.epoch === evt.epoch &&
        saved.type === evt.type &&
        Number.isSafeInteger(saved.sequence) &&
        (evt.type === "pi_widget"
          ? saved.key === evt.key && saved.sequence >= evt.sequence
          : saved.sequence === evt.sequence),
    ),
  );
}

// An answer's saved trace events plus one passive record, by the rules its
// live trace block uses (addEvent in 05-history.js): only the latest frame
// of each widget, and no clear frames. The record goes in the order the
// channel sent it, so one put back after a reload still reads in order.
// Returns the events and the stored copy of the record (null if not stored).
function addPassivePiRecordToEvents(traceEvents, evt) {
  let events = traceEvents;
  if (evt.type === "pi_widget") {
    if (!Array.isArray(evt.lines) || !evt.lines.length) {
      return { events, record: null };
    }
    events = events.filter(
      (saved) => !(saved?.type === "pi_widget" && saved.key === evt.key),
    );
  }
  const record = { ...evt };
  delete record.thinking;
  delete record.response;
  delete record.sessionId;
  const later = events.findIndex(
    (saved) =>
      !!evt.epoch &&
      saved?.epoch === evt.epoch &&
      Number.isSafeInteger(saved.sequence) &&
      saved.sequence > evt.sequence,
  );
  return {
    events:
      later < 0
        ? [...events, record]
        : [...events.slice(0, later), record, ...events.slice(later)],
    record,
  };
}

// An answer with one passive record added to its saved trace: the record and
// the trace lines it showed. Nothing is written over. An answer with saved
// lines gets them after its own; one whose lines come from its events gets
// them at the record's place among those events.
function piAnswerWithRecord(answer, evt, lines) {
  const { events, record } = addPassivePiRecordToEvents(
    Array.isArray(answer.traceEvents) ? answer.traceEvents : [],
    evt,
  );
  const savedLines = Array.isArray(answer.traceLines) ? answer.traceLines : [];
  const traceLines = savedLines.length
    ? [...savedLines, ...lines]
    : dedupeStatusTraceLines(
        events.flatMap((saved) =>
          saved === record
            ? lines
            : [formatStreamEventTraceLine(saved)].filter(Boolean),
        ),
      );
  return { ...answer, traceLines, traceEvents: events };
}

// Passive records exist only in this page's history until the next message
// saves it. When the page loads the conversation from the server first (after
// a background turn is saved, a reconcile, or reopening the conversation),
// the server's copy lacks them. They are remembered here, with what
// identifies the answer they belong to, so they can be added back.
const PI_UNSAVED_RECORDS_MAX = 200;

// Where a remembered record's answer is in a loaded history: in the same
// place counted from the start, or from the end (the server drops the oldest
// messages past its limit), after the same question and with the same text.
// An answer with no text must still hold the step it held then.
function piRememberedAnswerIndex(turns, entry) {
  for (const index of [entry.index, turns.length - 1 - entry.fromEnd]) {
    const answer = turns[index];
    if (answer?.role !== "assistant") continue;
    if (turns[index - 1]?.content !== entry.question) continue;
    const same = entry.content
      ? answer.content === entry.content
      : !!entry.marker && piRecordInHistory([answer], entry.marker);
    if (same) return index;
  }
  return -1;
}

// A history loaded from the server, plus the passive records this page showed
// that it lacks. It only adds, and only onto the answer a record belongs to.
// A record found saved is forgotten; one whose answer cannot be found is not
// placed anywhere else.
function piWithUnsavedRecords(session, turns) {
  const remembered = Array.isArray(session.piUnsavedRecords)
    ? session.piUnsavedRecords
    : [];
  let next = turns;
  const kept = [];
  for (const entry of remembered) {
    if (entry.convId !== session.convId) {
      kept.push(entry);
      continue;
    }
    if (piRecordInHistory(next, entry.evt)) continue;
    kept.push(entry);
    const index = piRememberedAnswerIndex(next, entry);
    if (index < 0) continue;
    if (next === turns) next = [...turns];
    next[index] = piAnswerWithRecord(next[index], entry.evt, entry.lines);
  }
  session.piUnsavedRecords = kept;
  return next;
}

// Remember a passive record saved into the page's history at turns[index].
function rememberUnsavedPiRecord(session, entry) {
  if (!Array.isArray(session.piUnsavedRecords)) session.piUnsavedRecords = [];
  if (entry.evt.type === "pi_widget") {
    session.piUnsavedRecords = session.piUnsavedRecords.filter(
      (r) =>
        !(
          r.convId === entry.convId &&
          r.evt.type === "pi_widget" &&
          r.evt.key === entry.evt.key
        ),
    );
  }
  const records = session.piUnsavedRecords;
  records.push(entry);
  const ofThisConversation = records.filter((r) => r.convId === entry.convId);
  if (ofThisConversation.length > PI_UNSAVED_RECORDS_MAX) {
    records.splice(records.indexOf(ofThisConversation[0]), 1);
  }
}

// Show a passive record and save it with the last answer, at once. It is only
// ever added to that answer's saved trace, never written over it. It appears
// in the answer's own trace block, or, when that block is not on screen
// (after a slash command, a reload or a switch of conversation), in one block
// of its own above the answer.
function addPassivePiRecord(session, evt) {
  const turns = Array.isArray(session.history) ? session.history : [];
  // A page load replays every buffered record; the ones already saved are
  // not added again.
  if (evt.replay === true && piRecordInHistory(turns, evt)) return;
  const { index, bubble } = piLastAnswer(turns);
  let block = [session.lastThinkingController, session.piPassiveBlock].find(
    (candidate) => piTraceBlockPrecedes(candidate, bubble),
  );
  if (!block) {
    const showsNothing =
      evt.type === "pi_widget"
        ? !Array.isArray(evt.lines) || !evt.lines.length
        : evt.type === "pi_status" && !evt.text;
    if (showsNothing) return;
    block = addThinking({
      live: false,
      modeName: "pi",
      convId: session.convId || currentConvId,
    });
    const answerWrap = bubble?.closest(".msg-wrap");
    if (answerWrap?.parentElement && block.element) {
      answerWrap.parentElement.insertBefore(block.element, answerWrap);
    }
    // Kept apart from lastThinkingController: a background run reusing this
    // block would write its partial snapshot over the answer's saved trace.
    session.piPassiveBlock = block;
  }
  const linesBefore = block.getSnapshot().traceLines.length;
  handleStreamEventTrace(evt, block);
  if (index < 0) return;
  const lines = block.getSnapshot().traceLines.slice(linesBefore);
  const answer = turns[index];
  const next = [...turns];
  next[index] = piAnswerWithRecord(answer, evt, lines);
  session.history = next;
  if (mode === "pi" && currentConvId === session.convId) {
    history = [...next];
  }
  // Only a record that can be recognised once saved (epoch and sequence),
  // and that adds something (a clear frame does not), is remembered.
  const clearFrame =
    evt.type === "pi_widget" && !(Array.isArray(evt.lines) && evt.lines.length);
  if (clearFrame || !evt.epoch || !Number.isSafeInteger(evt.sequence)) return;
  const entry = {
    convId: session.convId,
    index,
    fromEnd: turns.length - 1 - index,
    question: turns[index - 1]?.content,
    content: answer.content,
    // A step the answer already held, to recognise one with no text.
    marker: (Array.isArray(answer.traceEvents) ? answer.traceEvents : []).find(
      (saved) =>
        saved?.epoch &&
        Number.isSafeInteger(saved.sequence) &&
        saved.type !== "pi_widget",
    ),
    evt,
    lines,
  };
  // A reconcile in flight is about to replace this history, perhaps with
  // newer answers; the record is run again against what it brings.
  if (session.piRecordsDuringReconcile) {
    session.piRecordsDuringReconcile.push(entry);
  } else {
    rememberUnsavedPiRecord(session, entry);
  }
}

function handlePiChannelEvent(evt) {
  if (!evt || typeof evt.type !== "string") return;
  const session = getActiveModeSession("pi");
  if (mode !== "pi" || session.convId !== currentConvId) return;
  if (evt.convId && evt.convId !== session.convId) return;
  if (Number.isSafeInteger(evt.sequence)) {
    if (!session.piEventSequences) session.piEventSequences = {};
    const lastSequence = Number(session.piEventSequences[session.convId]) || 0;
    if (evt.sequence <= lastSequence) return;
    session.piEventSequences[session.convId] = evt.sequence;
  }
  // A live prompt stream already renders everything it receives; the
  // channel only takes over when no run is attached. Sequence IDs are
  // still recorded above so reconnects do not replay its events.
  if (session.activeAbortController) return;
  // Completed runs are already represented in conversation history, or were
  // rendered by the stream that ran them. Their records, live or replayed,
  // never start a run.
  if (evt.completed === true && !piChannelRun) {
    return;
  }
  if (evt.type === "replay_gap") {
    if (!session.piReplayReconcile) {
      session.piReplayReconcile = true;
      session.piRecordsDuringReconcile = [];
      fetch(
        apiUrl("/api/conversations/id/" + encodeURIComponent(session.convId)),
      )
        .then((response) => readJsonResponse(response, "Reconcile Pi history"))
        .then((conversation) => {
          if (
            mode === "pi" &&
            currentConvId === session.convId &&
            !session.activeAbortController &&
            !piChannelRun &&
            Array.isArray(conversation?.history)
          ) {
            session.history = piWithUnsavedRecords(session, [
              ...conversation.history,
            ]);
            history = [...session.history];
            renderSessionTranscript(session);
            // Records shown while the fetch was out go to the last answer
            // of the history it brought.
            const during = session.piRecordsDuringReconcile || [];
            session.piRecordsDuringReconcile = null;
            during.forEach((entry) => addPassivePiRecord(session, entry.evt));
          }
        })
        .catch(uiRefreshFailed("Pi history reconcile"))
        .finally(() => {
          session.piReplayReconcile = false;
          // Not reconciled: their history was kept, so remember them as is.
          (session.piRecordsDuringReconcile || []).forEach((entry) =>
            rememberUnsavedPiRecord(session, entry),
          );
          session.piRecordsDuringReconcile = null;
        });
    }
    return;
  }
  if (!piChannelRun) {
    const uiRecord = PI_CHANNEL_PASSIVE.has(evt.type);
    if (!uiRecord && !PI_CHANNEL_SUBSTANTIVE.has(evt.type)) return;
    const passive = uiRecord && !evt.sessionId;
    // Straggler gate: the SSE socket can deliver a run's trailing
    // events moments after the prompt stream already finalized it —
    // don't resurrect that turn as a spurious continuation. A record
    // with no session never travelled on a prompt stream, so it is
    // never a straggler.
    if (!passive && Date.now() - (session.lastRunEndedAt || 0) < 1500) {
      return;
    }
    // A dangling draft from an earlier turn must be committed first,
    // or this continuation would stream into its bubble above the
    // current position.
    if (session.draftAssistant || session.streamingAssistantDiv) {
      const leftoverText = session.draftAssistant?.content || "";
      const leftover = finalizeDraftAssistant("pi", leftoverText, []);
      if (leftover.content && leftover.content.trim()) {
        session.history = [...session.history, leftover];
        if (mode === "pi" && currentConvId === session.convId) {
          history = [...session.history];
        }
      }
    }
    if (passive) {
      addPassivePiRecord(session, evt);
      return;
    }
    session.thinkingStartedAt = Date.now();
    // Reuse the last trace block only if it belongs to the last answer and
    // holds its whole trace: finalize writes a reused block's snapshot over
    // the answer's saved trace. After a Dive slash command the block belongs
    // to an earlier answer; a block an earlier background run had to create
    // holds only that run's part.
    const lastController = session.lastThinkingController;
    const priorController =
      !lastController?.piPartialTrace &&
      piTraceBlockPrecedes(
        lastController,
        piLastAnswer(Array.isArray(session.history) ? session.history : [])
          .bubble,
      )
        ? lastController
        : null;
    const controller =
      priorController ||
      addThinking({
        live: true,
        startedAt: session.thinkingStartedAt,
        modeName: "pi",
        convId: session.convId || currentConvId,
      });
    if (!priorController) controller.piPartialTrace = true;
    const reusedController = !!priorController;
    session.thinkingController = controller;
    controller.addTraceLine(
      "Pi woke in the background — streaming its continuation.",
    );
    const channelHistory = Array.isArray(session.history)
      ? [...session.history]
      : [];
    const baseIndex = channelHistory.findLastIndex(
      (message) => message?.role === "assistant",
    );
    const baseMessage = baseIndex >= 0 ? channelHistory[baseIndex] : null;
    const assistantBubbles = [
      ...chat.querySelectorAll(".msg-wrap.assistant > .msg.assistant"),
    ];
    const assistantDiv =
      baseIndex >= 0 ? assistantBubbles.at(-1) || null : null;
    piChannelRun = {
      controller,
      response: "",
      sources: [],
      session,
      convId: session.convId,
      history: channelHistory,
      baseIndex,
      baseMessage,
      assistantDiv,
      reusedController,
    };
    // A background continuation is now generating — surface Stop.
    if (typeof updateSendButtonState === "function") {
      updateSendButtonState();
    }
  }
  const run = piChannelRun;
  if (evt.type === "delta") {
    run.response =
      typeof evt.response === "string"
        ? evt.response
        : run.response + (evt.delta || "");
    renderPiChannelResponse(run);
    return;
  }
  if (evt.type === "web_sources") {
    run.sources = normalizeLibrarySourceResults([
      ...(Array.isArray(run.sources) ? run.sources : []),
      ...(Array.isArray(evt.sources) ? evt.sources : []),
    ]);
    renderPiChannelResponse(run);
    return;
  }
  if (evt.type === "done") {
    finalizePiChannelRun(typeof evt.response === "string" ? evt.response : "");
    return;
  }
  if (evt.type === "error") {
    run.controller?.markFailure?.(evt.error || "unknown");
    finalizePiChannelRun();
    return;
  }
  // Widget frames are stored by the run's controller (addEvent) and
  // committed with the wake turn in finalizePiChannelRun. They must
  // never be merged into the PREVIOUS assistant message: the subagent
  // fleet always repaints under the same widget key, so a cross-turn
  // merge deduped by key silently destroyed the prior turn's stored
  // widget in history (and duplicated the new one).
  handleStreamEventTrace(evt, run.controller);
  if (evt.type === "thinking_delta") return;
}

// CHAT SEND / LOGIC
