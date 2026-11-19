// KEEP IN RAM, on whichever llama-server is installed.
//
// llama.cpp used to lock a model into RAM with `--mlock`. Build 0.8.0 removed
// that flag in favour of `--load-mode MODE` (alias `-lm`), and an unknown flag
// is fatal: `llama-server --mlock …` exits with "invalid argument: --mlock", so
// every model with the box ticked failed to start at all. Older builds have the
// opposite problem — they know `--mlock` and reject `--load-mode`.
//
// So the flag is chosen from what the binary itself says it accepts. Its
// `--help` lists every option, costs a few milliseconds, and loads nothing.
// The answer is cached per binary and invalidated when the file changes, so a
// `brew upgrade` is picked up on the next load without restarting Dive.
//
// The stored setting is still `mlock: true`: that is what existing configs say,
// and it still means the same thing. Only the argv it turns into has changed.
//
//   --load-mode mmap+mlock   is the old default (mmap) plus `--mlock`, which is
//                            exactly what the box asked for before the change.
"use strict";

const fs = require("fs");
const { execFile } = require("child_process");

const KEEP_IN_RAM_MODE = "mmap+mlock";
const HELP_TIMEOUT_MS = 10000;

// Which keep-in-RAM flags a `llama-server --help` text offers. An option is
// only counted where it is listed as one — at the start of a line or after a
// comma, as in "-lm,   --load-mode MODE" — never where a description merely
// mentions the word ("may reduce pageouts if not using mlock").
function parseLoadFlags(helpText) {
  const text = String(helpText || "");
  const listed = (flag) =>
    new RegExp(`(?:^|,)\\s*${flag}(?=[\\s,=]|$)`, "m").test(text);
  return {
    loadMode: listed("--load-mode"),
    mlock: listed("--mlock"),
  };
}

// The arguments that keep a model in RAM, given what the binary offers.
// `--load-mode` wins when both are listed: it is the current spelling, and a
// build in the middle of the transition still accepts it. Neither listed means
// there is no way to ask, and passing a flag the binary rejects would stop the
// model starting at all — so the answer is no arguments, and the caller says so.
function keepInRamArgs(flags) {
  if (flags?.loadMode) return ["--load-mode", KEEP_IN_RAM_MODE];
  if (flags?.mlock) return ["--mlock"];
  return [];
}

function runHelp(binary) {
  return new Promise((resolve) => {
    execFile(
      binary,
      ["--help"],
      { timeout: HELP_TIMEOUT_MS, maxBuffer: 4 << 20 },
      // Some builds print the help to stderr and some exit non-zero after
      // printing it, so whatever came out is read either way.
      (error, stdout, stderr) => {
        const text = `${stdout || ""}\n${stderr || ""}`;
        resolve(text.trim() ? text : null);
      },
    );
  });
}

// One probe per binary. Keyed on the resolved path, so the Homebrew symlink
// that moves to a new Cellar version on upgrade gives a new key, and on its
// size and mtime, so a binary rebuilt in place does too.
function createLoadFlagProbe({ readHelp = runHelp } = {}) {
  const cache = new Map();
  function keyFor(binary) {
    try {
      const real = fs.realpathSync(binary);
      const st = fs.statSync(real);
      return `${real}\0${st.size}\0${st.mtimeMs}`;
    } catch {
      return "";
    }
  }
  // { loadMode, mlock } — or null when the help could not be read at all.
  return async function probe(binary) {
    const key = keyFor(binary);
    if (key && cache.has(key)) return cache.get(key);
    const help = await readHelp(binary);
    const flags = help === null ? null : parseLoadFlags(help);
    // A failed read is not remembered: it may have been a one-off.
    if (key && flags) cache.set(key, flags);
    return flags;
  };
}

// What a launch with KEEP IN RAM ticked adds to llama-server's argv, and the
// line to put in the server log when it has to add nothing: a choice the user
// made is never dropped without saying so.
async function resolveKeepInRam(binary, probe) {
  const flags = await probe(binary);
  const args = keepInRamArgs(flags);
  if (args.length) return { args, note: "" };
  return {
    args,
    note: flags
      ? "KEEP IN RAM is ticked, but this llama-server lists neither --load-mode nor --mlock, so the model was started without it."
      : "KEEP IN RAM is ticked, but llama-server --help could not be read to find its flag, so the model was started without it.",
  };
}

module.exports = {
  KEEP_IN_RAM_MODE,
  parseLoadFlags,
  keepInRamArgs,
  createLoadFlagProbe,
  resolveKeepInRam,
};
