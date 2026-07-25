      function toggleTheme() {
        isDark = !isDark;
        localStorage.setItem(
          "ollama-pi-chat-dark-mode",
          isDark ? "true" : "false",
        );
        updateThemeUI();
      }

      function updateThemeUI() {
        document.documentElement.setAttribute(
          "data-theme",
          isDark ? "dark" : "light",
        );
        document.getElementById("iconSun").style.display = isDark ? "none" : "";
        document.getElementById("iconMoon").style.display = isDark
          ? ""
          : "none";
      }

      function changeOllamaPalette(p) {
        ollamaPalette = p;
        localStorage.setItem("ollama-pi-chat-ollama-palette", p);
        saveUiSettingsSoon();
        if (mode === "ollama") applyPalette(p);
      }

      function changePiPalette(p) {
        piPalette = p;
        localStorage.setItem("ollama-pi-chat-pi-palette", p);
        saveUiSettingsSoon();
        if (mode === "pi") applyPalette(p);
      }

      function changeCloudPalette(p) {
        cloudPalette = p;
        localStorage.setItem("ollama-pi-chat-cloud-palette", p);
        saveUiSettingsSoon();
        if (mode === "cloud") applyPalette(p);
      }

      function clampFloat(value, fallback, min, max) {
        const parsed = Number.parseFloat(value);
        if (!Number.isFinite(parsed)) return fallback;
        return Math.min(max, Math.max(min, parsed));
      }

      function parseStopSequences(input) {
        if (typeof input !== "string" || !input.trim()) return [];
        const list = input
          .split(/\r?\n|\|\|/g)
          .map((item) => item.trim())
          .filter(Boolean);
        return [...new Set(list)];
      }

      function normalizeOllamaOptions(raw) {
        const source =
          raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
        const stop =
          Array.isArray(source.stop) && source.stop.length
            ? source.stop
                .map((item) => (typeof item === "string" ? item.trim() : ""))
                .filter(Boolean)
            : [];
        return {
          temperature: clampFloat(
            source.temperature,
            OLLAMA_DEFAULT_OPTIONS.temperature,
            0,
            2,
          ),
          topP: clampFloat(source.topP, OLLAMA_DEFAULT_OPTIONS.topP, 0, 1),
          topK: clampInteger(source.topK, OLLAMA_DEFAULT_OPTIONS.topK, 1, 1000),
          repeatPenalty: clampFloat(
            source.repeatPenalty,
            OLLAMA_DEFAULT_OPTIONS.repeatPenalty,
            0,
            2,
          ),
          repeatLastN: clampInteger(
            source.repeatLastN,
            OLLAMA_DEFAULT_OPTIONS.repeatLastN,
            -1,
            131072,
          ),
          numPredict: clampInteger(
            source.numPredict,
            OLLAMA_DEFAULT_OPTIONS.numPredict,
            -1,
            200000,
          ),
          numCtx: clampInteger(
            source.numCtx,
            OLLAMA_DEFAULT_OPTIONS.numCtx,
            256,
            131072,
          ),
          seed: clampInteger(
            source.seed,
            OLLAMA_DEFAULT_OPTIONS.seed,
            -2147483648,
            2147483647,
          ),
          stop,
        };
      }

      function isSameOllamaOptionSet(options, expected) {
        const normalized = normalizeOllamaOptions(options);
        return (
          normalized.temperature === expected.temperature &&
          normalized.topP === expected.topP &&
          normalized.topK === expected.topK &&
          normalized.repeatPenalty === expected.repeatPenalty &&
          normalized.repeatLastN === expected.repeatLastN &&
          normalized.numPredict === expected.numPredict &&
          normalized.numCtx === expected.numCtx &&
          normalized.seed === expected.seed &&
          normalized.stop.length === 0
        );
      }

      function loadOllamaOptionsFromStorage() {
        try {
          const raw = localStorage.getItem(OLLAMA_OPTIONS_STORAGE_KEY);
          if (!raw) {
            ollamaOptions = normalizeOllamaOptions(ollamaOptions);
            return;
          }
          const storedOptions = normalizeOllamaOptions(JSON.parse(raw));
          if (
            isSameOllamaOptionSet(storedOptions, OLLAMA_LEGACY_DEFAULT_OPTIONS)
          ) {
            ollamaOptions = normalizeOllamaOptions({});
            localStorage.setItem(
              OLLAMA_OPTIONS_STORAGE_KEY,
              JSON.stringify(ollamaOptions),
            );
            return;
          }
          ollamaOptions = storedOptions;
        } catch (_error) {
          ollamaOptions = normalizeOllamaOptions(ollamaOptions);
        }
      }

      function renderOllamaOptionsForm() {
        const options = normalizeOllamaOptions(ollamaOptions);
        ollamaOptions = options;
        document.getElementById("ollamaTemperatureInput").value = String(
          options.temperature,
        );
        document.getElementById("ollamaTopPInput").value = String(options.topP);
        document.getElementById("ollamaTopKInput").value = String(options.topK);
        document.getElementById("ollamaRepeatPenaltyInput").value = String(
          options.repeatPenalty,
        );
        document.getElementById("ollamaRepeatLastNInput").value = String(
          options.repeatLastN,
        );
        document.getElementById("ollamaNumPredictInput").value = String(
          options.numPredict,
        );
        document.getElementById("ollamaNumCtxInput").value = String(
          options.numCtx,
        );
        document.getElementById("ollamaSeedInput").value = String(options.seed);
        document.getElementById("ollamaStopInput").value =
          options.stop.join("\n");
      }

      function collectOllamaOptionsFromForm() {
        return normalizeOllamaOptions({
          temperature: document.getElementById("ollamaTemperatureInput").value,
          topP: document.getElementById("ollamaTopPInput").value,
          topK: document.getElementById("ollamaTopKInput").value,
          repeatPenalty: document.getElementById("ollamaRepeatPenaltyInput")
            .value,
          repeatLastN: document.getElementById("ollamaRepeatLastNInput").value,
          numPredict: document.getElementById("ollamaNumPredictInput").value,
          numCtx: document.getElementById("ollamaNumCtxInput").value,
          seed: document.getElementById("ollamaSeedInput").value,
          stop: parseStopSequences(
            document.getElementById("ollamaStopInput").value,
          ),
        });
      }

      function saveOllamaOptionsFromForm() {
        ollamaOptions = collectOllamaOptionsFromForm();
        localStorage.setItem(
          OLLAMA_OPTIONS_STORAGE_KEY,
          JSON.stringify(ollamaOptions),
        );
        renderOllamaOptionsForm();
        // Update the token counter total immediately so it reflects the new num_ctx
        if (mode === "ollama") {
          ollamaTokenState = {
            ...ollamaTokenState,
            total: ollamaOptions.numCtx,
          };
          updateTokenCounter("ollama");
        }
      }

      function resetOllamaOptionsToDefaults() {
        ollamaOptions = normalizeOllamaOptions({});
        localStorage.setItem(
          OLLAMA_OPTIONS_STORAGE_KEY,
          JSON.stringify(ollamaOptions),
        );
        renderOllamaOptionsForm();
      }

      function getOllamaOptionsRequestPayload() {
        const normalized = normalizeOllamaOptions(ollamaOptions);
        const payload = {
          temperature: normalized.temperature,
          top_p: normalized.topP,
          top_k: normalized.topK,
          repeat_penalty: normalized.repeatPenalty,
          repeat_last_n: normalized.repeatLastN,
          num_predict: normalized.numPredict,
          num_ctx: normalized.numCtx,
          seed: normalized.seed,
        };
        if (normalized.stop.length) payload.stop = normalized.stop;
        return payload;
      }

      function normalizeLibrarySettings(raw) {
        const source = raw && typeof raw === "object" ? raw : {};
        return {
          enabled: source.enabled === true,
          limit: clampInteger(source.limit, 20, 1, 50),
          maxContextChars: clampInteger(
            source.maxContextChars,
            30000,
            1000,
            50000,
          ),
          includeSourcePaths: source.includeSourcePaths !== false,
        };
      }

      function normalizeDatabaseChatModes(raw, fallbackEnabled = false) {
        return Object.fromEntries(
          SEARCH_ALGO_MODE_KEYS.map((modeKey) => [
            modeKey,
            {
              enabled:
                raw?.[modeKey] && typeof raw[modeKey] === "object"
                  ? raw[modeKey].enabled === true
                  : fallbackEnabled === true,
            },
          ]),
        );
      }

      function getDatabaseModeSettings(modeKey = mode) {
        const normalized = normalizeDatabaseConfig(databaseConfig);
        const chatModes = normalizeDatabaseChatModes(
          normalized.chatModes,
          normalized.chatIntegration.enabled,
        );
        const activeMode = SEARCH_ALGO_MODE_KEYS.includes(modeKey)
          ? modeKey
          : "ollama";
        return {
          ...normalized.chatIntegration,
          enabled: chatModes[activeMode]?.enabled === true,
        };
      }

      function normalizeSourceExtensionsInput(value) {
        const raw = Array.isArray(value)
          ? value
          : String(value || "").split(/[, ]+/);
        const extensions = raw
          .map((extension) =>
            String(extension || "")
              .trim()
              .toLowerCase(),
          )
          .filter(Boolean)
          .map((extension) =>
            extension.startsWith(".") ? extension : `.${extension}`,
          );
        return [...new Set(extensions)];
      }

      function formatExtensions(extensions) {
        const normalized = normalizeSourceExtensionsInput(extensions);
        return normalized.length ? normalized.join(", ") : ".txt";
      }

      function normalizeDatabaseConfig(raw) {
        const source = raw && typeof raw === "object" ? raw : {};
        const defaults = databaseConfig || {};
        const search = source.search || {};
        const embedding = source.embedding || {};
        const chunking = source.chunking || {};
        const usesLegacyChunkDefaults =
          (Number(chunking.targetChars) === 1800 &&
            Number(chunking.overlapChars) === 220 &&
            Number(chunking.minChars) === 120 &&
            Number(chunking.maxChars) === 2800) ||
          (Number(chunking.targetChars) === 4200 &&
            Number(chunking.overlapChars) === 120 &&
            Number(chunking.minChars) === 300 &&
            Number(chunking.maxChars) === 6500);
        const normalizedChunking = usesLegacyChunkDefaults ? {} : chunking;
        const watch = source.watch || {};
        const quantization = String(
          embedding.quantization || "int8",
        ).toLowerCase();
        const sources = Array.isArray(source.sources)
          ? source.sources.map((item, index) => ({
              name: String(item?.name || `Source ${index + 1}`).trim(),
              type: String(item?.type || "document").trim() || "document",
              path: String(item?.path || "").trim(),
              extensions: normalizeSourceExtensionsInput(item?.extensions),
            }))
          : [];
        const chatIntegration = normalizeLibrarySettings(
          source.chatIntegration || source.library || librarySettings,
        );
        const chatModes = normalizeDatabaseChatModes(
          source.chatModes,
          chatIntegration.enabled,
        );
        const normalizedSearch = {
          keywordEnabled: search.keywordEnabled === true,
          defaultLimit: clampInteger(search.defaultLimit, 5, 1, 50),
          maxLimit: clampInteger(search.maxLimit, 50, 1, 50),
          maxContextChars: clampInteger(
            search.maxContextChars,
            12000,
            1000,
            50000,
          ),
          ...normalizeSearchAlgorithmValues(search, SEARCH_ALGORITHM_DEFAULTS),
        };
        return {
          version: 1,
          databasePath:
            String(source.databasePath || defaults.databasePath || "").trim() ||
            "~/dive/library.sqlite",
          sources,
          chunking: {
            targetChars: clampInteger(
              normalizedChunking.targetChars,
              defaults.chunking?.targetChars || 2400,
              500,
              10000,
            ),
            overlapChars: clampInteger(
              normalizedChunking.overlapChars,
              defaults.chunking?.overlapChars || 0,
              0,
              2000,
            ),
            minChars: clampInteger(
              normalizedChunking.minChars,
              defaults.chunking?.minChars || 300,
              20,
              2000,
            ),
            maxChars: clampInteger(
              normalizedChunking.maxChars,
              defaults.chunking?.maxChars || 3200,
              500,
              20000,
            ),
          },
          search: normalizedSearch,
          searchModes: Object.fromEntries(
            SEARCH_ALGO_MODE_KEYS.map((modeKey) => [
              modeKey,
              normalizeSearchAlgorithmValues(
                source.searchModes?.[modeKey],
                normalizedSearch,
              ),
            ]),
          ),
          chatModes,
          embedding: {
            enabled: embedding.enabled === true,
            // No invented default: an unset model stays empty so the UI and
            // the index preflight treat it as "not configured yet".
            model: String(embedding.model || "").trim(),
            ollamaBaseUrl:
              String(embedding.ollamaBaseUrl || "").trim() ||
              "http://127.0.0.1:11434",
            batchSize: clampInteger(embedding.batchSize, 16, 1, 64),
            dimensions: clampInteger(embedding.dimensions, 0, 0, 4096),
            quantization:
              quantization === "float" || quantization === "float32"
                ? "float32"
                : "int8",
            sqliteVecExtensionPath: String(
              embedding.sqliteVecExtensionPath || "",
            ).trim(),
          },
          chatIntegration,
          watch: {
            enabled: watch.enabled === true,
            debounceMs: clampInteger(watch.debounceMs, 2000, 250, 60000),
            rescanIntervalMs: clampInteger(
              watch.rescanIntervalMs,
              60000,
              5000,
              3600000,
            ),
          },
        };
      }

      let embeddingModelFetchTried = false;
      function renderEmbeddingModelSelect(currentModel) {
        const select = document.getElementById("databaseEmbeddingModelSelect");
        const customInput = document.getElementById(
          "databaseEmbeddingModelCustomInput",
        );
        if (!select) return;
        // Best-effort: discover local-server embedding models (LM Studio's
        // bundled embedder) even if the user never opened the LM Studio tab.
        if (
          !embeddingModelFetchTried &&
          !(localEmbeddingModelsCache.lmstudio || []).length
        ) {
          embeddingModelFetchTried = true;
          fetchLocalModelList("lmstudio")
            .then(() => {
              const current = document.getElementById(
                "databaseEmbeddingModelSelect",
              );
              // Re-render only if the user has not switched to Custom in the
              // meantime; keep whatever value is currently selected.
              if (
                (localEmbeddingModelsCache.lmstudio || []).length &&
                current &&
                current.value !== "__custom__"
              ) {
                renderEmbeddingModelSelect(current.value || currentModel);
              }
            })
            .catch(() => {});
        }
        // Only models the servers actually report as installed: Ollama's
        // downloaded models plus LM Studio / llama.cpp embedding models. A
        // saved model that no server reports falls back to the Custom input
        // instead of being listed as if it existed.
        const models = [
          ...new Set(
            [
              ...availableOllamaModels,
              ...(localEmbeddingModelsCache.lmstudio || []),
              ...(localEmbeddingModelsCache.llamacpp || []),
            ].filter(Boolean),
          ),
        ];
        const currentKnown = models.includes(currentModel);
        select.innerHTML = "";
        models.forEach((modelName) => {
          const option = document.createElement("option");
          option.value = modelName;
          option.textContent = modelName;
          select.appendChild(option);
        });
        const customOption = document.createElement("option");
        customOption.value = "__custom__";
        customOption.textContent = "Custom model id";
        select.appendChild(customOption);
        // An unset model shows an explicit placeholder instead of being
        // dumped into the Custom input as if something were configured.
        if (!currentModel) {
          const placeholder = document.createElement("option");
          placeholder.value = "";
          placeholder.textContent = "Select an embedding model";
          select.insertBefore(placeholder, select.firstChild);
        }
        select.value = currentKnown
          ? currentModel
          : currentModel
            ? "__custom__"
            : "";
        if (customInput) {
          customInput.style.display =
            select.value === "__custom__" ? "" : "none";
          customInput.value = currentKnown || !currentModel ? "" : currentModel;
        }
        refreshCustomSelectUi(select);
        if (currentKnown) syncEmbeddingBaseUrlToModel(currentModel);
      }

      // Embedding requests must go to the server that actually hosts the
      // selected model: an LM Studio model has to hit LM Studio's port (1234),
      // not Ollama's 11434 — otherwise indexing fails with "model not found".
      function embeddingBaseUrlForModel(modelName) {
        if (!modelName || modelName === "__custom__") return "";
        const stripVersion = (url) =>
          String(url || "")
            .replace(/\/+$/, "")
            .replace(/\/v\d+$/, "");
        if (
          (localEmbeddingModelsCache.lmstudio || []).includes(modelName) ||
          (localModelsCache.lmstudio || []).includes(modelName)
        ) {
          return stripVersion(localModelConfig.lmstudio.baseUrl);
        }
        if (
          (localEmbeddingModelsCache.llamacpp || []).includes(modelName) ||
          (localModelsCache.llamacpp || []).includes(modelName)
        ) {
          return stripVersion(localModelConfig.llamacpp.baseUrl);
        }
        if (availableOllamaModels.includes(modelName)) {
          return "http://127.0.0.1:11434";
        }
        return "";
      }

      function syncEmbeddingBaseUrlToModel(modelName) {
        const input = document.getElementById("databaseEmbeddingBaseUrlInput");
        if (!input) return;
        const routed = embeddingBaseUrlForModel(modelName);
        if (routed && input.value.trim() !== routed) input.value = routed;
      }

      function renderDatabaseSources(sources) {
        const container = document.getElementById("databaseSourcesList");
        if (!container) return;
        container.innerHTML = "";
        if (!sources.length) {
          const empty = document.createElement("div");
          empty.className = "setting-help";
          empty.textContent = "No source folders configured.";
          container.appendChild(empty);
          return;
        }
        sources.forEach((source, index) => {
          const row = document.createElement("div");
          row.className = "database-source-row";
          row.dataset.index = String(index);

          const firstGrid = document.createElement("div");
          firstGrid.className = "database-source-grid";

          const nameWrap = document.createElement("div");
          nameWrap.className = "setting-row";
          const nameLabel = document.createElement("label");
          nameLabel.style.fontSize = "calc(10px * var(--font-scale, 1))";
          nameLabel.textContent = "NAME";
          const nameInput = document.createElement("input");
          nameInput.type = "text";
          nameInput.className = "database-source-name";
          nameInput.value = source.name || "";
          nameWrap.append(nameLabel, nameInput);

          const typeWrap = document.createElement("div");
          typeWrap.className = "setting-row";
          const typeLabel = document.createElement("label");
          typeLabel.style.fontSize = "calc(10px * var(--font-scale, 1))";
          typeLabel.textContent = "TYPE";
          const typeSelect = document.createElement("select");
          typeSelect.className = "database-source-type";
          ["book", "note", "document"].forEach((type) => {
            const option = document.createElement("option");
            option.value = type;
            option.textContent = type;
            typeSelect.appendChild(option);
          });
          typeSelect.value = ["book", "note", "document"].includes(source.type)
            ? source.type
            : "document";
          typeWrap.append(typeLabel, typeSelect);

          firstGrid.append(nameWrap, typeWrap);

          const secondGrid = document.createElement("div");
          secondGrid.className = "database-source-grid-wide";

          const pathWrap = document.createElement("div");
          pathWrap.className = "setting-row";
          const pathLabel = document.createElement("label");
          pathLabel.style.fontSize = "calc(10px * var(--font-scale, 1))";
          pathLabel.textContent = "FOLDER PATH";
          const pathInput = document.createElement("input");
          pathInput.type = "text";
          pathInput.className = "database-source-path";
          pathInput.value = source.path || "";
          pathWrap.append(pathLabel, pathInput);

          const extensionsWrap = document.createElement("div");
          extensionsWrap.className = "setting-row";
          const extensionsLabel = document.createElement("label");
          extensionsLabel.style.fontSize = "calc(10px * var(--font-scale, 1))";
          extensionsLabel.textContent = "EXTENSIONS";
          const extensionsInput = document.createElement("input");
          extensionsInput.type = "text";
          extensionsInput.className = "database-source-extensions";
          extensionsInput.value = formatExtensions(source.extensions);
          extensionsWrap.append(extensionsLabel, extensionsInput);

          secondGrid.append(pathWrap, extensionsWrap);

          const actions = document.createElement("div");
          actions.className = "database-source-actions";
          const removeButton = document.createElement("button");
          removeButton.type = "button";
          removeButton.className = "settings-action-btn database-source-remove";
          removeButton.textContent = "REMOVE SOURCE";
          removeButton.dataset.index = String(index);
          actions.appendChild(removeButton);

          row.append(firstGrid, secondGrid, actions);
          container.appendChild(row);
          refreshCustomSelectUi(typeSelect);
        });
      }

      function renderDatabaseConfigForm() {
        databaseConfig = normalizeDatabaseConfig(databaseConfig);
        databaseChatModes = databaseConfig.chatModes;
        librarySettings = getDatabaseModeSettings(mode);
        const settings = librarySettings;
        const dbPathInput = document.getElementById("databasePathInput");
        const enabledInput = document.getElementById(
          "librarySearchEnabledInput",
        );
        const limitInput = document.getElementById("libraryLimitInput");
        const maxContextInput = document.getElementById(
          "libraryMaxContextInput",
        );
        const includePathsInput = document.getElementById(
          "libraryIncludePathsInput",
        );
        const semanticInput = document.getElementById(
          "databaseSemanticEnabledInput",
        );
        const keywordInput = document.getElementById(
          "databaseKeywordEnabledInput",
        );
        const baseUrlInput = document.getElementById(
          "databaseEmbeddingBaseUrlInput",
        );
        const batchInput = document.getElementById(
          "databaseEmbeddingBatchInput",
        );
        const dimensionsInput = document.getElementById(
          "databaseEmbeddingDimensionsInput",
        );
        const quantizationSelect = document.getElementById(
          "databaseEmbeddingQuantizationSelect",
        );
        const defaultLimitInput = document.getElementById(
          "databaseDefaultLimitInput",
        );
        const sqliteVecInput = document.getElementById(
          "databaseSqliteVecPathInput",
        );
        if (dbPathInput) dbPathInput.value = databaseConfig.databasePath;
        if (enabledInput) enabledInput.checked = settings.enabled;
        if (limitInput) limitInput.value = String(settings.limit);
        if (maxContextInput) {
          maxContextInput.value = String(settings.maxContextChars);
        }
        if (includePathsInput) {
          includePathsInput.checked = settings.includeSourcePaths;
        }
        if (semanticInput) {
          semanticInput.checked = databaseConfig.embedding.enabled;
        }
        if (keywordInput) {
          keywordInput.checked = databaseConfig.search.keywordEnabled;
        }
        renderEmbeddingModelSelect(databaseConfig.embedding.model);
        if (baseUrlInput) {
          // Prefer the URL of the server that reports the saved model; a stale
          // saved URL (e.g. Ollama's) would misroute LM Studio embeddings.
          baseUrlInput.value =
            embeddingBaseUrlForModel(databaseConfig.embedding.model) ||
            databaseConfig.embedding.ollamaBaseUrl;
        }
        if (batchInput) {
          batchInput.value = String(databaseConfig.embedding.batchSize);
        }
        if (dimensionsInput) {
          dimensionsInput.value = String(databaseConfig.embedding.dimensions);
        }
        if (quantizationSelect) {
          quantizationSelect.value =
            databaseConfig.embedding.quantization || "int8";
          refreshCustomSelectUi(quantizationSelect);
        }
        if (defaultLimitInput) {
          defaultLimitInput.value = String(databaseConfig.search.defaultLimit);
        }
        if (sqliteVecInput) {
          sqliteVecInput.value =
            databaseConfig.embedding.sqliteVecExtensionPath;
        }
        populateSearchAlgorithmSliders();
        updateBookFilterUi();
        document.querySelectorAll('input[type="range"]').forEach((input) => {
          const display = input.nextElementSibling;
          if (display && display.classList.contains("setting-range-value")) {
            display.textContent = input.value;
          }
        });

        renderDatabaseSources(databaseConfig.sources);
      }

      function setRangeValue(inputId, value) {
        const input = document.getElementById(inputId);
        if (!input) return;
        input.value = String(value);
        const display = input.nextElementSibling;
        if (display && display.classList.contains("setting-range-value")) {
          display.textContent = input.value;
        }
      }

      let searchAlgorithmMode = null;
      let searchAlgorithmSlidersReady = false;

      function activeSearchAlgorithmMode() {
        if (!SEARCH_ALGO_MODE_KEYS.includes(searchAlgorithmMode)) {
          searchAlgorithmMode = SEARCH_ALGO_MODE_KEYS.includes(mode)
            ? mode
            : "ollama";
        }
        return searchAlgorithmMode;
      }

      function getSearchAlgorithmValuesForMode(modeKey) {
        return normalizeSearchAlgorithmValues(
          databaseConfig.searchModes?.[modeKey],
          databaseConfig.search || SEARCH_ALGORITHM_DEFAULTS,
        );
      }

      function readSearchAlgorithmSlidersFromForm(fallback) {
        return normalizeSearchAlgorithmValues(
          {
            rrfK: document.getElementById("databaseRrfKInput")?.value,
            contentKeywordBonus: document.getElementById(
              "databaseContentKeywordBonusInput",
            )?.value,
            metadataKeywordBonus: document.getElementById(
              "databaseMetadataKeywordBonusInput",
            )?.value,
            semanticWeight: document.getElementById(
              "databaseSemanticWeightInput",
            )?.value,
            keywordWeight: document.getElementById("databaseKeywordWeightInput")
              ?.value,
            metadataWeight: document.getElementById(
              "databaseMetadataWeightInput",
            )?.value,
            sourceWeight: document.getElementById("databaseSourceWeightInput")
              ?.value,
            maxPassagesPerSource: document.getElementById(
              "databaseMaxPassagesPerSourceInput",
            )?.value,
          },
          fallback,
        );
      }

      function commitActiveSearchAlgorithmSliders() {
        if (!searchAlgorithmSlidersReady) return;
        const modeKey = activeSearchAlgorithmMode();
        if (
          !databaseConfig.searchModes ||
          typeof databaseConfig.searchModes !== "object"
        ) {
          databaseConfig.searchModes = {};
        }
        databaseConfig.searchModes[modeKey] =
          readSearchAlgorithmSlidersFromForm(
            getSearchAlgorithmValuesForMode(modeKey),
          );
      }

      // Search-algorithm settings autosave: persist immediately on change to
      // ~/dive/library-config.json, scoped to the active mode. Sends ONLY the
      // searchModes block as a partial config so the server merge never
      // touches structural settings (model/dims/chunking/sources). These are
      // query-time weights with no index side effects, so no reindex prompt.
      const SEARCH_ALGO_SLIDER_IDS = new Set([
        "databaseRrfKInput",
        "databaseContentKeywordBonusInput",
        "databaseMetadataKeywordBonusInput",
        "databaseSemanticWeightInput",
        "databaseKeywordWeightInput",
        "databaseMetadataWeightInput",
        "databaseSourceWeightInput",
        "databaseMaxPassagesPerSourceInput",
      ]);
      let searchAlgoAutosaveTimer = null;
      function flashSearchAlgoSaveStatus(text) {
        const el = document.getElementById("searchAlgoSaveStatus");
        if (!el) return;
        el.textContent = text;
        clearTimeout(el._clearTimer);
        if (text === "Saved") {
          el._clearTimer = setTimeout(() => {
            el.textContent = "";
          }, 1500);
        }
      }
      async function persistSearchAlgorithmSettings() {
        commitActiveSearchAlgorithmSliders();
        if (!databaseConfig.searchModes) return;
        flashSearchAlgoSaveStatus("Saving…");
        try {
          await postJson(
            "/api/library/config",
            { config: { searchModes: databaseConfig.searchModes } },
            "Save search algorithm settings",
          );
          flashSearchAlgoSaveStatus("Saved");
        } catch (error) {
          console.error("Search algorithm autosave failed", error);
          flashSearchAlgoSaveStatus("Save failed");
        }
      }
      function scheduleSearchAlgorithmAutosave() {
        if (!searchAlgorithmSlidersReady) return;
        clearTimeout(searchAlgoAutosaveTimer);
        searchAlgoAutosaveTimer = setTimeout(
          persistSearchAlgorithmSettings,
          400,
        );
      }

      function populateSearchAlgorithmSliders() {
        const modeKey = activeSearchAlgorithmMode();
        const values = getSearchAlgorithmValuesForMode(modeKey);
        setRangeValue("databaseRrfKInput", values.rrfK);
        setRangeValue(
          "databaseContentKeywordBonusInput",
          values.contentKeywordBonus,
        );
        setRangeValue(
          "databaseMetadataKeywordBonusInput",
          values.metadataKeywordBonus,
        );
        setRangeValue("databaseSemanticWeightInput", values.semanticWeight);
        setRangeValue("databaseKeywordWeightInput", values.keywordWeight);
        setRangeValue("databaseMetadataWeightInput", values.metadataWeight);
        setRangeValue("databaseSourceWeightInput", values.sourceWeight);
        setRangeValue(
          "databaseMaxPassagesPerSourceInput",
          values.maxPassagesPerSource,
        );
        document
          .querySelectorAll("#searchAlgorithmModeTabs .search-algo-mode-btn")
          .forEach((btn) => {
            btn.classList.toggle(
              "active",
              btn.dataset.searchAlgoMode === modeKey,
            );
          });
        searchAlgorithmSlidersReady = true;
      }

      function selectSearchAlgorithmMode(nextMode) {
        if (!SEARCH_ALGO_MODE_KEYS.includes(nextMode)) return;
        if (nextMode === activeSearchAlgorithmMode()) return;
        commitActiveSearchAlgorithmSliders();
        searchAlgorithmMode = nextMode;
        populateSearchAlgorithmSliders();
      }

      // The settings tab always follows the active chat mode; a manual tab
      // selection persists only until the next mode switch.
      function syncSearchAlgorithmModeToChatMode() {
        if (!SEARCH_ALGO_MODE_KEYS.includes(mode)) return;
        if (searchAlgorithmMode === mode) return;
        commitActiveSearchAlgorithmSliders();
        searchAlgorithmMode = mode;
        populateSearchAlgorithmSliders();
      }

      function resetSearchAlgorithmSettings() {
        setRangeValue("databaseRrfKInput", SEARCH_ALGORITHM_DEFAULTS.rrfK);
        setRangeValue(
          "databaseContentKeywordBonusInput",
          SEARCH_ALGORITHM_DEFAULTS.contentKeywordBonus,
        );
        setRangeValue(
          "databaseMetadataKeywordBonusInput",
          SEARCH_ALGORITHM_DEFAULTS.metadataKeywordBonus,
        );
        setRangeValue(
          "databaseSemanticWeightInput",
          SEARCH_ALGORITHM_DEFAULTS.semanticWeight,
        );
        setRangeValue(
          "databaseKeywordWeightInput",
          SEARCH_ALGORITHM_DEFAULTS.keywordWeight,
        );
        setRangeValue(
          "databaseMetadataWeightInput",
          SEARCH_ALGORITHM_DEFAULTS.metadataWeight,
        );
        setRangeValue(
          "databaseSourceWeightInput",
          SEARCH_ALGORITHM_DEFAULTS.sourceWeight,
        );
        setRangeValue(
          "databaseMaxPassagesPerSourceInput",
          SEARCH_ALGORITHM_DEFAULTS.maxPassagesPerSource,
        );
        databaseConfig = collectDatabaseConfigFromForm();
        scheduleSearchAlgorithmAutosave();
      }

      function collectLibrarySettingsFromForm() {
        return normalizeLibrarySettings({
          enabled:
            document.getElementById("librarySearchEnabledInput")?.checked ===
            true,
          limit: document.getElementById("libraryLimitInput")?.value,
          maxContextChars: document.getElementById("libraryMaxContextInput")
            ?.value,
          includeSourcePaths: document.getElementById(
            "libraryIncludePathsInput",
          )?.checked,
        });
      }

      function collectDatabaseChatModesFromForm(currentModes) {
        const nextModes = normalizeDatabaseChatModes(currentModes, false);
        const activeMode = SEARCH_ALGO_MODE_KEYS.includes(mode)
          ? mode
          : "ollama";
        nextModes[activeMode] = {
          enabled:
            document.getElementById("librarySearchEnabledInput")?.checked ===
            true,
        };
        return nextModes;
      }

      function collectDatabaseSourcesFromForm() {
        const container = document.getElementById("databaseSourcesList");
        if (!container) return [];
        return Array.from(container.querySelectorAll(".database-source-row"))
          .map((row, index) => ({
            name:
              row.querySelector(".database-source-name")?.value.trim() ||
              `Source ${index + 1}`,
            type:
              row.querySelector(".database-source-type")?.value || "document",
            path:
              row.querySelector(".database-source-path")?.value.trim() || "",
            extensions: normalizeSourceExtensionsInput(
              row.querySelector(".database-source-extensions")?.value || "",
            ),
          }))
          .filter((source) => source.path);
      }

      function getSelectedEmbeddingModel() {
        const select = document.getElementById("databaseEmbeddingModelSelect");
        const customInput = document.getElementById(
          "databaseEmbeddingModelCustomInput",
        );
        if (select?.value === "__custom__") {
          return customInput?.value.trim() || databaseConfig.embedding.model;
        }
        return select?.value || databaseConfig.embedding.model;
      }

      function collectDatabaseConfigFromForm() {
        commitActiveSearchAlgorithmSliders();
        const current = normalizeDatabaseConfig(databaseConfig);
        const nextChatModes = collectDatabaseChatModesFromForm(
          current.chatModes,
        );
        const requestedDefaultLimit = clampInteger(
          document.getElementById("databaseDefaultLimitInput")?.value,
          current.search.defaultLimit,
          1,
          50,
        );
        const requestedChatLimit = clampInteger(
          document.getElementById("libraryLimitInput")?.value,
          current.chatIntegration.limit,
          1,
          50,
        );
        const requestedMaxLimit = Math.max(
          current.search.maxLimit,
          requestedDefaultLimit,
          requestedChatLimit,
        );
        return normalizeDatabaseConfig({
          ...current,
          databasePath:
            document.getElementById("databasePathInput")?.value ||
            current.databasePath,
          sources: collectDatabaseSourcesFromForm(),
          search: {
            ...current.search,
            keywordEnabled: document.getElementById(
              "databaseKeywordEnabledInput",
            )?.checked,
            defaultLimit: requestedDefaultLimit,
            maxLimit: requestedMaxLimit,
            maxContextChars: document.getElementById("libraryMaxContextInput")
              ?.value,
          },
          searchModes: current.searchModes,
          chatModes: nextChatModes,
          embedding: {
            ...current.embedding,
            enabled: document.getElementById("databaseSemanticEnabledInput")
              ?.checked,
            model: getSelectedEmbeddingModel(),
            ollamaBaseUrl:
              document.getElementById("databaseEmbeddingBaseUrlInput")?.value ||
              current.embedding.ollamaBaseUrl,
            batchSize: document.getElementById("databaseEmbeddingBatchInput")
              ?.value,
            dimensions: document.getElementById(
              "databaseEmbeddingDimensionsInput",
            )?.value,
            quantization:
              document.getElementById("databaseEmbeddingQuantizationSelect")
                ?.value ||
              current.embedding.quantization ||
              "int8",
            sqliteVecExtensionPath:
              document.getElementById("databaseSqliteVecPathInput")?.value ||
              "",
          },
          chatIntegration: normalizeLibrarySettings({
            ...collectLibrarySettingsFromForm(),
            enabled: Object.values(nextChatModes).some(
              (settings) => settings?.enabled === true,
            ),
          }),
        });
      }

      async function loadLibrarySettings() {
        try {
          const res = await fetch(apiUrl("/api/library/config"));
          const payload = await readJsonResponse(res, "Load database config");
          databaseConfig = normalizeDatabaseConfig(payload?.config);
          databaseChatModes = databaseConfig.chatModes;
          librarySettings = getDatabaseModeSettings(mode);
        } catch (error) {
          console.error("Could not load database config", error);
          databaseConfig = normalizeDatabaseConfig(databaseConfig);
          databaseChatModes = databaseConfig.chatModes;
          librarySettings = getDatabaseModeSettings(mode);
        }
        renderDatabaseConfigForm();
      }

      function describeDatabaseIndexSettingChanges(previous, next) {
        const changes = [];
        const prev = normalizeDatabaseConfig(previous);
        const curr = normalizeDatabaseConfig(next);
        if (prev.search.keywordEnabled !== curr.search.keywordEnabled) {
          changes.push(
            curr.search.keywordEnabled
              ? "Keyword FTS will be built from existing passages. This can take time and increase database size, but it should not delete EPUB/chunk progress."
              : "Keyword FTS will be removed. Semantic vectors and extracted passages should remain intact.",
          );
        }
        if (
          prev.embedding.enabled !== curr.embedding.enabled ||
          prev.embedding.model !== curr.embedding.model ||
          Number(prev.embedding.dimensions || 0) !==
            Number(curr.embedding.dimensions || 0) ||
          prev.embedding.quantization !== curr.embedding.quantization ||
          prev.embedding.sqliteVecExtensionPath !==
            curr.embedding.sqliteVecExtensionPath
        ) {
          changes.push(
            "Vector settings changed. Existing passages should remain, but vector rows may need to be rebuilt or retried.",
          );
        }
        if (
          prev.chunking.targetChars !== curr.chunking.targetChars ||
          prev.chunking.overlapChars !== curr.chunking.overlapChars ||
          prev.chunking.minChars !== curr.chunking.minChars ||
          prev.chunking.maxChars !== curr.chunking.maxChars
        ) {
          changes.push(
            "Chunking changed. This requires re-extracting and rebuilding affected document passages.",
          );
        }
        return changes;
      }

      async function saveLibrarySettingsFromForm() {
        const previousConfig = normalizeDatabaseConfig(databaseConfig);
        const nextConfig = collectDatabaseConfigFromForm();
        const indexChanges = describeDatabaseIndexSettingChanges(
          previousConfig,
          nextConfig,
        );
        if (indexChanges.length) {
          const ok = await appConfirm(
            `Database index setting changes:\n\n${indexChanges.join(
              "\n\n",
            )}\n\nContinue saving these settings?`,
            "Database",
            { confirmLabel: "Save" },
          );
          if (!ok) {
            renderDatabaseConfigForm();
            return false;
          }
        }
        databaseConfig = nextConfig;
        databaseChatModes = databaseConfig.chatModes;
        librarySettings = getDatabaseModeSettings(mode);
        renderDatabaseConfigForm();
        try {
          const payload = await postJson(
            "/api/library/config",
            { config: databaseConfig },
            "Save database settings",
          );
          databaseConfig = normalizeDatabaseConfig(payload?.config);
          databaseChatModes = databaseConfig.chatModes;
          librarySettings = getDatabaseModeSettings(mode);
          renderDatabaseConfigForm();
          await loadLibraryStatus();
          return true;
        } catch (error) {
          console.error("Could not save database settings", error);
          await appAlert(
            error.message || "Failed to save database settings.",
            "Database",
          );
          return false;
        }
      }

      function setElementText(id, value) {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
      }

      function formatMetricNumber(value) {
        const number = Number(value || 0);
        if (!Number.isFinite(number)) return "0";
        return number.toLocaleString();
      }

      function formatByteSize(value) {
        const bytes = Number(value || 0);
        if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
        const units = ["B", "KB", "MB", "GB", "TB"];
        let size = bytes;
        let unitIndex = 0;
        while (size >= 1024 && unitIndex < units.length - 1) {
          size /= 1024;
          unitIndex += 1;
        }
        const digits = unitIndex === 0 || size >= 100 ? 0 : size >= 10 ? 1 : 2;
        return `${size.toFixed(digits)} ${units[unitIndex]}`;
      }

      // Latest /api/library/status payload — the index-job renderer reads it
      // for embedding-readiness numbers.
      let lastSavedDatabaseStatus = null;

      function renderSavedDatabaseStatus(status) {
        lastSavedDatabaseStatus = status || null;
        const sourceCount = Array.isArray(status.sources)
          ? status.sources.filter((source) => source.exists).length
          : 0;
        const vectorLabel = status.embedding?.sqliteVecConfigured
          ? `sqlite-vec ${status.embedding?.quantization || "int8"}`
          : status.embedding?.enabled
            ? "semantic waiting"
            : status.search?.keywordEnabled
              ? "FTS5 only"
              : "compact only";
        const sqliteLabel = status.sqliteAvailable
          ? status.sqliteCanLoadExtensions
            ? `extensions on | ${basenameFromPath(status.sqliteExtensionPath || status.sqlitePath)}`
            : `no extensions | ${basenameFromPath(status.sqlitePath)}`
          : "not available";

        setElementText(
          "libraryStatusFilesValue",
          formatMetricNumber(status.files),
        );
        setElementText(
          "libraryStatusPassagesValue",
          formatMetricNumber(status.chunks),
        );
        setElementText(
          "libraryStatusEmbeddingsValue",
          formatMetricNumber(status.embeddings),
        );
        const readyCount =
          status.embedding?.readyCount ?? status.embedding?.matchingRows ?? 0;
        const missingCount = status.embedding?.missingCount ?? 0;
        setElementText(
          "libraryStatusEmbeddingsReadyValue",
          formatMetricNumber(readyCount),
        );
        setElementText(
          "libraryStatusEmbeddingsMissingValue",
          formatMetricNumber(missingCount),
        );
        // Side panel: minimal database completion metric (actual indexed files
        // relative to total files found on disk).
        // If a job is active/paused, the job poll already updates this.
        // Only update if we are absolutely sure no job is active.
        if (!window.activeLibraryIndexJob) {
          const totalFiles = status.totalFiles || 0;
          const indexedFiles = status.files || 0;
          const completionPct =
            totalFiles > 0
              ? Math.round((indexedFiles / totalFiles) * 100)
              : null;
          const sideDbEl = document.getElementById("sideDbCompletion");
          if (sideDbEl) {
            sideDbEl.textContent =
              completionPct === null
                ? ""
                : `${indexedFiles} / ${totalFiles} (${completionPct}%)`;
            sideDbEl.style.color = "";
          }
        }
        setElementText(
          "libraryStatusSourcesValue",
          formatMetricNumber(sourceCount),
        );
        setElementText("libraryStatusVectorValue", vectorLabel);
        const configuredDims = Number(status.embedding?.dimensions || 0);
        const storedDims = Number(status.embedding?.storedDimensions || 0);
        const dimsLabel = configuredDims
          ? formatMetricNumber(configuredDims)
          : storedDims
            ? `native | ${formatMetricNumber(storedDims)} stored`
            : "native";
        setElementText("libraryStatusDimsValue", dimsLabel);
        setElementText(
          "libraryStatusModelValue",
          status.embedding?.model || "no embedding model",
        );
        setElementText("libraryStatusSqliteValue", sqliteLabel);
      }

      async function loadLibraryStatus() {
        const statusEl = document.getElementById("libraryStatusText");
        if (!statusEl) return;
        try {
          const res = await fetch(apiUrl("/api/library/status"));
          const status = await readJsonResponse(res, "Load library status");
          renderSavedDatabaseStatus(status);
          if (!status.sqliteAvailable) {
            statusEl.textContent = "SQLite not available. Set SQLITE3_PATH.";
            return;
          }
          const readyCount =
            status.embedding?.readyCount ?? status.embedding?.matchingRows ?? 0;
          const missingCount = status.embedding?.missingCount ?? 0;
          if (status.embedding?.enabled) {
            statusEl.textContent = `Semantic search ${
              missingCount === 0 && Number(status.chunks || 0) > 0
                ? "ready"
                : "not complete"
            }: ${formatMetricNumber(readyCount)} / ${formatMetricNumber(status.chunks)} passages embedded, ${formatMetricNumber(missingCount)} missing. Live job counts appear below.`;
          } else {
            statusEl.textContent =
              "Semantic embeddings are disabled. Saved database snapshot appears above; live job counts appear below.";
          }
        } catch (error) {
          console.error("Could not load library status", error);
          statusEl.textContent = "Library status unavailable.";
        }
      }

      async function exportIndexedFiles() {
        const statusEl = document.getElementById("libraryStatusText");
        const exportStatusEl = document.getElementById(
          "libraryExportStatusText",
        );
        const exportActions = document.getElementById("libraryExportActions");
        const button = document.getElementById("exportIndexedFilesBtn");
        if (statusEl) statusEl.textContent = "Exporting indexed EPUB list...";
        if (exportStatusEl) {
          exportStatusEl.style.display = "";
          exportStatusEl.textContent = "Exporting indexed EPUB list...";
        }
        if (exportActions) exportActions.style.display = "none";
        if (button) button.disabled = true;
        try {
          const res = await fetch(apiUrl("/api/library/export-indexed-files"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          });
          const payload = await readJsonResponse(res, "Export indexed files");
          lastIndexedFilesExportPath = payload.path || "";
          if (statusEl) {
            statusEl.textContent = `Exported ${formatMetricNumber(payload.count)} indexed EPUB files to ${payload.path}.`;
          }
          if (exportStatusEl) {
            exportStatusEl.textContent = `Exported ${formatMetricNumber(payload.count)} indexed EPUB files. ${payload.path}`;
          }
          if (exportActions) exportActions.style.display = "";
          openIndexedFilesExport().catch((error) => {
            console.error("Could not open indexed file export", error);
          });
        } catch (error) {
          console.error("Could not export indexed files", error);
          if (statusEl) statusEl.textContent = "Indexed file export failed.";
          if (exportStatusEl) {
            exportStatusEl.style.display = "";
            exportStatusEl.textContent = "Indexed file export failed.";
          }
          await appAlert(
            error.message || "Failed to export indexed files.",
            "Database",
          );
        } finally {
          if (button) button.disabled = false;
        }
      }

      async function openIndexedFilesExport() {
        const res = await fetch(
          apiUrl("/api/library/export-indexed-files/open"),
          {
            method: "POST",
          },
        );
        await readJsonResponse(res, "Open indexed files export");
      }

      async function copyIndexedFilesExportPath() {
        if (!lastIndexedFilesExportPath) return;
        try {
          if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(lastIndexedFilesExportPath);
          } else {
            const temp = document.createElement("textarea");
            temp.value = lastIndexedFilesExportPath;
            document.body.appendChild(temp);
            temp.select();
            document.execCommand("copy");
            temp.remove();
          }
        } catch (error) {
          console.error("Could not copy indexed files export path", error);
          await appAlert("Could not copy export path.", "Database");
        }
      }

      function renderLibraryEstimate(estimate) {
        setElementText(
          "libraryEstimateFilesValue",
          `${formatMetricNumber(estimate.sampledFiles)} / ${formatMetricNumber(estimate.files)} sampled`,
        );
        setElementText(
          "libraryEstimatePassagesValue",
          formatMetricNumber(estimate.estimatedChunks),
        );
        setElementText(
          "libraryEstimateTextValue",
          `${formatByteSize(estimate.estimatedCompressedBytes)} compressed`,
        );
        setElementText(
          "libraryEstimateVectorValue",
          formatByteSize(estimate.estimatedVectorBytes),
        );
        setElementText(
          "libraryEstimateTotalValue",
          `${formatByteSize(estimate.estimatedTotalBytes)} estimated`,
        );
        const outliers = Array.isArray(estimate.outliers)
          ? estimate.outliers.slice(0, 3)
          : [];
        setElementText(
          "libraryEstimateOutliersValue",
          outliers.length
            ? outliers
                .map(
                  (item) =>
                    `${basenameFromPath(item.path)} (${formatMetricNumber(item.chunks)} passages)`,
                )
                .join(" | ")
            : "--",
        );
      }

      async function estimateLibraryIndexSize() {
        const statusEl = document.getElementById("libraryEstimateStatusText");
        const button = document.getElementById("estimateLibraryIndexBtn");
        const saved = await saveLibrarySettingsFromForm();
        if (!saved) return;
        if (statusEl) statusEl.textContent = "Estimating from a sample...";
        if (button) button.disabled = true;
        try {
          const res = await fetch(apiUrl("/api/library/estimate?sample=150"));
          const estimate = await readJsonResponse(res, "Estimate index size");
          renderLibraryEstimate(estimate);
          if (statusEl) {
            const skipped = Number(estimate.sampleSkippedDocuments || 0);
            const errors = Number(estimate.sampleErrors || 0);
            statusEl.textContent = `Estimate based on ${formatMetricNumber(estimate.sampledFiles)} readable sample files. ${formatMetricNumber(skipped)} skipped, ${formatMetricNumber(errors)} errors in sample.`;
          }
        } catch (error) {
          console.error("Could not estimate library index", error);
          if (statusEl) statusEl.textContent = "Index estimate unavailable.";
          await appAlert(
            error.message || "Failed to estimate index size.",
            "Database",
          );
        } finally {
          if (button) button.disabled = false;
        }
      }

      function formatIndexPhase(phase) {
        const labels = {
          "embedding-preflight": "Checking embeddings",
          resuming: "Resuming",
          indexing: "Indexing",
          "keyword-indexing": "Keyword index",
          embedding: "Embedding",
          pruning: "Pruning removed files",
          compacting: "Compacting database",
          cancelling: "Cancelling",
          cancelled: "Cancelled",
          pausing: "Pausing",
          paused: "Paused",
          completed: "Completed",
        };
        return labels[phase] || "Indexing";
      }

      function basenameFromPath(filePath) {
        return (
          String(filePath || "")
            .split(/[\\/]/)
            .filter(Boolean)
            .pop() || ""
        );
      }

      function setLibraryIndexProgress(percent, text) {
        const fill = document.getElementById("libraryIndexProgressFill");
        const progressText = document.getElementById(
          "libraryIndexProgressText",
        );
        const safePercent = Math.max(
          0,
          Math.min(100, Number.isFinite(Number(percent)) ? Number(percent) : 0),
        );
        if (fill) fill.style.width = `${safePercent}%`;
        if (progressText) progressText.textContent = text || `${safePercent}%`;
      }

      function setLibraryIndexButtons(running) {
        const runButton = document.getElementById("runLibraryIndexBtn");
        const retryButton = document.getElementById(
          "retryLibraryEmbeddingsBtn",
        );
        const forceButton = document.getElementById("forceLibraryReindexBtn");
        const cancelButton = document.getElementById("cancelLibraryIndexBtn");
        if (runButton) runButton.disabled = running;
        if (retryButton) retryButton.disabled = running;
        if (forceButton) forceButton.disabled = running;
        if (cancelButton) cancelButton.disabled = !running;
      }

      function formatIndexIssueKind(kind) {
        const labels = {
          embedding_error: "Embedding",
          document_skipped: "Skipped doc",
          file_error: "File",
        };
        return labels[kind] || "Issue";
      }

      function formatRecentIndexIssues(issues) {
        if (!Array.isArray(issues) || !issues.length) return "--";
        return issues
          .slice(-3)
          .reverse()
          .map((issue) => {
            const file = basenameFromPath(issue.filePath || issue.path);
            const detail = issue.error || issue.reason || "unknown";
            const source = file ? `${file}: ` : "";
            return `${formatIndexIssueKind(issue.kind)} - ${source}${detail}`;
          })
          .join(" | ");
      }

      function renderIndexJobGrid(values = {}) {
        setElementText("libraryJobPhaseValue", values.phase || "Idle");
        setElementText("libraryJobProgressValue", values.progress || "0%");
        setElementText("libraryJobFilesValue", values.files || "--");
        setElementText("libraryJobPassagesValue", values.passages || "--");
        setElementText("libraryJobEmbeddingsValue", values.embeddings || "--");
        setElementText(
          "libraryJobPendingEmbeddingsValue",
          values.pending || "--",
        );
        setElementText("libraryJobErrorsValue", values.errors || "--");
        setElementText(
          "libraryJobEmbeddingErrorsValue",
          values.embeddingErrors || "--",
        );
        setElementText("libraryJobSkippedValue", values.skipped || "--");
        setElementText(
          "libraryJobCurrentFileValue",
          values.currentFile || "--",
        );
        setElementText(
          "libraryJobRecentIssuesValue",
          values.recentIssues || "--",
        );
      }

      function getEmbeddingReadinessFromStatus(status) {
        const chunks = Number(status?.chunks || 0);
        const ready = Number(
          status?.embedding?.readyCount ??
            status?.embedding?.matchingRows ??
            status?.embeddings ??
            0,
        );
        const missing = Number(
          status?.embedding?.missingCount ?? Math.max(0, chunks - ready),
        );
        return { chunks, ready, missing };
      }

      function formatEmbeddingReadiness(status) {
        if (!status || status.error) return "";
        const summary = getEmbeddingReadinessFromStatus(status);
        if (!status.embedding?.enabled) {
          return "Semantic embeddings disabled.";
        }
        return `Semantic ready: ${formatMetricNumber(summary.ready)} / ${formatMetricNumber(summary.chunks)} passages embedded; ${formatMetricNumber(summary.missing)} missing.`;
      }

      // Index ETA (frontend-only). Estimates remaining time for the embedding
      // phase using a rolling window of recent status-poll samples, so a
      // pause/resume or a cold start never poisons the figure. No backend or
      // indexer involvement; purely derived from progress already reported.
      let embeddingEtaSamples = [];
      function formatEtaSeconds(totalSeconds) {
        const s = Math.max(0, Math.round(totalSeconds));
        if (s < 60) return `~${s}s left`;
        const m = Math.round(s / 60);
        if (m < 60) return `~${m}m left`;
        const h = Math.floor(m / 60);
        const rem = m % 60;
        return rem ? `~${h}h ${rem}m left` : `~${h}h left`;
      }
      function computeEmbeddingEtaText(
        job,
        phaseKey,
        embedded,
        embeddingPending,
      ) {
        if (!job || job.status !== "running" || phaseKey !== "embedding") {
          embeddingEtaSamples = [];
          return "";
        }
        if (!(Number(embeddingPending) > 0)) return "";
        const now = Date.now();
        const last = embeddingEtaSamples[embeddingEtaSamples.length - 1];
        // A fresh run resets the counter; drop stale samples if it went down.
        if (last && Number(embedded) < last.embedded) embeddingEtaSamples = [];
        embeddingEtaSamples.push({ t: now, embedded: Number(embedded) || 0 });
        const cutoff = now - 90000; // rolling 90s window
        embeddingEtaSamples = embeddingEtaSamples.filter((s) => s.t >= cutoff);
        const first = embeddingEtaSamples[0];
        const latest = embeddingEtaSamples[embeddingEtaSamples.length - 1];
        const spanMs = latest.t - first.t;
        const delta = latest.embedded - first.embedded;
        if (spanMs < 20000 || delta <= 0) return " | estimating…";
        const rate = delta / (spanMs / 1000); // passages per second
        if (!(rate > 0)) return " | estimating…";
        return ` | ${formatEtaSeconds(Number(embeddingPending) / rate)}`;
      }

      let alertedEmbeddingFailureJobId = null;

      function renderLibraryIndexJob(payload) {
        // Surface mid-run embedding failures once per job, loudly.
        try {
          const jobId = payload?.job?.id || null;
          const embErrors =
            Number(payload?.job?.progress?.embeddingErrors) || 0;
          if (
            jobId &&
            embErrors > 0 &&
            payload?.job?.status === "running" &&
            alertedEmbeddingFailureJobId !== jobId
          ) {
            alertedEmbeddingFailureJobId = jobId;
            const recent = payload?.job?.progress?.recentErrors || [];
            const detail = recent.length
              ? `\n\nMost recent error:\n${String(recent[recent.length - 1]?.error || recent[recent.length - 1] || "").slice(0, 300)}`
              : "";
            appConfirm(
              `Embeddings are failing during this index run (${embErrors} so far). ` +
                `You can pause now, fix the embedding server, and press ` +
                `Build / Update Index to resume — or continue keyword-only ` +
                `and use Retry Embeddings later for the affected passages.` +
                detail,
              "Database — embedding errors",
              {
                confirmLabel: "Pause indexing",
                cancelLabel: "Continue without embeddings",
                danger: true,
              },
            )
              .then((pause) => {
                if (pause) cancelLibraryIndex();
              })
              .catch(() => {});
          }
        } catch (_e) {}
        // Side panel activity light: glowing while the index job runs.
        const dbDot = document.getElementById("sideDbDot");
        if (dbDot) {
          const running = payload?.running === true;
          dbDot.classList.toggle("indexing", running);
          dbDot.title = running
            ? "Library index running…"
            : "Library index idle";
        }
        const statusEl = document.getElementById("libraryIndexStatusText");
        if (!statusEl) return;
        const savedStatus = lastSavedDatabaseStatus;
        const job = payload?.job || null;
        if (!job) {
          statusEl.textContent = "No active index job.";
          setLibraryIndexProgress(0, "0%");
          setLibraryIndexButtons(false);
          renderIndexJobGrid();
          return;
        }

        const progress = job.progress || {};
        const stats = job.stats || {};
        const percent =
          job.status === "completed"
            ? 100
            : Number.isFinite(Number(progress.percent))
              ? Number(progress.percent)
              : 0;
        const processed = progress.processed ?? stats.processed ?? 0;
        const scanned = progress.scanned ?? stats.scanned ?? 0;

        // Mirror the exactly reported progress to the side panel.
        // This overrides the snapshot if a job (active or paused) exists.
        const sideDbEl = document.getElementById("sideDbCompletion");
        if (sideDbEl) {
          sideDbEl.textContent = `${processed} / ${scanned} (${Math.round(percent)}%)`;
          sideDbEl.style.color =
            job.status === "running" ? "var(--accent)" : "";
        }

        const chunks = progress.chunks ?? stats.chunks ?? 0;
        const embedded = progress.embedded ?? stats.embedded ?? 0;
        const estimatedFinalBytes =
          progress.estimatedFinalBytes ?? stats.estimatedFinalBytes ?? 0;
        const embeddingErrors =
          progress.embeddingErrors ?? stats.embeddingErrors ?? 0;
        const embeddingPending =
          progress.embeddingPending ??
          stats.embeddingPending ??
          Math.max(
            0,
            Number(chunks || 0) -
              Number(embedded || 0) -
              Number(embeddingErrors || 0) -
              Number(
                progress.embeddingsSkipped ?? stats.embeddingsSkipped ?? 0,
              ),
          );
        const jobErrors =
          progress.errors ??
          (Array.isArray(stats.errors) ? stats.errors.length : 0);
        const skippedDocs =
          progress.skippedDocuments ??
          (Array.isArray(stats.skippedDocuments)
            ? stats.skippedDocuments.length
            : 0);
        const recentIssues =
          progress.recentErrors || job.recentErrors || stats.recentErrors || [];
        const skippedUnchanged = progress.skipped ?? stats.skipped ?? 0;
        const phaseText = formatIndexPhase(progress.phase);
        const currentFile = basenameFromPath(progress.currentFile);
        const currentFileText = currentFile ? ` | ${currentFile}` : "";
        const estimateText = estimatedFinalBytes
          ? ` | est ${formatByteSize(estimatedFinalBytes)}`
          : "";
        const etaText = computeEmbeddingEtaText(
          job,
          progress.phase,
          embedded,
          embeddingPending,
        );
        const progressLine = `${Math.round(percent)}% | ${processed}/${scanned} files | ${chunks} passages touched | ${embedded} generated this run | ${embeddingPending} missing now${estimateText}${etaText}`;
        setLibraryIndexProgress(percent, progressLine);
        setLibraryIndexButtons(job.status === "running");
        renderIndexJobGrid({
          phase: phaseText,
          progress: `${Math.round(percent)}%`,
          files: scanned
            ? `${formatMetricNumber(processed)} / ${formatMetricNumber(scanned)}`
            : "--",
          passages: formatMetricNumber(chunks),
          embeddings: formatMetricNumber(embedded),
          pending: formatMetricNumber(embeddingPending),
          errors: formatMetricNumber(jobErrors),
          embeddingErrors: formatMetricNumber(embeddingErrors),
          skipped: `${formatMetricNumber(skippedUnchanged)} unchanged | ${formatMetricNumber(skippedDocs)} docs`,
          currentFile: currentFile || "--",
          recentIssues: formatRecentIndexIssues(recentIssues),
        });
        if (job.status === "running") {
          const preflightError =
            progress.embeddingPreflightError || stats.embeddingPreflightError;
          const embeddingText = preflightError ? ` ${preflightError}` : "";
          const lastEmbeddingError = progress.lastEmbeddingError
            ? ` Last embedding error: ${progress.lastEmbeddingError}`
            : "";
          const actionText = job.retryEmbeddings
            ? "Retrying missing embeddings"
            : job.force
              ? "Reindexing all sources"
              : "Indexing changed sources";
          statusEl.textContent = `${actionText}: ${phaseText}${currentFileText}.${embeddingText}${lastEmbeddingError}`;
          return;
        }
        if (job.status === "completed") {
          const errors = Array.isArray(stats.errors) ? stats.errors.length : 0;
          const readiness = getEmbeddingReadinessFromStatus(savedStatus);
          const completedPending =
            savedStatus && !savedStatus.error
              ? readiness.missing
              : (stats.embeddingPending ??
                Math.max(
                  0,
                  Number(stats.chunks || chunks || 0) -
                    Number(stats.embedded || embedded || 0) -
                    Number(embeddingErrors || 0) -
                    Number(stats.embeddingsSkipped || 0),
                ));
          const preflightError = stats.embeddingPreflightError
            ? ` ${stats.embeddingPreflightError}`
            : "";
          const readinessText = formatEmbeddingReadiness(savedStatus);
          statusEl.textContent = `Index completed: ${formatMetricNumber(stats.indexed || 0)} indexed this run, ${formatMetricNumber(stats.skipped || 0)} unchanged, ${formatMetricNumber(skippedDocs)} skipped documents, ${formatMetricNumber(stats.embedded || embedded)} embeddings generated this run, ${formatMetricNumber(completedPending)} missing now, ${formatMetricNumber(embeddingErrors)} embedding failures, ${formatMetricNumber(errors)} file errors.${readinessText ? ` ${readinessText}` : ""}${preflightError}`;
          setLibraryIndexProgress(100, "100%");
          renderIndexJobGrid({
            phase: "Completed",
            progress: "100%",
            files: scanned
              ? `${formatMetricNumber(processed)} / ${formatMetricNumber(scanned)}`
              : "--",
            passages: formatMetricNumber(stats.chunks || chunks),
            embeddings: formatMetricNumber(stats.embedded || embedded),
            pending: formatMetricNumber(completedPending),
            errors: formatMetricNumber(errors),
            embeddingErrors: formatMetricNumber(embeddingErrors),
            skipped: `${formatMetricNumber(stats.skipped || skippedUnchanged)} unchanged | ${formatMetricNumber(skippedDocs)} docs`,
            currentFile: "--",
            recentIssues: formatRecentIndexIssues(recentIssues),
          });
          return;
        }
        if (job.status === "paused") {
          statusEl.textContent =
            "INDEX PAUSED — nothing is being indexed right now. Press Build / Update Index to resume from where it stopped.";
          renderIndexJobGrid({
            phase: "Paused",
            progress: `${Math.round(percent)}%`,
            files: scanned
              ? `${formatMetricNumber(processed)} / ${formatMetricNumber(scanned)}`
              : "--",
            passages: formatMetricNumber(chunks),
            embeddings: formatMetricNumber(embedded),
            pending: formatMetricNumber(embeddingPending),
            errors: formatMetricNumber(jobErrors),
            embeddingErrors: formatMetricNumber(embeddingErrors),
            skipped: `${formatMetricNumber(skippedUnchanged)} unchanged | ${formatMetricNumber(skippedDocs)} docs`,
            currentFile: "--",
            recentIssues: formatRecentIndexIssues(recentIssues),
          });
          return;
        }
        if (job.status === "cancelled") {
          statusEl.textContent = "Index cancelled.";
          renderIndexJobGrid({
            phase: "Cancelled",
            progress: `${Math.round(percent)}%`,
            files: scanned
              ? `${formatMetricNumber(processed)} / ${formatMetricNumber(scanned)}`
              : "--",
            passages: formatMetricNumber(chunks),
            embeddings: formatMetricNumber(embedded),
            pending: formatMetricNumber(embeddingPending),
            errors: formatMetricNumber(jobErrors),
            embeddingErrors: formatMetricNumber(embeddingErrors),
            skipped: `${formatMetricNumber(skippedUnchanged)} unchanged | ${formatMetricNumber(skippedDocs)} docs`,
            currentFile: "--",
            recentIssues: formatRecentIndexIssues(recentIssues),
          });
          return;
        }
        statusEl.textContent = `Index failed: ${job.error || "unknown error"}`;
        renderIndexJobGrid({
          phase: "Failed",
          progress: `${Math.round(percent)}%`,
          files: scanned
            ? `${formatMetricNumber(processed)} / ${formatMetricNumber(scanned)}`
            : "--",
          passages: formatMetricNumber(chunks),
          embeddings: formatMetricNumber(embedded),
          pending: formatMetricNumber(embeddingPending),
          errors: formatMetricNumber(jobErrors || 1),
          embeddingErrors: formatMetricNumber(embeddingErrors),
          skipped: `${formatMetricNumber(skippedUnchanged)} unchanged | ${formatMetricNumber(skippedDocs)} docs`,
          currentFile: "--",
          recentIssues: formatRecentIndexIssues(recentIssues),
        });
      }

      async function pollLibraryIndexJob() {
        try {
          const res = await fetch(apiUrl("/api/library/index"));
          const payload = await readJsonResponse(res, "Load index job");
          // Track if a job is present globally to prevent snapshot from overwriting it
          window.activeLibraryIndexJob = payload?.job || null;
          renderLibraryIndexJob(payload);
          if (payload?.running) {
            libraryIndexPollTimer = window.setTimeout(
              pollLibraryIndexJob,
              2000,
            );
          } else {
            await loadLibraryStatus();
          }
        } catch (error) {
          console.error("Could not poll index job", error);
        }
      }

      // Human explanation for a failed embedding preflight, so nobody has to
      // dig through logs to learn the embedding server simply is not running.
      function describeEmbeddingProblem(check) {
        const where = check.baseUrl || "the configured embedding server";
        const model = check.model || "the configured embedding model";
        const raw = String(check.error || "");
        if (
          /ECONNREFUSED|timed out|ENOTFOUND|EHOSTUNREACH|fetch failed/i.test(
            raw,
          )
        ) {
          return (
            `The embedding server at ${where} is not responding.\n\n` +
            `Start the app that serves your embedding model (LM Studio or ` +
            `Ollama) and make sure "${model}" is loaded, or correct the ` +
            `Embedding Server URL in Settings > Database.`
          );
        }
        if (/404|not found|no such model|model .* not/i.test(raw)) {
          return (
            `The server at ${where} answered, but the embedding model ` +
            `"${model}" is not available on it.\n\n` +
            `Load or pull that model, or set a different Embedding Model in ` +
            `Settings > Database.`
          );
        }
        if (/sqlite-vec|loadable extension/i.test(raw)) {
          return raw;
        }
        return (
          `Embedding check failed:\n${raw || "unknown error"}\n\n` +
          `Verify the Embedding Server URL and Embedding Model in ` +
          `Settings > Database.`
        );
      }

      async function startLibraryIndex(force = false, extraOptions = {}) {
        const saved = await saveLibrarySettingsFromForm();
        if (!saved) return;
        // Preflight EVERYTHING before starting, so every misconfiguration is
        // a plain-language dialog instead of a silent no-op or a crippled
        // index the user only discovers hours later.
        let pre = null;
        try {
          const res = await fetch(apiUrl("/api/library/preflight"));
          pre = await readJsonResponse(res, "Index preflight");
        } catch (_e) {
          // The preflight itself failing must never block indexing.
        }
        if (pre) {
          const retryRun = extraOptions.retryEmbeddings === true;
          if (!(pre.sourcesConfigured > 0)) {
            await appAlert(
              "No library folder is selected, so there is nothing to " +
                "index.\n\nAdd the folder that contains your books under " +
                "Settings > Database, then press Build / Update Index again.",
              "Database — no folder selected",
            );
            return;
          }
          if (Array.isArray(pre.missingPaths) && pre.missingPaths.length) {
            await appAlert(
              "The configured library folder does not exist:\n\n" +
                pre.missingPaths.join("\n") +
                "\n\nCorrect the path in Settings > Database, then press " +
                "Build / Update Index again.",
              "Database — folder not found",
            );
            return;
          }
          if (!(pre.fileCount > 0)) {
            await appAlert(
              "The configured library folder contains no supported files, " +
                "so there is nothing to index.\n\nCheck the folder path and " +
                "the file extensions configured in Settings > Database.",
              "Database — no files to index",
            );
            return;
          }
          const emb = pre.embedding || {};
          if (!emb.configured) {
            if (retryRun) {
              await appAlert(
                "Retry Embeddings needs an embedding model. Set the " +
                  "Embedding Server URL and Embedding Model in " +
                  "Settings > Database first.",
                "Database — no embedding model",
              );
              return;
            }
            const proceed = await appConfirm(
              "No embedding model is configured, so this index would be " +
                "KEYWORD-ONLY: searches will match exact words, but " +
                "semantic search (finding passages by meaning) will not " +
                "work.\n\nTo enable semantic search, set the Embedding " +
                "Server URL and Embedding Model in Settings > Database " +
                "before indexing.",
              "Database — no embedding model",
              { confirmLabel: "Index keyword-only", danger: true },
            );
            if (!proceed) return;
          } else if (!emb.ready) {
            if (retryRun) {
              await appAlert(
                describeEmbeddingProblem(emb) +
                  "\n\nFix the problem, then press Retry Embeddings again.",
                "Database — embeddings unavailable",
              );
              return;
            }
            const proceed = await appConfirm(
              describeEmbeddingProblem(emb) +
                "\n\nYou can fix the problem and press Build / Update Index " +
                "again, or continue now with KEYWORD-ONLY indexing (no " +
                "semantic search for the affected passages).",
              "Database — embeddings unavailable",
              { confirmLabel: "Index keyword-only", danger: true },
            );
            if (!proceed) return;
          }
          // Final gate: state exactly what is about to happen.
          const embLine = emb.configured
            ? emb.ready
              ? `Embeddings: ${emb.model} at ${emb.baseUrl}` +
                (emb.dimensions ? ` (${emb.dimensions} dimensions)` : "")
              : "Embeddings: UNAVAILABLE — indexing keyword-only"
            : "Embeddings: none configured — indexing keyword-only";
          const actionLine = retryRun
            ? "Retry missing embeddings for the existing index."
            : force
              ? "Rebuild the ENTIRE index from scratch."
              : pre.indexedFiles > 0
                ? `Update the index (${formatMetricNumber(pre.indexedFiles)} files already indexed; unchanged files are skipped).`
                : "Build a new index.";
          const start = await appConfirm(
            `${actionLine}\n\n` +
              `Files found: ${formatMetricNumber(pre.fileCount)}\n` +
              `${embLine}\n` +
              `Index file: ${pre.databasePath || "default location"}`,
            "Database — start indexing?",
            { confirmLabel: retryRun ? "Retry embeddings" : "Start indexing" },
          );
          if (!start) return;
        }
        if (libraryIndexPollTimer) clearTimeout(libraryIndexPollTimer);
        try {
          const payload = await postJson(
            "/api/library/index",
            { force, prune: true, compact: true, ...extraOptions },
            force ? "Start library reindex" : "Start library index",
          );
          renderLibraryIndexJob(payload);
          libraryIndexPollTimer = window.setTimeout(pollLibraryIndexJob, 1000);
        } catch (error) {
          console.error("Could not start index job", error);
          await appAlert(
            error.message || "Failed to start index job.",
            "Database",
          );
        }
      }

      async function retryLibraryEmbeddings() {
        await startLibraryIndex(false, { retryEmbeddings: true });
      }

      async function cancelLibraryIndex() {
        try {
          const payload = await postJson(
            "/api/library/index/cancel",
            {},
            "Pause library index",
          );
          renderLibraryIndexJob(payload);
          if (libraryIndexPollTimer) clearTimeout(libraryIndexPollTimer);
          libraryIndexPollTimer = window.setTimeout(pollLibraryIndexJob, 1000);
        } catch (error) {
          console.error("Could not pause index job", error);
          await appAlert(
            error.message || "Failed to pause index job.",
            "Database",
          );
        }
      }

      function addDatabaseSource() {
        databaseConfig = collectDatabaseConfigFromForm();
        databaseConfig.sources.push({
          name: `Source ${databaseConfig.sources.length + 1}`,
          type: "document",
          path: "",
          extensions: [".md", ".txt"],
        });
        renderDatabaseConfigForm();
      }

      function removeDatabaseSource(index) {
        databaseConfig = collectDatabaseConfigFromForm();
        databaseConfig.sources.splice(index, 1);
        renderDatabaseConfigForm();
      }

      function getLibraryRequestPayload() {
        const payload = collectLibrarySettingsFromForm();
        const fileIds = getBookFilterFileIds(mode);
        if (fileIds.length) payload.fileIds = fileIds;
        return payload;
      }

      // BOOK FILTER (per-mode restriction of database passages to <=10 books)
      const BOOK_FILTER_MAX = 10;
      const BOOK_FILTER_STORAGE_KEY = "dive-book-filters";
      let bookFilterSelections = { ollama: [], pi: [], cloud: [] };
      let bookFilterDraft = [];
      let bookFilterSuggestTimer = null;

      function sanitizeBookFilterList(list) {
        const seen = new Set();
        const books = [];
        for (const item of Array.isArray(list) ? list : []) {
          const id = Number.parseInt(item?.id, 10);
          if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
          seen.add(id);
          books.push({
            id,
            title: String(item?.title || "Untitled"),
            author: String(item?.author || ""),
          });
          if (books.length >= BOOK_FILTER_MAX) break;
        }
        return books;
      }

      function loadBookFilterSelections() {
        try {
          const raw = JSON.parse(
            localStorage.getItem(BOOK_FILTER_STORAGE_KEY) || "{}",
          );
          for (const key of ["ollama", "pi", "cloud"]) {
            bookFilterSelections[key] = sanitizeBookFilterList(raw?.[key]);
          }
        } catch (_e) {
          bookFilterSelections = { ollama: [], pi: [], cloud: [] };
        }
      }

      function saveBookFilterSelections() {
        try {
          localStorage.setItem(
            BOOK_FILTER_STORAGE_KEY,
            JSON.stringify(bookFilterSelections),
          );
        } catch (_e) {}
      }

      function getBookFilterFileIds(modeKey) {
        return (bookFilterSelections[modeKey] || []).map((book) => book.id);
      }

      function isDatabaseContextEnabledNow() {
        const input = document.getElementById("librarySearchEnabledInput");
        if (input) return input.checked === true;
        return librarySettings.enabled === true;
      }

      function updateBookFilterUi() {
        const btn = document.getElementById("bookFilterBtn");
        if (!btn) return;
        btn.style.display = isDatabaseContextEnabledNow() ? "" : "none";
        const count = getBookFilterFileIds(mode).length;
        const active = count > 0;
        // Active state fills the button with the accent and shows the count;
        // the CSS hides the number entirely when no filter is set.
        btn.classList.toggle("active", active);
        const countEl = document.getElementById("bookFilterCount");
        if (countEl) countEl.textContent = active ? String(count) : "";
        btn.title = active
          ? `Book filter active (${count} book(s)) — chat is restricted`
          : "Restrict database search to specific books";
      }

      function renderBookFilterSuggestions(files) {
        const container = document.getElementById("bookFilterSuggestions");
        if (!container) return;
        container.innerHTML = "";
        const selectedIds = new Set(bookFilterDraft.map((book) => book.id));
        for (const file of (Array.isArray(files) ? files : [])
          .filter((file) => !selectedIds.has(Number(file.id)))
          .slice(0, 8)) {
          const item = document.createElement("button");
          item.type = "button";
          item.className = "book-filter-suggestion";
          item.textContent =
            file.title + (file.author ? ` — ${file.author}` : "");
          item.addEventListener("click", () => {
            addBookToFilterDraft({
              id: Number(file.id),
              title: String(file.title || "Untitled"),
              author: String(file.author || ""),
            });
          });
          container.appendChild(item);
        }
      }

      function renderBookFilterDraft() {
        const list = document.getElementById("bookFilterSelectedList");
        if (!list) return;
        list.innerHTML = "";
        if (!bookFilterDraft.length) {
          const empty = document.createElement("div");
          empty.className = "book-filter-empty";
          empty.textContent =
            "No books selected — the whole library is searched.";
          list.appendChild(empty);
        }
        bookFilterDraft.forEach((book, index) => {
          const row = document.createElement("div");
          row.className = "book-filter-row";
          const label = document.createElement("span");
          label.className = "book-filter-row-label";
          label.textContent =
            book.title + (book.author ? ` — ${book.author}` : "");
          const removeBtn = document.createElement("button");
          removeBtn.type = "button";
          removeBtn.className = "book-filter-remove-btn";
          removeBtn.textContent = "✕";
          removeBtn.setAttribute("aria-label", `Remove ${book.title}`);
          removeBtn.addEventListener("click", () => {
            bookFilterDraft.splice(index, 1);
            renderBookFilterDraft();
          });
          row.appendChild(label);
          row.appendChild(removeBtn);
          list.appendChild(row);
        });
        const atMax = bookFilterDraft.length >= BOOK_FILTER_MAX;
        const input = document.getElementById("bookFilterSearchInput");
        if (input) {
          input.disabled = atMax;
          if (atMax) input.value = "";
        }
        const warning = document.getElementById("bookFilterMaxWarning");
        if (warning) warning.style.display = atMax ? "" : "none";
        if (atMax) renderBookFilterSuggestions([]);
      }

      function addBookToFilterDraft(book) {
        if (bookFilterDraft.length >= BOOK_FILTER_MAX) return;
        if (bookFilterDraft.some((item) => item.id === book.id)) return;
        bookFilterDraft.push(book);
        const input = document.getElementById("bookFilterSearchInput");
        if (input) input.value = "";
        renderBookFilterSuggestions([]);
        renderBookFilterDraft();
      }

      async function fetchBookFilterSuggestions(term) {
        try {
          const res = await fetch(apiUrl("/api/library/files/search"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: term }),
          });
          const data = await readJsonResponse(res, "Search library books");
          renderBookFilterSuggestions(
            Array.isArray(data?.files) ? data.files : [],
          );
        } catch (error) {
          console.error("Book title search failed", error);
          renderBookFilterSuggestions([]);
        }
      }

      function openBookFilterPanel() {
        bookFilterDraft = (bookFilterSelections[mode] || []).map((book) => ({
          ...book,
        }));
        const label = document.getElementById("bookFilterModeLabel");
        if (label) label.textContent = mode.toUpperCase();
        const input = document.getElementById("bookFilterSearchInput");
        if (input) input.value = "";
        renderBookFilterSuggestions([]);
        renderBookFilterDraft();
        const overlay = document.getElementById("bookFilterOverlay");
        if (overlay) overlay.style.display = "flex";
        if (input && !input.disabled) input.focus();
      }

      function closeBookFilterPanel() {
        const overlay = document.getElementById("bookFilterOverlay");
        if (overlay) overlay.style.display = "none";
      }

      function applyBookFilterDraft() {
        bookFilterSelections[mode] = bookFilterDraft.map((book) => ({
          ...book,
        }));
        saveBookFilterSelections();
        updateBookFilterUi();
        closeBookFilterPanel();
      }

      loadBookFilterSelections();

      function normalizeFontStack(fontStack) {
        const trimmed = typeof fontStack === "string" ? fontStack.trim() : "";
        return trimmed || DEFAULT_UI_FONTS.ollama;
      }

      const FONT_PRESETS = [
        { id: "space-mono", stack: '"Space Mono", monospace' },
        { id: "ia-writer-quattro-s", stack: '"iA Writer Quattro S", serif' },
        { id: "montserrat", stack: "Montserrat, sans-serif" },
        { id: "sen", stack: "Sen, sans-serif" },
        { id: "ia-writer-duo-s", stack: '"iA Writer Duo S", sans-serif' },
        { id: "ibm-plex-serif", stack: '"IBM Plex Serif", serif' },
        { id: "ibarra-real-nova", stack: '"Ibarra Real Nova", serif' },
        { id: "lora", stack: "Lora, serif" },
        { id: "ia-writer-mono-s", stack: '"iA Writer Mono S", monospace' },
        { id: "marcellus", stack: "Marcellus, serif" },
      ];

      function normalizeFontForCompare(fontStack) {
        return normalizeFontStack(fontStack)
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
      }

      function getPresetStackById(presetId) {
        const preset = FONT_PRESETS.find((item) => item.id === presetId);
        return preset ? preset.stack : null;
      }

      function getPresetIdByStack(fontStack) {
        const normalized = normalizeFontForCompare(fontStack);
        const matched = FONT_PRESETS.find(
          (item) => normalizeFontForCompare(item.stack) === normalized,
        );
        return matched ? matched.id : "custom";
      }

      function syncFontControls(scope, fontStack) {
        const ids = {
          ollama: ["settingOllamaFontPreset", "settingOllamaFontCustom"],
          pi: ["settingPiFontPreset", "settingPiFontCustom"],
          cloud: ["settingCloudFontPreset", "settingCloudFontCustom"],
          lmstudio: ["lmStudioFontPreset", "lmStudioFontCustom"],
          llamacpp: ["llamaCppFontPreset", "llamaCppFontCustom"],
        }[scope];
        if (!ids) return;
        const presetSelect = document.getElementById(ids[0]);
        const customInput = document.getElementById(ids[1]);
        if (!presetSelect || !customInput) return;
        const presetId = getPresetIdByStack(fontStack);
        presetSelect.value = presetId;
        if (presetId === "custom") {
          customInput.style.display = "";
          customInput.value = normalizeFontStack(fontStack);
        } else {
          customInput.style.display = "none";
        }
        refreshCustomSelectUi(presetSelect);
      }

      function applyFont(fontStack) {
        document.documentElement.style.setProperty(
          "--ui-font",
          normalizeFontStack(fontStack),
        );
      }

      function changeOllamaFont(fontStack) {
        ollamaFont = normalizeFontStack(fontStack);
        localStorage.setItem("ollama-pi-chat-ollama-font", ollamaFont);
        saveUiSettingsSoon();
        syncFontControls("ollama", ollamaFont);
        if (mode === "ollama") applyFont(ollamaFont);
      }

      function changePiFont(fontStack) {
        piFont = normalizeFontStack(fontStack);
        localStorage.setItem("ollama-pi-chat-pi-font", piFont);
        saveUiSettingsSoon();
        syncFontControls("pi", piFont);
        if (mode === "pi") applyFont(piFont);
      }

      function changeCloudFont(fontStack) {
        cloudFont = normalizeFontStack(fontStack);
        localStorage.setItem("ollama-pi-chat-cloud-font", cloudFont);
        saveUiSettingsSoon();
        syncFontControls("cloud", cloudFont);
        if (mode === "cloud") applyFont(cloudFont);
      }

      function onOllamaFontPresetChange(presetId) {
        if (presetId === "custom") {
          const customInput = document.getElementById(
            "settingOllamaFontCustom",
          );
          customInput.style.display = "";
          customInput.value = ollamaFont;
          customInput.focus();
          customInput.select();
          return;
        }
        const presetStack = getPresetStackById(presetId);
        if (presetStack) changeOllamaFont(presetStack);
      }

      function onPiFontPresetChange(presetId) {
        if (presetId === "custom") {
          const customInput = document.getElementById("settingPiFontCustom");
          customInput.style.display = "";
          customInput.value = piFont;
          customInput.focus();
          customInput.select();
          return;
        }
        const presetStack = getPresetStackById(presetId);
        if (presetStack) changePiFont(presetStack);
      }

      function onCloudFontPresetChange(presetId) {
        if (presetId === "custom") {
          const customInput = document.getElementById("settingCloudFontCustom");
          customInput.style.display = "";
          customInput.value = cloudFont;
          customInput.focus();
          customInput.select();
          return;
        }
        const presetStack = getPresetStackById(presetId);
        if (presetStack) changeCloudFont(presetStack);
      }

      function changeLmstudioFont(fontStack) {
        lmstudioFont = normalizeFontStack(fontStack);
        localStorage.setItem("ollama-pi-chat-lmstudio-font", lmstudioFont);
        saveUiSettingsSoon();
        syncFontControls("lmstudio", lmstudioFont);
        if (mode === "lmstudio") applyFont(lmstudioFont);
      }

      function changeLlamacppFont(fontStack) {
        llamacppFont = normalizeFontStack(fontStack);
        localStorage.setItem("ollama-pi-chat-llamacpp-font", llamacppFont);
        saveUiSettingsSoon();
        syncFontControls("llamacpp", llamacppFont);
        if (mode === "llamacpp") applyFont(llamacppFont);
      }

      function onLocalFontPresetChange(scope, presetId, customId, currentFont) {
        if (presetId === "custom") {
          const customInput = document.getElementById(customId);
          customInput.style.display = "";
          customInput.value = currentFont;
          customInput.focus();
          customInput.select();
          return;
        }
        const presetStack = getPresetStackById(presetId);
        if (!presetStack) return;
        if (scope === "lmstudio") changeLmstudioFont(presetStack);
        else changeLlamacppFont(presetStack);
      }

      function applyPalette(p) {
        document.documentElement.setAttribute("data-palette", p);
      }

      async function refreshOllamaModelContext() {
        const used =
          typeof ollamaTokenState.used === "number" ? ollamaTokenState.used : 0;
        ollamaTokenState = { used, total: ollamaOptions.numCtx };
        if (mode === "ollama") {
          updateTokenCounter("ollama");
        }
      }

      // MODELS AND MODE
      async function loadModels() {
        // Ollama's model list is only useful when Ollama mode can be used at
        // all — don't ping a server the user never enabled.
        if (!enabledModes.includes("ollama")) {
          availableOllamaModels = [];
          return;
        }
        try {
          const res = await fetch(apiUrl("/api/models"));
          const payload = await readJsonResponse(res, "Load models");
          // New shape: { models, offline }. Legacy shape: bare array.
          const models = Array.isArray(payload) ? payload : payload?.models;
          ollamaOffline = payload?.offline === true;
          availableOllamaModels = Array.isArray(models) ? models : [];
          const savedModel = localStorage.getItem(MODEL_STORAGE_KEY) || "";
          if (!savedModel || !availableOllamaModels.includes(savedModel)) {
            if (availableOllamaModels.length > 0) {
              localStorage.setItem(MODEL_STORAGE_KEY, availableOllamaModels[0]);
            }
          }
          // NEVER write into the topbar select directly: it is shared by every
          // mode, and this fetch can resolve while another mode (LM Studio,
          // llama.cpp, Cloud) is active — which used to replace that mode's
          // model list with Ollama's. The mode-aware renderer is the only
          // writer, and only when Ollama is actually the active mode.
          if (mode === "ollama") {
            populateTopbarModelSelect();
            if (typeof syncCustomSelect === "function")
              syncCustomSelect(modelSelect);
          }
          renderOllamaModelSelect();
          renderDatabaseConfigForm();
          await refreshOllamaModelContext();
        } catch (e) {
          console.error("Could not load models", e);
        }
      }

      // The topbar model dropdown is shared across modes that pick a model
      // (Ollama, LM Studio, llama.cpp, Cloud). It is repopulated per mode.
      function populateTopbarModelSelect() {
        if (!modelSelect) return;
        modelSelect.innerHTML = "";
        const addOpt = (value, label) => {
          const o = document.createElement("option");
          o.value = value;
          o.textContent = label;
          modelSelect.appendChild(o);
        };
        if (mode === "ollama") {
          const saved = localStorage.getItem(MODEL_STORAGE_KEY) || "";
          if (!availableOllamaModels.length) {
            addOpt("", ollamaOffline ? "(Ollama offline)" : "(no models)");
          }
          availableOllamaModels.forEach((m) => addOpt(m, m));
          if (saved && availableOllamaModels.includes(saved)) {
            modelSelect.value = saved;
          } else if (availableOllamaModels.length) {
            modelSelect.value = availableOllamaModels[0];
          }
        } else if (LOCAL_MODE_IDS.includes(mode)) {
          const list = localModelsCache[mode] || [];
          addOpt("", list.length ? "Automatic" : "(no models — Refresh)");
          list.forEach((m) => addOpt(m, m));
          modelSelect.value = localModelConfig[mode].model || "";
        } else if (mode === "cloud") {
          // Only list providers that actually have an API key saved (or set via
          // env) — you can't use a model without a key.
          const withKeys = Object.keys(CLOUD_DEFAULT_MODELS).filter(
            (p) => cloudSettings.hasApiKey?.[p],
          );
          if (!withKeys.length) {
            addOpt("", "No API key — add one in Settings");
            modelSelect.value = "";
          } else {
            for (const p of withKeys) {
              const m = cloudSettings.models?.[p] || CLOUD_DEFAULT_MODELS[p];
              addOpt(p, `${getCloudProviderLabel(p)} · ${m}`);
            }
            modelSelect.value = withKeys.includes(cloudSettings.provider)
              ? cloudSettings.provider
              : withKeys[0];
          }
        } else if (mode === "pi") {
          if (!piAvailableModels.length) {
            addOpt("", "(loading Pi models…)");
            modelSelect.value = "";
          } else {
            piAvailableModels.forEach((m) => {
              const value = piModelValue(m);
              addOpt(value, m.name ? `${m.name}` : value);
            });
            if (
              piCurrentModelValue &&
              piAvailableModels.some(
                (m) => piModelValue(m) === piCurrentModelValue,
              )
            ) {
              modelSelect.value = piCurrentModelValue;
            }
          }
        }
        if (typeof syncCustomSelect === "function")
          syncCustomSelect(modelSelect);
      }

      // Ollama's Settings model dropdown mirrors the top-bar picker: both read
      // and write the same MODEL_STORAGE_KEY, so changing either updates the
      // other. Populated from the same availableOllamaModels list.
      function renderOllamaModelSelect() {
        const sel = document.getElementById("ollamaModelSelect");
        if (!sel) return;
        const saved = localStorage.getItem(MODEL_STORAGE_KEY) || "";
        sel.innerHTML = "";
        const addOpt = (value, label) => {
          const o = document.createElement("option");
          o.value = value;
          o.textContent = label;
          sel.appendChild(o);
        };
        if (!availableOllamaModels.length) {
          addOpt(
            "",
            ollamaOffline ? "(Ollama offline)" : "(no models — Refresh)",
          );
        }
        availableOllamaModels.forEach((m) => addOpt(m, m));
        if (saved && availableOllamaModels.includes(saved)) {
          sel.value = saved;
        } else if (availableOllamaModels.length) {
          sel.value = availableOllamaModels[0];
        }
        if (typeof refreshCustomSelectUi === "function") {
          refreshCustomSelectUi(sel);
        }
      }

      async function onTopbarModelChange() {
        const val = modelSelect.value;
        if (mode === "ollama") {
          if (val) localStorage.setItem(MODEL_STORAGE_KEY, val);
          renderOllamaModelSelect();
          await refreshOllamaModelContext();
        } else if (LOCAL_MODE_IDS.includes(mode)) {
          localModelConfig[mode].model = val;
          const els = localModeEls(mode);
          if (els.select) els.select.value = val;
          saveLocalModeSettings();
        } else if (mode === "cloud") {
          // Ignore the "No API key" placeholder; only switch to a real provider.
          if (val) {
            cloudSettings.provider = val;
            renderCloudSettingsForm();
            await saveCloudSettingsUi();
          }
        } else if (mode === "pi") {
          const idx = val.indexOf("/");
          if (idx > 0) {
            const provider = val.slice(0, idx);
            const modelId = val.slice(idx + 1);
            piCurrentModelValue = val;
            try {
              await callPiCommand({ type: "set_model", provider, modelId });
              refreshPiStatus().catch(() => {});
            } catch (_e) {}
          }
        }
        updateModeStatus();
      }

      modelSelect.addEventListener("change", () => {
        onTopbarModelChange();
      });

      function getCloudProviderLabel(provider) {
        if (provider === "anthropic") return "Claude";
        if (provider === "mistral") return "Mistral";
        if (provider === "google") return "Google Gemini";
        return "OpenAI";
      }

      function formatTitleCase(value) {
        if (!value) return "";
        return String(value).charAt(0).toUpperCase() + String(value).slice(1);
      }

      function updateModeStatus() {
        const statusEl = document.getElementById("modeStatus");
        if (!statusEl) return;
        const piSect = document.getElementById("sidePiStatusSect");
        const modelSect = document.getElementById("sideModelSect");
        if (piSect) {
          piSect.style.display = mode === "pi" ? "block" : "none";
        }
        if (modelSect) {
          // Pi feeds the shared model dropdown now — keep the section visible.
          modelSect.style.display = "block";
        }
        if (mode === "ollama") {
          statusEl.textContent = "";
          statusEl.title = "";
          return;
        }
        if (LOCAL_MODE_IDS.includes(mode)) {
          // The topbar model + prompt dropdowns convey the state; no status text.
          statusEl.textContent = "";
          statusEl.title = "";
          return;
        }
        if (mode === "pi") {
          const modelName = piStatusInfo?.model || "Model ?";
          const state = piStatusInfo?.state || "IDLE";
          const cost = piStatusInfo?.cost || "Cost ?";
          const think = piStatusInfo?.thinkingLevel
            ? formatTitleCase(piStatusInfo.thinkingLevel)
            : "?";
          statusEl.textContent = "";
          statusEl.title = "";
          return;
        }
        const provider = cloudSettings.provider || "openai";
        const modelName =
          cloudSettings.models?.[provider] || CLOUD_DEFAULT_MODELS[provider];
        const keyStatus = cloudSettings.hasApiKey?.[provider]
          ? "Key saved"
          : "No API key";
        statusEl.textContent = `Cloud: ${getCloudProviderLabel(provider)} | ${modelName} | ${cloudStreamState} | ${keyStatus}`;
        statusEl.title = statusEl.textContent;
      }

      async function refreshPiStatus() {
        if (mode !== "pi" || !currentConvId) {
          updateModeStatus();
          return;
        }
        try {
          const res = await fetch(apiUrl("/api/pi/status"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ saveConv: currentConvId }),
          });
          if (!res.ok) {
            updateModeStatus();
            return;
          }
          const payload = await res.json();
          piStatusInfo = payload?.status || piStatusInfo;

          // Update sidebar status elements
          const thinkSelect = document.getElementById("sidePiThinkSelect");
          if (
            thinkSelect &&
            piStatusInfo?.thinkingLevel &&
            thinkSelect.value !== piStatusInfo.thinkingLevel
          ) {
            thinkSelect.value = piStatusInfo.thinkingLevel;
            if (typeof syncCustomSelect === "function") {
              syncCustomSelect(thinkSelect);
            }
          }
          const stateLine = document.getElementById("sidePiStateLine");
          if (stateLine) {
            const bits = [];
            bits.push(piStatusInfo?.isLocal === true ? "LOCAL" : "CLOUD");
            if (piStatusInfo?.cost && piStatusInfo.cost !== "Local") {
              bits.push(piStatusInfo.cost);
            }
            bits.push(piStatusInfo?.state || "IDLE");
            if (piStatusInfo?.contextUsage?.percent != null) {
              bits.push(`CTX ${piStatusInfo.contextUsage.percent}%`);
            }
            stateLine.textContent = bits.join(" · ");
          }
          // Keep the shared model dropdown in sync with Pi's actual model.
          if (piStatusInfo?.provider && piStatusInfo?.model) {
            piCurrentModelValue = `${piStatusInfo.provider}/${piStatusInfo.model}`;
            if (mode === "pi" && piAvailableModels.length) {
              if (modelSelect && modelSelect.value !== piCurrentModelValue) {
                modelSelect.value = piCurrentModelValue;
                if (typeof syncCustomSelect === "function") {
                  syncCustomSelect(modelSelect);
                }
              }
            }
          }

          if (piStatusInfo?.contextUsage) {
            piTokenState = {
              used: piStatusInfo.contextUsage.used || 0,
              total: piStatusInfo.contextUsage.total || null,
            };
          }
          updateModeStatus();
        } catch (e) {
          updateModeStatus();
        }
      }

      function setMode(m) {
        if (!modeSession[m]) m = "ollama";
        if (typeof collectDatabaseConfigFromForm === "function") {
          try {
            databaseConfig = collectDatabaseConfigFromForm();
            databaseChatModes = databaseConfig.chatModes;
          } catch (_error) {
            // ignore DOM read issues during early initialization
          }
        }
        // Save current mode session state before switching
        syncCurrentSessionState();

        // Attachments are per-mode and independent: stash the current mode's
        // files, then restore the target mode's own files (if any). Files never
        // bleed across modes, but leaving and returning to a mode keeps them.
        pendingFilesByMode[mode] = pendingFiles;
        mode = m;
        pendingFiles = pendingFilesByMode[m] || [];
        renderPendingFileChips();
        const isOllamaMode = m === "ollama";
        const isPiMode = m === "pi";
        const isCloudMode = m === "cloud";
        applyPalette(
          isOllamaMode
            ? ollamaPalette
            : isPiMode
              ? piPalette
              : m === "lmstudio"
                ? lmstudioPalette
                : m === "llamacpp"
                  ? llamacppPalette
                  : cloudPalette,
        );
        applyFont(
          isOllamaMode
            ? ollamaFont
            : isPiMode
              ? piFont
              : m === "lmstudio"
                ? lmstudioFont
                : m === "llamacpp"
                  ? llamacppFont
                  : cloudFont,
        );
        applyFontScale(fontScales[m] || 1);

        document.documentElement.setAttribute("data-mode", m); // Switches the CSS colors

        // Restore the target mode's session state
        const saved = modeSession[m];
        history = saved.convId ? [...saved.history] : [];
        currentConvId = saved.convId || null;
        // The composer draft is per-mode too, so an unsent message in one mode
        // does not appear when switching to another. Setting value directly does
        // not fire the input event, so resize the textarea to match.
        input.value = saved.draft || "";
        if (typeof autoResizeInput === "function") autoResizeInput();
        lastUserMessage = saved.lastUserMessage || null;
        lastSentMessage = saved.lastSentMessage || null;
        lastExchangePersisted =
          saved.lastExchangePersisted !== false ? true : false;

        renderSessionTranscript(saved);
        document.getElementById("btnOllama").className =
          m === "ollama" ? "active" : "";
        document.getElementById("btnPi").className = m === "pi" ? "active" : "";
        document.getElementById("btnCloud").className =
          m === "cloud" ? "active" : "";
        const isLocalMode = LOCAL_MODE_IDS.includes(m);
        MODE_DEFS.forEach((def) => {
          if (LOCAL_MODE_IDS.includes(def.id)) {
            const b = document.getElementById(def.btnId);
            if (b) b.className = m === def.id ? "active" : "";
          }
        });
        // Topbar model dropdown: Ollama, LM Studio, llama.cpp, and Cloud all
        // pick a model here (Pi has none). Prompt dropdown: every prompt mode
        // (Ollama, Cloud, local modes). Pi now feeds the shared model picker
        // too (via its RPC bridge).
        modelSelect.classList.toggle("mode-hidden", false);
        topbarPromptSelect.classList.toggle(
          "mode-hidden",
          !PROMPT_MODE_KEYS.includes(m),
        );
        populateTopbarModelSelect();
        if (isPiMode && !piAvailableModels.length) {
          loadPiTopbarModels();
        }
        if (isLocalMode && (localModelsCache[m] || []).length === 0) {
          fetchLocalModelList(m).catch(() => {});
        }
        if (m === "llamacpp" && typeof refreshLlamaCppManager === "function") {
          refreshLlamaCppManager().catch(() => {});
        }
        updateSettingsTabAvailability({
          isOllamaMode,
          isCloudMode,
          isLocalMode,
          isLlamaCppMode: m === "llamacpp",
        });
        piPaletteGroup.style.display = isPiMode ? "" : "none";
        cloudPaletteGroup.style.display = isCloudMode ? "" : "none";
        ollamaGenGroup.style.display = isOllamaMode ? "" : "none";
        databaseSettingsGroup.style.display = "";
        ollamaFontGroup.style.display = isOllamaMode ? "" : "none";
        piFontGroup.style.display = isPiMode ? "" : "none";
        cloudFontGroup.style.display = isCloudMode ? "" : "none";
        const isPromptMode = PROMPT_MODE_KEYS.includes(m);
        promptSettingsGroup.style.display = isPromptMode ? "" : "none";
        promptManageGroup.style.display = isPromptMode ? "" : "none";
        // Load this mode's own active prompt, then refresh the lists/dropdowns.
        activePromptId = isPromptMode
          ? localStorage.getItem(activePromptStorageKey(m)) || ""
          : "";
        if (typeof renderPromptsList === "function") renderPromptsList();
        if (typeof populatePromptSelect === "function") populatePromptSelect();
        const builtinSkillsGroup =
          document.getElementById("builtinSkillsGroup");
        const customSkillsGroup = document.getElementById("customSkillsGroup");
        if (builtinSkillsGroup) {
          builtinSkillsGroup.style.display =
            isOllamaMode || isCloudMode || isLocalMode ? "" : "none";
        }
        if (customSkillsGroup) {
          customSkillsGroup.style.display =
            isOllamaMode || isLocalMode ? "" : "none";
        }
        const bookSearchConfigGroup = document.getElementById(
          "bookSearchConfigGroup",
        );
        if (bookSearchConfigGroup) {
          bookSearchConfigGroup.style.display =
            isOllamaMode || isCloudMode || isLocalMode ? "" : "none";
        }
        piSettingsGroup.style.display = isPiMode ? "" : "none";
        cloudSettingsGroup.style.display = isCloudMode ? "" : "none";
        const lmStudioSettingsGroup = document.getElementById(
          "lmStudioSettingsGroup",
        );
        const llamaCppSettingsGroup = document.getElementById(
          "llamaCppSettingsGroup",
        );
        // Each local mode's config shows in MAIN only for its own mode, exactly
        // like the Ollama/Pi/Cloud settings groups.
        if (lmStudioSettingsGroup) {
          lmStudioSettingsGroup.style.display = m === "lmstudio" ? "" : "none";
        }
        if (llamaCppSettingsGroup) {
          llamaCppSettingsGroup.style.display = m === "llamacpp" ? "" : "none";
        }
        const llamaCppModelsGroup =
          document.getElementById("llamaCppModelsGroup");
        if (llamaCppModelsGroup) {
          llamaCppModelsGroup.style.display = m === "llamacpp" ? "" : "none";
        }
        if (!isPiMode) {
          piPermissionBtn.style.display = "none";
        } else if (
          activePiPermissionRequest &&
          !piSettings.permissionUx.autoOpen
        ) {
          piPermissionBtn.style.display = "";
        }
        if (!isOllamaMode && mcpOpen) {
          toggleMcp();
        }
        document.getElementById("uploadBtn").style.display = "";
        if (!isOllamaMode) closePromptEditor();
        if (historyOpen) {
          loadHistoryPanel();
        }
        if (isOllamaMode) {
          refreshOllamaModelContext().catch(() => {});
        }
        if (isPiMode) {
          refreshPiStatus().catch(() => {});
        } else {
          updateModeStatus();
        }
        syncSearchAlgorithmModeToChatMode();
        renderDatabaseConfigForm();
        updateBookFilterUi();
        refreshSidePanel();
        ensurePiEventChannel();
        updateTokenCounter();
        updateSendButtonState();
        // Lessons are per-mode: entering a mode rebinds the Lessons editor
        // to THIS mode's file, so another mode's lessons can never carry
        // over (covers switching modes while Settings is open).
        if (typeof loadLessonsUi === "function") {
          loadLessonsUi().catch(() => {});
        }
        // Same for the editable system prompts: rebind to this mode's own
        // override files.
        if (typeof loadSystemPromptsUi === "function") {
          loadSystemPromptsUi().catch(() => {});
        }
      }

      function clearChat() {
        if (currentConvId && mode === "pi") {
          fetch(apiUrl("/api/pi/new-session"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ saveConv: currentConvId }),
          }).catch(console.error);
        }
        if (mode === "ollama") {
          ollamaTokenState = { used: null, total: null };
        } else if (mode === "pi") {
          piTokenState = { used: null, total: null };
          piStatusInfo = null;
        } else if (mode === "lmstudio") {
          lmstudioTokenState = { used: null, total: null };
        } else if (mode === "llamacpp") {
          llamacppTokenState = { used: null, total: null };
        } else {
          cloudTokenState = { used: null, total: null };
          cloudStreamState = "IDLE";
        }
        // Wipe the saved session for this mode so switching back doesn't restore it
        clearModeSession(mode);
        chat.innerHTML = "";
        history = [];
        currentConvId = null;
        lastUserMessage = null;
        lastSentMessage = null;
        lastExchangePersisted = true;
        clearPendingFiles();
        ensurePiEventChannel();
        if (typeof updateDownloadButtonState === "function") {
          updateDownloadButtonState();
        }
        if (typeof updateTokenCounter === "function") updateTokenCounter();
      }

      function hidePiPermissionModal() {
        document.getElementById("piPermissionModal").style.display = "none";
      }

      function clearPiPermissionState() {
        if (activePiPermissionTimer) {
          clearTimeout(activePiPermissionTimer);
          activePiPermissionTimer = null;
        }
        activePiPermissionRequest = null;
        activePiPermissionResolver = null;
        piPermissionBtn.style.display = "none";
      }

      function resolvePiPermission(response) {
        const resolver = activePiPermissionResolver;
        if (typeof resolver === "function") {
          const request = activePiPermissionRequest;
          hidePiPermissionModal();
          clearPiPermissionState();
          resolver({
            type: "extension_ui_response",
            id: request?.id,
            ...response,
          });
        }
      }

      function renderAndOpenPiPermissionModal(request) {
        if (!request) return;
        const modal = document.getElementById("piPermissionModal");
        const titleEl = document.getElementById("piPermissionTitle");
        const msgEl = document.getElementById("piPermissionMessage");
        const inputEl = document.getElementById("piPermissionInput");
        const editorEl = document.getElementById("piPermissionEditor");
        const optionsEl = document.getElementById("piPermissionOptions");

        piPermissionBtn.style.display = "none";
        titleEl.textContent = request.title || "Permission Request";
        msgEl.textContent = request.message || "";
        inputEl.style.display = "none";
        editorEl.style.display = "none";
        optionsEl.innerHTML = "";

        const addOptionButton = (label, onClick, isDanger = false) => {
          const btn = document.createElement("button");
          btn.textContent = label;
          btn.style.padding = "8px 10px";
          btn.style.background = isDanger ? "#ff4444" : "var(--text-inverse)";
          btn.style.color = isDanger ? "#fff" : "var(--bg-inverse)";
          btn.style.border = "none";
          btn.style.cursor = "pointer";
          btn.style.fontFamily = "inherit";
          btn.style.fontWeight = "bold";
          btn.style.fontSize = "calc(11px * var(--font-scale, 1))";
          btn.onclick = onClick;
          optionsEl.appendChild(btn);
        };

        if (request.method === "select") {
          const opts = Array.isArray(request.options) ? request.options : [];
          if (opts.length === 0) {
            addOptionButton("CANCEL", () =>
              resolvePiPermission({ cancelled: true }),
            );
          } else {
            opts.forEach((opt) => {
              const label = String(opt);
              const denyLike = /^no\b|deny|block|cancel/i.test(label);
              addOptionButton(
                label,
                () => resolvePiPermission({ value: label }),
                denyLike,
              );
            });
          }
        } else if (request.method === "confirm") {
          addOptionButton("ALLOW", () =>
            resolvePiPermission({ confirmed: true }),
          );
          addOptionButton(
            "DENY",
            () => resolvePiPermission({ confirmed: false }),
            true,
          );
          addOptionButton("CANCEL", () =>
            resolvePiPermission({ cancelled: true }),
          );
        } else if (request.method === "input") {
          inputEl.style.display = "block";
          inputEl.value = "";
          inputEl.placeholder = request.placeholder || "";
          addOptionButton("SUBMIT", () =>
            resolvePiPermission({ value: inputEl.value }),
          );
          addOptionButton("CANCEL", () =>
            resolvePiPermission({ cancelled: true }),
          );
          setTimeout(() => inputEl.focus(), 0);
        } else if (request.method === "editor") {
          editorEl.style.display = "block";
          editorEl.value = request.prefill || "";
          addOptionButton("SUBMIT", () =>
            resolvePiPermission({ value: editorEl.value }),
          );
          addOptionButton("CANCEL", () =>
            resolvePiPermission({ cancelled: true }),
          );
          setTimeout(() => editorEl.focus(), 0);
        } else {
          addOptionButton("CANCEL", () =>
            resolvePiPermission({ cancelled: true }),
          );
        }

        modal.style.display = "flex";
      }

      function schedulePiPermissionDecisionTimeout() {
        const timeoutMs =
          Number(piSettings.permissionUx?.decisionTimeoutMs) > 0
            ? Number(piSettings.permissionUx?.decisionTimeoutMs)
            : 0;
        if (timeoutMs <= 0) return;
        if (activePiPermissionTimer) clearTimeout(activePiPermissionTimer);
        activePiPermissionTimer = setTimeout(() => {
          const defaultAction =
            piSettings.permissionUx?.defaultAction || "deny";
          const pendingRequest = activePiPermissionRequest;
          if (!pendingRequest) return;
          if (pendingRequest.method === "confirm") {
            if (defaultAction === "allow") {
              resolvePiPermission({ confirmed: true });
            } else {
              resolvePiPermission({ confirmed: false });
            }
            return;
          }
          resolvePiPermission({ cancelled: true });
        }, timeoutMs);
      }

      function askPiPermission(request, signal) {
        activePiPermissionRequest = request;

        return new Promise((resolve, reject) => {
          activePiPermissionResolver = resolve;

          if (signal && signal.aborted) {
            clearPiPermissionState();
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }

          const onAbort = () => {
            clearPiPermissionState();
            hidePiPermissionModal();
            reject(new DOMException("Aborted", "AbortError"));
          };
          if (signal) {
            signal.addEventListener("abort", onAbort, { once: true });
          }

          const shouldAutoOpen = piSettings.permissionUx?.autoOpen !== false;
          if (shouldAutoOpen) {
            renderAndOpenPiPermissionModal(request);
          } else {
            piPermissionBtn.style.display = mode === "pi" ? "" : "none";
          }
          schedulePiPermissionDecisionTimeout();
        });
      }

      async function runPiRpcConversation(
        message,
        signal,
        source = "manual",
        historyForRequest = [],
        saveConv = null,
        convTitle = "",
        onDelta,
        onEvent,
        images,
      ) {
        // Terminal parity (issue 1.3): pressing Stop must actually halt Pi,
        // not just close the HTTP stream. Send a real `abort` RPC command to
        // the Pi process the instant the user cancels — equivalent to Esc in
        // the Pi terminal. Fire-and-forget: the stream teardown proceeds
        // regardless of the command's result.
        if (signal && typeof signal.addEventListener === "function") {
          signal.addEventListener(
            "abort",
            () => {
              try {
                fetch(apiUrl("/api/pi/command"), {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    saveConv: saveConv || currentConvId,
                    command: { type: "abort" },
                  }),
                }).catch(() => {});
              } catch (_e) {}
            },
            { once: true },
          );
        }
        const res = await fetch(apiUrl("/api/pi/stream"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message,
            source,
            history: historyForRequest,
            saveConv,
            convTitle,
            mode: "pi",
            library: getLibraryRequestPayload(),
            images: images || undefined,
          }),
          signal,
        });

        if (!res.ok) {
          const raw = await res.text();
          throw new Error(
            `Start Pi stream failed (${res.status}): ${(raw || "empty response body").slice(0, 500)}`,
          );
        }

        if (!res.body) {
          throw new Error("Pi stream response body is unavailable.");
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let sessionId = null;
        let finalResponse = "";

        // On interrupt the server closes the NDJSON stream cleanly, so
        // reader.read() returns {done:true} instead of throwing. Detect the
        // aborted signal and raise an AbortError so the caller takes the
        // cancellation branch (which always writes "Request cancelled by
        // user.") instead of the normal-completion path that would leave an
        // empty assistant bubble.
        const throwIfAborted = () => {
          if (signal && signal.aborted) {
            const err = new Error("Pi request aborted by user.");
            err.name = "AbortError";
            throw err;
          }
        };

        while (true) {
          const { done, value } = await reader.read();
          throwIfAborted();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.trim()) continue;
            let evt;
            try {
              evt = JSON.parse(line);
            } catch (_e) {
              continue;
            }

            if (evt.type === "session_start" && evt.sessionId) {
              sessionId = evt.sessionId;
              continue;
            }

            if (evt.type === "delta") {
              finalResponse =
                typeof evt.response === "string" ? evt.response : finalResponse;
              if (typeof onDelta === "function")
                onDelta(finalResponse, evt.delta || "");
              continue;
            }

            if (
              evt.type === "thinking_start" ||
              evt.type === "thinking_delta" ||
              evt.type === "thinking_end" ||
              evt.type === "skill_links" ||
              evt.type === "web_sources" ||
              evt.type === "library_results" ||
              evt.type === "library_error" ||
              evt.type === "slash_command" ||
              evt.type === "heartbeat" ||
              evt.type === "pi_banner" ||
              evt.type === "pi_widget" ||
              evt.type === "pi_status" ||
              evt.type === "pi_notice" ||
              evt.type === "pi_usage" ||
              evt.type === "async_pending" ||
              evt.type === "provider_retry" ||
              evt.type === "provider_retry_end" ||
              evt.type === "provider_error" ||
              evt.type === "compaction_start" ||
              evt.type === "compaction_end"
            ) {
              if (typeof onEvent === "function") onEvent(evt);
              continue;
            }

            if (
              evt.type === "tool_start" ||
              evt.type === "tool_update" ||
              evt.type === "tool_end" ||
              evt.type === "stderr" ||
              evt.type === "trace"
            ) {
              if (typeof onEvent === "function") onEvent(evt);
              continue;
            }

            if (evt.type === "needs_ui") {
              if (typeof onEvent === "function") onEvent(evt);
              const activeSessionId = sessionId || evt.sessionId;
              if (!activeSessionId)
                throw new Error(
                  "Missing Pi sessionId for permission response.",
                );
              const uiResponse = await askPiPermission(evt.request, signal);
              logSecurityEvent("pi_permission_dialog_shown", {
                method: evt.request?.method || "unknown",
                title: evt.request?.title || "",
              });
              await postJson(
                "/api/pi/respond",
                {
                  sessionId: activeSessionId,
                  uiResponse,
                  streaming: true,
                },
                "Respond to Pi permission request",
                signal,
              );
              continue;
            }

            if (evt.type === "done") {
              finalResponse =
                typeof evt.response === "string" ? evt.response : finalResponse;
              if (typeof onDelta === "function") onDelta(finalResponse, "");
              if (typeof onEvent === "function") onEvent(evt);
              return finalResponse;
            }

            if (evt.type === "error") {
              if (typeof onEvent === "function") onEvent(evt);
              throw new Error(evt.error || "Pi streaming error.");
            }
          }
        }

        throwIfAborted();

        if (buffer.trim()) {
          try {
            const evt = JSON.parse(buffer.trim());
            if (evt.type === "done") {
              finalResponse =
                typeof evt.response === "string" ? evt.response : finalResponse;
              if (typeof onDelta === "function") onDelta(finalResponse, "");
              return finalResponse;
            }
            if (evt.type === "error") {
              throw new Error(evt.error || "Pi streaming error.");
            }
          } catch (_e) {}
        }

        return finalResponse;
      }

      async function runOllamaStreamConversation(
        message,
        model,
        historyForRequest,
        saveConv,
        convTitle,
        signal,
        onDelta,
        onEvent,
        images,
      ) {
        const res = await fetch(apiUrl("/api/chat/stream"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message,
            model,
            history: historyForRequest,
            saveConv,
            convTitle,
            mode: "ollama",
            options: getOllamaOptionsRequestPayload(),
            library: getLibraryRequestPayload(),
            images: images || undefined,
            agentMode: ollamaAgentMode || undefined,
            agentMaxRounds: ollamaAgentMode ? ollamaAgentMaxRounds : undefined,
            nativeTools: ollamaNativeTools,
          }),
          signal,
        });

        if (!res.ok) {
          const raw = await res.text();
          throw new Error(
            `Start Ollama stream failed (${res.status}): ${(raw || "empty response body").slice(0, 500)}`,
          );
        }
        if (!res.body) {
          throw new Error("Ollama stream response body is unavailable.");
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let finalResponse = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.trim()) continue;
            let evt;
            try {
              evt = JSON.parse(line);
            } catch (_e) {
              continue;
            }

            if (evt.type === "delta") {
              finalResponse =
                typeof evt.response === "string" ? evt.response : finalResponse;
              if (typeof onDelta === "function")
                onDelta(finalResponse, evt.delta || "");
              continue;
            }

            if (
              evt.type === "thinking_start" ||
              evt.type === "thinking_delta" ||
              evt.type === "thinking_end" ||
              evt.type === "skill_links" ||
              evt.type === "web_sources" ||
              evt.type === "library_results" ||
              evt.type === "library_error" ||
              evt.type === "slash_command" ||
              evt.type === "heartbeat" ||
              evt.type === "pi_banner" ||
              evt.type === "pi_widget" ||
              evt.type === "pi_status" ||
              evt.type === "pi_notice" ||
              evt.type === "pi_usage" ||
              evt.type === "async_pending" ||
              evt.type === "provider_retry" ||
              evt.type === "provider_retry_end" ||
              evt.type === "provider_error" ||
              evt.type === "compaction_start" ||
              evt.type === "compaction_end"
            ) {
              if (typeof onEvent === "function") onEvent(evt);
              continue;
            }

            if (evt.type === "needs_ui") {
              if (typeof onEvent === "function") onEvent(evt);
              const activeSessionId = evt.sessionId;
              if (!activeSessionId)
                throw new Error(
                  "Missing sessionId for Ollama permission response.",
                );
              const uiResponse = await askPiPermission(evt.request, signal);
              await postJson(
                "/api/ollama/tool-respond",
                {
                  sessionId: activeSessionId,
                  uiResponse,
                  streaming: true,
                },
                "Respond to Ollama permission request",
                signal,
              );
              continue;
            }

            if (evt.type === "done") {
              finalResponse =
                typeof evt.response === "string" ? evt.response : finalResponse;
              if (typeof onDelta === "function") onDelta(finalResponse, "");
              if (typeof onEvent === "function") onEvent(evt);
              return finalResponse;
            }

            if (evt.type === "error") {
              throw new Error(evt.error || "Ollama streaming error.");
            }
          }
        }

        return finalResponse;
      }

      async function runCloudStreamConversation(
        message,
        historyForRequest,
        saveConv,
        convTitle,
        signal,
        onDelta,
        onEvent,
        images,
        systemOverride,
      ) {
        const res = await fetch(apiUrl("/api/cloud/chat/stream"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message,
            history: historyForRequest,
            saveConv,
            convTitle,
            mode: "cloud",
            library: getLibraryRequestPayload(),
            images: images || undefined,
            promptOverlay: systemOverride
              ? undefined
              : getActivePromptContent() || undefined,
            systemOverride: systemOverride || undefined,
          }),
          signal,
        });

        if (!res.ok) {
          const raw = await res.text();
          throw new Error(
            `Start Cloud stream failed (${res.status}): ${(raw || "empty response body").slice(0, 500)}`,
          );
        }
        if (!res.body) {
          throw new Error("Cloud stream response body is unavailable.");
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let finalResponse = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.trim()) continue;
            let evt;
            try {
              evt = JSON.parse(line);
            } catch (_e) {
              continue;
            }

            if (evt.type === "delta") {
              finalResponse =
                typeof evt.response === "string" ? evt.response : finalResponse;
              if (typeof onDelta === "function") {
                onDelta(finalResponse, evt.delta || "");
              }
              continue;
            }

            if (
              evt.type === "thinking_start" ||
              evt.type === "thinking_delta" ||
              evt.type === "thinking_end" ||
              evt.type === "tool_start" ||
              evt.type === "tool_end" ||
              evt.type === "skill_links" ||
              evt.type === "web_sources" ||
              evt.type === "library_results" ||
              evt.type === "library_error" ||
              evt.type === "slash_command" ||
              evt.type === "heartbeat" ||
              evt.type === "pi_banner" ||
              evt.type === "pi_widget" ||
              evt.type === "pi_status" ||
              evt.type === "pi_notice" ||
              evt.type === "pi_usage" ||
              evt.type === "async_pending" ||
              evt.type === "provider_retry" ||
              evt.type === "provider_retry_end" ||
              evt.type === "provider_error" ||
              evt.type === "compaction_start" ||
              evt.type === "compaction_end"
            ) {
              if (typeof onEvent === "function") onEvent(evt);
              continue;
            }

            if (evt.type === "needs_ui") {
              if (typeof onEvent === "function") onEvent(evt);
              const activeSessionId = evt.sessionId;
              if (!activeSessionId)
                throw new Error(
                  "Missing sessionId for Cloud permission response.",
                );
              const uiResponse = await askPiPermission(evt.request, signal);
              await postJson(
                "/api/ollama/tool-respond",
                {
                  sessionId: activeSessionId,
                  uiResponse,
                  streaming: true,
                },
                "Respond to Cloud permission request",
                signal,
              );
              continue;
            }

            if (evt.type === "done") {
              finalResponse =
                typeof evt.response === "string" ? evt.response : finalResponse;
              if (evt.usage && typeof evt.usage.total === "number") {
                updateTokenCounter("cloud", evt.usage.total, null);
              }
              if (typeof onDelta === "function") onDelta(finalResponse, "");
              if (typeof onEvent === "function") onEvent(evt);
              return finalResponse;
            }

            if (evt.type === "error") {
              throw new Error(evt.error || "Cloud streaming error.");
            }
          }
        }

        return finalResponse;
      }

      // Local OpenAI-compatible bespoke modes (LM Studio, llama.cpp). Same
      // NDJSON stream contract as Cloud, but hits /api/<mode>/stream and sends
      // the mode's configured model.
      async function runLocalModeConversation(
        modeId,
        message,
        historyForRequest,
        saveConv,
        convTitle,
        signal,
        onDelta,
        onEvent,
        images,
        systemOverride,
      ) {
        const conf = localModelConfig[modeId] || {};
        const res = await fetch(apiUrl(`/api/${modeId}/stream`), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message,
            history: historyForRequest,
            saveConv,
            convTitle,
            mode: modeId,
            // Send explicit "" when auto so server doesn't fall back to its own saved model
            model: typeof conf.model === "string" ? conf.model : undefined,
            params: conf.params || undefined,
            promptOverlay: systemOverride
              ? undefined
              : getActivePromptContent() || undefined,
            systemOverride: systemOverride || undefined,
            library: getLibraryRequestPayload(),
            images: images || undefined,
          }),
          signal,
        });

        if (!res.ok) {
          const raw = await res.text();
          throw new Error(
            `Start ${modeId} stream failed (${res.status}): ${(raw || "empty response body").slice(0, 500)}`,
          );
        }
        if (!res.body) {
          throw new Error(`${modeId} stream response body is unavailable.`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let finalResponse = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.trim()) continue;
            let evt;
            try {
              evt = JSON.parse(line);
            } catch (_e) {
              continue;
            }

            if (evt.type === "delta") {
              finalResponse =
                typeof evt.response === "string" ? evt.response : finalResponse;
              if (typeof onDelta === "function") {
                onDelta(finalResponse, evt.delta || "");
              }
              continue;
            }

            if (
              evt.type === "thinking_start" ||
              evt.type === "thinking_delta" ||
              evt.type === "thinking_end" ||
              evt.type === "tool_start" ||
              evt.type === "tool_end" ||
              evt.type === "skill_links" ||
              evt.type === "web_sources" ||
              evt.type === "library_results" ||
              evt.type === "library_error" ||
              evt.type === "slash_command" ||
              evt.type === "heartbeat" ||
              evt.type === "pi_banner" ||
              evt.type === "pi_widget" ||
              evt.type === "pi_status" ||
              evt.type === "pi_notice" ||
              evt.type === "pi_usage" ||
              evt.type === "async_pending" ||
              evt.type === "provider_retry" ||
              evt.type === "provider_retry_end" ||
              evt.type === "provider_error" ||
              evt.type === "compaction_start" ||
              evt.type === "compaction_end"
            ) {
              if (typeof onEvent === "function") onEvent(evt);
              continue;
            }

            if (evt.type === "needs_ui") {
              if (typeof onEvent === "function") onEvent(evt);
              const activeSessionId = evt.sessionId;
              if (!activeSessionId)
                throw new Error(
                  `Missing sessionId for ${modeId} permission response.`,
                );
              const uiResponse = await askPiPermission(evt.request, signal);
              await postJson(
                "/api/ollama/tool-respond",
                { sessionId: activeSessionId, uiResponse, streaming: true },
                `Respond to ${modeId} permission request`,
                signal,
              );
              continue;
            }

            if (evt.type === "done") {
              finalResponse =
                typeof evt.response === "string" ? evt.response : finalResponse;
              if (evt.usage && typeof evt.usage.total === "number") {
                updateTokenCounter(
                  modeId,
                  evt.usage.total,
                  localContextCache[modeId] || null,
                );
                // Context was unknown at start — fetch it now so the
                // token counter replaces '?' with the real limit.
                if (!localContextCache[modeId]) {
                  fetchLocalModelList(modeId).catch(() => {});
                }
              }
              if (typeof onDelta === "function") onDelta(finalResponse, "");
              if (typeof onEvent === "function") onEvent(evt);
              return finalResponse;
            }

            if (evt.type === "error") {
              throw new Error(evt.error || `${modeId} streaming error.`);
            }
          }
        }

        return finalResponse;
      }

      // ---- Local mode (LM Studio / llama.cpp) settings + model picker ----
