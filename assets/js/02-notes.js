      async function flushNotesSave() {
        if (notesSaveTimer) {
          clearTimeout(notesSaveTimer);
          notesSaveTimer = null;
          const { area } = getNotesElements();
          if (area) saveNotesToServer(area.value);
        }
        if (notesSaveInFlight) {
          try {
            await notesSaveInFlight;
          } catch (_e) {
            /* reported by the save path */
          }
        }
      }

      // ---- Markdown preview ----
      //
      // The textarea remains the only source of truth for a note. The preview
      // is rendered FROM it and never written back, so no amount of toggling,
      // switching notes or re-rendering can alter what gets saved. Rendering
      // goes through the same marked + DOMPurify pipeline as chat messages,
      // so a note is sanitized exactly like untrusted model output.
      let notesPreviewMode = false;

      function renderNotesPreview() {
        const { area } = getNotesElements();
        const preview = document.getElementById("notesPreview");
        if (!area || !preview) return;
        const text = area.value || "";
        if (!text.trim()) {
          preview.textContent = "";
          const empty = document.createElement("div");
          empty.className = "notes-preview-empty";
          empty.textContent = "Nothing to preview yet.";
          preview.appendChild(empty);
          return;
        }
        // Never let a renderer problem hide the note. If the vendor scripts
        // are missing or marked throws on some input, fall back to the raw
        // text as plain text — unrendered beats invisible, and textContent
        // cannot inject anything.
        try {
          if (
            typeof marked === "undefined" ||
            typeof DOMPurify === "undefined"
          ) {
            throw new Error("Markdown renderer unavailable");
          }
          preview.innerHTML = DOMPurify.sanitize(marked.parse(text));
          // A note can contain any link; keep it out of the app's own window.
          forceLinksToNewTab(preview);
          addNoteCodeCopyButtons(preview);
        } catch (error) {
          console.error("Could not render note preview", error);
          preview.textContent = text;
        }
      }

      // A COPY control on each fenced block, matching the one chat messages
      // get. The code text is read BEFORE the button is inserted, so the
      // button's own label can never end up on the clipboard.
      function addNoteCodeCopyButtons(root) {
        root.querySelectorAll("pre").forEach((pre) => {
          const codeText = pre.querySelector("code")?.textContent ?? pre.textContent;
          const button = document.createElement("button");
          button.type = "button";
          button.className = "notes-code-copy";
          button.textContent = "COPY";
          button.title = "Copy this code block";
          button.addEventListener("click", async (event) => {
            event.stopPropagation();
            try {
              // Absent outside a secure context; say so rather than throwing.
              if (!navigator.clipboard?.writeText) {
                throw new Error("Clipboard unavailable");
              }
              await navigator.clipboard.writeText(codeText);
              button.textContent = "COPIED";
            } catch (_error) {
              button.textContent = "FAILED";
            }
            setTimeout(() => {
              button.textContent = "COPY";
            }, 1500);
          });
          pre.appendChild(button);
        });
      }

      function setNotesPreview(on) {
        const { panel, area } = getNotesElements();
        if (!panel) return;
        notesPreviewMode = !!on;
        panel.classList.toggle("preview-mode", notesPreviewMode);
        const button = document.getElementById("notesPreviewBtn");
        if (button) {
          button.textContent = notesPreviewMode ? "EDIT" : "PREVIEW";
          button.title = notesPreviewMode
            ? "Back to editing"
            : "Render this note as Markdown";
          button.setAttribute("aria-pressed", String(notesPreviewMode));
        }
        if (notesPreviewMode) {
          // Browsing the note list hides both views, so entering preview from
          // there would show an empty panel.
          panel.classList.remove("list-open");
          renderNotesPreview();
        } else {
          area?.focus();
        }
      }

      function toggleNotesPreview() {
        setNotesPreview(!notesPreviewMode);
      }

      // Opening or creating a note replaces the textarea's contents; the
      // preview has to follow or it would show the note you just left.
      function refreshNotesPreviewIfOpen() {
        if (notesPreviewMode) renderNotesPreview();
      }

      function formatNoteDate(value) {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return "";
        return date.toLocaleDateString(undefined, {
          day: "2-digit",
          month: "short",
        });
      }

      async function refreshNotesList() {
        try {
          const res = await fetch(apiUrl("/api/notes/list"), {
            cache: "no-store",
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const listing = await res.json();
          notesListCache = Array.isArray(listing.notes) ? listing.notes : [];
        } catch (error) {
          console.error("Failed to list notes", error);
        }
        renderNotesList();
      }

      const NOTE_CARD_ICON =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 12h-5"/><path d="M15 8h-5"/><path d="M19 17V5a2 2 0 0 0-2-2H4"/><path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3"/></svg>';

      function renderNotesList() {
        const { list } = getNotesElements();
        if (!list) return;
        list.textContent = "";
        if (!notesListCache.length) {
          const empty = document.createElement("div");
          empty.id = "notesEmpty";
          empty.textContent = "No notes yet. Create one with +";
          list.appendChild(empty);
          return;
        }
        notesListCache.forEach((note) => {
          const card = document.createElement("div");
          card.className =
            "note-card" + (note.name === activeNoteName ? " active" : "");
          card.title = `${note.name} · ${formatNoteDate(note.updatedAt)}`;
          card.innerHTML = NOTE_CARD_ICON;
          const name = document.createElement("span");
          name.className = "note-card-name";
          name.textContent = note.name;
          const del = document.createElement("button");
          del.type = "button";
          del.className = "note-card-delete";
          del.textContent = "✕";
          del.title = `Delete "${note.name}"`;
          del.addEventListener("click", (event) => {
            event.stopPropagation();
            deleteNoteByName(note.name);
          });
          card.appendChild(name);
          card.appendChild(del);
          card.addEventListener("click", () => openNote(note.name));
          list.appendChild(card);
        });
      }

      function toggleNotesList() {
        const { panel } = getNotesElements();
        if (!panel) return;
        const opening = !panel.classList.contains("list-open");
        panel.classList.toggle("list-open", opening);
        if (opening) refreshNotesList();
      }

      async function openNote(name) {
        try {
          await flushNotesSave();
          const res = await fetch(
            apiUrl(`${NOTES_ENDPOINT}?name=${encodeURIComponent(name)}`),
            { cache: "no-store" },
          );
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          activeNoteName = data.name || name;
          notesLastSyncedText = typeof data.text === "string" ? data.text : "";
          notesPendingSaveText = null;
          notesLoaded = true;
          const { area, titleInput, panel } = getNotesElements();
          if (area) area.value = notesLastSyncedText;
          if (titleInput) titleInput.value = activeNoteName;
          if (panel) panel.classList.remove("list-open");
          refreshNotesPreviewIfOpen();
          updateNotesStatus("Synced");
        } catch (error) {
          console.error("Failed to open note", error);
          updateNotesStatus("Failed to open note", true);
        }
      }

      async function createNewNote() {
        try {
          await flushNotesSave();
          const res = await fetch(apiUrl("/api/notes/create"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: "" }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          activeNoteName = data.name;
          notesLastSyncedText = "";
          notesPendingSaveText = null;
          notesLoaded = true;
          const { area, titleInput, panel } = getNotesElements();
          if (area) {
            area.value = "";
          }
          if (titleInput) {
            titleInput.value = activeNoteName;
            titleInput.focus();
            titleInput.select();
          }
          if (panel) panel.classList.remove("list-open");
          // A brand new note exists to be typed into, so never leave the user
          // staring at an empty rendered pane.
          if (notesPreviewMode) setNotesPreview(false);
          updateNotesStatus("New note");
          refreshNotesList();
        } catch (error) {
          console.error("Failed to create note", error);
          updateNotesStatus("Failed to create note", true);
        }
      }

      async function renameActiveNote(title) {
        const { titleInput } = getNotesElements();
        const wanted = String(title || "").trim();
        if (!wanted) {
          if (titleInput) titleInput.value = activeNoteName;
          return;
        }
        try {
          if (!activeNoteName) {
            // No note open yet: a title implies creating one with that name.
            const res = await fetch(apiUrl("/api/notes/create"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ title: wanted }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            activeNoteName = data.name;
          } else if (wanted !== activeNoteName) {
            const res = await fetch(apiUrl("/api/notes/rename"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name: activeNoteName, title: wanted }),
            });
            const data = await res.json().catch(() => null);
            if (!res.ok) {
              throw new Error(data?.error || `HTTP ${res.status}`);
            }
            activeNoteName = data.name;
          }
          if (titleInput) titleInput.value = activeNoteName;
          updateNotesStatus("Renamed");
          refreshNotesList();
        } catch (error) {
          console.error("Failed to rename note", error);
          updateNotesStatus(error.message || "Failed to rename note", true);
          if (titleInput) titleInput.value = activeNoteName;
        }
      }

      async function deleteNoteByName(name) {
        if (
          !(await appConfirm(`Delete the note "${name}"?`, "Notes", {
            danger: true,
          }))
        ) {
          return;
        }
        try {
          const res = await fetch(apiUrl("/api/notes/delete"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const listing = await res.json();
          notesListCache = Array.isArray(listing.notes) ? listing.notes : [];
          if (name === activeNoteName) {
            if (listing.active) {
              await openNote(listing.active);
              const { panel } = getNotesElements();
              if (panel) panel.classList.add("list-open");
            } else {
              activeNoteName = "";
              notesLastSyncedText = "";
              notesPendingSaveText = null;
              const { area, titleInput } = getNotesElements();
              if (area) area.value = "";
              if (titleInput) titleInput.value = "";
              updateNotesStatus("");
            }
          }
          renderNotesList();
        } catch (error) {
          console.error("Failed to delete note", error);
          updateNotesStatus("Failed to delete note", true);
        }
      }

      const chat = document.getElementById("chat");
      let chatPinnedToBottom = true;
      chat.addEventListener(
        "scroll",
        () => {
          const distanceFromBottom =
            chat.scrollHeight - chat.scrollTop - chat.clientHeight;
          chatPinnedToBottom = distanceFromBottom < 60;
        },
        { passive: true },
      );
      function scrollChatToBottom() {
        if (chatPinnedToBottom) chat.scrollTop = chat.scrollHeight;
      }
      const input = document.getElementById("input");
      const modelSelect = document.getElementById("modelSelect");
      const topbarPromptSelect = document.getElementById("topbarPromptSelect");
      const piPaletteGroup = document.getElementById("piPaletteGroup");
      const cloudPaletteGroup = document.getElementById("cloudPaletteGroup");
      const ollamaFontGroup = document.getElementById("ollamaFontGroup");
      const ollamaGenGroup = document.getElementById("ollamaGenGroup");
      const databaseSettingsGroup = document.getElementById(
        "databaseSettingsGroup",
      );
      const piFontGroup = document.getElementById("piFontGroup");
      const cloudFontGroup = document.getElementById("cloudFontGroup");
      const promptSettingsGroup = document.getElementById(
        "promptSettingsGroup",
      );
      const promptManageGroup = document.getElementById("promptManageGroup");
      const piSettingsGroup = document.getElementById("piSettingsGroup");
      const cloudSettingsGroup = document.getElementById("cloudSettingsGroup");
      const piPermissionBtn = document.getElementById("piPermissionBtn");
      const fileInput = document.getElementById("fileInput");
      const API_BASE =
        window.location.protocol === "moz-extension:"
          ? "http://127.0.0.1:8080"
          : "";

      function apiUrl(path) {
        return `${API_BASE}${path}`;
      }

      async function readJsonResponse(res, contextLabel) {
        const raw = await res.text();
        if (!res.ok) {
          const details =
            raw && raw.trim()
              ? raw.trim().slice(0, 500)
              : "empty response body";
          throw new Error(`${contextLabel} failed (${res.status}): ${details}`);
        }
        if (!raw || !raw.trim()) {
          throw new Error(`${contextLabel} returned an empty response body.`);
        }
        try {
          return JSON.parse(raw);
        } catch (e) {
          throw new Error(
            `${contextLabel} returned invalid JSON: ${e.message}`,
          );
        }
      }

      async function postJson(url, payload, contextLabel, signal) {
        const res = await fetch(apiUrl(url), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal,
        });
        return readJsonResponse(res, contextLabel);
      }

      function closeAppDialog(result) {
        const modal = document.getElementById("appDialogModal");
        const resolver = activeAppDialogResolver;
        activeAppDialogResolver = null;
        if (modal) {
          modal.classList.remove("open");
          modal.setAttribute("aria-hidden", "true");
        }
        if (
          appDialogPreviousFocus &&
          typeof appDialogPreviousFocus.focus === "function"
        ) {
          appDialogPreviousFocus.focus();
        }
        appDialogPreviousFocus = null;
        if (typeof resolver === "function") resolver(result);
      }

      function showAppDialog(options = {}) {
        const modal = document.getElementById("appDialogModal");
        const titleEl = document.getElementById("appDialogTitle");
        const messageEl = document.getElementById("appDialogMessage");
        const cancelBtn = document.getElementById("appDialogCancelBtn");
        const confirmBtn = document.getElementById("appDialogConfirmBtn");
        if (!modal || !titleEl || !messageEl || !cancelBtn || !confirmBtn) {
          return Promise.resolve(true);
        }

        if (activeAppDialogResolver) closeAppDialog(false);

        const showCancel = options.cancelLabel !== false;
        titleEl.textContent = options.title || "Notice";
        messageEl.textContent = options.message || "";
        cancelBtn.textContent = options.cancelLabel || "Cancel";
        cancelBtn.style.display = showCancel ? "" : "none";
        confirmBtn.textContent = options.confirmLabel || "OK";
        confirmBtn.classList.toggle("danger", options.danger === true);
        appDialogPreviousFocus = document.activeElement;
        modal.classList.add("open");
        modal.setAttribute("aria-hidden", "false");

        return new Promise((resolve) => {
          activeAppDialogResolver = resolve;
          window.setTimeout(() => confirmBtn.focus(), 0);
        });
      }

      function appAlert(message, title = "Notice") {
        return showAppDialog({
          title,
          message,
          confirmLabel: "OK",
          cancelLabel: false,
        });
      }

      function appConfirm(message, title = "Confirm", options = {}) {
        return showAppDialog({
          title,
          message,
          confirmLabel: options.confirmLabel || "Continue",
          cancelLabel: options.cancelLabel || "Cancel",
          danger: options.danger === true,
        });
      }

      document
        .getElementById("appDialogConfirmBtn")
        ?.addEventListener("click", () => closeAppDialog(true));
      document
        .getElementById("appDialogCancelBtn")
        ?.addEventListener("click", () => closeAppDialog(false));
      document
        .getElementById("appDialogModal")
        ?.addEventListener("click", (event) => {
          if (event.target === event.currentTarget) closeAppDialog(false);
        });
      document.addEventListener("keydown", (event) => {
        const modal = document.getElementById("appDialogModal");
        if (
          event.key === "Escape" &&
          modal?.classList.contains("open") &&
          activeAppDialogResolver
        ) {
          event.preventDefault();
          closeAppDialog(false);
        }
      });

      function forceLinksToNewTab(root) {
        if (!root) return;
        root.querySelectorAll("a[href]").forEach((a) => {
          a.setAttribute("target", "_blank");
          a.setAttribute("rel", "noopener noreferrer");
        });
      }

      function logSecurityEvent(event, details = {}) {
        fetch(apiUrl("/api/security-event"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ event, details }),
          keepalive: true,
        }).catch(() => {});
      }

      function refreshCustomSelectUi(selectEl) {
        if (selectEl && typeof syncCustomSelect === "function") {
          syncCustomSelect(selectEl);
        }
      }

      let uiSettingsSaveTimer = null;
      function currentUiSettingsPayload() {
        return {
          palettes: {
            ollama: ollamaPalette,
            pi: piPalette,
            cloud: cloudPalette,
            lmstudio: lmstudioPalette,
            llamacpp: llamacppPalette,
          },
          fonts: {
            ollama: ollamaFont,
            pi: piFont,
            cloud: cloudFont,
            lmstudio: lmstudioFont,
            llamacpp: llamacppFont,
          },
          fontScales: { ...fontScales },
          thinkingExpanded: { ...thinkingExpandedByMode },
          enabledModes: [...enabledModes],
          defaultMode: defaultLaunchMode,
        };
      }

      // Keep only known mode ids, in registry order, always leaving at least one
      // enabled (falls back to the defaults if the list is empty/invalid).
      function normalizeEnabledModes(list) {
        const known = new Set(MODE_DEFS.map((d) => d.id));
        const filtered = Array.isArray(list)
          ? MODE_DEFS.map((d) => d.id).filter(
              (id) => list.includes(id) && known.has(id),
            )
          : [];
        return filtered.length ? filtered : [...DEFAULT_ENABLED_MODES];
      }

      function persistEnabledModes() {
        localStorage.setItem(
          ENABLED_MODES_STORAGE_KEY,
          JSON.stringify(enabledModes),
        );
        saveUiSettingsSoon();
      }

      // Show only enabled modes in the switcher; if the active mode was just
      // disabled, move to the first still-enabled mode.
      function applyEnabledModes() {
        MODE_DEFS.forEach((def) => {
          const btn = document.getElementById(def.btnId);
          if (btn) {
            btn.style.display = enabledModes.includes(def.id) ? "" : "none";
          }
        });
        updateSearchAlgorithmModeTabs();
        if (!enabledModes.includes(mode)) {
          setMode(enabledModes[0] || "llamacpp");
        }
      }

      // The Search Algorithm sub-panel mirrors the enabled modes: only tabs for
      // currently-enabled modes are shown. If the selected tab's mode gets
      // disabled, fall back to the first enabled one.
      function updateSearchAlgorithmModeTabs() {
        const tabs = document.querySelectorAll(
          "#searchAlgorithmModeTabs .search-algo-mode-btn",
        );
        tabs.forEach((btn) => {
          btn.style.display = enabledModes.includes(btn.dataset.searchAlgoMode)
            ? ""
            : "none";
        });
        if (
          searchAlgorithmSlidersReady &&
          typeof activeSearchAlgorithmMode === "function" &&
          !enabledModes.includes(activeSearchAlgorithmMode())
        ) {
          selectSearchAlgorithmMode(enabledModes[0] || "llamacpp");
        }
      }

      function setModeEnabled(modeId, enabled) {
        if (enabled) {
          if (!enabledModes.includes(modeId)) {
            enabledModes = normalizeEnabledModes([...enabledModes, modeId]);
          }
        } else {
          // Never allow disabling the last enabled mode.
          if (enabledModes.length <= 1) return false;
          enabledModes = enabledModes.filter((id) => id !== modeId);
        }
        persistEnabledModes();
        applyEnabledModes();
        renderModesSettings();
        return true;
      }

      // Render one checkbox per registered mode in the settings panel.
      function renderModesSettings() {
        const list = document.getElementById("modesToggleList");
        if (!list) return;
        list.textContent = "";
        MODE_DEFS.forEach((def) => {
          const isOn = enabledModes.includes(def.id);
          const lastOne = isOn && enabledModes.length <= 1;
          const row = document.createElement("label");
          row.className = "mode-toggle-row";
          const cb = document.createElement("input");
          cb.type = "checkbox";
          cb.className = "brutalist-toggle";
          cb.checked = isOn;
          // Can't uncheck the only remaining enabled mode.
          cb.disabled = lastOne;
          cb.addEventListener("change", () => {
            const ok = setModeEnabled(def.id, cb.checked);
            if (!ok) cb.checked = true;
          });
          const text = document.createElement("span");
          text.textContent = def.label;
          row.appendChild(cb);
          row.appendChild(text);
          list.appendChild(row);
        });
        renderDefaultModeList();
      }

      // Radio list: which enabled mode is preselected when the app opens.
      function renderDefaultModeList() {
        const list = document.getElementById("defaultModeList");
        if (!list) return;
        list.textContent = "";
        // If the saved default was disabled, fall back to "first enabled".
        if (defaultLaunchMode && !enabledModes.includes(defaultLaunchMode)) {
          defaultLaunchMode = "";
        }
        const options = [
          { id: "", label: "First enabled" },
          ...MODE_DEFS.filter((def) => enabledModes.includes(def.id)).map(
            (def) => ({ id: def.id, label: def.label }),
          ),
        ];
        options.forEach((opt) => {
          const row = document.createElement("label");
          row.className = "mode-toggle-row";
          // Same toggle style as the Enabled Modes list; exactly one stays on
          // (checking one unchecks the rest, like a radio group).
          const cb = document.createElement("input");
          cb.type = "checkbox";
          cb.className = "brutalist-toggle";
          cb.checked = defaultLaunchMode === opt.id;
          cb.addEventListener("change", () => {
            // Unchecking the active choice falls back to "First enabled";
            // unchecking "First enabled" itself is not allowed.
            defaultLaunchMode = cb.checked ? opt.id : "";
            localStorage.setItem(DEFAULT_MODE_STORAGE_KEY, defaultLaunchMode);
            saveUiSettingsSoon();
            renderDefaultModeList();
          });
          const text = document.createElement("span");
          text.textContent = opt.label;
          row.appendChild(cb);
          row.appendChild(text);
          list.appendChild(row);
        });
      }

      function saveUiSettingsSoon() {
        if (uiSettingsSaveTimer) clearTimeout(uiSettingsSaveTimer);
        uiSettingsSaveTimer = window.setTimeout(() => {
          uiSettingsSaveTimer = null;
          postJson(
            "/api/ui/settings",
            { settings: currentUiSettingsPayload() },
            "Save UI settings",
          ).catch((error) => {
            console.error("Could not save UI settings", error);
          });
        }, 250);
      }

      async function loadUiSettings() {
        let serverPayload = null;
        try {
          const res = await fetch(apiUrl("/api/ui/settings"));
          serverPayload = await readJsonResponse(res, "Load UI settings");
        } catch (error) {
          console.error("Could not load UI settings", error);
        }

        const useServer = serverPayload?.exists === true;
        const settings = serverPayload?.settings || {};
        const palettes = settings.palettes || {};
        const fonts = settings.fonts || {};

        ollamaPalette = useServer
          ? palettes.ollama || "nordic"
          : localStorage.getItem("ollama-pi-chat-ollama-palette") || "nordic";
        piPalette = useServer
          ? palettes.pi || "orange"
          : localStorage.getItem("ollama-pi-chat-pi-palette") || "orange";
        cloudPalette = useServer
          ? palettes.cloud || "solarised"
          : localStorage.getItem("ollama-pi-chat-cloud-palette") || "solarised";
        lmstudioPalette = useServer
          ? palettes.lmstudio || "nordic"
          : localStorage.getItem("ollama-pi-chat-lmstudio-palette") || "nordic";
        llamacppPalette = useServer
          ? palettes.llamacpp || "carbon"
          : localStorage.getItem("ollama-pi-chat-llamacpp-palette") || "carbon";
        const legacyFontsUntouched =
          normalizeFontStack(fonts.ollama) === LEGACY_DEFAULT_UI_FONT &&
          normalizeFontStack(fonts.pi) === LEGACY_DEFAULT_UI_FONT &&
          normalizeFontStack(fonts.cloud) === LEGACY_DEFAULT_UI_FONT;
        ollamaFont = useServer
          ? legacyFontsUntouched
            ? DEFAULT_UI_FONTS.ollama
            : normalizeFontStack(fonts.ollama || DEFAULT_UI_FONTS.ollama)
          : normalizeFontStack(
              localStorage.getItem("ollama-pi-chat-ollama-font") ||
                DEFAULT_UI_FONTS.ollama,
            );
        piFont = useServer
          ? legacyFontsUntouched
            ? DEFAULT_UI_FONTS.pi
            : normalizeFontStack(fonts.pi || DEFAULT_UI_FONTS.pi)
          : normalizeFontStack(
              localStorage.getItem("ollama-pi-chat-pi-font") ||
                DEFAULT_UI_FONTS.pi,
            );
        cloudFont = useServer
          ? legacyFontsUntouched
            ? DEFAULT_UI_FONTS.cloud
            : normalizeFontStack(fonts.cloud || DEFAULT_UI_FONTS.cloud)
          : normalizeFontStack(
              localStorage.getItem("ollama-pi-chat-cloud-font") ||
                DEFAULT_UI_FONTS.cloud,
            );
        lmstudioFont = normalizeFontStack(
          (useServer && fonts.lmstudio) ||
            localStorage.getItem("ollama-pi-chat-lmstudio-font") ||
            "Sen, sans-serif",
        );
        llamacppFont = normalizeFontStack(
          (useServer && fonts.llamacpp) ||
            localStorage.getItem("ollama-pi-chat-llamacpp-font") ||
            "Marcellus, serif",
        );

        const storedScales = settings.fontScales || {};
        for (const id of Object.keys(fontScales)) {
          const raw =
            useServer && storedScales[id] !== undefined
              ? storedScales[id]
              : localStorage.getItem(`ollama-pi-chat-${id}-font-scale`);
          if (raw !== null && raw !== undefined && raw !== "") {
            fontScales[id] = normalizeFontScale(raw);
          }
          localStorage.setItem(
            `ollama-pi-chat-${id}-font-scale`,
            String(fontScales[id]),
          );
        }

        localStorage.setItem("ollama-pi-chat-ollama-palette", ollamaPalette);
        localStorage.setItem("ollama-pi-chat-pi-palette", piPalette);
        localStorage.setItem("ollama-pi-chat-cloud-palette", cloudPalette);
        localStorage.setItem("ollama-pi-chat-ollama-font", ollamaFont);
        localStorage.setItem("ollama-pi-chat-pi-font", piFont);
        localStorage.setItem("ollama-pi-chat-cloud-font", cloudFont);

        const storedThinkingExpanded =
          settings.thinkingExpanded &&
          typeof settings.thinkingExpanded === "object" &&
          !Array.isArray(settings.thinkingExpanded)
            ? settings.thinkingExpanded
            : {};
        for (const id of Object.keys(thinkingExpandedByMode)) {
          const raw =
            useServer && storedThinkingExpanded[id] !== undefined
              ? storedThinkingExpanded[id]
              : localStorage.getItem(
                  `ollama-pi-chat-${id}-thinking-expanded`,
                );
          if (raw !== null && raw !== undefined && raw !== "") {
            thinkingExpandedByMode[id] =
              raw === true || String(raw).toLowerCase() === "true";
          }
          localStorage.setItem(
            `ollama-pi-chat-${id}-thinking-expanded`,
            String(thinkingExpandedByMode[id]),
          );
        }

        let storedEnabledModes = null;
        if (useServer && Array.isArray(settings.enabledModes)) {
          storedEnabledModes = settings.enabledModes;
        } else {
          try {
            storedEnabledModes = JSON.parse(
              localStorage.getItem(ENABLED_MODES_STORAGE_KEY) || "null",
            );
          } catch (_e) {
            storedEnabledModes = null;
          }
        }
        enabledModes = normalizeEnabledModes(storedEnabledModes);
        localStorage.setItem(
          ENABLED_MODES_STORAGE_KEY,
          JSON.stringify(enabledModes),
        );

        // Default mode on launch: server value first, then localStorage. Only
        // accept a currently-enabled mode; "" means "first enabled".
        const storedDefaultMode = useServer
          ? settings.defaultMode || ""
          : localStorage.getItem(DEFAULT_MODE_STORAGE_KEY) || "";
        defaultLaunchMode = enabledModes.includes(storedDefaultMode)
          ? storedDefaultMode
          : "";
        localStorage.setItem(DEFAULT_MODE_STORAGE_KEY, defaultLaunchMode);

        if (!useServer || legacyFontsUntouched) saveUiSettingsSoon();
      }

      // THEMES AND PALETTES
