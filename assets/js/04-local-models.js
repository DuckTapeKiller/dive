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
  // Defaults differ per mode (llama.cpp ships tighter sampling).
  const modeDefaults = defaultLocalParams(modeId);
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
      if (!Number.isFinite(v)) v = modeDefaults[def.key];
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
    help.textContent = "Default: " + modeDefaults[def.key];

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
              ...defaultLocalParams(id),
              ...(s.params && typeof s.params === "object" ? s.params : {}),
            },
            nativeTools: s.nativeTools !== false,
            agentMode: s.agentMode === true,
            agentMaxRounds: Number.isFinite(Number(s.agentMaxRounds))
              ? Math.min(50, Math.max(1, Math.round(s.agentMaxRounds)))
              : 25,
            // Carried through explicitly: saving posts this whole object
            // back, so a field dropped here would be wiped on the next
            // unrelated settings change.
            singleSystemMessage:
              s.singleSystemMessage && typeof s.singleSystemMessage === "object"
                ? { ...s.singleSystemMessage }
                : {},
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
      els.nativeTools.checked = localModelConfig[id].nativeTools !== false;
    }
    if (els.agentMode) {
      els.agentMode.checked = localModelConfig[id].agentMode === true;
    }
    if (els.agentRounds) {
      els.agentRounds.value = String(localModelConfig[id].agentMaxRounds || 25);
    }
    renderLocalModelOptions(id);
    renderLocalParams(id);
  }
  // renderLocalModelOptions repaints the SETTINGS dropdown only, and the
  // topbar reads the same value. Whichever of this fetch and the model
  // list arrived last used to win, so on a slow settings response the
  // topbar sat on "Automatic" while the server had a model named — and
  // "Automatic" resolves to whichever model the server happens to list
  // first, which is the wrong one as soon as the order is not lucky.
  if (LOCAL_MODE_IDS.includes(mode)) populateTopbarModelSelect();
}

// Re-read WHICH MODEL IS SELECTED, and repaint both dropdowns that name
// it.
//
// The topbar dropdown and the settings dropdown are two views of a single
// value that the server owns, and the page caches its own copy at boot.
// Loading a model from the MODELS tab moves the server's copy; nothing
// moved the page's. That is not merely cosmetic: sending a message posts
// the topbar's value EXPLICITLY, and an explicit choice beats the server's
// own record — so the next message asked for the model selected before,
// and the router dutifully loaded it back over the one just loaded.
//
// Deliberately narrower than loadLocalModeSettings(), which rebuilds every
// parameter field from the server and would throw away anything typed into
// the settings form but not yet saved.
async function refreshLocalModelSelection() {
  let data;
  try {
    const res = await fetch(apiUrl("/api/local-models/settings"));
    data = await readJsonResponse(res, "Load local model settings");
  } catch (e) {
    console.error("Could not refresh the local model selection", e);
    return;
  }
  for (const id of LOCAL_MODE_IDS) {
    const next = data?.settings?.[id]?.model;
    if (typeof next !== "string" || next === localModelConfig[id].model) {
      continue;
    }
    localModelConfig[id].model = next;
    renderLocalModelOptions(id, localModelsCache[id]);
    if (mode === id) populateTopbarModelSelect();
  }
}

// "MERGE SYSTEM PROMPTS" for one model.
//
// Dive normally sends the assistant policy, the database context and the
// skills policy as three separate system messages, which small models
// follow more reliably. A few chat templates reject any system message
// after the first ("System message must be at the beginning") and fail the
// whole request, so those models get the blocks merged into one instead.
//
// Off for every model by default, and stored per model, so ticking it for
// an awkward model leaves every other one exactly as it was.
function mkSingleSystemCheck(file, parent) {
  const conf = localModelConfig.llamacpp;
  if (!conf.singleSystemMessage) conf.singleSystemMessage = {};
  const holder = document.createElement("label");
  holder.style.cssText =
    "display: flex; align-items: center; gap: 4px; font-size: calc(9px * var(--font-scale, 1));";
  holder.title =
    "Send the assistant policy, database context and skills policy as ONE system message instead of three. " +
    "Only needed for models whose chat template refuses a system message that is not the first one — " +
    'they fail with "System message must be at the beginning". Leave off otherwise: separate messages are followed more reliably.';
  const input = document.createElement("input");
  input.type = "checkbox";
  input.className = "dive-check";
  input.checked = conf.singleSystemMessage[file] === true;
  input.addEventListener("change", () => {
    if (input.checked) conf.singleSystemMessage[file] = true;
    // Deleted rather than set to false, so the saved file only ever lists
    // the models actually opted in.
    else delete conf.singleSystemMessage[file];
    saveLocalModeSettings();
  });
  holder.appendChild(input);
  holder.appendChild(document.createTextNode("MERGE SYSTEM PROMPTS"));
  parent.appendChild(holder);
  return input;
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

// Total for the token counter: the context CHOSEN for the selected model,
// falling back to whatever the server reports when there is no choice on
// record for it.
//
// The chosen value leads deliberately. It is what the CONTEXT slider
// shows, it is what Dive writes into the preset section and passes as -c,
// and it is therefore what the model will be running with the moment the
// router has restarted. Leading with the server's figure instead made the
// counter lag a reload behind the slider, so the two disagreed for as
// long as the old model stayed loaded — which is exactly the confusion
// this is meant to remove.
function llamaCppTokenCounterTotal() {
  const selected = String(localModelConfig.llamacpp.model || "");
  if (selected) {
    const stem = selected.replace(/\.gguf$/i, "");
    const entry = (llamaCppLastStatus.models || []).find(
      (m) => m.file === selected || m.file.replace(/\.gguf$/i, "") === stem,
    );
    if (entry && entry.ctx > 0) return entry.ctx;
  }
  const reported = localContextCache.llamacpp;
  return typeof reported === "number" && reported > 0 ? reported : null;
}

async function fetchLocalModelList(modeId, { alertOnError = false } = {}) {
  try {
    const res = await fetch(apiUrl(`/api/${modeId}/models`));
    const data = await readJsonResponse(res, "List local models");
    localModelsCache[modeId] = Array.isArray(data.models) ? data.models : [];
    localEmbeddingModelsCache[modeId] = Array.isArray(data.embeddingModels)
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
  // The Database embedding dropdown shares these caches. Rebuild it
  // whenever a local model list changes, including later manual refreshes
  // after a server that was still starting becomes reachable.
  if (typeof refreshEmbeddingModelSelectFromCache === "function") {
    refreshEmbeddingModelSelectFromCache();
  }
  if (mode === modeId) {
    populateTopbarModelSelect();
    // Surface the loaded context window as the token-counter limit even
    // before the first message (so you can see e.g. 9169 vs what you set).
    const st = modeId === "lmstudio" ? lmstudioTokenState : llamacppTokenState;
    updateTokenCounter(
      modeId,
      typeof st.used === "number" ? st.used : 0,
      modeId === "llamacpp"
        ? llamaCppTokenCounterTotal()
        : localContextCache[modeId] || null,
    );
  }
  return localModelsCache[modeId];
}

// "Refresh models" button in settings: fetch and surface errors. For
// llama.cpp, an unreachable server usually just means no model has been
// loaded through the manager yet — say that instead of a bare 502.
async function refreshLocalModels(modeId) {
  if (modeId === "llamacpp") {
    try {
      const status = await llamaCppManagerFetchStatus();
      if (status.chat?.state !== "running") {
        await refreshLlamaCppManager().catch(
          uiRefreshFailed("llama.cpp manager"),
        );
        await appAlert(
          "No model is loaded yet. Click LOAD next to a model in the MODEL LIBRARY section to start the llama.cpp server, then the model list will fill in automatically.",
          "llama.cpp",
        );
        return;
      }
    } catch {
      /* manager unavailable: fall through to the normal fetch */
    }
  }
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
        localModelConfig[id].params = defaultLocalParams(id);
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
  wireLlamaCppManager();
}

// ---- llama.cpp manager: run llama-server inside Dive (no terminal).
// Talks to /api/llamacpp/manager/*: local GGUF library with per-model
// context/GPU-layer settings, load/stop, and Hugging Face downloads.

let llamaCppManagerPollTimer = null;
let llamaCppManagerBusy = false; // a LOAD request is in flight
// Instant-feedback load state, set synchronously on click so the UI
// reacts before any network round-trip (fixes the "click twice" feel).
let llamaCppLoadingLabel = ""; // "CHAT" | "EMBEDDING" | ""
let llamaCppLoadingModel = "";
let llamaCppLoadStartMs = 0;
let llamaCppLoadTimer = null;
// Last status from the server, so the elapsed-time ticker can re-render
// the status line every second without re-fetching.
let llamaCppLastStatus = { chat: {}, embedding: {}, binaryFound: true };
// Files whose ADVANCED panel is open, so poll-driven re-renders of the
// model list don't collapse a panel the user is working in.
const llamaCppAdvOpen = new Set();
// Last chat model seen loaded (router or managed), to detect switches.
let llamaCppLastLoadedChatModel = "";

function llamaCppFmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 1024 * 1024 * 1024)
    return (n / (1024 * 1024 * 1024)).toFixed(2) + " GB";
  return Math.round(n / (1024 * 1024)) + " MB";
}

