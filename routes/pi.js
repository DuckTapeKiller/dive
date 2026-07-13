// Pi domain: the entire Pi RPC integration — process lifecycle per
// conversation, session event fan-out, the persistent SSE event channel,
// environment banner, RPC commands, and every /api/pi/* route. Shared
// storage/library/security helpers are injected from server.js; the api
// object exposes the pieces the legacy /api/chat/stream pi branch still
// consumes there.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { randomBytes, randomUUID } = require("crypto");
const { buildChatLibraryContext } = require("../library/store");
const {
  isSkillSlashCommand,
  parseSlashCommand,
} = require("../slash_commands.js");

const PI_COMMAND_CANDIDATES =
  process.platform === "win32"
    ? ["pi.cmd", "pi.exe", "pi"]
    : ["/opt/homebrew/bin/pi", "/usr/local/bin/pi", "pi"];

module.exports = function createPiDomain(deps) {
  const {
    DATA_DIR,
    PORT,
    PI_DEFAULT_SERVER_PORT,
    PI_SESSION_TIMEOUT_MS,
    PI_SESSION_SWEEP_INTERVAL_MS,
    DB_ON_PROMPT,
    buildExecutablePath,
    parseJsonBody,
    appendSecurityEvent,
    createHttpError,
    openPathInFileManager,
    upsertConversation,
    persistAsyncWakeTurn,
    sanitizeTraceEventForStorage,
    normalizeAttachmentImages,
    extForImageMime,
    emitSlashCommand,
    getCommandMessage,
    getLibraryRequestForCommand,
    getLibraryContextSourceResults,
    serializeLibraryResults,
    loadPiSettings,
    savePiSettings,
    sanitizePiSettings,
    defaultPiSettings,
    buildPiPromptWithLibraryContext,
  } = deps;

  function isExecutableFile(filePath) {
    if (!filePath || typeof filePath !== "string") return false;
    try {
      fs.accessSync(filePath, fs.constants.X_OK);
      return true;
    } catch (_error) {
      return false;
    }
  }

  function getPiCommand() {
    for (const candidate of PI_COMMAND_CANDIDATES) {
      if (isExecutableFile(candidate)) {
        return candidate;
      }
    }

    try {
      const lookup =
        process.platform === "win32"
          ? spawnSync("where", ["pi"], {
              encoding: "utf8",
              env: {
                ...process.env,
                PATH: buildExecutablePath(process.env.PATH || ""),
              },
            })
          : spawnSync("/usr/bin/env", ["which", "pi"], {
              encoding: "utf8",
              env: {
                ...process.env,
                PATH: buildExecutablePath(process.env.PATH || ""),
              },
            });
      if (lookup.status === 0) {
        const found = (lookup.stdout || "").split(/\r?\n/)[0].trim();
        if (found) return found;
      }
    } catch (_error) {}
    return "pi"; // Fallback to PATH
  }

  function getPiRuntimeInfo(settings = loadPiSettings()) {
    const resolvedWorkingDirectory = settings.workingDirectory || DATA_DIR;
    const globalSandbox = path.join(os.homedir(), ".pi", "sandbox.json");
    const projectSandbox = path.join(
      resolvedWorkingDirectory,
      ".pi",
      "sandbox.json",
    );
    const configuredCommand =
      typeof settings.commandPath === "string" && settings.commandPath.trim()
        ? settings.commandPath.trim()
        : null;
    const autoDetectedCommand = getPiCommand();
    const resolvedCommand = configuredCommand || autoDetectedCommand;

    return {
      dataDir: DATA_DIR,
      projectDir: __dirname,
      configuredServerPort: settings.serverPort || PI_DEFAULT_SERVER_PORT,
      activeServerPort: PORT,
      configuredCommand,
      autoDetectedCommand,
      resolvedCommand,
      resolvedWorkingDirectory,
      sandbox: {
        globalPath: globalSandbox,
        globalEnabled: fs.existsSync(globalSandbox),
        projectPath: projectSandbox,
        projectEnabled: fs.existsSync(projectSandbox),
      },
    };
  }

  const PI_DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
  const piRpcSessions = new Map();

  function createPiSessionId() {
    return `pi_${randomUUID()}`;
  }

  function buildPiEnv() {
    const env = { ...process.env };
    env.PATH = buildExecutablePath(env.PATH || "");
    return env;
  }

  function notifyPiSession(session) {
    const waiters = session.waiters.splice(0);
    waiters.forEach((resolve) => resolve());
  }

  // ---- Persistent per-conversation Pi event channels (SSE) ----
  // The per-prompt NDJSON stream only lives as long as one prompt request.
  // Events that arrive between turns (async subagent wakes, widget updates,
  // orphaned-session captures) are pushed here instead, so the client never
  // has to poll conversations.json to find out what happened.
  const piEventChannels = new Map(); // convId -> Set<http.ServerResponse>

  function broadcastPiConvEvent(convId, event) {
    if (!convId || !event) return;
    const subscribers = piEventChannels.get(convId);
    if (!subscribers || subscribers.size === 0) return;
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of subscribers) {
      if (!res.writableEnded) {
        try {
          res.write(payload);
        } catch (_e) {}
      }
    }
  }

  function emitPiSessionEvent(session, event) {
    if (!session || !event) return;
    // Push to the conversation's persistent channel regardless of whether a
    // prompt stream is attached — the client dedupes by run state.
    broadcastPiConvEvent(session.convProc?.convId, event);
    if (!session.streamListeners) return;
    for (const listener of session.streamListeners) {
      try {
        listener(event);
      } catch (e) {}
    }
  }

  function clampText(value, maxLength = 1000) {
    const text = typeof value === "string" ? value : String(value ?? "");
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength)}…`;
  }

  function extractToolTextPayload(payload) {
    if (!payload || !Array.isArray(payload.content)) return "";
    const parts = payload.content
      .filter(
        (item) => item && item.type === "text" && typeof item.text === "string",
      )
      .map((item) => item.text);
    return parts.join("\n");
  }

  function addPiSessionListener(session, listener) {
    if (!session || typeof listener !== "function") {
      return () => {};
    }
    session.streamListeners.add(listener);
    return () => {
      session.streamListeners.delete(listener);
    };
  }

  // Pi extension widgets/status lines carry terminal ANSI colour codes; strip
  // them so the web UI renders clean text.
  function stripAnsi(text) {
    return String(text ?? "").replace(
      /\u001b\[[0-9;?]*[a-zA-Z]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b[@-Z\\^_]/g,
      "",
    );
  }

  function isPiDialogRequest(evt) {
    return (
      evt?.type === "extension_ui_request" && PI_DIALOG_METHODS.has(evt.method)
    );
  }

  function formatPiUiRequest(evt) {
    return {
      id: evt.id,
      method: evt.method,
      title: evt.title || "",
      message: evt.message || "",
      options: Array.isArray(evt.options) ? evt.options : [],
      placeholder: evt.placeholder || "",
      prefill: evt.prefill || "",
      timeout: typeof evt.timeout === "number" ? evt.timeout : undefined,
    };
  }

  const piConvProcesses = new Map();
  // convId -> { proc, buffer, stderrData, closed, lastActivityAt, settings, sessionFile, activeRequestId, pendingStatsResolver, pendingStateResolver }

  function cleanupPiSession(sessionId, reason = "session_closed") {
    const session = piRpcSessions.get(sessionId);
    if (!session) return;

    const wasQueued = session.queued;
    const convProc = session.convProc;

    // If the session ended in a provider error but hasn't actually finished the agent run,
    // we must NOT delete it yet. This keeps the session alive so that Pi's internal
    // auto-retries can still emit events to the original session ID, allowing the
    // browser to receive the recovered response on the same stream.
    // Terminal reasons (stale sweep, process death) must still reclaim it,
    // otherwise a retry that never resolves leaks the session forever.
    if (
      session.hadProviderError &&
      !session.done &&
      !session.closed &&
      reason !== "stale_timeout" &&
      reason !== "session_closed"
    ) {
      return;
    }

    if (!session.done && !session.error) {
      session.error = new Error(reason);
    }
    notifyPiSession(session);
    piRpcSessions.delete(sessionId);

    if (convProc) {
      if (wasQueued && convProc.queue) {
        const idx = convProc.queue.findIndex((q) => q.id === sessionId);
        if (idx !== -1) convProc.queue.splice(idx, 1);
      } else if (convProc.activeRequestId === sessionId) {
        advancePiQueue(convProc);
      }
    }

    appendSecurityEvent("pi_session_cleanup", {
      sessionId,
      reason,
      source: session.source || null,
      pendingDialogMethod: session.pendingDialog?.method || null,
    });
  }

  function getOrCreatePiConvProcess(convId, piSettings = null) {
    if (piConvProcesses.has(convId)) {
      const existing = piConvProcesses.get(convId);
      if (!existing.closed) {
        existing.lastActivityAt = Date.now();
        return existing;
      }
      piConvProcesses.delete(convId);
    }

    // Cap number of running Pi processes
    const MAX_PI_CONV_PROCESSES = 20;
    if (piConvProcesses.size >= MAX_PI_CONV_PROCESSES) {
      let oldest = null,
        oldestTime = Infinity;
      for (const [id, proc] of piConvProcesses.entries()) {
        if (proc.closed) {
          piConvProcesses.delete(id);
          break; // we just need to free up one slot
        }
        // Avoid killing a process that is actively processing a request
        if (proc.activeRequestId !== null) continue;
        if (proc.lastActivityAt < oldestTime) {
          oldest = id;
          oldestTime = proc.lastActivityAt;
        }
      }
      if (piConvProcesses.size >= MAX_PI_CONV_PROCESSES && oldest) {
        try {
          piConvProcesses.get(oldest).proc.kill();
        } catch (_) {}
        piConvProcesses.delete(oldest);
      }
    }

    const settings = sanitizePiSettings(piSettings || loadPiSettings());
    const configuredCommand =
      typeof settings.commandPath === "string"
        ? settings.commandPath.trim()
        : "";
    const cmd = configuredCommand || getPiCommand();
    const proc = spawn(cmd, ["--mode", "rpc"], {
      cwd: settings.workingDirectory || DATA_DIR,
      env: buildPiEnv(),
    });

    proc.on("exit", (code, signal) => {
      convProc.closed = true;
      appendSecurityEvent("pi_process_exit", {
        convId,
        code,
        signal,
      });
    });

    const convProc = {
      proc,
      buffer: "",
      stderrData: "",
      closed: false,
      lastActivityAt: Date.now(),
      settings,
      sessionFile: null,
      activeRequestId: null,
      pendingStatsResolver: null,
      pendingStateResolver: null,
      pendingCommandResolvers: new Map(),
      convId,
    };

    piConvProcesses.set(convId, convProc);

    proc.stdout.on("data", (chunk) => {
      convProc.buffer += chunk.toString();
      const lines = convProc.buffer.split("\n");
      convProc.buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        let evt;
        try {
          evt = JSON.parse(line);
        } catch (e) {
          continue;
        }

        convProc.lastActivityAt = Date.now();

        // Generic RPC command responses (issued via sendPiCommand with an id).
        if (
          evt.type === "response" &&
          typeof evt.id === "string" &&
          convProc.pendingCommandResolvers instanceof Map &&
          convProc.pendingCommandResolvers.has(evt.id)
        ) {
          const resolveCommand = convProc.pendingCommandResolvers.get(evt.id);
          convProc.pendingCommandResolvers.delete(evt.id);
          resolveCommand(evt);
          continue;
        }

        if (evt.type === "response" && evt.command === "get_state") {
          const stateData = evt.data || evt;
          convProc.sessionFile = stateData.sessionFile || convProc.sessionFile;
          if (convProc.pendingStateResolver) {
            const resolveState = convProc.pendingStateResolver;
            convProc.pendingStateResolver = null;
            resolveState(stateData);
          }
          continue;
        }

        if (
          (evt.type === "response" && evt.command === "get_session_stats") ||
          evt.type === "session_stats" ||
          evt.type === "get_session_stats_response" ||
          evt.contextUsage
        ) {
          const statsData = evt.data || evt;
          if (convProc.pendingStatsResolver && statsData.contextUsage) {
            const resolveStats = convProc.pendingStatsResolver;
            convProc.pendingStatsResolver = null;
            resolveStats(statsData);
          }
          continue;
        }

        let session = piRpcSessions.get(convProc.activeRequestId);

        if (!session) {
          // The session is missing (either it never existed, or was cleaned up/timed out).
          // If we get a message update, tool, or end, the model has "woken up" (or a
          // lingering response arrived) and we should capture it as an async wake turn.
          const isWakeEvent =
            evt.type === "message_update" ||
            evt.type === "tool_execution_start" ||
            evt.type === "tool_execution_update" ||
            evt.type === "tool_execution_end" ||
            evt.type === "agent_end";
          if (isWakeEvent) {
            const captured = {
              id: createPiSessionId(),
              proc: convProc.proc,
              convProc,
              response: "",
              thinking: "",
              buffer: "",
              stderrData: "",
              pendingDialog: null,
              done: false,
              closed: false,
              error: null,
              hadProviderError: false,
              waiters: [],
              streamListeners: new Set(),
              source: "async_wake",
              timeoutMs: convProc.settings.timeoutMs,
              uiSettings: convProc.settings.permissionUx,
              createdAt: Date.now(),
              lastActivityAt: Date.now(),
              queued: false,
            };
            piRpcSessions.set(captured.id, captured);
            convProc.activeRequestId = captured.id;
            session = captured;
            appendSecurityEvent("pi_async_wake_detected", {
              convId,
              sessionId: captured.id,
              triggerEvent: evt.type || null,
            });
          }
        }

        // Track the pi-subagents async fleet widget even when no session is
        // attached: its presence means background subagents are still running,
        // which gates when an agent_end really finishes the conversation turn.
        if (
          evt.type === "extension_ui_request" &&
          evt.method === "setWidget" &&
          evt.widgetKey === "subagent-async"
        ) {
          convProc.asyncWidgetActive =
            Array.isArray(evt.widgetLines) && evt.widgetLines.length > 0;
        }

        if (!session) continue;

        session.lastActivityAt = Date.now();

        // Extension UI signals (widgets, status lines, notifications) become
        // first-class readable events instead of raw JSON trace dumps. The
        // subagent fleet widget in particular is the same live progress view
        // the terminal shows — forward its lines verbatim (ANSI stripped).
        if (evt.type === "extension_ui_request") {
          if (evt.method === "setWidget") {
            const widgetLines = Array.isArray(evt.widgetLines)
              ? evt.widgetLines.slice(0, 80).map((l) => stripAnsi(l))
              : null;
            emitPiSessionEvent(session, {
              type: "pi_widget",
              sessionId: session.id,
              key: evt.widgetKey || "widget",
              lines: widgetLines,
            });
            continue;
          }
          if (evt.method === "setStatus") {
            emitPiSessionEvent(session, {
              type: "pi_status",
              sessionId: session.id,
              key: evt.statusKey || "status",
              text:
                typeof evt.statusText === "string"
                  ? stripAnsi(evt.statusText)
                  : "",
            });
            continue;
          }
          if (evt.method === "notify") {
            emitPiSessionEvent(session, {
              type: "pi_notice",
              sessionId: session.id,
              noticeType: evt.notifyType || "info",
              message: stripAnsi(evt.message || ""),
            });
            continue;
          }
          if (evt.method === "setTitle" || evt.method === "set_editor_text") {
            continue; // terminal-only concerns, meaningless in the web UI
          }
          // select / confirm / input / editor fall through to the dialog
          // handler below (isPiDialogRequest).
        }

        if (evt.type === "auto_retry_start") {
          emitPiSessionEvent(session, {
            type: "provider_retry",
            sessionId: session.id,
          });
          continue;
        }

        if (evt.type === "auto_retry_end") {
          emitPiSessionEvent(session, {
            type: "provider_retry_end",
            success: evt.success || false,
            sessionId: session.id,
          });
          continue;
        }

        if (
          (evt.type === "message_end" || evt.type === "turn_end") &&
          (evt.stopReason === "error" || evt.message?.stopReason === "error")
        ) {
          let errorMsg =
            evt.errorMessage ||
            evt.message?.errorMessage ||
            "Unknown provider error";
          if (typeof errorMsg === "object") {
            errorMsg = JSON.stringify(errorMsg);
          }
          session.hadProviderError = true;
          emitPiSessionEvent(session, {
            type: "provider_error",
            error: clampText(String(errorMsg), 600),
            sessionId: session.id,
          });
          continue;
        }

        // A clean assistant message-end carries the model + token usage for the
        // turn — surface it as a compact readable footer instead of JSON noise.
        if (
          evt.type === "message_end" &&
          evt.message?.role === "assistant" &&
          evt.message?.usage
        ) {
          const usage = evt.message.usage;
          emitPiSessionEvent(session, {
            type: "pi_usage",
            sessionId: session.id,
            model: evt.message.model || "",
            input: Number(usage.input) || 0,
            output: Number(usage.output) || 0,
            cost: Number(usage.cost?.total) || 0,
          });
          continue;
        }

        // Structural lifecycle events carry nothing the user can read — the
        // substance arrives via thinking/text deltas and tool events. Dropping
        // them here is what kills the raw-JSON "Trace" gibberish.
        if (
          evt.type === "agent_start" ||
          evt.type === "turn_start" ||
          evt.type === "turn_end" ||
          evt.type === "message_start" ||
          evt.type === "message_end" ||
          evt.type === "response"
        ) {
          continue;
        }

        if (evt.type === "compaction_start") {
          emitPiSessionEvent(session, {
            type: "compaction_start",
            reason: evt.reason || null,
            sessionId: session.id,
          });
          continue;
        }

        if (evt.type === "compaction_end") {
          emitPiSessionEvent(session, {
            type: "compaction_end",
            reason: evt.reason || null,
            tokensBefore: evt.result?.tokensBefore || null,
            sessionId: session.id,
          });
          continue;
        }

        if (evt.type === "message_update") {
          const delta = evt.assistantMessageEvent;
          if (delta?.type === "thinking_start") {
            emitPiSessionEvent(session, {
              type: "thinking_start",
              sessionId: session.id,
            });
            continue;
          }
          if (delta?.type === "thinking_delta") {
            const chunk = typeof delta.delta === "string" ? delta.delta : "";
            if (chunk) session.thinking += chunk;
            emitPiSessionEvent(session, {
              type: "thinking_delta",
              delta: chunk,
              thinking: session.thinking,
              sessionId: session.id,
            });
            continue;
          }
          if (delta?.type === "thinking_end") {
            emitPiSessionEvent(session, {
              type: "thinking_end",
              thinking: session.thinking,
              sessionId: session.id,
            });
            continue;
          }
          if (delta?.type === "text_delta") {
            // First text of the wake turn (after async subagents finished):
            // separate it from the pre-async text instead of gluing them.
            if (session.awaitingAsync) {
              session.awaitingAsync = false;
              if (session.response && session.response.trim()) {
                session.response += "\n\n";
              }
            }
            session.response += delta.delta;
            emitPiSessionEvent(session, {
              type: "delta",
              delta: delta.delta,
              response: session.response,
              sessionId: session.id,
            });
            continue;
          }
          // Fallback: if it's a message update but not a delta, it might be a full response.
          if (typeof delta === "string" && delta.trim()) {
            session.response = delta;
            emitPiSessionEvent(session, {
              type: "delta",
              delta: delta,
              response: session.response,
              sessionId: session.id,
            });
            continue;
          }
          continue;
        }

        if (evt.type === "tool_execution_start") {
          emitPiSessionEvent(session, {
            type: "tool_start",
            sessionId: session.id,
            toolName: evt.toolName || null,
            toolCallId: evt.toolCallId || null,
            argsPreview: clampText(JSON.stringify(evt.args || {}), 400),
          });
          continue;
        }

        if (evt.type === "tool_execution_update") {
          const output = extractToolTextPayload(evt.partialResult);
          emitPiSessionEvent(session, {
            type: "tool_update",
            sessionId: session.id,
            toolName: evt.toolName || null,
            toolCallId: evt.toolCallId || null,
            outputPreview: clampText(output, 3000),
          });
          continue;
        }

        if (evt.type === "tool_execution_end") {
          const output = extractToolTextPayload(evt.result);
          emitPiSessionEvent(session, {
            type: "tool_end",
            sessionId: session.id,
            toolName: evt.toolName || null,
            toolCallId: evt.toolCallId || null,
            isError: evt.isError === true,
            outputPreview: clampText(output, 1500),
          });
          continue;
        }

        if (isPiDialogRequest(evt)) {
          session.pendingDialog = evt;
          emitPiSessionEvent(session, {
            type: "needs_ui",
            sessionId: session.id,
            request: formatPiUiRequest(evt),
          });
          notifyPiSession(session);
          continue;
        }

        if (evt.type === "agent_end") {
          // Async subagents: pi-subagents lets the parent agent end its turn
          // while background children keep working, then wakes it with their
          // results. While the fleet widget is active, this agent_end is NOT
          // the end of the conversation turn — keep the session (and the
          // client's stream) open so the wake turn lands in the same bubble
          // instead of an empty reply + a prematurely re-enabled send button.
          if (
            convProc.asyncWidgetActive &&
            session.source !== "async_wake" &&
            !session.error
          ) {
            session.awaitingAsync = true;
            emitPiSessionEvent(session, {
              type: "async_pending",
              sessionId: session.id,
            });
            continue;
          }
          session.done = true;
          if (
            session.hadProviderError &&
            (!session.response || !session.response.trim())
          ) {
            emitPiSessionEvent(session, {
              type: "error",
              error:
                "The provider encountered an error and retries were exhausted. No response was generated.",
              sessionId: session.id,
            });
          }
          emitPiSessionEvent(session, {
            type: "done",
            response: session.response || "",
            sessionId: session.id,
          });
          notifyPiSession(session);
          if (session.source === "async_wake") {
            // Nobody is listening for this session (no stream, no waiter) —
            // save the result now, since this is the only chance to.
            persistAsyncWakeTurn(convId, session.response || "", {
              thinking: session.thinking || "",
            });
            cleanupPiSession(session.id, "async_wake_completed");
          }
          continue;
        }

        if (evt.type === "extension_error") {
          emitPiSessionEvent(session, {
            type: "trace",
            sessionId: session.id,
            label: "extension_error",
            detail: clampText(JSON.stringify(evt), 1500),
          });
          continue;
        }

        emitPiSessionEvent(session, {
          type: "trace",
          sessionId: session.id,
          label: evt.type || "event",
          detail: clampText(JSON.stringify(evt), 1200),
        });
      }
    });

    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      // Ring-buffer: keep only the last 50KB to prevent memory exhaustion
      convProc.stderrData = (convProc.stderrData + text).slice(-50_000);
      if (convProc.activeRequestId) {
        const session = piRpcSessions.get(convProc.activeRequestId);
        if (session) {
          emitPiSessionEvent(session, {
            type: "stderr",
            sessionId: session.id,
            chunk: clampText(text, 1500),
          });
        }
      }
    });

    proc.stdin.on("error", () => {});

    proc.on("error", (error) => {
      let errMsg = error instanceof Error ? error.message : String(error);
      if (error.code === "ENOENT") {
        errMsg =
          "Pi command not found. Please install Pi and ensure it is in your PATH, or configure its path in Settings.";
      }
      if (convProc.activeRequestId) {
        const session = piRpcSessions.get(convProc.activeRequestId);
        if (session) {
          session.error = new Error(errMsg);
          emitPiSessionEvent(session, {
            type: "error",
            error: session.error.message,
            sessionId: session.id,
          });
          notifyPiSession(session);
        }
      }
      if (convProc.pendingStateResolver) {
        const resolveState = convProc.pendingStateResolver;
        convProc.pendingStateResolver = null;
        resolveState(null);
      }
      if (convProc.pendingStatsResolver) {
        const resolveStats = convProc.pendingStatsResolver;
        convProc.pendingStatsResolver = null;
        resolveStats(null);
      }
    });

    proc.on("close", (code) => {
      convProc.closed = true;
      if (convProc.pendingStateResolver) {
        const resolveState = convProc.pendingStateResolver;
        convProc.pendingStateResolver = null;
        resolveState(null);
      }
      if (convProc.pendingStatsResolver) {
        const resolveStats = convProc.pendingStatsResolver;
        convProc.pendingStatsResolver = null;
        resolveStats(null);
      }
      if (convProc.activeRequestId) {
        const session = piRpcSessions.get(convProc.activeRequestId);
        if (session && !session.done) {
          if (code !== 0) {
            session.error = new Error(
              `Pi process exited with code ${code}. Stderr: ${convProc.stderrData.trim() || "none"}`,
            );
            emitPiSessionEvent(session, {
              type: "error",
              error: session.error.message,
              sessionId: session.id,
            });
          } else {
            session.done = true;
            emitPiSessionEvent(session, {
              type: "done",
              response: session.response || "",
              sessionId: session.id,
            });
          }
          notifyPiSession(session);
        }
      }
    });

    proc.stdin.write(JSON.stringify({ type: "get_state" }) + "\n");

    return convProc;
  }

  function requestPiState(convProc, timeoutMs = 5000) {
    if (!convProc || convProc.closed) return Promise.resolve(null);
    if (convProc.pendingStateResolver) {
      return Promise.reject(
        createHttpError(409, "State request already in progress"),
      );
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (convProc.pendingStateResolver === finish) {
          convProc.pendingStateResolver = null;
        }
        resolve(value);
      };
      convProc.pendingStateResolver = finish;
      convProc.proc.stdin.write(JSON.stringify({ type: "get_state" }) + "\n");
      setTimeout(() => finish(null), timeoutMs);
    });
  }

  function requestPiStats(convProc, timeoutMs = 5000) {
    if (!convProc || convProc.closed) return Promise.resolve(null);
    if (convProc.pendingStatsResolver) {
      return Promise.reject(
        createHttpError(409, "Stats request already in progress"),
      );
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (convProc.pendingStatsResolver === finish) {
          convProc.pendingStatsResolver = null;
        }
        resolve(value);
      };
      convProc.pendingStatsResolver = finish;
      convProc.proc.stdin.write(
        JSON.stringify({ type: "get_session_stats" }) + "\n",
      );
      setTimeout(() => finish(null), timeoutMs);
    });
  }

  function formatPiContextUsage(stats) {
    const cu = stats && stats.contextUsage;
    if (cu && cu.tokens != null && cu.contextWindow != null) {
      return {
        used: cu.tokens,
        total: cu.contextWindow,
        percent:
          cu.percent != null
            ? cu.percent
            : Math.round((cu.tokens / cu.contextWindow) * 100),
      };
    }
    return null;
  }

  function summarizePiStatus(state, stats = null) {
    const model =
      state?.model && typeof state.model === "object" ? state.model : {};
    const provider = typeof model.provider === "string" ? model.provider : "";
    const cloudProviders = [
      "openai",
      "anthropic",
      "google",
      "mistral",
      "deepseek",
      "perplexity",
    ];
    const isCloud = cloudProviders.includes(provider.toLowerCase());

    const zeroCost =
      model.cost &&
      typeof model.cost === "object" &&
      Number(model.cost.input || 0) === 0 &&
      Number(model.cost.output || 0) === 0 &&
      Number(model.cost.cacheRead || 0) === 0 &&
      Number(model.cost.cacheWrite || 0) === 0;
    const statsCost =
      stats && typeof stats.cost === "number" && Number.isFinite(stats.cost)
        ? stats.cost
        : null;

    const isLocal =
      !isCloud &&
      (provider === "ollama" ||
        zeroCost ||
        (statsCost !== null && statsCost === 0));

    const cost = isLocal
      ? "Local"
      : statsCost != null
        ? `$${statsCost.toFixed(4)}`
        : null;

    return {
      model: model.id || model.name || null,
      provider: provider || null,
      isLocal,
      state: state?.isCompacting
        ? "COMPACTING"
        : state?.isStreaming
          ? "STREAMING"
          : "IDLE",
      thinkingLevel:
        typeof state?.thinkingLevel === "string" ? state.thinkingLevel : null,
      cost,
      sessionId: typeof state?.sessionId === "string" ? state.sessionId : null,
      contextUsage: formatPiContextUsage(stats),
    };
  }

  function isPiConvProcBusy(convProc) {
    return convProc.activeRequestId !== null;
  }

  function advancePiQueue(convProc) {
    if (!convProc.queue || convProc.queue.length === 0) {
      convProc.activeRequestId = null;
      return;
    }
    const next = convProc.queue.shift();
    const session = piRpcSessions.get(next.id);
    if (!session) {
      advancePiQueue(convProc);
      return;
    }
    dispatchPiPrompt(convProc, session, next.message);
  }

  function dispatchPiPrompt(convProc, session, message) {
    convProc.activeRequestId = session.id;
    const payload = JSON.stringify({
      type: "prompt",
      message,
      source: session.source,
    });
    convProc.proc.stdin.write(payload + "\n");
    session.lastActivityAt = Date.now();
  }

  // ---- Pi environment banner (version, context, skills, prompts, extensions) ----
  let piVersionCache = null;
  function getPiVersionSync() {
    if (piVersionCache !== null) return piVersionCache;
    piVersionCache = "";
    try {
      let cmd = getPiCommand();
      if (!path.isAbsolute(cmd)) {
        const lookup = spawnSync("/usr/bin/env", ["which", cmd], {
          encoding: "utf8",
          env: buildPiEnv(),
        });
        const found = (lookup.stdout || "").trim().split("\n")[0];
        if (found) cmd = found;
      }
      const real = fs.realpathSync(cmd);
      const pkg = JSON.parse(
        fs.readFileSync(
          path.join(path.dirname(real), "..", "package.json"),
          "utf8",
        ),
      );
      piVersionCache = typeof pkg.version === "string" ? pkg.version : "";
    } catch (_e) {}
    return piVersionCache;
  }

  function listPiExtensionsFromSettings() {
    try {
      const cfg = JSON.parse(
        fs.readFileSync(
          path.join(os.homedir(), ".pi", "agent", "settings.json"),
          "utf8",
        ),
      );
      const names = new Set();
      const nameOf = (source) => {
        const s = String(source);
        if (s.startsWith("npm:")) return s.slice(4);
        return path.basename(s);
      };
      for (const entry of Array.isArray(cfg.extensions) ? cfg.extensions : []) {
        const parts = String(entry).split("/").filter(Boolean);
        // "+extensions/pi-face/src/index.ts" -> "pi-face"
        const idx = parts.findIndex(
          (p) => p === "extensions" || p === "+extensions",
        );
        names.add(idx >= 0 && parts[idx + 1] ? parts[idx + 1] : parts[0]);
      }
      for (const entry of Array.isArray(cfg.packages) ? cfg.packages : []) {
        if (typeof entry === "string") names.add(nameOf(entry));
        else if (entry && typeof entry === "object" && entry.source) {
          names.add(nameOf(entry.source));
        }
      }
      return [...names].sort();
    } catch (_e) {
      return [];
    }
  }

  function listPiContextFiles(workingDirectory) {
    const home = os.homedir();
    const candidates = [
      path.join(home, ".pi", "agent", "AGENTS.md"),
      workingDirectory ? path.join(workingDirectory, "AGENTS.md") : null,
      workingDirectory ? path.join(workingDirectory, ".pi", "AGENTS.md") : null,
    ].filter(Boolean);
    return candidates
      .filter((file) => {
        try {
          return fs.existsSync(file);
        } catch (_e) {
          return false;
        }
      })
      .map((file) =>
        file.startsWith(home) ? "~" + file.slice(home.length) : file,
      );
  }

  // Compose the same startup banner the pi terminal shows and deliver it into
  // the first turn's execution trace of a conversation.
  async function emitPiEnvironmentBanner(convProc, session) {
    const lines = [];
    const version = getPiVersionSync();
    lines.push(version ? `pi v${version}` : "pi");
    const context = listPiContextFiles(
      convProc.settings?.workingDirectory || DATA_DIR,
    );
    if (context.length) lines.push(`Context: ${context.join(", ")}`);
    try {
      const reply = await sendPiCommand(
        convProc,
        { type: "get_commands" },
        20000,
      );
      const commands = reply?.data?.commands || [];
      const skills = commands
        .filter((c) => c.source === "skill")
        .map((c) => c.name)
        .sort();
      const prompts = commands
        .filter((c) => c.source === "prompt")
        .map((c) => "/" + c.name)
        .sort();
      if (skills.length) lines.push(`Skills: ${skills.join(", ")}`);
      if (prompts.length) lines.push(`Prompts: ${prompts.join(", ")}`);
    } catch (_e) {}
    const extensions = listPiExtensionsFromSettings();
    if (extensions.length) lines.push(`Extensions: ${extensions.join(", ")}`);
    emitPiSessionEvent(session, {
      type: "pi_banner",
      sessionId: session.id,
      text: lines.join("\n"),
    });
  }

  // Send a one-shot RPC command (model switching, thinking level, compaction,
  // stats, command discovery) to a conversation's pi process and await its
  // response. This is what lets the web UI expose the same controls the
  // terminal has instead of prompting-only access.
  function sendPiCommand(convProc, command, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (!convProc.proc.stdin || !convProc.proc.stdin.writable) {
        reject(new Error("Pi process stdin is not writable."));
        return;
      }
      if (!(convProc.pendingCommandResolvers instanceof Map)) {
        convProc.pendingCommandResolvers = new Map();
      }
      const id = `cmd_${randomUUID()}`;
      const timer = setTimeout(() => {
        convProc.pendingCommandResolvers.delete(id);
        reject(new Error(`Pi command ${command.type} timed out.`));
      }, timeoutMs);
      convProc.pendingCommandResolvers.set(id, (evt) => {
        clearTimeout(timer);
        resolve(evt);
      });
      convProc.proc.stdin.write(JSON.stringify({ id, ...command }) + "\n");
      convProc.lastActivityAt = Date.now();
    });
  }

  function sendPiPrompt(convProc, message, source = "manual") {
    // Use convId as the session ID to ensure a single stable channel per conversation.
    // This ensures that async_wake recoveries (which use the same convId) are delivered
    // to the original stream.
    const id = convProc.convId || createPiSessionId();

    const session = {
      id,
      proc: convProc.proc,
      convProc,
      response: "",
      thinking: "",
      buffer: "",
      stderrData: "",
      pendingDialog: null,
      done: false,
      closed: false,
      error: null,
      hadProviderError: false,
      waiters: [],
      streamListeners: new Set(),
      source,
      timeoutMs: convProc.settings.timeoutMs,
      uiSettings: convProc.settings.permissionUx,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      queued: false,
    };

    piRpcSessions.set(id, session);

    if (isPiConvProcBusy(convProc)) {
      session.queued = true;
      if (!convProc.queue) convProc.queue = [];
      convProc.queue.push({ id, message });
      emitPiSessionEvent(session, { type: "queued", sessionId: id });
      return session;
    }

    dispatchPiPrompt(convProc, session, message);
    return session;
  }

  async function waitForPiSessionStep(
    session,
    timeoutMs = session?.timeoutMs || PI_SESSION_TIMEOUT_MS,
  ) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      if (session.error) {
        cleanupPiSession(session.id);
        throw session.error;
      }

      if (session.pendingDialog) {
        return {
          status: "needs_ui",
          sessionId: session.id,
          request: formatPiUiRequest(session.pendingDialog),
        };
      }

      if (session.done) {
        const response = session.response || "";
        appendSecurityEvent("pi_response_completed", {
          sessionId: session.id,
          source: session.source || null,
          responseLength: response.length,
        });
        cleanupPiSession(session.id, "completed");
        return {
          status: "done",
          response,
        };
      }

      await new Promise((resolve) => {
        if (session.error || session.pendingDialog || session.done) {
          resolve();
        } else {
          session.waiters.push(resolve);
        }
      });
    }

    cleanupPiSession(session.id, "session_timeout");
    throw new Error("Timed out waiting for Pi RPC response.");
  }

  function applyPiUiResponse(session, uiResponse) {
    if (!uiResponse || typeof uiResponse !== "object") {
      throw new Error("uiResponse object is required");
    }
    if (uiResponse.type !== "extension_ui_response") {
      throw new Error("uiResponse.type must be extension_ui_response");
    }
    if (typeof uiResponse.id !== "string" || !uiResponse.id) {
      throw new Error("uiResponse.id is required");
    }
    if (!session.pendingDialog || session.pendingDialog.id !== uiResponse.id) {
      throw new Error("uiResponse.id does not match current pending request");
    }

    if (session.proc.stdin.destroyed || session.proc.stdin.writableEnded) {
      throw new Error("Pi RPC stdin is not writable");
    }

    session.proc.stdin.write(JSON.stringify(uiResponse) + "\n");
    session.lastActivityAt = Date.now();
    session.pendingDialog = null;
  }

  setInterval(() => {
    const now = Date.now();
    for (const [sessionId, session] of piRpcSessions.entries()) {
      if (session.done || session.closed) continue;
      const staleTimeoutMs = session.timeoutMs || PI_SESSION_TIMEOUT_MS;
      if (now - session.lastActivityAt > staleTimeoutMs) {
        cleanupPiSession(sessionId, "stale_timeout");
      }
    }

    // Sweep closed piConvProcesses
    for (const [convId, proc] of piConvProcesses.entries()) {
      if (proc.closed) {
        piConvProcesses.delete(convId);
      }
    }
  }, PI_SESSION_SWEEP_INTERVAL_MS).unref();

  async function dispatch(ctx) {
    const { req, res, urlPath, send } = ctx;

    if (req.method === "GET" && urlPath === "/api/pi/settings") {
      const settings = loadPiSettings();
      send(200, {
        settings,
        runtime: getPiRuntimeInfo(settings),
      });
      return;
    }

    if (req.method === "POST" && urlPath === "/api/pi/settings") {
      try {
        const body = await parseJsonBody(req);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          send(400, { error: "Settings object is required" });
          return;
        }
        const nextSettings =
          body.settings && typeof body.settings === "object"
            ? body.settings
            : body;
        const sanitized = sanitizePiSettings(nextSettings);
        savePiSettings(sanitized);
        send(200, {
          ok: true,
          settings: sanitized,
          runtime: getPiRuntimeInfo(sanitized),
        });
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return;
    }

    if (req.method === "POST" && urlPath === "/api/pi/settings/reset") {
      const defaults = defaultPiSettings();
      savePiSettings(defaults);
      send(200, {
        ok: true,
        settings: defaults,
        runtime: getPiRuntimeInfo(defaults),
      });
      return;
    }

    if (req.method === "POST" && urlPath === "/api/pi/open-project-folder") {
      openPathInFileManager(__dirname, {}, (error) => {
        if (error) {
          send(500, {
            error: `Failed to open project folder: ${error.message}`,
          });
          return;
        }
        send(200, { ok: true, path: __dirname });
      });
      return;
    }

    if (req.method === "GET" && urlPath.startsWith("/api/pi/events")) {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const convId = url.searchParams.get("conv") || "default";
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(": connected\n\n");
      let subscribers = piEventChannels.get(convId);
      if (!subscribers) {
        subscribers = new Set();
        piEventChannels.set(convId, subscribers);
      }
      subscribers.add(res);
      const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(": hb\n\n");
      }, 15000);
      heartbeat.unref?.();
      req.on("close", () => {
        clearInterval(heartbeat);
        subscribers.delete(res);
        if (subscribers.size === 0) piEventChannels.delete(convId);
      });
      return;
    }

    if (req.method === "POST" && urlPath === "/api/pi/command") {
      try {
        const body = await parseJsonBody(req);
        const convId = body.saveConv || body.convId || "default";
        const command = body.command;
        // Only session-control commands; prompting still goes through the
        // streaming endpoint so events render in the conversation.
        const ALLOWED_PI_COMMANDS = new Set([
          "get_state",
          "get_available_models",
          "set_model",
          "cycle_model",
          "set_thinking_level",
          "cycle_thinking_level",
          "compact",
          "set_auto_compaction",
          "set_auto_retry",
          "abort_retry",
          "get_session_stats",
          "get_commands",
        ]);
        if (
          !command ||
          typeof command !== "object" ||
          !ALLOWED_PI_COMMANDS.has(command.type)
        ) {
          send(400, { error: "Unsupported Pi command" });
          return;
        }
        const convProc = getOrCreatePiConvProcess(convId, loadPiSettings());
        const timeoutMs = command.type === "compact" ? 180000 : 15000;
        const result = await sendPiCommand(convProc, command, timeoutMs);
        send(200, { ok: result?.success !== false, result });
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return;
    }

    if (req.method === "POST" && req.url === "/api/pi/new-session") {
      try {
        const body = await parseJsonBody(req);
        const convId = body.saveConv || body.convId || "default";
        const convProc = piConvProcesses.get(convId);
        if (convProc && !convProc.closed) {
          convProc.proc.stdin.write(
            JSON.stringify({ type: "new_session" }) + "\n",
          );
        }
        send(200, { ok: true });
      } catch (e) {
        send(500, { error: e.message });
      }
      return;
    }

    if (req.method === "POST" && urlPath === "/api/pi/load-session") {
      try {
        const body = await parseJsonBody(req);
        const convId = body.saveConv || body.convId || "default";
        const { sessionFile } = body;

        if (typeof sessionFile !== "string" || !sessionFile.trim()) {
          send(400, { error: "sessionFile must be a non-empty string" });
          return;
        }
        const resolvedPath = path.resolve(sessionFile.trim());

        const convProc = getOrCreatePiConvProcess(convId);
        convProc.proc.stdin.write(
          JSON.stringify({
            type: "switch_session",
            sessionPath: resolvedPath,
          }) + "\n",
        );
        send(200, { ok: true });
      } catch (e) {
        send(500, { error: e.message });
      }
      return;
    }

    if (req.method === "POST" && urlPath === "/api/pi/stats") {
      try {
        const body = await parseJsonBody(req);
        const convId = body.saveConv || body.convId || "default";
        const convProc = piConvProcesses.get(convId);
        if (!convProc || convProc.closed) {
          send(404, { error: "No active Pi process" });
          return;
        }

        const stats = await requestPiStats(convProc);
        send(200, { contextUsage: formatPiContextUsage(stats) });
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return;
    }

    if (req.method === "POST" && urlPath === "/api/pi/status") {
      try {
        const body = await parseJsonBody(req);
        const convId = body.saveConv || body.convId || "default";
        const convProc = piConvProcesses.get(convId);
        if (!convProc || convProc.closed) {
          send(404, { error: "No active Pi process" });
          return;
        }

        const state = await requestPiState(convProc);
        const stats = await requestPiStats(convProc);
        send(200, {
          status: summarizePiStatus(state, stats),
        });
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return;
    }

    if (req.method === "POST" && urlPath === "/api/pi/stream") {
      let session = null;
      let unsubscribe = null;
      let persistTimer = null;
      let persistPartial = null;
      const traceEvents = [];
      let thinking = "";
      const writeStreamEvent = (evt) => {
        // Widget frames update in place — keep only the latest frame per widget
        // in the stored trace so history holds the final state, not hundreds of
        // intermediate repaints. A clear frame (lines: null) mutes the live
        // view but must NOT erase the stored final state.
        let skipStore = false;
        if (evt?.type === "pi_widget") {
          if (Array.isArray(evt.lines) && evt.lines.length) {
            for (let i = traceEvents.length - 1; i >= 0; i--) {
              if (
                traceEvents[i].type === "pi_widget" &&
                traceEvents[i].key === evt.key
              ) {
                traceEvents.splice(i, 1);
              }
            }
          } else {
            skipStore = true;
          }
        }
        const storedEvent = skipStore
          ? null
          : sanitizeTraceEventForStorage(evt);
        if (storedEvent) traceEvents.push(storedEvent);
        if (evt?.type === "thinking_delta") {
          if (typeof evt.thinking === "string") {
            thinking = evt.thinking;
          } else if (typeof evt.delta === "string") {
            thinking += evt.delta;
          }
        }
        // Continuously checkpoint the in-flight turn to disk (debounced) so
        // clearing the chat, starting a new session, or a crash mid-run never
        // loses what was already produced.
        if (evt?.type !== "heartbeat" && typeof persistPartial === "function") {
          if (evt?.type === "async_pending") {
            persistPartial();
          } else if (!persistTimer) {
            persistTimer = setTimeout(() => {
              persistTimer = null;
              if (session && !session.done) persistPartial();
            }, 2500);
          }
        }
        if (res.writableEnded) return;
        res.write(JSON.stringify(evt) + "\n");
      };
      try {
        const body = await parseJsonBody(req);
        if (!body || typeof body.message !== "string" || !body.message.trim()) {
          send(400, { error: "message is required" });
          return;
        }

        const source =
          typeof body.source === "string" && body.source.trim()
            ? body.source.trim()
            : "manual";
        const { history = [], saveConv, convTitle, mode = "pi" } = body;
        const originalMessage = body.message;
        const slashCommand = parseSlashCommand(originalMessage);
        const promptQuestion = getCommandMessage(slashCommand, originalMessage);
        const messages = [
          ...history,
          { role: "user", content: originalMessage },
        ];
        let promptMessage = promptQuestion;
        let librarySourceResults = [];
        let libraryPassages = [];

        res.writeHead(200, {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });

        emitSlashCommand(writeStreamEvent, slashCommand);
        if (isSkillSlashCommand(slashCommand)) {
          writeStreamEvent({
            type: "error",
            error: `/${slashCommand.name} is only supported in Ollama mode.`,
          });
          if (!res.writableEnded) res.end();
          return;
        }

        try {
          const libraryContext = await buildChatLibraryContext(
            promptQuestion,
            getLibraryRequestForCommand(
              body.library,
              slashCommand,
              history,
              "pi",
            ),
          );
          if (libraryContext.enabled) {
            // Database Context on for Pi: prepend the strict library-only policy
            // so Pi answers exclusively from the retrieved passages. When the
            // database is off, Pi keeps its own native persona and tools.
            promptMessage =
              DB_ON_PROMPT +
              "\n\n" +
              buildPiPromptWithLibraryContext(
                promptMessage,
                libraryContext.contextMessage,
              );
            librarySourceResults = serializeLibraryResults(
              getLibraryContextSourceResults(libraryContext),
              getLibraryRequestForCommand(body.library, slashCommand, history),
            );
            libraryPassages = Array.isArray(libraryContext.contextResults)
              ? libraryContext.contextResults
              : [];
            writeStreamEvent({
              type: "library_results",
              results: librarySourceResults,
              passages: libraryPassages,
              meta: libraryContext.contextMeta,
            });
          }
        } catch (e) {
          writeStreamEvent({ type: "library_error", error: e.message });
        }

        // Pi is a text-only CLI, so an attached image is written to a temp file
        // and its path is referenced in the prompt; Pi can open it if it has
        // image/file-reading tools. Temp files self-delete after 10 minutes.
        const piImages = normalizeAttachmentImages(body.images);
        if (piImages.length) {
          const refs = [];
          for (const img of piImages) {
            const tmp = path.join(
              os.tmpdir(),
              "pi_img_" +
                randomBytes(8).toString("hex") +
                extForImageMime(img.mimeType),
            );
            try {
              fs.writeFileSync(tmp, Buffer.from(img.dataBase64, "base64"));
              refs.push(tmp);
              setTimeout(
                () => {
                  try {
                    fs.unlinkSync(tmp);
                  } catch (_e) {}
                },
                10 * 60 * 1000,
              ).unref();
            } catch (_e) {}
          }
          if (refs.length) {
            promptMessage +=
              "\n\n[Attached image file" +
              (refs.length > 1 ? "s" : "") +
              " saved locally — open with your image/file tools: " +
              refs.join(", ") +
              "]";
          }
        }

        const piSettings = loadPiSettings();
        const convId = body.saveConv || "default";
        const convProc = getOrCreatePiConvProcess(convId, piSettings);
        session = sendPiPrompt(convProc, promptMessage, source);
        persistPartial = () => {
          try {
            upsertConversation(
              saveConv,
              convTitle,
              body.message,
              messages,
              session?.response || "",
              mode,
              {
                librarySources: librarySourceResults,
                passages: libraryPassages,
                thinking,
                traceEvents,
                status: "streaming",
              },
            );
          } catch (_e) {}
        };
        writeStreamEvent({ type: "session_start", sessionId: session.id });
        if (!convProc.bannerEmitted) {
          convProc.bannerEmitted = true;
          emitPiEnvironmentBanner(convProc, session).catch(() => {});
        }

        unsubscribe = addPiSessionListener(session, (evt) => {
          writeStreamEvent(evt);
          if (evt.type === "done" || evt.type === "error") {
            if (persistTimer) {
              clearTimeout(persistTimer);
              persistTimer = null;
            }
            if (evt.type === "done") {
              upsertConversation(
                saveConv,
                convTitle,
                body.message,
                messages,
                session.response || "",
                mode,
                {
                  librarySources: librarySourceResults,
                  passages: libraryPassages,
                  thinking,
                  traceEvents,
                },
              );
            }
            if (typeof unsubscribe === "function") unsubscribe();
            if (heartbeatInterval) clearInterval(heartbeatInterval);
            if (!res.writableEnded) res.end();
            cleanupPiSession(
              session.id,
              evt.type === "done" ? "completed_stream" : "stream_error",
            );
          }
        });

        const heartbeatInterval = setInterval(() => {
          if (!res.writableEnded) {
            if (session) session.lastActivityAt = Date.now();
            writeStreamEvent({ type: "heartbeat" });
          } else {
            clearInterval(heartbeatInterval);
          }
        }, 2000);

        if (session.pendingDialog) {
          writeStreamEvent({
            type: "needs_ui",
            sessionId: session.id,
            request: formatPiUiRequest(session.pendingDialog),
          });
        }

        res.on("close", () => {
          if (typeof unsubscribe === "function") unsubscribe();
          if (heartbeatInterval) clearInterval(heartbeatInterval);
          if (persistTimer) {
            clearTimeout(persistTimer);
            persistTimer = null;
          }
          if (session && piRpcSessions.has(session.id)) {
            // The client went away mid-run (stop button, app closed, reload):
            // checkpoint whatever the turn produced so far before tearing down.
            if (!session.done && typeof persistPartial === "function") {
              persistPartial();
            }
            cleanupPiSession(session.id, "stream_client_disconnected");
          }
        });
      } catch (e) {
        if (!res.writableEnded) {
          if (!res.headersSent) {
            send(e.statusCode || 500, { error: e.message });
          } else {
            writeStreamEvent({ type: "error", error: e.message || String(e) });
            res.end();
          }
        }
        if (session && piRpcSessions.has(session.id)) {
          cleanupPiSession(session.id, "stream_setup_error");
        }
      }
      return;
    }

    if (
      req.method === "POST" &&
      (req.url === "/api/pi" || req.url === "/api/pi/start")
    ) {
      let session = null;
      try {
        const body = await parseJsonBody(req);
        if (!body || typeof body.message !== "string" || !body.message.trim()) {
          send(400, { error: "message is required" });
          return;
        }

        const source =
          typeof body.source === "string" && body.source.trim()
            ? body.source.trim()
            : "manual";
        const slashCommand = parseSlashCommand(body.message);
        if (isSkillSlashCommand(slashCommand)) {
          send(400, {
            error: `/${slashCommand.name} is only supported in Ollama mode.`,
          });
          return;
        }
        const promptQuestion = getCommandMessage(slashCommand, body.message);
        let promptMessage = promptQuestion;
        let libraryResults = [];
        try {
          const libraryContext = await buildChatLibraryContext(
            promptQuestion,
            getLibraryRequestForCommand(
              body.library,
              slashCommand,
              body.history,
              "pi",
            ),
          );
          if (libraryContext.enabled) {
            promptMessage = buildPiPromptWithLibraryContext(
              promptMessage,
              libraryContext.contextMessage,
            );
            libraryResults = serializeLibraryResults(
              libraryContext.results,
              getLibraryRequestForCommand(
                body.library,
                slashCommand,
                body.history,
              ),
            );
          }
        } catch (_e) {}
        const piSettings = loadPiSettings();
        const convId = body.saveConv || "default";
        const convProc = getOrCreatePiConvProcess(convId, piSettings);
        session = sendPiPrompt(convProc, promptMessage, source);
        req.on("close", () => {
          if (session && !res.writableEnded) {
            cleanupPiSession(session.id, "client_disconnected_start");
          }
        });
        const result = await waitForPiSessionStep(session);
        send(200, { ...result, libraryResults });
      } catch (e) {
        if (req.destroyed) {
          console.log(
            "Request was destroyed (aborted). Skipping error response.",
          );
        } else {
          send(e.statusCode || 500, { error: e.message });
        }
      }
      return;
    }

    if (req.method === "POST" && req.url === "/api/pi/respond") {
      let sessionId = null;
      try {
        const body = await parseJsonBody(req);
        const {
          sessionId: requestSessionId,
          uiResponse,
          streaming,
        } = body || {};
        sessionId = requestSessionId;
        if (typeof sessionId !== "string" || !sessionId) {
          send(400, { error: "sessionId is required" });
          return;
        }

        const session = piRpcSessions.get(sessionId);
        if (!session) {
          send(404, { error: "Pi RPC session not found or expired" });
          return;
        }
        req.on("close", () => {
          if (sessionId && !res.writableEnded) {
            cleanupPiSession(sessionId, "client_disconnected_respond");
          }
        });

        applyPiUiResponse(session, uiResponse);
        appendSecurityEvent("pi_permission_response", {
          sessionId,
          approved:
            typeof uiResponse.confirmed === "boolean"
              ? uiResponse.confirmed
              : typeof uiResponse.value === "string"
                ? uiResponse.value
                : uiResponse.cancelled === true
                  ? "cancelled"
                  : "unknown",
        });

        if (streaming === true) {
          send(200, { ok: true });
          return;
        }

        const result = await waitForPiSessionStep(session);
        send(200, result);
      } catch (e) {
        if (req.destroyed) {
          console.log(
            "Request was destroyed (aborted). Skipping error response.",
          );
        } else {
          send(e.statusCode || 500, { error: e.message });
        }
      }
      return;
    }

    send(404, { error: "Unknown Pi endpoint" });
  }

  async function handleRequest(ctx) {
    if (!ctx.urlPath.startsWith("/api/pi/")) return false;
    await dispatch(ctx);
    return true;
  }

  return {
    handleRequest,
    api: {
      getOrCreatePiConvProcess,
      sendPiPrompt,
      addPiSessionListener,
      cleanupPiSession,
      emitPiEnvironmentBanner,
      applyPiUiResponse,
      waitForPiSessionStep,
      getSessionFile(convId) {
        return piConvProcesses.has(convId)
          ? piConvProcesses.get(convId).sessionFile
          : null;
      },
      shutdownAll() {
        for (const procObj of piConvProcesses.values()) {
          try {
            procObj.proc.kill("SIGTERM");
          } catch (_e) {}
        }
        piConvProcesses.clear();
      },
    },
  };
};
