"use strict";

// Validation for the two filesystem paths the user can point Pi at: the `pi`
// executable and its working directory. Both are spawned/entered by the server,
// so they are checked rather than trusted — but the checks stay narrow enough
// that a normal Homebrew or npm-global install still passes.
//
// Each function returns { path, reason }: an empty `path` with a human-readable
// `reason`, so the settings API can tell the user why a value was refused
// instead of silently blanking the field.

const fs = require("fs");
const os = require("os");
const path = require("path");

const PI_COMMAND_BASENAMES = new Set(["pi", "pi.cmd", "pi.exe"]);

// Resolve a user-supplied path and confirm this user owns it and no other user
// can rewrite it. Deliberately no ancestor-permission walk: package-manager
// prefixes such as /opt/homebrew/lib are group-writable by design, so walking
// ancestors rejects nearly every real install. It would also buy nothing,
// because auto-detection spawns that same binary without any check.
function resolveOwnedPath(filePath, expectedType) {
  let resolved;
  let stat;
  try {
    resolved = fs.realpathSync(filePath);
    stat = fs.statSync(resolved);
  } catch (_error) {
    return { path: "", reason: "does not exist or is not readable" };
  }
  if (expectedType === "file" && !stat.isFile()) {
    return { path: "", reason: "is not a file" };
  }
  if (expectedType === "directory" && !stat.isDirectory()) {
    return { path: "", reason: "is not a directory" };
  }
  if (
    typeof process.getuid === "function" &&
    stat.uid !== process.getuid() &&
    stat.uid !== 0
  ) {
    return { path: "", reason: "is owned by another user" };
  }
  if ((stat.mode & 0o022) !== 0) {
    return { path: "", reason: "is writable by other users" };
  }
  return { path: resolved, reason: "" };
}

function sanitizePiCommandPath(value) {
  const candidate = typeof value === "string" ? value.trim() : "";
  if (!candidate) return { path: "", reason: "" };
  if (!path.isAbsolute(candidate)) {
    return PI_COMMAND_BASENAMES.has(candidate)
      ? { path: candidate, reason: "" }
      : {
          path: "",
          reason: 'must be an absolute path or the bare command name "pi"',
        };
  }
  if (!PI_COMMAND_BASENAMES.has(path.basename(candidate))) {
    return {
      path: "",
      reason: `must end in one of: ${[...PI_COMMAND_BASENAMES].join(", ")}`,
    };
  }
  const owned = resolveOwnedPath(candidate, "file");
  if (!owned.path) return owned;
  // Validate through the realpath, but keep the path the user actually gave.
  // A launcher like /opt/homebrew/bin/pi resolves to .../dist/cli.js, whose
  // basename would fail the check above the next time these settings are
  // loaded from disk — sanitizing must be idempotent.
  return { path: candidate, reason: "" };
}

function sanitizePiWorkingDirectory(value, dataDir) {
  const candidate = typeof value === "string" ? value.trim() : "";
  if (!candidate) return { path: "", reason: "" };
  const resolved = resolveOwnedPath(candidate, "directory");
  if (!resolved.path) return resolved;
  const roots = [path.resolve(os.homedir()), path.resolve(dataDir)];
  const inRoot = (root) =>
    resolved.path === root || resolved.path.startsWith(root + path.sep);
  if (!roots.some(inRoot)) {
    return { path: "", reason: "must be inside your home or Dive data folder" };
  }
  return resolved;
}

module.exports = {
  sanitizePiCommandPath,
  sanitizePiWorkingDirectory,
};