// "131072" -> "128K" so context sizes stay readable next to the slider.
function llamaCppFmtCtx(n) {
  if (!Number.isFinite(n) || n <= 0) return "";
  return n >= 1024 ? Math.round(n / 1024) + "K" : String(n);
}

function llamaCppFmtParams(n) {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B params";
  if (n >= 1e6) return Math.round(n / 1e6) + "M params";
  return n.toLocaleString() + " params";
}

// Plain-language guidance per quantization family, so picking a file on
// Hugging Face is an informed choice instead of a size guess.
function llamaCppQuantHint(quant) {
  const q = String(quant || "").toUpperCase();
  if (!q) return "";
  if (/^(IQ1|IQ2|Q2)/.test(q)) return "tiny — significant quality loss";
  if (/^(IQ3|Q3)/.test(q)) return "small — noticeable quality loss";
  if (q === "Q4_K_M") return "recommended — best size/quality balance";
  if (/^(IQ4|Q4)/.test(q)) return "good size/quality balance";
  if (/^Q5/.test(q)) return "larger — low quality loss";
  if (/^Q6/.test(q)) return "large — minimal quality loss";
  if (/^Q8/.test(q)) return "very large — near-original quality";
  if (/^(F16|BF16|FP16)/.test(q)) return "full precision — largest";
  if (/^(F32|FP32)/.test(q)) return "full 32-bit precision — largest";
  return "";
}

