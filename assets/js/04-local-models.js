      function localModeEls(modeId) {
        if (modeId === "lmstudio") {
          return {
            base: document.getElementById("lmStudioBaseUrl"),
            select: document.getElementById("lmStudioModelSelect"),
            palette: document.getElementById("lmStudioPaletteSelect"),
            params: document.getElementById("lmStudioParams"),
            reset: document.getElementById("lmStudioParamsReset"),
            nativeTools: document.getElementById("lmStudioNativeToolsInput"),
            agentMode: document.getElementById("lmStudioAgentModeInput"),
            agentRounds: document.getElementById("lmStudioAgentRoundsInput"),
          };
        }
        return {
          base: document.getElementById("llamaCppBaseUrl"),
          select: document.getElementById("llamaCppModelSelect"),
          palette: document.getElementById("llamaCppPaletteSelect"),
          params: document.getElementById("llamaCppParams"),
          reset: document.getElementById("llamaCppParamsReset"),
          nativeTools: document.getElementById("llamaCppNativeToolsInput"),
          agentMode: document.getElementById("llamaCppAgentModeInput"),
          agentRounds: document.getElementById("llamaCppAgentRoundsInput"),
        };
      }

      // Get/set the per-mode palette variable for a local mode.
      function localPaletteVar(modeId, value) {
        if (modeId === "lmstudio") {
          if (value !== undefined) lmstudioPalette = value;
          return lmstudioPalette;
        }
        if (value !== undefined) llamacppPalette = value;
        return llamacppPalette;
      }

      // Render a mode's sampling parameters using the same stepper component as
      // the Ollama generation settings (label + number input + +/- controls),
      // laid out two per row.
      function renderLocalParams(modeId) {
        const els = localModeEls(modeId);
        if (!els.params) return;
        const conf = localModelConfig[modeId];
        els.params.innerHTML = "";
        let rowWrap = null;
        LOCAL_PARAM_DEFS.forEach((def, i) => {
          if (i % 2 === 0) {
            rowWrap = document.createElement("div");
            rowWrap.className = "setting-row-inline";
            els.params.appendChild(rowWrap);
          }
          const cell = document.createElement("div");
          cell.className = "setting-row";
          cell.style.flex = "1";

          const label = document.createElement("label");
          label.style.fontSize = "calc(10px * var(--font-scale, 1))";
          label.textContent = def.label.toUpperCase();

          const numWrap = document.createElement("div");
          numWrap.className = "setting-number";
          const input = document.createElement("input");
          const inputId = `${modeId}-param-${def.key}`;
          input.id = inputId;
          input.type = "number";
          input.min = def.min;
          input.max = def.max;
          input.step = def.step;
          input.value = conf.params[def.key];
          input.addEventListener("change", () => {
            let v = parseFloat(input.value);
            if (!Number.isFinite(v)) v = def.def;
            v = Math.min(def.max, Math.max(def.min, v));
            input.value = v;
            conf.params[def.key] = v;
            saveLocalModeSettings();
          });
          const controls = document.createElement("div");
          controls.className = "setting-number-controls";
          ["up", "down"].forEach((dir) => {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "setting-number-btn";
            b.setAttribute("data-target", inputId);
            b.setAttribute("data-dir", dir);
            b.textContent = dir === "up" ? "+" : "−";
            controls.appendChild(b);
          });
          numWrap.appendChild(input);
          numWrap.appendChild(controls);

          const desc = document.createElement("div");
          desc.className = "setting-help";
          desc.textContent = def.help || "";

          const help = document.createElement("div");
          help.className = "setting-help";
          help.textContent = "Default: " + def.def;

          cell.appendChild(label);
          cell.appendChild(numWrap);
          if (def.help) cell.appendChild(desc);
          cell.appendChild(help);
          rowWrap.appendChild(cell);
        });
      }

      function renderLocalModelOptions(modeId, models) {
        const els = localModeEls(modeId);
        if (!els.select) return;
        const current = localModelConfig[modeId].model || "";
        const list = Array.isArray(models) ? models : current ? [current] : [];
        els.select.innerHTML = "";
        const optAuto = document.createElement("option");
        optAuto.value = "";
        optAuto.textContent = "Automatic";
        els.select.appendChild(optAuto);
        for (const m of list) {
          const o = document.createElement("option");
          o.value = m;
          o.textContent = m;
          els.select.appendChild(o);
        }
        els.select.value = current;
        // The visible dropdown is a custom-select widget built from the native
        // select's options at startup; rebuild it so new models show up.
        refreshCustomSelectUi(els.select);
      }

      async function loadLocalModeSettings() {
        try {
          const res = await fetch(apiUrl("/api/local-models/settings"));
          const data = await readJsonResponse(res, "Load local model settings");
          if (data && data.settings) {
            for (const id of LOCAL_MODE_IDS) {
              const s = data.settings[id];
              if (s) {
                localModelConfig[id] = {
                  baseUrl: s.baseUrl || localModelConfig[id].baseUrl,
                  model: typeof s.model === "string" ? s.model : "",
                  params: {
                    ...defaultLocalParams(),
                    ...(s.params && typeof s.params === "object"
                      ? s.params
                      : {}),
                  },
                  nativeTools: s.nativeTools !== false,
                  agentMode: s.agentMode === true,
                  agentMaxRounds: Number.isFinite(Number(s.agentMaxRounds))
                    ? Math.min(50, Math.max(1, Math.round(s.agentMaxRounds)))
                    : 25,
                };
              }
            }
          }
        } catch (e) {
          console.error("Could not load local model settings", e);
        }
        for (const id of LOCAL_MODE_IDS) {
          const els = localModeEls(id);
          if (els.base) els.base.value = localModelConfig[id].baseUrl;
          if (els.palette) {
            els.palette.value = localPaletteVar(id);
            // Rebuild the custom-select widget so its trigger shows the saved
            // palette instead of the first option.
            refreshCustomSelectUi(els.palette);
          }
          if (els.nativeTools) {
            els.nativeTools.checked =
              localModelConfig[id].nativeTools !== false;
          }
          if (els.agentMode) {
            els.agentMode.checked = localModelConfig[id].agentMode === true;
          }
          if (els.agentRounds) {
            els.agentRounds.value = String(
              localModelConfig[id].agentMaxRounds || 25,
            );
          }
          renderLocalModelOptions(id);
          renderLocalParams(id);
        }
      }

      function saveLocalModeSettings() {
        postJson(
          "/api/local-models/settings",
          {
            settings: {
              lmstudio: localModelConfig.lmstudio,
              llamacpp: localModelConfig.llamacpp,
            },
          },
          "Save local model settings",
        ).catch((e) => console.error("Could not save local model settings", e));
      }

      // Cache of the model ids each local server reports, so the topbar
      // dropdown can populate without re-fetching on every mode switch.
      const localModelsCache = { lmstudio: [], llamacpp: [] };
      // Embedding-capable model ids reported by each local server, offered in
      // the Database settings so embeddings work without Ollama.
      const localEmbeddingModelsCache = { lmstudio: [], llamacpp: [] };
      // The loaded context window each local server reports (LM Studio
      // /api/v0/models, llama.cpp /props) — shown as the token-counter limit.
      const localContextCache = { lmstudio: null, llamacpp: null };

      async function fetchLocalModelList(
        modeId,
        { alertOnError = false } = {},
      ) {
        try {
          const res = await fetch(apiUrl(`/api/${modeId}/models`));
          const data = await readJsonResponse(res, "List local models");
          localModelsCache[modeId] = Array.isArray(data.models)
            ? data.models
            : [];
          localEmbeddingModelsCache[modeId] = Array.isArray(
            data.embeddingModels,
          )
            ? data.embeddingModels
            : [];
          localContextCache[modeId] =
            typeof data.contextLength === "number" ? data.contextLength : null;
        } catch (e) {
          if (alertOnError) {
            alert(`Could not list models for ${modeId}: ${e.message}`);
          }
        }
        renderLocalModelOptions(modeId, localModelsCache[modeId]);
        if (mode === modeId) {
          populateTopbarModelSelect();
          // Surface the loaded context window as the token-counter limit even
          // before the first message (so you can see e.g. 9169 vs what you set).
          const st =
            modeId === "lmstudio" ? lmstudioTokenState : llamacppTokenState;
          updateTokenCounter(
            modeId,
            typeof st.used === "number" ? st.used : 0,
            localContextCache[modeId] || null,
          );
        }
        return localModelsCache[modeId];
      }

      // "Refresh models" button in settings: fetch and surface errors.
      async function refreshLocalModels(modeId) {
        await fetchLocalModelList(modeId, { alertOnError: true });
      }

      function wireLocalModeSettings() {
        for (const id of LOCAL_MODE_IDS) {
          const els = localModeEls(id);
          if (els.base) {
            els.base.addEventListener("change", () => {
              const v = els.base.value.trim();
              if (v) localModelConfig[id].baseUrl = v;
              saveLocalModeSettings();
            });
          }
          if (els.select) {
            els.select.addEventListener("change", () => {
              localModelConfig[id].model = els.select.value;
              saveLocalModeSettings();
              if (mode === id) updateModeStatus();
            });
          }
          if (els.nativeTools) {
            els.nativeTools.addEventListener("change", () => {
              localModelConfig[id].nativeTools = els.nativeTools.checked;
              saveLocalModeSettings();
            });
          }
          if (els.agentMode) {
            els.agentMode.addEventListener("change", () => {
              localModelConfig[id].agentMode = els.agentMode.checked;
              saveLocalModeSettings();
            });
          }
          if (els.agentRounds) {
            els.agentRounds.addEventListener("change", () => {
              let v = parseInt(els.agentRounds.value, 10);
              if (!Number.isFinite(v)) v = 25;
              v = Math.min(50, Math.max(1, v));
              els.agentRounds.value = String(v);
              localModelConfig[id].agentMaxRounds = v;
              saveLocalModeSettings();
            });
          }
          if (els.palette) {
            els.palette.addEventListener("change", () => {
              const v = els.palette.value;
              localPaletteVar(id, v);
              localStorage.setItem(`ollama-pi-chat-${id}-palette`, v);
              saveUiSettingsSoon();
              if (mode === id) applyPalette(v);
            });
          }
          if (els.reset) {
            els.reset.addEventListener("click", () => {
              localModelConfig[id].params = defaultLocalParams();
              renderLocalParams(id);
              saveLocalModeSettings();
            });
          }
        }
        const lmBtn = document.getElementById("lmStudioRefreshModels");
        if (lmBtn) {
          lmBtn.addEventListener("click", () => refreshLocalModels("lmstudio"));
        }
        const llBtn = document.getElementById("llamaCppRefreshModels");
        if (llBtn) {
          llBtn.addEventListener("click", () => refreshLocalModels("llamacpp"));
        }
      }

      // HISTORY
