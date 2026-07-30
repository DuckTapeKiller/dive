// Find out what a running llama-server router is configured with, by asking
// the process itself rather than the user.
//
// A router in `--models-preset` mode already carries everything preset sync
// needs on its command line: the .ini it read at startup, and (for the chat
// router) the folder it scans. Reading that back turns a feature that had to
// be switched on and filled in by hand into one that simply works:
//
//   /opt/homebrew/bin/llama-server --models-dir /Users/x/models \
//     --models-preset /Users/x/models/llama-server-chat.ini \
//     --models-max 1 --host 127.0.0.1 --port 8130
//
// Restarting is equally free of configuration. Both routers are supervised by
// launchd with KeepAlive=true, so ending the process IS the restart — no
// LaunchAgent label has to be known, and no launchctl label can be typed
// wrongly. Dive therefore never needs to be told anything about them.
//
// Everything here is deliberately narrow. A port only yields a router when the
// listening process really is a llama-server started with a preset, and that
// same check is repeated immediately before the process is signalled, so a
// recycled PID can never send a signal somewhere else.
"use strict";

const path = require("path");
const { execFile } = require("child_process");

// llama-server in managed mode (`llama-server -m model.gguf`) has no preset and
// is Dive's own child; only a preset-mode router is ever adopted.
const BINARY_RE = /(^|\/)llama-server$/;

function run(command, args, timeout = 2500) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout, maxBuffer: 1 << 20 },
      (error, stdout) => {
        // A non-zero exit is the normal "nothing listening" answer from lsof,
        // so it is not worth distinguishing from a real failure here.
        resolve(error && !stdout ? "" : String(stdout || ""));
      },
    );
  });
}

// PID listening on a TCP port. `-t` keeps the output to bare PIDs; several can
// come back when a process forks, and the first is the listener.
async function listenerPid(port) {
  const out = await run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
  const pid = Number(String(out).trim().split(/\s+/)[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

// Full argv of a process, unwrapped (-ww) so a long command line is not cut
// off before the flags this needs.
async function commandLine(pid) {
  const out = await run("ps", ["-ww", "-o", "args=", "-p", String(pid)]);
  return String(out).trim();
}

// Value of `--flag`, tolerating spaces in a path by taking every token up to
// the next flag. ps prints argv unquoted, so this is the best reconstruction
// available — and it is exact for any path without a " --" in it.
function flagValue(tokens, flag) {
  const start = tokens.indexOf(flag);
  if (start === -1) return "";
  const parts = [];
  for (let i = start + 1; i < tokens.length; i++) {
    if (tokens[i].startsWith("--")) break;
    parts.push(tokens[i]);
  }
  return parts.join(" ");
}

// Read a command line into the two paths preset sync needs, or null when this
// process is not a preset-mode llama-server. Exported for tests: it is the
// part worth pinning down, and it needs no live process.
function parseRouterCommand(cmd) {
  const tokens = String(cmd || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.length) return null;
  if (!BINARY_RE.test(tokens[0])) return null;
  const presetPath = flagValue(tokens, "--models-preset");
  // No preset means managed mode (or a plain single-model server): not ours to
  // write to, and nothing to write.
  if (
    !presetPath ||
    !path.isAbsolute(presetPath) ||
    !/\.ini$/i.test(presetPath)
  ) {
    return null;
  }
  const modelsDir = flagValue(tokens, "--models-dir");
  return {
    binary: tokens[0],
    presetPath: path.normalize(presetPath),
    // The embedding router runs without --models-dir; the caller falls back to
    // the folder Dive already knows about.
    modelsDir:
      modelsDir && path.isAbsolute(modelsDir) ? path.normalize(modelsDir) : "",
  };
}

// The model file behind one entry of a router's /v1/models. A router reports it
// twice: the spawn arguments carry `--model <path>`, and the preset text the
// entry was built from repeats it. Either is an absolute path.
//
// This is what makes a section name irrelevant. A router names a model after
// its `[section]`, which need not resemble the filename — the embedding preset
// deliberately uses an alias the library's vector index is keyed to — so
// matching by name only ever worked for sections named after their own file.
function routerModelPath(entry) {
  const status = entry?.status;
  if (!status || typeof status !== "object") return "";
  const args = Array.isArray(status.args) ? status.args : [];
  const at = args.indexOf("--model");
  if (at !== -1 && typeof args[at + 1] === "string") return args[at + 1];
  const fromPreset = /^[ \t]*model[ \t]*=[ \t]*(.+)$/m.exec(
    String(status.preset || ""),
  );
  return fromPreset ? fromPreset[1].trim() : "";
}

// The .gguf paths a router currently has RESIDENT, which is what a restart
// costs and therefore what has to be put back afterwards.
//
// Strictly the models reporting "loaded". A router advertises everything in its
// preset, and llama-server parks an idle model as "sleeping" — reloading either
// of those would drag models into memory that nobody asked for, which is worse
// than the unload this repairs.
function loadedModelPaths(advertised) {
  const models = Array.isArray(advertised?.models) ? advertised.models : [];
  return models
    .filter((m) => m && m.state === "loaded" && m.modelPath)
    .map((m) => m.modelPath);
}

// The name a router knows a given FILE by, or "" if it does not serve it.
// Path first, since that is unambiguous; the filename stem remains as a
// fallback for a router that reports no path per model.
function routerAliasFor(advertised, modelPath, file) {
  const models = Array.isArray(advertised?.models) ? advertised.models : [];
  if (modelPath) {
    const want = path.resolve(modelPath);
    const byPath = models.find(
      (m) => m.modelPath && path.resolve(m.modelPath) === want,
    );
    if (byPath) return byPath.id;
  }
  const stem = String(file || "").replace(/\.gguf$/i, "");
  return stem && models.some((m) => m.id === stem) ? stem : "";
}

// The router serving `port`, or null if nothing there is one.
async function discoverRouter(port) {
  const pid = await listenerPid(port);
  if (!pid) return null;
  const parsed = parseRouterCommand(await commandLine(pid));
  return parsed ? { pid, ...parsed } : null;
}

// Restart a router by ending it: launchd's KeepAlive brings it straight back
// with the rewritten preset. The command line is re-read first so the signal
// can only ever reach the same llama-server that was discovered — between
// discovery and here the process may have died and the PID been reused.
async function restartRouter(router) {
  const parsed = parseRouterCommand(await commandLine(router.pid));
  if (!parsed || parsed.presetPath !== router.presetPath) {
    return { ok: false, error: "router process changed before restart" };
  }
  try {
    process.kill(router.pid, "SIGTERM");
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
  return { ok: true, pid: router.pid };
}

// Wait for launchd to put a router back on the port, so a caller that restarts
// in order to load a model does not race the respawn. Resolves with the new
// router, or null if it never came back in time.
async function waitForRouter(
  port,
  { timeoutMs = 15000, previousPid = 0 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await discoverRouter(port);
    if (found && found.pid !== previousPid) return found;
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

module.exports = {
  parseRouterCommand,
  routerModelPath,
  routerAliasFor,
  loadedModelPaths,
  discoverRouter,
  restartRouter,
  waitForRouter,
  listenerPid,
  commandLine,
};
