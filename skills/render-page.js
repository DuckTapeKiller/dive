"use strict";

// Ask Dive's desktop app to render a page whose text only appears after its
// JavaScript runs, and get its HTML back.
//
// The renderer is electron/render-page.js, a short-lived Electron process with
// a hidden, locked-down window. Electron tells this server how to start it
// (DIVE_ELECTRON_BINARY and DIVE_RENDER_ARGS, set in electron/main.js for the
// LaunchAgent, the child server and the in-process fallback). Without them —
// `node server.js` on its own, the test suite — rendering is simply not
// available and callers carry on without it.

const { spawn } = require("child_process");
const fs = require("fs");
const { assertUrlAllowed } = require("./sandbox.js");

const RENDER_TIMEOUT_MS = 25000;
const MAX_OUTPUT = 8 * 1024 * 1024;
// Each render is a Chromium; research reads many pages, and a few at a time
// is plenty.
const MAX_CONCURRENT = 2;

let running = 0;
const waiting = [];

function renderCommand(env = process.env) {
  const binary = String(env.DIVE_ELECTRON_BINARY || "");
  if (!binary || !fs.existsSync(binary)) return null;
  let args;
  try {
    args = JSON.parse(env.DIVE_RENDER_ARGS || '["--render-page"]');
  } catch {
    return null;
  }
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) {
    return null;
  }
  return { binary, args };
}

function renderAvailable(env = process.env) {
  return renderCommand(env) !== null;
}

async function withSlot(run) {
  if (running >= MAX_CONCURRENT) {
    await new Promise((resolve) => waiting.push(resolve));
  }
  running += 1;
  try {
    return await run();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

// { ok: true, url, title, html } or { ok: false, error }.
async function renderPage(url, { timeoutMs = RENDER_TIMEOUT_MS, env } = {}) {
  const command = renderCommand(env || process.env);
  if (!command) {
    return {
      ok: false,
      error: "page rendering needs Dive's desktop app",
    };
  }
  // The renderer checks too, request by request; this refuses before a
  // Chromium is started for nothing.
  const guardError = await assertUrlAllowed(url);
  if (guardError) return { ok: false, error: guardError };

  return withSlot(
    () =>
      new Promise((resolve) => {
        const childEnv = { ...(env || process.env) };
        // Inherited from a server that runs as Electron-in-Node mode, this
        // would make the renderer a Node script that never opens a window.
        delete childEnv.ELECTRON_RUN_AS_NODE;
        childEnv.DIVE_RENDER_URL = url;
        childEnv.DIVE_RENDER_TIMEOUT_MS = String(timeoutMs);
        let child;
        try {
          child = spawn(command.binary, command.args, {
            env: childEnv,
            stdio: ["ignore", "pipe", "ignore"],
            windowsHide: true,
          });
        } catch (error) {
          resolve({
            ok: false,
            error: `could not start the renderer: ${error.message}`,
          });
          return;
        }
        let out = "";
        let settled = false;
        const done = (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(killer);
          resolve(result);
        };
        // The renderer stops itself at timeoutMs; this is for one that hangs.
        const killer = setTimeout(() => {
          child.kill("SIGKILL");
          done({ ok: false, error: "the renderer did not answer" });
        }, timeoutMs + 10000);
        killer.unref?.();
        child.stdout.on("data", (chunk) => {
          if (out.length < MAX_OUTPUT) out += chunk;
        });
        child.on("error", (error) =>
          done({
            ok: false,
            error: `could not start the renderer: ${error.message}`,
          }),
        );
        child.on("close", () => {
          const line = out.trim().split("\n").pop() || "";
          try {
            const result = JSON.parse(line);
            done(
              result && typeof result === "object"
                ? result
                : { ok: false, error: "the renderer gave no answer" },
            );
          } catch {
            done({ ok: false, error: "the renderer gave no readable answer" });
          }
        });
      }),
  );
}

module.exports = { renderPage, renderAvailable, renderCommand };
