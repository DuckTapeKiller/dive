# Modes

Dive has five chat modes. They are defined in exactly one place —
[`assets/js/00-modes.js`](../assets/js/00-modes.js) — and everything else derives
from that registry. If you are adding a mode, that file is the only list to
change.

| Mode      | id         | Backend                         | Dive skills | Enabled by default |
| --------- | ---------- | ------------------------------- | ----------- | ------------------ |
| llama.cpp | `llamacpp` | Local server, OpenAI-compatible | yes         | yes                |
| Pi        | `pi`       | External `pi` agent over RPC    | **no**      | yes                |
| Cloud     | `cloud`    | OpenAI or Anthropic             | yes         | yes                |
| LM Studio | `lmstudio` | Local server, OpenAI-compatible | yes         | no                 |
| Ollama    | `ollama`   | Local Ollama, NDJSON            | yes         | no                 |

Two orderings exist and they are not the same:

- `MODE_DEFS` is **display** order (the topbar): llama.cpp, Pi, Cloud, LM Studio,
  Ollama.
- `MODE_IDS` is **canonical** order, used for storage and iteration.

Do not use one where the other is meant.

## What is isolated per mode

Nearly everything. Each mode keeps its own:

- conversation history and current conversation
- model selection and system prompt
- enabled skills, and which skills appear in the composer
- MCP servers and their status
- library search settings
- palette, font and font scale
- message queue

State lives in `modeSession[mode]` and the various `*ByMode` maps. A handful of
module-level globals (`history`, `currentConvId`, `lastUserMessage`,
`lastSentMessage`) hold the _active_ mode's copy and are synchronised by hand:
`syncCurrentSessionState()` pushes globals into the session, `setMode()` pulls
them back out. This is the one place where drift is possible, and
`test/mode_switch_lifecycle.test.js` exists to prove it does not happen.

## Pi is different

Pi is not a model backend Dive drives. It is a separate agent process with its
own tools, its own permission system and its own session files. Dive is a client.

That means:

- **Pi does not get Dive's skills.** `diveSkills: false`. It has its own.
- **Pi does not get Dive's MCP servers.** `requireNonPiMode` guards those routes.
- **The composer skill launcher never appears in Pi.** `renderComposerSkillButtons`
  clears the bar when the mode is not a Dive-skills mode.
- Pi has its own settings, its own sandbox policy, and its own status panel.

This asymmetry is deliberate. Making Pi "uniform" with the other modes would mean
running two competing tool systems in one turn.

## Backend details

### llama.cpp (`llamacpp`)

Local server speaking the OpenAI streaming format on `/chat/completions`. Dive
can also manage models and presets — see `routes/llamacpp.js` and
`routes/llamacpp-preset.js`. Configure the base URL under local-model settings.

### LM Studio (`lmstudio`)

Same wire format as llama.cpp. Differs in one respect: LM Studio loads a model
before it can answer, so Dive calls `/api/v0/models` and `/api/v1/models/load`
first. That preamble is why the abort tests in `test/stream_endpoints.test.js`
take care to hang the _chat_ call and not the load call.

### Ollama (`ollama`)

Native Ollama API at `/api/chat`, streaming NDJSON rather than SSE. Base URL is
set through `/api/ollama/settings`.

### Cloud (`cloud`)

OpenAI or Anthropic. Keys and per-provider base URLs are stored in
`cloud-settings.json`. The base URL is configurable per provider, which is what
lets the test suite point Cloud at a local mock instead of a real API.

### Pi (`pi`)

An external `pi --mode rpc` process, one per conversation, communicating in JSONL
over stdin and stdout. See [pi.md](pi.md).

## Skills and tool calling

Modes with `diveSkills: true` offer Dive's skills to the model two ways:

- **Native tool calling** where the backend supports it.
- **XML fallback** otherwise: the model emits
  `<call:calculator>{"expression": "6*7"}</call>`, the server executes it,
  strips the markup from what the user sees, and feeds the result back for a
  second turn.

The XML form never reaches the transcript. `stripSkillCallsForDisplay` removes
it, and a turn that is only a tool call produces no assistant bubble at all —
the activity is shown by the thinking panel instead.
