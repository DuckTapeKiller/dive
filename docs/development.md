# Development

## Requirements

Node.js (the project runs on Node 26), npm, and a model backend for whichever
mode you want to exercise. Pi mode additionally needs `pi` on your PATH.

```bash
npm install
```

## Running from source

```bash
npm run dev:web     # server only, at http://127.0.0.1:8080
npm run dev:app     # the Electron shell
```

`dev:web` is usually what you want. The interface is a plain page — open it in a
browser, use devtools, reload freely. The Electron shell adds the window, the
runtime sync and the LaunchAgent, none of which help while iterating.

Use a scratch data directory so you never touch your real one:

```bash
DIVE_DATA_DIR=/tmp/dive-dev npm run dev:web
```

## Scripts

| Script                   | Purpose                                       |
| ------------------------ | --------------------------------------------- |
| `npm test`               | The full suite — `node --test test/*.test.js` |
| `npm run lint`           | ESLint, then the whole-program frontend lint  |
| `npm run lint:frontend`  | Frontend lint alone                           |
| `npm run format`         | Prettier over everything                      |
| `npm run format:check`   | Verify formatting without writing             |
| `npm run bench`          | Frontend render benchmark                     |
| `npm run library:index`  | Index configured library sources              |
| `npm run library:status` | Indexing progress                             |
| `npm run library:watch`  | Reindex on change                             |
| `npm run library:search` | Query the library from the terminal           |

A Husky pre-commit hook runs Prettier and ESLint over staged files, so
formatting drift is fixed at commit time rather than argued about.

## Building

```bash
npm run build:arm64          # macOS Apple Silicon, directory output
npm run build:mac            # macOS, directory output
npm run build:universal      # macOS universal
npm run build:dmg:arm64      # macOS installer
npm run build:linux          # AppImage and deb
npm run build:win            # NSIS and portable
```

Output lands in `release/`.

**Quit Dive before building.** `electron-builder` deletes its output directory
first, which removes the bundle out from under a running instance and kills it. A
stray `.DS_Store` recreated during that delete will also fail the build with
`ENOTEMPTY`; remove it and rebuild.

### After building

The packaged app copies its files into
`~/Library/Application Support/dive-desktop/runtime/` on launch and runs from
there. Verify a change actually reached the renderer:

```bash
grep -c "yourChange" \
  ~/Library/Application\ Support/dive-desktop/runtime/assets/js/03-theme.js
```

If the source has your fix and the runtime does not, the build is stale.

### Packaging new files

Adding a top-level module or directory means updating **three** places:

1. `files` in `package.json`
2. `asarUnpack` in `package.json`
3. `syncRuntimeFiles()` in `electron/main.js`

Miss the third and the file is inside the bundle but never copied to the runtime,
so the packaged app fails at a point far from the cause.
`test/packaging.test.js` guards this — it has caught the omission three times.

## The frontend has no build step

`index.html` loads `assets/js/*.js` in numeric order as plain `<script>` tags.
There is no bundler, no modules, one shared global scope. Load order is the
dependency order.

Consequences worth internalising:

- Every top-level `function` is global.
- Top-level `const` and `let` are **not** on `window`. Tests reaching for
  `dom.window.someConst` get `undefined`; use the exported setter functions.
- A typo in a cross-file reference is a runtime error nothing would catch — which
  is why `scripts/lint-frontend.js` concatenates the files in load order and
  lints them as one program. Run it before committing frontend changes.

## Adding a mode

Edit [`assets/js/00-modes.js`](../assets/js/00-modes.js) and nothing else for the
registry itself. Add the route, the settings, and the button in `index.html`.
`test/mode_registry.test.js` checks the registry stays consistent.

## Code style

Prettier decides formatting; do not argue with it. Beyond that, the convention
that matters is comments: explain **why**, especially where the code looks
strange. Much of this codebase is shaped by a specific failure — `res.on("close")`
instead of `req.on("close")`, keeping the user's Pi path instead of its realpath,
two tombstone checks instead of one. Those comments are the reason nobody
"simplifies" the fix back into the bug.
