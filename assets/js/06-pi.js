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
  } catch (_e) {}
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
      "Skills",
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
    } catch (_e) {}
    if (mode === "pi") populateTopbarModelSelect();
  } catch (_e) {}
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

function finalizePiChannelRun(finalResponse) {
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
  run.controller?.stopTimer?.();

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
    } catch (_e) {}
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
  "pi_widget",
  "pi_status",
  "pi_notice",
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
  // Completed historical runs are already represented in conversation
  // history. Their replay records are for reconciliation only, never a
  // reason to create a duplicate background assistant bubble.
  if (evt.replay === true && evt.completed === true && !piChannelRun) {
    return;
  }
  if (evt.type === "replay_gap") {
    if (!session.piReplayReconcile) {
      session.piReplayReconcile = true;
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
            session.history = [...conversation.history];
            history = [...session.history];
            renderSessionTranscript(session);
          }
        })
        .catch(() => {})
        .finally(() => {
          session.piReplayReconcile = false;
        });
    }
    return;
  }
  if (!piChannelRun) {
    if (!PI_CHANNEL_SUBSTANTIVE.has(evt.type)) return;
    // Straggler gate: the SSE socket can deliver a run's trailing
    // events moments after the prompt stream already finalized it —
    // don't resurrect that turn as a spurious continuation.
    if (Date.now() - (session.lastRunEndedAt || 0) < 1500) return;
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
    session.thinkingStartedAt = Date.now();
    const priorController = session.lastThinkingController?.isConnected
      ? session.lastThinkingController
      : null;
    const controller =
      priorController ||
      addThinking({
        live: true,
        startedAt: session.thinkingStartedAt,
        modeName: "pi",
        convId: session.convId || currentConvId,
      });
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
    run.controller?.addTraceLine(`Error: ${evt.error || "unknown"}`, {
      failure: true,
    });
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
