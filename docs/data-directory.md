# Data directory and settings

Everything Dive keeps lives in one directory, `~/dive` by default. It is defined
in exactly one place, [`data-dir.js`](../data-dir.js), and overridden with the
`DIVE_DATA_DIR` environment variable:

```bash
DIVE_DATA_DIR=/tmp/dive-scratch npm run dev:web
```

The override exists so tests never touch your real data. Every integration test
sets it. If you are adding a test that starts a server, set it too.

```js
const {
  DATA_DIR,
  PLUGINS_DIR,
  WORKSPACE_DIR,
  isOverridden,
} = require("./data-dir.js");
```

## Layout

```
~/dive/
├── conversations/            per-mode conversation files
├── attachments/              uploaded images, named by content hash
├── notes/                    notes panel
├── plugins/                  live plugins (loaded)
├── plugin-drafts/            proposed plugins (never loaded)
├── system-prompts/           saved system prompts
├── workspace/                skill working directory
├── llamacpp-models/          downloaded local models
├── ollama/                   Ollama-specific state
├── lessons/                  per-mode remembered lessons
│
├── conversations.json        conversation index
├── deleted-tombstones.json   deletions, 24-hour TTL
├── ui-settings.json          interface preferences
├── ollama-settings.json      Ollama base URL
├── local-model-settings.json llama.cpp and LM Studio
├── cloud-settings.json       providers, keys, base URLs
├── pi-settings.json          Pi command path, working directory, policy
├── llamacpp.json             llama.cpp runtime configuration
├── library-config.json       indexed sources and search settings
├── library-index-job.json    indexing progress
├── library-index-errors.jsonl per-file indexing failures
├── coding-settings.json      code skill settings
├── allowed-dirs.json         filesystem sandbox roots
├── sandbox.json              sandbox policy
├── book-search.json          book search providers
├── web-search-settings.json  web search backends
├── notes.json                notes index
├── prompts.json              prompt library
├── security-events.jsonl     recorded security events
└── daemon.log                server log
```

## Files worth knowing about

**`allowed-dirs.json`** — the filesystem sandbox roots. This is the file you edit
to let file skills reach a project directory. Nothing else grants that access.

**`deleted-tombstones.json`** — deleted conversation ids with timestamps. Stops a
still-running turn from resurrecting a conversation you deleted. Entries expire
after 24 hours.

**`cloud-settings.json`** — API keys in plain text, with file permissions as your
only protection. It is never sent to the client: `redactCloudSettings` strips
keys from every response.

**`plugin-drafts/`** — where `propose_plugin` writes. Not on the load path.
Approving moves a draft into `plugins/`, and only then does its code run.

## Settings by scope

**Per mode:** enabled skills, composer launcher skills, model, system prompt, MCP
servers, library search, palette, font, font scale.

**Global:** data directory, server port, cloud provider keys, Pi settings,
library sources and index, allowed directories, book and web search providers.

Per-mode settings are read through the active mode's bucket on demand rather than
copied into aliases. Aliases had to be re-pointed on every mode change, and
forgetting to do so is what left stale skill lists on screen.

## Server port

Default 8080 (`DEFAULT_PORT` in `server.js`), overridable with `PORT`. The
Electron shell reads the configured port and passes it to the LaunchAgent so the
window and the daemon agree.

## The runtime copy

The packaged application does not run from `~/dive`, and it does not run its own
bundle files directly. It copies them to:

```
~/Library/Application Support/dive-desktop/runtime/
```

and runs from there. That copy is refreshed on every launch with `force: true`,
so it cannot drift from the bundle — but it _will_ faithfully reproduce a stale
bundle. If a fix is in the repository and the app still misbehaves, rebuild.
See [architecture.md](architecture.md).

## Backups

`~/dive` is the whole application state. Copy it and you have copied everything:
conversations, settings, notes, keys and the library index. There is no hidden
state elsewhere, apart from the runtime copy, which is disposable and rebuilt on
every start.
