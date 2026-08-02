// The MCP session lifecycle: generations, leases and draining.
//
// A mode's MCP clients can be reconfigured while a model turn is still running.
// The turn captures a session up front and must keep using it; the old
// generation is retired but stays alive until every lease and in-flight tool
// call has finished. That is subtle and was previously covered by one test.
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  initMcpServers,
  getMcpSession,
  acquireMcpSession,
  releaseMcpSession,
  getMcpOllamaTools,
  executeMcpTool,
  stopMcpServers,
  isMcpCommandAllowed,
  MCP_ALLOWED_COMMANDS,
} = require("../mcp.js");

test("only allowlisted commands may be spawned", () => {
  for (const cmd of MCP_ALLOWED_COMMANDS) {
    assert.equal(isMcpCommandAllowed(cmd), true, cmd);
    // An absolute path is judged by its basename.
    assert.equal(isMcpCommandAllowed(`/usr/local/bin/${cmd}`), true);
  }
  for (const bad of ["bash", "sh", "curl", "rm", "", "   ", null, undefined]) {
    assert.equal(isMcpCommandAllowed(bad), false, String(bad));
  }
  // A disallowed binary cannot be smuggled in via a path.
  assert.equal(isMcpCommandAllowed("/tmp/evil/bash"), false);
});

test("a retired generation stays alive until its lease is released", async () => {
  await initMcpServers("ollama", "");
  const lease = acquireMcpSession("ollama");
  const generation = lease.id;

  // Reconfiguring replaces the active generation.
  await initMcpServers("ollama", "");
  const current = getMcpSession("ollama");
  assert.notEqual(current.id, generation, "a new generation should be active");

  // The captured one is retired but not closed: the request still owns it.
  assert.equal(lease.draining, true);
  assert.equal(lease.closed, false);

  await releaseMcpSession(lease);
  assert.equal(lease.closed, true, "releasing the last lease should close it");
  // The active generation is untouched.
  assert.equal(getMcpSession("ollama").closed, false);
});

test("two leases on one generation both have to be released", async () => {
  await initMcpServers("cloud", "");
  const a = acquireMcpSession("cloud");
  const b = acquireMcpSession("cloud");
  assert.equal(a, b, "leases on the same generation share the session");

  await initMcpServers("cloud", "");
  assert.equal(a.closed, false);

  await releaseMcpSession(a);
  assert.equal(a.closed, false, "still one lease outstanding");
  await releaseMcpSession(b);
  assert.equal(a.closed, true);
});

test("invalid configuration leaves the running generation in place", async () => {
  await initMcpServers("lmstudio", "");
  const before = getMcpSession("lmstudio").id;

  const statuses = await initMcpServers("lmstudio", "{ not json");
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].ok, false);
  assert.match(statuses[0].error, /Invalid JSON/);
  assert.equal(
    getMcpSession("lmstudio").id,
    before,
    "a broken config must not tear down working servers",
  );
});

test("a tool call names the mode whose servers are missing", async () => {
  await initMcpServers("llamacpp", "");
  const session = getMcpSession("llamacpp");
  const result = await executeMcpTool(
    { function: { name: "mcp__nosuch__tool", arguments: "{}" } },
    { mode: "llamacpp", session },
  );
  assert.match(result, /not active for llamacpp/);

  const malformed = await executeMcpTool(
    { function: { name: "not_an_mcp_name", arguments: "{}" } },
    { mode: "llamacpp", session },
  );
  assert.match(malformed, /Invalid MCP tool name/);
});

test("stopMcpServers clears a mode without touching the others", async () => {
  await initMcpServers("ollama", "");
  await initMcpServers("cloud", "");
  const cloudBefore = getMcpSession("cloud").id;

  await stopMcpServers("ollama");
  assert.equal(getMcpOllamaTools("ollama").length, 0);
  assert.equal(
    getMcpSession("cloud").id,
    cloudBefore,
    "stopping one mode must not disturb another",
  );
});

test("an unknown mode is rejected rather than given its own bucket", () => {
  assert.throws(() => acquireMcpSession("pi"), /mode must be one of/);
  assert.throws(() => getMcpSession("nonsense"), /mode must be one of/);
});
