# HTTP API

Everything is served from `http://127.0.0.1:8080` by default. The server binds
loopback only. There is no authentication, because there is no remote access —
if you expose this port, you have given away everything below.

Request and response bodies are JSON unless noted. Streaming endpoints return
NDJSON (one JSON object per line); the two event channels return SSE.

## Chat

| Method | Path                       | Purpose                                  |
| ------ | -------------------------- | ---------------------------------------- |
| POST   | `/api/chat`                | Ollama, non-streaming                    |
| POST   | `/api/chat/stream`         | Ollama, streaming                        |
| POST   | `/api/llamacpp/stream`     | llama.cpp, streaming                     |
| POST   | `/api/lmstudio/stream`     | LM Studio, streaming                     |
| POST   | `/api/cloud/chat/stream`   | Cloud provider, streaming                |
| POST   | `/api/ollama/tool-respond` | Continue after a client-side tool result |

Common request fields:

```jsonc
{
  "message": "text of the user's turn",
  "history": [{ "role": "user", "content": "..." }],
  "model": "model-id", // not used by cloud, which reads settings
  "images": [/* attachments */],
  "saveConv": "conversation-id",
  "convTitle": "Title",
  "library": { "enabled": true },
  "nativeTools": true, // false forces the XML skill-call fallback
}
```

### Stream event types

| `type`                                               | Meaning                                                |
| ---------------------------------------------------- | ------------------------------------------------------ |
| `delta`                                              | Answer text so far, in `response`                      |
| `thinking_start` / `thinking_delta` / `thinking_end` | Reasoning trace                                        |
| `tool_start` / `tool_end`                            | A skill began or finished                              |
| `library_results`                                    | Retrieved passages and their sources                   |
| `library_error`                                      | Retrieval failed; the turn continues ungrounded        |
| `attachment_notice`                                  | Attachments were dropped; `message` says which and why |
| `web_sources`                                        | Source pills for the answer                            |
| `done`                                               | Final `response`; the turn is saved                    |
| `error`                                              | The turn failed                                        |

## Conversations

| Method | Path                        | Purpose                       |
| ------ | --------------------------- | ----------------------------- |
| GET    | `/api/conversations`        | List across all modes         |
| GET    | `/api/conversations/id/:id` | One conversation              |
| DELETE | `/api/conversations/id/:id` | Delete, and tombstone it      |
| DELETE | `/api/conversations?mode=`  | Delete a mode's conversations |

Deleting writes a **tombstone** (`deleted-tombstones.json`, 24-hour TTL). A turn
that was still generating when you deleted its conversation must not write it
back when it finishes, and the tombstone is what prevents that. There are two
tombstone checks in `upsertConversation` — removing either alone changes
nothing, which is worth knowing before you "simplify" one away.

## Attachments

| Method | Path                     | Purpose                   |
| ------ | ------------------------ | ------------------------- |
| POST   | `/api/upload`            | multipart upload          |
| GET    | `/api/attachments/:file` | Fetch a stored attachment |

Limits: 50 MB (`MAX_UPLOAD_PAYLOAD_SIZE`), enforced against the declared
`Content-Length` before a byte is read. Images are stored under a hash of their
content, never under the supplied filename — traversal in the name has nowhere
to go. Unsupported extensions are refused with 415.

A single turn carries at most 8 images (`MAX_TURN_IMAGES`). Anything beyond that,
plus anything malformed or unreadable, is reported to the client as an
`attachment_notice` rather than dropped in silence.

## Pi

| Method   | Path                          | Purpose                                             |
| -------- | ----------------------------- | --------------------------------------------------- |
| POST     | `/api/pi`                     | Non-streaming turn                                  |
| POST     | `/api/pi/stream`              | Streaming turn                                      |
| GET      | `/api/pi/events?conv=&after=` | SSE channel; resume with `after` or `Last-Event-ID` |
| POST     | `/api/pi/command`             | Send an RPC command (including `abort`)             |
| POST     | `/api/pi/respond`             | Answer a permission prompt                          |
| GET      | `/api/pi/status`              | Process and session state                           |
| GET      | `/api/pi/stats`               | Cost and context usage                              |
| GET/POST | `/api/pi/settings`            | Pi settings                                         |
| POST     | `/api/pi/settings/reset`      | Restore defaults                                    |
| POST     | `/api/pi/new-session`         | Start a fresh Pi session                            |
| POST     | `/api/pi/load-session`        | Load an existing session file                       |
| POST     | `/api/pi/start`               | Start the Pi process                                |
| POST     | `/api/pi/open-project-folder` | Reveal the working directory                        |

