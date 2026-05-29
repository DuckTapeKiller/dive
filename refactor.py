import re

with open("server.js", "r", encoding="utf-8") as f:
    content = f.read()

# 1. Add piConvProcesses map right before cleanupPiSession
piconv_decl = """
const piConvProcesses = new Map();
// convId -> { proc, buffer, stderrData, closed, lastActivityAt, settings, sessionFile, activeRequestId, pendingStatsResolver }
"""

content = re.sub(
    r"function cleanupPiSession\(",
    piconv_decl.strip() + "\n\nfunction cleanupPiSession(",
    content,
    count=1
)

# 2. Modify cleanupPiSession to not kill proc
content = re.sub(
    r"try \{\s*if \(\!session\.closed \&\& session\.proc\) \{\s*session\.proc\.kill\(\"SIGINT\"\);\s*\}\s*\} catch \(e\) \{\}",
    "",
    content,
    count=1
)

# 3. Replace createPiRpcSession with getOrCreatePiConvProcess and sendPiPrompt
replacement = """
function getOrCreatePiConvProcess(convId, piSettings = null) {
  if (piConvProcesses.has(convId)) {
    const existing = piConvProcesses.get(convId);
    if (!existing.closed) {
      existing.lastActivityAt = Date.now();
      return existing;
    }
    piConvProcesses.delete(convId);
  }

  const settings = sanitizePiSettings(piSettings || loadPiSettings());
  const configuredCommand = typeof settings.commandPath === "string" ? settings.commandPath.trim() : "";
  const cmd = configuredCommand || getPiCommand();
  const proc = spawn(cmd, ["--mode", "rpc"], {
    cwd: settings.workingDirectory || DATA_DIR,
    env: buildPiEnv(),
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
  };

  piConvProcesses.set(convId, convProc);

  proc.stdout.on("data", (chunk) => {
    convProc.buffer += chunk.toString();
    const lines = convProc.buffer.split("\\n");
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

      if (evt.type === "response" && evt.command === "get_state") {
        convProc.sessionFile = evt.data?.sessionFile || null;
        continue;
      }

      if (evt.type === "response" && evt.command === "get_session_stats") {
        if (convProc.pendingStatsResolver) {
          convProc.pendingStatsResolver(evt.data);
          convProc.pendingStatsResolver = null;
        }
        continue;
      }

      if (!convProc.activeRequestId) continue;
      const session = piRpcSessions.get(convProc.activeRequestId);
      if (!session) continue;
      
      session.lastActivityAt = Date.now();

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
          emitPiSessionEvent(session, { type: "thinking_start", sessionId: session.id });
          continue;
        }
        if (delta?.type === "thinking_delta") {
          const chunk = typeof delta.delta === "string" ? delta.delta : "";
          if (chunk) session.thinking += chunk;
          emitPiSessionEvent(session, { type: "thinking_delta", delta: chunk, thinking: session.thinking, sessionId: session.id });
          continue;
        }
        if (delta?.type === "thinking_end") {
          emitPiSessionEvent(session, { type: "thinking_end", thinking: session.thinking, sessionId: session.id });
          continue;
        }
        if (delta?.type === "text_delta") {
          session.response += delta.delta;
          emitPiSessionEvent(session, { type: "delta", delta: delta.delta, response: session.response, sessionId: session.id });
        }
        continue;
      }

      if (evt.type === "tool_execution_start") {
        emitPiSessionEvent(session, { type: "tool_start", sessionId: session.id, toolName: evt.toolName || null, toolCallId: evt.toolCallId || null, argsPreview: clampText(JSON.stringify(evt.args || {}), 400) });
        continue;
      }

      if (evt.type === "tool_execution_update") {
        const output = extractToolTextPayload(evt.partialResult);
        emitPiSessionEvent(session, { type: "tool_update", sessionId: session.id, toolName: evt.toolName || null, toolCallId: evt.toolCallId || null, outputPreview: clampText(output, 1500) });
        continue;
      }

      if (evt.type === "tool_execution_end") {
        const output = extractToolTextPayload(evt.result);
        emitPiSessionEvent(session, { type: "tool_end", sessionId: session.id, toolName: evt.toolName || null, toolCallId: evt.toolCallId || null, isError: evt.isError === true, outputPreview: clampText(output, 1500) });
        continue;
      }

      if (isPiDialogRequest(evt)) {
        session.pendingDialog = evt;
        emitPiSessionEvent(session, { type: "needs_ui", sessionId: session.id, request: formatPiUiRequest(evt) });
        notifyPiSession(session);
        continue;
      }

      if (evt.type === "agent_end") {
        session.done = true;
        emitPiSessionEvent(session, { type: "done", response: session.response || "", sessionId: session.id });
        notifyPiSession(session);
        continue;
      }

      if (evt.type === "extension_error") {
        emitPiSessionEvent(session, { type: "trace", sessionId: session.id, label: "extension_error", detail: clampText(JSON.stringify(evt), 1500) });
        continue;
      }

      emitPiSessionEvent(session, { type: "trace", sessionId: session.id, label: evt.type || "event", detail: clampText(JSON.stringify(evt), 1200) });
    }
  });

  proc.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    convProc.stderrData += text;
    if (convProc.activeRequestId) {
      const session = piRpcSessions.get(convProc.activeRequestId);
      if (session) {
        emitPiSessionEvent(session, { type: "stderr", sessionId: session.id, chunk: clampText(text, 1500) });
      }
    }
  });

  proc.stdin.on("error", () => {});

  proc.on("error", (error) => {
    let errMsg = error instanceof Error ? error.message : String(error);
    if (error.code === "ENOENT") {
      errMsg = "Pi command not found. Please install Pi and ensure it is in your PATH, or configure its path in Settings.";
    }
    if (convProc.activeRequestId) {
      const session = piRpcSessions.get(convProc.activeRequestId);
      if (session) {
        session.error = new Error(errMsg);
        emitPiSessionEvent(session, { type: "error", error: session.error.message, sessionId: session.id });
        notifyPiSession(session);
      }
    }
  });

  proc.on("close", (code) => {
    convProc.closed = true;
    if (convProc.activeRequestId) {
      const session = piRpcSessions.get(convProc.activeRequestId);
      if (session && !session.done) {
        if (code !== 0) {
          session.error = new Error(`Pi process exited with code ${code}. Stderr: ${convProc.stderrData.trim() || "none"}`);
          emitPiSessionEvent(session, { type: "error", error: session.error.message, sessionId: session.id });
        } else {
          session.done = true;
          emitPiSessionEvent(session, { type: "done", response: session.response || "", sessionId: session.id });
        }
        notifyPiSession(session);
      }
    }
  });

  proc.stdin.write(JSON.stringify({ type: "get_state" }) + "\\n");

  return convProc;
}

function sendPiPrompt(convProc, message, source = "manual") {
  const id = createPiSessionId();
  convProc.activeRequestId = id;
  
  const session = {
    id,
    proc: convProc.proc,
    response: "",
    thinking: "",
    buffer: "",
    stderrData: "",
    pendingDialog: null,
    done: false,
    closed: false,
    error: null,
    waiters: [],
    streamListeners: new Set(),
    source,
    timeoutMs: convProc.settings.timeoutMs,
    uiSettings: convProc.settings.permissionUx,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
  };

  piRpcSessions.set(id, session);
  appendSecurityEvent("pi_prompt_received", { sessionId: id, source });

  convProc.proc.stdin.write(JSON.stringify({ type: "prompt", message }) + "\\n");
  convProc.lastActivityAt = Date.now();

  return session;
}
"""

