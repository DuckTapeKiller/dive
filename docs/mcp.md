# MCP servers

Dive can connect to Model Context Protocol servers and offer their tools to the
model alongside its own skills. Implemented in [`mcp.js`](../mcp.js).

**Not available in Pi mode.** Pi has its own tool system; `requireNonPiMode`
guards these routes.

## Configuration

Through `/api/mcp/config`. Server definitions are installed **globally**, but
every running client belongs to exactly one mode. Enabling a server for Cloud
does not start it for llama.cpp.

## Sessions, leases and generations

This is the part worth understanding before changing anything.

A **session** owns the running clients for one mode. It tracks:

- `leases` — callers currently holding it
- `activeCalls` — tool calls in flight
- `draining` — retired, finishing existing work
- `closed`

Reconfiguring a mode does not tear down the running clients underneath whatever
is using them. Instead it creates a **new generation**: the old session is
retired and marked draining, while in-flight requests keep using it until their
lease and their tool calls finish. New requests get the new session.

```
acquireMcpSession(mode)   →  lease++, use it
releaseMcpSession(session) →  lease--, close if draining and idle
```

A session closes when it is draining and both `leases` and `activeCalls` reach
zero. Without this, changing a server mid-turn would pull the transport out from
under a running tool call.

`test/mcp_lease.test.js` and `test/mcp_shutdown.test.js` cover this, including
that a retired session is not closed while work is outstanding.

## Shutdown

`shutdownMcpServers()` closes every session and waits for draining ones. It has
its own deadline, and `gracefulShutdown` in `server.js` keeps a 5-second
force-exit as a backstop in case a transport wedges while closing.

The force-exit is a backstop, not the normal path. If shutdown routinely takes
5 seconds, something is not closing — that was true of the global app-event
stream until it was closed explicitly.

## Purging

`POST /api/mcp/purge` drops sessions without changing configuration. Useful when
a server is misbehaving and you want it restarted on the next call.

## Failure handling

An MCP server that fails to start does not block chat. Initialisation errors are
caught and the turn proceeds without those tools — `sendMessage` wraps
`ensureMcpModeInitialised` for exactly this reason. MCP is an enhancement, not a
dependency.
