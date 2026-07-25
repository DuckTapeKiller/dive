      function toggleHistory() {
        historyOpen = !historyOpen;
        const panel = document.getElementById("historyPanel");
        const resizerEl = document.getElementById("historyResizer");
        if (historyOpen) {
          if (settingsOpen) toggleSettings();
          if (notesOpen) toggleNotes();
          if (mcpOpen) toggleMcp();
          panel.classList.add("open");
          if (resizerEl) resizerEl.style.display = "block";
          loadHistoryPanel();
        } else {
          panel.classList.remove("open");
          if (resizerEl) resizerEl.style.display = "none";
        }
      }

      async function loadHistoryPanel() {
        const list = document.getElementById("historyList");
        try {
          const res = await fetch(apiUrl("/api/conversations"));
          const convs = await readJsonResponse(res, "Load conversations");
          const filteredConvs = convs.filter((conv) => {
            const convMode =
              typeof conv.mode === "string" ? conv.mode : "ollama";
            return convMode === mode;
          });
          list.innerHTML = "";
          if (!filteredConvs.length) {
            list.innerHTML =
              '<div id="historyEmpty">No conversations yet</div>';
            return;
          }
          filteredConvs.forEach((conv, idx) => {
            const item = document.createElement("div");
            item.className = "history-item";
            const text = document.createElement("div");
            text.className = "history-item-text";
            const titleSpan = document.createElement("span");
            titleSpan.textContent = conv.title || "Conversation " + (idx + 1);
            const dateSpan = document.createElement("span");
            dateSpan.className = "history-item-date";
            const ts = conv.updatedAt || conv.createdAt;
            dateSpan.textContent = ts
              ? new Date(ts).toLocaleString([], {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : "";
            text.appendChild(titleSpan);
            text.appendChild(dateSpan);
            text.title = conv.title;
            text.onclick = () => loadConversation(conv);
            const del = document.createElement("button");
            del.className = "history-item-del";
            del.textContent = "×";
            del.onclick = (e) => {
              e.stopPropagation();
              deleteConversation(conv.id);
            };
            item.appendChild(text);
            item.appendChild(del);
            list.appendChild(item);
          });
        } catch (e) {
          list.innerHTML = '<div id="historyEmpty">Error loading history</div>';
        }
      }

      function loadConversation(conv) {
        const targetMode = modeSession[conv.mode] ? conv.mode : mode;
        if (targetMode !== mode) {
          setMode(targetMode);
        }
        const session = getActiveModeSession(targetMode);
        const runActive = !!session.activeAbortController;
        if (runActive && session.convId === conv.id) {
          // Returning to the conversation that is still streaming: the
          // in-memory session is authoritative (it holds the pending user
          // turn and the live draft) — re-render it instead of clobbering
          // it with the older on-disk copy.
          currentConvId = conv.id;
          history = [...session.history];
          renderSessionTranscript(session);
        } else if (runActive) {
          // A run is still streaming ANOTHER conversation of this mode. The
          // run owns the session: leave it bound to its own conversation so
          // the reply lands there (the server saves it under the run's conv
          // id) and can never leak into the one being opened. Render the
          // requested conversation as a detached, read-only-state view; the
          // setDraftAssistant/thinking guards (convId mismatch) keep the
          // stream out of this DOM. Stop the live thinking timer first —
          // its nodes are about to be detached by the re-render.
          session.thinkingController?.stopTimer?.();
          currentConvId = conv.id;
          history = conv.history ? [...conv.history] : [];
          lastUserMessage = null;
          lastSentMessage = null;
          renderSessionTranscript({ history: [...history] });
        } else {
          // No active run: bind the mode's session to the loaded conversation.
          history = conv.history || [];
          currentConvId = conv.id;
          session.convId = conv.id;
          session.history = [...history];
          session.lastUserMessage = null;
          session.lastSentMessage = null;
          session.lastExchangePersisted = true;
          session.draftAssistant = null;
          lastUserMessage = null;
          lastSentMessage = null;
          renderSessionTranscript(session);
        }
        if (typeof updateTokenCounter === "function") updateTokenCounter();
        // Never send switch_session into a conversation whose Pi process is
        // mid-generation: reloading the session file resets the agent and
        // cancels the in-flight turn. The live process already has its
        // session open — there is nothing to load.
        if (
          conv.mode === "pi" &&
          conv.piSessionFile &&
          !(runActive && session.convId === conv.id)
        ) {
          fetch(apiUrl("/api/pi/load-session"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              saveConv: conv.id,
              sessionFile: conv.piSessionFile,
            }),
          }).catch(console.error);
        }
        if (mode === "pi") {
          refreshPiStatus().catch(() => {});
        } else {
          updateModeStatus();
        }
        ensurePiEventChannel();
        // Only close the drawer when it is open — the side panel's recent list
        // also loads conversations, without the drawer ever being open.
        if (historyOpen) toggleHistory();
      }

      async function deleteConversation(convId) {
        const res = await fetch(
          apiUrl("/api/conversations/id/" + encodeURIComponent(convId)),
          {
            method: "DELETE",
          },
        );
        await readJsonResponse(res, "Delete conversation");
        loadHistoryPanel();
        refreshSidePanelRecent();
      }

      // ---- PERMANENT SIDE PANEL (collapsible) ----
      const SIDE_PANEL_COLLAPSED_KEY = "dive-side-panel-collapsed";

      function sidePanelSetCollapsed(collapsed) {
        const panel = document.getElementById("sidePanel");
        const rail = document.getElementById("sideRail");
        const resizerEl = document.getElementById("sidePanelResizer");
        if (!panel || !rail) return;
        panel.style.display = collapsed ? "none" : "flex";
        rail.style.display = collapsed ? "flex" : "none";
        if (resizerEl) resizerEl.style.display = collapsed ? "none" : "";
        try {
          localStorage.setItem(SIDE_PANEL_COLLAPSED_KEY, String(collapsed));
        } catch (_e) {}
      }

      function updateSidePanelDb() {
        const input = document.getElementById("librarySearchEnabledInput");
        const enabled = input
          ? input.checked === true
          : librarySettings.enabled === true;
        const toggle = document.getElementById("sideDbToggle");
        if (toggle) toggle.checked = enabled;
        const railBtn = document.getElementById("railDbBtn");
        if (railBtn) railBtn.classList.toggle("on", enabled);
      }

      async function sideDbSetEnabled(enabled) {
        // Mirror into the Database tab's checkbox (the single source the rest
        // of the app reads) and persist through the same per-mode save path.
        const input = document.getElementById("librarySearchEnabledInput");
        if (input && input.checked !== enabled) {
          input.checked = enabled;
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
        updateSidePanelDb();
        if (typeof saveLibrarySettingsFromForm === "function") {
          try {
            await saveLibrarySettingsFromForm();
          } catch (_e) {}
        }
        updateSidePanelDb();
      }

      function sideRefreshModels() {
        if (mode === "ollama") {
          if (typeof loadModels === "function") loadModels();
        } else if (LOCAL_MODE_IDS.includes(mode)) {
          refreshLocalModels(mode);
        } else if (mode === "cloud") {
          loadCloudSettings()
            .then(() => {
              if (mode === "cloud") populateTopbarModelSelect();
            })
            .catch(() => {});
        } else if (mode === "pi") {
          piAvailableModels = [];
          loadPiTopbarModels();
          refreshPiStatus().catch(() => {});
        }
      }

      function formatSideConvAge(ts) {
        if (!ts) return "";
        const minutes = Math.floor((Date.now() - ts) / 60000);
        if (minutes < 1) return "now";
        if (minutes < 60) return minutes + "m";
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return hours + "h";
        return Math.floor(hours / 24) + "d";
      }

      async function refreshSidePanelRecent() {
        const list = document.getElementById("sideRecentList");
        if (!list) return;
        try {
          const res = await fetch(apiUrl("/api/conversations"));
          const convs = await readJsonResponse(res, "Load conversations");
          const recent = (Array.isArray(convs) ? convs : [])
            .filter((conv) => {
              const convMode =
                typeof conv.mode === "string" ? conv.mode : "ollama";
              return convMode === mode;
            })
            .slice(0, 5);
          list.innerHTML = "";
          if (!recent.length) {
            const empty = document.createElement("div");
            empty.className = "side-recent-empty";
            empty.textContent = "No conversations yet";
            list.appendChild(empty);
            return;
          }
          for (const conv of recent) {
            const item = document.createElement("div");
            item.className =
              "side-box side-conv" +
              (conv.id === currentConvId ? " active" : "");
            const title = document.createElement("span");
            title.className = "side-conv-title";
            title.textContent = conv.title || "Conversation";
            const date = document.createElement("span");
            date.className = "side-conv-date";
            date.textContent = formatSideConvAge(
              conv.updatedAt || conv.createdAt,
            );
            item.title = conv.title || "";
            item.appendChild(title);
            item.appendChild(date);
            item.onclick = () => {
              loadConversation(conv);
              refreshSidePanelRecent();
            };
            list.appendChild(item);
          }
        } catch (_e) {
          // Server unavailable — leave the list as-is.
        }
      }

      function refreshSidePanel() {
        updateSidePanelDb();
        refreshSidePanelRecent();
      }

      function wireSidePanel() {
        const on = (id, event, handler) => {
          const el = document.getElementById(id);
          if (el) el.addEventListener(event, handler);
        };
        on("sidePanelCollapseBtn", "click", () => sidePanelSetCollapsed(true));
        on("railExpandBtn", "click", () => sidePanelSetCollapsed(false));
        on("sideRefreshBtn", "click", sideRefreshModels);
        on("railRefreshBtn", "click", sideRefreshModels);
        on("sideDbToggle", "change", () => {
          const toggle = document.getElementById("sideDbToggle");
          if (toggle) sideDbSetEnabled(toggle.checked);
        });
        on("railDbBtn", "click", () => {
          const railBtn = document.getElementById("railDbBtn");
          if (railBtn) sideDbSetEnabled(!railBtn.classList.contains("on"));
        });
        on("sideHistoryBtn", "click", () => toggleHistory());
        on("railHistoryBtn", "click", () => toggleHistory());
        on("sideSettingsBtn", "click", () => toggleSettings());
        on("railSettingsBtn", "click", () => toggleSettings());
        on("sideMcpBtn", "click", () => toggleMcp());
        on("railMcpBtn", "click", () => toggleMcp());
        on("sideNotesBtn", "click", () => toggleNotes());
        on("railNotesBtn", "click", () => toggleNotes());
        on("sidePiThinkSelect", "change", () => {
          const sel = document.getElementById("sidePiThinkSelect");
          if (!sel || !sel.value) return;
          callPiCommand({ type: "set_thinking_level", level: sel.value })
            .then(() => refreshPiStatus().catch(() => {}))
            .catch(() => {});
        });
        if (typeof syncCustomSelect === "function") {
          syncCustomSelect(document.getElementById("sidePiThinkSelect"));
        }
        // Keep the side panel in sync with the Database tab checkbox.
        on("librarySearchEnabledInput", "change", updateSidePanelDb);
        sidePanelSetCollapsed(
          localStorage.getItem(SIDE_PANEL_COLLAPSED_KEY) === "true",
        );
        refreshSidePanel();
      }

      async function deleteAllHistory() {
        const modeLabel =
          MODE_DEFS.find((def) => def.id === mode)?.label || mode;
        if (
          !(await appConfirm(`Delete all ${modeLabel} history?`, "History", {
            confirmLabel: "Delete",
            danger: true,
          }))
        ) {
          return;
        }
        const res = await fetch(
          apiUrl("/api/conversations/mode/" + encodeURIComponent(mode)),
          {
            method: "DELETE",
          },
        );
        await readJsonResponse(res, "Delete history");
        loadHistoryPanel();
        refreshSidePanelRecent();
      }

      // ---- SESSION EXPORT (MARKDOWN) ----
      // The whole conversation on screen, written to a .md file: every turn,
      // its attachments, the model's reasoning, the tools it ran and the
      // library passages it was given. An export that quietly dropped any of
      // that would be worse than none.

      // Filename-safe stem from the conversation's opening line.
      function slugifyForFilename(text) {
        return String(text || "")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 48);
      }

      function exportTimestamp(date) {
        const pad = (n) => String(n).padStart(2, "0");
        return (
          `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
          `-${pad(date.getHours())}${pad(date.getMinutes())}`
        );
      }

      // Markdown blockquote: reasoning and passages keep their own line breaks
      // without their markdown bleeding into the surrounding document. `indent`
      // keeps a quote inside the numbered list item it belongs to.
      function markdownBlockquote(text, indent = "") {
        return String(text || "")
          .replace(/\r\n/g, "\n")
          .split("\n")
          .map((line) => (line.trim() ? `${indent}> ${line}` : `${indent}>`))
          .join("\n");
      }

      // Attachment URLs are server paths; absolute ones still resolve when the
      // exported file is opened in another editor while Dive is running.
      function absoluteAttachmentUrl(url) {
        if (!url) return "";
        if (/^[a-z]+:/i.test(url)) return url;
        return `${window.location.origin}${apiUrl(url)}`;
      }

      // Every message currently on screen, including a reply still streaming.
      function getSessionExportHistory() {
        const session = getActiveModeSession(mode);
        const messages = Array.isArray(history) ? [...history] : [];
        const draft = session.draftAssistant;
        if (draft && messages[messages.length - 1] !== draft) {
          messages.push(draft);
        }
        return messages;
      }

      function buildSessionMarkdown() {
        const messages = getSessionExportHistory();
        if (!messages.length) return "";
        const firstUser = messages.find(
          (m) => m && m.role === "user" && m.content,
        );
        const title =
          (firstUser ? String(firstUser.content).split("\n")[0].trim() : "") ||
          "Dive conversation";
        const now = new Date();
        const lines = [`# ${title}`, ""];
        lines.push(`- **Mode:** ${mode}`);
        // The picker's own label: the model name for Ollama and local modes,
        // "provider · model" for Cloud, the Pi model for Pi.
        const modelName = (
          modelSelect?.selectedOptions?.[0]?.textContent || ""
        ).trim();
        if (modelName && !modelName.startsWith("("))
          lines.push(`- **Model:** ${modelName}`);
        if (currentConvId) lines.push(`- **Conversation:** ${currentConvId}`);
        lines.push(`- **Exported:** ${now.toLocaleString()}`);
        lines.push("");

        messages.forEach((msg) => {
          if (!msg || (msg.role !== "user" && msg.role !== "assistant")) return;
          lines.push("---", "");
          lines.push(msg.role === "user" ? "## You" : "## Assistant", "");
          const images = Array.isArray(msg.images) ? msg.images : [];
          for (const img of images) {
            const name = img?.name || "attached image";
            const url = absoluteAttachmentUrl(img?.url);
            // Inline images (never stored) would embed megabytes of base64 —
            // record that they were attached instead.
            lines.push(
              url ? `![${name}](${url})` : `*(attached image: ${name})*`,
              "",
            );
          }
          const content = String(msg.content || "").trim();
          if (content) lines.push(content, "");
          if (msg.role !== "assistant") return;

          const metadata = getAssistantMetadataFromMessage(msg);
          if (metadata.thinking && metadata.thinking.trim()) {
            lines.push("**Reasoning**", "");
            lines.push(markdownBlockquote(metadata.thinking.trim()), "");
          }
          if (metadata.traceLines && metadata.traceLines.length) {
            lines.push("**Trace**", "");
            metadata.traceLines.forEach((line) => lines.push(`- ${line}`));
            lines.push("");
          }
          const sources = getMessageLibrarySources(msg);
          if (sources.length) {
            lines.push("**Sources**", "");
            sources.forEach((source, index) => {
              const label = source.author
                ? `${source.title} — ${source.author}`
                : source.title;
              lines.push(`${index + 1}. ${label}`);
              if (source.path) lines.push(`   - Path: \`${source.path}\``);
              if (source.url) lines.push(`   - URL: ${source.url}`);
              const passages = Array.isArray(source.passages)
                ? source.passages
                : [];
              passages.forEach((passage) => {
                const heading = passage?.heading
                  ? ` (${passage.heading})`
                  : "";
                const text = String(passage?.text || "").trim();
                if (!text) return;
                lines.push("");
                lines.push(`   Passage${heading}:`);
                lines.push("");
                lines.push(markdownBlockquote(text, "   "));
              });
              lines.push("");
            });
          }
        });
        // No blank-line squeezing: a reply's own spacing (code blocks
        // especially) has to survive the export byte for byte.
        return lines.join("\n").trim() + "\n";
      }

      // Hands the file to the browser, which drops it in the download folder
      // (Downloads unless the user changed it) without a round trip.
      function downloadSessionMarkdown() {
        const markdown = buildSessionMarkdown();
        if (!markdown) return;
        const messages = getSessionExportHistory();
        const firstUser = messages.find(
          (m) => m && m.role === "user" && m.content,
        );
        const stem =
          slugifyForFilename(firstUser ? firstUser.content : "") || "session";
        const filename = `dive-${stem}-${exportTimestamp(new Date())}.md`;
        const blob = new Blob([markdown], {
          type: "text/markdown;charset=utf-8",
        });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        link.rel = "noopener";
        document.body.appendChild(link);
        link.click();
        link.remove();
        // Revoke late: Chromium reads the blob after the click returns.
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      }

      // Nothing on screen means nothing to export.
      function updateDownloadButtonState() {
        const btn = document.getElementById("downloadBtn");
        if (!btn) return;
        btn.disabled = !getSessionExportHistory().length;
      }

      // Remove every attachment for the current mode.
      function clearPendingFiles() {
        pendingFiles = [];
        pendingFilesByMode[mode] = pendingFiles;
        renderPendingFileChips();
      }

      // Remove a single attachment (by index) for the current mode.
      function removePendingFile(idx) {
        pendingFiles.splice(idx, 1);
        pendingFilesByMode[mode] = pendingFiles;
        renderPendingFileChips();
      }

      // Rebuild the attachment pills from the current mode's `pendingFiles`.
      // One bordered pill per file, each with its own remove (x).
      function renderPendingFileChips() {
        const fileChip = document.getElementById("fileChip");
        if (!fileChip) return;
        fileChip.textContent = "";
        pendingFiles.forEach((att, idx) => {
          const pill = document.createElement("span");
          pill.className = "file-pill";
          const label = document.createElement("span");
          label.className = "file-pill-label";
          label.textContent = "↑ " + att.name;
          const remove = document.createElement("button");
          remove.type = "button";
          remove.className = "file-pill-x";
          remove.setAttribute("aria-label", "Remove " + att.name);
          remove.title = "Remove " + att.name;
          remove.textContent = "×";
          remove.addEventListener("click", () => removePendingFile(idx));
          pill.appendChild(label);
          pill.appendChild(remove);
          fileChip.appendChild(pill);
        });
        // An upload in progress gets its own pill: without it a dropped file
        // is invisible until it finishes, and the window looks like nothing
        // happened.
        if (pendingUploads > 0) {
          const pill = document.createElement("span");
          pill.className = "file-pill";
          const label = document.createElement("span");
          label.className = "file-pill-label";
          label.textContent = "↑ Uploading…";
          pill.appendChild(label);
          fileChip.appendChild(pill);
        }
        fileChip.classList.toggle(
          "show",
          pendingFiles.length > 0 || pendingUploads > 0,
        );
        fileInput.value = "";
      }

      // Upload a batch of files (from the picker or a drag-and-drop) and turn
      // each one into a pending attachment.
      async function ingestFiles(fileList) {
        const files = Array.from(fileList || []);
        if (!files.length) return;
        // The attachment belongs to the mode it was dropped into, even if the
        // user switches mode while the upload is still running.
        const targetMode = mode;
        pendingUploads += 1;
        renderPendingFileChips();
        const run = (async () => {
          for (const file of files) {
            const targetFiles = pendingFilesByMode[targetMode] || pendingFiles;
            if (targetFiles.length >= MAX_ATTACHMENTS) {
              alert(`You can attach at most ${MAX_ATTACHMENTS} files.`);
              break;
            }
            const form = new FormData();
            form.append("file", file);
            try {
              const res = await fetch(apiUrl("/api/upload"), {
                method: "POST",
                body: form,
              });
              const data = await readJsonResponse(res, "Upload file");
              const att =
                data.kind === "image"
                  ? {
                      name: file.name,
                      kind: "image",
                      imageBase64: data.dataBase64,
                      mimeType: data.mimeType,
                      // Server-side copy of the image: what the chat bubble
                      // renders and what history keeps, so the attachment
                      // outlives this page load.
                      url: data.url || "",
                    }
                  : { name: file.name, kind: "text", text: data.text };
              targetFiles.push(att);
              pendingFilesByMode[targetMode] = targetFiles;
              if (targetMode === mode) pendingFiles = targetFiles;
            } catch (e) {
              alert(`Upload failed for ${file.name}: ${e.message}`);
            }
          }
        })().finally(() => {
          pendingUploads -= 1;
          renderPendingFileChips();
        });
        // sendMessage awaits this, so a file dropped and sent in the same
        // breath is still part of the turn.
        pendingUploadsDone = pendingUploadsDone.then(
          () => run,
          () => run,
        );
        await run;
      }

      fileInput.addEventListener("change", async () => {
        const files = Array.from(fileInput.files || []);
        // Clear the native input up front so re-selecting the same file (or
        // clicking attach again) still fires change, and files accumulate.
        fileInput.value = "";
        await ingestFiles(files);
      });

      // Drag-and-drop: dropping files anywhere over the window attaches them.
      // dragenter/dragleave fire once per child element, so the overlay is
      // driven by a depth counter — toggling on each event would make it
      // flicker as the pointer crosses child nodes.
      (function setupFileDrop() {
        let depth = 0;
        const show = (on) =>
          document.getElementById("dropOverlay")?.classList.toggle("show", on);
        // React only to real files, never to text/element drags inside the UI.
        const hasFiles = (e) =>
          Array.from(e.dataTransfer?.types || []).includes("Files");
        window.addEventListener("dragenter", (e) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          depth += 1;
          show(true);
        });
        window.addEventListener("dragover", (e) => {
          if (!hasFiles(e)) return;
          // Without preventDefault the browser navigates to the dropped file.
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        });
        window.addEventListener("dragleave", (e) => {
          if (!hasFiles(e)) return;
          depth = Math.max(0, depth - 1);
          if (!depth) show(false);
        });
        window.addEventListener("drop", async (e) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          depth = 0;
          show(false);
          await ingestFiles(e.dataTransfer.files);
        });
      })();

      // MESSAGES AND RENDERING
      function normalizeLibrarySourceResults(results) {
        const normalized = [];
        const bySource = new Map();
        for (const result of Array.isArray(results) ? results : []) {
          if (!result || typeof result !== "object") continue;
          const pathValue = String(result.path || "").trim();
          const titleValue = String(result.title || "").trim();
          const authorValue = String(result.author || "").trim();
          const urlValue = String(result.url || "").trim();
          const key = pathValue || urlValue || `${titleValue}|${authorValue}`;
          if (!key) continue;
          if (!bySource.has(key)) {
            bySource.set(key, {
              title: titleValue || basenameFromPath(pathValue) || "Untitled",
              author: authorValue,
              path: pathValue,
              url: urlValue,
              heading: String(result.heading || "").trim(),
              passages: [],
              passageKeys: new Set(),
            });
          }
          const source = bySource.get(key);
          const heading = String(result.heading || "").trim();
          const text = String(result.text || "").trim();
          const chunkId =
            result.chunkId === null || result.chunkId === undefined
              ? ""
              : String(result.chunkId);
          if (heading && !source.heading) source.heading = heading;
          const passageItems = [
            ...(Array.isArray(result.passages) ? result.passages : []),
            { chunkId, heading, text },
          ];
          passageItems.forEach((passage) => {
            const passageHeading = String(passage?.heading || "").trim();
            const passageText = String(passage?.text || "").trim();
            const passageChunkId =
              passage?.chunkId === null || passage?.chunkId === undefined
                ? ""
                : String(passage.chunkId);
            if (!passageHeading && !passageText) return;
            const passageKey = `${passageChunkId}|${passageHeading}|${passageText}`;
            if (!source.passageKeys.has(passageKey)) {
              source.passageKeys.add(passageKey);
              source.passages.push({
                chunkId: passageChunkId,
                heading: passageHeading,
                text: passageText,
              });
            }
          });
        }
        for (const source of bySource.values()) {
          delete source.passageKeys;
          normalized.push(source);
        }
        return normalized;
      }

      function mergeLibraryResultsWithPassages(results, passages) {
        return normalizeLibrarySourceResults([
          ...(Array.isArray(results) ? results : []),
          ...(Array.isArray(passages) ? passages : []),
        ]);
      }

      function readLibrarySourcesFromMessage(div) {
        if (!div?.dataset?.librarySources) return [];
        try {
          return normalizeLibrarySourceResults(
            JSON.parse(div.dataset.librarySources),
          );
        } catch (_error) {
          return [];
        }
      }

      function getMessageLibrarySources(message) {
        if (!message || typeof message !== "object") return [];
        return mergeLibraryResultsWithPassages(
          message.librarySources || message.libraryResults || message.sources,
          message.passages,
        );
      }

      function formatSourcePassagesForClipboard(source) {
        const passages = Array.isArray(source?.passages) ? source.passages : [];
        const lines = [
          "BOOK PATH:",
          source?.path || "(path unavailable)",
          "",
          "PASSAGES:",
        ];
        if (!passages.length) {
          lines.push("(No passage text was stored for this source.)");
          return lines.join("\n");
        }
        passages.forEach((passage, index) => {
          lines.push("");
          lines.push(`PASSAGE ${index + 1}`);
          if (passage.heading) {
            lines.push(`Heading: ${passage.heading}`);
          }
          if (passage.text) {
            lines.push("");
            lines.push(String(passage.text).trim());
          }
        });
        return lines.join("\n");
      }

      function buildAssistantHistoryMessage(
        content,
        librarySources,
        metadata = {},
      ) {
        const message = { role: "assistant", content: content || "" };
        const normalized = normalizeLibrarySourceResults(librarySources);
        if (normalized.length) message.librarySources = normalized;
        if (typeof metadata.thinking === "string" && metadata.thinking.trim()) {
          message.thinking = metadata.thinking;
        }
        if (Array.isArray(metadata.traceLines) && metadata.traceLines.length) {
          message.traceLines = metadata.traceLines;
        }
        if (
          Array.isArray(metadata.traceEvents) &&
          metadata.traceEvents.length
        ) {
          message.traceEvents = metadata.traceEvents;
        }
        if (Array.isArray(metadata.passages) && metadata.passages.length) {
          message.passages = metadata.passages;
        }
        if (typeof metadata.status === "string" && metadata.status.trim()) {
          message.status = metadata.status.trim();
        }
        return message;
      }

      function cloneAssistantMetadata(metadata = {}) {
        return {
          thinking:
            typeof metadata.thinking === "string" ? metadata.thinking : "",
          traceLines: Array.isArray(metadata.traceLines)
            ? [...metadata.traceLines]
            : [],
          traceEvents: Array.isArray(metadata.traceEvents)
            ? metadata.traceEvents.map((evt) =>
                evt && typeof evt === "object" ? { ...evt } : evt,
              )
            : [],
          passages: Array.isArray(metadata.passages)
            ? metadata.passages.map((p) =>
                p && typeof p === "object" ? { ...p } : p,
              )
            : [],
          status:
            typeof metadata.status === "string" ? metadata.status : "streaming",
        };
      }

      // Pi's setStatus is a keyed, replaceable status line that extensions
      // re-emit unchanged every turn (e.g. the sandbox banner). Conversations
      // saved before deduplication carry those repeats in their stored trace
      // lines — collapse them at the read boundary: a "Status · key:" line
      // is kept only when its text differs from that key's previous line.
      function dedupeStatusTraceLines(lines) {
        const lastByKey = new Map();
        return lines.filter((line) => {
          const m = /^Status · ([^:]*): ([\s\S]*)$/.exec(String(line || ""));
          if (!m) return true;
          if (lastByKey.get(m[1]) === m[2]) return false;
          lastByKey.set(m[1], m[2]);
          return true;
        });
      }

      function getAssistantMetadataFromMessage(message) {
        if (!message || typeof message !== "object") {
          return cloneAssistantMetadata();
        }
        const traceEvents = Array.isArray(message.traceEvents)
          ? message.traceEvents
          : [];
        const derivedTraceLines = dedupeStatusTraceLines(
          Array.isArray(message.traceLines) && message.traceLines.length
            ? message.traceLines
            : traceEvents
                .map((evt) => formatStreamEventTraceLine(evt))
                .filter(Boolean),
        );
        return cloneAssistantMetadata({
          thinking:
            typeof message.thinking === "string" ? message.thinking : "",
          traceLines: derivedTraceLines,
          traceEvents,
          passages: Array.isArray(message.passages) ? message.passages : [],
          status: typeof message.status === "string" ? message.status : "done",
        });
      }

      function getActiveModeSession(modeName = mode) {
        if (!modeSession[modeName]) modeSession[modeName] = createModeSession();
        return modeSession[modeName];
      }

      function getActiveAbortController(modeName = mode) {
        return getActiveModeSession(modeName).activeAbortController || null;
      }

      function renderLibrarySources(div, sources) {
        div.querySelector(".library-sources-container")?.remove();
        const normalized = normalizeLibrarySourceResults(sources);
        if (!normalized.length) return;

        const container = document.createElement("div");
        container.className = "library-sources-container";

        const label = document.createElement("div");
        label.className = "sources-label";
        label.textContent = "SOURCES";
        container.appendChild(label);

        const hasWeb = normalized.some((s) => s.url);
        label.textContent = hasWeb ? "WEB SOURCES" : "SOURCES";

        const list = document.createElement("div");
        list.className = "sources-list";
        normalized.forEach((source, index) => {
          const button = document.createElement("button");
          button.type = "button";
          if (source.url) {
            // Web source: a clickable pill that opens the page in the browser.
            button.className = "source-pill web-source-pill";
            let domain = "";
            try {
              domain = new URL(source.url).hostname.replace(/^www\./, "");
            } catch {
              domain = "";
            }
            const labelText = domain
              ? `${source.title} · ${domain}`
              : source.title;
            button.innerHTML =
              `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>` +
              `<span>${index + 1}. ${escapeHTML(labelText)}</span>`;
            button.title = `Open ${source.url}`;
            button.addEventListener("click", () => {
              window.open(source.url, "_blank", "noopener,noreferrer");
            });
          } else {
            // Library (database) source: copies the retrieved passages.
            button.className = "source-pill library-source-pill";
            const author = source.author ? ` - ${source.author}` : "";
            button.textContent = `${index + 1}. ${source.title}${author}`;
            button.title = "Copy source path and retrieved passages";
            button.addEventListener("click", async () => {
              if (!navigator.clipboard?.writeText) return;
              await navigator.clipboard.writeText(
                formatSourcePassagesForClipboard(source),
              );
              const prior = button.textContent;
              button.textContent = "COPIED PASSAGES";
              setTimeout(() => {
                button.textContent = prior;
              }, 1200);
            });
          }
          list.appendChild(button);
        });
        container.appendChild(list);
        div.appendChild(container);
      }

      // Remove every form of skill-call syntax so a raw <call:...> can NEVER be
      // shown in a bubble, in ANY mode or render path. This is the single choke
      // point that guarantees the drum — not the call — is what the user sees.
      function stripSkillCallsForDisplay(text) {
        return (
          String(text || "")
            // Completed call block: <call:name>args</call>
            .replace(/<call:[^>]*>[\s\S]*?<\/call>/gi, "")
            // Malformed call: opener plus a JSON argument object, no closing tag.
            .replace(/<call:[^>]*>\s*\{[^{}]*\}/gi, "")
            // A dangling opener (with or without '>') left at the very end.
            .replace(/<call:[^>]*>?\s*$/i, "")
            // A bare partial "<".."<call" fragment at the very end (mid-stream).
            // The lone "<" case matters: stream chunks can split right after
            // the opening bracket of "<call:", and it must show the drum too.
            .replace(/<(?:c(?:a(?:l(?:l)?)?)?)?$/i, "")
        );
      }

      // Sources are shown as pills, so any "Source:/References:" citation line or
      // trailing citation the model still writes must be removed from the bubble.
      function stripSourceCitations(text) {
        return String(text || "")
          .replace(
            /^[ \t]*(?:\*\*|__)?(?:sources?|references?|fuentes?|referencias?)(?:\*\*|__)?[ \t]*:?[ \t]*(?:\[[^\]]*\]\([^)]*\)|https?:\/\/\S+)[ \t]*\.?[ \t]*$/gim,
            "",
          )
          .replace(
            /\s*(?:sources?|references?|fuentes?|referencias?)[ \t]*:?[ \t]*(?:\[[^\]]*\]\([^)]*\)|https?:\/\/\S+)\s*\.?\s*$/i,
            "",
          )
          .replace(/\n{3,}/g, "\n\n")
          .replace(/\s+$/, "");
      }

      function renderAssistantMessage(div, text, librarySources) {
        if (!div) return;
        const cleanText = stripSourceCitations(stripSkillCallsForDisplay(text));
        div.dataset.rawText = cleanText;
        if (Array.isArray(librarySources)) {
          div.dataset.librarySources = JSON.stringify(
            normalizeLibrarySourceResults(librarySources),
          );
        }
        const sourceResults = readLibrarySourcesFromMessage(div);

        let finalText = cleanText;

        if (typeof marked !== "undefined" && typeof DOMPurify !== "undefined") {
          div.innerHTML = DOMPurify.sanitize(marked.parse(finalText));
          forceLinksToNewTab(div);
          renderLibrarySources(div, sourceResults);

          // Add copy buttons to code blocks
          div.querySelectorAll("pre").forEach((pre) => {
            pre.style.position = "relative";

            const btn = document.createElement("button");
            btn.textContent = "COPY";
            btn.style.position = "absolute";
            btn.style.top = "5px";
            btn.style.right = "5px";
            btn.style.padding = "3px 6px";
            btn.style.fontSize = "calc(9px * var(--font-scale, 1))";
            btn.style.background = "var(--bg-secondary)";
            btn.style.color = "var(--text-normal)";
            btn.style.border = "var(--border-width) solid var(--border-color)";
            btn.style.cursor = "pointer";
            btn.style.fontFamily = "inherit";
            btn.style.fontWeight = "bold";
            btn.style.opacity = "0.7";
            btn.style.transition = "opacity 0.1s";

            btn.onmouseover = () => (btn.style.opacity = "1.0");
            btn.onmouseout = () => (btn.style.opacity = "0.7");

            btn.onclick = (e) => {
              e.stopPropagation();
              const codeText =
                pre.querySelector("code")?.textContent || pre.textContent;
              navigator.clipboard.writeText(codeText);
              btn.textContent = "COPIED";
              setTimeout(() => (btn.textContent = "COPY"), 1500);
            };
            pre.appendChild(btn);
          });
        } else {
          div.textContent = finalText;
          renderLibrarySources(div, sourceResults);
        }
      }

      // An assistant bubble is "empty" when it carries no rendered text and no
      // drum — the exact `<div class="msg assistant" data-raw-text="">` husk
      // that a cancelled, failed, or tool-only turn would otherwise leave in
      // the DOM. Remove its whole wrap so the view never shows blank bubbles.
      function assistantBubbleIsEmpty(div) {
        if (!div) return false;
        if ((div.dataset.rawText || "").trim()) return false;
        if (div.querySelector(".lucide-drum")) return false;
        if ((div.textContent || "").trim()) return false;
        return true;
      }

      function removeAssistantBubbleIfEmpty(div) {
        if (!assistantBubbleIsEmpty(div)) return false;
        const wrap = div.closest(".msg-wrap") || div;
        if (wrap && wrap.parentElement) wrap.remove();
        return true;
      }

      function addMessage(text, role, options = {}) {
        const wrap = document.createElement("div");
        wrap.className = "msg-wrap " + role;
        const div = document.createElement("div");
        div.className = "msg " + role;
        div.dataset.rawText = text || "";

        if (role === "assistant") {
          renderAssistantMessage(div, text, options.librarySources);
        } else {
          // Attached images render as thumbnails above the text, so the bubble
          // shows what was actually sent instead of just a filename.
          const imgs = Array.isArray(options.images) ? options.images : [];
          if (imgs.length) {
            const gallery = document.createElement("div");
            gallery.className = "msg-images";
            for (const img of imgs) {
              if (!img) continue;
              // Stored attachments come back as a URL into the attachments
              // store; a freshly attached one may only have its bytes yet.
              const src = img.url
                ? apiUrl(img.url)
                : img.dataBase64 && img.mimeType
                  ? `data:${img.mimeType};base64,${img.dataBase64}`
                  : "";
              if (!src) continue;
              const el = document.createElement("img");
              el.className = "msg-image";
              el.src = src;
              el.alt = img.name || "attached image";
              if (img.name) el.title = img.name;
              gallery.appendChild(el);
            }
            if (gallery.children.length) div.appendChild(gallery);
          }
          // Keep the text in its own node so the images sit above it; .msg's
          // pre-wrap is inherited, so raw user text still keeps its newlines.
          if (text) {
            const textEl = document.createElement("div");
            textEl.textContent = text;
            div.appendChild(textEl);
          }
        }

        wrap.appendChild(div);

        // Actions block for both user and assistant
        const actions = document.createElement("div");
        actions.className = "msg-actions";

        const copyBtn = document.createElement("button");
        copyBtn.textContent = "COPY";
        copyBtn.onclick = () => {
          navigator.clipboard.writeText(div.dataset.rawText || text || "");
          copyBtn.textContent = "COPIED";
          setTimeout(() => (copyBtn.textContent = "COPY"), 1500);
        };
        actions.appendChild(copyBtn);

        if (role === "assistant") {
          const regenBtn = document.createElement("button");
          regenBtn.textContent = "REGEN";
          regenBtn.onclick = () => regenerate(wrap);
          actions.appendChild(regenBtn);
        }

        wrap.appendChild(actions);
        chat.appendChild(wrap);
        scrollChatToBottom();
        // Every bubble goes through here, so this covers sending, loading a
        // conversation and switching mode.
        updateDownloadButtonState();
        return div;
      }

      function stripMarkdownHeadingMarkers(value) {
        return String(value || "")
          .replace(/^\s*#{1,6}\s+/, "")
          .replace(/^\s*>+\s*/, "")
          .trim();
      }

      function isThinkingExpandedByDefault(modeName) {
        if (modeName === "pi") return !!piSettings.streamThinkingExpanded;
        return !!thinkingExpandedByMode[modeName];
      }

      function addThinking(initialSnapshot = {}) {
        const wrap = document.createElement("div");
        wrap.className = "thinking-wrap";

        const plain = document.createElement("div");
        plain.className = "thinking loading";
        plain.textContent = "Working...";
        // Live substate shown next to the elapsed clock so the user always
        // sees WHAT the system is doing, never a static opaque spinner
        // (issue 1.7): "Waiting for response", "Running <tool>", "Retrying",
        // "Compacting", etc.
        let currentPhase = "Working";

        const details = document.createElement("details");
        details.className = "thinking-details";
        details.style.display = "none";

        const summary = document.createElement("summary");
        summary.textContent = "Thinking...";

        const body = document.createElement("div");
        body.className = "thinking-details-body thinking-markdown";

        details.appendChild(summary);
        details.appendChild(body);
        wrap.appendChild(plain);
        wrap.appendChild(details);

        const debugDetails = document.createElement("details");
        debugDetails.className = "thinking-details";
        debugDetails.style.display = "none";
        debugDetails.open = false;
        const debugSummary = document.createElement("summary");
        debugSummary.textContent = "Execution Trace";
        const debugBody = document.createElement("div");
        debugBody.className = "thinking-details-body execution-trace-body";
        debugBody.style.maxHeight = "220px";
        debugBody.style.overflow = "auto";
        debugBody.style.fontSize = "calc(11px * var(--font-scale, 1))";
        debugDetails.appendChild(debugSummary);
        debugDetails.appendChild(debugBody);

        const passagesDetails = document.createElement("details");
        passagesDetails.className = "thinking-details";
        passagesDetails.style.display = "none";
        passagesDetails.open = false;
        const passagesSummary = document.createElement("summary");
        passagesSummary.textContent = "Passages";
        const passagesBody = document.createElement("div");
        passagesBody.className = "thinking-details-body";
        passagesBody.style.maxHeight = "300px";
        passagesBody.style.overflow = "auto";
        passagesBody.style.fontSize = "calc(12px * var(--font-scale, 1))";
        passagesDetails.appendChild(passagesSummary);
        passagesDetails.appendChild(passagesBody);

        // Live extension widgets (e.g. the pi-subagents fleet view): the same
        // line-based progress display the terminal shows, updating in place.
        // When a widget is cleared its final state stays visible but muted,
        // so finished background work never just vanishes.
        const widgetsBox = document.createElement("div");
        widgetsBox.className = "pi-widgets";
        widgetsBox.style.display = "none";
        const liveWidgets = new Map();

        // Agent step timeline: one visible row per tool call, above the
        // thinking stream. Hidden until the first tool runs.
        const timeline = document.createElement("div");
        timeline.className = "agent-timeline";
        timeline.style.display = "none";
        const timelineTitle = document.createElement("div");
        timelineTitle.className = "agent-timeline-title";
        timelineTitle.textContent = "STEPS";
        timeline.appendChild(timelineTitle);
        const timelineSteps = [];
        // Full argument text (up to the server's 300-char event preview); the
        // row clamps visually via CSS and the tooltip carries everything.
        const timelineArgsSummary = (argsPreview) => {
          if (!argsPreview) return "";
          try {
            const parsed = JSON.parse(argsPreview);
            if (parsed && typeof parsed === "object") {
              const firstString = Object.values(parsed).find(
                (v) => typeof v === "string" && v.trim(),
              );
              if (typeof firstString === "string") {
                return firstString;
              }
              const firstArray = Object.values(parsed).find(
                (v) => Array.isArray(v) && v.length,
              );
              if (firstArray) {
                return firstArray.map(String).join(", ");
              }
            }
          } catch (_e) {
            // Not JSON (e.g. a shell command): show the raw preview.
          }
          return String(argsPreview);
        };

        wrap.appendChild(timeline);
        wrap.appendChild(widgetsBox);
        wrap.appendChild(plain);
        wrap.appendChild(details);
        wrap.appendChild(debugDetails);
        wrap.appendChild(passagesDetails);
        chat.appendChild(wrap);
        scrollChatToBottom();

        // Live elapsed counter on the thinking indicator. Ticks only for a live
        // run (initialSnapshot.live); history replays stay static. startedAt is
        // carried across mode switches so the counter continues from the real
        // run start instead of restarting when the transcript is re-rendered.
        const startedAt = Number(initialSnapshot.startedAt) || Date.now();
        let timerInterval = null;
        let lastFailureReason = "";
        const renderElapsed = () => {
          const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
          const elapsed =
            s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
          if (plain.style.display !== "none") {
            plain.textContent = `${currentPhase}... ${elapsed}`;
          }
          summary.textContent = `Thinking... (${elapsed})`;
        };
        if (initialSnapshot.live === true) {
          renderElapsed();
          timerInterval = window.setInterval(renderElapsed, 1000);
        }

        let reasoningText =
          typeof initialSnapshot.thinking === "string"
            ? initialSnapshot.thinking
            : "";
        let traceLines = Array.isArray(initialSnapshot.traceLines)
          ? [...initialSnapshot.traceLines]
          : [];
        let traceEvents = Array.isArray(initialSnapshot.traceEvents)
          ? [...initialSnapshot.traceEvents]
          : [];
        let currentPassages = Array.isArray(initialSnapshot.passages)
          ? [...initialSnapshot.passages]
          : [];
        let hasReasoning = Boolean(reasoningText);
        let traceCount = traceLines.length;
        let hasFailure =
          initialSnapshot.status === "error" ||
          traceLines.some((line) => /^Failure:/i.test(String(line || "")));

        // A text delta can fire the "empty bubble" removal a tick before a
        // reasoning delta arrives (common with cloud reasoning models, whose
        // answer and reasoning tokens interleave). If that happens the wrap is
        // detached; re-attach it so reasoning still renders and EXPANDS rather
        // than vanishing (issue 1.1).
        const ownerMode = initialSnapshot.modeName || mode;
        const ownerConvId = initialSnapshot.convId || currentConvId;
        const isActiveView = () =>
          mode === ownerMode &&
          (!ownerConvId || currentConvId === ownerConvId);

        const ensureAttached = () => {
          if (!isActiveView()) return false;
          if (!wrap.isConnected) {
            chat.appendChild(wrap);
          }
          return true;
        };
        const controller = {
          addReasoningChunk(chunk) {
            if (!chunk) return;
            const canRender = ensureAttached();
            if (!hasReasoning) {
              hasReasoning = true;
              if (canRender) {
                plain.style.display = "none";
                details.style.display = "block";
                details.open = isThinkingExpandedByDefault(ownerMode);
              }
            }
            reasoningText += chunk;
            if (canRender) {
              body.innerHTML = DOMPurify.sanitize(marked.parse(reasoningText));
              scrollChatToBottom();
            }
          },
          setPassages(passagesArray) {
            if (!Array.isArray(passagesArray) || passagesArray.length === 0)
              return;
            currentPassages = [...passagesArray];
            if (!isActiveView()) return;
            passagesDetails.style.display = "block";
            passagesBody.innerHTML = "";
            passagesArray.forEach((passage, idx) => {
              const entry = document.createElement("div");
              entry.style.marginBottom = "12px";
              entry.style.paddingBottom = "12px";
              entry.style.borderBottom = "none";

              const titleEl = document.createElement("div");
              titleEl.style.fontWeight = "bold";
              titleEl.style.marginBottom = "4px";
              titleEl.textContent =
                stripMarkdownHeadingMarkers(passage.title) +
                (passage.author ? ` by ${passage.author}` : "");
              entry.appendChild(titleEl);

              if (passage.heading) {
                const headingEl = document.createElement("div");
                headingEl.style.fontStyle = "italic";
                headingEl.style.marginBottom = "4px";
                headingEl.textContent = stripMarkdownHeadingMarkers(
                  passage.heading,
                );
                entry.appendChild(headingEl);
              }

              const textEl = document.createElement("div");
              textEl.className = "thinking-markdown";
              textEl.style.marginTop = "4px";
              if (
                typeof marked !== "undefined" &&
                typeof DOMPurify !== "undefined"
              ) {
                textEl.innerHTML = DOMPurify.sanitize(
                  marked.parse(passage.text || ""),
                );
              } else {
                textEl.style.whiteSpace = "pre-wrap";
                textEl.textContent = passage.text || "";
              }
              entry.appendChild(textEl);

              passagesBody.appendChild(entry);
            });
            scrollChatToBottom();
          },
          setPhase(label) {
            if (!label) return;
            currentPhase = String(label);
            if (!isActiveView()) return;
            if (plain.style.display !== "none") {
              const s = Math.max(
                0,
                Math.floor((Date.now() - startedAt) / 1000),
              );
              const elapsed =
                s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
              plain.textContent = `${currentPhase}... ${elapsed}`;
            }
          },
          addTraceLine(line, opts = {}) {
            if (!line) return;
            const canRender = ensureAttached();
            traceCount += 1;
            if (opts.failure) hasFailure = true;
            traceLines.push(String(line));
            if (!canRender) return;
            debugDetails.style.display = "block";
            debugSummary.textContent = hasFailure
              ? `Execution Trace (${traceCount}, failed)`
              : `Execution Trace (${traceCount})`;
            if (opts.failure) {
              debugSummary.style.color = "#ff6b6b";
            }
            debugBody.innerHTML = DOMPurify.sanitize(
              marked.parse(traceLines.join("\n\n")),
            );
            debugBody.scrollTop = debugBody.scrollHeight;
            scrollChatToBottom();
          },
          addEvent(evt) {
            if (!evt || typeof evt !== "object") return;
            // Streaming micro-events are never stored: the thinking text is
            // captured separately and replay only reads tool/widget events.
            if (
              evt.type === "heartbeat" ||
              evt.type === "delta" ||
              evt.type === "done" ||
              evt.type === "session_start" ||
              evt.type === "thinking_start" ||
              evt.type === "thinking_delta" ||
              evt.type === "thinking_end"
            ) {
              return;
            }
            // Widget frames repaint in place — keep only the latest frame per
            // widget in the snapshot, mirroring the server-side storage. The
            // clear frame (lines: null) is not stored so the final state of
            // finished background work survives in history.
            if (evt.type === "pi_widget") {
              if (!Array.isArray(evt.lines) || !evt.lines.length) return;
              for (let i = traceEvents.length - 1; i >= 0; i--) {
                if (
                  traceEvents[i].type === "pi_widget" &&
                  traceEvents[i].key === evt.key
                ) {
                  traceEvents.splice(i, 1);
                }
              }
            }
            // Drop bulky accumulator fields — only the per-event payload is
            // needed for replay.
            const copy = { ...evt };
            delete copy.thinking;
            delete copy.response;
            delete copy.sessionId;
            traceEvents.push(copy);
          },
          setLiveWidget(key, lines) {
            if (!isActiveView()) return;
            if (Array.isArray(lines) && lines.length) {
              let box = liveWidgets.get(key);
              if (!box) {
                // Each widget is a collapsed-by-default disclosure (native
                // chevron via <summary>, same pattern as Thinking / Execution
                // Trace): the status line stays visible and updates in place,
                // the full output expands on demand. The open state belongs
                // to the user — frames never force it.
                box = document.createElement("details");
                box.className = "thinking-details pi-widget-details";
                const summaryEl = document.createElement("summary");
                const bodyEl = document.createElement("div");
                bodyEl.className = "pi-widget-block";
                box.appendChild(summaryEl);
                box.appendChild(bodyEl);
                liveWidgets.set(key, box);
                widgetsBox.appendChild(box);
              }
              box.classList.remove("finished");
              // First line is the widget's status line — it becomes the
              // always-visible summary; the rest is the expandable body.
              const summaryText = String(lines[0] || key);
              const bodyLines = lines.slice(1);
              box.querySelector("summary").textContent = summaryText;
              // Subagent output is Markdown — render it, don't dump the source.
              box.querySelector(".pi-widget-block").innerHTML =
                DOMPurify.sanitize(marked.parse(bodyLines.join("\n")));
              widgetsBox.style.display = "block";
              scrollChatToBottom();
            } else {
              // Cleared: keep the final state visible but muted instead of
              // erasing what the background agents just did.
              const box = liveWidgets.get(key);
              if (box) box.classList.add("finished");
            }
          },
          finishLiveWidgets() {
            for (const pre of liveWidgets.values()) {
              pre.classList.add("finished");
            }
          },
          addTimelineStep(toolName, argsPreview) {
            timeline.style.display = "flex";
            const row = document.createElement("div");
            row.className = "agent-timeline-step pending";
            const num = document.createElement("span");
            num.className = "agent-timeline-num";
            num.textContent = `${timelineSteps.length + 1}.`;
            const label = document.createElement("span");
            label.className = "agent-timeline-label";
            const argsSummary = timelineArgsSummary(argsPreview);
            label.textContent = argsSummary
              ? `${toolName} — ${argsSummary}`
              : toolName;
            label.title = label.textContent;
            const status = document.createElement("span");
            status.className = "agent-timeline-status";
            status.textContent = "…";
            row.append(num, label, status);
            timeline.appendChild(row);
            timelineSteps.push({ row, status, toolName, done: false });
            scrollChatToBottom();
          },
          completeTimelineStep(toolName, isError) {
            const step =
              timelineSteps.find((s) => !s.done && s.toolName === toolName) ||
              timelineSteps.find((s) => !s.done);
            if (!step) return;
            step.done = true;
            step.row.classList.remove("pending");
            step.row.classList.add(isError ? "fail" : "ok");
            step.status.textContent = isError ? "✗" : "✓";
          },
          finalizeTimeline() {
            for (const step of timelineSteps) {
              if (step.done) continue;
              step.done = true;
              step.row.classList.remove("pending");
              step.row.classList.add("stopped");
              step.status.textContent = "⏹";
            }
          },
          stopTimer() {
            if (timerInterval) {
              clearInterval(timerInterval);
              timerInterval = null;
            }
          },
          markFailure(reason) {
            if (!reason) return;
            // The stream error event and the caller's catch block both
            // report the same failure — record it once.
            if (reason === lastFailureReason) return;
            lastFailureReason = reason;
            this.addTraceLine(`Failure: ${reason}`, { failure: true });
            // Don't leave a frozen "Working…" label on a dead run.
            this.stopTimer();
            if (plain.isConnected && plain.style.display !== "none") {
              plain.classList.remove("loading");
              plain.textContent = "Failed — see Execution Trace";
            }
          },
          getSnapshot() {
            return cloneAssistantMetadata({
              thinking: reasoningText,
              traceLines,
              traceEvents,
              passages: currentPassages,
              status: hasFailure ? "error" : "streaming",
            });
          },
          remove() {
            this.stopTimer();
            if (wrap.parentElement) wrap.remove();
          },
          get isConnected() {
            return !!wrap.isConnected;
          },
          get hadReasoning() {
            return hasReasoning;
          },
          get hadTrace() {
            return traceLines.length > 0 || liveWidgets.size > 0;
          },
          get hadPassages() {
            return currentPassages.length > 0;
          },
        };
        // Replay persisted tool events into the timeline AND the per-tool
        // progress panels (history and aborted runs re-render from their
        // traceEvents snapshot). The panels must be rebuilt with the exact
        // frames the live stream painted, or every tool's output block
        // vanishes from the transcript on mode switch / history load.
        if (traceEvents.length) {
          for (const evt of traceEvents) {
            if (evt.type === "tool_start") {
              controller.addTimelineStep(
                evt.toolName || "tool",
                evt.argsPreview || "",
              );
              controller.setLiveWidget(
                toolWidgetKey(evt),
                toolWidgetStartLines(evt),
              );
            } else if (evt.type === "tool_update") {
              controller.setLiveWidget(
                toolWidgetKey(evt),
                toolWidgetUpdateLines(evt),
              );
            } else if (evt.type === "tool_end") {
              controller.completeTimelineStep(
                evt.toolName || "tool",
                evt.isError === true,
              );
              controller.setLiveWidget(
                toolWidgetKey(evt),
                toolWidgetEndLines(evt),
              );
              controller.setLiveWidget(toolWidgetKey(evt), null);
            } else if (evt.type === "pi_widget" && Array.isArray(evt.lines)) {
              controller.setLiveWidget(evt.key || "widget", evt.lines);
            }
          }
          controller.finalizeTimeline();
          if (initialSnapshot.live !== true) {
            controller.finishLiveWidgets();
          }
        }
        if (hasReasoning) {
          plain.style.display = "none";
          details.style.display = "block";
          details.open = isThinkingExpandedByDefault(ownerMode);
          body.innerHTML = DOMPurify.sanitize(marked.parse(reasoningText));
        }
        if (traceLines.length > 0) {
          debugDetails.style.display = "block";
          debugSummary.textContent = hasFailure
            ? `Execution Trace (${traceLines.length}, failed)`
            : `Execution Trace (${traceLines.length})`;
          if (hasFailure) {
            debugSummary.style.color = "#ff6b6b";
          }
          debugBody.innerHTML = DOMPurify.sanitize(
              marked.parse(traceLines.join("\n\n")),
            );
          debugBody.scrollTop = debugBody.scrollHeight;
        }
        if (currentPassages.length > 0) {
          controller.setPassages(currentPassages);
        }
        return controller;
      }

      function assistantMetadataHasContent(metadata = {}) {
        return Boolean(
          (typeof metadata.thinking === "string" && metadata.thinking.trim()) ||
          (Array.isArray(metadata.traceLines) && metadata.traceLines.length) ||
          (Array.isArray(metadata.traceEvents) &&
            metadata.traceEvents.length) ||
          (Array.isArray(metadata.passages) && metadata.passages.length),
        );
      }

      function renderAssistantHistoryMessage(
        message,
        session = null,
        liveOptions = {},
      ) {
        const metadata = getAssistantMetadataFromMessage(message);
        if (assistantMetadataHasContent(metadata)) {
          const thinking = addThinking({
            ...metadata,
            live: liveOptions.live === true,
            startedAt: liveOptions.startedAt,
            modeName: liveOptions.modeName || mode,
            convId: liveOptions.convId || session?.convId || currentConvId,
          });
          if (session) session.thinkingController = thinking;
        }
        const div = addMessage(message.content || "", "assistant", {
          librarySources: getMessageLibrarySources(message),
        });
        if (session) session.streamingAssistantDiv = div;
        return div;
      }

      function renderSessionTranscript(session) {
        if (!session) return;
        const activeThinkingSnapshot =
          session.thinkingController?.getSnapshot?.() || null;
        // Stop the outgoing controller's elapsed-timer interval before the DOM
        // is wiped, otherwise it keeps firing against detached nodes on every
        // mode switch (a fresh controller is created below).
        session.thinkingController?.stopTimer?.();
        chat.innerHTML = "";
        updateDownloadButtonState();
        session.streamingAssistantDiv = null;
        session.thinkingController = null;
        const sessionHistory = Array.isArray(session.history)
          ? session.history
          : [];
        sessionHistory.forEach((msg) => {
          if (msg.role === "user") {
            // Attachments are part of the turn: re-render their thumbnails.
            addMessage(msg.content, "user", { images: msg.images });
          } else if (msg.role === "assistant") {
            renderAssistantHistoryMessage(msg);
          }
        });
        if (session.draftAssistant) {
          if (activeThinkingSnapshot) {
            const metadata = getAssistantMetadataFromMessage(
              session.draftAssistant,
            );
            session.draftAssistant = buildAssistantHistoryMessage(
              session.draftAssistant.content || "",
              getMessageLibrarySources(session.draftAssistant),
              {
                thinking:
                  activeThinkingSnapshot.thinking || metadata.thinking || "",
                traceLines: activeThinkingSnapshot.traceLines?.length
                  ? activeThinkingSnapshot.traceLines
                  : metadata.traceLines,
                traceEvents: activeThinkingSnapshot.traceEvents?.length
                  ? activeThinkingSnapshot.traceEvents
                  : metadata.traceEvents,
                passages: activeThinkingSnapshot.passages?.length
                  ? activeThinkingSnapshot.passages
                  : metadata.passages,
                status: activeThinkingSnapshot.status || metadata.status,
              },
            );
          }
          renderAssistantHistoryMessage(session.draftAssistant, session, {
            live: !!session.activeAbortController,
            startedAt: session.thinkingStartedAt,
            modeName: mode,
            convId: session.convId || currentConvId,
          });
        }

        // Restore active session state (thinking controller and tool drum)
        if (session.activeAbortController) {
          if (!session.thinkingController) {
            session.thinkingController = addThinking({
              ...(activeThinkingSnapshot || {}),
              live: true,
              startedAt: session.thinkingStartedAt,
              modeName: mode,
              convId: session.convId || currentConvId,
            });
          }
          if (session.drumPending) {
            appendDrumIcon(session.streamingAssistantDiv);
          }
        }
      }

      function syncCurrentSessionState() {
        if (!modeSession[mode]) return;
        const session = getActiveModeSession(mode);
        // An active run owns its session. When the user is viewing a
        // DIFFERENT conversation of this mode (detached view), leaving the
        // mode must not rebind the run's session to the viewed conversation
        // — the streaming reply would leak into it. Keep only the composer
        // draft; returning to this mode snaps back to the streaming
        // conversation (setMode restores currentConvId from session.convId).
        if (session.activeAbortController && session.convId !== currentConvId) {
          session.draft = input.value;
          return;
        }
        session.convId = currentConvId;
        session.history = [...history];
        session.draft = input.value;
        session.lastUserMessage = lastUserMessage;
        session.lastSentMessage = lastSentMessage;
        session.lastExchangePersisted = lastExchangePersisted;
      }

      // The animated drum shown while a mode is streaming a tool/skill call.
      const DRUM_ICON_HTML = `<div style="display:flex; justify-content:flex-start; align-items:center; opacity:0.6; padding-top: 5px; color: var(--accent);"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-drum-icon lucide-drum" style="animation: pulse 1.5s infinite;"><path d="m2 2 8 8"/><path d="m22 2-8 8"/><ellipse cx="12" cy="9" rx="10" ry="5"/><path d="M7 13.4v7.9"/><path d="M12 14v8"/><path d="M17 13.4v7.9"/><path d="M2 9v8a10 5 0 0 0 20 0V9"/></svg></div>`;
      function appendDrumIcon(div) {
        if (div && !div.querySelector(".lucide-drum")) {
          div.insertAdjacentHTML("beforeend", DRUM_ICON_HTML);
        }
      }
      function removeDrumIcon(div) {
        if (!div) return;
        div.querySelector(".lucide-drum")?.parentElement?.remove();
      }

      // Drive the tool-execution drum from explicit tool_start/tool_end trace
      // events. This makes it reliable for native (OpenAI-schema) tool calls
      // too, which carry no "<call:" text for the display-strip heuristic to
      // catch. drumPending is stored on the session so it is restored when the
      // mode's transcript is re-rendered (see renderSessionTranscript).
      function setToolExecutingDrum(session, executing, isActive) {
        if (!session) return;
        session.drumPending = executing;
        if (!isActive) return;
        if (executing) {
          if (
            !session.streamingAssistantDiv ||
            !session.streamingAssistantDiv.isConnected
          ) {
            session.streamingAssistantDiv = addMessage("", "assistant");
          }
          appendDrumIcon(session.streamingAssistantDiv);
          scrollChatToBottom();
        } else {
          removeDrumIcon(session.streamingAssistantDiv);
          // A tool ran but produced no visible assistant text — don't leave the
          // now-drumless empty bubble sitting in the DOM.
          if (removeAssistantBubbleIfEmpty(session.streamingAssistantDiv)) {
            session.streamingAssistantDiv = null;
          }
        }
      }

      function setDraftAssistant(modeName, content, librarySources, metadata) {
        const session = getActiveModeSession(modeName);
        // Hide any skill call (partial, complete, or malformed) from the visible
        // bubble and surface the animated drum instead. Applied here so every
        // mode (ollama, pi, cloud, lmstudio, llamacpp) behaves identically.
        const raw = content || "";
        const text = stripSkillCallsForDisplay(raw);
        const showDrumIcon = text !== raw;
        const existingMetadata = getAssistantMetadataFromMessage(
          session.draftAssistant,
        );
        const nextMetadata =
          metadata ||
          session.thinkingController?.getSnapshot?.() ||
          existingMetadata;
        if (
          (!Array.isArray(nextMetadata.passages) ||
            nextMetadata.passages.length === 0) &&
          Array.isArray(existingMetadata.passages) &&
          existingMetadata.passages.length
        ) {
          nextMetadata.passages = existingMetadata.passages;
        }
        session.draftAssistant = buildAssistantHistoryMessage(
          text,
          librarySources || [],
          nextMetadata,
        );
        // Remember whether a tool/skill call is mid-flight so the drum can be
        // restored when this mode's transcript is re-rendered (e.g. after the
        // user switches modes and comes back while it is still calling tools).
        session.drumPending = showDrumIcon;

        if (mode !== modeName || currentConvId !== session.convId) return;
        if (
          !session.streamingAssistantDiv ||
          !session.streamingAssistantDiv.isConnected
        ) {
          if (text.trim() || (librarySources || []).length) {
            session.streamingAssistantDiv = addMessage("", "assistant");
          }
        }
        if (session.streamingAssistantDiv) {
          renderAssistantMessage(
            session.streamingAssistantDiv,
            text,
            librarySources || [],
          );
          if (showDrumIcon) {
            appendDrumIcon(session.streamingAssistantDiv);
          }
          scrollChatToBottom();
        }
      }

      function finalizeDraftAssistant(modeName, content, librarySources) {
        const session = getActiveModeSession(modeName);
        const existingMetadata = getAssistantMetadataFromMessage(
          session.draftAssistant,
        );
        const metadata =
          session.thinkingController?.getSnapshot?.() || existingMetadata;
        if (
          (!Array.isArray(metadata.passages) ||
            metadata.passages.length === 0) &&
          Array.isArray(existingMetadata.passages) &&
          existingMetadata.passages.length
        ) {
          metadata.passages = existingMetadata.passages;
        }
        metadata.status = "done";
        const assistantMessage = buildAssistantHistoryMessage(
          content || "",
          librarySources || [],
          metadata,
        );
        // A finalized turn has no tool executing, so strip any stale drum
        // first — otherwise it would keep an otherwise-empty bubble alive.
        removeDrumIcon(session.streamingAssistantDiv);
        // Never leave a blank assistant husk behind: a turn that ended with no
        // text (aborted before output, tool-only, failed) must purge its DOM
        // node rather than persist an empty bubble (issue 2.2).
        removeAssistantBubbleIfEmpty(session.streamingAssistantDiv);
        session.draftAssistant = null;
        session.streamingAssistantDiv = null;
        session.thinkingController = null;
        session.drumPending = false;
        return assistantMessage;
      }

      // Guarantee a clean slate before a new user turn creates its bubble.
      // Any leftover draft/streaming node from a cancelled turn or a background
      // Pi-channel continuation is committed to history (if it has content) or
      // purged (if empty), then the streaming refs are nulled. After this, the
      // next stream is forced to mount a brand-new, uniquely mapped assistant
      // node — it can never reuse or write into a pre-existing container.
      function beginIsolatedTurn(session, modeName) {
        if (!session) return;
        const activeMode = modeName || mode;
        // Fold any live background Pi continuation into history first.
        if (typeof finalizePiChannelRun === "function") {
          try {
            finalizePiChannelRun();
          } catch (_e) {}
        }
        if (session.draftAssistant || session.streamingAssistantDiv) {
          const leftoverText = session.draftAssistant?.content || "";
          const committed = finalizeDraftAssistant(activeMode, leftoverText, []);
          if (committed.content && committed.content.trim()) {
            session.history = [...session.history, committed];
            if (currentConvId === session.convId) {
              history = [...session.history];
            }
          }
        }
        // Defensive: finalizeDraftAssistant already nulls these, but ensure no
        // stale node survives even if no draft existed.
        if (removeAssistantBubbleIfEmpty(session.streamingAssistantDiv)) {
          session.streamingAssistantDiv = null;
        }
        session.draftAssistant = null;
        session.streamingAssistantDiv = null;
      }

      function clearModeSession(modeName) {
        modeSession[modeName] = createModeSession();
      }

      chat.addEventListener("click", (e) => {
        const anchor = e.target.closest("a[href]");
        if (!anchor || !chat.contains(anchor)) return;
        e.preventDefault();
        window.open(anchor.href, "_blank", "noopener,noreferrer");
      });

      function clampInteger(value, fallback, min, max) {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed)) return fallback;
        return Math.min(max, Math.max(min, parsed));
      }

      function stepNumberInput(input, direction) {
        if (!input) return;
        const step = Number.parseFloat(input.step || "1");
        const min = Number.parseFloat(input.min);
        const max = Number.parseFloat(input.max);
        const current = Number.parseFloat(input.value || "0");
        const safeStep = Number.isFinite(step) && step > 0 ? step : 1;
        const base = Number.isFinite(current) ? current : 0;
        let next = direction === "down" ? base - safeStep : base + safeStep;
        if (Number.isFinite(min) && next < min) next = min;
        if (Number.isFinite(max) && next > max) next = max;
        const stepText = String(input.step || "1");
        const decimalMatch = stepText.match(/\.(\d+)/);
        const precision = decimalMatch ? decimalMatch[1].length : 0;
        const normalized = Number(next.toFixed(precision));
        input.value = String(normalized);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }

      function normalizeCloudSettings(raw) {
        const source =
          raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
        const provider =
          source.provider === "anthropic" ||
          source.provider === "mistral" ||
          source.provider === "google"
            ? source.provider
            : "openai";
        return {
          provider,
          models: {
            ...CLOUD_DEFAULT_MODELS,
            ...(source.models && typeof source.models === "object"
              ? source.models
              : {}),
          },
          baseUrls: {
            ...CLOUD_DEFAULT_BASE_URLS,
            ...(source.baseUrls && typeof source.baseUrls === "object"
              ? source.baseUrls
              : {}),
          },
          maxTokens: clampInteger(source.maxTokens, 2048, 1, 128000),
          agentMode: source.agentMode === true,
          agentMaxRounds: clampInteger(source.agentMaxRounds, 25, 1, 50),
          hasApiKey: {
            openai: !!source.hasApiKey?.openai,
            anthropic: !!source.hasApiKey?.anthropic,
            mistral: !!source.hasApiKey?.mistral,
            google: !!source.hasApiKey?.google,
          },
          envKeyNames: {
            openai: source.envKeyNames?.openai || "OPENAI_API_KEY",
            anthropic: source.envKeyNames?.anthropic || "ANTHROPIC_API_KEY",
            mistral: source.envKeyNames?.mistral || "MISTRAL_API_KEY",
            google: source.envKeyNames?.google || "GEMINI_API_KEY",
          },
        };
      }

      function renderCloudSettingsForm() {
        const provider = cloudSettings.provider || "openai";
        const providerSelect = document.getElementById("cloudProviderSelect");
        const apiKeyInput = document.getElementById("cloudApiKeyInput");
        const modelInput = document.getElementById("cloudModelInput");
        const baseUrlInput = document.getElementById("cloudBaseUrlInput");
        const maxTokensInput = document.getElementById("cloudMaxTokensInput");
        const keyStatus = document.getElementById("cloudApiKeyStatus");
        if (
          !providerSelect ||
          !apiKeyInput ||
          !modelInput ||
          !baseUrlInput ||
          !maxTokensInput
        ) {
          return;
        }
        providerSelect.value = provider;
        apiKeyInput.value = "";
        apiKeyInput.placeholder = cloudSettings.hasApiKey?.[provider]
          ? "Saved key is active. Leave blank to keep it."
          : `Paste ${getCloudProviderLabel(provider)} API key`;
        modelInput.value =
          cloudSettings.models?.[provider] || CLOUD_DEFAULT_MODELS[provider];
        baseUrlInput.value =
          cloudSettings.baseUrls?.[provider] ||
          CLOUD_DEFAULT_BASE_URLS[provider];
        maxTokensInput.value = Number(cloudSettings.maxTokens) || 2048;
        const agentModeInput = document.getElementById("cloudAgentModeInput");
        if (agentModeInput) {
          agentModeInput.checked = cloudSettings.agentMode === true;
        }
        const agentRoundsInput = document.getElementById(
          "cloudAgentRoundsInput",
        );
        if (agentRoundsInput) {
          agentRoundsInput.value = String(
            Number(cloudSettings.agentMaxRounds) || 25,
          );
        }
        if (keyStatus) {
          const envName =
            cloudSettings.envKeyNames?.[provider] || "provider API key";
          keyStatus.textContent = cloudSettings.hasApiKey?.[provider]
            ? `API key configured for ${getCloudProviderLabel(provider)}.`
            : `No key configured. You can save one here or set ${envName}.`;
        }
        refreshCustomSelectUi(providerSelect);
        updateModeStatus();
      }

      function collectCloudSettingsFromForm(clearApiKey = false) {
        const provider =
          document.getElementById("cloudProviderSelect")?.value || "openai";
        const model = document.getElementById("cloudModelInput")?.value || "";
        const baseUrl =
          document.getElementById("cloudBaseUrlInput")?.value || "";
        const apiKey = document.getElementById("cloudApiKeyInput")?.value || "";
        const maxTokens = clampInteger(
          document.getElementById("cloudMaxTokensInput")?.value,
          2048,
          1,
          128000,
        );
        return {
          provider,
          models: {
            ...cloudSettings.models,
            [provider]: model.trim() || CLOUD_DEFAULT_MODELS[provider],
          },
          baseUrls: {
            ...cloudSettings.baseUrls,
            [provider]: baseUrl.trim() || CLOUD_DEFAULT_BASE_URLS[provider],
          },
          maxTokens,
          agentMode:
            document.getElementById("cloudAgentModeInput")?.checked === true,
          agentMaxRounds: clampInteger(
            document.getElementById("cloudAgentRoundsInput")?.value,
            25,
            1,
            50,
          ),
          apiKeys: apiKey.trim() ? { [provider]: apiKey.trim() } : {},
          clearApiKeys: clearApiKey ? { [provider]: true } : {},
        };
      }

      async function loadCloudSettings() {
        try {
          const res = await fetch(apiUrl("/api/cloud/settings"));
          const payload = await readJsonResponse(res, "Load Cloud settings");
          cloudSettings = normalizeCloudSettings(payload?.settings);
          renderCloudSettingsForm();
        } catch (error) {
          console.error("Could not load Cloud settings", error);
          renderCloudSettingsForm();
        }
      }

      async function saveCloudSettingsUi(clearApiKey = false) {
        try {
          const settings = collectCloudSettingsFromForm(clearApiKey);
          const res = await fetch(apiUrl("/api/cloud/settings"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ settings }),
          });
          const payload = await readJsonResponse(res, "Save Cloud settings");
          cloudSettings = normalizeCloudSettings(payload?.settings);
          renderCloudSettingsForm();
        } catch (error) {
          console.error("Could not save Cloud settings", error);
          await appAlert(
            error.message || "Failed to save Cloud settings.",
            "Cloud",
          );
        }
      }

      function renderPiSettingsForm() {
        const commandInput = document.getElementById("piCommandPathInput");
        const workingDirInput = document.getElementById("piWorkingDirInput");
        const commandDefaultEl = document.getElementById(
          "piCommandPathDefault",
        );
        const workingDirDefaultEl = document.getElementById(
          "piWorkingDirDefault",
        );
        const resolvedCommand = piRuntimeInfo?.resolvedCommand || "pi";
        const resolvedWorkingDirectory =
          piRuntimeInfo?.resolvedWorkingDirectory ||
          piSettings.workingDirectory;
        const defaultWorkingDirectory =
          piRuntimeInfo?.dataDir ||
          piSettings.workingDirectory ||
          "(server default working directory)";

        commandInput.value = piSettings.commandPath || resolvedCommand;
        commandInput.placeholder = `Auto-detect (current: ${resolvedCommand})`;
        commandInput.dataset.defaultResolved = resolvedCommand;
        commandInput.dataset.hasOverride = piSettings.commandPath
          ? "true"
          : "false";
        workingDirInput.value =
          piSettings.workingDirectory ||
          resolvedWorkingDirectory ||
          defaultWorkingDirectory;
        workingDirInput.placeholder = resolvedWorkingDirectory || "";
        if (commandDefaultEl) {
          commandDefaultEl.textContent = `Default (auto-detect): ${resolvedCommand}`;
        }
        if (workingDirDefaultEl) {
          workingDirDefaultEl.textContent = `Default: ${defaultWorkingDirectory}`;
        }
        document.getElementById("piTimeoutMsInput").value =
          Number(piSettings.timeoutMs) || 300000;
        document.getElementById("piServerPortInput").value =
          Number(piSettings.serverPort) || 8080;
        document.getElementById("piTraceLimitInput").value =
          Number(piSettings.toolOutputMaxChars) || 12000;
        document.getElementById("piPermissionPolicySelect").value =
          piSettings.permissionPolicy || "normal";
        document.getElementById("piPermissionAutoOpenInput").checked =
          !!piSettings.permissionUx?.autoOpen;
        document.getElementById("piPermissionDefaultActionSelect").value =
          piSettings.permissionUx?.defaultAction || "deny";
        document.getElementById("piPermissionTimeoutMsInput").value =
          Number(piSettings.permissionUx?.decisionTimeoutMs) || 0;
        document.getElementById("piThinkingExpandedInput").checked =
          !!piSettings.streamThinkingExpanded;
        thinkingExpandedByMode.pi = !!piSettings.streamThinkingExpanded;

        const runtimeSummary = document.getElementById("piRuntimeSummary");
        if (runtimeSummary) {
          if (!piRuntimeInfo) {
            runtimeSummary.textContent = "";
          } else {
            const resolvedCommand =
              piRuntimeInfo.resolvedCommand || "(unknown)";
            const resolvedWorkingDirectory =
              piRuntimeInfo.resolvedWorkingDirectory || "(unknown)";
            const sandboxGlobal = piRuntimeInfo.sandbox?.globalEnabled
              ? "enabled"
              : "disabled";
            const sandboxProject = piRuntimeInfo.sandbox?.projectEnabled
              ? "enabled"
              : "disabled";
            const configuredServerPort =
              Number(piRuntimeInfo.configuredServerPort) || 8080;
            const activeServerPort =
              Number(piRuntimeInfo.activeServerPort) || 8080;
            runtimeSummary.textContent =
              `Server port (configured/active): ${configuredServerPort}/${activeServerPort}\n` +
              `Resolved command: ${resolvedCommand}\n` +
              `Working directory: ${resolvedWorkingDirectory}\n` +
              `Sandbox (global/project): ${sandboxGlobal}/${sandboxProject}`;
          }
        }

        const folderPath = piRuntimeInfo?.projectDir || "";
        document.getElementById("ollamaPiChatFolderPath").textContent =
          folderPath;
      }

      function wireThinkingExpandedSettings() {
        const entries = [
          { id: "ollamaThinkingExpandedInput", mode: "ollama" },
          { id: "cloudThinkingExpandedInput", mode: "cloud" },
          { id: "lmStudioThinkingExpandedInput", mode: "lmstudio" },
          { id: "llamaCppThinkingExpandedInput", mode: "llamacpp" },
        ];
        entries.forEach(({ id, mode }) => {
          const input = document.getElementById(id);
          if (!input) return;
          input.checked = !!thinkingExpandedByMode[mode];
          if (input.dataset.bound === "true") return;
          input.dataset.bound = "true";
          input.addEventListener("change", () => {
            thinkingExpandedByMode[mode] = input.checked;
            localStorage.setItem(
              `ollama-pi-chat-${mode}-thinking-expanded`,
              String(input.checked),
            );
            if (typeof saveUiSettingsSoon === "function") {
              saveUiSettingsSoon();
            }
          });
        });
      }

      function collectPiSettingsFromForm() {
        const commandInput = document.getElementById("piCommandPathInput");
        const timeoutMs = clampInteger(
          document.getElementById("piTimeoutMsInput").value,
          300000,
          15000,
          1800000,
        );
        const traceChars = clampInteger(
          document.getElementById("piTraceLimitInput").value,
          12000,
          1000,
          50000,
        );
        const serverPort = clampInteger(
          document.getElementById("piServerPortInput").value,
          8080,
          1024,
          65535,
        );
        const permissionTimeoutMs = clampInteger(
          document.getElementById("piPermissionTimeoutMsInput").value,
          45000,
          0,
          600000,
        );
        const commandPathValue = commandInput.value.trim();
        const defaultCommandPath = commandInput.dataset.defaultResolved || "";
        const hasCommandOverride = commandInput.dataset.hasOverride === "true";
        const commandPath =
          !hasCommandOverride && commandPathValue === defaultCommandPath
            ? ""
            : commandPathValue;

        return {
          commandPath,
          workingDirectory: document
            .getElementById("piWorkingDirInput")
            .value.trim(),
          serverPort,
          timeoutMs,
          permissionPolicy:
            document.getElementById("piPermissionPolicySelect").value ===
            "strict"
              ? "strict"
              : "normal",
          permissionUx: {
            autoOpen: document.getElementById("piPermissionAutoOpenInput")
              .checked,
            defaultAction:
              document.getElementById("piPermissionDefaultActionSelect")
                .value === "allow"
                ? "allow"
                : "deny",
            decisionTimeoutMs: permissionTimeoutMs,
          },
          toolOutputMaxChars: traceChars,
          streamThinkingExpanded: document.getElementById(
            "piThinkingExpandedInput",
          ).checked,
        };
      }

      function applyPermissionPolicyPreset() {
        const policy = document.getElementById(
          "piPermissionPolicySelect",
        ).value;
        if (policy !== "strict") return;
        document.getElementById("piPermissionDefaultActionSelect").value =
          "deny";
        const timeoutInput = document.getElementById(
          "piPermissionTimeoutMsInput",
        );
        const current = Number.parseInt(timeoutInput.value, 10);
        if (!Number.isFinite(current) || current > 30000) {
          timeoutInput.value = "30000";
        }
      }

      async function resetPiSettingsToDefaults() {
        if (
          !(await appConfirm(
            "Reset all Pi settings to defaults? This will remove custom overrides.",
            "Pi Settings",
            { confirmLabel: "Reset", danger: true },
          ))
        ) {
          return;
        }
        try {
          const resetRes = await fetch(apiUrl("/api/pi/settings/reset"), {
            method: "POST",
          });
          const payload = await readJsonResponse(resetRes, "Reset Pi settings");
          piSettings = payload?.settings || piSettings;
          piRuntimeInfo = payload?.runtime || piRuntimeInfo;
          renderPiSettingsForm();
        } catch (error) {
          console.error("Could not reset Pi settings", error);
          await appAlert(
            error.message || "Failed to reset Pi settings.",
            "Pi Settings",
          );
        }
      }

      async function loadOllamaSkillsConfig() {
        renderBuiltinSkillsList();
        try {
          const res = await fetch(apiUrl("/api/ollama/skills/settings"));
          builtinSkillsConfig = {
            ...DEFAULT_BUILTIN_SKILLS_CONFIG,
            ...(await res.json()),
          };
          renderBuiltinSkillsList();
        } catch (error) {
          console.error("Could not load Ollama skills config", error);
          renderBuiltinSkillsList();
        }
        loadPluginsUi().catch(() => {});
      }

      // ---- PLUGINS (skills / slash commands loaded from ~/dive/plugins) ----
      let loadedPluginsPayload = null;

      function renderPluginsList() {
        const list = document.getElementById("pluginsList");
        const hint = document.getElementById("pluginsDirHint");
        if (!list) return;
        const payload = loadedPluginsPayload;
        if (hint && payload?.directory) {
          hint.textContent = `Directory: ${payload.directory}`;
        }
        const plugins = payload?.plugins || [];
        if (!plugins.length) {
          list.innerHTML =
            '<div class="setting-help">No plugins installed.</div>';
          return;
        }
        const esc = (s) =>
          String(s ?? "").replace(
            /[&<>"']/g,
            (c) =>
              ({
                "&": "&amp;",
                "<": "&lt;",
                ">": "&gt;",
                '"': "&quot;",
                "'": "&#39;",
              })[c],
          );
        let html = "";
        for (const plugin of plugins) {
          const version = plugin.version ? ` v${esc(plugin.version)}` : "";
          const commands = Object.keys(plugin.commands || {})
            .map((c) => `/${c}`)
            .join(" ");
          const commandText = commands ? ` | Commands: ${commands}` : "";
          let skillRows = "";
          for (const skillName of plugin.skills || []) {
            const enabled = builtinSkillsConfig[skillName] !== false;
            skillRows += `
              <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 6px;">
                <span>${esc(humanizeSkillLabel(skillName))}</span>
                <input type="checkbox" class="brutalist-toggle builtin-skill-toggle" data-skill="${esc(skillName)}" ${enabled ? "checked" : ""} >
              </div>`;
          }
          const errorRow = plugin.error
            ? `<div style="font-size: calc(11px * var(--font-scale, 1)); margin-top: 6px; color: var(--error-color, #b33);">Error: ${esc(plugin.error)}</div>`
            : "";
          html += `
            <div style="background: var(--bg-primary); color: var(--text-normal); padding: 8px; border: var(--border-width) solid var(--border-color); margin-bottom: calc(var(--border-width) * -1);">
              <strong>${esc(humanizeSkillLabel(plugin.name))}${version}</strong>
              <div style="font-size: calc(11px * var(--font-scale, 1)); opacity: 0.8; margin-top: 4px;">${esc(plugin.description || "No description.")}${esc(commandText)}</div>
              ${errorRow}
              ${skillRows}
            </div>
          `;
        }
        list.innerHTML = html;
      }

      async function loadPluginsUi() {
        const reloadBtn = document.getElementById("pluginsReloadBtn");
        if (reloadBtn && !reloadBtn.dataset.wired) {
          reloadBtn.dataset.wired = "1";
          reloadBtn.addEventListener("click", () => {
            reloadPlugins().catch(() => {});
          });
        }
        try {
          const res = await fetch(apiUrl("/api/plugins"));
          loadedPluginsPayload = await readJsonResponse(res, "Load plugins");
        } catch (error) {
          console.error("Could not load plugins", error);
          loadedPluginsPayload = null;
        }
        renderPluginsList();
        loadLessonsUi().catch(() => {});
        loadPluginDraftsUi().catch(() => {});
        loadSystemPromptsUi().catch(() => {});
      }

      // ---- EDITABLE SYSTEM PROMPTS (Settings > Prompt) ----
      // The DB-off and DB-on base prompts are editable per mode, mirroring
      // the per-mode Lessons editor. Only the base policy text is editable:
      // the skills/tool instructions are separate, always appended
      // automatically, and never touched by these overrides.
      let systemPromptsLoadToken = 0;
      // The mode whose prompts the textareas are currently showing. Saves
      // always target this mode, never one switched to mid-edit.
      let systemPromptsEditorMode = null;
      // Defaults for the mode currently shown, used by "Restore Default".
      let systemPromptEditorDefaults = { dboff: "", dbon: "" };

      function currentSystemPromptsMode() {
        return PROMPT_MODE_KEYS.includes(mode) ? mode : null;
      }

      // Ollama's real prompt is built client-side: its DB-off default base is
      // the composite's policy preamble, not the server constant.
      function systemPromptDefaultsFor(forMode, payload) {
        if (forMode === "ollama") {
          return { dboff: DB_OFF_POLICY_PREAMBLE, dbon: DB_ON_PROMPT };
        }
        return {
          dboff: payload?.dbOffDefault || "",
          dbon: payload?.dbOnDefault || "",
        };
      }

      // Keeps the runtime cache for Ollama's client-built prompt in sync.
      async function refreshOllamaPromptOverrides() {
        try {
          const res = await fetch(apiUrl("/api/system-prompts?mode=ollama"));
          const payload = await readJsonResponse(res, "Load system prompts");
          ollamaPromptOverrides = {
            dboff: payload?.dbOffOverride || "",
            dbon: payload?.dbOnOverride || "",
          };
        } catch (error) {
          console.error("Could not load Ollama prompt overrides", error);
        }
      }

      async function loadSystemPromptsUi() {
        const group = document.getElementById("systemPromptsGroup");
        const offEl = document.getElementById("systemPromptDbOff");
        const onEl = document.getElementById("systemPromptDbOn");
        if (!offEl || !onEl) return;
        const forMode = currentSystemPromptsMode();
        if (group) group.style.display = forMode ? "" : "none";
        if (!forMode) return;
        wireSystemPromptButtons();
        const token = ++systemPromptsLoadToken;
        try {
          const res = await fetch(
            apiUrl("/api/system-prompts?mode=" + encodeURIComponent(forMode)),
          );
          const payload = await readJsonResponse(res, "Load system prompts");
          // Ignore stale responses if the mode changed mid-flight.
          if (token !== systemPromptsLoadToken) return;
          systemPromptsEditorMode = forMode;
          systemPromptEditorDefaults = systemPromptDefaultsFor(
            forMode,
            payload,
          );
          offEl.value =
            payload?.dbOffOverride || systemPromptEditorDefaults.dboff;
          onEl.value = payload?.dbOnOverride || systemPromptEditorDefaults.dbon;
          if (forMode === "ollama") {
            ollamaPromptOverrides = {
              dboff: payload?.dbOffOverride || "",
              dbon: payload?.dbOnOverride || "",
            };
          }
        } catch (error) {
          console.error("Could not load system prompts", error);
        }
      }

      async function saveSystemPromptOverride(which) {
        const box = document.getElementById(
          which === "dbon" ? "systemPromptDbOn" : "systemPromptDbOff",
        );
        const saveMode = systemPromptsEditorMode || currentSystemPromptsMode();
        if (!box || !saveMode) return;
        const text = box.value.trim();
        const defaultText =
          which === "dbon"
            ? systemPromptEditorDefaults.dbon
            : systemPromptEditorDefaults.dboff;
        // Saving the unchanged default (or an empty box) just clears the
        // override so the built-in text stays the live fallback.
        const isReset = !text || text === defaultText;
        const res = await fetch(apiUrl("/api/system-prompts"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            isReset
              ? { mode: saveMode, which, reset: true }
              : { mode: saveMode, which, text },
          ),
        });
        await readJsonResponse(res, "Save system prompt");
        if (saveMode === "ollama") await refreshOllamaPromptOverrides();
      }

      async function resetSystemPromptOverride(which) {
        const saveMode = systemPromptsEditorMode || currentSystemPromptsMode();
        if (!saveMode) return;
        const res = await fetch(apiUrl("/api/system-prompts"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: saveMode, which, reset: true }),
        });
        await readJsonResponse(res, "Restore system prompt");
        if (saveMode === "ollama") await refreshOllamaPromptOverrides();
        await loadSystemPromptsUi();
      }

      function wireSystemPromptButtons() {
        const wire = (id, handler, savedLabel, normalLabel) => {
          const btn = document.getElementById(id);
          if (!btn || btn.dataset.wired) return;
          btn.dataset.wired = "1";
          btn.addEventListener("click", async () => {
            try {
              await handler();
              btn.textContent = savedLabel;
              setTimeout(() => (btn.textContent = normalLabel), 1200);
            } catch (error) {
              console.error(error);
              await appAlert(
                error.message || "Failed to update system prompt.",
                "System Prompts",
              );
            }
          });
        };
        wire(
          "systemPromptDbOffSaveBtn",
          () => saveSystemPromptOverride("dboff"),
          "SAVED",
          "SAVE",
        );
        wire(
          "systemPromptDbOnSaveBtn",
          () => saveSystemPromptOverride("dbon"),
          "SAVED",
          "SAVE",
        );
        wire(
          "systemPromptDbOffResetBtn",
          () => resetSystemPromptOverride("dboff"),
          "RESTORED",
          "RESTORE DEFAULT",
        );
        wire(
          "systemPromptDbOnResetBtn",
          () => resetSystemPromptOverride("dbon"),
          "RESTORED",
          "RESTORE DEFAULT",
        );
      }

      // ---- LESSONS (persistent instructions injected into system prompts) ----
      // Lessons are STRICTLY per-mode and always bound to the ACTIVE mode:
      // the editor shows, loads and saves only the current mode's file, so
      // one mode's lessons can never leak into another. Pi is excluded — it
      // has its own AGENTS.md context system, so the editor hides entirely.
      let lessonsLoadToken = 0;
      // The mode whose lessons the textarea is currently showing. Saves
      // always target this mode, never one switched to mid-edit.
      let lessonsEditorMode = null;

      const LESSONS_MODE_LABELS = {
        ollama: "OLLAMA",
        lmstudio: "LM STUDIO",
        llamacpp: "LLAMA.CPP",
        cloud: "CLOUD",
      };

      function currentLessonsMode() {
        return Object.prototype.hasOwnProperty.call(LESSONS_MODE_LABELS, mode)
          ? mode
          : null;
      }

      async function fetchLessonsForCurrentMode() {
        const box = document.getElementById("lessonsTextarea");
        const forMode = currentLessonsMode();
        if (!box || !forMode) return;
        const token = ++lessonsLoadToken;
        try {
          const res = await fetch(
            apiUrl("/api/lessons?mode=" + encodeURIComponent(forMode)),
          );
          const payload = await readJsonResponse(res, "Load lessons");
          // Ignore stale responses if the mode changed mid-flight.
          if (token !== lessonsLoadToken) return;
          lessonsEditorMode = forMode;
          box.value = payload?.text || "";
        } catch (error) {
          console.error("Could not load lessons", error);
        }
      }

      async function loadLessonsUi() {
        const group = document.getElementById("lessonsGroup");
        const box = document.getElementById("lessonsTextarea");
        const btn = document.getElementById("lessonsSaveBtn");
        const label = document.getElementById("lessonsLabel");
        if (!box) return;
        const forMode = currentLessonsMode();
        if (group) group.style.display = forMode ? "" : "none";
        if (!forMode) return;
        if (label) {
          label.textContent = `LESSONS — ${LESSONS_MODE_LABELS[forMode]}`;
        }
        if (btn && !btn.dataset.wired) {
          btn.dataset.wired = "1";
          btn.addEventListener("click", async () => {
            const saveMode = lessonsEditorMode || currentLessonsMode();
            if (!saveMode) return;
            try {
              await fetch(apiUrl("/api/lessons"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  text: box.value,
                  mode: saveMode,
                }),
              });
              btn.textContent = "SAVED";
              setTimeout(() => (btn.textContent = "SAVE LESSONS"), 1200);
            } catch (error) {
              console.error("Could not save lessons", error);
              await appAlert(
                error.message || "Failed to save lessons.",
                "Lessons",
              );
            }
          });
        }
        await fetchLessonsForCurrentMode();
      }

      // ---- MODEL-DRAFTED PLUGINS AWAITING APPROVAL ----
      async function loadPluginDraftsUi() {
        const wrap = document.getElementById("pluginDraftsWrap");
        const list = document.getElementById("pluginDraftsList");
        if (!wrap || !list) return;
        let drafts = [];
        try {
          const res = await fetch(apiUrl("/api/plugins/drafts"));
          const payload = await readJsonResponse(res, "Load plugin drafts");
          drafts = payload?.drafts || [];
        } catch (error) {
          console.error("Could not load plugin drafts", error);
        }
        wrap.style.display = drafts.length ? "" : "none";
        list.innerHTML = "";
        for (const draft of drafts) {
          const card = document.createElement("div");
          card.style.cssText =
            "background: var(--bg-primary); color: var(--text-normal); padding: 8px; margin-top: 8px;";
          const title = document.createElement("strong");
          title.textContent = `${draft.name} (drafted ${draft.draftedAt ? new Date(draft.draftedAt).toLocaleString() : "unknown"})`;
          const desc = document.createElement("div");
          desc.style.cssText =
            "font-size: calc(11px * var(--font-scale, 1)); opacity: 0.8; margin-top: 4px;";
          desc.textContent = draft.description || "No description.";
          const code = document.createElement("pre");
          code.style.cssText =
            "max-height: 220px; overflow: auto; margin-top: 6px; padding: 6px; background: var(--bg-secondary); font-size: calc(10px * var(--font-scale, 1)); user-select: text;";
          code.textContent = draft.code || "";
          const row = document.createElement("div");
          row.style.cssText = "display: flex; gap: 6px; margin-top: 6px;";
          const approve = document.createElement("button");
          approve.className = "settings-action-btn";
          approve.textContent = "APPROVE AND ENABLE";
          approve.addEventListener("click", async () => {
            if (
              !(await appConfirm(
                `Approve plugin "${draft.name}"? Its code will run inside Dive with full local access. Only approve code you have read and trust.`,
                "Plugins — approve draft",
                { confirmLabel: "Approve", danger: true },
              ))
            ) {
              return;
            }
            try {
              const res = await fetch(apiUrl("/api/plugins/drafts/approve"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: draft.name }),
              });
              await readJsonResponse(res, "Approve draft");
              await loadPluginsUi();
            } catch (error) {
              await appAlert(
                error.message || "Failed to approve draft.",
                "Plugins",
              );
            }
          });
          const remove = document.createElement("button");
          remove.className = "settings-action-btn";
          remove.textContent = "DELETE";
          remove.addEventListener("click", async () => {
            try {
              const res = await fetch(apiUrl("/api/plugins/drafts/delete"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: draft.name }),
              });
              await readJsonResponse(res, "Delete draft");
              await loadPluginDraftsUi();
            } catch (error) {
              await appAlert(
                error.message || "Failed to delete draft.",
                "Plugins",
              );
            }
          });
          row.appendChild(approve);
          row.appendChild(remove);
          card.appendChild(title);
          card.appendChild(desc);
          card.appendChild(code);
          card.appendChild(row);
          list.appendChild(card);
        }
      }

      async function reloadPlugins() {
        try {
          const res = await fetch(apiUrl("/api/plugins/reload"), {
            method: "POST",
          });
          loadedPluginsPayload = await readJsonResponse(res, "Reload plugins");
          renderPluginsList();
        } catch (error) {
          console.error("Could not reload plugins", error);
          await appAlert(
            error.message || "Failed to reload plugins.",
            "Plugins",
          );
        }
      }

      async function toggleBuiltinSkill(skillName, enabled) {
        builtinSkillsConfig[skillName] = enabled;
        try {
          await fetch(apiUrl("/api/ollama/skills/settings"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(builtinSkillsConfig),
          });
          renderBuiltinSkillsList();
          renderPluginsList();
        } catch (error) {
          console.error("Could not save Ollama skills config", error);
        }
      }

      function renderBuiltinSkillsList() {
        const list = document.getElementById("builtinSkillsList");
        if (!list) return;
        let html = "";
        for (const [skill, info] of Object.entries(ALL_BUILTIN_SKILLS_INFO)) {
          const enabled = builtinSkillsConfig[skill] !== false;
          html += `
            <div style="display: flex; justify-content: space-between; align-items: center; background: var(--bg-primary); color: var(--text-normal); padding: 8px; border: var(--border-width) solid var(--border-color); margin-bottom: calc(var(--border-width) * -1);">
              <div>
                <strong>${humanizeSkillLabel(skill)}</strong>
                <div style="font-size: calc(11px * var(--font-scale, 1)); opacity: 0.8; margin-top: 4px;">${info.desc}</div>
              </div>
              <input type="checkbox" class="brutalist-toggle builtin-skill-toggle" data-skill="${skill}" ${enabled ? "checked" : ""} >
            </div>
          `;
        }
        list.innerHTML = html;
      }

      async function loadPiSettings() {
        try {
          const res = await fetch(apiUrl("/api/pi/settings"));
          const payload = await readJsonResponse(res, "Load Pi settings");
          piSettings = payload?.settings || piSettings;
          piRuntimeInfo = payload?.runtime || null;
          renderPiSettingsForm();
        } catch (error) {
          console.error("Could not load Pi settings", error);
          piRuntimeInfo = {
            resolvedCommand: "pi",
            resolvedWorkingDirectory:
              piSettings.workingDirectory ||
              "(server default working directory)",
            sandbox: { globalEnabled: false, projectEnabled: false },
            projectDir: "",
            dataDir: piSettings.workingDirectory || "",
          };
          renderPiSettingsForm();
        }
      }

      async function savePiSettingsUi() {
        try {
          applyPermissionPolicyPreset();
          const settings = collectPiSettingsFromForm();
          const res = await fetch(apiUrl("/api/pi/settings"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(settings),
          });
          const payload = await readJsonResponse(res, "Save Pi settings");
          piSettings = payload?.settings || settings;
          piRuntimeInfo = payload?.runtime || null;
          renderPiSettingsForm();
        } catch (error) {
          console.error("Could not save Pi settings", error);
          await appAlert(
            error.message || "Failed to save Pi settings.",
            "Pi Settings",
          );
        }
      }

      async function openOllamaPiChatFolder() {
        try {
          const res = await fetch(apiUrl("/api/pi/open-project-folder"), {
            method: "POST",
          });
          await readJsonResponse(res, "Open Dive folder");
        } catch (error) {
          console.error("Could not open Dive folder", error);
          await appAlert(
            error.message || "Failed to open folder.",
            "Pi Settings",
          );
        }
      }

      async function copyOllamaPiChatFolderPath() {
        const folderPath = piRuntimeInfo?.projectDir || "";
        if (!folderPath) return;
        try {
          if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(folderPath);
            return;
          }
          const temp = document.createElement("textarea");
          temp.value = folderPath;
          document.body.appendChild(temp);
          temp.select();
          document.execCommand("copy");
          temp.remove();
        } catch (error) {
          console.error("Copy failed", error);
          await appAlert("Could not copy path to clipboard.", "Pi Settings");
        }
      }

      // SYSTEM PROMPTS MANAGEMENT
      async function loadPrompts() {
        try {
          const res = await fetch(apiUrl("/api/prompts"));
          promptsList = await readJsonResponse(res, "Load prompts");
          renderPromptsList();
          populatePromptSelect();
        } catch (e) {
          console.error("Could not load prompts", e);
        }
      }

      function populatePromptSelect() {
        const select = document.getElementById("settingActivePrompt");
        const topSelect = document.getElementById("topbarPromptSelect");

        if (!select) return;
        const modePrompts = promptsForMode(mode);
        if (
          activePromptId &&
          !modePrompts.some((p) => p.id === activePromptId)
        ) {
          activePromptId = "";
          localStorage.setItem(activePromptStorageKey(mode), "");
        }

        select.textContent = "";
        const defaultOption = document.createElement("option");
        defaultOption.value = "";
        defaultOption.textContent = "Default (Built-in Policy)";
        select.appendChild(defaultOption);

        if (topSelect) {
          topSelect.textContent = "";
          const topDefault = document.createElement("option");
          topDefault.value = "";
          topDefault.textContent = "Prompt: Default";
          topSelect.appendChild(topDefault);
        }

        modePrompts.forEach((p) => {
          const option = document.createElement("option");
          option.value = String(p.id ?? "");
          option.textContent = String(p.name ?? "");
          if (p.id === activePromptId) option.selected = true;
          select.appendChild(option);

          if (topSelect) {
            const topOption = document.createElement("option");
            topOption.value = String(p.id ?? "");
            topOption.textContent = `Prompt: ${String(p.name ?? "")}`;
            if (p.id === activePromptId) topOption.selected = true;
            topSelect.appendChild(topOption);
          }
        });

        if (typeof syncCustomSelect === "function") {
          syncCustomSelect(select);
          if (topSelect) syncCustomSelect(topSelect);
        }
      }

      // Content of the currently selected system prompt overlay, or "" if none.
      // Used by both Ollama and the local modes so the topbar prompt dropdown
      // applies everywhere.
      function getActivePromptContent() {
        const selected = activePromptId
          ? promptsList.find((p) => p.id === activePromptId)
          : null;
        return selected?.content || "";
      }

      // Returns { systemPrompt, messageToSend } when a hard-mode trigger fires,
      // null otherwise. Used by all modes except pi.
      function checkHardModeTriggers(rawMessage) {
        const firefoxMatch = rawMessage.match(FIREFOX_PROOFREAD_TRIGGER);
        if (firefoxMatch) {
          // Newer Firefox wraps the selection in <selection>…</selection>
          // tags inside the quotes — the model must get ONLY the text itself.
          let selected = firefoxMatch[1].trim();
          const tagged = selected.match(/^<selection>([\s\S]*)<\/selection>$/i);
          if (tagged) selected = tagged[1].trim();
          return {
            systemPrompt: PROOFREAD_HARD_MODE_PROMPT,
            messageToSend: selected,
          };
        }
        const proofreadMatch = rawMessage.match(PROOFREAD_TRIGGER);
        if (proofreadMatch) {
          return {
            systemPrompt: PROOFREAD_HARD_MODE_PROMPT,
            messageToSend:
              rawMessage.slice(proofreadMatch[0].length).trim() ||
              rawMessage.trim(),
          };
        }
        const enMatch = rawMessage.match(TRANSLATE_TO_EN_TRIGGER);
        if (enMatch) {
          return {
            systemPrompt: TRANSLATE_TO_EN_HARD_MODE_PROMPT,
            messageToSend:
              rawMessage.slice(enMatch[0].length).trim() || rawMessage.trim(),
          };
        }
        const esMatch = rawMessage.match(TRANSLATE_TO_ES_TRIGGER);
        if (esMatch) {
          return {
            systemPrompt: TRANSLATE_TO_ES_HARD_MODE_PROMPT,
            messageToSend:
              rawMessage.slice(esMatch[0].length).trim() || rawMessage.trim(),
          };
        }
        return null;
      }

      function buildOllamaRequestContext(baseHistory, rawMessage) {
        const conversationHistory = baseHistory.filter(
          (m) => m.role !== "system",
        );
        // The selected custom Prompt REPLACES the base policy text inside
        // getOllamaBasePolicyPrompt (never the tools section, which is
        // appended separately there). No secondary system message anymore.
        const systemMessages = [
          {
            role: "system",
            content: getOllamaBasePolicyPrompt(getActivePromptContent()),
          },
        ];

        const hm = checkHardModeTriggers(rawMessage);
        if (hm) {
          return {
            requestHistory: [{ role: "system", content: hm.systemPrompt }],
            messageToSend: hm.messageToSend,
            persistToHistory: false,
          };
        }

        return {
          requestHistory: [...systemMessages, ...conversationHistory],
          messageToSend: rawMessage,
          persistToHistory: true,
        };
      }

      function renderPromptsList() {
        const list = document.getElementById("customPromptsList");
        list.innerHTML = "";
        const modePrompts = promptsForMode(mode);
        if (!modePrompts.length) {
          list.innerHTML =
            '<div style="font-size: calc(10px * var(--font-scale, 1)); opacity:0.5; text-align:center;">No prompts saved</div>';
          return;
        }
        modePrompts.forEach((p) => {
          const item = document.createElement("div");
          item.className = "prompt-item";

          const name = document.createElement("span");
          name.className = "prompt-item-name";
          name.textContent = p.name;
          name.title = "Edit prompt";
          name.style.cursor = "pointer";
          name.onclick = () => beginEditPrompt(p.id);

          const del = document.createElement("button");
          del.className = "prompt-item-del";
          del.textContent = "×";
          del.title = "Delete prompt";
          del.onclick = () => deletePrompt(p.id);

          item.appendChild(name);
          item.appendChild(del);
          list.appendChild(item);
        });
      }

      function formatStreamEventTraceLine(evt) {
        if (evt.type === "pi_banner") return String(evt.text || "");
        if (!evt || typeof evt !== "object") return "";

        if (evt.type === "library_results") {
          const resultCount = Array.isArray(evt.results)
            ? evt.results.length
            : 0;
          const meta = evt.meta && typeof evt.meta === "object" ? evt.meta : {};
          const retrieved =
            typeof meta.retrievedCount === "number"
              ? meta.retrievedCount
              : resultCount;
          const injected =
            typeof meta.injectedCount === "number"
              ? meta.injectedCount
              : resultCount;
          const uniqueSources =
            typeof meta.uniqueSourceCount === "number"
              ? meta.uniqueSourceCount
              : normalizeLibrarySourceResults(evt.results).length;
          const contextCap =
            typeof meta.maxContextChars === "number"
              ? ` | cap: ${meta.maxContextChars.toLocaleString()} chars`
              : "";
          return `Library search: ${retrieved} retrieved | ${injected} injected | ${uniqueSources} unique source(s)${contextCap}`;
        }

        if (evt.type === "library_error") {
          return `Library search error: ${evt.error || "unknown"}`;
        }

        if (evt.type === "slash_command") {
          return `Command: ${evt.label || evt.command || "slash"}`;
        }

        if (evt.type === "tool_start") {
          const tool = evt.toolName || "tool";
          const args = evt.argsPreview ? ` args=${evt.argsPreview}` : "";
          return `Tool start: ${tool}${args}`;
        }

        if (evt.type === "tool_update") {
          const tool = evt.toolName || "tool";
          const output = evt.outputPreview
            ? ` output=${evt.outputPreview}`
            : "";
          return `Tool update: ${tool}${output}`;
        }

        if (evt.type === "tool_end") {
          const tool = evt.toolName || "tool";
          const suffix = evt.isError ? " (error)" : " (ok)";
          const output = evt.outputPreview
            ? ` output=${evt.outputPreview}`
            : "";
          return `Tool end: ${tool}${suffix}${output}`;
        }

        if (evt.type === "stderr") return `stderr: ${evt.chunk || ""}`;

        if (evt.type === "trace") {
          const label = evt.label || "event";
          const skipLabels = new Set([
            "turn_start",
            "turn_end",
            "message_start",
            "message_end",
            "agent_start",
            "queue_update",
          ]);
          if (skipLabels.has(label)) return "";
          if (label === "agent_end") return "agent finished";
          let detail = "";
          if (evt.detail) {
            try {
              const parsed = JSON.parse(evt.detail);
              if (parsed.toolName) {
                detail = ` ${parsed.toolName}`;
                if (parsed.args)
                  detail += ` ${JSON.stringify(parsed.args).slice(0, 80)}`;
              } else if (parsed.model) {
                detail = ` model=${parsed.model}`;
              } else {
                detail = ` ${evt.detail.slice(0, 120)}`;
              }
            } catch (e) {
              detail = ` ${evt.detail.slice(0, 120)}`;
            }
          }
          return `${label}:${detail}`;
        }

        if (evt.type === "error") {
          return `Failure: ${evt.error || "Unknown error"}`;
        }

        return "";
      }

      // Per-tool progress panel frames. Shared by the live stream handler and
      // the history replay loop so the panels survive re-renders identically.
      function toolWidgetKey(evt) {
        return `tool · ${evt.toolName || "tool"}`;
      }
      function toolWidgetStartLines(evt) {
        const tool = evt.toolName || "tool";
        // No text arrow: the running state is shown by the widget's green
        // glow (see .pi-widget-details CSS), and the disclosure chevron
        // already sits at the start of the summary line.
        return [`${tool} running…`].concat(
          evt.argsPreview ? [evt.argsPreview.slice(0, 300)] : [],
        );
      }
      function toolWidgetUpdateLines(evt) {
        const tool = evt.toolName || "tool";
        const lines = String(evt.outputPreview || "")
          .split("\n")
          .slice(-16);
        return [`${tool} running…`, ""].concat(lines);
      }
      function toolWidgetEndLines(evt) {
        const tool = evt.toolName || "tool";
        const lines = String(evt.outputPreview || "")
          .split("\n")
          .slice(-16);
        return [`${evt.isError ? "✗" : "✓"} ${tool}`, ""].concat(lines);
      }

      function handleStreamEventTrace(evt, thinking) {
        if (!evt || !thinking) return;
        // Keep-alive frames are transport noise — never record or render them.
        if (evt.type === "heartbeat") return;
        // Granular phase telemetry on the working indicator (issue 1.7).
        if (typeof thinking.setPhase === "function") {
          switch (evt.type) {
            case "session_start":
              thinking.setPhase("Starting Pi");
              break;
            case "thinking_start":
              thinking.setPhase("Thinking");
              break;
            case "delta":
            case "thinking_end":
              thinking.setPhase("Writing response");
              break;
            case "tool_start":
              thinking.setPhase(
                `Running ${evt.toolName || evt.name || "tool"}`,
              );
              break;
            case "tool_end":
              thinking.setPhase("Processing result");
              break;
            case "provider_retry":
              thinking.setPhase("Provider error — retrying");
              break;
            case "provider_retry_end":
              thinking.setPhase("Working");
              break;
            case "compaction_start":
              thinking.setPhase("Compacting context");
              break;
            case "compaction_end":
              thinking.setPhase("Working");
              break;
            case "async_pending":
              thinking.setPhase("Waiting on subagents");
              break;
            default:
              break;
          }
        }
        if (typeof thinking.addEvent === "function") {
          thinking.addEvent(evt);
        }

        if (evt.type === "pi_widget") {
          if (typeof thinking.setLiveWidget === "function") {
            thinking.setLiveWidget(evt.key || "widget", evt.lines || null);
          }
          return;
        }

        if (evt.type === "pi_banner") {
          String(evt.text || "")
            .split("\n")
            .filter(Boolean)
            .forEach((line) => thinking.addTraceLine(line));
          return;
        }

        if (evt.type === "pi_status") {
          if (evt.text) {
            // setStatus is a keyed, REPLACEABLE status line in Pi's terminal
            // UI; extensions re-emit it unchanged at every turn/tool boundary
            // (e.g. the sandbox banner). Only append a trace line when the
            // text for that key actually changed.
            const statusKey = evt.key || "status";
            if (!thinking.lastStatusByKey) thinking.lastStatusByKey = {};
            if (thinking.lastStatusByKey[statusKey] !== evt.text) {
              thinking.lastStatusByKey[statusKey] = evt.text;
              thinking.addTraceLine(`Status · ${statusKey}: ${evt.text}`);
            }
          }
          return;
        }

        if (evt.type === "pi_notice") {
          thinking.addTraceLine(`Notice: ${evt.message || ""}`, {
            failure: evt.noticeType === "error",
          });
          return;
        }

        if (evt.type === "pi_usage") {
          const parts = [];
          if (evt.model) parts.push(evt.model);
          if (evt.input) parts.push(`↑${evt.input}`);
          if (evt.output) parts.push(`↓${evt.output}`);
          if (evt.cost) parts.push(`$${Number(evt.cost).toFixed(4)}`);
          if (parts.length) thinking.addTraceLine(`Turn: ${parts.join(" · ")}`);
          return;
        }

        if (evt.type === "async_pending") {
          thinking.addTraceLine(
            "Background subagents still running — Pi will wake with their results. Keeping this turn open…",
          );
          return;
        }

        if (evt.type === "provider_retry") {
          thinking.addTraceLine("Provider error. Pi is retrying...");
          return;
        }

        if (evt.type === "provider_retry_end") {
          if (evt.success) {
            thinking.addTraceLine("Retry successful.");
          } else {
            thinking.addTraceLine("Retry failed.", { failure: true });
          }
          return;
        }

        if (evt.type === "provider_error") {
          thinking.addTraceLine(`Provider error: ${evt.error}`, {
            failure: true,
          });
          return;
        }

        if (evt.type === "compaction_start") {
          const reason = evt.reason || "context_limit";
          thinking.addTraceLine(`Compaction started (reason: ${reason})`);
          return;
        }

        if (evt.type === "compaction_end") {
          const tokens = evt.tokensBefore
            ? ` (tokens before: ${evt.tokensBefore})`
            : "";
          thinking.addTraceLine(`Compaction completed${tokens}`);
          return;
        }

        if (evt.type === "thinking_delta") {
          thinking.addReasoningChunk(evt.delta || "");
          return;
        }

        if (evt.type === "library_results") {
          const resultCount = Array.isArray(evt.results)
            ? evt.results.length
            : 0;
          const meta = evt.meta && typeof evt.meta === "object" ? evt.meta : {};
          const retrieved =
            typeof meta.retrievedCount === "number"
              ? meta.retrievedCount
              : resultCount;
          const injected =
            typeof meta.injectedCount === "number"
              ? meta.injectedCount
              : resultCount;
          const uniqueSources =
            typeof meta.uniqueSourceCount === "number"
              ? meta.uniqueSourceCount
              : normalizeLibrarySourceResults(evt.results).length;
          const contextCap =
            typeof meta.maxContextChars === "number"
              ? ` | cap: ${meta.maxContextChars.toLocaleString()} chars`
              : "";
          thinking.addTraceLine(
            `Library search: ${retrieved} retrieved | ${injected} injected | ${uniqueSources} unique source(s)${contextCap}`,
          );
          if (Array.isArray(evt.passages) && evt.passages.length > 0) {
            if (typeof thinking.setPassages === "function") {
              thinking.setPassages(evt.passages);
            }
          }
          return;
        }

        if (evt.type === "library_error") {
          thinking.addTraceLine(
            `Library search error: ${evt.error || "unknown"}`,
          );
          return;
        }

        if (evt.type === "slash_command") {
          thinking.addTraceLine(
            `Command: ${evt.label || evt.command || "slash"}`,
          );
          return;
        }

        if (evt.type === "tool_start") {
          const tool = evt.toolName || "tool";
          const args = evt.argsPreview ? ` args=${evt.argsPreview}` : "";
          if (typeof thinking.addTimelineStep === "function") {
            thinking.addTimelineStep(tool, evt.argsPreview || "");
          }
          // Open a live progress panel for the running tool — web searches,
          // subagent fleets etc. stream here in place, like the terminal.
          if (typeof thinking.setLiveWidget === "function") {
            thinking.setLiveWidget(toolWidgetKey(evt), toolWidgetStartLines(evt));
          }
          thinking.addTraceLine(`Tool start: ${tool}${args}`);
          return;
        }

        if (evt.type === "tool_update") {
          // Stream the tool's live progress into its panel instead of
          // spamming the execution trace with partial dumps.
          if (typeof thinking.setLiveWidget === "function") {
            thinking.setLiveWidget(
              toolWidgetKey(evt),
              toolWidgetUpdateLines(evt),
            );
          }
          return;
        }

        if (evt.type === "tool_end") {
          const tool = evt.toolName || "tool";
          const suffix = evt.isError ? " (error)" : " (ok)";
          const output = evt.outputPreview
            ? ` output=${evt.outputPreview}`
            : "";
          if (typeof thinking.completeTimelineStep === "function") {
            thinking.completeTimelineStep(tool, evt.isError === true);
          }
          // Freeze the tool's live panel at its final output, muted.
          if (typeof thinking.setLiveWidget === "function") {
            thinking.setLiveWidget(toolWidgetKey(evt), toolWidgetEndLines(evt));
            thinking.setLiveWidget(toolWidgetKey(evt), null);
          }
          thinking.addTraceLine(`Tool end: ${tool}${suffix}${output}`, {
            failure: evt.isError === true,
          });
          return;
        }

        if (evt.type === "stderr") {
          thinking.addTraceLine(`stderr: ${evt.chunk || ""}`);
          return;
        }

        if (evt.type === "trace") {
          const label = evt.label || "event";
          // Filter out low-value structural noise
          const skipLabels = new Set([
            "turn_start",
            "turn_end",
            "message_start",
            "message_end",
            "agent_start",
            "queue_update",
          ]);
          if (skipLabels.has(label)) return;
          // For agent_end, just show a summary line
          if (label === "agent_end") {
            thinking.addTraceLine("agent finished");
            return;
          }
          // For other trace events, try to extract a clean summary
          let detail = "";
          if (evt.detail) {
            try {
              const parsed = JSON.parse(evt.detail);
              // tool execution events - show tool name and key info
              if (parsed.toolName) {
                detail = ` ${parsed.toolName}`;
                if (parsed.args)
                  detail += ` ${JSON.stringify(parsed.args).slice(0, 80)}`;
              } else if (parsed.model) {
                detail = ` model=${parsed.model}`;
              } else {
                detail = ` ${evt.detail.slice(0, 120)}`;
              }
            } catch (e) {
              detail = ` ${evt.detail.slice(0, 120)}`;
            }
          }
          thinking.addTraceLine(`${label}:${detail}`);
          return;
        }

        if (evt.type === "error") {
          if (typeof thinking.finalizeTimeline === "function") {
            thinking.finalizeTimeline();
          }
          if (typeof thinking.stopTimer === "function") thinking.stopTimer();
          thinking.markFailure(evt.error || "Unknown error");
        }

        if (evt.type === "done") {
          // Any step still marked running when the reply completes was
          // interrupted (e.g. budget exhaustion mid-call) — close it out.
          if (typeof thinking.finalizeTimeline === "function") {
            thinking.finalizeTimeline();
          }
          if (typeof thinking.stopTimer === "function") thinking.stopTimer();
        }
      }

      function captureLibrarySources(evt, state, assistantDiv) {
        if (!state) return;
        if (evt?.type === "library_results") {
          state.results = mergeLibraryResultsWithPassages(
            evt.results,
            evt.passages,
          );
          state.passages = Array.isArray(evt.passages) ? evt.passages : [];
        } else if (evt?.type === "web_sources") {
          // Web-search sources flow through the same pill pipeline; each keeps a
          // url so its pill opens the page in the browser instead of copying.
          const incoming = Array.isArray(evt.sources) ? evt.sources : [];
          if (!incoming.length) return;
          state.results = normalizeLibrarySourceResults([
            ...(Array.isArray(state.results) ? state.results : []),
            ...incoming,
          ]);
        } else {
          return;
        }
        if (assistantDiv?.isConnected) {
          renderAssistantMessage(
            assistantDiv,
            assistantDiv.dataset.rawText || "",
            state.results,
          );
        }
      }

      function selectActivePrompt(id) {
        activePromptId = id;
        localStorage.setItem(activePromptStorageKey(mode), id);

        const settingSelect = document.getElementById("settingActivePrompt");
        const topSelect = document.getElementById("topbarPromptSelect");
        if (settingSelect) settingSelect.value = id;
        if (topSelect) topSelect.value = id;
      }

      // "+ NEW PROMPT": open the editor blank, in create mode.
      function openPromptEditor() {
        editingPromptId = null;
        document.getElementById("promptName").value = "";
        document.getElementById("promptContent").value = "";
        document.getElementById("promptEditor").style.display = "flex";
      }

      // Click on a saved prompt's name: open the editor pre-filled with it.
      // Save then updates that entry in place instead of creating a new one.
      function beginEditPrompt(id) {
        const prompt = promptsList.find((p) => p.id === id);
        if (!prompt) return;
        editingPromptId = id;
        document.getElementById("promptName").value = prompt.name;
        document.getElementById("promptContent").value = prompt.content;
        document.getElementById("promptEditor").style.display = "flex";
      }

      function closePromptEditor() {
        editingPromptId = null;
        document.getElementById("promptEditor").style.display = "none";
      }

      function escapeHTML(str) {
        return str.replace(
          /[&<>'"]/g,
          (tag) =>
            ({
              "&": "&amp;",
              "<": "&lt;",
              ">": "&gt;",
              "'": "&#39;",
              '"': "&quot;",
            })[tag] || tag,
        );
      }

      let customSkills = [];

      async function loadCustomSkills() {
        try {
          const res = await fetch(apiUrl("/api/custom-skills"));
          if (res.ok) {
            customSkills = await res.json();
            renderCustomSkillsList();
          }
        } catch (e) {
          console.error("Failed to load custom skills", e);
        }
      }

      function renderCustomSkillsList() {
        const container = document.getElementById("customSkillsList");
        if (!container) return;
        container.innerHTML = "";
        customSkills.forEach((skill, idx) => {
          const div = document.createElement("div");
          div.className = "prompt-item";
          div.innerHTML = `
            <div class="prompt-item-header">
              <span class="prompt-item-name">${escapeHTML(skill.name)} (${skill.type})</span>
              <button class="prompt-item-delete" data-idx="${idx}">×</button>
            </div>
            <div class="prompt-item-content">${escapeHTML(skill.description)}</div>
          `;
          container.appendChild(div);
        });
      }

      function openSkillEditor() {
        document.getElementById("customSkillsEditor").style.display = "flex";
      }

      function closeSkillEditor() {
        document.getElementById("customSkillsEditor").style.display = "none";
        document.getElementById("skillName").value = "";
        document.getElementById("skillDesc").value = "";
        document.getElementById("skillCode").value = "";
      }

      async function saveCustomSkill() {
        const name = document.getElementById("skillName").value.trim();
        const description = document.getElementById("skillDesc").value.trim();
        const type = document.getElementById("skillType").value;
        const code = document.getElementById("skillCode").value.trim();

        if (!name || !description || !code) {
          await appAlert("All fields are required.", "Skills");
          return;
        }

        customSkills.push({ name, description, type, code });
        try {
          const res = await fetch(apiUrl("/api/custom-skills"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(customSkills),
          });
          if (res.ok) {
            closeSkillEditor();
            await loadCustomSkills();
          } else {
            await appAlert("Failed to save custom skill.", "Skills");
          }
        } catch (e) {
          console.error(e);
        }
      }

      async function deleteCustomSkill(idx) {
        if (
          !(await appConfirm("Delete this custom skill?", "Skills", {
            confirmLabel: "Delete",
            danger: true,
          }))
        ) {
          return;
        }
        customSkills.splice(idx, 1);
        try {
          const res = await fetch(apiUrl("/api/custom-skills"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(customSkills),
          });
          if (res.ok) await loadCustomSkills();
        } catch (e) {
          console.error(e);
        }
      }

      async function saveCustomPrompt() {
        const name = document.getElementById("promptName").value.trim();
        const content = document.getElementById("promptContent").value.trim();
        if (!name || !content) return;

        const editing = editingPromptId
          ? promptsList.find((p) => p.id === editingPromptId)
          : null;
        if (editing) {
          // Update in place: same id, same mode, new name/content.
          editing.name = name;
          editing.content = content;
        } else {
          promptsList.push({
            id: "prompt_" + Date.now(),
            name: name,
            content: content,
            // Belongs to the mode it was created in (Ollama / Cloud / LM Studio / llama.cpp).
            mode: PROMPT_MODE_KEYS.includes(mode) ? mode : "ollama",
          });
        }

        try {
          const res = await fetch(apiUrl("/api/prompts"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(promptsList),
          });
          await readJsonResponse(res, "Save prompt");
          document.getElementById("promptName").value = "";
          document.getElementById("promptContent").value = "";
          closePromptEditor();
          await loadPrompts();
        } catch (e) {
          console.error(e);
          await appAlert("Failed to save prompt.", "Prompts");
        }
      }

      async function deletePrompt(id) {
        if (
          !(await appConfirm(
            "Are you sure you want to delete this prompt?",
            "Prompts",
            { confirmLabel: "Delete", danger: true },
          ))
        ) {
          return;
        }
        promptsList = promptsList.filter((p) => p.id !== id);
        if (activePromptId === id) {
          activePromptId = "";
          localStorage.setItem(activePromptStorageKey(mode), "");
        }
        if (editingPromptId === id) closePromptEditor();
        try {
          const res = await fetch(apiUrl("/api/prompts"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(promptsList),
          });
          await readJsonResponse(res, "Delete prompt");
          await loadPrompts();
        } catch (e) {
          console.error(e);
        }
      }

      // Persist a conversation snapshot to disk (conversations.json). Used when
      // a turn is interrupted: the server's normal "done" save never fires on
      // abort, so the client posts its in-memory history so the interrupted
      // exchange survives in the History panel and across reloads. Every mode
      // uses the same in-memory history shape, so this is mode-agnostic.
      // Fire-and-forget.
      function persistConversationSnapshot(
        convId,
        modeName,
        historyArr,
        title,
      ) {
        if (!convId || !Array.isArray(historyArr) || !historyArr.length) return;
        fetch(apiUrl("/api/conversations"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: convId,
            mode: modeName,
            title: title || "",
            messages: historyArr,
            clientId: typeof APP_CLIENT_ID !== "undefined" ? APP_CLIENT_ID : "",
          }),
        }).catch(() => {});
      }

      // ---- BOOK SEARCH CONFIG ----
