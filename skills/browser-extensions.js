"use strict";

// Browser extensions for the agent browser.
//
// WHY THIS IS A SEPARATE MECHANISM FROM THE FILTER LISTS
//
// The browser already blocks ads and consent walls using uBlock Origin's own
// filter lists, applied in-process. That covers the common case and costs
// nothing. This module is for the case it cannot cover: running a real
// extension, chosen by the user.
//
// Three facts shape everything here, and each was verified against the engine
// actually shipped rather than assumed:
//
//   1. Playwright's default headless build is `chromium_headless_shell`, and it
//      CANNOT LOAD EXTENSIONS AT ALL. The full Chromium build can, in headless
//      mode, via `channel: "chromium"`. Measured: probe extension "not loaded"
//      on the shell, "LOADED" on the full build.
//   2. Extensions load only through `launchPersistentContext`, which needs a
//      profile directory on disk. A session with extensions is therefore a
//      different kind of session from an ephemeral one — it has a home.
//   3. Chromium 153 has no Manifest V2. uBlock Origin CLASSIC CANNOT RUN, now
//      or ever, in this engine. uBlock Origin Lite is the MV3 build and is what
//      "install uBlock" means here. Anything else offered under that name would
//      be a lie to the user.
//
// Extensions are unpacked third-party code running inside the browser the agent
// drives. Nothing is installed on its own: an install is an explicit act, the
// download is pinned to a release asset from the project's own repository, and
// the model is never given a way to trigger one.

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const yauzl = require("yauzl");

const EXTENSIONS_DIRNAME = "browser-extensions";
const CONFIG_FILENAME = "browser-extensions.json";
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

// The catalogue Dive offers to install. Deliberately tiny and specific: an
// arbitrary "install any URL" field would let a mistyped address put unreviewed
// code in the browser.
const CATALOGUE = {
  ublock_lite: {
    id: "ublock_lite",
    name: "uBlock Origin Lite",
    // Said plainly because the difference matters and is easy to get wrong.
    summary:
      "The Manifest V3 build of uBlock Origin. The classic MV2 extension cannot run in this engine — Chromium removed Manifest V2 — so Lite is what is available.",
    homepage: "https://github.com/uBlockOrigin/uBOL-home",
    releasesApi:
      "https://api.github.com/repos/uBlockOrigin/uBOL-home/releases/latest",
    // The Chromium build, not edge/firefox/safari.
    assetPattern: /^uBOLite_.*\.chromium\.zip$/,
  },
};

// A manifest name can be an i18n key ("__MSG_extName__") rather than a name.
// Shown raw it reads as a bug, so it is resolved from the extension's own
// English messages, falling back to what the catalogue calls it.
function resolveName(dir, rawName, fallback) {
  const name = String(rawName || "");
  const key = name.match(/^__MSG_(.+)__$/);
  if (!key) return name || fallback;
  for (const locale of ["en", "en_US", "en_GB"]) {
    try {
      const messages = JSON.parse(
        fs.readFileSync(
          path.join(dir, "_locales", locale, "messages.json"),
          "utf8",
        ),
      );
      const message = messages?.[key[1]]?.message;
      if (message) return message;
    } catch {
      // Try the next locale; a missing translation is not an error here.
    }
  }
  return fallback || name;
}

// Chrome derives the id of an UNPACKED extension from the absolute path it was
// loaded from: SHA-256 of the path, first 16 bytes, hex digits 0-f mapped onto
// a-p. Knowing it without asking the browser is what lets Dive build the URL of
// an extension's own settings page — chrome-extension://<id>/dashboard.html —
// which is the only way to actually configure something like uBlock. Verified
// against a running instance: computed and observed ids matched exactly.
function unpackedExtensionId(dir) {
  return crypto
    .createHash("sha256")
    .update(path.resolve(dir), "utf8")
    .digest("hex")
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
}

