#!/usr/bin/env node
"use strict";

// Whole-program lint for assets/js.
//
// The client is seven classic scripts sharing one global scope: 03-theme.js
// calls functions declared in 01-core.js, and so on — 2,197 such references at
// the time of writing. ESLint analyses one file at a time, so per-file linting
// reports every cross-file call as no-undef. That is why eslint.config.js
// switches no-undef and no-unused-vars off for assets/js/**, which also means a
// misspelled name there is a silent runtime error.
//
// This script lints the files the way the browser actually runs them:
// concatenated, in the order index.html loads them, as one program. Findings
// are mapped back to real file:line. No source restructuring required.
//
// Run: npm run lint:frontend  (also part of npm run lint)

const fs = require("fs");
const path = require("path");
const { ESLint } = require("eslint");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");

// The browser globals the client may use. Derived from jsdom rather than
// hand-listed so it cannot silently drift; jsdom is already the environment the
// DOM tests run in. SUPPLEMENT covers globals real browsers have that jsdom
// does not implement.
const SUPPLEMENT = [
  "fetch",
  "Response",
  "Request",
  "EventSource",
  "ReadableStream",
  "structuredClone",
  "reportError",
  "requestIdleCallback",
  "cancelIdleCallback",
  "Notification",
  "IntersectionObserver",
  "ResizeObserver",
  "showOpenFilePicker",
  "showSaveFilePicker",
];

// Names the client declares itself, deliberately shadowing a same-named
// browser global. `history` is the app's message array, not window.history.
// Anything new here is reported by no-redeclare, so this cannot go stale
// silently.
const APP_OWNED = ["history"];

function browserGlobals() {
  const { window } = new JSDOM("", { url: "http://localhost/" });
  const names = new Set(Object.getOwnPropertyNames(window));
  for (const name of SUPPLEMENT) names.add(name);
  for (const name of APP_OWNED) names.delete(name);
  return Object.fromEntries([...names].map((name) => [name, "readonly"]));
}

// Vendor libraries loaded from /vendor before the app's own scripts.
const VENDOR_GLOBALS = ["marked", "DOMPurify", "hljs"];

// 00-modes.js publishes its exports onto the global object in a loop, which no
// static analyser can follow. Read the real export names from the module so
// this cannot fall out of step with the registry.
function registryGlobals() {
  return Object.keys(require(path.join(ROOT, "assets/js/00-modes.js")));
}

// The scripts index.html loads, in load order, so a new file is picked up
// automatically and the concatenation matches what the browser executes.
function frontendFiles() {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const files = [...html.matchAll(/<script src="\/(assets\/js\/[^"]+)">/g)].map(
    (m) => m[1],
  );
  if (!files.length) {
    throw new Error("no /assets/js scripts found in index.html");
  }
  return files;
}

function buildBundle(files) {
  const segments = [];
  let source = "";
  let line = 1;
  for (const file of files) {
    const text = fs.readFileSync(path.join(ROOT, file), "utf8");
    const lines = text.split("\n").length;
    segments.push({ file, start: line, end: line + lines - 1 });
    source += text + "\n";
    line += lines;
  }
  return { source, segments };
}

function locate(segments, line) {
  const segment = segments.find((s) => line >= s.start && line <= s.end);
  return segment
    ? { file: segment.file, line: line - segment.start + 1 }
    : { file: "(bundle)", line };
}

async function main() {
  const files = frontendFiles();
  const { source, segments } = buildBundle(files);

  const globals = {
    ...browserGlobals(),
    ...Object.fromEntries(VENDOR_GLOBALS.map((n) => [n, "readonly"])),
    ...Object.fromEntries(registryGlobals().map((n) => [n, "readonly"])),
    // 00-modes.js is dual CommonJS/browser.
    module: "readonly",
  };

  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: {
      languageOptions: { ecmaVersion: "latest", sourceType: "script", globals },
      linterOptions: { reportUnusedDisableDirectives: true },
      rules: {
        "no-undef": "error",
        "no-unused-vars": [
          "warn",
          {
            args: "none",
            caughtErrors: "none",
            varsIgnorePattern: "^_",
          },
        ],
        "no-constant-condition": ["error", { checkLoops: false }],
        "no-dupe-keys": "error",
        "no-func-assign": "error",
        "no-redeclare": "error",
        "no-self-assign": "error",
        "no-unreachable": "error",
      },
    },
  });

  const [result] = await eslint.lintText(source, {
    filePath: path.join(ROOT, "assets/js/__bundle__.js"),
  });

  const findings = (result?.messages || []).map((m) => ({
    ...m,
    ...locate(segments, m.line),
  }));
  const errors = findings.filter((f) => f.severity === 2);
  const warnings = findings.filter((f) => f.severity === 1);

  for (const f of [...errors, ...warnings]) {
    const where = `${f.file}:${f.line}:${f.column}`;
    const level = f.severity === 2 ? "error" : "warning";
    console.log(
      `  ${where.padEnd(30)} ${level.padEnd(8)} ${f.message}  ${f.ruleId || ""}`,
    );
  }

  const scope = `${files.length} files, ${source.split("\n").length} lines`;
  if (errors.length || warnings.length) {
    console.log(
      `\n✖ ${errors.length} error(s), ${warnings.length} warning(s) (${scope})`,
    );
  } else {
    console.log(`✔ frontend clean (${scope})`);
  }
  process.exit(errors.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
