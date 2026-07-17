      // Live cross-client sync (issue 2.1): subscribe to the server's global
      // event channel. When ANY client (this app or a browser tab) saves a
      // conversation, refresh the history/side-panel here, and if that same
      // conversation is open in this client, re-pull and re-render it — unless
      // this client is mid-stream on that conversation, in which case the
      // local live render wins and we skip to avoid clobbering it.
      // Stable per-tab identity so this client can recognise (and ignore) the
      // broadcast echoes of its own saves.
      const APP_CLIENT_ID = `client_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

      let globalAppEventSource = null;
      function subscribeToGlobalAppEvents() {
        try {
          if (globalAppEventSource) globalAppEventSource.close();
          globalAppEventSource = new EventSource(apiUrl("/api/events/global"));
          globalAppEventSource.onmessage = (msg) => {
            let evt;
            try {
              evt = JSON.parse(msg.data);
            } catch (_e) {
              return;
            }
            if (
              evt.type === "conversation_saved" ||
              evt.type === "conversation_deleted"
            ) {
              handleRemoteConversationSaved(evt);
            }
          };
        } catch (_e) {
          /* EventSource unavailable — sync simply stays manual */
        }
      }

      function handleRemoteConversationSaved(evt) {
        // Ignore echoes of this client's own saves entirely.
        if (evt.clientId && evt.clientId === APP_CLIENT_ID) return;
        // Keep the recent list and open History panel current everywhere.
        if (typeof refreshSidePanelRecent === "function") {
          refreshSidePanelRecent();
        }
        if (historyOpen && typeof loadHistoryPanel === "function") {
          loadHistoryPanel();
        }
        if (evt.type === "conversation_deleted") return;
        // Re-render the open conversation only when it is the one that changed
        // and this client is not itself streaming it right now.
        if (!evt.id || evt.id !== currentConvId || evt.mode !== mode) return;
        const session = getActiveModeSession(mode);
        if (session.activeAbortController) return; // local run owns the view
        if (mode === "pi" && typeof piChannelRun !== "undefined" && piChannelRun)
          return;
        // Grace window: server-side saves of THIS client's just-finished or
        // just-aborted run (which carry no clientId) must not clobber the
        // locally rendered state — the local view is authoritative right
        // after its own run.
        if (Date.now() - (session.lastRunEndedAt || 0) < 3000) return;
        reloadOpenConversationFromServer(evt.id);
      }

      async function reloadOpenConversationFromServer(convId) {
        try {
          const res = await fetch(
            apiUrl(`/api/conversations/id/${encodeURIComponent(convId)}`),
          );
          if (!res.ok) return;
          const conv = await res.json();
          if (!conv || conv.id !== currentConvId) return;
          const session = getActiveModeSession(mode);
          if (session.activeAbortController) return;
          session.history = Array.isArray(conv.history) ? conv.history : [];
          history = [...session.history];
          renderSessionTranscript(session);
        } catch (_e) {
          /* transient fetch failure — next event will retry */
        }
      }

      async function sendMessage() {
        const runMode = mode;
        const allowThinkingRemoval = runMode !== "pi";
        const runSession = getActiveModeSession(runMode);
        if (runSession.activeAbortController) return;
        let text = input.value.trim();
        if (!text) return;
        if (runMode === "pi" && text.startsWith("/")) {
          input.value = "";
          resetInputSize();
          const handled = await runPiLocalCommand(text);
          if (handled) return;
          // Unknown command: restore nothing — it goes to Pi as a prompt.
          text = text.trim();
        }
        const messageSource = pendingFiles.length ? "uploaded_file" : "manual";
        logSecurityEvent("user_message_submitted", {
          mode: runMode,
          source: messageSource,
        });
        input.value = "";
        resetInputSize();
        lastUserMessage = text;
        if (!currentConvId) currentConvId = "conv_" + Date.now();
        runSession.convId = currentConvId;
        const runConvId = currentConvId;
        // Absolute turn isolation (issues 1.5 / 2.2): every new query starts
        // from a clean stream state. Commit or discard any lingering draft or
        // background Pi-channel continuation BEFORE this turn creates its own
        // bubble, so the incoming stream can never inherit a prior assistant
        // DOM node or leave the new user message orphaned.
        beginIsolatedTurn(runSession, runMode);
        if (runMode === "pi") ensurePiEventChannel();

        let displayText = text;
        let outgoingImages = null;
        if (pendingFiles.length) {
          const imageAtts = pendingFiles.filter((f) => f.kind === "image");
          const textAtts = pendingFiles.filter((f) => f.kind !== "image");
          // Text/PDF files are injected into the prompt (each labelled);
          // images are sent as data, not text.
          if (textAtts.length) {
            const fileBlocks = textAtts
              .map((f) => "[File: " + f.name + "]\n" + f.text)
              .join("\n\n");
            text = fileBlocks + "\n\n" + text;
          }
          if (imageAtts.length) {
            outgoingImages = imageAtts.map((f) => ({
              name: f.name,
              dataBase64: f.imageBase64,
              mimeType: f.mimeType,
            }));
          }
          const names = pendingFiles
            .map((f) => (f.kind === "image" ? "Image: " : "File: ") + f.name)
            .join(", ");
          displayText = "[" + names + "] " + lastUserMessage;
          clearPendingFiles();
        }

        // Prepare active system prompt context
        let requestHistory = [...history];
        let messageToSend = text;
        let persistToHistory = true;
        let hardModeOverride = null;
        if (runMode === "ollama") {
          const context = buildOllamaRequestContext(requestHistory, text);
          requestHistory = context.requestHistory;
          messageToSend = context.messageToSend;
          persistToHistory = context.persistToHistory !== false;
        } else if (runMode !== "pi") {
          const hm = checkHardModeTriggers(text);
          if (hm) {
            messageToSend = hm.messageToSend;
            persistToHistory = false;
            hardModeOverride = hm.systemPrompt;
            requestHistory = []; // context-blind: no conversation history
          }
        }
        // Hard-mode triggers (proofread/translate, incl. Firefox's context
        // menu): show the text actually being corrected, not the wrapper
        // template around it.
        if (!persistToHistory) {
          displayText = messageToSend;
        }
        // Hard-mode exchanges are one-shot: never let the server save them as
        // conversations either.
        const saveConvId = persistToHistory ? runConvId : null;

        addMessage(displayText, "user");
        // Real run start, kept on the session so the elapsed counter continues
        // from here across mode switches instead of restarting.
        runSession.thinkingStartedAt = Date.now();
        const thinking = addThinking({
          live: true,
          startedAt: runSession.thinkingStartedAt,
          modeName: runMode,
          convId: runConvId,
        });
        runSession.thinkingController = thinking;

        lastSentMessage = messageToSend;
        runSession.history = [...history];
        runSession.history.push({ role: "user", content: messageToSend });
        history = [...runSession.history];
        runSession.lastUserMessage = lastUserMessage;
        runSession.lastSentMessage = messageToSend;
        runSession.lastExchangePersisted = persistToHistory;
        // Register the conversation in History IMMEDIATELY. The server only
        // saves it when the stream finishes, so without this early snapshot
        // a brand-new conversation stays invisible in the History panel for
        // the whole run — and navigating to another conversation mid-reply
        // would leave no way back to it. The end-of-run save (server on
        // done, client on abort/error) later replaces this snapshot with
        // the full exchange.
        if (saveConvId) {
          persistConversationSnapshot(
            saveConvId,
            runMode,
            runSession.history,
            lastUserMessage.slice(0, 40),
          );
          setTimeout(() => {
            refreshSidePanelRecent();
            if (historyOpen && typeof loadHistoryPanel === "function") {
              loadHistoryPanel();
            }
          }, 400);
        }
        const runAbortController = new AbortController();
        runSession.activeAbortController = runAbortController;
        runSession.activeRunId = `${runMode}_${Date.now()}_${Math.random()}`;
        updateSendButtonState();
        const activeLibrarySources = { results: [] };
        const recordRunTrace = (evt) => {
          handleStreamEventTrace(
            evt,
            runSession.thinkingController || thinking,
          );
          const drumActive = mode === runMode && currentConvId === runConvId;
          if (evt.type === "tool_start") {
            setToolExecutingDrum(runSession, true, drumActive);
          } else if (evt.type === "tool_end" || evt.type === "done") {
            setToolExecutingDrum(runSession, false, drumActive);
          }
        };

        try {
          let response;
          if (runMode === "ollama") {
            response = await runOllamaStreamConversation(
              messageToSend,
              modelSelect.value,
              requestHistory,
              saveConvId,
              lastUserMessage.slice(0, 40),
              runAbortController.signal,
              (partialResponse) => {
                if (
                  thinking?.isConnected &&
                  !thinking.hadReasoning &&
                  !thinking.hadTrace &&
                  !thinking.hadPassages
                ) {
                  thinking.remove();
                  if (runSession.thinkingController === thinking) {
                    runSession.thinkingController = null;
                  }
                }
                setDraftAssistant(
                  runMode,
                  partialResponse || "",
                  activeLibrarySources.results,
                );
              },
              (evt) => {
                captureLibrarySources(
                  evt,
                  activeLibrarySources,
                  runSession.streamingAssistantDiv,
                );
                if (evt.type === "skill_links") {
                  if (
                    !runSession.streamingAssistantDiv &&
                    mode === runMode &&
                    currentConvId === runConvId
                  ) {
                    runSession.streamingAssistantDiv = addMessage(
                      "",
                      "assistant",
                    );
                  }
                  if (runSession.streamingAssistantDiv) {
                    const currentLinks = JSON.parse(
                      runSession.streamingAssistantDiv.dataset.skillLinks ||
                        "[]",
                    );
                    const merged = Array.from(
                      new Set([...currentLinks, ...evt.links]),
                    );
                    runSession.streamingAssistantDiv.dataset.skillLinks =
                      JSON.stringify(merged);
                    if (runSession.streamingAssistantDiv.dataset.rawText) {
                      renderAssistantMessage(
                        runSession.streamingAssistantDiv,
                        runSession.streamingAssistantDiv.dataset.rawText,
                        activeLibrarySources.results,
                      );
                    }
                  }
                }
                if (
                  evt.type === "done" &&
                  evt.promptTokens !== undefined &&
                  evt.evalTokens !== undefined
                ) {
                  const used = evt.promptTokens + evt.evalTokens;
                  // Total is exactly what we sent as num_ctx — the real active
                  // context window for this session, not Ollama's architectural max.
                  updateTokenCounter("ollama", used, ollamaOptions.numCtx);
                }
                recordRunTrace(evt);
              },
              outgoingImages,
            );
            setDraftAssistant(
              runMode,
              response || "",
              activeLibrarySources.results,
            );
            if (
              thinking?.isConnected &&
              !thinking.hadReasoning &&
              !thinking.hadTrace &&
              !thinking.hadPassages
            ) {
              thinking.remove();
            }
            if (persistToHistory) {
              const assistantMessage = finalizeDraftAssistant(
                runMode,
                response,
                activeLibrarySources.results,
              );
              runSession.history = [
                ...requestHistory.filter((msg) => msg.role !== "system"),
                { role: "user", content: messageToSend },
                assistantMessage,
              ];
              if (mode === runMode && currentConvId === runConvId) {
                history = [...runSession.history];
              }
            }
            runSession.lastExchangePersisted = persistToHistory;
            if (mode === runMode && currentConvId === runConvId) {
              lastExchangePersisted = persistToHistory;
            }
          } else if (runMode === "pi") {
            response = await runPiRpcConversation(
              messageToSend,
              runAbortController.signal,
              messageSource,
              requestHistory,
              runConvId,
              lastUserMessage.slice(0, 40),
              (partialResponse) => {
                if (
                  allowThinkingRemoval &&
                  thinking?.isConnected &&
                  !thinking.hadReasoning &&
                  !thinking.hadTrace &&
                  !thinking.hadPassages
                ) {
                  thinking.remove();
                  if (runSession.thinkingController === thinking) {
                    runSession.thinkingController = null;
                  }
                }
                const nextText = partialResponse || "";
                setDraftAssistant(
                  runMode,
                  nextText,
                  activeLibrarySources.results,
                );
              },
              (evt) => {
                captureLibrarySources(
                  evt,
                  activeLibrarySources,
                  runSession.streamingAssistantDiv,
                );
                if (evt.type === "session_start") {
                  piStatusInfo = {
                    ...(piStatusInfo || {}),
                    state: "STREAMING",
                  };
                  if (mode === runMode) updateModeStatus();
                }
                if (evt.type === "done") {
                  refreshPiStatus().catch(() => {});
                }
                recordRunTrace(evt);
              },
              outgoingImages,
            );
            setDraftAssistant(
              runMode,
              response || "",
              activeLibrarySources.results,
            );
            if (
              allowThinkingRemoval &&
              thinking?.isConnected &&
              !thinking.hadReasoning &&
              !thinking.hadTrace &&
              !thinking.hadPassages
            ) {
              thinking.remove();
            }
            const assistantMessage = finalizeDraftAssistant(
              runMode,
              response,
              activeLibrarySources.results,
            );
            runSession.history = [
              ...requestHistory,
              { role: "user", content: messageToSend },
              assistantMessage,
            ];
            if (mode === runMode && currentConvId === runConvId) {
              history = [...runSession.history];
            }
            runSession.lastExchangePersisted = true;
            if (mode === runMode && currentConvId === runConvId) {
              lastExchangePersisted = true;
            }
          } else if (runMode === "lmstudio" || runMode === "llamacpp") {
            response = await runLocalModeConversation(
              runMode,
              messageToSend,
              requestHistory,
              saveConvId,
              lastUserMessage.slice(0, 40),
              runAbortController.signal,
              (partialResponse) => {
                if (
                  thinking?.isConnected &&
                  !thinking.hadReasoning &&
                  !thinking.hadTrace &&
                  !thinking.hadPassages
                ) {
                  thinking.remove();
                  if (runSession.thinkingController === thinking) {
                    runSession.thinkingController = null;
                  }
                }
                setDraftAssistant(
                  runMode,
                  partialResponse || "",
                  activeLibrarySources.results,
                );
              },
              (evt) => {
                captureLibrarySources(
                  evt,
                  activeLibrarySources,
                  runSession.streamingAssistantDiv,
                );
                recordRunTrace(evt);
              },
              outgoingImages,
              hardModeOverride,
            );
            setDraftAssistant(
              runMode,
              response || "",
              activeLibrarySources.results,
            );
            if (
              thinking?.isConnected &&
              !thinking.hadReasoning &&
              !thinking.hadTrace &&
              !thinking.hadPassages
            ) {
              thinking.remove();
            }
            if (persistToHistory) {
              const assistantMessageLocal = finalizeDraftAssistant(
                runMode,
                response,
                activeLibrarySources.results,
              );
              runSession.history = [
                ...requestHistory,
                { role: "user", content: messageToSend },
                assistantMessageLocal,
              ];
              if (mode === runMode && currentConvId === runConvId) {
                history = [...runSession.history];
              }
            }
            runSession.lastExchangePersisted = persistToHistory;
            if (mode === runMode && currentConvId === runConvId) {
              lastExchangePersisted = persistToHistory;
            }
          } else {
            cloudStreamState = "STREAMING";
            if (mode === runMode) updateModeStatus();
            response = await runCloudStreamConversation(
              messageToSend,
              requestHistory,
              saveConvId,
              lastUserMessage.slice(0, 40),
              runAbortController.signal,
              (partialResponse) => {
                if (
                  thinking?.isConnected &&
                  !thinking.hadReasoning &&
                  !thinking.hadTrace &&
                  !thinking.hadPassages
                ) {
                  thinking.remove();
                  if (runSession.thinkingController === thinking) {
                    runSession.thinkingController = null;
                  }
                }
                const nextText = partialResponse || "";
                setDraftAssistant(
                  runMode,
                  nextText,
                  activeLibrarySources.results,
                );
              },
              (evt) => {
                captureLibrarySources(
                  evt,
                  activeLibrarySources,
                  runSession.streamingAssistantDiv,
                );
                if (evt.type === "done") {
                  cloudStreamState = "IDLE";
                  if (mode === runMode) updateModeStatus();
                }
                recordRunTrace(evt);
              },
              outgoingImages,
              hardModeOverride,
            );
            setDraftAssistant(
              runMode,
              response || "",
              activeLibrarySources.results,
            );
            if (
              thinking?.isConnected &&
              !thinking.hadReasoning &&
              !thinking.hadTrace &&
              !thinking.hadPassages
            ) {
              thinking.remove();
            }
            if (persistToHistory) {
              const assistantMessage = finalizeDraftAssistant(
                runMode,
                response,
                activeLibrarySources.results,
              );
              runSession.history = [
                ...requestHistory,
                { role: "user", content: messageToSend },
                assistantMessage,
              ];
              if (mode === runMode && currentConvId === runConvId) {
                history = [...runSession.history];
              }
            }
            runSession.lastExchangePersisted = persistToHistory;
            if (mode === runMode && currentConvId === runConvId) {
              lastExchangePersisted = persistToHistory;
            }
          }
        } catch (e) {
          clearPiPermissionState();
          if (runMode === "cloud") {
            cloudStreamState = "IDLE";
            if (mode === runMode) updateModeStatus();
          }
          if (e.name === "AbortError" || runAbortController.signal.aborted) {
            // Keep the thinking / steps / trace box visible on interrupt —
            // only drop it when it is empty, matching the success path. Freeze
            // its timer and mark any in-progress tool steps as stopped instead
            // of removing the whole box (it also lives in the saved history).
            if (thinking) {
              if (typeof thinking.finalizeTimeline === "function") {
                thinking.finalizeTimeline();
              }
              if (typeof thinking.stopTimer === "function") {
                thinking.stopTimer();
              }
              if (
                thinking.isConnected &&
                !thinking.hadReasoning &&
                !thinking.hadTrace &&
                !thinking.hadPassages
              ) {
                thinking.remove();
              }
            }
            const prior = runSession.draftAssistant?.content || "";
            const cancelled =
              prior && prior.trim()
                ? `${prior}\n\n*Request cancelled by user.*`
                : "*Request cancelled by user.*";
            setDraftAssistant(
              runMode,
              cancelled,
              activeLibrarySources.results,
              {
                ...(runSession.thinkingController?.getSnapshot?.() || {}),
                status: "aborted",
              },
            );
            // Preserve the interrupted turn: commit the partial (plus the
            // cancellation note) to history and clear the streaming refs, so it
            // survives re-render and the next response is appended below it
            // instead of overwriting this bubble.
            const abortedAssistant = finalizeDraftAssistant(
              runMode,
              cancelled,
              activeLibrarySources.results,
            );
            if (persistToHistory) {
              runSession.history = [
                ...requestHistory,
                { role: "user", content: messageToSend },
                abortedAssistant,
              ];
              if (mode === runMode && currentConvId === runConvId) {
                history = [...runSession.history];
              }
              // Save the interrupted conversation to disk so it appears in the
              // History panel and survives a reload (the stream "done" save
              // never runs on abort).
              persistConversationSnapshot(
                runConvId,
                runMode,
                runSession.history,
                lastUserMessage.slice(0, 40),
              );
            }
          } else {
            if (thinking && thinking.isConnected) {
              thinking.markFailure(e.message || String(e));
            }
            setDraftAssistant(
              runMode,
              "Error: " + e.message,
              activeLibrarySources.results,
              {
                ...(runSession.thinkingController?.getSnapshot?.() || {}),
                status: "error",
              },
            );
            // Commit the failed turn and clear the streaming refs, exactly
            // like the abort path. A dangling draft bubble would otherwise
            // capture the NEXT turn's reply, which then renders above its
            // own thinking/steps — broken chronology.
            const failedAssistant = finalizeDraftAssistant(
              runMode,
              "Error: " + e.message,
              activeLibrarySources.results,
            );
            if (persistToHistory) {
              runSession.history = [
                ...requestHistory,
                { role: "user", content: messageToSend },
                failedAssistant,
              ];
              if (mode === runMode && currentConvId === runConvId) {
                history = [...runSession.history];
              }
              persistConversationSnapshot(
                runConvId,
                runMode,
                runSession.history,
                lastUserMessage.slice(0, 40),
              );
            }
          }
        } finally {
          runSession.activeAbortController = null;
          runSession.activeRunId = null;
          runSession.lastRunEndedAt = Date.now();
          resetInputSize();
          updateSendButtonState();
          if (typeof updateTokenCounter === "function") updateTokenCounter();
          // The server saves the conversation as the stream finishes; give it
          // a moment, then refresh the side panel's recent list.
          setTimeout(() => refreshSidePanelRecent(), 500);
        }
      }

      async function regenerate(wrapEl) {
        if (!lastUserMessage || !lastSentMessage) return;
        const runMode = mode;
        const allowThinkingRemoval = runMode !== "pi";
        const runSession = getActiveModeSession(runMode);
        if (runSession.activeAbortController) return;
        const runConvId = currentConvId || "conv_" + Date.now();
        currentConvId = runConvId;
        runSession.convId = runConvId;
        if (wrapEl) wrapEl.remove();
        // Only remove the last user+assistant pair if it was persisted to history
        // and there are enough entries to remove. When lastExchangePersisted is
        // false (e.g. Ollama triggered mode like proofreading), the exchange
        // was never added to history, so we skip the slice.
        if (lastExchangePersisted && history.length >= 2) {
          history = history.slice(0, -2);
        }
        runSession.history = [...history];
        runSession.draftAssistant = null;
        runSession.thinkingStartedAt = Date.now();
        const thinking = addThinking({
          live: true,
          startedAt: runSession.thinkingStartedAt,
          modeName: runMode,
          convId: runConvId,
        });
        runSession.thinkingController = thinking;

        let requestHistory = [...history];
        let messageToSend = lastSentMessage;
        let persistToHistory = true;
        let hardModeOverride = null;
        if (runMode === "ollama") {
          const context = buildOllamaRequestContext(
            requestHistory,
            lastUserMessage,
          );
          requestHistory = context.requestHistory;
          messageToSend = context.messageToSend || messageToSend;
          persistToHistory = context.persistToHistory !== false;
        } else if (runMode !== "pi") {
          const hm = checkHardModeTriggers(lastUserMessage);
          if (hm) {
            messageToSend = hm.messageToSend;
            persistToHistory = false;
            hardModeOverride = hm.systemPrompt;
            requestHistory = [];
          }
        }
        // Hard-mode exchanges are one-shot: never let the server save them as
        // conversations either.
        const saveConvId = persistToHistory ? runConvId : null;

        const runAbortController = new AbortController();
        runSession.activeAbortController = runAbortController;
        runSession.activeRunId = `${runMode}_${Date.now()}_${Math.random()}`;
        updateSendButtonState();
        const activeLibrarySources = { results: [] };
        const recordRunTrace = (evt) => {
          handleStreamEventTrace(
            evt,
            runSession.thinkingController || thinking,
          );
          const drumActive = mode === runMode && currentConvId === runConvId;
          if (evt.type === "tool_start") {
            setToolExecutingDrum(runSession, true, drumActive);
          } else if (evt.type === "tool_end" || evt.type === "done") {
            setToolExecutingDrum(runSession, false, drumActive);
          }
        };
        const handlePartial = (partialResponse) => {
          if (
            runMode !== "pi" &&
            thinking?.isConnected &&
            !thinking.hadReasoning &&
            !thinking.hadTrace &&
            !thinking.hadPassages
          ) {
            thinking.remove();
            if (runSession.thinkingController === thinking) {
              runSession.thinkingController = null;
            }
          }
          setDraftAssistant(
            runMode,
            partialResponse || "",
            activeLibrarySources.results,
          );
        };
        const handleEvent = (evt) => {
          captureLibrarySources(
            evt,
            activeLibrarySources,
            runSession.streamingAssistantDiv,
          );
          if (
            evt.type === "done" &&
            evt.promptTokens !== undefined &&
            evt.evalTokens !== undefined
          ) {
            const used = evt.promptTokens + evt.evalTokens;
            updateTokenCounter("ollama", used, ollamaOptions.numCtx);
          }
          if (evt.type === "session_start") {
            piStatusInfo = {
              ...(piStatusInfo || {}),
              state: "STREAMING",
            };
            if (mode === runMode) updateModeStatus();
          }
          if (evt.type === "done" && runMode === "pi") {
            refreshPiStatus().catch(() => {});
          }
          if (evt.type === "done" && runMode === "cloud") {
            cloudStreamState = "IDLE";
            if (mode === runMode) updateModeStatus();
          }
          recordRunTrace(evt);
        };

        try {
          let response;
          if (runMode === "ollama") {
            response = await runOllamaStreamConversation(
              messageToSend,
              modelSelect.value,
              requestHistory,
              saveConvId,
              lastUserMessage.slice(0, 40),
              runAbortController.signal,
              handlePartial,
              handleEvent,
            );
            setDraftAssistant(
              runMode,
              response || "",
              activeLibrarySources.results,
            );
            if (
              thinking?.isConnected &&
              !thinking.hadReasoning &&
              !thinking.hadTrace &&
              !thinking.hadPassages
            ) {
              thinking.remove();
            }
            if (persistToHistory) {
              const assistantMessage = finalizeDraftAssistant(
                runMode,
                response,
                activeLibrarySources.results,
              );
              runSession.history = [
                ...requestHistory.filter((msg) => msg.role !== "system"),
                { role: "user", content: messageToSend },
                assistantMessage,
              ];
              if (mode === runMode && currentConvId === runConvId) {
                history = [...runSession.history];
              }
            }
            runSession.lastExchangePersisted = persistToHistory;
            if (mode === runMode && currentConvId === runConvId) {
              lastExchangePersisted = persistToHistory;
            }
          } else if (runMode === "pi") {
            response = await runPiRpcConversation(
              messageToSend,
              runAbortController.signal,
              "manual",
              requestHistory,
              runConvId,
              lastUserMessage.slice(0, 40),
              handlePartial,
              handleEvent,
            );
            setDraftAssistant(
              runMode,
              response || "",
              activeLibrarySources.results,
            );
            if (
              allowThinkingRemoval &&
              thinking?.isConnected &&
              !thinking.hadReasoning &&
              !thinking.hadTrace &&
              !thinking.hadPassages
            ) {
              thinking.remove();
            }
            const assistantMessage = finalizeDraftAssistant(
              runMode,
              response,
              activeLibrarySources.results,
            );
            runSession.history = [
              ...requestHistory,
              { role: "user", content: messageToSend },
              assistantMessage,
            ];
            if (mode === runMode && currentConvId === runConvId) {
              history = [...runSession.history];
            }
            runSession.lastExchangePersisted = true;
            if (mode === runMode && currentConvId === runConvId) {
              lastExchangePersisted = true;
            }
          } else if (runMode === "lmstudio" || runMode === "llamacpp") {
            response = await runLocalModeConversation(
              runMode,
              messageToSend,
              requestHistory,
              saveConvId,
              lastUserMessage.slice(0, 40),
              runAbortController.signal,
              handlePartial,
              handleEvent,
              undefined,
              hardModeOverride,
            );
            setDraftAssistant(
              runMode,
              response || "",
              activeLibrarySources.results,
            );
            if (
              thinking?.isConnected &&
              !thinking.hadReasoning &&
              !thinking.hadTrace &&
              !thinking.hadPassages
            ) {
              thinking.remove();
            }
            if (persistToHistory) {
              const assistantMessageLocal = finalizeDraftAssistant(
                runMode,
                response,
                activeLibrarySources.results,
              );
              runSession.history = [
                ...requestHistory,
                { role: "user", content: messageToSend },
                assistantMessageLocal,
              ];
              if (mode === runMode && currentConvId === runConvId) {
                history = [...runSession.history];
              }
            }
            runSession.lastExchangePersisted = persistToHistory;
            if (mode === runMode && currentConvId === runConvId) {
              lastExchangePersisted = persistToHistory;
            }
          } else {
            cloudStreamState = "STREAMING";
            if (mode === runMode) updateModeStatus();
            response = await runCloudStreamConversation(
              messageToSend,
              requestHistory,
              saveConvId,
              lastUserMessage.slice(0, 40),
              runAbortController.signal,
              handlePartial,
              handleEvent,
              undefined,
              hardModeOverride,
            );
            setDraftAssistant(
              runMode,
              response || "",
              activeLibrarySources.results,
            );
            if (
              thinking?.isConnected &&
              !thinking.hadReasoning &&
              !thinking.hadTrace &&
              !thinking.hadPassages
            ) {
              thinking.remove();
            }
            if (persistToHistory) {
              const assistantMessage = finalizeDraftAssistant(
                runMode,
                response,
                activeLibrarySources.results,
              );
              runSession.history = [
                ...requestHistory,
                { role: "user", content: messageToSend },
                assistantMessage,
              ];
              if (mode === runMode && currentConvId === runConvId) {
                history = [...runSession.history];
              }
            }
            runSession.lastExchangePersisted = persistToHistory;
            if (mode === runMode && currentConvId === runConvId) {
              lastExchangePersisted = persistToHistory;
            }
          }
        } catch (e) {
          clearPiPermissionState();
          if (runMode === "cloud") {
            cloudStreamState = "IDLE";
            if (mode === runMode) updateModeStatus();
          }
          if (e.name === "AbortError" || runAbortController.signal.aborted) {
            // Keep the thinking / steps / trace box visible on interrupt —
            // only drop it when it is empty, matching the success path. Freeze
            // its timer and mark any in-progress tool steps as stopped instead
            // of removing the whole box (it also lives in the saved history).
            if (thinking) {
              if (typeof thinking.finalizeTimeline === "function") {
                thinking.finalizeTimeline();
              }
              if (typeof thinking.stopTimer === "function") {
                thinking.stopTimer();
              }
              if (
                thinking.isConnected &&
                !thinking.hadReasoning &&
                !thinking.hadTrace &&
                !thinking.hadPassages
              ) {
                thinking.remove();
              }
            }
            const prior = runSession.draftAssistant?.content || "";
            const cancelled =
              prior && prior.trim()
                ? `${prior}\n\n*Request cancelled by user.*`
                : "*Request cancelled by user.*";
            setDraftAssistant(
              runMode,
              cancelled,
              activeLibrarySources.results,
              {
                ...(runSession.thinkingController?.getSnapshot?.() || {}),
                status: "aborted",
              },
            );
            // Preserve the interrupted turn: commit the partial (plus the
            // cancellation note) to history and clear the streaming refs, so it
            // survives re-render and the next response is appended below it
            // instead of overwriting this bubble.
            const abortedAssistant = finalizeDraftAssistant(
              runMode,
              cancelled,
              activeLibrarySources.results,
            );
            if (persistToHistory) {
              runSession.history = [
                ...requestHistory,
                { role: "user", content: messageToSend },
                abortedAssistant,
              ];
              if (mode === runMode && currentConvId === runConvId) {
                history = [...runSession.history];
              }
              // Save the interrupted conversation to disk so it appears in the
              // History panel and survives a reload (the stream "done" save
              // never runs on abort).
              persistConversationSnapshot(
                runConvId,
                runMode,
                runSession.history,
                lastUserMessage.slice(0, 40),
              );
            }
          } else {
            if (thinking && thinking.isConnected) {
              thinking.markFailure(e.message || String(e));
            }
            setDraftAssistant(
              runMode,
              "Error: " + e.message,
              activeLibrarySources.results,
              {
                ...(runSession.thinkingController?.getSnapshot?.() || {}),
                status: "error",
              },
            );
            // Commit the failed turn and clear the streaming refs, exactly
            // like the abort path. A dangling draft bubble would otherwise
            // capture the NEXT turn's reply, which then renders above its
            // own thinking/steps — broken chronology.
            const failedAssistant = finalizeDraftAssistant(
              runMode,
              "Error: " + e.message,
              activeLibrarySources.results,
            );
            if (persistToHistory) {
              runSession.history = [
                ...requestHistory,
                { role: "user", content: messageToSend },
                failedAssistant,
              ];
              if (mode === runMode && currentConvId === runConvId) {
                history = [...runSession.history];
              }
              persistConversationSnapshot(
                runConvId,
                runMode,
                runSession.history,
                lastUserMessage.slice(0, 40),
              );
            }
          }
        } finally {
          runSession.activeAbortController = null;
          runSession.activeRunId = null;
          runSession.lastRunEndedAt = Date.now();
          resetInputSize();
          updateSendButtonState();
          if (typeof updateTokenCounter === "function") updateTokenCounter();
          // The server saves the conversation as the stream finishes; give it
          // a moment, then refresh the side panel's recent list.
          setTimeout(() => refreshSidePanelRecent(), 500);
        }
      }

      async function updateTokenCounter(
        modeOverride = null,
        used = null,
        total = null,
      ) {
        const counterEl = document.getElementById("tokenCounter");
        if (!counterEl) return;

        const m = modeOverride || mode;

        // If called with explicit data, save it to the right mode's state
        if (typeof used === "number") {
          if (m === "ollama") {
            ollamaTokenState = {
              used,
              total: typeof total === "number" ? total : null,
            };
          } else if (m === "pi") {
            piTokenState = {
              used,
              total: typeof total === "number" ? total : null,
            };
          } else if (m === "cloud") {
            cloudTokenState = {
              used,
              total: typeof total === "number" ? total : null,
            };
          } else if (m === "lmstudio") {
            lmstudioTokenState = {
              used,
              total: typeof total === "number" ? total : null,
            };
          } else if (m === "llamacpp") {
            llamacppTokenState = {
              used,
              total: typeof total === "number" ? total : null,
            };
          }
        }

        // Display only the current mode's state
        const state =
          mode === "ollama"
            ? ollamaTokenState
            : mode === "pi"
              ? piTokenState
              : mode === "lmstudio"
                ? lmstudioTokenState
                : mode === "llamacpp"
                  ? llamacppTokenState
                  : cloudTokenState;

        // Pi with no data yet: try fetching live from the process
        if (mode === "pi" && state.used == null && currentConvId) {
          try {
            const res = await fetch(apiUrl("/api/pi/status"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ saveConv: currentConvId }),
            });
            const data = await res.json();
            piStatusInfo = data?.status || piStatusInfo;
            updateModeStatus();
            if (data.status?.contextUsage) {
              piTokenState = {
                used: data.status.contextUsage.used || 0,
                total: data.status.contextUsage.total || null,
              };
              const t = piTokenState.total != null ? piTokenState.total : "?";
              counterEl.textContent = `Tokens: ${piTokenState.used} / ${t}`;
              return;
            }
          } catch (e) {}
        }

        if (state.used == null) {
          const totalStr = state.total != null ? state.total : "?";
          counterEl.textContent = `Tokens: 0 / ${totalStr}`;
          return;
        }
        const totalStr = state.total != null ? state.total : "?";
        counterEl.textContent = `Tokens: ${state.used} / ${totalStr}`;
      }

      // Generation is "active" while a foreground stream is attached OR a Pi
      // background continuation (async subagent wake / retry) is still running
      // on the channel. The Stop button must stay visible for both, or the
      // user sees Send while Pi is still working (issue 1.3).
      function isGenerationActive() {
        if (getActiveAbortController()) return true;
        if (
          mode === "pi" &&
          typeof piChannelRun !== "undefined" &&
          piChannelRun
        ) {
          return true;
        }
        return false;
      }

      function updateSendButtonState() {
        const sendBtn = document.getElementById("send");
        if (isGenerationActive()) {
          sendBtn.innerHTML = STOP_ICON;
          sendBtn.setAttribute("aria-label", "Stop response");
          sendBtn.setAttribute("title", "Stop response");
          sendBtn.classList.add("stopping");
        } else {
          sendBtn.innerHTML = SEND_ICON;
          sendBtn.setAttribute("aria-label", "Send message");
          sendBtn.setAttribute("title", "Send message");
          sendBtn.classList.remove("stopping");
        }
      }

      // Stop whatever is generating: a live stream (abort its controller) or a
      // Pi background continuation (send a real abort RPC + close the channel
      // run). Returns true if it stopped something.
      function stopActiveGeneration() {
        const controller = getActiveAbortController();
        if (controller) {
          if (activePiPermissionRequest) {
            resolvePiPermission({ cancelled: true });
          }
          controller.abort();
          return true;
        }
        if (
          mode === "pi" &&
          typeof piChannelRun !== "undefined" &&
          piChannelRun
        ) {
          fetch(apiUrl("/api/pi/command"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              saveConv: currentConvId,
              command: { type: "abort" },
            }),
          }).catch(() => {});
          if (typeof finalizePiChannelRun === "function") {
            try {
              finalizePiChannelRun();
            } catch (_e) {}
          }
          updateSendButtonState();
          return true;
        }
        return false;
      }

      document.getElementById("send").addEventListener("click", () => {
        if (!stopActiveGeneration()) {
          sendMessage();
        }
      });
      piPermissionBtn.addEventListener("click", () => {
        if (!activePiPermissionRequest) return;
        renderAndOpenPiPermissionModal(activePiPermissionRequest);
      });
      document.addEventListener("click", (event) => {
        const button = event.target.closest(".setting-number-btn");
        if (!button) return;
        const targetId = button.getAttribute("data-target");
        const direction = button.getAttribute("data-dir") || "up";
        const inputEl = targetId ? document.getElementById(targetId) : null;
        if (!inputEl) return;
        stepNumberInput(inputEl, direction);
      });
      document.addEventListener("click", (event) => {
        const button = event.target.closest(".font-scale-btn");
        if (!button) return;
        nudgeFontScale(
          button.getAttribute("data-font-scale-mode"),
          button.getAttribute("data-dir") === "down" ? -1 : 1,
        );
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          if (!stopActiveGeneration()) {
            sendMessage();
          }
        }
      });
      function autoResizeInput() {
        const INPUT_MIN_HEIGHT = 42;
        if (!input.value || input.value.length === 0) {
          resetInputSize();
          return;
        }
        input.style.height = "auto";
        let newHeight = input.scrollHeight;

        if (newHeight <= INPUT_MIN_HEIGHT + 2) {
          input.style.height = `${INPUT_MIN_HEIGHT}px`;
          input.style.overflowY = "hidden";
          return;
        }
        if (newHeight < INPUT_MIN_HEIGHT) newHeight = INPUT_MIN_HEIGHT;

        if (newHeight > 160) {
          newHeight = 160;
          input.style.overflowY = "auto";
        } else {
          input.style.overflowY = "hidden";
        }
        input.style.height = newHeight + "px";
      }

      function resetInputSize() {
        input.style.height = "42px";
        input.style.overflowY = "hidden";
      }

      input.addEventListener("input", () => {
        autoResizeInput();
      });

      // PANEL Toggles
      function toggleNotes() {
        notesOpen = !notesOpen;
        const panel = document.getElementById("notesPanel");
        const resizerEl = document.getElementById("notesResizer");
        if (notesOpen) {
          if (historyOpen) toggleHistory();
          if (settingsOpen) toggleSettings();
          if (mcpOpen) toggleMcp();
          panel.classList.add("open");
          resizerEl.style.display = "block";
          const { area } = getNotesElements();
          if (area) {
            area.value = notesLastSyncedText;
          }
          ensureNotesLoaded();
        } else {
          panel.classList.remove("open");
          resizerEl.style.display = "none";
          scheduleNotesSave(true);
        }
      }

      // Build a copyable diagnostics report: environment, startup timings,
      // per-mode state, and recent errors — for bug/slow-startup reports.
      function buildDiagnosticsReport() {
        const lines = [];
        const add = (k, v) => lines.push(k + ": " + v);
        const nav =
          (performance.getEntriesByType &&
            performance.getEntriesByType("navigation")[0]) ||
          null;
        const versionLabel =
          document.getElementById("app-version-label")?.textContent || "?";
        lines.push("=== DIVE DIAGNOSTICS ===");
        add("generated", new Date().toISOString());
        add("app version", versionLabel);
        lines.push("");
        lines.push("--- ENVIRONMENT ---");
        add("userAgent", navigator.userAgent);
        add("electron", /Electron/i.test(navigator.userAgent) ? "yes" : "no");
        add("platform", navigator.platform);
        add("language", navigator.language);
        add("online", String(navigator.onLine));
        add("cpuCores", String(navigator.hardwareConcurrency || "?"));
        add("deviceMemoryGB", String(navigator.deviceMemory || "?"));
        add(
          "window",
          window.innerWidth +
            "x" +
            window.innerHeight +
            " @" +
            (window.devicePixelRatio || 1) +
            "x",
        );
        add("apiBase", typeof API_BASE !== "undefined" ? API_BASE : "?");
        if (performance.memory) {
          add(
            "jsHeapMB",
            Math.round(performance.memory.usedJSHeapSize / 1048576) +
              " / " +
              Math.round(performance.memory.jsHeapSizeLimit / 1048576),
          );
        }
        lines.push("");
        lines.push("--- STARTUP TIMING (ms) ---");
        if (nav) {
          add("html responseEnd", Math.round(nav.responseEnd - nav.startTime));
          add(
            "domContentLoaded",
            Math.round(nav.domContentLoadedEventEnd - nav.startTime),
          );
          add("load event", Math.round(nav.loadEventEnd - nav.startTime));
          if (nav.transferSize) add("html transferBytes", nav.transferSize);
        }
        __bootTimings.forEach((t) => add("  " + t.label, t.ms));
        lines.push("");
        lines.push("--- STATE ---");
        add("active mode", mode);
        add("theme", isDark ? "dark" : "light");
        add(
          "enabled modes",
          typeof enabledModes !== "undefined" ? enabledModes.join(", ") : "?",
        );
        try {
          add(
            "palettes",
            `ollama=${ollamaPalette} pi=${piPalette} cloud=${cloudPalette} lmstudio=${lmstudioPalette} llamacpp=${llamacppPalette}`,
          );
          const dbcfg =
            typeof collectDatabaseConfigFromForm === "function"
              ? collectDatabaseConfigFromForm().chatModes
              : databaseChatModes;
          add(
            "database enabled",
            SEARCH_ALGO_MODE_KEYS.map(
              (m) => m + "=" + (dbcfg[m]?.enabled ? "on" : "off"),
            ).join(" "),
          );
          add("ollama model", localStorage.getItem(MODEL_STORAGE_KEY) || "?");
          add(
            "cloud provider/model",
            (cloudSettings.provider || "?") +
              " / " +
              (cloudSettings.models?.[cloudSettings.provider] || "?"),
          );
          LOCAL_MODE_IDS.forEach((id) => {
            const c = localModelConfig[id];
            add(id, `${c.baseUrl}  model=${c.model || "(auto)"}`);
          });
          add("active prompt", activePromptId || "(default)");
        } catch (e) {
          add("state error", e.message);
        }
        lines.push("");
        lines.push("--- RECENT ERRORS (" + __capturedErrors.length + ") ---");
        if (__capturedErrors.length) {
          lines.push(...__capturedErrors.slice(-20));
        } else {
          lines.push("(none)");
        }
        return lines.join("\n");
      }

      function refreshDiagnostics() {
        const out = document.getElementById("diagnosticsOutput");
        if (out) out.value = buildDiagnosticsReport();
      }

      function toggleSettings() {
        settingsOpen = !settingsOpen;
        const panel = document.getElementById("settingsPanel");
        const resizerEl = document.getElementById("settingsResizer");
        if (settingsOpen) {
          if (historyOpen) toggleHistory();
          if (notesOpen) toggleNotes();
          if (mcpOpen) toggleMcp();
          panel.classList.add("open");
          resizerEl.style.display = "block";
          closePromptEditor();
          refreshDiagnostics();
          // Lessons are per-mode: every open must rebind the Lessons editor
          // to the CURRENT mode and load that mode's file (boot-time loading
          // alone left it stale).
          if (typeof loadLessonsUi === "function") {
            loadLessonsUi().catch(() => {});
          }
        } else {
          panel.classList.remove("open");
          resizerEl.style.display = "none";
        }
      }

      function appendSettingsGroups(panelId, groupIds) {
        const panel = document.getElementById(panelId);
        if (!panel) return;
        groupIds.forEach((groupId) => {
          const group = document.getElementById(groupId);
          if (group) panel.appendChild(group);
        });
      }

      function organizeSettingsTabs() {
        // MODES tab holds only the Enabled Modes checkboxes.
        appendSettingsGroups("settingsTabModes", [
          "modesSettingsGroup",
          "diagnosticsGroup",
        ]);
        // MAIN tab holds every mode's config, each shown only for its active
        // mode (same pattern as Ollama/Pi/Cloud).
        appendSettingsGroups("settingsTabMain", [
          "piPaletteGroup",
          "cloudPaletteGroup",
          "ollamaFontGroup",
          "piFontGroup",
          "cloudFontGroup",
          "ollamaGenGroup",
          "piSettingsGroup",
          "cloudSettingsGroup",
          "lmStudioSettingsGroup",
          "llamaCppSettingsGroup",
        ]);
        appendSettingsGroups("settingsTabDatabase", ["databaseSettingsGroup"]);
        appendSettingsGroups("settingsTabPrompts", [
          "promptSettingsGroup",
          "promptManageGroup",
          "systemPromptsGroup",
        ]);
        appendSettingsGroups("settingsTabSkills", [
          "builtinSkillsGroup",
          "pluginsGroup",
          "lessonsGroup",
          "customSkillsGroup",
          "bookSearchConfigGroup",
        ]);

        const settingsBody = document.getElementById("settingsBody");
        const settingsFooter = document.querySelector(".settings-footer");
        if (settingsBody && settingsFooter)
          settingsBody.appendChild(settingsFooter);
      }

      function switchSettingsTab(tabName) {
        const validTabs = ["main", "modes", "database", "prompts", "skills"];
        const nextTab = validTabs.includes(tabName) ? tabName : "main";
        activeSettingsTab = nextTab;

        document.querySelectorAll(".settings-tab").forEach((tab) => {
          const isActive = tab.dataset.settingsTab === nextTab;
          tab.classList.toggle("active", isActive);
          tab.setAttribute("aria-selected", isActive ? "true" : "false");
          tab.tabIndex = isActive ? 0 : -1;
        });
        document.querySelectorAll(".settings-tab-panel").forEach((panel) => {
          const isActive = panel.dataset.settingsPanel === nextTab;
          panel.classList.toggle("active", isActive);
          panel.hidden = !isActive;
        });
      }

      function updateSettingsTabAvailability(state = {}) {
        const isOllamaMode =
          typeof state === "boolean" ? state : state.isOllamaMode === true;
        const isCloudMode =
          typeof state === "object" && state.isCloudMode === true;
        const isLocalMode =
          typeof state === "object" && state.isLocalMode === true;
        const promptsVisible = isOllamaMode || isLocalMode;
        const skillsVisible = isOllamaMode || isCloudMode || isLocalMode;
        const promptsTab = document.querySelector(
          '.settings-tab[data-settings-tab="prompts"]',
        );
        const skillsTab = document.querySelector(
          '.settings-tab[data-settings-tab="skills"]',
        );
        if (promptsTab) promptsTab.style.display = promptsVisible ? "" : "none";
        if (skillsTab) skillsTab.style.display = skillsVisible ? "" : "none";
        if (
          (activeSettingsTab === "prompts" && !promptsVisible) ||
          (activeSettingsTab === "skills" && !skillsVisible)
        ) {
          switchSettingsTab("main");
        }
      }

      // Real connection results from the server (set after each config POST),
      // so the panel shows what actually connected instead of just the names
      // present in the JSON.
      let lastMcpStatuses = null;

      function renderMcpList(jsonString, statuses = lastMcpStatuses) {
        const listDiv = document.getElementById("mcpActiveList");
        if (!listDiv) return;
        listDiv.innerHTML = "";
        try {
          if (!jsonString) return;
          const config = JSON.parse(jsonString);
          if (config && config.mcpServers) {
            const servers = Object.keys(config.mcpServers);
            if (servers.length > 0) {
              servers.forEach((name) => {
                const status = Array.isArray(statuses)
                  ? statuses.find((s) => s && s.name === name)
                  : null;
                const badge = document.createElement("div");
                if (status && status.ok) {
                  badge.textContent = `${name.toUpperCase()} · ${status.toolCount} TOOLS`;
                  badge.title = (status.tools || []).join(", ");
                  badge.style.cssText =
                    "background: var(--accent); color: var(--bg-inverse); padding: 4px 8px; font-size: calc(10px * var(--font-scale, 1)); font-weight: bold; border-radius: 2px;";
                } else if (status && !status.ok) {
                  badge.textContent = `${name.toUpperCase()} · FAILED`;
                  badge.title = status.error || "Unknown error";
                  badge.style.cssText =
                    "background: #ff4444; color: #fff; padding: 4px 8px; font-size: calc(10px * var(--font-scale, 1)); font-weight: bold; border-radius: 2px;";
                  const err = document.createElement("div");
                  err.textContent = status.error || "Unknown error";
                  err.style.cssText =
                    "flex-basis: 100%; font-size: calc(9px * var(--font-scale, 1)); color: #ff4444; margin: -2px 0 4px;";
                  listDiv.appendChild(badge);
                  listDiv.appendChild(err);
                  return;
                } else {
                  badge.textContent = name.toUpperCase();
                  badge.style.cssText =
                    "background: var(--text-inverse); color: var(--bg-inverse); padding: 4px 8px; font-size: calc(10px * var(--font-scale, 1)); font-weight: bold; border-radius: 2px;";
                }
                listDiv.appendChild(badge);
              });
            } else {
              listDiv.innerHTML =
                "<span style='font-size: calc(10px * var(--font-scale, 1)); opacity: 0.5;'>No active servers</span>";
            }
          }
        } catch (e) {
          // invalid json, just ignore
        }
      }

      function toggleMcp() {
        mcpOpen = !mcpOpen;
        const panel = document.getElementById("mcpPanel");
        const resizerEl = document.getElementById("mcpResizer");
        if (mcpOpen) {
          if (historyOpen) toggleHistory();
          if (notesOpen) toggleNotes();
          if (settingsOpen) toggleSettings();
          panel.classList.add("open");
          resizerEl.style.display = "block";
          const configArea = document.getElementById("mcpConfigArea");
          const saved = localStorage.getItem("mcpConfig");
          if (saved) {
            configArea.value = saved;
            renderMcpList(saved);
          } else {
            renderMcpList("");
          }
        } else {
          panel.classList.remove("open");
          resizerEl.style.display = "none";
        }
      }

      async function saveMcpConfig() {
        const area = document.getElementById("mcpConfigArea");
        const status = document.getElementById("mcpStatus");
        try {
          const raw = area.value.trim();
          if (raw) {
            JSON.parse(raw); // validate
          }
          localStorage.setItem("mcpConfig", raw);
          renderMcpList(raw);
          status.textContent = "CONNECTING...";
          status.style.color = "var(--accent)";

          const res = await fetch("/api/mcp/config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ config: raw }),
          });
          const payload = await res.json().catch(() => null);
          lastMcpStatuses = Array.isArray(payload?.servers)
            ? payload.servers
            : null;
          renderMcpList(raw);

          const okCount = (lastMcpStatuses || []).filter((s) => s.ok).length;
          const failCount = (lastMcpStatuses || []).filter((s) => !s.ok).length;
          if (failCount > 0) {
            status.textContent = `${okCount} CONNECTED, ${failCount} FAILED`;
            status.style.color = "#ff4444";
          } else {
            status.textContent = `${okCount} CONNECTED`;
            status.style.color = "var(--accent)";
          }
          setTimeout(() => {
            status.textContent = "";
          }, 6000);
        } catch (e) {
          status.textContent = "INVALID JSON";
          status.style.color = "#ff4444";
          setTimeout(() => {
            status.textContent = "";
          }, 2000);
        }
      }

      // Stop every MCP server and delete everything they downloaded (the
      // folders referenced in the config's env paths). Fully reversible: the
      // next save simply re-downloads.
      async function purgeMcpDownloads() {
        const status = document.getElementById("mcpStatus");
        const raw =
          document.getElementById("mcpConfigArea")?.value.trim() ||
          localStorage.getItem("mcpConfig") ||
          "";
        if (
          !(await appConfirm(
            "Stop all MCP servers and delete their downloaded files? The next save re-downloads them.",
            "MCP",
          ))
        ) {
          return;
        }
        try {
          const res = await fetch(apiUrl("/api/mcp/purge"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ config: raw }),
          });
          const payload = await readJsonResponse(res, "Delete MCP downloads");
          lastMcpStatuses = null;
          renderMcpList(localStorage.getItem("mcpConfig") || "");
          const count = Array.isArray(payload?.removed)
            ? payload.removed.length
            : 0;
          status.textContent = `SERVERS STOPPED · ${count} LOCATION${count === 1 ? "" : "S"} DELETED`;
          status.style.color = "var(--accent)";
          setTimeout(() => {
            status.textContent = "";
          }, 6000);
        } catch (e) {
          status.textContent = "DELETE FAILED";
          status.style.color = "#ff4444";
          console.error("Could not delete MCP downloads", e);
          setTimeout(() => {
            status.textContent = "";
          }, 3000);
        }
      }

      function saveNotes() {
        scheduleNotesSave(true);
      }

      // Auto-save notes on input
      document.addEventListener("input", (e) => {
        if (e.target.matches('input[type="range"]')) {
          const display = e.target.nextElementSibling;
          if (display && display.classList.contains("setting-range-value")) {
            display.textContent = e.target.value;
          }
          if (SEARCH_ALGO_SLIDER_IDS.has(e.target.id)) {
            scheduleSearchAlgorithmAutosave();
          }
        }
      });

      document.addEventListener("DOMContentLoaded", () => {
        const area = document.getElementById("notesArea");
        if (area)
          area.addEventListener("input", () => {
            scheduleNotesSave(false);
          });
      });

      // Resizers logic
      const notesResizer = document.getElementById("notesResizer");
      const notesPanel = document.getElementById("notesPanel");
      let isResizing = false;

      const settingsResizer = document.getElementById("settingsResizer");
      const settingsPanel = document.getElementById("settingsPanel");
      let isSettingsResizing = false;

      const mcpResizer = document.getElementById("mcpResizer");
      const mcpPanelEl = document.getElementById("mcpPanel");
      let isMcpResizing = false;

      const historyResizer = document.getElementById("historyResizer");
      const historyPanelEl = document.getElementById("historyPanel");
      let isHistoryResizing = false;

      historyResizer.addEventListener("mousedown", (e) => {
        if (!historyOpen) return;
        isHistoryResizing = true;
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      });

      const sidePanelResizer = document.getElementById("sidePanelResizer");
      const sidePanelEl = document.getElementById("sidePanel");
      let isSidePanelResizing = false;

      if (sidePanelResizer) {
        sidePanelResizer.addEventListener("mousedown", (e) => {
          if (sidePanelEl.style.display === "none") return;
          isSidePanelResizing = true;
          document.body.style.cursor = "col-resize";
          document.body.style.userSelect = "none";
        });
      }

      notesResizer.addEventListener("mousedown", (e) => {
        if (!notesOpen) return;
        isResizing = true;
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      });

      settingsResizer.addEventListener("mousedown", (e) => {
        if (!settingsOpen) return;
        isSettingsResizing = true;
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      });

      mcpResizer.addEventListener("mousedown", (e) => {
        if (!mcpOpen) return;
        isMcpResizing = true;
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      });

      document.addEventListener("mousemove", (e) => {
        const main = document.getElementById("main");
        const mainRect = main.getBoundingClientRect();
        if (isResizing) {
          const newWidth = mainRect.right - e.clientX;
          if (newWidth > 150 && newWidth < mainRect.width - 200) {
            notesPanel.style.width = newWidth + "px";
          }
        } else if (isSettingsResizing) {
          const newWidth = mainRect.right - e.clientX;
          if (newWidth > 200 && newWidth < mainRect.width - 200) {
            settingsPanel.style.width = newWidth + "px";
          }
        } else if (isMcpResizing) {
          const newWidth = mainRect.right - e.clientX;
          if (newWidth > 300 && newWidth < mainRect.width - 200) {
            mcpPanelEl.style.width = newWidth + "px";
          }
        } else if (isHistoryResizing) {
          // History is docked on the LEFT, so its width grows to the right.
          const newWidth =
            e.clientX - historyPanelEl.getBoundingClientRect().left;
          if (newWidth > 150 && newWidth < mainRect.width - 200) {
            historyPanelEl.style.width = newWidth + "px";
          }
        } else if (isSidePanelResizing) {
          // The side panel is docked on the LEFT edge of #main.
          const newWidth = e.clientX - mainRect.left;
          if (newWidth > 200 && newWidth < mainRect.width - 200) {
            sidePanelEl.style.width = newWidth + "px";
          }
        }
      });

      document.addEventListener("mouseup", () => {
        if (
          isResizing ||
          isSettingsResizing ||
          isMcpResizing ||
          isHistoryResizing ||
          isSidePanelResizing
        ) {
          isResizing = false;
          isSettingsResizing = false;
          isMcpResizing = false;
          isHistoryResizing = false;
          isSidePanelResizing = false;
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
        }
      });

      // DOM LOADED
      window.addEventListener("DOMContentLoaded", async () => {
        // 1. Theme and color palette setup
        isDark = localStorage.getItem("ollama-pi-chat-dark-mode") === "true";
        updateThemeUI();

        await __timed("loadUiSettings", loadUiSettings);
        if (typeof wireThinkingExpandedSettings === "function") {
          wireThinkingExpandedSettings();
        }
        loadOllamaOptionsFromStorage();
        document.getElementById("settingOllamaPalette").value = ollamaPalette;
        document.getElementById("settingPiPalette").value = piPalette;
        document.getElementById("settingCloudPalette").value = cloudPalette;
        refreshCustomSelectUi(document.getElementById("settingOllamaPalette"));
        refreshCustomSelectUi(document.getElementById("settingPiPalette"));
        refreshCustomSelectUi(document.getElementById("settingCloudPalette"));
        syncFontControls("ollama", ollamaFont);
        syncFontControls("pi", piFont);
        syncFontControls("cloud", cloudFont);
        syncFontControls("lmstudio", lmstudioFont);
        syncFontControls("llamacpp", llamacppFont);
        renderOllamaOptionsForm();
        await __timed("loadLibrarySettings", loadLibrarySettings);
        // Library status runs SQLite counts that can take many seconds on a big
        // library — run it in the background so it never blocks startup.
        __timed("pollLibraryIndexJob", pollLibraryIndexJob).catch(() => {});
        // Open in the user's chosen default mode. "First enabled" ("") always
        // means the leftmost enabled mode — never a stale initial value.
        mode = enabledModes.includes(defaultLaunchMode)
          ? defaultLaunchMode
          : enabledModes[0] || "lmstudio";
        applyPalette(
          mode === "ollama"
            ? ollamaPalette
            : mode === "pi"
              ? piPalette
              : mode === "lmstudio"
                ? lmstudioPalette
                : mode === "llamacpp"
                  ? llamacppPalette
                  : cloudPalette,
        );
        applyFont(
          mode === "ollama"
            ? ollamaFont
            : mode === "pi"
              ? piFont
              : mode === "lmstudio"
                ? lmstudioFont
                : mode === "llamacpp"
                  ? llamacppFont
                  : cloudFont,
        );
        setMode(mode);
        renderModesSettings();
        applyEnabledModes();
        renderPiSettingsForm();

        // Migrate the legacy global active-prompt into Ollama's per-mode slot,
        // then load the current mode's own active prompt.
        const legacyActivePrompt = localStorage.getItem(
          "ollama-pi-chat-active-prompt",
        );
        if (
          legacyActivePrompt &&
          !localStorage.getItem(activePromptStorageKey("ollama"))
        ) {
          localStorage.setItem(
            activePromptStorageKey("ollama"),
            legacyActivePrompt,
          );
        }
        activePromptId = PROMPT_MODE_KEYS.includes(mode)
          ? localStorage.getItem(activePromptStorageKey(mode)) || ""
          : "";
        updateSendButtonState();

        // 2. Load models & Prompts (timed for slow-startup diagnostics)
        await __timed("loadModels", loadModels);
        await __timed("loadPrompts", loadPrompts);
        // Ollama's system prompt is built client-side: its base-prompt
        // overrides must be cached before the first message can be sent.
        await __timed(
          "refreshOllamaPromptOverrides",
          refreshOllamaPromptOverrides,
        );
        await __timed("loadCustomSkills", loadCustomSkills);
        await __timed("loadPiSettings", loadPiSettings);
        await __timed("loadCloudSettings", loadCloudSettings);
        await __timed("loadLocalModeSettings", loadLocalModeSettings);
        wireLocalModeSettings();
        wireOllamaAgentSettings();
        wireSidePanel();
        loadBookSearchConfigUi();
        const btn_saveBookSearch = document.getElementById(
          "saveBookSearchConfigBtn",
        );
        if (btn_saveBookSearch) {
          btn_saveBookSearch.addEventListener("click", saveBookSearchConfigUi);
        }
        await __timed("loadOllamaSkillsConfig", loadOllamaSkillsConfig);
        subscribeToGlobalAppEvents();
        __bootTimings.push({
          label: "__boot_total",
          ms: Math.round(performance.now() - __appLoadStart),
        });
        const permissionPolicySelect = document.getElementById(
          "piPermissionPolicySelect",
        );
        if (permissionPolicySelect) {
          permissionPolicySelect.addEventListener(
            "change",
            applyPermissionPolicyPreset,
          );
        }

        // 3. Handle optional one-shot query prompt (Firefox "Ask chatbot"
        // context menu). Runs in the user's launch mode — never a hardcoded
        // one; the app is not Ollama-only.
        const params = new URLSearchParams(window.location.search);
        const q = params.get("q");
        if (q) {
          document.getElementById("input").value = q;
          autoResizeInput();
          sendMessage();
          window.history.replaceState({}, document.title, "/");
        }

        updateTokenCounter();

        // 4. Fetch app version
        fetch(apiUrl("/api/version"))
          .then((res) => res.json())
          .then((data) => {
            const el = document.getElementById("app-version-label");
            if (el) el.textContent = data.version;
          })
          .catch((err) => console.error("Could not fetch version:", err));

        // 5. Initialize MCP Servers if configured
        const savedMcpConfig = localStorage.getItem("mcpConfig");
        if (savedMcpConfig) {
          fetch("/api/mcp/config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ config: savedMcpConfig }),
          })
            .then((res) => res.json())
            .then((payload) => {
              // Keep the real connection results so opening the MCP panel
              // shows which servers are up and why any failed.
              if (Array.isArray(payload?.servers)) {
                lastMcpStatuses = payload.servers;
              }
            })
            .catch((err) => console.error("Could not init MCP:", err));
        }
      });
      function syncCustomSelect(selectEl) {
        if (!selectEl) return;

        // If it already has a custom wrapper next to it, remove it
        if (
          selectEl.nextElementSibling &&
          selectEl.nextElementSibling.classList.contains(
            "custom-select-wrapper",
          )
        ) {
          selectEl.nextElementSibling.remove();
        }

        selectEl.style.display = "none";

        const wrapper = document.createElement("div");
        wrapper.className = "custom-select-wrapper";
        if (selectEl.id) {
          wrapper.dataset.for = selectEl.id;
        }
        selectEl.classList.forEach((c) => {
          if (c !== "mode-hidden") wrapper.classList.add(c);
        });

        const trigger = document.createElement("div");
        trigger.className = "custom-select-trigger";

        const textSpan = document.createElement("span");
        textSpan.className = "custom-select-text";
        textSpan.textContent =
          selectEl.options[selectEl.selectedIndex]?.text || "";

        const iconSpan = document.createElement("span");
        iconSpan.innerHTML = "▼";
        iconSpan.style.fontSize = "calc(8px * var(--font-scale, 1))";
        iconSpan.style.marginLeft = "auto";
        iconSpan.style.paddingLeft = "4px";

        trigger.appendChild(textSpan);
        trigger.appendChild(iconSpan);

        const optionsContainer = document.createElement("div");
        optionsContainer.className = "custom-select-options";

        Array.from(selectEl.options).forEach((opt) => {
          const optDiv = document.createElement("div");
          optDiv.className = "custom-select-option";
          optDiv.textContent = opt.text;

          if (opt.selected) optDiv.classList.add("selected");

          optDiv.addEventListener("click", (e) => {
            e.stopPropagation();
            selectEl.value = opt.value;
            textSpan.textContent = opt.text;

            Array.from(optionsContainer.children).forEach((c) =>
              c.classList.remove("selected"),
            );
            optDiv.classList.add("selected");

            optionsContainer.classList.remove("open");

            selectEl.dispatchEvent(new Event("change", { bubbles: true }));
          });
          optionsContainer.appendChild(optDiv);
        });

        trigger.addEventListener("click", (e) => {
          e.stopPropagation();
          document.querySelectorAll(".custom-select-options").forEach((c) => {
            if (c !== optionsContainer) c.classList.remove("open");
          });
          optionsContainer.classList.toggle("open");
        });

        wrapper.appendChild(trigger);
        wrapper.appendChild(optionsContainer);
        selectEl.parentNode.insertBefore(wrapper, selectEl.nextSibling);

        // Sync mode-hidden visibility
        wrapper.style.display = selectEl.classList.contains("mode-hidden")
          ? "none"
          : "inline-block";

        if (!selectEl.dataset.observerAttached) {
          const observer = new MutationObserver(() => {
            if (
              selectEl.nextElementSibling &&
              selectEl.nextElementSibling.classList.contains(
                "custom-select-wrapper",
              )
            ) {
              selectEl.nextElementSibling.style.display =
                selectEl.classList.contains("mode-hidden")
                  ? "none"
                  : "inline-block";
            }
          });
          observer.observe(selectEl, {
            attributes: true,
            attributeFilter: ["class"],
          });
          selectEl.dataset.observerAttached = "true";
        }
      }

      document.addEventListener("click", () => {
        document
          .querySelectorAll(".custom-select-options")
          .forEach((c) => c.classList.remove("open"));
      });

      document.addEventListener("click", (event) => {
        const tab = event.target.closest(".settings-tab");
        if (!tab) return;
        switchSettingsTab(tab.dataset.settingsTab);
      });

      // Initialize static selects
      organizeSettingsTabs();
      switchSettingsTab(activeSettingsTab);
      document.querySelectorAll("select").forEach(syncCustomSelect);

      // --- REFACTORED ONCLICK LISTENERS ---
      document.addEventListener("DOMContentLoaded", function () {
        document.addEventListener("change", function (e) {
          if (e.target.classList.contains("builtin-skill-toggle")) {
            toggleBuiltinSkill(
              e.target.getAttribute("data-skill"),
              e.target.checked,
            );
          } else if (
            e.target.id === "topbarPromptSelect" ||
            e.target.id === "settingActivePrompt"
          ) {
            selectActivePrompt(e.target.value);
          } else if (e.target.id === "settingOllamaPalette") {
            changeOllamaPalette(e.target.value);
          } else if (e.target.id === "settingPiPalette") {
            changePiPalette(e.target.value);
          } else if (e.target.id === "settingCloudPalette") {
            changeCloudPalette(e.target.value);
          } else if (e.target.id === "settingOllamaFontPreset") {
            onOllamaFontPresetChange(e.target.value);
          } else if (e.target.id === "settingOllamaFontCustom") {
            changeOllamaFont(e.target.value);
          } else if (e.target.id === "settingPiFontPreset") {
            onPiFontPresetChange(e.target.value);
          } else if (e.target.id === "settingPiFontCustom") {
            changePiFont(e.target.value);
          } else if (e.target.id === "settingCloudFontPreset") {
            onCloudFontPresetChange(e.target.value);
          } else if (e.target.id === "settingCloudFontCustom") {
            changeCloudFont(e.target.value);
          } else if (e.target.id === "lmStudioFontPreset") {
            onLocalFontPresetChange(
              "lmstudio",
              e.target.value,
              "lmStudioFontCustom",
              lmstudioFont,
            );
          } else if (e.target.id === "lmStudioFontCustom") {
            changeLmstudioFont(e.target.value);
          } else if (e.target.id === "llamaCppFontPreset") {
            onLocalFontPresetChange(
              "llamacpp",
              e.target.value,
              "llamaCppFontCustom",
              llamacppFont,
            );
          } else if (e.target.id === "llamaCppFontCustom") {
            changeLlamacppFont(e.target.value);
          } else if (e.target.id === "cloudProviderSelect") {
            cloudSettings.provider = e.target.value;
            renderCloudSettingsForm();
          } else if (
            e.target.id === "cloudModelInput" ||
            e.target.id === "cloudBaseUrlInput" ||
            e.target.id === "cloudMaxTokensInput"
          ) {
            const provider = cloudSettings.provider || "openai";
            if (e.target.id === "cloudModelInput") {
              cloudSettings.models[provider] =
                e.target.value.trim() || CLOUD_DEFAULT_MODELS[provider];
            } else if (e.target.id === "cloudBaseUrlInput") {
              cloudSettings.baseUrls[provider] =
                e.target.value.trim() || CLOUD_DEFAULT_BASE_URLS[provider];
            } else {
              cloudSettings.maxTokens = clampInteger(
                e.target.value,
                2048,
                1,
                128000,
              );
            }
            updateModeStatus();
          } else if (
            e.target.closest("#ollamaGenGroup") &&
            e.target.tagName !== "SELECT" &&
            e.target.tagName !== "BUTTON"
          ) {
            saveOllamaOptionsFromForm();
          } else if (e.target.id === "databaseEmbeddingModelSelect") {
            const customInput = document.getElementById(
              "databaseEmbeddingModelCustomInput",
            );
            if (customInput) {
              customInput.style.display =
                e.target.value === "__custom__" ? "" : "none";
              if (e.target.value === "__custom__") customInput.focus();
            }
            syncEmbeddingBaseUrlToModel(e.target.value);
          }
        });

        document.addEventListener("click", function (e) {
          const removeSourceButton = e.target.closest(
            ".database-source-remove",
          );
          if (removeSourceButton) {
            removeDatabaseSource(Number(removeSourceButton.dataset.index || 0));
            return;
          }
          if (e.target && e.target.classList.contains("prompt-item-delete")) {
            const idx = e.target.getAttribute("data-idx");
            if (idx !== null) {
              if (typeof deleteCustomSkill === "function")
                deleteCustomSkill(idx);
              else if (typeof deleteCustomPrompt === "function")
                deleteCustomPrompt(idx);
            }
          }
        });

        const btn_btnOllama = document.getElementById("btnOllama");
        if (btn_btnOllama) {
          btn_btnOllama.addEventListener("click", function (event) {
            setMode("ollama");
          });
        }

        const btn_btnPi = document.getElementById("btnPi");
        if (btn_btnPi) {
          btn_btnPi.addEventListener("click", function (event) {
            setMode("pi");
          });
        }

        const btn_btnCloud = document.getElementById("btnCloud");
        if (btn_btnCloud) {
          btn_btnCloud.addEventListener("click", function (event) {
            setMode("cloud");
          });
        }

        const btn_btnLmStudio = document.getElementById("btnLmStudio");
        if (btn_btnLmStudio) {
          btn_btnLmStudio.addEventListener("click", function () {
            setMode("lmstudio");
          });
        }

        const btn_btnLlamaCpp = document.getElementById("btnLlamaCpp");
        if (btn_btnLlamaCpp) {
          btn_btnLlamaCpp.addEventListener("click", function () {
            setMode("llamacpp");
          });
        }

        const btn_clearBtn = document.getElementById("clearBtn");
        if (btn_clearBtn) {
          btn_clearBtn.addEventListener("click", function (event) {
            clearChat();
          });
        }

        const btn_themeBtn = document.getElementById("themeBtn");
        if (btn_themeBtn) {
          btn_themeBtn.addEventListener("click", function (event) {
            toggleTheme();
          });
        }

        const btn_deleteAllBtn = document.getElementById("deleteAllBtn");
        if (btn_deleteAllBtn) {
          btn_deleteAllBtn.addEventListener("click", function (event) {
            deleteAllHistory();
          });
        }

        const btn_uploadBtn = document.getElementById("uploadBtn");
        if (btn_uploadBtn) {
          btn_uploadBtn.addEventListener("click", function (event) {
            document.getElementById("fileInput").click();
          });
        }

        const btn_saveNotesBtn = document.getElementById("saveNotesBtn");
        if (btn_saveNotesBtn) {
          btn_saveNotesBtn.addEventListener("click", function (event) {
            saveNotes();
          });
        }

        const btn_closeHistoryBtn = document.getElementById("closeHistoryBtn");
        if (btn_closeHistoryBtn) {
          btn_closeHistoryBtn.addEventListener("click", function (event) {
            if (historyOpen) toggleHistory();
          });
        }

        const btn_closeNotesBtn = document.getElementById("closeNotesBtn");
        if (btn_closeNotesBtn) {
          btn_closeNotesBtn.addEventListener("click", function (event) {
            toggleNotes();
          });
        }

        const btn_notesFolderBtn = document.getElementById("notesFolderBtn");
        if (btn_notesFolderBtn) {
          btn_notesFolderBtn.addEventListener("click", function (event) {
            toggleNotesList();
          });
        }

        const btn_notesNewBtn = document.getElementById("notesNewBtn");
        if (btn_notesNewBtn) {
          btn_notesNewBtn.addEventListener("click", function (event) {
            createNewNote();
          });
        }

        const input_notesTitle = document.getElementById("notesTitleInput");
        if (input_notesTitle) {
          input_notesTitle.addEventListener("change", function (event) {
            renameActiveNote(input_notesTitle.value);
          });
          input_notesTitle.addEventListener("keydown", function (event) {
            if (event.key === "Enter") input_notesTitle.blur();
          });
        }

        const btn_closeMcpBtn = document.getElementById("closeMcpBtn");
        if (btn_closeMcpBtn) {
          btn_closeMcpBtn.addEventListener("click", function (event) {
            toggleMcp();
          });
        }

        const btn_saveMcpBtn = document.getElementById("saveMcpBtn");
        if (btn_saveMcpBtn) {
          btn_saveMcpBtn.addEventListener("click", function (event) {
            saveMcpConfig();
          });
        }

        const btn_purgeMcpBtn = document.getElementById("purgeMcpBtn");
        if (btn_purgeMcpBtn) {
          btn_purgeMcpBtn.addEventListener("click", function (event) {
            purgeMcpDownloads();
          });
        }

        const btn_closeSettingsBtn =
          document.getElementById("closeSettingsBtn");
        if (btn_closeSettingsBtn) {
          btn_closeSettingsBtn.addEventListener("click", function (event) {
            toggleSettings();
          });
        }

        const btn_saveCloudSettingsBtn = document.getElementById(
          "saveCloudSettingsBtn",
        );
        if (btn_saveCloudSettingsBtn) {
          btn_saveCloudSettingsBtn.addEventListener("click", function () {
            saveCloudSettingsUi(false);
          });
        }

        const btn_reloadCloudSettingsBtn = document.getElementById(
          "reloadCloudSettingsBtn",
        );
        if (btn_reloadCloudSettingsBtn) {
          btn_reloadCloudSettingsBtn.addEventListener("click", function () {
            loadCloudSettings();
          });
        }

        const btn_clearCloudApiKeyBtn = document.getElementById(
          "clearCloudApiKeyBtn",
        );
        if (btn_clearCloudApiKeyBtn) {
          btn_clearCloudApiKeyBtn.addEventListener("click", async function () {
            if (
              !(await appConfirm(
                "Clear the saved API key for this Cloud provider?",
                "Cloud",
                { confirmLabel: "Clear", danger: true },
              ))
            ) {
              return;
            }
            saveCloudSettingsUi(true);
          });
        }

        const btn_saveDatabaseSettingsBtn = document.getElementById(
          "saveDatabaseSettingsBtn",
        );
        if (btn_saveDatabaseSettingsBtn) {
          btn_saveDatabaseSettingsBtn.addEventListener("click", function () {
            saveLibrarySettingsFromForm();
          });
        }

        const btn_resetSearchAlgorithmSettingsBtn = document.getElementById(
          "resetSearchAlgorithmSettingsBtn",
        );
        if (btn_resetSearchAlgorithmSettingsBtn) {
          btn_resetSearchAlgorithmSettingsBtn.addEventListener(
            "click",
            function () {
              resetSearchAlgorithmSettings();
            },
          );
        }

        document
          .querySelectorAll("#searchAlgorithmModeTabs .search-algo-mode-btn")
          .forEach((btn) => {
            btn.addEventListener("click", function () {
              selectSearchAlgorithmMode(btn.dataset.searchAlgoMode);
            });
          });

        const bookFilterBtn = document.getElementById("bookFilterBtn");
        if (bookFilterBtn) {
          bookFilterBtn.addEventListener("click", openBookFilterPanel);
        }

        const diagRefreshBtn = document.getElementById("diagnosticsRefreshBtn");
        if (diagRefreshBtn) {
          diagRefreshBtn.addEventListener("click", refreshDiagnostics);
        }
        const diagCopyBtn = document.getElementById("diagnosticsCopyBtn");
        if (diagCopyBtn) {
          diagCopyBtn.addEventListener("click", async () => {
            refreshDiagnostics();
            const out = document.getElementById("diagnosticsOutput");
            const text = out ? out.value : "";
            try {
              await navigator.clipboard.writeText(text);
            } catch (_e) {
              if (out) {
                out.focus();
                out.select();
                document.execCommand("copy");
              }
            }
            const prev = diagCopyBtn.textContent;
            diagCopyBtn.textContent = "Copied!";
            setTimeout(() => {
              diagCopyBtn.textContent = prev;
            }, 1200);
          });
        }
        const bookFilterCloseBtn =
          document.getElementById("bookFilterCloseBtn");
        if (bookFilterCloseBtn) {
          bookFilterCloseBtn.addEventListener("click", closeBookFilterPanel);
        }
        const bookFilterOverlayEl =
          document.getElementById("bookFilterOverlay");
        if (bookFilterOverlayEl) {
          bookFilterOverlayEl.addEventListener("click", function (event) {
            if (event.target === bookFilterOverlayEl) closeBookFilterPanel();
          });
        }
        const bookFilterClearBtn =
          document.getElementById("bookFilterClearBtn");
        if (bookFilterClearBtn) {
          bookFilterClearBtn.addEventListener("click", function () {
            bookFilterDraft = [];
            renderBookFilterDraft();
          });
        }
        const bookFilterApplyBtn =
          document.getElementById("bookFilterApplyBtn");
        if (bookFilterApplyBtn) {
          bookFilterApplyBtn.addEventListener("click", applyBookFilterDraft);
        }
        const bookFilterSearchInputEl = document.getElementById(
          "bookFilterSearchInput",
        );
        if (bookFilterSearchInputEl) {
          bookFilterSearchInputEl.addEventListener("input", function () {
            clearTimeout(bookFilterSuggestTimer);
            const term = bookFilterSearchInputEl.value.trim();
            if (term.length < 2) {
              renderBookFilterSuggestions([]);
              return;
            }
            bookFilterSuggestTimer = setTimeout(() => {
              fetchBookFilterSuggestions(term);
            }, 200);
          });
        }
        const librarySearchEnabledInputEl = document.getElementById(
          "librarySearchEnabledInput",
        );
        if (librarySearchEnabledInputEl) {
          librarySearchEnabledInputEl.addEventListener(
            "change",
            updateBookFilterUi,
          );
        }

        const btn_reloadLibraryStatusBtn = document.getElementById(
          "reloadLibraryStatusBtn",
        );
        if (btn_reloadLibraryStatusBtn) {
          btn_reloadLibraryStatusBtn.addEventListener("click", function () {
            loadLibraryStatus();
          });
        }

        const btn_exportIndexedFilesBtn = document.getElementById(
          "exportIndexedFilesBtn",
        );
        if (btn_exportIndexedFilesBtn) {
          btn_exportIndexedFilesBtn.addEventListener("click", function () {
            exportIndexedFiles();
          });
        }

        const btn_openIndexedFilesExportBtn = document.getElementById(
          "openIndexedFilesExportBtn",
        );
        if (btn_openIndexedFilesExportBtn) {
          btn_openIndexedFilesExportBtn.addEventListener("click", function () {
            openIndexedFilesExport().catch((error) => {
              console.error("Could not open indexed file export", error);
              appAlert(error.message || "Failed to open export.", "Database");
            });
          });
        }

        const btn_copyIndexedFilesExportPathBtn = document.getElementById(
          "copyIndexedFilesExportPathBtn",
        );
        if (btn_copyIndexedFilesExportPathBtn) {
          btn_copyIndexedFilesExportPathBtn.addEventListener(
            "click",
            function () {
              copyIndexedFilesExportPath();
            },
          );
        }

        const btn_addDatabaseSourceBtn = document.getElementById(
          "addDatabaseSourceBtn",
        );
        if (btn_addDatabaseSourceBtn) {
          btn_addDatabaseSourceBtn.addEventListener("click", function () {
            addDatabaseSource();
          });
        }

        const btn_runLibraryIndexBtn =
          document.getElementById("runLibraryIndexBtn");
        if (btn_runLibraryIndexBtn) {
          btn_runLibraryIndexBtn.addEventListener("click", function () {
            startLibraryIndex(false);
          });
        }

        const btn_retryLibraryEmbeddingsBtn = document.getElementById(
          "retryLibraryEmbeddingsBtn",
        );
        if (btn_retryLibraryEmbeddingsBtn) {
          btn_retryLibraryEmbeddingsBtn.addEventListener("click", function () {
            retryLibraryEmbeddings();
          });
        }

        const btn_estimateLibraryIndexBtn = document.getElementById(
          "estimateLibraryIndexBtn",
        );
        if (btn_estimateLibraryIndexBtn) {
          btn_estimateLibraryIndexBtn.addEventListener("click", function () {
            estimateLibraryIndexSize();
          });
        }

        const btn_forceLibraryReindexBtn = document.getElementById(
          "forceLibraryReindexBtn",
        );
        if (btn_forceLibraryReindexBtn) {
          btn_forceLibraryReindexBtn.addEventListener(
            "click",
            async function () {
              if (
                !(await appConfirm(
                  "Reindex all configured source files?",
                  "Database",
                  { confirmLabel: "Reindex", danger: true },
                ))
              ) {
                return;
              }
              startLibraryIndex(true);
            },
          );
        }

        const btn_cancelLibraryIndexBtn = document.getElementById(
          "cancelLibraryIndexBtn",
        );
        if (btn_cancelLibraryIndexBtn) {
          btn_cancelLibraryIndexBtn.addEventListener("click", function () {
            cancelLibraryIndex();
          });
        }

        const btn_refactored_btn_1 =
          document.getElementById("refactored_btn_1");
        if (btn_refactored_btn_1) {
          btn_refactored_btn_1.addEventListener("click", function (event) {
            saveOllamaOptionsFromForm();
          });
        }

        const btn_refactored_btn_2 =
          document.getElementById("refactored_btn_2");
        if (btn_refactored_btn_2) {
          btn_refactored_btn_2.addEventListener("click", function (event) {
            resetOllamaOptionsToDefaults();
          });
        }

        const btn_refactored_btn_3 =
          document.getElementById("refactored_btn_3");
        if (btn_refactored_btn_3) {
          btn_refactored_btn_3.addEventListener("click", function (event) {
            savePiSettingsUi();
          });
        }

        const btn_refactored_btn_4 =
          document.getElementById("refactored_btn_4");
        if (btn_refactored_btn_4) {
          btn_refactored_btn_4.addEventListener("click", function (event) {
            loadPiSettings();
          });
        }

        const btn_refactored_btn_5 =
          document.getElementById("refactored_btn_5");
        if (btn_refactored_btn_5) {
          btn_refactored_btn_5.addEventListener("click", function (event) {
            resetPiSettingsToDefaults();
          });
        }

        const btn_refactored_btn_6 =
          document.getElementById("refactored_btn_6");
        if (btn_refactored_btn_6) {
          btn_refactored_btn_6.addEventListener("click", function (event) {
            openOllamaPiChatFolder();
          });
        }

        const btn_refactored_btn_7 =
          document.getElementById("refactored_btn_7");
        if (btn_refactored_btn_7) {
          btn_refactored_btn_7.addEventListener("click", function (event) {
            copyOllamaPiChatFolderPath();
          });
        }

        const btn_refactored_btn_8 =
          document.getElementById("refactored_btn_8");
        if (btn_refactored_btn_8) {
          btn_refactored_btn_8.addEventListener("click", function (event) {
            openPromptEditor();
          });
        }

        const btn_refactored_btn_9 =
          document.getElementById("refactored_btn_9");
        if (btn_refactored_btn_9) {
          btn_refactored_btn_9.addEventListener("click", function (event) {
            saveCustomPrompt();
          });
        }

        const btn_refactored_btn_10 =
          document.getElementById("refactored_btn_10");
        if (btn_refactored_btn_10) {
          btn_refactored_btn_10.addEventListener("click", function (event) {
            closePromptEditor();
          });
        }

        const btn_refactored_btn_11 =
          document.getElementById("refactored_btn_11");
        if (btn_refactored_btn_11) {
          btn_refactored_btn_11.addEventListener("click", function (event) {
            openSkillEditor();
          });
        }

        const btn_refactored_btn_12 =
          document.getElementById("refactored_btn_12");
        if (btn_refactored_btn_12) {
          btn_refactored_btn_12.addEventListener("click", function (event) {
            saveCustomSkill();
          });
        }

        const btn_refactored_btn_13 =
          document.getElementById("refactored_btn_13");
        if (btn_refactored_btn_13) {
          btn_refactored_btn_13.addEventListener("click", function (event) {
            closeSkillEditor();
          });
        }
      });
    
