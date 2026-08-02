"use strict";

const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StdioClientTransport,
} = require("@modelcontextprotocol/sdk/client/stdio.js");
const fs = require("fs");
const path = require("path");
const { NON_PI_MODES, requireNonPiMode } = require("./mode-state.js");

// MCP definitions are installed globally, but every running client/session is
// owned by exactly one non-Pi mode. A mode reconfiguration creates a new
// generation; in-flight requests retain the old generation until their lease
// and tool calls have finished.
const activeMcpSessions = new Map();
const retiredMcpSessions = new Set();
const mcpInitQueues = new Map();
let mcpShuttingDown = false;
let mcpShutdownPromise = null;
let nextSessionId = 1;

function createSession(mode) {
  return {
    id: nextSessionId++,
    mode,
    clients: new Map(),
    leases: 0,
    activeCalls: 0,
    draining: false,
    closed: false,
    closePromise: null,
  };
}

function getMcpSession(mode = "ollama") {
  const normalized = requireNonPiMode(mode);
  let session = activeMcpSessions.get(normalized);
  if (mcpShuttingDown && !session) {
    const error = new Error("MCP subsystem is shutting down.");
    error.statusCode = 503;
    throw error;
  }
  if (!session) {
    session = createSession(normalized);
    activeMcpSessions.set(normalized, session);
  }
  return session;
}

function acquireMcpSession(mode = "ollama") {
  if (mcpShuttingDown) {
    const error = new Error("MCP subsystem is shutting down.");
    error.statusCode = 503;
    throw error;
  }
  const session = getMcpSession(mode);
  session.leases += 1;
  return session;
}

async function closeSession(session) {
  if (!session || session.closed) return;
  if (session.leases > 0 || session.activeCalls > 0) {
    session.draining = true;
    retiredMcpSessions.add(session);
    return;
  }
  if (session.closePromise) return session.closePromise;
  session.closePromise = (async () => {
    session.closed = true;
    for (const [name, state] of session.clients.entries()) {
      try {
        await state.client.close();
      } catch (error) {
        console.error(`Error closing MCP client ${name}:`, error);
      }
    }
    session.clients.clear();
    retiredMcpSessions.delete(session);
  })();
  return session.closePromise;
}

function maybeCloseDrainingSession(session) {
  if (
    session &&
    session.draining &&
    session.leases === 0 &&
    session.activeCalls === 0
  ) {
    return closeSession(session);
  }
  return Promise.resolve();
}

function releaseMcpSession(session) {
  if (!session || !session.leases) return Promise.resolve();
  session.leases -= 1;
  return maybeCloseDrainingSession(session);
}

// Packaged macOS apps launch with a minimal PATH (/usr/bin:/bin:...) that does
// not include Homebrew or the Node installer locations, so "npx"/"uvx" are
// never found and every MCP server silently fails. Search these too.
const EXTRA_PATH_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
];

function augmentedPath() {
  const dirs = (process.env.PATH || "").split(":").filter(Boolean);
  for (const dir of EXTRA_PATH_DIRS) {
    if (!dirs.includes(dir)) dirs.push(dir);
  }
  return dirs.join(":");
}

