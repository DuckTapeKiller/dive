PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS library_files (
  id INTEGER PRIMARY KEY,
  source_name TEXT NOT NULL,
  source_type TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  title TEXT,
  author TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  mtime_ms INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL DEFAULT '',
  index_signature TEXT NOT NULL DEFAULT '',
  indexed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  chunk_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS library_chunks (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES library_files(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  heading TEXT,
  text TEXT DEFAULT '',
  text_compressed BLOB,
  text_encoding TEXT NOT NULL DEFAULT 'plain',
  text_size INTEGER NOT NULL DEFAULT 0,
  token_estimate INTEGER NOT NULL DEFAULT 0,
  start_line INTEGER,
  end_line INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(file_id, chunk_index)
);

DROP TRIGGER IF EXISTS library_chunks_ai;
DROP TRIGGER IF EXISTS library_chunks_ad;
DROP TRIGGER IF EXISTS library_chunks_au;
DROP VIEW IF EXISTS library_chunks_fts_source;

CREATE TABLE IF NOT EXISTS library_embeddings (
  chunk_id INTEGER PRIMARY KEY REFERENCES library_chunks(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS library_vector_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS library_files_path_idx ON library_files(path);
CREATE INDEX IF NOT EXISTS library_chunks_file_idx ON library_chunks(file_id, chunk_index);
CREATE INDEX IF NOT EXISTS library_embeddings_model_idx ON library_embeddings(model);
