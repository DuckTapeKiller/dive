# Bundled SQLite command-line shell

- Project: SQLite — https://sqlite.org
- Version: 3.53.3 (official precompiled binary,
  sqlite-tools-osx-arm64-3530300.zip from sqlite.org)
- License: public domain (https://sqlite.org/copyright.html)
- Artifact: `darwin-arm64/sqlite3` — arm64, links only macOS system
  libraries, compiled WITH runtime loadable-extension support.

Dive uses this shell to build and query the local library index (including
loading the bundled sqlite-vec extension). Detection order: the SQLITE3_PATH
environment variable, then this bundled binary, then Homebrew/system
installations.