// Split GGUFs ("-00001-of-00003.gguf"): group all parts into one
// downloadable entry so the user can't grab a single unusable part.
const LLAMA_GGUF_PART_RE = /-(\d{5})-of-(\d{5})\.gguf$/;
function llamaCppGroupHfFiles(files) {
  const groups = new Map();
  const out = [];
  for (const f of files) {
    const m = String(f.file).match(LLAMA_GGUF_PART_RE);
    if (!m) {
      out.push({
        label: f.file,
        files: [f.file],
        totalBytes: f.sizeBytes || 0,
        quant: f.quant || "",
        parts: 1,
      });
      continue;
    }
    const key = f.file.slice(0, m.index) + `-of-${m[2]}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        label: f.file.slice(0, m.index) + ".gguf",
        files: [],
        totalBytes: 0,
        quant: f.quant || "",
        parts: Number(m[2]),
      };
      groups.set(key, g);
      out.push(g);
    }
    g.files.push(f.file);
    g.totalBytes += f.sizeBytes || 0;
  }
  for (const g of out) g.files.sort();
  return out;
}

async function llamaCppManagerFetchStatus() {
  const res = await fetch(apiUrl("/api/llamacpp/manager/status"));
  return await readJsonResponse(res, "llama.cpp manager status");
}

function llamaCppManagerSchedulePoll(status) {
  const transitional =
    llamaCppManagerBusy ||
    status.chat?.state === "starting" ||
    status.embedding?.state === "starting" ||
    (status.download && status.download.active);
  // An external llama-server (router mode) loads/unloads models on its
  // own as chats happen — keep the status fresh with a slow poll.
  const external = status.chatExternal || status.embeddingExternal;
  clearTimeout(llamaCppManagerPollTimer);
  if (transitional || external) {
    llamaCppManagerPollTimer = setTimeout(
      () =>
        refreshLlamaCppManager().catch(uiRefreshFailed("llama.cpp manager")),
      transitional ? 1200 : 8000,
    );
  }
}

function llamaCppElapsedSuffix() {
  if (!llamaCppLoadStartMs) return "";
  return ` — ${Math.floor((Date.now() - llamaCppLoadStartMs) / 1000)}s`;
}

// Render the chat + embedding slot states as flat status cards: one card
// per server, a header with the port, and one aligned row per model with
// a state dot + badge. Uses theme vars so every palette works.
// Inactive rows read as secondary, not as absent. At 45% an unloaded
// model measured 3.25:1 against the card — below the 4.5:1 needed for
// text this small. 60% measures 5.43:1 while the active row stays at
// 13.35:1, so the hierarchy is still obvious at a glance.
const LLAMA_DIM = "color-mix(in srgb, currentColor 60%, transparent)";
const LLAMA_DIM_SOFT = "color-mix(in srgb, currentColor 40%, transparent)";
const LLAMA_HAIR = "color-mix(in srgb, currentColor 14%, transparent)";

function llamaCppStatusDot(kind) {
  const dot = document.createElement("span");
  let s =
    "width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; display: inline-block;";
  if (kind === "loaded") s += ` background: var(--accent);`;
  else if (kind === "loading")
    s += ` background: var(--accent); opacity: 0.55;`;
  else if (kind === "sleeping") s += ` background: ${LLAMA_DIM_SOFT};`;
  else if (kind === "error") s += " background: #ff4444;";
  else s += ` border: 1.5px solid ${LLAMA_DIM}; width: 5px; height: 5px;`;
  dot.style.cssText = s;
  return dot;
}

// Readable ink for a chip filled with --accent. Accents span #ebcb8b to
// #1f4e79 across the palettes, so no single fixed colour works: the old
// --bg-inverse measured 2.38:1 on the green palette. Picking black or
// white per accent — whichever contrasts more — is never worse than
// 4.61:1 on any palette Dive ships.
let llamaCppAccentInkCache = { accent: "", ink: "#fff" };
function llamaCppAccentInk() {
  const probe = document.createElement("span");
  probe.style.color = "var(--accent)";
  probe.style.display = "none";
  document.body.appendChild(probe);
  const accent = getComputedStyle(probe).color;
  probe.remove();
  if (accent === llamaCppAccentInkCache.accent) {
    return llamaCppAccentInkCache.ink;
  }
  const parts = accent.match(/[\d.]+/g);
  let ink = "#fff";
  if (parts) {
    const lin = (v) => {
      v = Number(v) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    const L =
      0.2126 * lin(parts[0]) + 0.7152 * lin(parts[1]) + 0.0722 * lin(parts[2]);
    ink = 1.05 / (L + 0.05) >= (L + 0.05) / 0.05 ? "#fff" : "#000";
  }
  llamaCppAccentInkCache = { accent, ink };
  return ink;
}

function llamaCppStatusBadge(kind, text) {
  const badge = document.createElement("span");
  let s = `font-size: calc(9px * var(--font-scale, 1)); letter-spacing: 1px; flex-shrink: 0; padding: 1px 6px;`;
  if (kind === "loaded")
    s += ` background: var(--accent); color: ${llamaCppAccentInk()}; font-weight: bold; padding: 2px 7px;`;
  else if (kind === "loading") s += " color: var(--accent); font-weight: bold;";
  else if (kind === "sleeping")
    s += ` border: 1px solid ${LLAMA_DIM}; color: ${LLAMA_DIM};`;
  else if (kind === "error") s += " color: #ff4444; font-weight: bold;";
  else s += ` color: ${LLAMA_DIM};`;
  badge.textContent = text;
  badge.style.cssText = s;
  return badge;
}

function llamaCppStatusRow(card, dotKind, name, badge, boldName) {
  const row = document.createElement("div");
  row.style.cssText = `display: flex; align-items: center; gap: 8px; padding: 5px 0; border-top: 1px solid ${LLAMA_HAIR};`;
  row.appendChild(llamaCppStatusDot(dotKind));
  const label = document.createElement("span");
  label.textContent = name;
  label.style.cssText =
    "flex: 1; font-size: calc(11px * var(--font-scale, 1)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" +
    // The active (loaded/loading) model is drawn in the full-strength
    // normal text color and bold so it reads as clearly "on"; inactive
    // rows are dimmed.
    (boldName
      ? " font-weight: bold; color: var(--text-normal);"
      : ` color: ${LLAMA_DIM};`);
  row.appendChild(label);
  if (badge) row.appendChild(badge);
  card.appendChild(row);
  return row;
}

function llamaCppStatusCard(el, label, metaText) {
  const card = document.createElement("div");
  card.style.cssText =
    "background: var(--flat-fill); padding: 8px 12px 6px; margin: 0 0 8px;";
  const head = document.createElement("div");
  head.style.cssText =
    "display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 4px;";
  const title = document.createElement("span");
  title.textContent = label;
  title.style.cssText =
    "font-weight: bold; font-size: calc(10px * var(--font-scale, 1)); letter-spacing: 1.5px;";
  const meta = document.createElement("span");
  meta.textContent = metaText;
  meta.style.cssText = `font-size: calc(9px * var(--font-scale, 1)); letter-spacing: 1px; color: ${LLAMA_DIM};`;
  head.appendChild(title);
  head.appendChild(meta);
  card.appendChild(head);
  el.appendChild(card);
  return card;
}

function llamaCppStatusHint(card, text) {
  const hint = document.createElement("div");
  hint.textContent = text;
  hint.style.cssText = `font-size: calc(9.5px * var(--font-scale, 1)); color: ${LLAMA_DIM}; padding: 5px 0 3px; border-top: 1px solid ${LLAMA_HAIR};`;
  card.appendChild(hint);
}

function renderLlamaCppStatusInto(el, status) {
  if (!el) return;
  el.textContent = "";
  if (!status.binaryFound) {
    const line = document.createElement("div");
    line.textContent =
      "llama-server binary not found — install it with: brew install llama.cpp";
    line.style.color = "#ff4444";
    el.appendChild(line);
    return;
  }
  const renderSlot = (label, slot, external, defaultPort) => {
    const loadingThis =
      (llamaCppManagerBusy && llamaCppLoadingLabel === label) ||
      slot.state === "starting";
    if (loadingThis) {
      const card = llamaCppStatusCard(
        el,
        label,
        `PORT ${slot.port || defaultPort} · LOADING`,
      );
      llamaCppStatusRow(
        card,
        "loading",
        slot.model || llamaCppLoadingModel || "",
        llamaCppStatusBadge("loading", `LOADING…${llamaCppElapsedSuffix()}`),
        true,
      );
      const bar = document.createElement("div");
      bar.className = "dive-progress";
      bar.style.margin = "2px 0 4px";
      card.appendChild(bar);
      return;
    }
    if (slot.state === "running") {
      const card = llamaCppStatusCard(el, label, `PORT ${slot.port} · ONLINE`);
      llamaCppStatusRow(
        card,
        "loaded",
        slot.model,
        llamaCppStatusBadge("loaded", "LOADED"),
        true,
      );
      return;
    }
    if (slot.state === "error") {
      const card = llamaCppStatusCard(
        el,
        label,
        `PORT ${slot.port || defaultPort} · ERROR`,
      );
      const err = document.createElement("div");
      err.textContent = slot.lastError || "unknown error";
      err.style.cssText = `color: #ff4444; font-size: calc(10px * var(--font-scale, 1)); padding: 4px 0; border-top: 1px solid ${LLAMA_HAIR}; white-space: pre-wrap;`;
      card.appendChild(err);
      if ((slot.logTail || []).length) {
        const log = document.createElement("pre");
        log.textContent = slot.logTail.join("\n");
        log.style.cssText =
          "font-size: calc(9px * var(--font-scale, 1)); white-space: pre-wrap; opacity: 0.7; max-height: 90px; overflow-y: auto; margin: 2px 0 4px;";
        card.appendChild(log);
      }
      return;
    }
    if (external) {
      const card = llamaCppStatusCard(
        el,
        label,
        `PORT ${external.port} · ONLINE`,
      );
      let anyLoaded = false;
      // A --models-dir router advertises the whole folder. Show only what
      // belongs to THIS server: projectors are part of a model rather
      // than one, and an embedding model cannot be chatted with. An
      // "unknown" alias (no matching file) is still shown — the router
      // genuinely offers it, and hiding it would mask a stale preset.
      const wanted = label === "EMBEDDING" ? "embedding" : "chat";
      const slotModels = (external.models || []).filter(
        (m) => !m.kind || m.kind === wanted || m.kind === "unknown",
      );
      for (const m of slotModels) {
        const kind =
          m.state === "loaded"
            ? "loaded"
            : m.state === "loading"
              ? "loading"
              : m.state === "sleeping"
                ? "sleeping"
                : "unloaded";
        if (kind === "loaded" || kind === "loading") anyLoaded = true;
        llamaCppStatusRow(
          card,
          kind,
          m.id,
          llamaCppStatusBadge(
            kind,
            kind === "loading" ? "LOADING…" : kind.toUpperCase(),
          ),
          kind === "loaded",
        );
      }
      if (!slotModels.length) {
        llamaCppStatusHint(
          card,
          label === "EMBEDDING"
            ? "no embedding model registered on this server"
            : "no chat model registered on this server",
        );
      } else if (!anyLoaded) {
        llamaCppStatusHint(
          card,
          "models load automatically when you send a message",
        );
      }
      return;
    }
    const card = llamaCppStatusCard(el, label, `PORT ${defaultPort} · OFFLINE`);
    llamaCppStatusHint(card, "load a model below to start chatting");
  };
  renderSlot(
    "CHAT",
    status.chat || {},
    status.chatExternal || null,
    status.port || 8130,
  );
  // The embedding server only earns a card when something is or was
  // happening there — most users never touch it.
  const emb = status.embedding || {};
  const embBusy = llamaCppManagerBusy && llamaCppLoadingLabel === "EMBEDDING";
  if (
    (emb.state && emb.state !== "stopped") ||
    embBusy ||
    status.embeddingExternal
  ) {
    renderSlot(
      "EMBEDDING",
      emb,
      status.embeddingExternal || null,
      status.embeddingPort || 8131,
    );
  }
}

