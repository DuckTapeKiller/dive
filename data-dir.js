"use strict";

// Where Dive keeps everything it owns: conversations, settings, lessons,
// plugins, the skill workspace, the library index.
//
// Defined once. Seven places used to compute `~/dive` independently — server.js,
// library/store.js, plugins.js, electron/main.js, skills/sandbox.js (twice) and
// skills/code.js — so the location could not be changed, and anything running
// against the app (an integration test, a second instance) wrote straight into
// the user's live data.
//
// DIVE_DATA_DIR overrides it. Electron passes its environment through to the
// server process it spawns, so setting it once covers both.
//
// Read at require time, like the constants it replaced. A test that needs a
// different directory must set process.env.DIVE_DATA_DIR before requiring
// anything that reaches this module.

const os = require("os");
const path = require("path");

const DEFAULT_DATA_DIR = path.join(os.homedir(), "dive");

const DATA_DIR = path.resolve(
  typeof process.env.DIVE_DATA_DIR === "string" &&
    process.env.DIVE_DATA_DIR.trim()
    ? process.env.DIVE_DATA_DIR.trim()
    : DEFAULT_DATA_DIR,
);

// Subdirectories with more than one consumer, so they cannot drift either.
const PLUGINS_DIR = path.join(DATA_DIR, "plugins");
const WORKSPACE_DIR = path.join(DATA_DIR, "workspace");

module.exports = {
  DATA_DIR,
  PLUGINS_DIR,
  WORKSPACE_DIR,
  isOverridden: DATA_DIR !== path.resolve(DEFAULT_DATA_DIR),
};
