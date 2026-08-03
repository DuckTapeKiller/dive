# Architecture

## Three processes

```
┌─────────────────────────────────────────────────────────┐
│ Electron main            electron/main.js               │
│  · syncs the runtime directory                          │
│  · starts (or adopts) the Node server                   │
│  · installs a LaunchAgent on macOS                      │
│  · opens a BrowserWindow at http://127.0.0.1:<port>     │
└───────────────┬─────────────────────────────────────────┘
                │ spawns
┌───────────────▼─────────────────────────────────────────┐
│ Node HTTP server         server.js                      │
│  · serves index.html, assets/, fonts/                   │
│  · owns conversations, settings, attachments            │
│  · delegates to route modules per domain                │
│  · talks to model backends; executes skills             │
└───────────────┬─────────────────────────────────────────┘
                │ HTTP + NDJSON / SSE
┌───────────────▼─────────────────────────────────────────┐
│ Renderer                 index.html + assets/js/*.js    │
│  · classic <script> tags, one shared global scope       │
│  · no bundler, no module system                         │
└─────────────────────────────────────────────────────────┘
```

The server binds `127.0.0.1` only ([server.js:3058](../server.js)) — it is never
reachable from the network. Default port 8080 (`DEFAULT_PORT`, overridable with
the `PORT` environment variable).

## The runtime directory

This trips people up, so it is worth understanding.

The packaged application does not run its own files directly. On every start,
`syncRuntimeFiles()` ([electron/main.js:140](../electron/main.js)) copies the
server, assets, skills and supporting modules out of the app bundle into:

```
~/Library/Application Support/dive-desktop/runtime/
```

The server then runs from _there_. The copy uses `force: true`, so it overwrites
on every launch and cannot drift from the bundle.

The consequence: **editing the repository does not change a running packaged
app.** The chain is repository → build → app bundle → runtime sync → running
renderer. A stale build shows stale behaviour even though the source is correct.
If you are debugging something that "should be fixed", check the runtime copy:

```bash
grep -c "theThingYouFixed" \
  ~/Library/Application\ Support/dive-desktop/runtime/assets/js/03-theme.js
```

On macOS the app also installs a LaunchAgent (`installOrRefreshLaunchAgent`) so
the server survives independently of the window.

## Module map

### Server core

| File                | Responsibility                                                  |
| ------------------- | --------------------------------------------------------------- |
| `server.js`         | HTTP entry, routing, conversations, attachments, settings       |
| `data-dir.js`       | The single definition of `DATA_DIR`; honours `DIVE_DATA_DIR`    |
| `mode-state.js`     | Per-mode helpers, including `requireNonPiMode`                  |
| `redact.js`         | `redactText`, `redactValue`, `boundedValue` for logs and traces |
| `pi-paths.js`       | Validates the Pi command path and working directory             |
| `slash_commands.js` | Slash command table and forced-skill construction               |
| `skills.js`         | Skill registry, dispatch, argument handling                     |
| `plugins.js`        | Plugin discovery and loading                                    |
| `mcp.js`            | MCP client sessions, leases, generations                        |

### Route modules (`routes/`)

`chat.js` (Ollama, LM Studio, llama.cpp, Cloud streaming), `pi.js` (the Pi
bridge and its SSE channel), `library.js`, `llamacpp.js`,
`llamacpp-preset.js`, `skills.js`, `settings.js`, `web-sources.js`, and others.
Each exports a factory that takes its dependencies, which is what makes them
testable without a live server.

### Skills (`skills/`)

`research.js`, `research-quality.js`, `code.js`, `sandbox.js`, `meta.js`,
`utility.js`. See [skills.md](skills.md).

### Server helpers (`server/`)

`cloud.js` (provider settings, request building, streaming) and `trace.js`.

### Frontend (`assets/js/`)

Loaded in numeric order by `index.html` into **one global scope**:

| File                 | Lines | Responsibility                                       |
| -------------------- | ----- | ---------------------------------------------------- |
| `00-modes.js`        | 103   | The mode registry — the only list of modes           |
| `01-core.js`         | 1,293 | State, per-mode skill config, shared helpers         |
| `02-notes.js`        | 822   | Notes panel                                          |
| `03-theme.js`        | 3,833 | Theme, `setMode`/`renderMode`, stream readers        |
| `04-local-models.js` | 1,771 | llama.cpp and LM Studio management                   |
| `05-history.js`      | 4,718 | Message rendering, history, thinking panel, settings |
| `06-pi.js`           | 620   | Pi event channel client                              |
| `07-chat.js`         | 3,140 | Composer, sending, queueing, abort                   |

There is no bundler and no `import`. Every top-level `function` is global;
top-level `const` and `let` are _not_ attached to `window`, which matters when
writing tests.

Because a bundler cannot check this arrangement, `scripts/lint-frontend.js`
concatenates the files in load order and lints the result as one program. It
catches undefined references across files that per-file linting cannot see.

## How a message travels

1. `sendMessage()` in `07-chat.js` reads the composer and the active mode.
2. A `thinking` panel is created immediately, showing `Working...` and a live
   phase label.
3. The mode's branch calls its endpoint — `/api/chat/stream`,
   `/api/llamacpp/stream`, `/api/lmstudio/stream`, `/api/cloud/chat/stream`, or
   `/api/pi/stream`.
4. The server builds the prompt, adds skills if the mode has them, adds library
   context if enabled, and streams from the backend.
5. If the model calls a skill, the server executes it, emits `tool_start` and
   `tool_end`, feeds the result back, and continues.
6. The response streams to the client as NDJSON, one JSON object per line.
7. On `done`, the conversation is written to disk — unless it was deleted
   mid-turn, which the tombstone check prevents from resurrecting it.

## Streaming formats

Two different formats, deliberately:

- **NDJSON** for chat responses. One JSON object per line, over a normal POST
  response. Events include `delta`, `thinking_delta`, `tool_start`, `tool_end`,
  `library_results`, `library_error`, `attachment_notice`, `done`, `error`.
- **SSE** for the two long-lived channels: `/api/events/global` (app-wide events)
  and `/api/pi/events` (reattaching to a Pi run). SSE is used here because it
  survives disconnection and supports resume via `Last-Event-ID`.

## Abort

Stop must stop the _work_, not just the rendering. Each mode wires its own
client-disconnect hook, and all of them hang off the **response**:

```js
res.on("close", () => {
  if (!finished) abortController.abort();
});
```

Not `req`. In current Node, the request's `close` fires when the request body
finishes, which is long before the user presses Stop — using it silently
disabled the abort and let generation run to completion. Pi additionally sends
real `abort_bash`, `abort_retry` and `abort` RPC commands, in that order, so
sub-activities stop before the agent does.
