# Pi integration

Pi is a separate agent, not a model backend. Dive spawns `pi --mode rpc` and
speaks JSONL over stdin and stdout. Pi brings its own tools, its own permission
system and its own session files; Dive is a client.

Nothing in this document applies to the other four modes, and nothing about
Dive's skills applies to Pi.

## Process model

One Pi process per conversation, keyed by conversation id. Each carries its
session id, session file, active request, queued prompts and pending RPC
commands. Records over 4 MB (`MAX_PI_RPC_RECORD_CHARS`) are rejected rather
than buffered without limit.

The JSONL decoder handles UTF-8 split across chunk boundaries — a multi-byte
character arriving in two reads must not corrupt the record — and throws on
malformed input instead of silently dropping it.

## Settings

Stored in `pi-settings.json`:

| Setting              | Default                     | Notes                                  |
| -------------------- | --------------------------- | -------------------------------------- |
| `commandPath`        | `""` (resolve `pi` on PATH) | Validated before use                   |
| `workingDirectory`   | `DATA_DIR`                  | Confined to home or the data directory |
| `timeoutMs`          | 5 minutes                   | Session timeout                        |
| `permissionPolicy`   | `"normal"`                  | How tool permissions are handled       |
| `toolOutputMaxChars` | 12000                       | Truncation limit for tool output       |

`commandPath` and `workingDirectory` go through
[`pi-paths.js`](../pi-paths.js). Two properties there are load-bearing:

- Sanitisation is **idempotent**. It keeps the path you supplied rather than its
  realpath. Storing the resolved path meant a symlinked install
  (`.../dist/cli.js`) failed re-validation on the next start and the setting
  silently blanked itself.
- A rejected path explains **why**, rather than quietly becoming empty.

## Streaming and the event channel

`/api/pi/stream` streams a turn as NDJSON, like the other modes.

`/api/pi/events` is different: an SSE channel that lets the interface **reattach**
to a run it was not watching — after a reload, a mode switch, or a dropped
connection.

Each conversation has a bounded replay buffer: 256 events or 4 MB, whichever
comes first (`PI_EVENT_BUFFER_SIZE`, `PI_EVENT_BUFFER_MAX_BYTES`), across at most
256 channels (`PI_EVENT_CHANNEL_MAX`). Every event is capped at 256 KB before
buffering, so one oversized event cannot evict the whole buffer.

Reconnect with `?after=<sequence>` or the `Last-Event-ID` header; the server
replays only what you have not seen. If your resume point has already been
evicted, you get a `replay_gap` event and the client refetches the conversation
rather than leaving a hole it will never notice.

A client that is fully caught up gets **no** gap event — a false gap would make
the interface refetch everything on every reconnect.

## Stopping

Stop must behave like Esc in the Pi terminal. Dive sends three RPC commands in
order:

1. `abort_bash` — stop a running shell command
2. `abort_retry` — stop a provider retry loop
3. `abort` — stop the agent

Sub-activities first, agent last. All four stop paths use the same routine, so
they cannot drift apart.

## The sandbox

Pi's sandbox is Pi's, not Dive's. `pi-sandbox` reads its global policy from
`~/.pi/agent/sandbox.json` and its project policy from `<cwd>/.pi/sandbox.json`.

Dive reads the same files to show you an accurate indicator. Two details worth
knowing:

- The path is `~/.pi/agent/sandbox.json`. `~/.pi/sandbox.json` is **not** read by
  pi-sandbox; reporting on that file showed a sandbox that was not actually in
  force.
- The indicator honours the policy's `enabled` flag. A present-but-disabled
  policy is not an active sandbox.

`security/pi-permissions.strict.jsonc` in this repository is a sample. It is
marked inert in its header and is not loaded by anything.

## Permission prompts

When Pi asks for permission, Dive surfaces the request and posts your answer to
`/api/pi/respond`. Prompts have a decision timeout so a forgotten dialog does not
wedge a session forever.

## Attachments

Images are resolved and any drops are **reported before** the Pi process is
started, so a Pi that fails to launch cannot also swallow the news that
attachments were dropped.

## Tool-only turns

A Pi turn that runs a tool and produces no text creates **no assistant bubble**.
The activity panel carries it: a live label — `Starting Pi`, `Thinking`,
`Running web_search`, `Processing result`, `Compacting context` — an elapsed
clock, and an execution trace that persists into history.

This is deliberate. The old behaviour created an empty bubble with a pulsing
icon before the model had said anything.

## What Pi does not get

- Dive's skills (`diveSkills: false`)
- Dive's MCP servers (`requireNonPiMode` guards those routes)
- The composer skill launcher

Do not "unify" these. Pi already has tools; running two tool systems in one turn
would mean two things claiming the same turn.