// The pages an extension exposes for a person to interact with. Without these
// an "extension manager" can only switch a black box on and off, which is not
// managing anything.
function extensionPages(dir, manifest) {
  // Deliberately NOT called `id`: an entry's `id` is its directory name, which
  // is what the enabled list is keyed by. Spreading a second `id` in here
  // silently overwrote it and switched every extension off.
  const extensionId = unpackedExtensionId(dir);
  const options =
    manifest?.options_page ||
    manifest?.options_ui?.page ||
    (fs.existsSync(path.join(dir, "dashboard.html")) ? "dashboard.html" : "");
  const popup = manifest?.action?.default_popup || "";
  const url = (page) =>
    page ? `chrome-extension://${extensionId}/${page}` : "";
  return { extensionId, optionsUrl: url(options), popupUrl: url(popup) };
}

function extensionsRoot(dataDir) {
  return path.join(dataDir, EXTENSIONS_DIRNAME);
}

function configPath(dataDir) {
  return path.join(dataDir, CONFIG_FILENAME);
}

function loadConfig(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(dataDir), "utf8"));
    const enabled = Array.isArray(raw?.enabled) ? raw.enabled : [];
    return { enabled: enabled.filter((id) => typeof id === "string") };
  } catch {
    return { enabled: [] };
  }
}

function saveConfig(dataDir, config) {
  fs.mkdirSync(path.dirname(configPath(dataDir)), { recursive: true });
  fs.writeFileSync(configPath(dataDir), JSON.stringify(config, null, 2));
}

// An extension is "installed" when its unpacked directory holds a manifest.
function readInstalled(dataDir) {
  const root = extensionsRoot(dataDir);
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    let manifest = null;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json")));
    } catch {
      // A directory without a readable manifest is a half-finished install.
      // Listed anyway, so it can be removed rather than sitting there unseen.
    }
    out.push({
      id: entry.name,
      dir,
      name: resolveName(
        dir,
        manifest?.name,
        CATALOGUE[entry.name]?.name || entry.name,
      ),
      version: manifest?.version || "",
      manifestVersion: manifest?.manifest_version || 0,
      valid: Boolean(manifest),
      catalogue: Boolean(CATALOGUE[entry.name]),
      summary: CATALOGUE[entry.name]?.summary || "",
      ...extensionPages(dir, manifest),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function listExtensions(dataDir) {
  const installed = readInstalled(dataDir);
  const { enabled } = loadConfig(dataDir);
  return {
    // What the browser will actually load: installed, valid, and switched on.
    extensions: installed.map((e) => ({
      ...e,
      enabled: enabled.includes(e.id) && e.valid,
    })),
    available: Object.values(CATALOGUE)
      .filter((c) => !installed.some((e) => e.id === c.id))
      .map(({ id, name, summary, homepage }) => ({
        id,
        name,
        summary,
        homepage,
      })),
  };
}

// The `--load-extension` paths for a launch, or [] when nothing is enabled.
function enabledExtensionPaths(dataDir) {
  const { enabled } = loadConfig(dataDir);
  return readInstalled(dataDir)
    .filter((e) => e.valid && enabled.includes(e.id))
    .map((e) => e.dir);
}

function setEnabled(dataDir, id, on) {
  const config = loadConfig(dataDir);
  const has = config.enabled.includes(id);
  if (on && !has) config.enabled.push(id);
  if (!on && has) config.enabled = config.enabled.filter((x) => x !== id);
  saveConfig(dataDir, config);
  return listExtensions(dataDir);
}

// ---- Installing ----

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Dive-Browser/1.0", Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return await res.json();
}

// Unzip into a directory, refusing any entry whose path escapes it. A crafted
// archive with "../" in its names is the classic way an unpack becomes an
// arbitrary write.
function unzipTo(archivePath, targetDir) {
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true }, (openError, zipfile) => {
      if (openError) return reject(openError);
      const root = path.resolve(targetDir);
      zipfile.on("error", reject);
      zipfile.on("end", resolve);
      zipfile.on("entry", (entry) => {
        const target = path.resolve(root, entry.fileName);
        if (target !== root && !target.startsWith(root + path.sep)) {
          return reject(
            new Error(`Archive entry escapes the target: ${entry.fileName}`),
          );
        }
        if (entry.fileName.endsWith("/")) {
          fs.mkdirSync(target, { recursive: true });
          return zipfile.readEntry();
        }
        zipfile.openReadStream(entry, (streamError, stream) => {
          if (streamError) return reject(streamError);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          const out = fs.createWriteStream(target);
          stream.pipe(out);
          out.on("finish", () => zipfile.readEntry());
          out.on("error", reject);
        });
      });
      zipfile.readEntry();
    });
  });
}

