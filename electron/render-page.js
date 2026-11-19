"use strict";

// Renders one web page in a hidden Chromium window and prints it as a single
// line of JSON on stdout, then exits.
//
// This replaces what the removed agent browser was good for: reading a page
// whose text only exists after its JavaScript has run. Dive's desktop app
// already is Chromium, so no Playwright and no second browser download are
// needed. The server (skills/render-page.js) starts this as a short-lived
// process for web_scraper and the research readers when a plain fetch finds
// no readable text.
//
// It is reached two ways: `electron electron/render-page.js` in development,
// and `Dive --render-page` in the packaged app, where electron/main.js hands
// over before it takes the single-instance lock, installs the LaunchAgent or
// opens a window. The URL arrives in DIVE_RENDER_URL.
//
// The page is untrusted, so the window is locked down: Chromium's sandbox, no
// Node, context isolation, a throwaway in-memory session and profile, no
// downloads, pop-ups or permissions, and every request to this machine or the
// local network cancelled — a page must not be able to reach Dive, a
// llama.cpp router or anything else listening here.

const os = require("os");
const fs = require("fs");
const path = require("path");
const dns = require("dns").promises;
const net = require("net");
const { app, BrowserWindow, session } = require("electron");
const { isBlockedIp } = require("../skills/sandbox.js");

const TARGET = String(process.env.DIVE_RENDER_URL || "");
const BUDGET_MS = Math.min(
  Math.max(Number(process.env.DIVE_RENDER_TIMEOUT_MS) || 25000, 5000),
  60000,
);
const SETTLE_MS = 6000;
const MAX_HTML = 4 * 1024 * 1024;

// A profile of its own, deleted on exit: the desktop app may be running with
// the shared one, and nothing a page leaves behind should outlive the render.
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "dive-render-"));
app.setPath("userData", profileDir);
app.disableHardwareAcceleration();
if (process.platform === "darwin" && app.dock) app.dock.hide();

let finished = false;
function finish(result) {
  if (finished) return;
  finished = true;
  try {
    fs.rmSync(profileDir, { recursive: true, force: true });
  } catch {
    /* a temp folder the system clears anyway */
  }
  // Exit only once the line has been handed over. Writing to a pipe is
  // asynchronous, and exiting straight after the write cut a large page off
  // part-way — the server, which reads through a pipe, got half a line.
  const exit = () => app.exit(0);
  setTimeout(exit, 5000).unref?.();
  try {
    process.stdout.write(`${JSON.stringify(result)}\n`, exit);
  } catch {
    exit();
  }
}

setTimeout(
  () => finish({ ok: false, error: `no page within ${BUDGET_MS / 1000}s` }),
  BUDGET_MS,
).unref?.();

// Hosts resolved once per render. A name that resolves to a private address
// is as local as a literal one.
const hostVerdicts = new Map();
async function hostIsPrivate(hostname) {
  const host = String(hostname || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (net.isIP(host)) return isBlockedIp(host);
  if (!hostVerdicts.has(host)) {
    hostVerdicts.set(
      host,
      dns
        .lookup(host, { all: true })
        .then((addresses) => addresses.some((a) => isBlockedIp(a.address)))
        .catch(() => false),
    );
  }
  return hostVerdicts.get(host);
}

async function requestAllowed(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (["data:", "blob:"].includes(parsed.protocol)) return true;
  if (!["http:", "https:"].includes(parsed.protocol)) return false;
  return !(await hostIsPrivate(parsed.hostname));
}

// A browser user agent without Electron's or Dive's name in it: some sites
// serve a stripped page, or nothing, to anything that is not a browser.
function browserUserAgent() {
  const chrome = process.versions.chrome || "142.0.0.0";
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
}

async function render() {
  if (!/^https?:\/\//i.test(TARGET)) {
    finish({ ok: false, error: "DIVE_RENDER_URL must be an http(s) URL" });
    return;
  }
  if (!(await requestAllowed(TARGET))) {
    finish({
      ok: false,
      error: "Access to local or private network addresses is not allowed.",
    });
    return;
  }
  const ses = session.fromPartition(`render-${process.pid}`, { cache: false });
  ses.setPermissionRequestHandler((_wc, _permission, callback) =>
    callback(false),
  );
  ses.setPermissionCheckHandler(() => false);
  ses.on("will-download", (event) => event.preventDefault());
  ses.webRequest.onBeforeRequest((details, callback) => {
    requestAllowed(details.url)
      .then((allowed) => callback({ cancel: !allowed }))
      .catch(() => callback({ cancel: true }));
  });

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      session: ses,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      images: false,
      backgroundThrottling: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.setUserAgent(browserUserAgent());

  try {
    await win.loadURL(TARGET);
  } catch (error) {
    // A page that keeps loading sub-resources rejects here even though its
    // document is usable; only give up when there is no document at all.
    if (
      !win.webContents.getURL() ||
      win.webContents.getURL() === "about:blank"
    ) {
      finish({ ok: false, error: `could not load the page: ${error.message}` });
      return;
    }
  }

  // Script-built pages keep adding text after the load event. Wait until the
  // amount of text stops changing, or for SETTLE_MS at most.
  const textLength = () =>
    win.webContents.executeJavaScript(
      "document.body ? document.body.innerText.length : 0",
      true,
    );
  const settleBy = Date.now() + SETTLE_MS;
  let previous = -1;
  let stable = 0;
  while (Date.now() < settleBy && stable < 2) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const length = await textLength().catch(() => previous);
    stable = length === previous && length > 0 ? stable + 1 : 0;
    previous = length;
  }

  const page = await win.webContents
    .executeJavaScript(
      `(() => {
        // The text as a reader sees it: innerText follows the layout, so
        // neighbouring blocks stay separate words. Menus, banners and footers
        // are hidden first, since innerText skips what is not displayed.
        const html = document.documentElement
          ? document.documentElement.outerHTML
          : "";
        for (const el of document.querySelectorAll(
          "nav, header, footer, aside, [role=navigation], [role=banner], [role=contentinfo], [role=complementary]",
        )) el.style.display = "none";
        const root =
          document.querySelector("main, article, [role=main]") || document.body;
        return {
          url: location.href,
          title: document.title,
          text: root ? root.innerText : "",
          html,
        };
      })()`,
      true,
    )
    .catch((error) => ({ error: error.message }));
  if (page.error) {
    finish({ ok: false, error: `could not read the page: ${page.error}` });
    return;
  }
  finish({
    ok: true,
    url: page.url,
    title: page.title,
    text: String(page.text || "").slice(0, MAX_HTML),
    html: String(page.html || "").slice(0, MAX_HTML),
  });
}

app.on("window-all-closed", () => {
  /* stay up until finish() — the hidden window is not the end of the run */
});
app
  .whenReady()
  .then(render, (error) =>
    finish({ ok: false, error: `could not start: ${error.message}` }),
  );
