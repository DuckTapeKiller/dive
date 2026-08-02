// Shutdown is a one-way transition on module state, so it gets its own file:
// node's test runner gives each file its own process.
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  initMcpServers,
  acquireMcpSession,
  releaseMcpSession,
  getMcpSession,
  shutdownMcpServers,
} = require("../mcp.js");

test("shutdown waits for an in-flight lease, then refuses new work", async () => {
  await initMcpServers("ollama", "");
  await initMcpServers("cloud", "");
  const inFlight = acquireMcpSession("ollama");

  // Shutdown must not close a generation a request is still using.
  const shutdown = shutdownMcpServers();
  let settled = false;
  shutdown.then(() => {
    settled = true;
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(inFlight.closed, false, "closed a session still under lease");

  await releaseMcpSession(inFlight);
  await shutdown;
  assert.equal(settled, true);
  assert.equal(inFlight.closed, true);

  // After shutdown, nothing new may be started.
  assert.throws(() => acquireMcpSession("ollama"), /shutting down/);
  assert.throws(() => getMcpSession("lmstudio"), /shutting down/);
  await assert.rejects(initMcpServers("cloud", ""), /shutting down/);

  // Shutting down twice is a no-op, not an error.
  await shutdownMcpServers();
});