start_idx = content.find("function createPiRpcSession")
if start_idx != -1:
    end_idx = content.find("\n}", content.find("return session;", start_idx)) + 2
    content = content[:start_idx] + replacement.strip() + content[end_idx:]

# 4. Modify /api/chat/stream createPiRpcSession call
content = re.sub(
    r"session = createPiRpcSession\(body\.message,\s*source,\s*piSettings\);",
    "const convId = body.saveConv || \"default\";\n      const convProc = getOrCreatePiConvProcess(convId, piSettings);\n      session = sendPiPrompt(convProc, body.message, source);",
    content
)

# 5. Modify /api/pi and /api/pi/start createPiRpcSession call
# Note: we replaced all occurrences in step 4 above since they matched the regex.
# Let's check for /api/pi/respond which uses JSON.stringify(body.uiResponse)
content = re.sub(
    r"session = createPiRpcSession\(JSON\.stringify\(body\.uiResponse\),\s*source,\s*piSettings\);",
    "const convId = body.saveConv || \"default\";\n      const convProc = getOrCreatePiConvProcess(convId, piSettings);\n      session = sendPiPrompt(convProc, JSON.stringify(body.uiResponse), source);",
    content
)

# 6. Add new endpoints in server.js
new_endpoints = """
  if (req.method === "POST" && req.url === "/api/pi/new-session") {
    try {
      const body = await parseJsonBody(req);
      const convId = body.saveConv || body.convId || "default";
      const convProc = piConvProcesses.get(convId);
      if (convProc && !convProc.closed) {
        convProc.proc.stdin.write(JSON.stringify({ type: "new_session" }) + "\\n");
      }
      send(200, { ok: true });
    } catch (e) {
      send(500, { error: e.message });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/pi/load-session") {
    try {
      const body = await parseJsonBody(req);
      const convId = body.saveConv || body.convId || "default";
      const { sessionFile } = body;
      const convProc = getOrCreatePiConvProcess(convId);
      convProc.proc.stdin.write(JSON.stringify({ type: "switch_session", sessionPath: sessionFile }) + "\\n");
      send(200, { ok: true });
    } catch (e) {
      send(500, { error: e.message });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/pi/stats") {
    try {
      const body = await parseJsonBody(req);
      const convId = body.saveConv || body.convId || "default";
      const convProc = piConvProcesses.get(convId);
      if (!convProc || convProc.closed) {
        send(404, { error: "No active Pi process" });
        return;
      }
      
      const stats = await new Promise((resolve) => {
        convProc.pendingStatsResolver = resolve;
        convProc.proc.stdin.write(JSON.stringify({ type: "get_session_stats" }) + "\\n");
        setTimeout(() => resolve(null), 5000); // 5s timeout
      });
      
      if (stats && stats.contextUsage) {
        send(200, { contextUsage: stats.contextUsage });
      } else {
        send(500, { error: "Failed to retrieve stats" });
      }
    } catch (e) {
      send(500, { error: e.message });
    }
    return;
  }

  if (req.method === "GET" && req.url.startsWith("/api/models/info")) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const modelName = url.searchParams.get("model");
    if (!modelName) {
      send(400, { error: "model parameter required" });
      return;
    }
    try {
      const opts = {
        hostname: "localhost",
        port: 11434,
        path: "/api/show",
        method: "POST",
        headers: { "Content-Type": "application/json" },
      };
      const r = http.request(opts, (resProxy) => {
        let data = "";
        resProxy.on("data", (c) => data += c);
        resProxy.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            send(200, { contextLength: parsed.model_info?.["llama.context_length"] || null });
          } catch(e) {
            send(500, { error: "Failed to parse ollama show response" });
          }
        });
      });
      r.on("error", (e) => send(500, { error: e.message }));
      r.write(JSON.stringify({ name: modelName }));
      r.end();
    } catch (e) {
      send(500, { error: e.message });
    }
    return;
  }
"""

