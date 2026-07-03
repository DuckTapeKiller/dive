const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StdioClientTransport,
} = require("@modelcontextprotocol/sdk/client/stdio.js");
const fs = require("fs");
const path = require("path");

// Store active MCP clients: { serverName: { client, transport, tools } }
const activeMcpClients = new Map();

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
 *
 * Extend this list when adding new trusted MCP integrations.
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
  const base = require("path").basename(cmd.trim());
  return MCP_ALLOWED_COMMANDS.has(base);
}

// Returns per-server statuses: [{ name, ok, toolCount, tools, error }] so the
// UI can show exactly which servers connected and why any failed, instead of
// failures dying silently in a console the packaged app never shows.
async function initMcpServers(configJson) {
  const statuses = [];
  // Clean up existing clients
  for (const [name, state] of activeMcpClients.entries()) {
    try {
      await state.client.close();
    } catch (e) {
      console.error(`Error closing MCP client ${name}:`, e);
    }
  }
  activeMcpClients.clear();

  if (!configJson) return statuses;

  let config;
  try {
    config = JSON.parse(configJson);
  } catch (e) {
    console.error("Failed to parse MCP config:", e);
    return [
      { name: "(config)", ok: false, error: `Invalid JSON: ${e.message}` },
    ];
  }

  if (!config.mcpServers) return statuses;

  for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
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
        !serverConfig.args.every((a) => typeof a === "string")
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
    try {
      const resolvedCommand = resolveCommandPath(serverConfig.command);
      console.log(
        `[MCP] Initializing server: ${serverName} (${resolvedCommand})`,
      );
      const transport = new StdioClientTransport({
        command: resolvedCommand,
        args: serverConfig.args,
        env: {
          ...process.env,
          PATH: augmentedPath(),
          ...(serverConfig.env || {}),
        },
      });

      const client = new Client(
        { name: "ollama-pi-chat", version: "1.0.0" },
        { capabilities: { tools: {} } },
      );

      await client.connect(transport);

      const toolsResponse = await client.listTools();
      const tools = toolsResponse.tools || [];

      console.log(
        `[MCP] Server ${serverName} connected. Tools: ${tools.map((t) => t.name).join(", ")}`,
      );

      activeMcpClients.set(serverName, { client, transport, tools });
      statuses.push({
        name: serverName,
        ok: true,
        toolCount: tools.length,
        tools: tools.map((t) => t.name),
      });
    } catch (e) {
      console.error(`[MCP] Failed to initialize server ${serverName}:`, e);
      statuses.push({ name: serverName, ok: false, error: e.message });
    }
  }
  return statuses;
}

// Convert MCP tools into Ollama's format
function getMcpOllamaTools() {
  const ollamaTools = [];

  for (const [serverName, state] of activeMcpClients.entries()) {
    for (const tool of state.tools) {
      ollamaTools.push({
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

  return ollamaTools;
}

// Execute an MCP tool
async function executeMcpTool(toolCall) {
  const nameParts = toolCall.function.name.split("__");
  if (nameParts.length < 3 || nameParts[0] !== "mcp") {
    return "Error: Invalid MCP tool name format.";
  }

  const serverName = nameParts[1];
  const toolName = nameParts.slice(2).join("__");

  const state = activeMcpClients.get(serverName);
  if (!state) {
    return `Error: MCP server '${serverName}' is not active.`;
  }

  let args = {};
  try {
    if (typeof toolCall.function.arguments === "string") {
      args = JSON.parse(toolCall.function.arguments);
    } else {
      args = toolCall.function.arguments || {};
    }
  } catch (e) {
    console.error("Failed to parse MCP tool args:", e);
  }

  try {
    const result = await state.client.callTool({
      name: toolName,
      arguments: args,
    });

    // Extract text content from MCP response
    if (result && result.content && Array.isArray(result.content)) {
      const textBlocks = result.content
        .filter((c) => c.type === "text")
        .map((c) => c.text);
      if (textBlocks.length > 0) {
        return textBlocks.join("\n");
      }
    }

    // Fallback if no text blocks are found
    return JSON.stringify(result);
  } catch (e) {
    console.error(`[MCP] Tool execution error for ${toolName}:`, e);
    return `Error executing MCP tool: ${e.message}`;
  }
}

module.exports = {
  initMcpServers,
  getMcpOllamaTools,
  executeMcpTool,
};