// Synchronous re-render of just the two status containers from cached
// state — used for instant click feedback and the elapsed-time ticker.
function renderLlamaCppStatusFromCache() {
  renderLlamaCppStatusInto(
    document.getElementById("llamaCppManagerStatus"),
    llamaCppLastStatus,
  );
  renderLlamaCppStatusInto(
    document.getElementById("llamaCppTabStatus"),
    llamaCppLastStatus,
  );
}

function llamaCppModelSlotOf(status, file) {
  if (status.chat?.model === file) return "chat";
  if (status.embedding?.model === file) return "embedding";
  return null;
}

// State of a model file on the external router (matched by alias =
// filename without .gguf): "loaded" | "sleeping" | "loading" |
// "unloaded" | null when no router serves that slot's port.
function llamaCppRouterStateOf(status, m) {
  const ext = m.embedding ? status.embeddingExternal : status.chatExternal;
  if (!ext || !ext.router) return null;
  const alias = m.file.replace(/\.gguf$/, "");
  return ext.models.find((x) => x.id === alias)?.state || null;
}

// Kick off a model load with instant, synchronous UI feedback (progress
// bar + elapsed timer appear immediately, before the network round-trip),
// then POST and refresh. Guarded so a second click while busy is ignored.
async function llamaCppLoadModel(m) {
  if (llamaCppManagerBusy) return;
  llamaCppManagerBusy = true;
  llamaCppLoadingLabel = m.embedding ? "EMBEDDING" : "CHAT";
  llamaCppLoadingModel = m.file;
  llamaCppLoadStartMs = Date.now();
  // Immediate feedback: disable every load button, show the progress bar.
  document
    .querySelectorAll(".llama-load-btn")
    .forEach((b) => (b.disabled = true));
  renderLlamaCppStatusFromCache();
  clearInterval(llamaCppLoadTimer);
  llamaCppLoadTimer = setInterval(renderLlamaCppStatusFromCache, 1000);
  let loadWarning = "";
  try {
    const result = await postJson(
      "/api/llamacpp/manager/start",
      { model: m.file },
      "Start llama.cpp server",
    );
    // A load can succeed and still not mean what it appears to. Loading
    // an embedding model does NOT switch the library over to it — the
    // stored vectors were built by another model and are not comparable
    // — so the server says so rather than let this tab imply otherwise.
    loadWarning = String(result?.warning || "");
  } catch (e) {
    await appAlert(e.message || String(e), "llama.cpp");
  } finally {
    clearInterval(llamaCppLoadTimer);
    llamaCppManagerBusy = false;
    llamaCppLoadingLabel = "";
    llamaCppLoadingModel = "";
    llamaCppLoadStartMs = 0;
    await refreshLlamaCppManager().catch(uiRefreshFailed("llama.cpp manager"));
    // A chat load makes the managed server this mode's backend: pick up
    // the selection it just moved, then refresh the chat model list +
    // context-length token counter.
    //
    // Selection first: the list refresh repaints the topbar from it, and
    // repainting it from the stale one is what left the panel naming the
    // model this load replaced.
    if (!m.embedding) {
      await refreshLocalModelSelection().catch(
        uiRefreshFailed("local model selection"),
      );
      await fetchLocalModelList("llamacpp").catch(
        uiRefreshFailed("local model list"),
      );
    }
  }
  // After the refresh, so the list already shows the model as loaded when
  // the caveat about it appears.
  if (loadWarning) await appAlert(loadWarning, "llama.cpp");
}

