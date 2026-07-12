# Bundled sqlite-vec extension

- Project: sqlite-vec — https://github.com/asg017/sqlite-vec
- Version: v0.1.9 (stable)
- Author: Alex Garcia
- License: dual-licensed MIT OR Apache-2.0 (see the project repository:
  LICENSE-MIT and LICENSE-APACHE)
- Artifact: `darwin-arm64/vec0.dylib` — the official loadable extension for
  macOS arm64 (identical to the `loadable-macos-aarch64` release artifact).

Dive loads this extension into an extension-capable sqlite3 CLI to provide
vector search for the local library index. Users may override the path in
Settings → Database (sqliteVecExtensionPath); when that field is empty or the
configured file is missing, this bundled copy is used.
