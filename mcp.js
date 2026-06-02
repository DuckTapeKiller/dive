const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StdioClientTransport,
} = require("@modelcontextprotocol/sdk/client/stdio.js");

// Store active MCP clients: { serverName: { client, transport, tools } }
const activeMcpClients = new Map();

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

async function initMcpServers(configJson) {
  // Clean up existing clients
  for (const [name, state] of activeMcpClients.entries()) {
    try {
      await state.client.close();
    } catch (e) {
      console.error(`Error closing MCP client ${name}:`, e);
    }
  }
  activeMcpClients.clear();

  if (!configJson) return;

  let config;
  try {
    config = JSON.parse(configJson);
  } catch (e) {
    console.error("Failed to parse MCP config:", e);
    return;
  }

  if (!config.mcpServers) return;

  for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
    // --- Security: validate command before spawning ---
    if (!isMcpCommandAllowed(serverConfig.command)) {
      console.error(
        `[MCP] Rejected server "${serverName}": command "${serverConfig.command}" is not on the allowlist. ` +
          `Permitted commands: ${[...MCP_ALLOWED_COMMANDS].join(", ")}`,
      );
      continue;
    }
    // Validate args is an array of strings (no objects that could smuggle flags)
    if (serverConfig.args !== undefined) {
      if (
        !Array.isArray(serverConfig.args) ||
        !serverConfig.args.every((a) => typeof a === "string")
      ) {
        console.error(
          `[MCP] Rejected server "${serverName}": args must be an array of strings.`,
        );
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
        console.error(
          `[MCP] Rejected server "${serverName}": args contains forbidden execution flag.`,
        );
        continue;
      }
    }
    // --------------------------------------------------
    try {
      console.log(`[MCP] Initializing server: ${serverName}`);
      const transport = new StdioClientTransport({
        command: serverConfig.command,
        args: serverConfig.args,
        env: { ...process.env, ...(serverConfig.env || {}) },
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
    } catch (e) {
      console.error(`[MCP] Failed to initialize server ${serverName}:`, e);
    }
  }
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