// One model list, two flavours: MAIN gets the compact loader (name, size,
// LOAD/STOP), the MODELS tab gets full management (context, GPU layers,
// embedding flag, advanced load options, delete).
function renderLlamaCppModelList(status, wrapId, full) {
  const wrap = document.getElementById(wrapId);
  if (!wrap) return;
  wrap.textContent = "";
  const allModels = Array.isArray(status.models) ? status.models : [];
  if (!allModels.length) {
    const empty = document.createElement("div");
    empty.className = "setting-help";
    empty.textContent = full
      ? "No .gguf models in the models folder yet — download one below."
      : "No models yet — download one in the MODELS tab.";
    wrap.appendChild(empty);
    return;
  }
  // Vision adapters (mmproj files, GGUF architecture "clip") aren't
  // loadable models — they attach to a parent model at load time. Keep
  // them out of the loadable rows and, in the full settings list, show
  // each nested under its parent (or as a deletable orphan if unmatched).
  const projectorByFile = new Map(
    allModels.filter((m) => m.arch === "clip").map((p) => [p.file, p]),
  );
  const models = allModels.filter((m) => m.arch !== "clip");
  const renderedProjectors = new Set();
  // Nested sub-line for a vision adapter: tree glyph, filename + size, and
  // a delete control. Never loadable, so no LOAD button or tuning inputs.
  // A projector is part of its model, so it is drawn INSIDE that model's
  // card: tagged, indented and tied to it with a left rule, rather than
  // floating as a sibling row that reads like another library entry.
  // An orphan has no card to live in, so it stands alone and says why.
  const buildProjectorLine = (proj, orphan) => {
    const line = document.createElement("div");
    line.style.cssText =
      "display: flex; align-items: center; gap: 6px; flex: 1 1 100%; min-width: 0; margin: 3px 0 1px; padding: 3px 0 3px 8px; border-left: 2px solid " +
      (orphan ? "#ff4444" : LLAMA_DIM) +
      ";";
    const tag = document.createElement("span");
    tag.textContent = orphan ? "ORPHANED ADAPTER" : "VISION ADAPTER";
    tag.style.cssText =
      "flex: 0 0 auto; font-size: calc(8px * var(--font-scale, 1)); font-weight: bold; letter-spacing: 1px; " +
      (orphan ? "color: #ff4444;" : `color: ${LLAMA_DIM};`);
    line.appendChild(tag);
    const label = document.createElement("div");
    label.style.cssText =
      "flex: 1 1 auto; min-width: 0; font-size: calc(9px * var(--font-scale, 1)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.85;";
    label.textContent = proj.file;
    label.title = orphan
      ? `${proj.file} (${llamaCppFmtBytes(proj.sizeBytes)}) — a multimodal projector with no matching model. Nothing will ever load it; deleting it frees the space.`
      : `${proj.file} (${llamaCppFmtBytes(proj.sizeBytes)}) — multimodal projector, loaded automatically with this model so it can accept images. Not a standalone model.`;
    line.appendChild(label);
    const size = document.createElement("span");
    size.textContent = llamaCppFmtBytes(proj.sizeBytes);
    size.style.cssText =
      "flex: 0 0 auto; font-size: calc(9px * var(--font-scale, 1)); opacity: 0.7;";
    line.appendChild(size);
    const del = document.createElement("button");
    del.type = "button";
    del.className = "settings-action-btn";
    del.textContent = "×";
    del.title = "Delete this vision adapter file";
    // settings-action-btn is a full-width bar; keep the adapter's delete a
    // compact × at the end of the sub-line instead.
    del.style.cssText =
      "flex: 0 0 auto; width: auto; padding: 1px 9px; border-color: #ff4444; color: #ff4444;";
    del.addEventListener("click", async () => {
      const sure = await appConfirm(
        `Delete ${proj.file} (${llamaCppFmtBytes(proj.sizeBytes)}) from disk? Its model will no longer accept images.`,
        "llama.cpp",
        { confirmLabel: "Delete", danger: true },
      );
      if (!sure) return;
      try {
        await postJson(
          "/api/llamacpp/manager/models/delete",
          { file: proj.file },
          "Delete vision adapter",
        );
        await refreshLlamaCppManager();
      } catch (e) {
        await appAlert(e.message || String(e), "llama.cpp");
      }
    });
    line.appendChild(del);
    return line;
  };
  const cacheTypes = Array.isArray(status.cacheTypes)
    ? status.cacheTypes
    : ["f16", "q8_0", "q4_0"];
  const anyStarting =
    llamaCppManagerBusy ||
    status.chat?.state === "starting" ||
    status.embedding?.state === "starting";
  const numInputStyle =
    "width: 66px; padding: 3px 4px; background: var(--flat-fill); color: var(--text-inverse); border: none; font-family: inherit; font-size: calc(10px * var(--font-scale, 1)); outline: none;";
  for (const m of models) {
    const activeSlot = llamaCppModelSlotOf(status, m.file);
    const routerState = llamaCppRouterStateOf(status, m);
    const isActive =
      (activeSlot !== null && status[activeSlot].state === "running") ||
      routerState === "loaded";
    const container = document.createElement("div");
    // The loaded model gets a standout treatment — accent left bar + a
    // subtle accent wash — so it's obvious at a glance which model is
    // running, instead of just an accent-colored filename.
    container.style.cssText = isActive
      ? "padding: 7px 10px; border-bottom: 1px solid var(--flat-fill); border-left: 3px solid var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent);"
      : "padding: 5px 0; border-bottom: 1px solid var(--flat-fill);";
    const row = document.createElement("div");
    row.style.cssText =
      "display: flex; align-items: center; gap: 6px; flex-wrap: wrap;";
    container.appendChild(row);

    const name = document.createElement("div");
    name.textContent = m.file + (m.embedding ? "  [embedding]" : "");
    name.title = `${m.file} (${llamaCppFmtBytes(m.sizeBytes)})`;
    name.style.cssText =
      "flex: 1 1 100%; font-size: calc(11px * var(--font-scale, 1)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" +
      (isActive ? " color: var(--accent); font-weight: bold;" : "");
    row.appendChild(name);

    // What the GGUF header says this model is: quantization,
    // architecture/size, trained context, split-part status.
    const metaBits = [];
    if (routerState === "loaded") metaBits.push("LOADED");
    else if (routerState === "loading") metaBits.push("LOADING…");
    else if (routerState === "sleeping") metaBits.push("sleeping (idle)");
    if (m.quant) metaBits.push(m.quant);
    if (m.arch || m.sizeLabel) {
      metaBits.push([m.arch, m.sizeLabel].filter(Boolean).join(" "));
    }
    if (m.maxCtx) {
      metaBits.push(`max context ${llamaCppFmtCtx(m.maxCtx)}`);
    }
    if (m.parts > 1) {
      metaBits.push(
        m.partsPresent < m.parts
          ? `${m.partsPresent}/${m.parts} parts — INCOMPLETE`
          : `${m.parts} parts`,
      );
    }
    // A vision adapter belongs to this model rather than being one. The
    // compact list gets a marker here; the full list draws the adapter
    // itself inside the card just below, so the size is not said twice.
    const ownProjector = m.projector && projectorByFile.get(m.projector);
    if (ownProjector) {
      metaBits.push(
        full ? "vision" : `vision +${llamaCppFmtBytes(ownProjector.sizeBytes)}`,
      );
    }
    if (metaBits.length) {
      const metaLine = document.createElement("div");
      metaLine.textContent = metaBits.join(" · ");
      metaLine.style.cssText =
        "flex: 1 1 100%; font-size: calc(9px * var(--font-scale, 1)); opacity: 0.6;";
      row.appendChild(metaLine);
    }
    // Attached adapter sits with the model's own description, above its
    // controls, so it is unmistakably part of this model.
    if (full && ownProjector) {
      row.appendChild(buildProjectorLine(ownProjector, false));
      renderedProjectors.add(m.projector);
    }

    const size = document.createElement("span");
    size.textContent = llamaCppFmtBytes(m.sizeBytes);
    size.style.cssText =
      "font-size: calc(9px * var(--font-scale, 1)); opacity: 0.6; min-width: 56px;";
    row.appendChild(size);

    // Persist a partial settings change and re-render.
    const saveModelSettings = (patch) => {
      postJson(
        "/api/llamacpp/manager/models/settings",
        { file: m.file, ...patch },
        "Save llama.cpp model settings",
      )
        .then(() => refreshLlamaCppManager())
        .catch((e) => console.error(e));
    };

    if (full) {
      const mkNum = (labelText, key, value, min, max, step, parent) => {
        const holder = document.createElement("label");
        holder.style.cssText =
          "display: flex; align-items: center; gap: 4px; font-size: calc(9px * var(--font-scale, 1));";
        holder.appendChild(document.createTextNode(labelText));
        const input = document.createElement("input");
        input.type = "number";
        input.min = min;
        input.max = max;
        input.step = step;
        input.value = value;
        input.style.cssText = numInputStyle;
        input.addEventListener("change", () => {
          const v = parseInt(input.value, 10);
          if (!Number.isFinite(v)) {
            // Empty/garbage input would JSON-serialize to null and make
            // the server reset the field to its default — restore the
            // saved value instead of persisting anything.
            input.value = value;
            return;
          }
          saveModelSettings({ [key]: v });
        });
        holder.appendChild(input);
        (parent || row).appendChild(holder);
        return input;
      };
      const mkCheck = (labelText, key, checked, parent) => {
        const holder = document.createElement("label");
        holder.style.cssText =
          "display: flex; align-items: center; gap: 4px; font-size: calc(9px * var(--font-scale, 1));";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.className = "dive-check";
        input.checked = checked === true;
        input.addEventListener("change", () =>
          saveModelSettings({ [key]: input.checked }),
        );
        holder.appendChild(input);
        holder.appendChild(document.createTextNode(labelText));
        (parent || row).appendChild(holder);
        return input;
      };
      const mkSelect = (labelText, key, value, options, parent) => {
        const holder = document.createElement("label");
        holder.style.cssText =
          "display: flex; align-items: center; gap: 4px; font-size: calc(9px * var(--font-scale, 1));";
        holder.appendChild(document.createTextNode(labelText));
        const sel = document.createElement("select");
        sel.style.cssText =
          "padding: 3px 4px; background: var(--flat-fill); color: var(--text-inverse); border: none; font-family: inherit; font-size: calc(10px * var(--font-scale, 1)); outline: none;";
        for (const opt of options) {
          const o = document.createElement("option");
          o.value = opt;
          o.textContent = opt;
          if (opt === value) o.selected = true;
          sel.appendChild(o);
        }
        sel.addEventListener("change", () =>
          saveModelSettings({ [key]: sel.value }),
        );
        holder.appendChild(sel);
        (parent || row).appendChild(holder);
        return sel;
      };

      // CONTEXT is a slider capped at the model's trained context
      // length (from the GGUF header); unknown models fall back to 128K.
      const ctxHolder = document.createElement("label");
      ctxHolder.style.cssText =
        "display: flex; align-items: center; gap: 4px; font-size: calc(9px * var(--font-scale, 1)); flex: 1 1 240px; min-width: 200px;";
      ctxHolder.appendChild(document.createTextNode("CONTEXT"));
      const ctxMax = m.maxCtx && m.maxCtx >= 512 ? m.maxCtx : 131072;
      const ctxSlider = document.createElement("input");
      ctxSlider.type = "range";
      ctxSlider.min = 256;
      ctxSlider.max = ctxMax;
      ctxSlider.step = 256;
      ctxSlider.value = Math.min(m.ctx, ctxMax);
      ctxSlider.style.cssText =
        "flex: 1; min-width: 90px; accent-color: var(--accent); margin: 0;";
      const ctxValue = document.createElement("span");
      ctxValue.style.cssText =
        "min-width: 92px; text-align: right; opacity: 0.8; white-space: nowrap;";
      const setCtxLabel = (v) => {
        ctxValue.textContent = `${Number(v).toLocaleString()} / ${llamaCppFmtCtx(ctxMax)}`;
      };
      setCtxLabel(ctxSlider.value);
      ctxSlider.addEventListener("input", () => setCtxLabel(ctxSlider.value));
      ctxSlider.addEventListener("change", () => {
        const next = parseInt(ctxSlider.value, 10);
        saveModelSettings({ ctx: next });
        // Move the token counter now rather than on the next poll: the
        // slider and the counter showing different numbers is what makes
        // this setting feel like it has not applied.
        const selected = String(localModelConfig.llamacpp.model || "");
        const stem = selected.replace(/\.gguf$/i, "");
        if (
          mode === "llamacpp" &&
          (m.file === selected || m.file.replace(/\.gguf$/i, "") === stem)
        ) {
          updateTokenCounter(
            "llamacpp",
            typeof llamacppTokenState.used === "number"
              ? llamacppTokenState.used
              : 0,
            next,
          );
        }
      });
      ctxSlider.title =
        "Context window in tokens. The KV cache grows with it — larger contexts use more memory. Max is what the model was trained for.";
      ctxHolder.appendChild(ctxSlider);
      ctxHolder.appendChild(ctxValue);
      row.appendChild(ctxHolder);

      mkNum("GPU LAYERS", "gpuLayers", m.gpuLayers, 0, 999, 1);
      mkCheck("EMBED", "embedding", m.embedding);

      // Advanced load options, collapsed by default to keep the row
      // clean. One arrow glyph rotated via CSS so the button is exactly
      // the same size open and closed; open state survives re-renders.
      const advPanel = document.createElement("div");
      advPanel.style.cssText =
        "display: none; gap: 10px 14px; flex-wrap: wrap; align-items: center; padding: 6px 0 2px 12px;";
      const advToggle = document.createElement("button");
      advToggle.type = "button";
      advToggle.className = "settings-action-btn";
      const advArrow = document.createElement("span");
      advArrow.textContent = "▾";
      advArrow.style.cssText =
        "display: inline-block; transition: transform 0.1s;";
      advToggle.appendChild(document.createTextNode("ADVANCED "));
      advToggle.appendChild(advArrow);
      const applyAdvState = (open) => {
        advPanel.style.display = open ? "flex" : "none";
        advArrow.style.transform = open ? "rotate(180deg)" : "none";
      };
      applyAdvState(llamaCppAdvOpen.has(m.file));
      advToggle.addEventListener("click", () => {
        const open = !llamaCppAdvOpen.has(m.file);
        if (open) llamaCppAdvOpen.add(m.file);
        else llamaCppAdvOpen.delete(m.file);
        applyAdvState(open);
      });
      row.appendChild(advToggle);

      mkNum("THREADS", "threads", m.threads || 0, 0, 1024, 1, advPanel);
      mkNum("BATCH", "batchSize", m.batchSize || 0, 0, 131072, 64, advPanel);
      mkCheck("FLASH ATTENTION", "flashAttn", m.flashAttn, advPanel);
      mkCheck("KEEP IN RAM (MLOCK)", "mlock", m.mlock, advPanel);
      mkSelect("KV CACHE K", "cacheTypeK", m.cacheTypeK, cacheTypes, advPanel);
      mkSelect("KV CACHE V", "cacheTypeV", m.cacheTypeV, cacheTypes, advPanel);
      // Compatibility switch, and the odd one out here: it lives in the
      // local-model settings (the chat path reads those) rather than in
      // the llama.cpp model settings the helpers above write, so it needs
      // its own handler instead of mkCheck.
      mkSingleSystemCheck(m.file, advPanel);
      container.appendChild(advPanel);
    }

    const loadBtn = document.createElement("button");
    loadBtn.type = "button";
    loadBtn.className = "settings-action-btn llama-load-btn";
    // Router-loaded models offer UNLOAD (frees RAM via the router);
    // Dive-managed ones offer STOP; everything else offers LOAD.
    loadBtn.textContent =
      routerState === "loaded" ? "UNLOAD" : isActive ? "STOP" : "LOAD";
    loadBtn.disabled = anyStarting || routerState === "loading";
    loadBtn.addEventListener("click", async () => {
      if (isActive) {
        loadBtn.disabled = true;
        try {
          await postJson(
            "/api/llamacpp/manager/stop",
            routerState === "loaded"
              ? { slot: m.embedding ? "embedding" : "chat", model: m.file }
              : { slot: activeSlot },
            "Stop llama.cpp server",
          );
        } catch (e) {
          await appAlert(e.message || String(e), "llama.cpp");
        } finally {
          // Always re-render: without this a failed stop leaves the
          // button permanently disabled.
          await refreshLlamaCppManager().catch(
            uiRefreshFailed("llama.cpp manager"),
          );
        }
        return;
      }
      await llamaCppLoadModel(m);
    });
    row.appendChild(loadBtn);

    if (full) {
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "settings-action-btn";
      delBtn.textContent = "×";
      delBtn.title = "Delete this model file";
      delBtn.style.cssText = "border-color: #ff4444; color: #ff4444;";
      delBtn.addEventListener("click", async () => {
        const sure = await appConfirm(
          `Delete ${m.file} (${llamaCppFmtBytes(m.sizeBytes)}) from disk?${isActive ? " It is currently loaded and will be stopped first." : ""}`,
          "llama.cpp",
          { confirmLabel: "Delete", danger: true },
        );
        if (!sure) return;
        try {
          await postJson(
            "/api/llamacpp/manager/models/delete",
            { file: m.file },
            "Delete llama.cpp model",
          );
          await refreshLlamaCppManager();
        } catch (e) {
          await appAlert(e.message || String(e), "llama.cpp");
        }
      });
      row.appendChild(delBtn);
    }
    wrap.appendChild(container);
  }
  // Only adapters with NO parent model get a row: an attached one is
  // already accounted for on its model's meta line, while an orphan is
  // gigabytes that nothing will ever load — it has to stay visible and
  // deletable rather than silently occupying the disk.
  if (full) {
    for (const p of projectorByFile.values()) {
      if (renderedProjectors.has(p.file)) continue;
      wrap.appendChild(buildProjectorLine(p, true));
    }
  }
}

