# The library

Dive can index your own documents and use them to ground answers. Everything
stays on your machine: the index is a local SQLite database, and the embedding
backend is whichever local or cloud model you have configured.

Implemented in [`library/`](../library) — `store.js` (index and search),
`indexer.js` (the crawl), `epub.js` (EPUB extraction), `search.js` (CLI).

## What gets indexed

You configure source folders, each with a type and an extension filter. EPUB and
plain text are the primary formats; HTML is handled inside EPUB containers.

Configuration lives in `library-config.json`. Indexing state and per-file errors
are recorded separately so a failed file is visible rather than silently absent:

- `library-index-job.json` — progress of the current or last run
- `library-index-errors.jsonl` — one line per file that failed

## Storage

A SQLite database with the official `sqlite-vec` extension, shipped per platform
(`vec0.dylib`, `vec0.so`, `vec0.dll`). Vectors live alongside the text, so there
is no external vector service and nothing to run.

Documents are split into chunks before embedding, capped at
`EMBEDDING_DOCUMENT_MAX_CHARS` (1200) per embedded unit. Embedding failures are
retried three times with backoff (`EMBEDDING_RETRY_ATTEMPTS`).

Chunking parameters are configurable, and old saved configs carrying superseded
defaults are migrated rather than honoured — see `normalizeChatIntegration` in
`store.js`.

## Using it in chat

Two ways, and they are treated differently on failure.

**Ambient context.** Turn library search on for a mode. Relevant passages are
retrieved and added to the prompt automatically. This is best-effort: if
retrieval fails, the turn still runs and the response reports `libraryError`.

**`/db`.** Forces database-only retrieval. Because you asked for it by name, a
failure is a failure — `/api/pi` returns **502** rather than answering from the
model's own knowledge. An ungrounded answer that looks grounded is worse than an
error.

Retrieved passages are shown as source pills on the answer and survive a reload.

## Settings

Per mode, so Cloud can search your library while llama.cpp does not. Configured
through `/api/library/settings`; search behaviour and limits through
`/api/library/config`.

Passage count and context size are clamped server-side — a client cannot ask for
an unbounded amount of context.

## Indexing workflow

| Step                                 | Endpoint                           |
| ------------------------------------ | ---------------------------------- |
| Check the setup before committing    | `POST /api/library/preflight`      |
| Estimate size and time               | `POST /api/library/estimate`       |
| Verify the embedding backend answers | `GET /api/library/embedding-check` |
| Start                                | `POST /api/library/index`          |
| Watch progress                       | `GET /api/library/status`          |
| Inspect failures                     | `GET /api/library/index/errors`    |
| Cancel                               | `POST /api/library/index/cancel`   |

Indexing is resumable. Cancelling does not discard what has already been
embedded.

## Command line

```bash
npm run library:index     # index configured sources
npm run library:status    # show progress
npm run library:watch     # watch for changes and reindex
npm run library:search    # query from the terminal
```

Useful for indexing a large collection without keeping the window open.

## Privacy

The index never leaves your machine. The one thing that does leave is whatever
your **embedding backend** sees — if you have configured a cloud embedding model,
the chunks being embedded are sent to that provider. Use a local embedding model
if that matters to you.
