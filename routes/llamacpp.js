// llama.cpp manager: run llama-server as managed child processes so the whole
// llama.cpp workflow (download a GGUF from Hugging Face, tune context size and
// GPU layers per model, load/unload/delete) lives inside Dive — no terminal.
//
// Two independent server slots:
//   - chat      (cfg.port):     the conversational model. Loading a new chat
//                               model evicts the previous one when the
//                               evictOnLoad policy is on (default); with the
//                               policy off a load is refused until the running
//                               model is stopped manually.
//   - embedding (cfg.port + 1): a model marked as an embedding model runs
//                               here with --embedding. Chat loads NEVER evict
//                               it; only loading another embedding model (or
//                               stopping it) replaces it.
//
// The manager only LAUNCHES servers; chatting still flows through the existing
// OpenAI-compatible /api/llamacpp/stream path. When a chat model finishes
// loading, the llamacpp mode's baseUrl is pointed at the managed server.
const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const { spawn } = require("child_process");
const preset = require("./llamacpp-preset");
const routers = require("./llamacpp-router-discovery");

module.exports = function createLlamaCppDomain(deps) {
  const {
    DATA_DIR,
    parseJsonBody,
    buildExecutablePath,
    loadLocalModelSettings,
    saveLocalModelSettings,
    // Preset sync restarts the embedding router; it must not do that while an
    // index run is streaming through it. Absent, it assumes idle.
    isLibraryIndexRunning = () => false,
    // Pushes a live event to every connected client. Absent, the UI falls back
    // to its polling refresh.
    broadcastAppEvent = () => {},
  } = deps;

  const CONFIG_FILE = path.join(DATA_DIR, "llamacpp.json");
  const DEFAULT_MODELS_DIR = path.join(os.homedir(), "models");
  // Pre-1.0 default lived inside the Dive data dir; migrated to ~/models.
  const LEGACY_MODELS_DIR = path.join(DATA_DIR, "llamacpp-models");
  const DEFAULT_PORT = 8130;
  // Per-model load options. 0/"" means "let llama.cpp decide" (flag omitted).
  const MODEL_DEFAULTS = {
    // Enough to be useful on a fresh download without having to touch the
    // slider, and small enough to be safe on any machine: the KV cache is
    // roughly 2 GB here even for an architecture with no sliding-window
    // discount, against 26 GB if a 256K-context model were allowed its
    // trained maximum. A model trained for less gets less — the chosen
    // context is always capped by the GGUF's own maximum.
    ctx: 20480,
    gpuLayers: 99,
    threads: 0,
    batchSize: 0,
    flashAttn: false,
    mlock: false,
    cacheTypeK: "f16",
    cacheTypeV: "f16",
  };
  // Valid llama.cpp KV-cache quantization types (from `llama-server --help`).
  const CACHE_TYPES = ["f16", "q8_0", "q5_1", "q5_0", "q4_1", "q4_0", "f32"];
  const LOAD_TIMEOUT_MS = 300000; // large models + big KV caches take a while
  const LOG_RING_SIZE = 80;
  const SLOT_IDS = ["chat", "embedding"];

  // ---- Config ----

  function defaultConfig() {
    return {
      modelsDir: DEFAULT_MODELS_DIR,
      binaryPath: "",
      port: DEFAULT_PORT,
      extraArgs: "",
      evictOnLoad: true,
      autostart: false,
      lastModel: "",
      lastEmbeddingModel: "",
      models: {},
      // Router preset sync. Automatic and unconfigured: the preset file and
      // models folder are read back from the running router's own command
      // line, and a restart is a signal to that process (launchd's KeepAlive
      // brings it back), so there is nothing to type in and nothing to switch
      // on. Setups that run Dive's own managed servers — the common case —
      // have no router to discover and never see this at all.
      //
      // The two paths remain only as an override for a router Dive cannot see
      // for itself; both are empty by default and normally stay that way.
      presetSync: {
        chatPresetPath: "",
        embedPresetPath: "",
      },
    };
  }

  function looksLikeEmbeddingModel(file) {
    return /embed|bge-|gte-|e5-|minilm/i.test(file);
  }

  function clampInt(value, min, max, fallback) {
    const n = Number(value);
    return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
  }

  function sanitizeModelEntry(entry, file) {
    const e = entry && typeof entry === "object" ? entry : {};
    return {
      ctx: clampInt(e.ctx, 256, 1048576, MODEL_DEFAULTS.ctx),
      gpuLayers: clampInt(e.gpuLayers, 0, 999, MODEL_DEFAULTS.gpuLayers),
      threads: clampInt(e.threads, 0, 1024, MODEL_DEFAULTS.threads),
      batchSize: clampInt(e.batchSize, 0, 131072, MODEL_DEFAULTS.batchSize),
      flashAttn: e.flashAttn === true,
      mlock: e.mlock === true,
      cacheTypeK: CACHE_TYPES.includes(e.cacheTypeK) ? e.cacheTypeK : "f16",
      cacheTypeV: CACHE_TYPES.includes(e.cacheTypeV) ? e.cacheTypeV : "f16",
      embedding:
        typeof e.embedding === "boolean"
          ? e.embedding
          : looksLikeEmbeddingModel(file),
    };
  }

  function sanitizeConfig(raw) {
    const out = defaultConfig();
    if (raw && typeof raw === "object") {
      if (typeof raw.modelsDir === "string" && raw.modelsDir.trim()) {
        out.modelsDir = raw.modelsDir.trim();
      }
      if (typeof raw.binaryPath === "string") {
        out.binaryPath = raw.binaryPath.trim();
      }
      const port = Number(raw.port);
      if (Number.isInteger(port) && port >= 1024 && port <= 65534) {
        out.port = port;
      }
      if (typeof raw.extraArgs === "string") {
        out.extraArgs = raw.extraArgs.trim().slice(0, 500);
      }
      out.evictOnLoad = raw.evictOnLoad !== false;
      out.autostart = raw.autostart === true;
      if (typeof raw.lastModel === "string") {
        const last = path.basename(raw.lastModel);
        if (last.endsWith(".gguf")) out.lastModel = last;
      }
      if (typeof raw.lastEmbeddingModel === "string") {
        const last = path.basename(raw.lastEmbeddingModel);
        if (last.endsWith(".gguf")) out.lastEmbeddingModel = last;
      }
      if (raw.models && typeof raw.models === "object") {
        for (const [file, entry] of Object.entries(raw.models)) {
          if (!file.endsWith(".gguf") || file !== path.basename(file)) continue;
          out.models[file] = sanitizeModelEntry(entry, file);
        }
      }
      const sync = raw.presetSync;
      if (sync && typeof sync === "object") {
        // A stored `enabled` is deliberately ignored rather than migrated: it
        // defaulted to false, so almost every config on disk carries
        // `enabled: false` by inheritance rather than by choice, and honouring
        // it would keep exactly the users this change is for switched off.
        out.presetSync = {
          chatPresetPath: sanitizePresetPath(sync.chatPresetPath),
          embedPresetPath: sanitizePresetPath(sync.embedPresetPath),
        };
      }
    }
    return out;
  }

  // Only an absolute path to a real .ini is accepted, so a stray relative path
  // can never send a write somewhere unexpected.
  function sanitizePresetPath(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    if (!path.isAbsolute(raw) || !/\.ini$/i.test(raw)) return "";
    return path.normalize(raw);
  }

  function loadConfig() {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        return sanitizeConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")));
      }
    } catch (e) {
      console.warn("Failed to load llama.cpp config:", e.message || e);
    }
    return defaultConfig();
  }

  function saveConfig(cfg) {
    const sanitized = sanitizeConfig(cfg);
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(sanitized, null, 2));
    return sanitized;
  }

  // One-time migration: configs that still point at the pre-1.0 default
  // (inside the Dive data dir) are moved to ~/models. Same volume, so each
  // model file moves with an instant rename. Custom folders are left alone.
  function migrateLegacyModelsDir() {
    try {
      const cfg = loadConfig();
      if (path.resolve(cfg.modelsDir) !== path.resolve(LEGACY_MODELS_DIR)) {
        return;
      }
      fs.mkdirSync(DEFAULT_MODELS_DIR, { recursive: true });
      let entries = [];
      try {
        entries = fs.readdirSync(LEGACY_MODELS_DIR);
      } catch {
        /* legacy dir never created */
      }
      for (const name of entries) {
        if (!name.endsWith(".gguf") && !name.endsWith(".part")) continue;
        const from = path.join(LEGACY_MODELS_DIR, name);
        const to = path.join(DEFAULT_MODELS_DIR, name);
        if (fs.existsSync(to)) continue; // never overwrite
        try {
          fs.renameSync(from, to);
        } catch (e) {
          console.warn(
            `[llamacpp] could not move ${name} to ~/models:`,
            e.message,
          );
          return; // keep pointing at the legacy dir so no model disappears
        }
      }
      cfg.modelsDir = DEFAULT_MODELS_DIR;
      saveConfig(cfg);
      console.log(`[llamacpp] models folder migrated to ${DEFAULT_MODELS_DIR}`);
    } catch (e) {
      console.warn("[llamacpp] models dir migration failed:", e.message || e);
    }
  }
  migrateLegacyModelsDir();

  function modelSettingsFor(cfg, file) {
    return {
      ...MODEL_DEFAULTS,
      embedding: looksLikeEmbeddingModel(file),
      ...(cfg.models[file] || {}),
    };
  }

  function slotPort(cfg, slotId) {
    return slotId === "embedding" ? cfg.port + 1 : cfg.port;
  }

  // ---- Binary discovery ----

  function findBinary(cfg) {
    if (cfg.binaryPath) {
      return fs.existsSync(cfg.binaryPath) ? cfg.binaryPath : "";
    }
    const dirs = buildExecutablePath(process.env.PATH || "").split(
      path.delimiter,
    );
    for (const dir of dirs) {
      const candidate = path.join(dir, "llama-server");
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        /* keep looking */
      }
    }
    return "";
  }

  // ---- GGUF metadata ----
  // Read the GGUF header key/value section to learn what a model actually is:
  // architecture, trained context length, quantization, parameter size label.
  // Only the first few MB are read; parsing stops at the tokenizer keys (the
  // interesting keys always precede them in files written by llama.cpp).

  const GGUF_SCALAR_SIZES = {
    0: 1, // uint8
    1: 1, // int8
    2: 2, // uint16
    3: 2, // int16
    4: 4, // uint32
    5: 4, // int32
    6: 4, // float32
    7: 1, // bool
    10: 8, // uint64
    11: 8, // int64
    12: 8, // float64
  };
  // general.file_type values (llama_ftype in llama.cpp).
  const GGUF_FILE_TYPES = {
    0: "F32",
    1: "F16",
    2: "Q4_0",
    3: "Q4_1",
    7: "Q8_0",
    8: "Q5_0",
    9: "Q5_1",
    10: "Q2_K",
    11: "Q3_K_S",
    12: "Q3_K_M",
    13: "Q3_K_L",
    14: "Q4_K_S",
    15: "Q4_K_M",
    16: "Q5_K_S",
    17: "Q5_K_M",
    18: "Q6_K",
    19: "IQ2_XXS",
    20: "IQ2_XS",
    21: "Q2_K_S",
    22: "IQ3_XS",
    23: "IQ3_XXS",
    24: "IQ1_S",
    25: "IQ4_NL",
    26: "IQ3_S",
    27: "IQ3_M",
    28: "IQ2_S",
    29: "IQ2_M",
    30: "IQ4_XS",
    31: "IQ1_M",
    32: "BF16",
    36: "TQ1_0",
    37: "TQ2_0",
  };

  function quantFromFilename(file) {
    const m = String(file)
      .toUpperCase()
      .match(
        /(IQ[1-4]_[A-Z0-9]+|Q[2-8]_K_[SML]|Q[2-8]_K|Q[2-8]_[01]|BF16|FP16|F16|FP32|F32)/,
      );
    return m ? m[1] : "";
  }

  function parseGgufHeader(filePath) {
    let fd;
    try {
      fd = fs.openSync(filePath, "r");
      const CAP = 4 * 1024 * 1024;
      const buf = Buffer.alloc(CAP);
      const bytes = fs.readSync(fd, buf, 0, CAP, 0);
      const view = buf.subarray(0, bytes);
      if (view.length < 24 || view.toString("ascii", 0, 4) !== "GGUF") {
        return null;
      }
      const version = view.readUInt32LE(4);
      if (version < 2 || version > 3) return null; // v1 (u32 counts) is extinct
      const kvCount = Number(view.readBigUInt64LE(16));
      let off = 24;
      const meta = {};
      const need = (n) => off + n <= view.length;
      const readStr = () => {
        if (!need(8)) return null;
        const len = Number(view.readBigUInt64LE(off));
        off += 8;
        if (len > 1 << 20 || !need(len)) return null;
        const s = view.toString("utf8", off, off + len);
        off += len;
        return s;
      };
      for (let i = 0; i < kvCount && i < 512; i++) {
        const key = readStr();
        if (key === null || !need(4)) break;
        // The huge vocab/merges arrays come after everything we care about.
        if (key.startsWith("tokenizer.")) break;
        const type = view.readUInt32LE(off);
        off += 4;
        if (type === 8) {
          const value = readStr();
          if (value === null) break;
          meta[key] = value;
        } else if (type === 9) {
          if (!need(12)) break;
          const itemType = view.readUInt32LE(off);
          off += 4;
          const count = Number(view.readBigUInt64LE(off));
          off += 8;
          if (itemType === 8 || itemType === 9) {
            // Walking a string array item-by-item; bail if it leaves the window.
            let ok = true;
            for (let j = 0; j < count; j++) {
              if (itemType !== 8 || readStr() === null) {
                ok = false;
                break;
              }
            }
            if (!ok) break;
          } else {
            const size = GGUF_SCALAR_SIZES[itemType];
            if (!size) break;
            off += size * count;
            if (off > view.length) break;
          }
        } else {
          const size = GGUF_SCALAR_SIZES[type];
          if (!size || !need(size)) break;
          let value;
          switch (type) {
            case 0:
              value = view.readUInt8(off);
              break;
            case 1:
              value = view.readInt8(off);
              break;
            case 2:
              value = view.readUInt16LE(off);
              break;
            case 3:
              value = view.readInt16LE(off);
              break;
            case 4:
              value = view.readUInt32LE(off);
              break;
            case 5:
              value = view.readInt32LE(off);
              break;
            case 6:
              value = view.readFloatLE(off);
              break;
            case 7:
              value = view.readUInt8(off) !== 0;
              break;
            case 10:
              value = Number(view.readBigUInt64LE(off));
              break;
            case 11:
              value = Number(view.readBigInt64LE(off));
              break;
            case 12:
              value = view.readDoubleLE(off);
              break;
          }
          off += size;
          meta[key] = value;
        }
      }
      return meta;
    } catch {
      return null;
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    }
  }

  // filePath -> { size, mtimeMs, info } so headers are read once per file.
  const ggufMetaCache = new Map();

  function ggufInfoFor(filePath, stat) {
    const cached = ggufMetaCache.get(filePath);
    if (
      cached &&
      cached.size === stat.size &&
      cached.mtimeMs === stat.mtimeMs
    ) {
      return cached.info;
    }
    const meta = parseGgufHeader(filePath);
    const arch =
      typeof meta?.["general.architecture"] === "string"
        ? meta["general.architecture"]
        : "";
    const ctxRaw = arch ? Number(meta?.[`${arch}.context_length`]) : 0;
    const info = {
      arch,
      modelName:
        typeof meta?.["general.name"] === "string" ? meta["general.name"] : "",
      sizeLabel:
        typeof meta?.["general.size_label"] === "string"
          ? meta["general.size_label"]
          : "",
      quant:
        GGUF_FILE_TYPES[meta?.["general.file_type"]] ||
        quantFromFilename(path.basename(filePath)),
      maxCtx: Number.isFinite(ctxRaw) && ctxRaw > 0 ? ctxRaw : 0,
    };
    ggufMetaCache.set(filePath, {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      info,
    });
    return info;
  }

  // Split GGUFs: "name-00001-of-00003.gguf". llama.cpp loads the whole set
  // when pointed at the first part, so only that part is listed as loadable.
  const GGUF_PART_RE = /-(\d{5})-of-(\d{5})\.gguf$/;

  // ---- Model folder scanning ----

  function modelFilePath(cfg, file) {
    // Names are always plain basenames; anything else is a traversal attempt.
    if (
      typeof file !== "string" ||
      !file.endsWith(".gguf") ||
      file !== path.basename(file)
    ) {
      return null;
    }
    return path.join(cfg.modelsDir, file);
  }

  // Quant/format/plumbing tokens stripped before comparing a projector's name
  // to a model's, so two unrelated q4 models don't look like a "family match".
  const PROJECTOR_NOISE_TOKENS = new Set([
    "mmproj",
    "mm",
    "proj",
    "clip",
    "vision",
    "model",
    "ggml",
    "gguf",
    "f16",
    "f32",
    "bf16",
    "fp16",
    "fp32",
    "q2",
    "q3",
    "q4",
    "q5",
    "q6",
    "q8",
    "iq2",
    "iq3",
    "iq4",
    "k",
    "m",
    "s",
    "l",
    "xl",
    "xs",
    "xxs",
  ]);

  function projectorFamilyTokens(name) {
    return new Set(
      path
        .basename(name, ".gguf")
        .toLowerCase()
        .replace(/mmproj/g, " ")
        .split(/[^a-z0-9]+/)
        .filter((t) => t && !PROJECTOR_NOISE_TOKENS.has(t)),
    );
  }

  // Vision models (Gemma 3, Qwen2-VL, LLaVA, …) split into a language GGUF plus
  // a separate multimodal projector ("mmproj") GGUF. llama-server needs that
  // projector passed with --mmproj or it rejects image input with
  // "image input is not supported". Projector files carry
  // general.architecture = "clip", so we can spot them by content regardless of
  // how they're named, then pair one with the model being launched. Returns the
  // projector's absolute path, or null when none applies.
  function findProjector(cfg, modelFile) {
    let entries;
    try {
      entries = fs.readdirSync(cfg.modelsDir);
    } catch {
      return null;
    }
    const projectors = [];
    const chatModels = [];
    for (const name of entries) {
      if (!name.endsWith(".gguf")) continue;
      const pm = name.match(GGUF_PART_RE);
      if (pm && pm[1] !== "00001") continue; // non-first split parts aren't loadable
      const full = path.join(cfg.modelsDir, name);
      let stat;
      try {
        stat = fs.statSync(full);
        if (!stat.isFile()) continue;
      } catch {
        continue;
      }
      if (ggufInfoFor(full, stat).arch === "clip") projectors.push(name);
      else chatModels.push(name);
    }
    if (projectors.length === 0) return null;

    // Prefer a projector that shares a model-family token with the model, so the
    // right one is picked when several vision models share the folder.
    const modelTokens = projectorFamilyTokens(modelFile);
    let best = null;
    let bestScore = 0;
    for (const proj of projectors) {
      let score = 0;
      for (const t of projectorFamilyTokens(proj)) {
        if (modelTokens.has(t)) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        best = proj;
      }
    }
    if (best) return path.join(cfg.modelsDir, best);

    // No name overlap (e.g. a generic "mmproj-F16.gguf"): only pair it when the
    // setup is unambiguous — one projector and one model — so a projector is
    // never wrongly attached to an unrelated text-only model.
    if (projectors.length === 1 && chatModels.length === 1) {
      return path.join(cfg.modelsDir, projectors[0]);
    }
    return null;
  }

  function scanModels(cfg) {
    let entries = [];
    try {
      entries = fs.readdirSync(cfg.modelsDir);
    } catch {
      return [];
    }
    const models = [];
    // First pass: collect sizes of the extra parts of split models so the
    // first part can report the aggregate size, and count parts present.
    const partSizes = new Map(); // "name-of-00003" prefix -> { bytes, present }
    for (const name of entries) {
      const pm = name.match(GGUF_PART_RE);
      if (!pm) continue;
      const key = name.slice(0, pm.index) + `-of-${pm[2]}`;
      try {
        const stat = fs.statSync(path.join(cfg.modelsDir, name));
        if (!stat.isFile()) continue;
        const agg = partSizes.get(key) || { bytes: 0, present: 0 };
        agg.bytes += stat.size;
        agg.present += 1;
        partSizes.set(key, agg);
      } catch {
        /* unreadable entry */
      }
    }
    for (const name of entries) {
      if (!name.endsWith(".gguf")) continue;
      const pm = name.match(GGUF_PART_RE);
      // Non-first parts are loadable only via part 1; hide them from the list.
      if (pm && pm[1] !== "00001") continue;
      try {
        // statSync (not the dirent) so symlinked model files count too.
        const fullPath = path.join(cfg.modelsDir, name);
        const stat = fs.statSync(fullPath);
        if (!stat.isFile()) continue;
        const entry = {
          file: name,
          sizeBytes: stat.size,
          ...ggufInfoFor(fullPath, stat),
          ...modelSettingsFor(cfg, name),
        };
        if (pm) {
          const key = name.slice(0, pm.index) + `-of-${pm[2]}`;
          const agg = partSizes.get(key);
          entry.parts = Number(pm[2]);
          entry.partsPresent = agg ? agg.present : 1;
          entry.sizeBytes = agg ? agg.bytes : stat.size;
        }
        models.push(entry);
      } catch {
        /* unreadable entry */
      }
    }
    // Pair vision adapters (mmproj files, GGUF architecture "clip") with their
    // parent chat model so the UI can nest them instead of listing them as
    // loadable models. Mirrors findProjector()'s matching over the already
    // scanned set: shared family-name tokens first, then a single-model /
    // single-projector fallback. Purely annotative — adds `projector` to a
    // model and `isProjector`/`parentFile` to an adapter; no entry is removed.
    const projectors = models.filter((m) => m.arch === "clip");
    if (projectors.length) {
      const chatModels = models.filter(
        (m) => m.arch !== "clip" && !m.embedding,
      );
      for (const m of chatModels) {
        const modelTokens = projectorFamilyTokens(m.file);
        let best = null;
        let bestScore = 0;
        for (const p of projectors) {
          let score = 0;
          for (const t of projectorFamilyTokens(p.file)) {
            if (modelTokens.has(t)) score++;
          }
          if (score > bestScore) {
            bestScore = score;
            best = p;
          }
        }
        if (!best && projectors.length === 1 && chatModels.length === 1) {
          best = projectors[0];
        }
        if (best) m.projector = best.file;
      }
      for (const p of projectors) {
        p.isProjector = true;
        const parent = chatModels.find((m) => m.projector === p.file);
        p.parentFile = parent ? parent.file : null;
      }
    }
    return models.sort((a, b) => a.file.localeCompare(b.file));
  }

  // ---- Router preset sync ----

  // Ports where a preset-mode router has been seen, and the restarts currently
  // in flight on them.
  //
  // Both exist to stop Dive taking a router's port. Restarting a router leaves
  // it free for about a second; a load arriving in that window finds the port
  // dead, concludes it is available and starts a managed single-model server on
  // it. That is unrecoverable without intervention: launchd can no longer bind,
  // so the router stays down, and Dive ends up serving ONE model on a port that
  // was serving every model in the preset — with a context fixed at whatever it
  // spawned with, which no amount of editing the preset will change.
  const knownRouterPorts = new Set();
  const routerRestartsInFlight = new Map();

  // Discovery shells out to lsof and ps — about 28ms a port — and the status
  // endpoint is polled every 8 seconds (1.2 while anything is loading), for an
  // answer that only changes when a router restarts. So it is cached briefly,
  // and the restart path clears it rather than waiting for the entry to lapse.
  const ROUTER_CACHE_MS = 4000;
  const routerCache = new Map();

  async function discoverRouterCached(port, { fresh = false } = {}) {
    const hit = routerCache.get(port);
    if (!fresh && hit && Date.now() - hit.at < ROUTER_CACHE_MS) {
      return hit.router;
    }
    const router = await routers.discoverRouter(port).catch(() => null);
    routerCache.set(port, { at: Date.now(), router });
    return router;
  }

  // Wait for any restart on this port to finish, then — if a router belongs
  // here — for it to answer again. Returns false only when a router was
  // expected and never came back, which is the one case where starting a
  // managed server would be wrong rather than merely unlucky.
  async function waitForRouterPort(port) {
    const inFlight = routerRestartsInFlight.get(port);
    if (inFlight) await inFlight.catch(() => {});
    if (!knownRouterPorts.has(port)) return true;
    if (await checkHealth(port)) return true;
    const back = await routers
      .waitForRouter(port, { timeoutMs: 20000 })
      .catch(() => null);
    if (back) return true;
    // Twenty seconds is far longer than launchd needs (it returns in about
    // one), so the router is genuinely gone rather than restarting — retired,
    // or crash-looping and throttled. Refuse this attempt so the reason gets
    // said out loud, then forget the port: a second attempt goes ahead and
    // starts Dive's own server, rather than the guard blocking the app for
    // good over a router that is never coming back.
    knownRouterPorts.delete(port);
    return false;
  }

  // What each router is actually serving, asked of the routers themselves.
  //
  // The chat router listens on cfg.port and the embedding router on the next
  // port, the same pair Dive's own slots would use. A slot Dive is running
  // itself is skipped: that process is a managed single-model server, has no
  // preset, and is nothing to sync.
  //
  // `filePath` prefers an explicitly configured path so a router Dive cannot
  // see for itself can still be pointed at, but nothing has to be configured
  // for the usual case.
  async function discoverRouterTargets(cfg) {
    const sync = cfg.presetSync || {};
    const wanted = [
      { kind: "chat", slot: "chat", override: sync.chatPresetPath },
      { kind: "embed", slot: "embedding", override: sync.embedPresetPath },
    ];
    const found = [];
    for (const { kind, slot, override } of wanted) {
      if (slots[slot].state === "running" || slots[slot].state === "starting") {
        continue;
      }
      const port = slotPort(cfg, slot);
      const router = await discoverRouterCached(port);
      if (router) knownRouterPorts.add(port);
      if (!router && !override) continue;
      found.push({
        kind,
        router,
        filePath: override || router.presetPath,
        // Only the chat router is started with --models-dir; everything else
        // falls back to the folder Dive downloads into, which is the folder
        // being synced in the first place.
        modelsDir: router?.modelsDir || cfg.modelsDir,
      });
    }
    return found;
  }

  // Regenerate the preset files from the models folder. `exclude` holds files
  // that are about to be deleted, so their sections come out BEFORE the .gguf
  // does — a preset that points at a missing file is the one state worth
  // avoiding. Never throws: a broken preset path must not fail a download.
  async function syncRouterPresets(options = {}) {
    const { exclude = [], dryRun = false, restart = true } = options;
    const cfg = loadConfig();
    const excludeSet = new Set(
      exclude.map((f) => path.basename(String(f || ""))).filter(Boolean),
    );
    // No router running means Dive is managing its own servers, which need no
    // preset. Nothing to do, and nothing worth reporting as a failure.
    const targets = await discoverRouterTargets(cfg);
    if (!targets.length) return { enabled: false, dryRun, files: [] };
    let models;
    try {
      models = scanModels(cfg);
    } catch (e) {
      return { enabled: true, dryRun, files: [], error: e.message };
    }
    const files = [];
    const changedKinds = new Set();
    for (const target of targets) {
      try {
        const plan = preset.planPreset({
          filePath: target.filePath,
          kind: target.kind,
          models,
          modelsDir: target.modelsDir,
          exclude: excludeSet,
        });
        const entry = {
          kind: plan.kind,
          filePath: plan.filePath,
          existed: plan.existed,
          changed: plan.changed,
          managed: plan.managed,
          skipped: plan.skipped,
          stale: plan.stale,
          written: false,
          backup: "",
        };
        // A dry run carries the text so the caller can show a real diff.
        if (dryRun) {
          entry.before = plan.before;
          entry.after = plan.after;
        } else if (plan.changed) {
          const result = preset.commitPlan(plan);
          entry.written = result.written;
          entry.backup = result.backup;
          if (result.written) changedKinds.add(plan.kind);
        }
        files.push(entry);
      } catch (e) {
        files.push({
          kind: target.kind,
          filePath: target.filePath,
          error: e.message || String(e),
        });
      }
    }
    const out = {
      enabled: true,
      dryRun,
      files,
      restart: [],
      // Which presets were rewritten, so a caller that deferred the restart
      // (the delete route does) knows what still needs restarting.
      changed: [...changedKinds],
    };
    if (!dryRun && restart) {
      out.restart = await restartChangedRouters(out.changed);
    }
    return out;
  }

  // A preset is read only at startup, so a rewritten file changes nothing
  // until its router restarts. Restart exactly the ones whose file changed.
  async function restartChangedRouters(kinds) {
    const cfg = loadConfig();
    const done = [];
    for (const kind of ["embed", "chat"]) {
      if (!kinds.includes(kind)) continue;
      done.push({ kind, ...(await restartRouter(kind, cfg)) });
    }
    return done;
  }

  const SLOT_FOR_KIND = { chat: "chat", embed: "embedding" };

  // Restarting is just ending the process: both routers run under launchd with
  // KeepAlive=true, so it comes straight back having re-read its preset. The
  // router is re-discovered here rather than reused from the sync above, so
  // the signal always goes to the process that is on the port right now.
  async function restartRouter(kind, cfg) {
    // An index run streams through the embedding server; restarting mid-run
    // would fail the job. The preset is already on disk, so the restart can
    // simply wait for the next sync or a manual one.
    if (kind === "embed" && isLibraryIndexRunning()) {
      return { attempted: false, reason: "a library index job is running" };
    }
    const port = slotPort(cfg, SLOT_FOR_KIND[kind]);
    // Fresh: this is about to signal a PID, so a cached one is not good enough.
    const router = await discoverRouterCached(port, { fresh: true });
    if (!router) {
      return {
        attempted: false,
        reason: `no llama-server router is listening on port ${port}`,
      };
    }
    knownRouterPorts.add(port);
    const result = await routers.restartRouter(router);
    if (!result.ok) return { attempted: true, port, ...result };
    // Wait for launchd to bring it back, so a model load that follows a
    // download is not sent to a port with nothing on it yet. The wait is
    // published while it runs: anything trying to load in this window must
    // queue behind it rather than find the port free and take it.
    const waiting = routers.waitForRouter(port, { previousPid: router.pid });
    routerRestartsInFlight.set(port, waiting);
    let back = null;
    try {
      back = await waiting;
    } finally {
      routerRestartsInFlight.delete(port);
      // The PID changed, so anything remembered about this port is stale.
      routerCache.delete(port);
    }
    return {
      attempted: true,
      port,
      ok: true,
      pid: router.pid,
      restored: Boolean(back),
      newPid: back ? back.pid : 0,
    };
  }

  // Fire-and-forget sync for the paths where a failure must not surface as a
  // download or delete failure.
  function syncRouterPresetsSoon(options) {
    syncRouterPresets(options).catch((e) =>
      console.warn("[llamacpp] preset sync failed:", e.message || e),
    );
  }

  // ---- Live models folder ----
  //
  // Watch the models folder so the library reflects reality without waiting
  // for the next poll, and so a .gguf added or removed OUTSIDE Dive (Finder, a
  // download tool, another machine syncing) still updates the presets.
  // Debounced, because a download writes .part then renames, and a delete of a
  // split model removes several files in a burst.
  let modelsWatcher = null;
  let modelsWatchDir = "";
  let modelsWatchTimer = null;

  function onModelsFolderChanged() {
    clearTimeout(modelsWatchTimer);
    modelsWatchTimer = setTimeout(() => {
      // Presets first, so a client refreshing on this event already sees the
      // regenerated state rather than racing it.
      syncRouterPresets()
        .catch((e) =>
          console.warn("[llamacpp] preset sync failed:", e.message || e),
        )
        .finally(() => broadcastModelsChanged());
    }, 700);
    modelsWatchTimer.unref?.();
  }

  function broadcastModelsChanged() {
    try {
      broadcastAppEvent("llamacpp_models_changed", {});
    } catch (e) {
      console.warn("[llamacpp] could not broadcast:", e.message || e);
    }
  }

  function ensureModelsWatcher() {
    const cfg = loadConfig();
    const dir = cfg.modelsDir;
    if (modelsWatcher && modelsWatchDir === dir) return;
    if (modelsWatcher) {
      try {
        modelsWatcher.close();
      } catch {
        /* already gone */
      }
      modelsWatcher = null;
    }
    modelsWatchDir = dir;
    try {
      modelsWatcher = fs.watch(dir, (_event, filename) => {
        // Only model files matter. Ignoring everything else keeps Dive's own
        // preset writes — the .ini files live in this folder too — from
        // triggering the sync that just wrote them.
        if (filename && !/\.gguf$/i.test(String(filename))) return;
        onModelsFolderChanged();
      });
      modelsWatcher.unref?.();
      modelsWatcher.on?.("error", () => {
        modelsWatcher = null;
      });
    } catch (e) {
      // A missing folder is normal before the first download; the poll still
      // covers the UI until one exists.
      modelsWatcher = null;
      console.warn("[llamacpp] models folder not watchable:", e.message || e);
    }
  }

  ensureModelsWatcher();

  // ---- Managed llama-server processes (one per slot) ----

  function makeSlot() {
    return {
      child: null,
      state: "stopped", // stopped | starting | running | error
      model: "",
      port: 0,
      startedAt: 0,
      lastError: "",
      log: [],
    };
  }

  const slots = { chat: makeSlot(), embedding: makeSlot() };

  function pushLog(slot, chunk) {
    const lines = String(chunk).split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      slot.log.push(trimmed);
      if (slot.log.length > LOG_RING_SIZE) slot.log.shift();
    }
  }

  async function checkHealth(port) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (!res.ok) return false;
      const data = await res.json().catch(() => null);
      return data?.status === "ok";
    } catch {
      return false;
    }
  }

  function pointChatModeAtManagedServer(port) {
    // The chat pipeline reads the llamacpp baseUrl from local-model-settings;
    // updating it here is what makes "load in Dive -> chat in Dive" seamless.
    const settings = loadLocalModelSettings();
    settings.llamacpp.baseUrl = `http://127.0.0.1:${port}/v1`;
    saveLocalModelSettings(settings);
  }

  function stopSlot(slotId) {
    const slot = slots[slotId];
    const child = slot.child;
    slot.child = null;
    slot.state = "stopped";
    slot.model = "";
    slot.startedAt = 0;
    if (child && !child.killed) {
      try {
        child.kill("SIGTERM");
        // llama-server exits promptly on SIGTERM; SIGKILL is the fallback.
        const killTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* already gone */
          }
        }, 4000);
        child.once("exit", () => clearTimeout(killTimer));
      } catch {
        /* already gone */
      }
    }
  }

  async function startServer(file) {
    const cfg = loadConfig();
    const modelPath = modelFilePath(cfg, file);
    if (!modelPath || !fs.existsSync(modelPath)) {
      return { error: `Model file not found in the models folder: ${file}` };
    }
    // Split model: refuse to launch unless every part is on disk (llama.cpp
    // would otherwise fail mid-load with a cryptic error).
    const pm = file.match(GGUF_PART_RE);
    if (pm) {
      const total = Number(pm[2]);
      for (let i = 1; i <= total; i++) {
        const part = `${file.slice(0, pm.index)}-${String(i).padStart(5, "0")}-of-${pm[2]}.gguf`;
        if (!fs.existsSync(path.join(cfg.modelsDir, part))) {
          return {
            error: `This is a split model (${total} parts) and part ${i} is missing. Re-download it from the MODELS tab.`,
          };
        }
      }
    }
    const binary = findBinary(cfg);
    if (!binary) {
      return {
        error:
          "llama-server binary not found. Install it (brew install llama.cpp) or set its path in the llama.cpp settings.",
      };
    }
    const modelCfg = modelSettingsFor(cfg, file);
    const slotId = modelCfg.embedding ? "embedding" : "chat";
    const slot = slots[slotId];
    // Eviction policy applies to the CHAT slot only: embedding models are
    // never evicted by chat loads (they live in their own slot), and loading
    // a different embedding model always replaces the current one.
    if (
      slotId === "chat" &&
      !cfg.evictOnLoad &&
      slot.state !== "stopped" &&
      slot.model &&
      slot.model !== file
    ) {
      return {
        error: `"${slot.model}" is still loaded and eviction on load is disabled. Stop it first, or enable "Evict on load" in the Models tab.`,
      };
    }
    stopSlot(slotId);
    const port = slotPort(cfg, slotId);
    // If a router lives on this port, wait for it — it may be a second into a
    // restart. Starting a managed server here instead would take the port for
    // good: launchd could not rebind, and one model would replace the whole
    // preset until somebody noticed and killed it by hand.
    if (!(await waitForRouterPort(port))) {
      return {
        error: `The llama-server router on port ${port} stopped answering, so Dive did not start its own server there — taking the port would stop the router coming back. Check it with "launchctl list | grep llamacpp". Try LOAD again to start Dive's own server on that port instead.`,
      };
    }
    // A foreign process already listening on the port would make llama-server
    // exit with a bind error — and worse, /health polls would answer from the
    // wrong server. If it's a router-mode llama-server, forward the load to it
    // (it applies its own eviction policy); otherwise fail with a clear message.
    if (await checkHealth(port)) {
      const forwarded = await routerLoad(port, file, modelPath);
      if (forwarded) return forwarded;
      return {
        error: `Port ${port} is already in use by another llama-server (not managed by this Dive instance). Stop it, or change SERVER PORT in the MODELS tab.`,
      };
    }
    const args = [
      "-m",
      modelPath,
      "-c",
      String(modelCfg.ctx),
      "-ngl",
      String(modelCfg.gpuLayers),
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
    ];
    if (modelCfg.threads > 0) args.push("-t", String(modelCfg.threads));
    if (modelCfg.batchSize > 0) args.push("-b", String(modelCfg.batchSize));
    if (modelCfg.mlock) args.push("--mlock");
    // Quantized KV cache (anything other than f16) requires Flash Attention in
    // llama.cpp, so turn it on automatically when the user picks a quantized
    // cache type even if they didn't tick the box.
    const kvQuantized =
      (modelCfg.cacheTypeK && modelCfg.cacheTypeK !== "f16") ||
      (modelCfg.cacheTypeV && modelCfg.cacheTypeV !== "f16");
    if (modelCfg.flashAttn || kvQuantized) args.push("-fa", "on");
    if (modelCfg.cacheTypeK && modelCfg.cacheTypeK !== "f16") {
      args.push("-ctk", modelCfg.cacheTypeK);
    }
    if (modelCfg.cacheTypeV && modelCfg.cacheTypeV !== "f16") {
      args.push("-ctv", modelCfg.cacheTypeV);
    }
    if (slotId === "embedding") {
      args.push("--embedding");
    } else {
      // Jinja chat templates: required for native tool calling, harmless
      // otherwise.
      args.push("--jinja");
      // Vision models need their multimodal projector passed explicitly, or
      // llama-server rejects images ("image input is not supported"). Attach a
      // matching mmproj from the models folder when one is found.
      const projector = findProjector(cfg, file);
      if (projector) args.push("--mmproj", projector);
    }
    if (cfg.extraArgs) args.push(...cfg.extraArgs.split(/\s+/).filter(Boolean));

    slot.log = [];
    slot.lastError = "";
    slot.state = "starting";
    slot.model = file;
    slot.port = port;
    slot.startedAt = Date.now();
    let child;
    try {
      child = spawn(binary, args, {
        env: {
          ...process.env,
          PATH: buildExecutablePath(process.env.PATH || ""),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      slot.state = "error";
      slot.lastError = `Failed to launch llama-server: ${e.message}`;
      return { error: slot.lastError };
    }
    slot.child = child;
    child.stdout.on("data", (c) => pushLog(slot, c));
    child.stderr.on("data", (c) => pushLog(slot, c));
    child.on("exit", (code) => {
      if (slot.child !== child) return; // an intentional stop/restart
      slot.child = null;
      const tail = slot.log.slice(-6).join("\n");
      slot.lastError =
        `llama-server exited with code ${code}.` + (tail ? `\n${tail}` : "");
      slot.state = "error";
      slot.model = "";
      console.warn(`[llamacpp:${slotId}] ${slot.lastError}`);
    });

    // Wait until /health reports ok (the model is loaded) or time out.
    const deadline = Date.now() + LOAD_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (slot.child !== child || slot.state === "error") {
        return { error: slot.lastError || "llama-server exited during load." };
      }
      if (await checkHealth(port)) {
        slot.state = "running";
        // Remember the model per slot so "load last model on startup" can
        // restore both the chat and the embedding server.
        const freshCfg = loadConfig();
        const lastKey = slotId === "chat" ? "lastModel" : "lastEmbeddingModel";
        if (freshCfg[lastKey] !== file) {
          freshCfg[lastKey] = file;
          saveConfig(freshCfg);
        }
        if (slotId === "chat") pointChatModeAtManagedServer(port);
        console.log(
          `[llamacpp:${slotId}] serving ${file} on port ${port} (ctx ${modelCfg.ctx}, gpu layers ${modelCfg.gpuLayers})`,
        );
        return { ok: true, slot: slotId, port };
      }
      await new Promise((r) => setTimeout(r, 700));
    }
    stopSlot(slotId);
    slot.state = "error";
    slot.lastError = `Model did not finish loading within ${LOAD_TIMEOUT_MS / 1000}s.`;
    return { error: slot.lastError };
  }

  // Autostart: when enabled, reload the last chat model shortly after Dive
  // boots — with Dive registered as a login item / LaunchAgent this brings
  // llama.cpp up automatically on laptop startup.
  setTimeout(async () => {
    const cfg = loadConfig();
    if (!cfg.autostart) return;
    // Arm the port guard before loading anything. It is populated by discovery,
    // and the first status poll only happens once a client asks — which may be
    // after this runs, or never if nothing opens the UI. Without this, autostart
    // is precisely the thing most likely to take a restarting router's port.
    await discoverRouterTargets(cfg).catch(() => []);
    // Chat first (it's what the user is waiting on), then the embedding
    // server so library semantic search comes back without manual loads.
    for (const file of [cfg.lastModel, cfg.lastEmbeddingModel]) {
      if (!file) continue;
      console.log(`[llamacpp] autostart: loading ${file}…`);
      const r = await startServer(file).catch((e) => ({ error: e.message }));
      if (r.error) console.warn(`[llamacpp] autostart failed: ${r.error}`);
    }
  }, 1500);

  // Kill the managed servers when Dive itself exits.
  process.on("exit", () => {
    for (const slotId of SLOT_IDS) {
      const child = slots[slotId].child;
      if (child && !child.killed) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
  });

  // ---- Hugging Face: search, file listing, download ----

  const HF_API = "https://huggingface.co";

  async function hfJson(url) {
    const res = await fetch(url, {
      headers: { "User-Agent": "Dive-LlamaCpp-Manager/1.0" },
    });
    if (!res.ok) throw new Error(`Hugging Face API error (${res.status}).`);
    return await res.json();
  }

  const download = {
    active: false,
    repo: "",
    file: "", // file currently transferring (display name)
    files: [], // full queue (repo-relative paths, split models have several)
    fileIndex: 0,
    received: 0,
    total: 0,
    error: "",
    done: false,
    request: null,
    stream: null,
    tempPath: "",
  };

  function downloadStatus() {
    return download.active || download.done || download.error
      ? {
          active: download.active,
          repo: download.repo,
          file: download.file,
          fileIndex: download.fileIndex,
          filesCount: download.files.length,
          received: download.received,
          total: download.total,
          error: download.error,
          done: download.done,
        }
      : null;
  }

  function cancelDownload() {
    if (!download.active) return;
    download.active = false;
    download.error = "Cancelled.";
    try {
      download.request?.destroy();
    } catch {
      /* already closed */
    }
    try {
      download.stream?.close();
    } catch {
      /* already closed */
    }
    if (download.tempPath) fs.rmSync(download.tempPath, { force: true });
  }

  function fetchToFile(url, destStream, redirectsLeft = 5) {
    return new Promise((resolve, reject) => {
      const req = https.get(
        url,
        { headers: { "User-Agent": "Dive-LlamaCpp-Manager/1.0" } },
        (res) => {
          if (
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            res.resume();
            if (redirectsLeft <= 0)
              return reject(new Error("Too many redirects."));
            const next = new URL(res.headers.location, url).toString();
            return fetchToFile(next, destStream, redirectsLeft - 1)
              .then(resolve)
              .catch(reject);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`Download failed (${res.statusCode}).`));
          }
          // Without a client-side size hint, grow the aggregate total one
          // part at a time as each content-length arrives.
          const total = Number(res.headers["content-length"]) || 0;
          if (total && !download.totalIsHint) download.total += total;
          res.on("data", (chunk) => {
            download.received += chunk.length;
          });
          res.pipe(destStream);
          destStream.on("finish", resolve);
          res.on("error", reject);
          destStream.on("error", reject);
        },
      );
      download.request = req;
      req.on("error", reject);
    });
  }

  // Download one or more GGUF files (split models arrive as a list of parts,
  // fetched sequentially). Progress is polled through the status endpoint.
  async function startDownload(repo, files, totalBytesHint) {
    if (download.active) {
      return { error: "Another download is already in progress." };
    }
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      return { error: "Invalid repository id." };
    }
    const list = (Array.isArray(files) ? files : [files])
      .map((f) => String(f || ""))
      .filter(Boolean);
    if (!list.length || list.length > 64) {
      return { error: "No files requested." };
    }
    for (const f of list) {
      if (!path.basename(f).endsWith(".gguf")) {
        return { error: "Only .gguf files can be downloaded." };
      }
    }
    const cfg = loadConfig();
    fs.mkdirSync(cfg.modelsDir, { recursive: true });
    // Skip parts that are already on disk (lets a cancelled split download
    // resume with the remaining parts).
    const pending = list.filter(
      (f) => !fs.existsSync(path.join(cfg.modelsDir, path.basename(f))),
    );
    if (!pending.length) {
      return {
        error: `${path.basename(list[0])} already exists in the models folder.`,
      };
    }
    const totalHint = Number(totalBytesHint) || 0;
    Object.assign(download, {
      active: true,
      repo,
      file: path.basename(pending[0]),
      files: pending,
      fileIndex: 0,
      received: 0,
      total: totalHint,
      totalIsHint: totalHint > 0,
      error: "",
      done: false,
      tempPath: "",
    });
    const run = async () => {
      for (let i = 0; i < pending.length; i++) {
        if (!download.active) return; // cancelled
        const relPath = pending[i];
        const safeName = path.basename(relPath);
        const destPath = path.join(cfg.modelsDir, safeName);
        download.fileIndex = i;
        download.file = safeName;
        download.tempPath = destPath + ".part";
        // Encode each URL segment (filenames may live in subfolders and can
        // contain characters encodeURI leaves alone).
        const url = `${HF_API}/${repo}/resolve/main/${relPath
          .split("/")
          .map(encodeURIComponent)
          .join("/")}`;
        const out = fs.createWriteStream(download.tempPath);
        download.stream = out;
        await fetchToFile(url, out);
        if (!download.active) return; // cancelled mid-part
        fs.renameSync(download.tempPath, destPath);
        console.log(`[llamacpp] downloaded ${repo}/${safeName}`);
      }
      download.active = false;
      download.done = true;
      // A newly downloaded model is useless to a router until its preset knows
      // about it, so regenerate now rather than waiting for the next restart.
      syncRouterPresetsSoon();
    };
    run().catch((e) => {
      const wasCancelled = !download.active && download.error === "Cancelled.";
      download.active = false;
      if (!wasCancelled) download.error = e.message || "Download failed.";
      if (download.tempPath) fs.rmSync(download.tempPath, { force: true });
    });
    return { ok: true };
  }

  // ---- Routes ----

  function slotStatus(slotId) {
    const slot = slots[slotId];
    return {
      state: slot.state,
      model: slot.model,
      port: slot.port,
      uptimeMs: slot.state === "running" ? Date.now() - slot.startedAt : 0,
      lastError: slot.lastError,
      logTail:
        slot.state === "error" || slot.state === "starting"
          ? slot.log.slice(-12)
          : [],
    };
  }

  // Detect a llama-server Dive did NOT launch (e.g. a router-mode LaunchAgent)
  // on a slot's port, so the UI can reflect what is actually serving instead
  // of claiming "stopped". Router mode reports per-model load state via
  // /v1/models; a classic single-model server is reported as one loaded model.
  async function probeExternalServer(port) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/models`, {
        signal: AbortSignal.timeout(900),
      });
      if (!res.ok) return null;
      const data = await res.json().catch(() => null);
      const list = Array.isArray(data?.data) ? data.data : [];
      if (!list.length) return null;
      return {
        port,
        // Router mode reports per-model status objects; a classic
        // single-model server doesn't (and can't load/unload on request).
        router: list.some((m) => m?.status && typeof m.status === "object"),
        models: list.map((m) => ({
          id: String(m?.id || m?.name || m?.model || "")
            .split("/")
            .pop(),
          // The .gguf behind this entry, which is what identifies it reliably.
          modelPath: routers.routerModelPath(m),
          state:
            m?.status && typeof m.status === "object"
              ? String(m.status.value || "unknown")
              : "loaded",
        })),
      };
    } catch {
      return null;
    }
  }

  // Tag every model a router advertises with what it actually is, matched
  // against the models folder by the file each entry points at, falling back to
  // the filename stem when a router reports no path.
  //
  //   chat      a normal conversational model
  //   embedding marked EMBED / detected as an embedder — cannot be chatted with
  //   projector an mmproj/clip adapter — part of a model, not a model
  //   unknown   advertised but absent from the folder (a preset pointing
  //             elsewhere, or a stale entry whose file was deleted). Left for
  //             the UI to show rather than hide: a router really is offering
  //             it, and silently dropping it would mask a broken preset.
  function classifyExternalModels(external, scanned, modelsDir) {
    if (!external || !Array.isArray(external.models)) return external;
    const list = scanned || [];
    const byAlias = new Map(
      list.map((m) => [m.file.replace(/\.gguf$/i, ""), m]),
    );
    const byPath = new Map(
      list.map((m) => [path.resolve(modelsDir, m.file), m]),
    );
    return {
      ...external,
      models: external.models.map((m) => {
        const match =
          (m.modelPath && byPath.get(path.resolve(m.modelPath))) ||
          byAlias.get(m.id);
        const kind = !match
          ? "unknown"
          : match.arch === "clip"
            ? "projector"
            : match.embedding
              ? "embedding"
              : "chat";
        return { ...m, kind };
      }),
    };
  }

  // Ask an external router-mode llama-server to load a model. Returns null if
  // the port isn't a router (caller falls back to its port-in-use error).
  async function routerLoad(port, file, modelPath) {
    const ext = await probeExternalServer(port);
    if (!ext || !ext.router) return null;
    const alias = routers.routerAliasFor(ext, modelPath, file);
    if (!alias) {
      return {
        error: `"${file}" is not registered in the external llama-server on port ${port}. Add it to the router preset file and restart the service.`,
      };
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/models/load`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: alias }),
        signal: AbortSignal.timeout(LOAD_TIMEOUT_MS),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok || /already running/i.test(data?.error?.message || "")) {
        return { ok: true, external: true, port };
      }
      return {
        error: data?.error?.message || `Router load failed (${res.status}).`,
      };
    } catch (e) {
      return { error: `Router load failed: ${e.message}` };
    }
  }

  // Unloading is best-effort — a router that has gone away has nothing to
  // unload — but a WRONG name is not the same thing as no router, and used to
  // be swallowed just the same: the model stayed resident while the caller was
  // told the stop had worked. The outcome is returned so that cannot recur.
  async function routerUnload(port, file, modelPath) {
    const ext = await probeExternalServer(port);
    if (!ext || !ext.router) return { ok: false, reason: "no router" };
    const alias = routers.routerAliasFor(ext, modelPath, file);
    if (!alias) {
      return {
        ok: false,
        reason: `"${file}" is not registered on port ${port}`,
      };
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/models/unload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: alias }),
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) return { ok: true, alias };
      const data = await res.json().catch(() => ({}));
      return {
        ok: false,
        reason: data?.error?.message || `router unload failed (${res.status})`,
      };
    } catch (e) {
      return { ok: false, reason: e.message || String(e) };
    }
  }

  async function handleRequest(ctx) {
    const { req, urlPath, requestUrl, send } = ctx;
    if (!urlPath.startsWith("/api/llamacpp/manager/")) return false;
    const route = urlPath.slice("/api/llamacpp/manager/".length);

    if (req.method === "GET" && route === "status") {
      const cfg = loadConfig();
      const binary = findBinary(cfg);
      // Only probe ports Dive's own slots aren't using.
      const [chatExternal, embeddingExternal] = await Promise.all([
        slots.chat.state === "stopped" || slots.chat.state === "error"
          ? probeExternalServer(slotPort(cfg, "chat"))
          : null,
        slots.embedding.state === "stopped" || slots.embedding.state === "error"
          ? probeExternalServer(slotPort(cfg, "embedding"))
          : null,
      ]);
      // A router started with --models-dir advertises every .gguf it can see,
      // projectors and embedding models included. Classify each entry against
      // the folder scan here, so the UI never has to re-derive it and a chat
      // server is never shown offering something it cannot chat with.
      const scanned = scanModels(cfg);
      send(200, {
        chat: slotStatus("chat"),
        embedding: slotStatus("embedding"),
        chatExternal: classifyExternalModels(
          chatExternal,
          scanned,
          cfg.modelsDir,
        ),
        embeddingExternal: classifyExternalModels(
          embeddingExternal,
          scanned,
          cfg.modelsDir,
        ),
        port: cfg.port,
        embeddingPort: cfg.port + 1,
        evictOnLoad: cfg.evictOnLoad,
        autostart: cfg.autostart,
        lastModel: cfg.lastModel,
        binary,
        binaryFound: Boolean(binary),
        binaryPath: cfg.binaryPath,
        modelsDir: cfg.modelsDir,
        extraArgs: cfg.extraArgs,
        cacheTypes: CACHE_TYPES,
        models: scanned,
        download: downloadStatus(),
        // What preset sync found for itself. There is nothing here for the
        // user to fill in — the panel reports the routers it detected, or says
        // there are none and that Dive is managing its own servers instead.
        presetSync: {
          ...cfg.presetSync,
          routers: (await discoverRouterTargets(cfg).catch(() => [])).map(
            (t) => ({
              kind: t.kind,
              filePath: t.filePath,
              modelsDir: t.modelsDir,
              pid: t.router ? t.router.pid : 0,
              discovered: Boolean(t.router),
            }),
          ),
        },
      });
      return true;
    }

    // Regenerate the preset files on demand. `dryRun` returns the before/after
    // text without writing anything or touching a router, which is how the
    // settings panel previews a change before it is ever applied.
    if (req.method === "POST" && route === "preset/sync") {
      try {
        const body = await parseJsonBody(req).catch(() => ({}));
        const result = await syncRouterPresets({
          dryRun: body?.dryRun === true,
          restart: body?.restart !== false,
        });
        send(200, result);
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return true;
    }

    if (req.method === "POST" && route === "config") {
      try {
        const body = await parseJsonBody(req);
        const cfg = loadConfig();
        if (typeof body?.modelsDir === "string") cfg.modelsDir = body.modelsDir;
        if (typeof body?.binaryPath === "string")
          cfg.binaryPath = body.binaryPath;
        if (body?.port !== undefined) cfg.port = Number(body.port);
        if (typeof body?.extraArgs === "string") cfg.extraArgs = body.extraArgs;
        if (typeof body?.evictOnLoad === "boolean")
          cfg.evictOnLoad = body.evictOnLoad;
        if (typeof body?.autostart === "boolean")
          cfg.autostart = body.autostart;
        if (body?.presetSync && typeof body.presetSync === "object") {
          cfg.presetSync = { ...cfg.presetSync, ...body.presetSync };
        }
        const savedCfg = saveConfig(cfg);
        // The folder may have moved; point the watcher at the new one or live
        // refresh keeps reporting on the old location.
        ensureModelsWatcher();
        send(200, { ok: true, config: savedCfg });
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return true;
    }

    if (req.method === "POST" && route === "models/settings") {
      try {
        const body = await parseJsonBody(req);
        const cfg = loadConfig();
        const file = path.basename(String(body?.file || ""));
        if (!file.endsWith(".gguf")) {
          send(400, { error: "file must be a .gguf name" });
          return true;
        }
        const current = modelSettingsFor(cfg, file);
        // Merge only the provided fields over the current settings, then
        // sanitize the whole entry (clamps ranges, validates cache types).
        const merged = { ...current };
        for (const key of [
          "ctx",
          "gpuLayers",
          "threads",
          "batchSize",
          "flashAttn",
          "mlock",
          "cacheTypeK",
          "cacheTypeV",
          "embedding",
        ]) {
          if (body?.[key] !== undefined) merged[key] = body[key];
        }
        cfg.models[file] = sanitizeModelEntry(merged, file);
        const saved = saveConfig(cfg);
        // Toggling EMBED moves a model between the two presets, and ctx / GPU
        // layers are written into its section, so both need regenerating.
        syncRouterPresetsSoon();
        send(200, { ok: true, settings: saved.models[file] });
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return true;
    }

    if (req.method === "POST" && route === "models/delete") {
      try {
        const body = await parseJsonBody(req);
        const cfg = loadConfig();
        const file = path.basename(String(body?.file || ""));
        const target = modelFilePath(cfg, file);
        if (!target || !fs.existsSync(target)) {
          send(404, { error: "Model file not found." });
          return true;
        }
        for (const slotId of SLOT_IDS) {
          if (slots[slotId].model === file) stopSlot(slotId);
        }
        // Rewrite the presets BEFORE the file goes, so no router is ever
        // pointed at a path that has just stopped existing — but hold the
        // restart back. A router started with --models-dir rescans the folder
        // when it comes up, so restarting while the .gguf is still on disk
        // would simply re-discover the model that is being deleted.
        const presetResult = await syncRouterPresets({
          exclude: [file],
          restart: false,
        }).catch((e) => {
          console.warn("[llamacpp] preset sync failed:", e.message || e);
          return null;
        });
        fs.rmSync(target, { force: true });
        // Split model: removing the listed first part removes its siblings
        // too, otherwise gigabytes of unloadable parts linger on disk.
        const pm = file.match(GGUF_PART_RE);
        if (pm) {
          const total = Number(pm[2]);
          for (let i = 2; i <= total; i++) {
            const part = `${file.slice(0, pm.index)}-${String(i).padStart(5, "0")}-of-${pm[2]}.gguf`;
            fs.rmSync(path.join(cfg.modelsDir, part), { force: true });
          }
        }
        delete cfg.models[file];
        saveConfig(cfg);
        // Every part of the model is off disk now; a restarting router can no
        // longer rediscover it, so the preset change can take effect.
        if (presetResult?.changed?.length) {
          await restartChangedRouters(presetResult.changed).catch((e) =>
            console.warn("[llamacpp] router restart failed:", e.message || e),
          );
        }
        send(200, { ok: true });
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return true;
    }

    if (req.method === "POST" && route === "start") {
      try {
        const body = await parseJsonBody(req);
        const result = await startServer(String(body?.model || ""));
        send(result.ok ? 200 : 500, result);
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return true;
    }

    if (req.method === "POST" && route === "stop") {
      try {
        const body = await parseJsonBody(req).catch(() => ({}));
        const slotId = body?.slot === "embedding" ? "embedding" : "chat";
        const slot = slots[slotId];
        // Slot idle but a model name was given: the model runs on an external
        // router — ask the router to unload it (frees its RAM).
        if (
          slot.state !== "running" &&
          slot.state !== "starting" &&
          body?.model
        ) {
          const cfg = loadConfig();
          const file = path.basename(String(body.model));
          const result = await routerUnload(
            slotPort(cfg, slotId),
            file,
            modelFilePath(cfg, file) || "",
          );
          // Saying "stopped" while the model is still resident is how this went
          // unnoticed before; a refused unload is now reported as one.
          if (!result.ok && result.reason !== "no router") {
            send(500, {
              error: `Could not unload "${file}": ${result.reason}`,
            });
            return true;
          }
        } else {
          stopSlot(slotId);
        }
        slots[slotId].lastError = "";
        send(200, { ok: true });
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return true;
    }

    if (req.method === "GET" && route === "hf/search") {
      try {
        const q = requestUrl?.searchParams?.get("q") || "";
        if (!q.trim()) {
          send(400, { error: "q parameter required" });
          return true;
        }
        const data = await hfJson(
          `${HF_API}/api/models?search=${encodeURIComponent(q)}&filter=gguf&sort=downloads&limit=12`,
        );
        send(200, {
          results: (Array.isArray(data) ? data : []).map((m) => ({
            id: m.id,
            downloads: m.downloads || 0,
            likes: m.likes || 0,
          })),
        });
      } catch (e) {
        send(502, { error: e.message });
      }
      return true;
    }

    if (req.method === "GET" && route === "hf/files") {
      try {
        const repo = requestUrl?.searchParams?.get("repo") || "";
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
          send(400, { error: "valid repo parameter required" });
          return true;
        }
        const data = await hfJson(`${HF_API}/api/models/${repo}?blobs=true`);
        const files = (data?.siblings || [])
          .filter((s) => String(s?.rfilename || "").endsWith(".gguf"))
          .map((s) => ({
            file: s.rfilename,
            sizeBytes: Number(s.size) || 0,
            quant: quantFromFilename(path.basename(String(s.rfilename))),
          }));
        // Repo-level GGUF metadata (Hugging Face parses the headers server
        // side): architecture, parameter count, trained context length.
        const g =
          data?.gguf && typeof data.gguf === "object" ? data.gguf : null;
        send(200, {
          files,
          gguf: g
            ? {
                architecture: String(g.architecture || ""),
                contextLength: Number(g.context_length) || 0,
                totalParams: Number(g.total) || 0,
              }
            : null,
        });
      } catch (e) {
        send(502, { error: e.message });
      }
      return true;
    }

    if (req.method === "POST" && route === "hf/download") {
      try {
        const body = await parseJsonBody(req);
        const result = await startDownload(
          String(body?.repo || ""),
          Array.isArray(body?.files) ? body.files : String(body?.file || ""),
          body?.totalBytes,
        );
        send(result.ok ? 200 : 400, result);
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return true;
    }

    if (req.method === "POST" && route === "hf/download/cancel") {
      cancelDownload();
      send(200, { ok: true });
      return true;
    }

    return false;
  }

  return { handleRequest };
};