function renderLlamaCppDownload(status) {
  const wrap = document.getElementById("llamaCppHfDownload");
  if (!wrap) return;
  wrap.textContent = "";
  const d = status.download;
  if (!d) return;
  const row = document.createElement("div");
  row.style.cssText =
    "display: flex; flex-direction: column; gap: 4px; padding: 6px 0;";
  const label = document.createElement("div");
  label.style.cssText = "font-size: calc(10px * var(--font-scale, 1));";
  if (d.active) {
    const pct = d.total ? Math.floor((d.received / d.total) * 100) : null;
    const partInfo =
      d.filesCount > 1
        ? ` (part ${(d.fileIndex || 0) + 1}/${d.filesCount})`
        : "";
    label.textContent = `Downloading ${d.file}${partInfo} — ${llamaCppFmtBytes(d.received)}${d.total ? ` / ${llamaCppFmtBytes(d.total)} (${pct}%)` : ""}`;
    const barOuter = document.createElement("div");
    if (pct === null) {
      // Unknown size: indeterminate animated bar.
      barOuter.className = "dive-progress";
    } else {
      barOuter.className = "dive-progress-bar";
      const barInner = document.createElement("span");
      barInner.style.width = `${pct}%`;
      barOuter.appendChild(barInner);
    }
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "settings-action-btn";
    cancel.textContent = "CANCEL DOWNLOAD";
    cancel.addEventListener("click", () =>
      postJson(
        "/api/llamacpp/manager/hf/download/cancel",
        {},
        "Cancel download",
      )
        .then(() => refreshLlamaCppManager())
        .catch(uiRefreshFailed("llama.cpp manager")),
    );
    row.appendChild(label);
    row.appendChild(barOuter);
    row.appendChild(cancel);
  } else if (d.error && d.error !== "Cancelled.") {
    label.textContent = `Download failed: ${d.error}`;
    label.style.color = "#ff4444";
    row.appendChild(label);
  } else if (d.done) {
    label.textContent = `Downloaded ${d.file} — it now appears in the model library above.`;
    label.style.color = "var(--accent)";
    row.appendChild(label);
  }
  wrap.appendChild(row);
}

