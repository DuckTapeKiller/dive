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
              record(
                `Failed to set model: ${r.result.error || "unknown error"}`,
              );
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
            let extra = "";
            try {
              const r = await callPiCommand({ type: "get_commands" });
              const cmds = r?.result?.data?.commands || [];
              if (cmds.length) {
                extra =
                  "\n\n**Pi commands** (sent to the agent as a message):\n" +
                  cmds
                    .map(
                      (c) =>
                        `- \`/${c.name}\`${
                          c.description ? " — " + c.description : ""
                        }`,
                    )
                    .join("\n");
              }
            } catch (_e) {}
            record(
              "**Dive Pi commands**\n" +
                "- `/models` — list available models\n" +
                "- `/model <name>` — switch model\n" +
                "- `/think <level>` — set thinking level\n" +
                "- `/compact` — compact the session\n" +
                "- `/stats` — session statistics\n" +
                "- `/help` — this list" +
                extra,
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

      function finalizePiChannelRun(finalResponse) {
        const session = getActiveModeSession("pi");
        const run = piChannelRun;
        piChannelRun = null;
        if (!run) return;
        // This finalizer is the only close path for channel (wake) turns:
        // freeze the bubble's timeline and elapsed clock, or a kept bubble
        // ticks forever after the retry/continuation finished.
        run.controller?.finalizeTimeline?.();
        run.controller?.stopTimer?.();
        const responseText =
          typeof finalResponse === "string" && finalResponse
            ? finalResponse
            : run.response || "";
        setDraftAssistant("pi", responseText, []);
        if (
          run.controller?.isConnected &&
          !run.controller.hadReasoning &&
          !run.controller.hadTrace &&
          !run.controller.hadPassages
        ) {
          run.controller.remove();
        }
        const assistantMessage = finalizeDraftAssistant("pi", responseText, []);
        // A wake turn has no user message of its own — append assistant-only.
        session.history = [...session.history, assistantMessage];
        if (mode === "pi" && currentConvId === session.convId) {
          history = [...session.history];
        }
        persistConversationSnapshot(session.convId, "pi", session.history, "");
        refreshSidePanelRecent();
        // Background continuation finished — return the button to Send.
        if (typeof updateSendButtonState === "function") {
          updateSendButtonState();
        }
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
        piEventSource = new EventSource(
          apiUrl(`/api/pi/events?conv=${encodeURIComponent(currentConvId)}`),
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
        // A live prompt stream already renders everything it receives; the
        // channel only takes over when no run is attached.
        if (session.activeAbortController) return;
        if (mode !== "pi" || session.convId !== currentConvId) return;
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
          const controller = addThinking({
            live: true,
            startedAt: session.thinkingStartedAt,
          });
          session.thinkingController = controller;
          controller.addTraceLine(
            "Pi woke in the background — streaming its continuation.",
          );
          piChannelRun = { controller, response: "" };
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
          setDraftAssistant("pi", run.response, []);
          return;
        }
        if (evt.type === "done") {
          finalizePiChannelRun(
            typeof evt.response === "string" ? evt.response : "",
          );
          return;
        }
        if (evt.type === "error") {
          run.controller?.addTraceLine(`Error: ${evt.error || "unknown"}`, {
            failure: true,
          });
          finalizePiChannelRun();
          return;
        }
        handleStreamEventTrace(evt, run.controller);
        if (evt.type === "thinking_delta") return;
      }

      // CHAT SEND / LOGIC
