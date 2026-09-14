// Browser domain routes: what the agent's browser is looking at.
//
// The point of putting a browser inside Dive rather than behind an MCP server
// is that the run is visible — the user can watch a page load, notice the agent
// on the wrong site, and stop it. These routes are that window: a list of open
// sessions, a live PNG of one, and a way to end it.
//
// Two different callers, and the distinction is the whole design.
//
// The MODEL drives the browser through browse_read/browse_act, and browse_act
// is gated because the page it acts on is untrusted input and a click cannot be
// taken back.
//
// The USER drives it through these routes, and is not gated, because a URL a
// person typed is the trusted instruction — it is what the gate exists to
// protect, not something to protect against. Taking over at a cookie wall or a
// login the agent cannot pass is the reason for putting the browser in the app
// at all; a panel you can only watch is a screenshot with extra steps.
//
// Both paths go through the same network guard. That guard is not about who is
// asking: it is there because Dive's server has no authentication and loopback
// binding is the only thing standing in for it.
//
// User actions are recorded as such, so the audit trail can tell a person's
// click from the agent's.
"use strict";

const browser = require("../skills/browser.js");
const extensions = require("../skills/browser-extensions.js");

module.exports = function createBrowserDomain(deps = {}) {
  const { parseJsonBody, appendSecurityEvent, DATA_DIR } = deps;

  async function handleRequest(ctx) {
    const { req, res, urlPath, requestUrl, send } = ctx;
    if (!urlPath.startsWith("/api/browser/")) return false;

    if (req.method === "GET" && urlPath === "/api/browser/sessions") {
      // So the panel can say when the element picker is waiting for a click.
      await browser.refreshPickerState().catch(() => {});
      send(200, {
        engineAvailable: browser.browserEngineAvailable(),
        installHint: browser.INSTALL_HINT,
        idleTimeoutMs: browser.SESSION_IDLE_MS,
        maxSessions: browser.SESSION_MAX,
        sessions: browser.listSessions(),
      });
      return true;
    }

    // The current page as a PNG. Polled by the viewer; a session that has gone
    // answers 404 rather than a stale image, so the panel can say so.
    if (req.method === "GET" && urlPath === "/api/browser/view") {
      const name = requestUrl?.searchParams?.get("session") || "default";
      // The panel reports its own size so the page is captured at the size it
      // will be displayed at, rather than scaled down from a fixed 1280x800.
      const width = requestUrl?.searchParams?.get("w");
      const height = requestUrl?.searchParams?.get("h");
      const size = width && height ? { width, height } : null;
      let frame;
      try {
        frame = await browser.screenshotSession(name, size, "jpeg");
      } catch (error) {
        // A capture that failed is not a missing session, and saying so sent
        // the last debugging session looking for the wrong thing entirely.
        send(500, { error: error.message });
        return true;
      }
      if (!frame) {
        send(404, { error: `No open browser session named "${name}".` });
        return true;
      }
      res.writeHead(200, {
        "Content-Type": "image/jpeg",
        "Content-Length": frame.length,
        // The page changes under the same URL, so a cached copy would show the
        // user a page the agent has already navigated away from.
        "Cache-Control": "no-store",
      });
      res.end(frame);
      return true;
    }

    // The address bar. Creates the session if there is not one yet, so the user
    // can start browsing without the agent having gone first.
    if (req.method === "POST" && urlPath === "/api/browser/navigate") {
      try {
        const body = parseJsonBody ? await parseJsonBody(req) : {};
        const session = String(body?.session || "user").trim() || "user";
        const result = await browser.userNavigate(session, body?.url, DATA_DIR);
        if (result.error) {
          send(400, { error: result.error });
          return true;
        }
        appendSecurityEvent?.("browser_user_navigated", {
          session,
          url: result.url,
        });
        send(200, result);
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return true;
    }

    // Back, forward, reload.
    if (req.method === "POST" && urlPath === "/api/browser/history") {
      try {
        const body = parseJsonBody ? await parseJsonBody(req) : {};
        const session = String(body?.session || "user").trim() || "user";
        const result = await browser.userHistory(session, body?.action);
        if (result.error) {
          send(400, { error: result.error });
          return true;
        }
        send(200, result);
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return true;
    }

    // Taking over: a click or keystroke aimed at the page itself.
    if (req.method === "POST" && urlPath === "/api/browser/interact") {
      try {
        const body = parseJsonBody ? await parseJsonBody(req) : {};
        const session = String(body?.session || "user").trim() || "user";
        // The panel sends its size so the frame this interaction produces can
        // come back with it, instead of costing a second request.
        const width = Number(body?.w) || 0;
        const height = Number(body?.h) || 0;
        const result = await browser.userInteract(session, {
          ...body,
          // `target` rides through: the client knows whether the pointer was
          // over the page or over the extension panel drawn on top of it.
          capture: width && height ? { width, height } : null,
        });
        if (result.error) {
          send(400, { error: result.error });
          return true;
        }
        send(200, result);
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return true;
    }

    // ---- Extensions ----
    //
    // Installing runs third-party code in the browser the agent drives, so it
    // is never automatic and never reachable by the model: these routes are
    // called from Dive's own settings interface and nowhere else. Enabling one
    // also changes how the browser is launched — a persistent profile on the
    // full Chromium build — so open sessions have to be restarted to pick it
    // up, and the response says so rather than leaving the user wondering.

    if (req.method === "GET" && urlPath === "/api/browser/extensions") {
      send(200, extensions.listExtensions(DATA_DIR));
      return true;
    }

    if (
      req.method === "POST" &&
      urlPath === "/api/browser/extensions/install"
    ) {
      try {
        const body = parseJsonBody ? await parseJsonBody(req) : {};
        const id = String(body?.id || "").trim();
        const result = await extensions.installExtension(DATA_DIR, id);
        if (result.error) {
          send(400, { error: result.error });
          return true;
        }
        appendSecurityEvent?.("browser_extension_installed", {
          id,
          name: result.name,
          version: result.version,
        });
        send(200, { ...result, ...extensions.listExtensions(DATA_DIR) });
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return true;
    }

    if (req.method === "POST" && urlPath === "/api/browser/extensions/enable") {
      try {
        const body = parseJsonBody ? await parseJsonBody(req) : {};
        const id = String(body?.id || "").trim();
        const on = body?.enabled === true;
        const listing = extensions.setEnabled(DATA_DIR, id, on);
        appendSecurityEvent?.("browser_extension_enabled", { id, enabled: on });
        // The change reaches the browser only on the next launch, because the
        // extension list is part of the launch command line.
        send(200, {
          ok: true,
          ...listing,
          restartRequired: browser.listSessions().length > 0,
        });
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return true;
    }

    // Open an extension's own settings UI in the browser panel, which is where
    // it is actually configured. From Dive's interface only.
    if (req.method === "POST" && urlPath === "/api/browser/extensions/open") {
      try {
        const body = parseJsonBody ? await parseJsonBody(req) : {};
        const session = String(body?.session || "user").trim() || "user";
        const result = await browser.openExtensionPage(
          session,
          DATA_DIR,
          String(body?.id || "").trim(),
          String(body?.page || ""),
        );
        if (result.error) {
          send(400, { error: result.error });
          return true;
        }
        send(200, result);
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return true;
    }

    // The popup — per-site filtering level, element picker, custom filters.
    // This is the control you block things with, as opposed to the dashboard,
    // which is global settings.
    if (req.method === "POST" && urlPath === "/api/browser/extensions/popup") {
      try {
        const body = parseJsonBody ? await parseJsonBody(req) : {};
        const session = String(body?.session || "user").trim() || "user";
        const result = await browser.openExtensionPopup(
          session,
          DATA_DIR,
          String(body?.id || "").trim(),
        );
        if (result.error) {
          send(400, { error: result.error });
          return true;
        }
        send(200, result);
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return true;
    }

    // Put the page back in front of the extension's UI.
    if (
      req.method === "POST" &&
      urlPath === "/api/browser/extensions/dismiss"
    ) {
      try {
        const body = parseJsonBody ? await parseJsonBody(req) : {};
        const session = String(body?.session || "user").trim() || "user";
        send(200, await browser.closeExtensionUi(session));
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return true;
    }

    if (req.method === "POST" && urlPath === "/api/browser/extensions/remove") {
      try {
        const body = parseJsonBody ? await parseJsonBody(req) : {};
        const result = extensions.removeExtension(
          DATA_DIR,
          String(body?.id || "").trim(),
        );
        if (result.error) {
          send(400, { error: result.error });
          return true;
        }
        send(200, { ...result, ...extensions.listExtensions(DATA_DIR) });
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return true;
    }

    // The live view as a stream rather than a series of requests.
    //
    // SSE because it is one long-lived connection the browser reconnects by
    // itself, and because frames only ever travel one way. The screenshot route
    // above stays as the fallback for a client that cannot hold a stream open.
    if (req.method === "GET" && urlPath === "/api/browser/stream") {
      const name = requestUrl?.searchParams?.get("session") || "default";
      const width = Number(requestUrl?.searchParams?.get("w")) || 0;
      const height = Number(requestUrl?.searchParams?.get("h")) || 0;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        // Nothing between here and the panel should buffer a live stream.
        "X-Accel-Buffering": "no",
      });
      let closed = false;
      const onFrame = (data) => {
        if (closed) return;
        // One frame, one SSE event. The payload is already base64 from Chrome,
        // so it is written through untouched rather than decoded and re-encoded.
        res.write(`data: ${data}\n\n`);
      };
      // Caught here as well as guarded inside: an exception thrown by this
      // route had nowhere to go and ended the server process.
      const started = await browser
        .startScreencast(name, { width, height, onFrame })
        .catch((error) => ({ error: `Live view failed: ${error.message}` }));
      if (started.error) {
        res.write(`event: error\ndata: ${JSON.stringify(started.error)}\n\n`);
        res.end();
        return true;
      }
      // A stream that produces nothing looks identical to a hung one from the
      // client side, so say hello immediately.
      res.write(`event: ready\ndata: ${JSON.stringify({ session: name })}\n\n`);
      const stop = () => {
        if (closed) return;
        closed = true;
        browser.stopScreencast(name, onFrame).catch(() => {});
      };
      res.on("close", stop);
      res.on("error", stop);
      return true;
    }

    // The extension's own panel, drawn OVER the live page by the client rather
    // than replacing it — the page has to stay visible or there is nothing to
    // pick an element from.
    if (req.method === "GET" && urlPath === "/api/browser/uiview") {
      const name = requestUrl?.searchParams?.get("session") || "default";
      const frame = await browser.screenshotExtensionUi(name, "jpeg");
      if (!frame) {
        send(404, { error: "No extension panel is open." });
        return true;
      }
      res.writeHead(200, {
        "Content-Type": "image/jpeg",
        "Content-Length": frame.length,
        "Cache-Control": "no-store",
      });
      res.end(frame);
      return true;
    }

    if (req.method === "POST" && urlPath === "/api/browser/close") {
      try {
        const body = parseJsonBody ? await parseJsonBody(req) : {};
        const name = String(body?.session || "").trim();
        if (name) {
          const closed = await browser.closeSession(browser.sessionName(name));
          send(200, { ok: true, closed: closed ? [name] : [] });
        } else {
          const names = browser.listSessions().map((s) => s.name);
          await browser.closeAllSessions();
          send(200, { ok: true, closed: names });
        }
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return true;
    }

    return false;
  }

  return { handleRequest, closeAllSessions: browser.closeAllSessions };
};