async function refreshLlamaCppManager() {
  const status = await llamaCppManagerFetchStatus();
  llamaCppLastStatus = status; // for the synchronous elapsed-time ticker
  // When the router's loaded chat model changes (a chat auto-loaded or
  // evicted one), refresh the model list so the token-counter total
  // reflects the context window of what is actually running.
  const loadedNow =
    (status.chatExternal?.models || []).find((m) => m.state === "loaded")?.id ||
    (status.chat?.state === "running" ? status.chat.model : "") ||
    "";
  if (loadedNow !== llamaCppLastLoadedChatModel) {
    llamaCppLastLoadedChatModel = loadedNow;
    fetchLocalModelList("llamacpp").catch(uiRefreshFailed("local model list"));
  } else if (mode === "llamacpp") {
    // Same model still loaded (or still none), but its configured context
    // may have just changed on the CONTEXT slider — the counter tracks
    // that without waiting for the model list to be refetched.
    updateTokenCounter(
      "llamacpp",
      typeof llamacppTokenState.used === "number" ? llamacppTokenState.used : 0,
      llamaCppTokenCounterTotal(),
    );
  }
  // MAIN: status + compact loader. MODELS tab: status + full management.
  renderLlamaCppStatusInto(
    document.getElementById("llamaCppManagerStatus"),
    status,
  );
  renderLlamaCppStatusInto(
    document.getElementById("llamaCppTabStatus"),
    status,
  );
  renderLlamaCppModelList(status, "llamaCppManagerModels", false);
  renderLlamaCppModelList(status, "llamaCppTabModels", true);
  renderLlamaCppDownload(status);
  const fillInput = (id, value) => {
    const input = document.getElementById(id);
    if (input && document.activeElement !== input) {
      input.value = value;
    }
  };
  fillInput("llamaCppModelsDir", status.modelsDir || "");
  fillInput("llamaCppPortInput", String(status.port || ""));
  fillInput("llamaCppBinaryPath", status.binaryPath || "");
  fillInput("llamaCppExtraArgs", status.extraArgs || "");
  const binaryInput = document.getElementById("llamaCppBinaryPath");
  if (binaryInput) {
    binaryInput.placeholder = status.binary
      ? `auto-detected: ${status.binary}`
      : "e.g. /opt/homebrew/bin/llama-server";
  }
  const evictInput = document.getElementById("llamaCppEvictInput");
  if (evictInput) evictInput.checked = status.evictOnLoad !== false;
  const autoInput = document.getElementById("llamaCppAutostartInput");
  if (autoInput) autoInput.checked = status.autostart === true;
  renderPresetRouters(status.presetSync || {});
  llamaCppManagerSchedulePoll(status);
  return status;
}

// What preset sync found for itself, in place of the fields that used to
// have to be filled in. Nothing here is editable — it is a report.
function renderPresetRouters(sync) {
  const el = document.getElementById("llamaCppPresetRouters");
  if (!el) return;
  const found = (sync.routers || []).filter((r) => r.discovered);
  if (!found.length) {
    el.textContent =
      "No llama-server router detected — Dive is managing its own servers, so there are no presets to keep in step.";
    return;
  }
  el.textContent = found
    .map(
      (r) =>
        `${r.kind === "embed" ? "EMBEDDING" : "CHAT"} router (pid ${r.pid}) → ${r.filePath}`,
    )
    .join("\n");
}

// Human-readable outcome of a preset sync. A dry run is shown as a plain
// diff so nothing is applied on the strength of a summary alone.
function renderPresetSyncResult(result, dryRun) {
  const out = document.getElementById("llamaCppPresetOutput");
  if (!out) return;
  if (!result || result.enabled === false) {
    out.textContent =
      "No llama-server router is running, so there is no preset to sync.";
    return;
  }
  if (result.error) {
    out.textContent = `Sync failed: ${result.error}`;
    return;
  }
  const lines = [];
  for (const file of result.files || []) {
    const label = `${file.kind.toUpperCase()} ${file.filePath}`;
    if (file.error) {
      lines.push(`${label}\n  error: ${file.error}`);
      continue;
    }
    if (!file.changed) {
      lines.push(`${label}\n  already up to date`);
    } else if (dryRun) {
      lines.push(`${label}\n  would change`);
    } else {
      lines.push(
        `${label}\n  updated${file.backup ? ` (backup: ${file.backup})` : ""}`,
      );
    }
    if (file.managed?.length) {
      lines.push(`  dive-managed: ${file.managed.join(", ")}`);
    }
    for (const skip of file.skipped || []) {
      lines.push(`  left alone: ${skip.file} — ${skip.reason}`);
    }
    for (const gone of file.removed || []) {
      lines.push(`  removed: [${gone.section}] — model file is gone`);
    }
    for (const stale of file.stale || []) {
      lines.push(
        `  stale, outside the models folder (yours to remove): [${stale.section}] -> ${stale.model}`,
      );
    }
    if (dryRun && file.changed) {
      lines.push("", "--- new file contents ---", file.after);
    }
  }
  for (const r of result.restart || []) {
    lines.push(
      r.attempted
        ? `${r.kind} router restart: ${r.ok ? "ok" : `failed — ${r.error}`}`
        : `${r.kind} router not restarted: ${r.reason}`,
    );
  }
  out.textContent = lines.join("\n") || "Nothing to do.";
}

