# Local Library Research

This folder contains the offline indexing and search layer for Dive.
It reads configured EPUB, TXT, and Markdown sources, builds a SQLite database
in `~/ollama-pi-chat/library.sqlite`, and can inject the most relevant passages
into Ollama chats when Local Library Research is enabled in settings. The
default Books source indexes Calibre EPUB files only; note folders can still
index `.md` and `.txt` files.

Passage text is stored compressed. Semantic vector search is the recommended
default for large libraries. Keyword FTS5 is optional because it adds a separate
keyword index and increases database size.

## Source Safety

The indexer only reads source files. It does not edit, convert, rename, or
delete files in your books or notes folders. EPUBs are opened read-only and
parsed in memory. All generated data is written under `~/ollama-pi-chat/`.
Interrupted index jobs are recorded in `~/ollama-pi-chat/library-index-job.json`
so the desktop app can resume a running job after reopening. Pressing Pause in
the app marks the job as paused and prevents automatic resume.
Embedding failures, skipped documents, and file-level index errors are written
to `~/ollama-pi-chat/library-index-errors.jsonl` for later inspection.

## Setup

1. Keep DRM-free EPUB books in your normal books folder, for example `~/Libros`.
2. Open `~/ollama-pi-chat/library-config.json` after the first run and set your
   source paths. Leave any unused source path empty.
3. Run:

```bash
npm run library:index
```

Search from the terminal:

```bash
npm run library:search -- "your question"
```

Keep the index updated while you work:

```bash
npm run library:watch
```

## EPUB Handling

EPUB ingestion follows `META-INF/container.xml`, the OPF manifest, and the OPF
spine reading order. Adjacent Calibre `metadata.opf` files are used only as a
fallback for title and author metadata, never as indexed content. Cover images,
standalone metadata files, PDFs, and image assets are ignored. DRM-protected
EPUBs, image-only comics, and fixed-layout books with too little extractable
text are reported under `skippedDocuments`.

## sqlite-vec

Semantic vector search is optional but recommended for large personal libraries.
To enable it, install sqlite-vec, set `embedding.enabled` to `true`, and set
`embedding.sqliteVecExtensionPath` in `~/ollama-pi-chat/library-config.json`.
The indexer stores embeddings with your configured Ollama embedding model and
uses sqlite-vec when the extension is available.

Keyword FTS5 can be enabled with `search.keywordEnabled`, but it is off by
default to keep the index compact.

## Chat Integration

In Ollama settings, enable Local Library Research. Each Ollama prompt will search
the local database, select a small number of relevant passages, and insert them
as a temporary system context for that request.