// Resolve a bare command name ("npx") to an absolute executable path using the
// augmented PATH, so spawning works in the packaged app. Paths pass through.
function resolveCommandPath(cmd) {
  const trimmed = String(cmd || "").trim();
  if (!trimmed || trimmed.includes("/")) return trimmed;
  for (const dir of augmentedPath().split(":")) {
    const candidate = path.join(dir, trimmed);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return trimmed;
}

/**
 * Permitted MCP launcher commands.
 * Only these executable names (basename, case-sensitive) may be used as the
 * `command` field in an mcpServers config. Full absolute paths are also
 * accepted provided their basename appears in this set.
 */
const MCP_ALLOWED_COMMANDS = new Set([
  "npx",
  "node",
  "python",
  "python3",
  "uvx",
  "deno",
  "bun",
]);

/**
 * Returns true if the supplied command string is on the allowlist.
 * Accepts both bare names ("npx") and absolute paths ("/usr/local/bin/npx").
 */
function isMcpCommandAllowed(cmd) {
  if (typeof cmd !== "string" || !cmd.trim()) return false;
  const base = path.basename(cmd.trim());
  return MCP_ALLOWED_COMMANDS.has(base);
}

function parseConfig(configJson) {
  if (!configJson) return {};
  if (typeof configJson === "object" && !Array.isArray(configJson)) {
    return configJson;
  }
  return JSON.parse(String(configJson));
}

function replaceActiveSession(mode, nextSession) {
  if (mcpShuttingDown) {
    nextSession.draining = true;
    return closeSession(nextSession);
  }
  const oldSession = activeMcpSessions.get(mode);
  activeMcpSessions.set(mode, nextSession);
  if (oldSession && oldSession !== nextSession) {
    oldSession.draining = true;
    retiredMcpSessions.add(oldSession);
    return maybeCloseDrainingSession(oldSession);
  }
  return Promise.resolve();
}

// Returns per-server statuses: [{ name, ok, toolCount, tools, error }] so the
// UI can show exactly which servers connected and why any failed.
async function initialiseMcpServers(mode, configJson) {
  const statuses = [];
  let config;
  try {
    config = parseConfig(configJson);
  } catch (error) {
    console.error("Failed to parse MCP config:", error);
    return [
      { name: "(config)", ok: false, error: `Invalid JSON: ${error.message}` },
    ];
  }

  const nextSession = createSession(mode);
  if (config && config.mcpServers && typeof config.mcpServers === "object") {
    for (const [serverName, serverConfig] of Object.entries(
      config.mcpServers,
    )) {
      if (!serverConfig || typeof serverConfig !== "object") {
        const error = "server configuration must be an object.";
        statuses.push({ name: serverName, ok: false, error });
        continue;
      }
      // --- Security: validate command before spawning ---
      if (!isMcpCommandAllowed(serverConfig.command)) {
        const error =
          `Command "${serverConfig.command}" is not on the allowlist ` +
          `(permitted: ${[...MCP_ALLOWED_COMMANDS].join(", ")}).`;
        console.error(`[MCP] Rejected server "${serverName}": ${error}`);
        statuses.push({ name: serverName, ok: false, error });
        continue;
      }
      // Validate args is an array of strings (no objects that could smuggle flags)
      if (serverConfig.args !== undefined) {
        if (
          !Array.isArray(serverConfig.args) ||
          !serverConfig.args.every((arg) => typeof arg === "string")
        ) {
          const error = "args must be an array of strings.";
          console.error(`[MCP] Rejected server "${serverName}": ${error}`);
          statuses.push({ name: serverName, ok: false, error });
          continue;
        }

        // Prevent args escape hatches (eval execution via node/python/etc)
        const blockedArgs = new Set([
          "-e",
          "--eval",
          "-c",
          "--command",
          "-p",
          "--print",
          "-i",
          "--interactive",
        ]);
        if (serverConfig.args.some((arg) => blockedArgs.has(arg))) {
          const error = "args contains a forbidden execution flag.";
          console.error(`[MCP] Rejected server "${serverName}": ${error}`);
          statuses.push({ name: serverName, ok: false, error });
          continue;
        }
      }
      // --------------------------------------------------
      let transport = null;
      let client = null;
      try {
        const resolvedCommand = resolveCommandPath(serverConfig.command);
        console.log(
          `[MCP] Initializing ${mode} server: ${serverName} (${resolvedCommand})`,
        );
        transport = new StdioClientTransport({
          command: resolvedCommand,
          args: serverConfig.args,
          env: {
            ...process.env,
            PATH: augmentedPath(),
            ...(serverConfig.env || {}),
          },
        });

        client = new Client(
          { name: "ollama-pi-chat", version: "1.0.0" },
          { capabilities: { tools: {} } },
        );

        await client.connect(transport);

        const toolsResponse = await client.listTools();
        const tools = toolsResponse.tools || [];

        console.log(
          `[MCP] ${mode}/${serverName} connected. Tools: ${tools.map((tool) => tool.name).join(", ")}`,
        );

        nextSession.clients.set(serverName, { client, transport, tools });
        statuses.push({
          name: serverName,
          ok: true,
          toolCount: tools.length,
          tools: tools.map((tool) => tool.name),
        });
      } catch (error) {
        console.error(
          `[MCP] Failed to initialize ${mode}/${serverName}:`,
          error,
        );
        statuses.push({ name: serverName, ok: false, error: error.message });
        try {
          await client?.close();
        } catch (_closeError) {
          // The connection already failed; closing is best effort.
        }
        try {
          await transport?.close?.();
        } catch (_transportCloseError) {
          // Same: the transport may never have opened.
        }
      }
    }
  }

  // Invalid configuration leaves the previous generation intact. Valid empty
  // configuration intentionally replaces it with an empty mode-local session.
  await replaceActiveSession(mode, nextSession);
  return statuses;
}

function enqueueMcpOperation(mode, operation) {
  if (mcpShuttingDown) {
    const error = new Error("MCP subsystem is shutting down.");
    error.statusCode = 503;
    return Promise.reject(error);
  }
  const previous = mcpInitQueues.get(mode) || Promise.resolve();
  // A failed earlier operation must not block the queue; its caller already
  // received the rejection.
  const operationPromise = previous.catch(() => {}).then(operation);
  const trackedPromise = operationPromise.finally(() => {
    if (mcpInitQueues.get(mode) === trackedPromise) {
      mcpInitQueues.delete(mode);
    }
  });
  mcpInitQueues.set(mode, trackedPromise);
  return trackedPromise;
}

// Serialise replacement and stop operations per mode. Without this, a slow
// connection attempt from an older save could finish after a newer save and
// silently reinstall stale MCP clients.
function initMcpServers(mode, configJson) {
  const normalized = requireNonPiMode(mode);
  return enqueueMcpOperation(normalized, () =>
    initialiseMcpServers(normalized, configJson),
  );
}

// Convert MCP tools into Ollama/OpenAI-compatible function definitions. A
// request passes the session it captured at start, so a mode reconfigured
// mid-turn cannot swap the tool list underneath it.
function getMcpOllamaTools(mode, session = null) {
  const active = session || getMcpSession(mode);
  const tools = [];
  for (const [serverName, state] of active.clients.entries()) {
    for (const tool of state.tools) {
      tools.push({
        type: "function",
        function: {
          name: `mcp__${serverName}__${tool.name}`,
          description:
            tool.description || `MCP tool ${tool.name} from ${serverName}`,
          parameters: tool.inputSchema || { type: "object", properties: {} },
        },
      });
    }
  }
  return tools;
}

// Execute an MCP tool against the session captured by the request. Passing the
// session is important: a mode can be reconfigured while a model turn is still
// running, and that turn must not jump to the new server generation.
async function executeMcpTool(toolCall, { mode, session } = {}) {
  const active = session || getMcpSession(mode);
  const nameParts = toolCall.function.name.split("__");
  if (nameParts.length < 3 || nameParts[0] !== "mcp") {
    return "Error: Invalid MCP tool name format.";
  }

  const serverName = nameParts[1];
  const toolName = nameParts.slice(2).join("__");
  const state = active.clients.get(serverName);
  if (!state) {
    return `Error: MCP server '${serverName}' is not active for ${active.mode}.`;
  }

  let args = {};
  try {
    if (typeof toolCall.function.arguments === "string") {
      args = JSON.parse(toolCall.function.arguments);
    } else {
      args = toolCall.function.arguments || {};
    }
  } catch (error) {
    console.error("Failed to parse MCP tool args:", error);
  }

  active.activeCalls += 1;
  try {
    const result = await state.client.callTool({
      name: toolName,
      arguments: args,
    });

    if (result && result.content && Array.isArray(result.content)) {
      const textBlocks = result.content
        .filter((content) => content.type === "text")
        .map((content) => content.text);
      if (textBlocks.length > 0) return textBlocks.join("\n");
    }
    return JSON.stringify(result);
  } catch (error) {
    console.error(`[MCP] Tool execution error for ${toolName}:`, error);
    return `Error executing MCP tool: ${error.message}`;
  } finally {
    active.activeCalls -= 1;
    maybeCloseDrainingSession(active);
  }
}

function stopMcpServers(mode = "ollama") {
  const normalized = requireNonPiMode(mode);
  return enqueueMcpOperation(normalized, () => {
    const current = activeMcpSessions.get(normalized);
    if (!current) return;
    const empty = createSession(normalized);
    return replaceActiveSession(normalized, empty);
  });
}

async function shutdownMcpServers() {
  if (mcpShutdownPromise) return mcpShutdownPromise;
  mcpShuttingDown = true;
  mcpShutdownPromise = (async () => {
    const shutdownDeadline = Date.now() + 4000;
    // Block new mode sessions first, then give already queued connection or
    // stop operations a bounded opportunity to finish. A stuck launcher must
    // not consume the entire HTTP server shutdown grace period.
    const queuedOperations = [...mcpInitQueues.values()];
    const queuedWaitMs = Math.max(0, shutdownDeadline - Date.now());
    await Promise.race([
      Promise.allSettled(queuedOperations),
      new Promise((resolve) => setTimeout(resolve, queuedWaitMs)),
    ]);

    const sessions = [
      ...new Set([
        ...activeMcpSessions.values(),
        ...retiredMcpSessions.values(),
      ]),
    ];
    activeMcpSessions.clear();
    for (const session of sessions) {
      // Do not zero leases or activeCalls: an in-flight request owns its
      // captured generation and must be allowed to finish before its client
      // transport is closed. The process-level shutdown timeout remains the
      // final safety net for a genuinely stuck call.
      session.draining = true;
      await closeSession(session);
      if (session.closed) continue;
      await new Promise((resolve) => {
        const check = () => {
          if (session.closed || Date.now() >= shutdownDeadline) {
            clearInterval(timer);
            resolve();
          }
        };
        const timer = setInterval(check, 25);
        timer.unref?.();
        check();
      });
    }
  })();
  return mcpShutdownPromise;
}

module.exports = {
  NON_PI_MODES,
  MCP_ALLOWED_COMMANDS,
  isMcpCommandAllowed,
  initMcpServers,
  getMcpSession,
  acquireMcpSession,
  releaseMcpSession,
  getMcpOllamaTools,
  executeMcpTool,
  stopMcpServers,
  shutdownMcpServers,
};