function renderLlamaCppHfResults(results) {
  const wrap = document.getElementById("llamaCppHfResults");
  if (!wrap) return;
  wrap.textContent = "";
  if (!results.length) {
    const empty = document.createElement("div");
    empty.className = "setting-help";
    empty.textContent = "No GGUF repositories matched that search.";
    wrap.appendChild(empty);
    return;
  }
  for (const r of results) {
    const row = document.createElement("div");
    row.style.cssText =
      "padding: 5px 0; border-bottom: 1px solid var(--flat-fill);";
    const head = document.createElement("div");
    head.style.cssText =
      "display: flex; align-items: center; gap: 8px; cursor: pointer;";
    const name = document.createElement("div");
    name.textContent = r.id;
    name.style.cssText =
      "flex: 1; font-size: calc(11px * var(--font-scale, 1)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
    const meta = document.createElement("span");
    meta.textContent = `${(r.downloads || 0).toLocaleString()} downloads`;
    meta.style.cssText =
      "font-size: calc(9px * var(--font-scale, 1)); opacity: 0.6;";
    head.appendChild(name);
    head.appendChild(meta);
    row.appendChild(head);
    const filesWrap = document.createElement("div");
    row.appendChild(filesWrap);
    let loaded = false;
    head.addEventListener("click", async () => {
      if (loaded) {
        filesWrap.textContent = "";
        loaded = false;
        return;
      }
      loaded = true;
      filesWrap.textContent = "Loading file list…";
      try {
        const res = await fetch(
          apiUrl(
            `/api/llamacpp/manager/hf/files?repo=${encodeURIComponent(r.id)}`,
          ),
        );
        const data = await readJsonResponse(res, "List GGUF files");
        filesWrap.textContent = "";
        const files = Array.isArray(data.files) ? data.files : [];
        if (!files.length) {
          filesWrap.textContent = "No .gguf files in this repository.";
          return;
        }
        // Repo-level GGUF metadata from Hugging Face: what the model
        // is, how big, and how much context it was trained for.
        if (data.gguf) {
          const bits = [];
          if (data.gguf.architecture) bits.push(data.gguf.architecture);
          const params = llamaCppFmtParams(data.gguf.totalParams);
          if (params) bits.push(params);
          if (data.gguf.contextLength) {
            bits.push(`max context ${llamaCppFmtCtx(data.gguf.contextLength)}`);
          }
          if (bits.length) {
            const metaLine = document.createElement("div");
            metaLine.textContent = bits.join(" · ");
            metaLine.style.cssText =
              "font-size: calc(9px * var(--font-scale, 1)); opacity: 0.7; padding: 2px 0 2px 12px; color: var(--accent);";
            filesWrap.appendChild(metaLine);
          }
        }
        for (const g of llamaCppGroupHfFiles(files)) {
          const fileRow = document.createElement("div");
          fileRow.style.cssText =
            "display: flex; align-items: center; gap: 6px; padding: 3px 0 3px 12px; flex-wrap: wrap;";
          const fname = document.createElement("div");
          fname.textContent =
            g.label + (g.parts > 1 ? ` (${g.parts} parts)` : "");
          fname.style.cssText =
            "flex: 1 1 100%; font-size: calc(10px * var(--font-scale, 1)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
          fileRow.appendChild(fname);
          // Quantization + what it means, so the choice is informed.
          const hint = llamaCppQuantHint(g.quant);
          if (g.quant || hint) {
            const quantLine = document.createElement("span");
            quantLine.textContent = [g.quant, hint].filter(Boolean).join(" — ");
            quantLine.style.cssText =
              "flex: 1; font-size: calc(9px * var(--font-scale, 1)); opacity: 0.6; padding-left: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;";
            fileRow.appendChild(quantLine);
          }
          const fsize = document.createElement("span");
          fsize.textContent = llamaCppFmtBytes(g.totalBytes);
          fsize.style.cssText =
            "font-size: calc(9px * var(--font-scale, 1)); opacity: 0.6;";
          const dlBtn = document.createElement("button");
          dlBtn.type = "button";
          dlBtn.className = "settings-action-btn";
          dlBtn.textContent = "DOWNLOAD";
          dlBtn.addEventListener("click", async () => {
            try {
              await postJson(
                "/api/llamacpp/manager/hf/download",
                {
                  repo: r.id,
                  files: g.files,
                  totalBytes: g.totalBytes,
                },
                "Start model download",
              );
              await refreshLlamaCppManager();
            } catch (e) {
              await appAlert(e.message || String(e), "llama.cpp");
            }
          });
          fileRow.appendChild(fsize);
          fileRow.appendChild(dlBtn);
          filesWrap.appendChild(fileRow);
        }
      } catch (e) {
        filesWrap.textContent = `Could not list files: ${e.message}`;
      }
    });
    wrap.appendChild(row);
  }
}

function wireLlamaCppManager() {
  // Config fields all POST a partial /config body and re-sync from the
  // server so what's shown is always what was actually saved.
  const saveManagerConfig = (patch, label) =>
    postJson("/api/llamacpp/manager/config", patch, label)
      .then(() => refreshLlamaCppManager())
      .catch((e) => console.error(e));
  const evictInput = document.getElementById("llamaCppEvictInput");
  if (evictInput) {
    evictInput.addEventListener("change", () =>
      saveManagerConfig(
        { evictOnLoad: evictInput.checked },
        "Save llama.cpp eviction policy",
      ),
    );
  }
  const autoInput = document.getElementById("llamaCppAutostartInput");
  if (autoInput) {
    autoInput.addEventListener("change", () =>
      saveManagerConfig(
        { autostart: autoInput.checked },
        "Save llama.cpp autostart",
      ),
    );
  }
  const dirInput = document.getElementById("llamaCppModelsDir");
  if (dirInput) {
    dirInput.addEventListener("change", () =>
      saveManagerConfig(
        { modelsDir: dirInput.value.trim() },
        "Save llama.cpp models folder",
      ),
    );
  }
  const portInput = document.getElementById("llamaCppPortInput");
  if (portInput) {
    portInput.addEventListener("change", () =>
      saveManagerConfig(
        { port: parseInt(portInput.value, 10) },
        "Save llama.cpp server port",
      ),
    );
  }
  const binaryInput = document.getElementById("llamaCppBinaryPath");
  if (binaryInput) {
    binaryInput.addEventListener("change", () =>
      saveManagerConfig(
        { binaryPath: binaryInput.value.trim() },
        "Save llama-server binary path",
      ),
    );
  }
  const extraArgsInput = document.getElementById("llamaCppExtraArgs");
  if (extraArgsInput) {
    extraArgsInput.addEventListener("change", () =>
      saveManagerConfig(
        { extraArgs: extraArgsInput.value.trim() },
        "Save llama.cpp extra arguments",
      ),
    );
  }
  // Nothing to save: preset sync configures itself from the running
  // routers. PREVIEW / SYNC NOW remain, for looking at what it would do.
  const runPresetSync = async (dryRun) => {
    const out = document.getElementById("llamaCppPresetOutput");
    if (out) out.textContent = dryRun ? "Previewing…" : "Syncing…";
    try {
      const result = await postJson(
        "/api/llamacpp/manager/preset/sync",
        { dryRun },
        dryRun ? "Preview preset sync" : "Sync router presets",
      );
      renderPresetSyncResult(result, dryRun);
    } catch (e) {
      if (out) out.textContent = `Sync failed: ${e.message}`;
    }
  };
  const previewBtn = document.getElementById("llamaCppPresetPreviewBtn");
  if (previewBtn) {
    previewBtn.addEventListener("click", () => runPresetSync(true));
  }
  const syncBtn = document.getElementById("llamaCppPresetSyncBtn");
  if (syncBtn) {
    syncBtn.addEventListener("click", () => runPresetSync(false));
  }
  const searchBtn = document.getElementById("llamaCppHfSearchBtn");
  const queryInput = document.getElementById("llamaCppHfQuery");
  const runSearch = async () => {
    const q = (queryInput?.value || "").trim();
    if (!q) return;
    const wrap = document.getElementById("llamaCppHfResults");
    if (wrap) wrap.textContent = "Searching Hugging Face…";
    try {
      const res = await fetch(
        apiUrl(`/api/llamacpp/manager/hf/search?q=${encodeURIComponent(q)}`),
      );
      const data = await readJsonResponse(res, "Hugging Face search");
      renderLlamaCppHfResults(Array.isArray(data.results) ? data.results : []);
    } catch (e) {
      if (wrap) wrap.textContent = `Search failed: ${e.message}`;
    }
  };
  if (searchBtn) searchBtn.addEventListener("click", runSearch);
  if (queryInput) {
    queryInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") runSearch();
    });
    // Clearing the query clears the stale results with it.
    queryInput.addEventListener("input", () => {
      if (queryInput.value.trim()) return;
      const wrap = document.getElementById("llamaCppHfResults");
      if (wrap) wrap.textContent = "";
    });
  }
  refreshLlamaCppManager().catch(uiRefreshFailed("llama.cpp manager"));
}

// HISTORY