content = re.sub(
    r"if \(req\.method === \"POST\" && req\.url === \"/api/chat/stream\"\)",
    new_endpoints.strip() + "\n\n  if (req.method === \"POST\" && req.url === \"/api/chat/stream\")",
    content
)

# 7. Add piConvProcesses sweep interval
sweep = """
setInterval(() => {
  const now = Date.now();
  for (const [convId, convProc] of piConvProcesses.entries()) {
    if (convProc.closed) {
      piConvProcesses.delete(convId);
      continue;
    }
    if (now - convProc.lastActivityAt > 30 * 60 * 1000) {
      try { convProc.proc.kill("SIGINT"); } catch (e) {}
      piConvProcesses.delete(convId);
    }
  }
}, 60000).unref();
"""

content = re.sub(
    r"setInterval\(\(\) => \{[^}]*PI_SESSION_SWEEP_INTERVAL_MS\)\.unref\(\);",
    "\\g<0>\n\n" + sweep.strip(),
    content
)

# 8. Ollama token counts
ollama_finalize_vars = """
      let output = "";
      let thinking = "";
      let emittedThinkingStart = false;
      let lineBuffer = "";
      let promptEvalCount = 0;
      let evalCount = 0;
"""

content = re.sub(
    r"let output = \"\";\s*let thinking = \"\";\s*let emittedThinkingStart = false;\s*let lineBuffer = \"\";",
    ollama_finalize_vars.strip(),
    content
)

content = re.sub(
    r"emit\(\{ type: \"done\", response: output, thinking \}\);",
    "emit({ type: \"done\", response: output, thinking, promptTokens: promptEvalCount, evalTokens: evalCount });",
    content
)

content = re.sub(
    r"if \(evt\.done === true\) \{",
    "if (evt.done === true) {\n              promptEvalCount = typeof evt.prompt_eval_count === \"number\" ? evt.prompt_eval_count : 0;\n              evalCount = typeof evt.eval_count === \"number\" ? evt.eval_count : 0;",
    content
)

# 9. Update upsertConversation to accept piSessionFile
content = re.sub(
    r"function upsertConversation\([^)]*\)\s*\{",
    "function upsertConversation(id, title, lastMessage, messages, lastResponse, mode = \"ollama\") {\n  const piSessionFile = mode === \"pi\" && id && piConvProcesses.has(id) ? piConvProcesses.get(id).sessionFile : null;",
    content
)

content = re.sub(
    r"convs\[existing\]\.lastUpdated = now;",
    "convs[existing].lastUpdated = now;\n    if (piSessionFile) convs[existing].piSessionFile = piSessionFile;",
    content
)

content = re.sub(
    r"const newConv = \{",
    "const newConv = {\n      piSessionFile,",
    content
)

with open("server.js", "w", encoding="utf-8") as f:
    f.write(content)
