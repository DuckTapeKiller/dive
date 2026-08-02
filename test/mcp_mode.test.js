const test = require("node:test");
const assert = require("node:assert/strict");
const {
  initMcpServers,
  getMcpSession,
  acquireMcpSession,
  releaseMcpSession,
  getMcpOllamaTools,
} = require("../mcp.js");

test("MCP sessions and tool discovery are isolated by non-Pi mode", async () => {
  const ollamaStatuses = await initMcpServers("ollama", "");
  const cloudStatuses = await initMcpServers("cloud", "");
  assert.deepEqual(ollamaStatuses, []);
  assert.deepEqual(cloudStatuses, []);

  const ollamaSession = getMcpSession("ollama");
  const cloudSession = getMcpSession("cloud");
  assert.notStrictEqual(ollamaSession, cloudSession);
  assert.equal(getMcpOllamaTools("ollama").length, 0);
  assert.equal(getMcpOllamaTools("cloud").length, 0);

  const lease = acquireMcpSession("ollama");
  await initMcpServers("ollama", "");
  assert.notStrictEqual(getMcpSession("ollama"), lease);
  // Replacing a mode generation does not invalidate an in-flight request's
  // captured lease. It is released only after that request is finished.
  assert.equal(lease.closed, false);
  await releaseMcpSession(lease);
});