`/api/pi` and `/api/pi/stream` report a failed library lookup the same way: the
streaming route as a `library_error` event, the non-streaming route as a
`libraryError` field. An explicit `/db` request that cannot reach the library
returns **502** rather than an ungrounded answer that looks grounded.

## Skills and plugins

| Method   | Path                                | Purpose                                         |
| -------- | ----------------------------------- | ----------------------------------------------- |
| GET/POST | `/api/ollama/skills/settings?mode=` | Per-mode skill config (all modes use this path) |
| GET/POST | `/api/custom-skills`                | User-defined skills                             |
| GET      | `/api/plugins`                      | Installed plugins                               |
| POST     | `/api/plugins/reload`               | Reload from disk                                |
| GET      | `/api/plugins/drafts`               | Drafts proposed by a model                      |
| POST     | `/api/plugins/drafts/approve`       | Approve a draft into the live directory         |
| POST     | `/api/plugins/drafts/delete`        | Discard a draft                                 |

The skills settings path is `/api/ollama/skills/settings` for _every_ mode; the
mode is a query parameter. The name is historical.

`inputSkills` on that endpoint controls which skills appear as composer buttons.
Only names on a fixed allowlist are accepted, and only with the value `true`.
`shell_command`, `file_operations` and `propose_plugin` are deliberately not on
it.

## Library

| Method   | Path                                | Purpose                      |
| -------- | ----------------------------------- | ---------------------------- |
| GET/POST | `/api/library/settings`             | Per-mode search settings     |
| GET/POST | `/api/library/config`               | Indexed folders and options  |
| POST     | `/api/library/index`                | Start indexing               |
| POST     | `/api/library/index/cancel`         | Cancel a running index       |
| GET      | `/api/library/index/errors`         | Per-file failures            |
| GET      | `/api/library/status`               | Progress                     |
| POST     | `/api/library/search`               | Query the index              |
| POST     | `/api/library/preflight`            | Check before indexing        |
| POST     | `/api/library/estimate`             | Estimate size and time       |
| GET      | `/api/library/embedding-check`      | Verify the embedding backend |
| POST     | `/api/library/files/search`         | Find indexed files           |
| GET      | `/api/library/export-indexed-files` | Export the file list         |

## Models and settings

| Method   | Path                                           | Purpose                              |
| -------- | ---------------------------------------------- | ------------------------------------ |
| GET      | `/api/models`                                  | Available models for the active mode |
| GET      | `/api/models/info`                             | Model metadata                       |
| GET      | `/api/lmstudio/models`, `/api/llamacpp/models` | Per-backend lists                    |
| ALL      | `/api/llamacpp/manager/*`                      | Download and run local models        |
| GET/POST | `/api/ollama/settings`                         | Ollama base URL                      |
| GET/POST | `/api/local-models/settings`                   | llama.cpp and LM Studio              |
| GET/POST | `/api/cloud/settings`                          | Providers, keys, base URLs           |
| GET/POST | `/api/ui/settings`                             | Interface preferences                |
| GET/POST | `/api/prompts`, `/api/system-prompts`          | Prompt library                       |
| GET/POST | `/api/mcp/config`                              | MCP servers                          |
| POST     | `/api/mcp/purge`                               | Drop MCP sessions                    |
| GET/POST | `/api/book-search/config`                      | Book search providers                |
| GET      | `/api/lessons`                                 | Remembered lessons                   |

Cloud settings are returned redacted — keys are never sent back to the client.

## Notes and media

| Method   | Path                                      | Purpose          |
| -------- | ----------------------------------------- | ---------------- |
| GET/POST | `/api/notes`                              | Notes content    |
| POST     | `/api/notes/create`, `/rename`, `/delete` | Manage notes     |
| GET      | `/api/notes/list`                         | List notes       |
| GET      | `/api/media/downloads`                    | Downloaded media |

## System

| Method | Path                  | Purpose                 |
| ------ | --------------------- | ----------------------- |
| GET    | `/api/version`        | Application version     |
| GET    | `/api/events/global`  | SSE: app-wide events    |
| GET    | `/api/health/logs`    | Recent log output       |
| POST   | `/api/security-event` | Record a security event |

`/api/events/global` is a long-lived SSE stream with a 15-second heartbeat. It is
closed explicitly during shutdown — without that, `server.close()` waits forever
on it and the process falls through to a 5-second force-exit with a non-zero
status.