// Install one catalogue entry. Downloads the release asset the project itself
// publishes, unpacks it, and leaves it DISABLED — installing and running are
// two decisions, and the second one is the user's.
async function installExtension(dataDir, id) {
  const spec = CATALOGUE[id];
  if (!spec) return { error: `Unknown extension "${id}".` };
  const release = await fetchJson(spec.releasesApi);
  const asset = (release.assets || []).find((a) =>
    spec.assetPattern.test(String(a.name || "")),
  );
  if (!asset) {
    return {
      error: `No matching Chromium build in release ${release.tag_name || "?"}.`,
    };
  }
  if (asset.size > MAX_ARCHIVE_BYTES) {
    return {
      error: `Release asset is unexpectedly large (${asset.size} bytes).`,
    };
  }
  const res = await fetch(asset.browser_download_url, {
    headers: { "User-Agent": "Dive-Browser/1.0" },
  });
  if (!res.ok) {
    return { error: `Download failed (${res.status}).` };
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  const tmpZip = path.join(os.tmpdir(), `dive-ext-${Date.now()}.zip`);
  fs.writeFileSync(tmpZip, bytes);
  // Unpacked beside the target and swapped in, so a failed unpack cannot leave
  // a half-written extension where the browser would try to load it.
  const target = path.join(extensionsRoot(dataDir), id);
  const staging = `${target}.incoming-${process.pid}`;
  try {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    await unzipTo(tmpZip, staging);
    let root = staging;
    // Some archives wrap everything in a single top-level folder.
    if (!fs.existsSync(path.join(root, "manifest.json"))) {
      const inner = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => path.join(root, e.name))
        .find((d) => fs.existsSync(path.join(d, "manifest.json")));
      if (!inner) {
        return { error: "The archive contains no manifest.json." };
      }
      root = inner;
    }
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, "manifest.json"), "utf8"),
    );
    if (Number(manifest.manifest_version) !== 3) {
      // Chromium 153 has no MV2. Installing one would produce a browser that
      // silently ignores it, which is worse than refusing.
      return {
        error: `That build is Manifest V${manifest.manifest_version}; this Chromium only runs Manifest V3 extensions.`,
      };
    }
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(root, target);
    return {
      ok: true,
      id,
      name: resolveName(target, manifest.name, spec.name),
      version: manifest.version || release.tag_name || "",
      release: release.tag_name || "",
    };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(tmpZip, { force: true });
  }
}

function removeExtension(dataDir, id) {
  const target = path.join(extensionsRoot(dataDir), id);
  const root = path.resolve(extensionsRoot(dataDir));
  const resolved = path.resolve(target);
  if (!resolved.startsWith(root + path.sep)) {
    return {
      error: "Refusing to remove a path outside the extensions folder.",
    };
  }
  if (!fs.existsSync(resolved)) return { error: `"${id}" is not installed.` };
  fs.rmSync(resolved, { recursive: true, force: true });
  const config = loadConfig(dataDir);
  config.enabled = config.enabled.filter((x) => x !== id);
  saveConfig(dataDir, config);
  return { ok: true, removed: id };
}

module.exports = {
  CATALOGUE,
  unpackedExtensionId,
  extensionPages,
  EXTENSIONS_DIRNAME,
  extensionsRoot,
  listExtensions,
  enabledExtensionPaths,
  setEnabled,
  installExtension,
  removeExtension,
  unzipTo,
  loadConfig,
  saveConfig,
};
