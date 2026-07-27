// Library domain: the index job lifecycle (start/pause/resume/persist) and
// every /api/library/* route. Instantiated once by server.js with the shared
// helpers it needs; everything else lives here or in library/store.
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const {
  checkEmbeddingPreflight,
  collectSourceFiles,
  estimateLibraryIndex,
  getLibraryStatus,
  indexLibrary,
  listIndexedLibraryFiles,
  loadLibraryConfig,
  saveLibraryConfig,
  saveLibraryChatSettings,
  searchLibrary,
  searchLibraryFiles,
} = require("../library/store");

module.exports = function createLibraryDomain(deps) {
  const {
    DATA_DIR,
    parseJsonBody,
    appendFileWithRotation,
    openPathInFileManager,
  } = deps;

  const LIBRARY_INDEX_JOB_FILE = path.join(DATA_DIR, "library-index-job.json");
  const LIBRARY_INDEX_ERROR_FILE = path.join(
    DATA_DIR,
    "library-index-errors.jsonl",
  );
  const LIBRARY_INDEXED_FILES_EXPORT_FILE = path.join(
    DATA_DIR,
    "indexed-epub-files.txt",
  );

  let activeLibraryIndexJob = null;
  let lastLibraryIndexJob = null;

  function formatIndexedLibraryFilesExport(files, config) {
    const lines = [
      "Dive Indexed EPUB Files",
      `Generated: ${new Date().toISOString()}`,
      `Database: ${config.databasePath}`,
      `Total indexed EPUB files: ${files.length}`,
      "",
    ];
    files.forEach((file, index) => {
      const title = file.title || path.basename(file.path || "") || "Untitled";
      const author = file.author ? ` - ${file.author}` : "";
      lines.push(`${index + 1}. ${title}${author}`);
      lines.push(`   Path: ${file.path || ""}`);
      lines.push(
        `   Source: ${file.sourceName || file.sourceType || "unknown"}`,
      );
      lines.push(`   Passages: ${file.chunkCount || 0}`);
      lines.push(`   Indexed: ${file.indexedAt || "unknown"}`);
      lines.push("");
    });
    return `${lines.join("\n").trimEnd()}\n`;
  }

  function publicLibraryIndexJob(job) {
    if (!job) return null;
    return {
      id: job.id,
      status: job.status,
      force: job.force,
      prune: job.prune,
      compact: job.compact,
      retryEmbeddings: job.retryEmbeddings === true,
      cancelRequested: job.cancelRequested === true,
      pauseRequested: job.pauseRequested === true,
      autoResumed: job.autoResumed === true,
      startedAt: job.startedAt,
      resumedAt: job.resumedAt || null,
      finishedAt: job.finishedAt || null,
      progress: job.progress || null,
      stats: job.stats || null,
      recentErrors: Array.isArray(job.recentErrors)
        ? job.recentErrors.slice(-10)
        : [],
      error: job.error || null,
    };
  }

  function readLibraryIndexJobFile() {
    try {
      if (!fs.existsSync(LIBRARY_INDEX_JOB_FILE)) return null;
      const parsed = JSON.parse(
        fs.readFileSync(LIBRARY_INDEX_JOB_FILE, "utf8"),
      );
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (error) {
      console.error("Could not read library index job state:", error.message);
      return null;
    }
  }

  function persistLibraryIndexJob(job) {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = `${LIBRARY_INDEX_JOB_FILE}.tmp`;
      fs.writeFileSync(
        tmp,
        JSON.stringify(publicLibraryIndexJob(job), null, 2),
        "utf8",
      );
      fs.renameSync(tmp, LIBRARY_INDEX_JOB_FILE);
    } catch (error) {
      console.error(
        "Could not persist library index job state:",
        error.message,
      );
    }
  }

  function persistedJobStartFileIndex(job) {
    const progress = job?.progress || {};
    const embeddingErrors = Number(progress.embeddingErrors || 0);
    const fileErrors = Number(progress.errors || 0);
    if (embeddingErrors > 0 || fileErrors > 0) return 0;
    const processed = Number(job?.progress?.processed || 0);
    return Number.isFinite(processed) && processed > 0
      ? Math.floor(processed)
      : 0;
  }

  function appendLibraryIndexError(job, entry) {
    const record = {
      timestamp: new Date().toISOString(),
      jobId: job.id,
      ...entry,
    };
    job.recentErrors = [...(job.recentErrors || []), record].slice(-10);
    appendFileWithRotation(
      LIBRARY_INDEX_ERROR_FILE,
      `${JSON.stringify(record)}\n`,
    );
  }

  function readRecentLibraryIndexErrors(limit = 50) {
    try {
      if (!fs.existsSync(LIBRARY_INDEX_ERROR_FILE)) return [];
      const max = Math.min(200, Math.max(1, Number(limit) || 50));
      return fs
        .readFileSync(LIBRARY_INDEX_ERROR_FILE, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .slice(-max)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch (_error) {
            return { timestamp: "", kind: "parse_error", error: line };
          }
        });
    } catch (error) {
      console.error("Could not read library index error log:", error.message);
      return [];
    }
  }

  function startLibraryIndexJob(options = {}) {
    if (activeLibraryIndexJob) {
      const error = new Error("A library index job is already running.");
      error.statusCode = 409;
      throw error;
    }
    const resumeProgress =
      options.resumeProgress && typeof options.resumeProgress === "object"
        ? options.resumeProgress
        : null;
    const startFileIndex = Math.max(
      0,
      Number.isFinite(Number(options.startFileIndex))
        ? Math.floor(Number(options.startFileIndex))
        : 0,
    );
    const job = {
      id: options.id || randomUUID(),
      status: "running",
      force: options.force === true,
      prune: options.prune !== false,
      compact: options.compact !== false,
      retryEmbeddings: options.retryEmbeddings === true,
      cancelRequested: false,
      pauseRequested: false,
      autoResumed: options.autoResume === true,
      startedAt: options.startedAt || new Date().toISOString(),
      resumedAt: options.autoResume === true ? new Date().toISOString() : null,
      finishedAt: null,
      progress: resumeProgress,
      stats: null,
      recentErrors: [],
      error: null,
    };
    activeLibraryIndexJob = job;
    lastLibraryIndexJob = job;
    persistLibraryIndexJob(job);
    indexLibrary({
      force: job.force,
      prune: job.prune,
      compact: job.compact,
      retryEmbeddings: job.retryEmbeddings,
      startFileIndex,
      resumeFromPath: options.resumeFromPath || "",
      resumeProgress:
        startFileIndex > 0 || options.resumeFromPath ? resumeProgress : null,
      onProgress: (progress) => {
        job.progress = progress;
        // Progress fires per file AND per embedding batch — persisting each
        // one hammers the disk for hours on a big run. Crash-resume only
        // needs a recent snapshot, so throttle to one write every 2 seconds.
        const now = Date.now();
        if (!job._lastPersistMs || now - job._lastPersistMs >= 2000) {
          job._lastPersistMs = now;
          persistLibraryIndexJob(job);
        }
      },
      onError: (entry) => {
        appendLibraryIndexError(job, entry);
        job.progress = {
          ...(job.progress || {}),
          recentErrors: job.recentErrors.slice(-5),
          lastEmbeddingError: entry.error || entry.reason || "",
        };
        persistLibraryIndexJob(job);
      },
      shouldCancel: () => job.cancelRequested === true,
    })
      .then((stats) => {
        job.status = "completed";
        job.stats = stats;
        job.progress = {
          ...(job.progress || {}),
          phase: "completed",
          percent: 100,
        };
        persistLibraryIndexJob(job);
      })
      .catch((error) => {
        if (error?.cancelled) {
          job.status = job.pauseRequested ? "paused" : "cancelled";
          job.error = null;
          job.progress = {
            ...(job.progress || {}),
            phase: job.pauseRequested ? "paused" : "cancelled",
          };
        } else {
          job.status = "failed";
          job.error = error.stack || error.message || String(error);
        }
        persistLibraryIndexJob(job);
      })
      .finally(() => {
        job.finishedAt = new Date().toISOString();
        activeLibraryIndexJob = null;
        persistLibraryIndexJob(job);
      });
    return job;
  }

  function pauseLibraryIndexJob() {
    if (!activeLibraryIndexJob) return null;
    activeLibraryIndexJob.pauseRequested = true;
    activeLibraryIndexJob.cancelRequested = true;
    activeLibraryIndexJob.progress = {
      ...(activeLibraryIndexJob.progress || {}),
      phase: "pausing",
    };
    persistLibraryIndexJob(activeLibraryIndexJob);
    return activeLibraryIndexJob;
  }

  function resumePersistedLibraryIndexJob() {
    const persisted = readLibraryIndexJobFile();
    if (!persisted) return;
    lastLibraryIndexJob = persisted;
    if (
      persisted.status !== "running" ||
      persisted.cancelRequested === true ||
      persisted.pauseRequested === true
    ) {
      return;
    }
    const startFileIndex = persistedJobStartFileIndex(persisted);
    // Resume by the last in-flight file PATH (robust to list changes while
    // the app was down); the numeric index is only a fallback for old job
    // files.
    const resumeFromPath =
      startFileIndex > 0 ? String(persisted.progress?.currentFile || "") : "";
    try {
      startLibraryIndexJob({
        id: persisted.id || randomUUID(),
        startedAt: persisted.startedAt || null,
        force: persisted.force === true,
        prune: persisted.prune !== false,
        compact: persisted.compact !== false,
        autoResume: true,
        resumeFromPath,
        resumeProgress:
          startFileIndex > 0 || resumeFromPath
            ? persisted.progress || null
            : null,
        startFileIndex,
      });
    } catch (error) {
      persisted.status = "failed";
      persisted.error = `Auto-resume failed: ${error.message}`;
      persisted.finishedAt = new Date().toISOString();
      lastLibraryIndexJob = persisted;
      persistLibraryIndexJob(persisted);
    }
  }

  async function handleRequest(ctx) {
    const { req, urlPath, requestUrl, send } = ctx;

    if (req.method === "GET" && urlPath === "/api/library/settings") {
      try {
        const config = loadLibraryConfig();
        send(200, { settings: config.chatIntegration });
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return true;
    }

    if (req.method === "POST" && urlPath === "/api/library/settings") {
      try {
        const body = await parseJsonBody(req);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          send(400, { error: "Settings object is required" });
          return true;
        }
        const nextSettings =
          body.settings && typeof body.settings === "object"
            ? body.settings
            : body;
        const config = saveLibraryChatSettings(nextSettings);
        send(200, { ok: true, settings: config.chatIntegration });
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return true;
    }

    if (req.method === "GET" && urlPath === "/api/library/config") {
      try {
        send(200, { config: loadLibraryConfig() });
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return true;
    }

    if (req.method === "POST" && urlPath === "/api/library/config") {
      try {
        const body = await parseJsonBody(req);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          send(400, { error: "Config object is required" });
          return true;
        }
        const nextConfig =
          body.config && typeof body.config === "object" ? body.config : body;
        const config = saveLibraryConfig(nextConfig);
        send(200, { ok: true, config });
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return true;
    }

    if (req.method === "GET" && urlPath === "/api/library/embedding-check") {
      try {
        const config = loadLibraryConfig();
        if (config.embedding?.enabled !== true) {
          send(200, { enabled: false, ready: false, error: "" });
          return true;
        }
        const result = await checkEmbeddingPreflight(config);
        send(200, {
          enabled: true,
          ready: result.ready === true,
          error: result.error || "",
          model: config.embedding.model || "",
          baseUrl: config.embedding.ollamaBaseUrl || "",
        });
      } catch (e) {
        send(500, { error: e.message });
      }
      return true;
    }

    // Everything the client needs to validate BEFORE starting an index run:
    // sources, files on disk, embedding pipeline, and current index size.
    if (req.method === "GET" && urlPath === "/api/library/preflight") {
      try {
        const config = loadLibraryConfig();
        const sources = Array.isArray(config.sources) ? config.sources : [];
        const configuredSources = sources.filter(
          (source) =>
            source && typeof source.path === "string" && source.path.trim(),
        );
        const missingPaths = configuredSources
          .filter((source) => !fs.existsSync(source.path))
          .map((source) => source.path);
        let fileCount = 0;
        if (configuredSources.length) {
          try {
            fileCount = collectSourceFiles(config).length;
          } catch (_e) {}
        }
        const embeddingEnabled = config.embedding?.enabled === true;
        const embeddingModel = String(config.embedding?.model || "");
        const embedding = {
          enabled: embeddingEnabled,
          configured: embeddingEnabled && !!embeddingModel,
          ready: false,
          error: "",
          model: embeddingModel,
          baseUrl: config.embedding?.ollamaBaseUrl || "",
          dimensions: 0,
        };
        if (embedding.configured) {
          const result = await checkEmbeddingPreflight(config);
          embedding.ready = result.ready === true;
          embedding.error = result.error || "";
          embedding.dimensions = Number(result.dimensions) || 0;
        }
        let indexedFiles = 0;
        try {
          const status = await getLibraryStatus();
          indexedFiles = Number(status.files || 0);
        } catch (_e) {}
        send(200, {
          sourcesConfigured: configuredSources.length,
          missingPaths,
          fileCount,
          indexedFiles,
          databasePath: config.databasePath || "",
          embedding,
        });
      } catch (e) {
        send(500, { error: e.message });
      }
      return true;
    }

    if (req.method === "GET" && urlPath === "/api/library/status") {
      try {
        send(200, await getLibraryStatus());
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return true;
    }

    if (req.method === "GET" && urlPath === "/api/library/estimate") {
      try {
        const sampleLimit = Number.parseInt(
          requestUrl.searchParams.get("sample") || "",
          10,
        );
        send(
          200,
          await estimateLibraryIndex({
            sampleLimit: Number.isFinite(sampleLimit) ? sampleLimit : undefined,
          }),
        );
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return true;
    }

    if (req.method === "GET" && urlPath === "/api/library/index") {
      let status = null;
      try {
        status = await getLibraryStatus();
      } catch (error) {
        status = { error: error.message };
      }
      // Sync lastLibraryIndexJob from disk to ensure accuracy
      if (!activeLibraryIndexJob) {
        lastLibraryIndexJob = readLibraryIndexJobFile();
      }
      send(200, {
        running: !!activeLibraryIndexJob,
        job: publicLibraryIndexJob(
          activeLibraryIndexJob || lastLibraryIndexJob,
        ),
        status,
      });
      return true;
    }

    if (req.method === "GET" && urlPath === "/api/library/index/errors") {
      const limit = Number.parseInt(
        requestUrl.searchParams.get("limit") || "",
        10,
      );
      send(200, {
        errors: readRecentLibraryIndexErrors(
          Number.isFinite(limit) ? limit : 50,
        ),
        path: LIBRARY_INDEX_ERROR_FILE,
      });
      return true;
    }

    if (
      req.method === "POST" &&
      urlPath === "/api/library/export-indexed-files"
    ) {
      try {
        const config = loadLibraryConfig();
        const files = await listIndexedLibraryFiles({ extension: ".epub" });
        const text = formatIndexedLibraryFilesExport(files, config);
        fs.writeFileSync(LIBRARY_INDEXED_FILES_EXPORT_FILE, text, "utf8");
        const stat = fs.statSync(LIBRARY_INDEXED_FILES_EXPORT_FILE);
        send(200, {
          ok: true,
          count: files.length,
          path: LIBRARY_INDEXED_FILES_EXPORT_FILE,
          directory: DATA_DIR,
          bytes: stat.size,
        });
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return true;
    }

    if (
      req.method === "POST" &&
      urlPath === "/api/library/export-indexed-files/open"
    ) {
      const targetPath = fs.existsSync(LIBRARY_INDEXED_FILES_EXPORT_FILE)
        ? LIBRARY_INDEXED_FILES_EXPORT_FILE
        : DATA_DIR;
      openPathInFileManager(targetPath, { revealFile: true }, (error) => {
        if (error) {
          send(500, {
            error: `Failed to open export folder: ${error.message}`,
          });
          return;
        }
        send(200, {
          ok: true,
          path: LIBRARY_INDEXED_FILES_EXPORT_FILE,
          directory: DATA_DIR,
        });
      });
      return true;
    }

    if (req.method === "POST" && urlPath === "/api/library/index") {
      try {
        const body = await parseJsonBody(req);
        const job = startLibraryIndexJob({
          force: body?.force === true,
          prune: body?.prune !== false,
          compact: body?.compact !== false,
          retryEmbeddings: body?.retryEmbeddings === true,
        });
        send(202, {
          ok: true,
          running: true,
          job: publicLibraryIndexJob(job),
          status: await getLibraryStatus().catch((error) => ({
            error: error.message,
          })),
        });
      } catch (e) {
        send(e.statusCode || 500, {
          error: e.message,
          running: !!activeLibraryIndexJob,
          job: publicLibraryIndexJob(
            activeLibraryIndexJob || lastLibraryIndexJob,
          ),
          status: await getLibraryStatus().catch((error) => ({
            error: error.message,
          })),
        });
      }
      return true;
    }

    if (req.method === "POST" && urlPath === "/api/library/index/cancel") {
      if (!activeLibraryIndexJob) {
        send(200, {
          ok: true,
          running: false,
          job: publicLibraryIndexJob(lastLibraryIndexJob),
          status: await getLibraryStatus().catch((error) => ({
            error: error.message,
          })),
        });
        return true;
      }
      const job = pauseLibraryIndexJob();
      send(202, {
        ok: true,
        running: true,
        job: publicLibraryIndexJob(job),
        status: await getLibraryStatus().catch((error) => ({
          error: error.message,
        })),
      });
      return true;
    }

    if (req.method === "POST" && urlPath === "/api/library/search") {
      try {
        const body = await parseJsonBody(req);
        const query = typeof body?.query === "string" ? body.query.trim() : "";
        if (!query) {
          send(400, { error: "Search query is required" });
          return true;
        }
        const results = await searchLibrary(query, {
          limit: body.limit,
          mode: body.mode,
        });
        send(200, { query, results });
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return true;
    }

    if (req.method === "POST" && urlPath === "/api/library/files/search") {
      try {
        const body = await parseJsonBody(req);
        const query = typeof body?.query === "string" ? body.query.trim() : "";
        if (!query) {
          send(400, { error: "Search query is required" });
          return true;
        }
        const files = await searchLibraryFiles(query, { limit: 12 });
        send(200, { query, files });
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return true;
    }

    return false;
  }

  return {
    handleRequest,
    resumePersistedLibraryIndexJob,
    // Read by the llama.cpp preset sync, which must not restart the embedding
    // router while an index run is streaming through it.
    isIndexJobRunning: () => !!activeLibraryIndexJob,
  };
};
